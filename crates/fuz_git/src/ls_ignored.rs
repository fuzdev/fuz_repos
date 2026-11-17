//! `Git::ls_ignored`: the untracked paths git ignores in a working tree,
//! for a caller that prunes them from a walk of its own.

use std::path::{Path, PathBuf};

use crate::records::{quote_record, split_records, to_paths};
use crate::runner::{CallOptions, Git, GitError};

/// The listing's arguments.
///
/// `--directory` folds a dir git can answer for whole into one entry, which
/// keeps the listing of a tree with a `node_modules/` or a `target/` small.
///
/// Not `--no-empty-directory`: beside `--ignored` it drops every ignored
/// path inside an untracked dir that holds anything not ignored (an
/// untracked package's `node_modules/`), so a caller pruning by the listing
/// would walk them. Without it, an empty dir is listed only when ignored
/// itself, which a caller can prune like any other.
const ARGS: &[&str] = &[
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
];

/// What `Git::ls_ignored` lists, each path relative to the dir it listed and
/// held as git's bytes, each list sorted by those bytes (git's own order).
///
/// A caller pruning a walk sends every `dirs` entry but `./` (see
/// `Git::ls_ignored`) through one `Git::check_ignore` call, with the same
/// dir: it prunes the dirs that confirms, and walks the
/// rest as usual, since their ignored contents are already in the listing
/// (`Git::ls_ignored` says why).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct IgnoredPaths {
    /// Dirs git folded, each kept with git's trailing `/` (which
    /// `Git::check_ignore` strips before asking, learning dir-ness from the
    /// disk instead). A candidate, not a verdict: git
    /// folds a dir whose untracked contents are all ignored even when no
    /// pattern names the dir itself. An ignored dir holding a repo of its
    /// own is listed here too, as git doesn't descend it.
    ///
    /// `PathBuf`'s `==`, ordering, and hashing compare by components, which
    /// drop the trailing `/` (`build/` equals `build`): compare
    /// `as_os_str()` bytes where the slash matters.
    pub dirs: Vec<PathBuf>,
    /// Ignored files git lists one by one, including those inside a dir in
    /// `dirs` that git folded without its being ignored itself.
    pub files: Vec<PathBuf>,
}

impl Git {
    /// Lists the untracked paths under `dir` that git's excludes ignore, in
    /// one `git ls-files --directory` call (one spawn).
    ///
    /// `dir` is a working tree's top level or a dir inside one; as with
    /// `Git::ls_files`, what's listed is `dir`'s subtree, relative to `dir`,
    /// and every exclude from the top level down still applies. A `dir`
    /// that git would fold lists as `./` in `dirs`: alone when `dir` is the
    /// outermost ignored dir, beside its contents when it isn't ignored.
    /// A pruning caller doesn't send `./` to `Git::check_ignore` with the
    /// same `dir`, which refuses it (`PathNotBelowDir`): `./` alone means
    /// `dir` is ignored whole, and beside contents it's a folded dir
    /// those contents already answer for. A
    /// `dir` strictly inside an ignored dir fails (see Errors).
    ///
    /// - **Folded dirs** are listed in `dirs`, each as one entry. An ignored
    ///   dir's contents aren't listed. A dir that's folded but not ignored
    ///   (no pattern names it, but all its untracked contents are ignored)
    ///   is listed together with those contents, nested dirs and files
    ///   alike (`pkg/`, `pkg/node_modules/`, `pkg/sub/`,
    ///   `pkg/sub/y.local.json`), so `Git::check_ignore` on `dirs` is all a
    ///   pruning caller needs, never a re-listing. Verified on git 2.47.3,
    ///   not on older releases down to `MIN_GIT_VERSION`; this rests on
    ///   git's dir traversal, so it's guarded by the test
    ///   `a_dir_of_ignored_files_folds_without_being_ignored`.
    /// - **Excludes** are git's standard set: every `.gitignore`,
    ///   `info/exclude`, and the global excludes file, as for
    ///   `Git::ls_files` (whose docs say when the last applies).
    /// - **Tracked files** are never listed, nor folded into an ignored
    ///   dir: git doesn't fold a dir the index has entries under, so its
    ///   ignored files are listed one by one.
    /// - **Nested repos and gitlinks** aren't descended: nothing inside one
    ///   is listed, though the outer repo's excludes may match it
    ///   (`Git::check_ignore` answers by them).
    /// - **Names** are git's bytes, unquoted (`-z`).
    ///
    /// `opts` is the call's, as for `Git::ls_files`; a caller listing a dir
    /// it doesn't vouch for sets `opts.refuse_implicit_bare`.
    ///
    /// # Errors
    ///
    /// As `Git::output`, including `Failed` when `dir` isn't in a working
    /// tree, and `OutputTooLarge` past the runner's stdout cap. `Failed`
    /// too when `dir` is strictly inside an ignored dir (`build/sub` under
    /// `build/`): git exits 128 with `internal error - directory entry not
    /// superset of prefix`, so a caller lists from the outermost ignored dir
    /// or above.
    /// `UnexpectedOutput` when a record is empty or the last one is
    /// unterminated.
    pub fn ls_ignored(&self, dir: &Path, opts: CallOptions<'_>) -> Result<IgnoredPaths, GitError> {
        let stdout = self.output(dir, ARGS, opts)?;
        parse_ignored(&stdout).map_err(|record| GitError::UnexpectedOutput {
            args: ARGS.join(" "),
            detail: format!("record `{}`", quote_record(record)),
        })
    }
}

/// Parses the listing's NUL-terminated records into `IgnoredPaths`, or
/// returns the first record it doesn't recognize.
fn parse_ignored(stdout: &[u8]) -> Result<IgnoredPaths, &[u8]> {
    let mut dirs: Vec<&[u8]> = Vec::new();
    let mut files: Vec<&[u8]> = Vec::new();
    for record in split_records(stdout)? {
        match record {
            [] | [b'/'] => return Err(record),
            [.., b'/'] => dirs.push(record),
            _ => files.push(record),
        }
    }
    Ok(IgnoredPaths {
        dirs: to_paths(dirs),
        files: to_paths(files),
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    use super::*;
    use crate::test_fixture::{Fixture, names, paths};

    impl Fixture {
        fn ignored_in(&self, dir: &Path) -> IgnoredPaths {
            let git = self.runner();
            let listed = git.ls_ignored(dir, CallOptions::default()).unwrap();
            assert_eq!(git.spawns(), 1);
            listed
        }

        fn ignored(&self) -> IgnoredPaths {
            self.ignored_in(&self.repo())
        }
    }

    /// Asserts `listed` holds exactly `dirs` and `files`, by bytes, so a
    /// dir's trailing `/` is pinned (`PathBuf`'s `==` drops it).
    #[track_caller]
    fn assert_ignored(listed: &IgnoredPaths, dirs: &[&[u8]], files: &[&[u8]]) {
        assert_eq!(names(&listed.dirs), dirs, "dirs");
        assert_eq!(names(&listed.files), files, "files");
    }

    /// A dir-only pattern folds its dir even past a negation inside it (git
    /// can't re-include a file whose dir is excluded); a `dir/*` pattern
    /// with a negation lists the files it ignores. Listed from inside, an
    /// ignored dir is `./` alone.
    #[test]
    fn negations_fold_as_git_ignores() {
        let f = Fixture::new();
        f.write(
            ".gitignore",
            "build/\n!build/keep.txt\nlogs/*\n!logs/keep.log\n",
        );
        f.write("build/a", "a");
        f.write("build/keep.txt", "b");
        f.write("logs/a.log", "c");
        f.write("logs/keep.log", "d");
        assert_ignored(&f.ignored(), &[b"build/"], &[b"logs/a.log"]);
        assert_ignored(&f.ignored_in(&f.repo().join("build")), &[b"./"], &[]);
    }

    /// Listing strictly inside an ignored dir fails in git itself, pinned
    /// here since git's behavior could change.
    #[test]
    fn a_dir_inside_an_ignored_dir_fails() {
        let f = Fixture::new();
        f.write(".gitignore", "build/\n");
        f.write("build/sub/deep/a", "a");
        let e = f
            .runner()
            .ls_ignored(&f.repo().join("build/sub"), CallOptions::default())
            .unwrap_err();
        assert!(
            matches!(
                &e,
                GitError::Failed {
                    code: Some(128),
                    stderr,
                    ..
                } if stderr.contains("not superset of prefix")
            ),
            "{e}"
        );
    }

    /// A dir whose untracked contents are all ignored folds though no
    /// pattern names it, and is listed with those contents, nested dirs and
    /// files alike: what lets a caller settle `dirs` with `check_ignore`
    /// alone, never re-listing. Listed from inside, it's `./` beside them.
    #[test]
    fn a_dir_of_ignored_files_folds_without_being_ignored() {
        let f = Fixture::new();
        f.write(".gitignore", "*.local.json\nnode_modules/\n");
        f.write(".claude/settings.local.json", "a");
        f.write("pkg/node_modules/x/index.js", "b");
        f.write("pkg/sub/y.local.json", "c");
        f.write("pkg/z.local.json", "d");
        assert_ignored(
            &f.ignored(),
            &[b".claude/", b"pkg/", b"pkg/node_modules/", b"pkg/sub/"],
            &[
                b".claude/settings.local.json",
                b"pkg/sub/y.local.json",
                b"pkg/z.local.json",
            ],
        );
        assert_ignored(
            &f.ignored_in(&f.repo().join(".claude")),
            &[b"./"],
            &[b"settings.local.json"],
        );
    }

    /// Ignored paths inside an untracked dir that also holds something not
    /// ignored are listed — what `--no-empty-directory` would drop — and an
    /// empty dir is listed only when ignored itself.
    #[test]
    fn ignored_paths_in_a_mixed_untracked_dir_are_listed() {
        let f = Fixture::new();
        f.write(".gitignore", "node_modules/\n*.tmp\nempty_ignored/\n");
        f.write("pkg/package.json", "a");
        f.write("pkg/node_modules/dep/index.js", "b");
        f.write("pkg/src/a.tmp", "c");
        f.write("pkg/src/main.js", "d");
        f.mkdir("empty");
        f.mkdir("empty_ignored");
        assert_ignored(
            &f.ignored(),
            &[b"empty_ignored/", b"pkg/node_modules/"],
            &[b"pkg/src/a.tmp"],
        );
    }

    /// git doesn't fold a dir the index has entries under, ignored or not.
    #[test]
    fn a_tracked_file_keeps_its_ignored_dir_unfolded() {
        let f = Fixture::new();
        f.write(".gitignore", "gen/\n");
        f.write("gen/tracked", "a");
        f.git(&["add", "-f", "gen/tracked"]);
        f.write("gen/untracked", "b");
        f.write("gen/deeper/c", "c");
        assert_ignored(&f.ignored(), &[b"gen/deeper/"], &[b"gen/untracked"]);
    }

    /// An ignored dir holding a repo of its own is listed whole; a nested
    /// repo that isn't ignored isn't descended.
    #[test]
    fn nested_repos_are_not_descended() {
        let f = Fixture::new();
        f.write(".gitignore", "vendor/\n*.tmp\n");
        f.git(&["init", "-q", "vendor/lib"]);
        f.write("vendor/lib/a", "a");
        f.write("vendor/b", "b");
        f.git(&["init", "-q", "nested"]);
        f.write("nested/c.tmp", "c");
        assert_ignored(&f.ignored(), &[b"vendor/"], &[]);
    }

    #[test]
    fn odd_names_round_trip() {
        let f = Fixture::new();
        f.write(".gitignore", "*.tmp\n");
        for name in [
            &b"-dash.tmp"[..],
            b"with space.tmp",
            b"line\nbreak.tmp",
            b"t\tab.tmp",
            b"caf\xe9.tmp",
            b"\xff\xfe.tmp",
        ] {
            f.write(OsStr::from_bytes(name), "a");
        }
        f.write("kept", "b");
        assert_ignored(
            &f.ignored(),
            &[],
            &[
                b"-dash.tmp",
                b"caf\xe9.tmp",
                b"line\nbreak.tmp",
                b"t\tab.tmp",
                b"with space.tmp",
                b"\xff\xfe.tmp",
            ],
        );
    }

    #[test]
    fn nothing_ignored_lists_nothing() {
        let f = Fixture::new();
        f.write("a", "a");
        assert_ignored(&f.ignored(), &[], &[]);
    }

    #[test]
    fn a_dir_outside_any_working_tree_fails() {
        let f = Fixture::new();
        let outside = f.tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let opts = CallOptions {
            ceiling: Some(f.tmp.path()),
            ..CallOptions::default()
        };
        let e = f.runner().ls_ignored(&outside, opts).unwrap_err();
        assert!(matches!(e, GitError::Failed { .. }), "{e}");
    }

    #[test]
    fn an_implicit_bare_repo_is_refused_when_asked() {
        let f = Fixture::new();
        f.git_in(f.tmp.path(), &["init", "-q", "--bare", "bare.git"], None);
        let opts = CallOptions {
            refuse_implicit_bare: true,
            ..CallOptions::default()
        };
        let e = f
            .runner()
            .ls_ignored(&f.tmp.path().join("bare.git"), opts)
            .unwrap_err();
        assert!(
            matches!(&e, GitError::Failed { stderr, .. } if stderr.contains("safe.bareRepository")),
            "{e}"
        );
        // a working tree is unaffected
        f.write(".gitignore", "*.tmp\n");
        f.write("a.tmp", "a");
        let listed = f.runner().ls_ignored(&f.repo(), opts).unwrap();
        assert_eq!(listed.files, paths(&[b"a.tmp"]));
    }

    #[test]
    fn parses_records() {
        assert_eq!(parse_ignored(b""), Ok(IgnoredPaths::default()));
        assert_ignored(
            &parse_ignored(b"b/\0a\0./\0").unwrap(),
            &[b"./", b"b/"],
            &[b"a"],
        );
        assert_eq!(parse_ignored(b"a\0\0b\0"), Err(&b""[..]));
        assert_eq!(parse_ignored(b"/\0"), Err(&b"/"[..]));
        assert_eq!(parse_ignored(b"a\0b"), Err(&b"b"[..]));
    }
}
