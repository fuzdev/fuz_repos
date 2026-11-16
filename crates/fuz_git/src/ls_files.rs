//! `Git::ls_files`: the files git lists in a working tree — tracked, and
//! untracked but not ignored — apart from the nested repos it doesn't
//! descend into.

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

use crate::runner::{CallOptions, Git, GitError};

/// The listing's arguments: the index's entries (`--cached`) and the
/// untracked files the excludes leave (`--others --exclude-standard`) in one
/// call, so one read of the index decides both. Each record is tagged
/// (`-t`): `? ` for an untracked one, a letter for an index entry, so no
/// untracked name can pass for an entry. Entries carry their mode (`-s`),
/// which is what marks a gitlink. `--format` would print the mode alone but
/// refuses `-o`, and `--deduplicate` does nothing beside `-s` or `-t`, so
/// conflict stages are merged here.
const ARGS: &[&str] = &[
    "ls-files",
    "-z",
    "-t",
    "-s",
    "--cached",
    "--others",
    "--exclude-standard",
];

/// A gitlink's mode in the index.
const GITLINK_MODE: &[u8] = b"160000";

/// How much of an unrecognized record an error quotes.
const QUOTED_RECORD_CAP: usize = 80;

/// What `Git::ls_files` lists, each path relative to the dir it listed and
/// held as git's bytes, each list sorted by those bytes (git's own order).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ListedFiles {
    /// The index's entries that aren't gitlinks, and the untracked files no
    /// exclude ignores. A symlink is listed here too, tracked or not; an
    /// `lstat` tells it apart.
    pub files: Vec<PathBuf>,
    /// The index's gitlinks (mode `160000`): submodules, or a repo added
    /// without one, populated or not. Nothing inside one is listed.
    pub gitlinks: Vec<PathBuf>,
    /// Untracked dirs holding a repo of their own, which git lists as a dir
    /// rather than descending into (given here without git's trailing `/`).
    /// Nothing inside one is listed. A dir the index already has entries
    /// under is descended even when it now holds a repo of its own: its
    /// untracked files are listed as the outer repo's.
    pub nested_repos: Vec<PathBuf>,
}

/// One record of the listing.
#[derive(Debug, PartialEq, Eq)]
enum Record<'a> {
    /// An index entry, one record per stage.
    Entry { path: &'a [u8], gitlink: bool },
    /// An untracked path, a nested repo's with a trailing `/`.
    Untracked(&'a [u8]),
}

impl Git {
    /// Lists the files under `dir` that git knows or would add, with the
    /// nested repos it stops at, in one `git ls-files` call (one spawn).
    ///
    /// `dir` is a working tree's top level or a dir inside one; as with git's
    /// own `ls-files`, what's listed is `dir`'s subtree, relative to `dir`.
    /// An unpopulated gitlink's dir is a dir of the superproject, so
    /// listing it gives that gitlink alone, as `gitlinks == ["./"]`.
    ///
    /// - **Index entries** are listed whatever the disk holds: a file
    ///   deleted from disk but not from the index is listed, and so is a
    ///   skip-worktree entry (a sparse checkout's, usually absent from
    ///   disk). Nothing is checked on disk here: a caller indexing the paths
    ///   reads each one's metadata anyway, and a check made here would have
    ///   aged by the time it did.
    /// - **A conflicted path** is listed once, among the gitlinks when any
    ///   of its stages is one.
    /// - **Untracked files** are those no `.gitignore`, `info/exclude`, or
    ///   global excludes file ignores — `core.excludesFile`, by default
    ///   `$XDG_CONFIG_HOME/git/ignore`, else `$HOME/.config/git/ignore`.
    ///   The last applies only when the environment git sees has
    ///   `XDG_CONFIG_HOME` or `HOME`: a `Git::with_clean_env` runner must
    ///   carry one for it to.
    /// - **Case** is as git holds it: the index's spelling for an entry, the
    ///   disk's for an untracked file. Under `core.ignoreCase` a file on
    ///   disk that differs from an entry only in case is that entry, not an
    ///   untracked file.
    /// - **Names** are git's bytes, unquoted (`-z`): a name that isn't UTF-8,
    ///   or holds a tab or a newline, is kept whole.
    ///
    /// `opts` is the call's, as for `Git::output`: `opts.timeout` replaces
    /// the local default (an interactive caller passes a shorter one), and
    /// `opts.ceiling` keeps a `dir` outside any repo from resolving to a
    /// parent's.
    ///
    /// # Errors
    ///
    /// As `Git::output`, including `Failed` when `dir` isn't in a working
    /// tree, and `OutputTooLarge` when the listing passes the runner's
    /// stdout cap (its `cap`) — usually a huge untracked tree; it's returned
    /// as is, so the caller can fall back to a walk of its own.
    /// `UnexpectedOutput` when a record isn't one git's `ls-files` prints.
    pub fn ls_files(&self, dir: &Path, opts: CallOptions<'_>) -> Result<ListedFiles, GitError> {
        let stdout = self.output(dir, ARGS, opts)?;
        parse_listing(&stdout).map_err(|record| GitError::UnexpectedOutput {
            args: ARGS.join(" "),
            detail: format!("record `{}`", quote_record(record)),
        })
    }
}

/// Parses the listing's NUL-terminated records into `ListedFiles`, or
/// returns the first record it doesn't recognize.
fn parse_listing(stdout: &[u8]) -> Result<ListedFiles, &[u8]> {
    let mut entries: Vec<(&[u8], bool)> = Vec::new();
    let mut files: Vec<&[u8]> = Vec::new();
    let mut nested_repos: Vec<&[u8]> = Vec::new();
    if !stdout.is_empty() {
        // every record ends in a NUL, the last one included; an
        // unterminated one is what follows the last NUL
        let body = stdout.strip_suffix(b"\0").ok_or_else(|| {
            stdout
                .iter()
                .rposition(|&b| b == 0)
                .map_or(stdout, |nul| &stdout[nul + 1..])
        })?;
        for record in body.split(|&b| b == 0) {
            match parse_record(record).ok_or(record)? {
                Record::Entry { path, gitlink } => entries.push((path, gitlink)),
                Record::Untracked(path) => match path.strip_suffix(b"/") {
                    Some(repo) => nested_repos.push(repo),
                    None => files.push(path),
                },
            }
        }
    }
    // a conflicted path's stages are adjacent in the index; kept once, a
    // gitlink if any stage is one
    entries.dedup_by(|next, kept| {
        let same = next.0 == kept.0;
        if same {
            kept.1 |= next.1;
        }
        same
    });
    let mut gitlinks = Vec::new();
    for (path, gitlink) in entries {
        if gitlink {
            gitlinks.push(path);
        } else {
            files.push(path);
        }
    }
    Ok(ListedFiles {
        files: to_paths(files),
        gitlinks: to_paths(gitlinks),
        nested_repos: to_paths(nested_repos),
    })
}

/// Parses one record: `? <path>` for an untracked path, or `<tag> <mode>
/// <object> <stage>\t<path>` for an index entry.
fn parse_record(record: &[u8]) -> Option<Record<'_>> {
    let (&tag, rest) = record.split_first()?;
    let rest = rest.strip_prefix(b" ")?;
    if tag == b'?' {
        return (!rest.is_empty()).then_some(Record::Untracked(rest));
    }
    let tab = rest.iter().position(|&b| b == b'\t')?;
    let (meta, path) = (&rest[..tab], &rest[tab + 1..]);
    let mut fields = meta.split(|&b| b == b' ');
    let mode = fields.next()?;
    let object = fields.next()?;
    let stage = fields.next()?;
    let well_formed = tag.is_ascii_uppercase()
        && mode.len() == 6
        && mode.iter().all(|b| (b'0'..=b'7').contains(b))
        && !object.is_empty()
        && object.iter().all(u8::is_ascii_hexdigit)
        && matches!(stage, [b'0'..=b'3'])
        && fields.next().is_none()
        && !path.is_empty();
    well_formed.then_some(Record::Entry {
        path,
        gitlink: mode == GITLINK_MODE,
    })
}

/// Sorts `names` by their bytes and makes them paths, losslessly.
fn to_paths(mut names: Vec<&[u8]>) -> Vec<PathBuf> {
    names.sort_unstable();
    names
        .into_iter()
        .map(|name| PathBuf::from(OsString::from_vec(name.to_vec())))
        .collect()
}

/// An unrecognized record for an error message: lossily decoded, control
/// characters escaped, capped. Only enough bytes for the cap are decoded (a
/// char is at most 4), so a huge record isn't copied whole.
fn quote_record(record: &[u8]) -> String {
    let head = &record[..record.len().min(QUOTED_RECORD_CAP * 4)];
    String::from_utf8_lossy(head)
        .chars()
        .flat_map(char::escape_debug)
        .take(QUOTED_RECORD_CAP)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    use super::*;

    /// A repo at `<tmp>/repo` with a home at `<tmp>/home`, and the clean
    /// environment its runners see: `PATH`, that `HOME`, and no system
    /// config.
    struct Fixture {
        tmp: tempfile::TempDir,
        env: Vec<(OsString, OsString)>,
    }

    impl Fixture {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::create_dir(tmp.path().join("home")).unwrap();
            let mut env: Vec<(OsString, OsString)> = vec![
                ("HOME".into(), tmp.path().join("home").into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ];
            env.extend(std::env::var_os("PATH").map(|p| ("PATH".into(), p)));
            let fixture = Self { tmp, env };
            fixture.git_in(fixture.tmp.path(), &["init", "-q", "repo"], None);
            fixture
        }

        fn repo(&self) -> PathBuf {
            self.tmp.path().join("repo")
        }

        /// Runs a setup call in `dir` on a runner of its own.
        fn git_in(&self, dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> String {
            let opts = CallOptions {
                stdin,
                ..CallOptions::default()
            };
            Git::with_clean_env(self.env.clone())
                .output_string(dir, args, opts)
                .unwrap()
        }

        fn git(&self, args: &[&str]) -> String {
            self.git_in(&self.repo(), args, None)
        }

        /// Writes `contents` at `name` under the repo, creating its dirs.
        fn write(&self, name: impl AsRef<OsStr>, contents: &str) {
            let path = self.repo().join(name.as_ref());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }

        fn list(&self) -> (ListedFiles, u32) {
            list_with(&self.repo(), self.env.clone())
        }
    }

    /// Lists `dir` on a fresh runner over `env`, returning its spawn count
    /// too.
    fn list_with(dir: &Path, env: Vec<(OsString, OsString)>) -> (ListedFiles, u32) {
        let git = Git::with_clean_env(env);
        let listed = git.ls_files(dir, CallOptions::default()).unwrap();
        (listed, git.spawns())
    }

    fn paths(names: &[&[u8]]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|n| PathBuf::from(OsStr::from_bytes(n)))
            .collect()
    }

    /// A made-up commit id, for a gitlink no object backs.
    const COMMIT: &str = "1111111111111111111111111111111111111111";

    #[test]
    fn lists_tracked_and_untracked_files_but_not_ignored_ones() {
        let f = Fixture::new();
        f.write(".gitignore", "*.log\n");
        f.write("tracked", "a");
        f.write("dir/x", "b");
        f.write("t\tab", "c");
        f.write(OsStr::from_bytes(b"\xff\xfe"), "d");
        f.git(&["add", "-A"]);
        f.write("untracked", "e");
        f.write("dir/new", "f");
        f.write("line\nbreak", "g");
        f.write(OsStr::from_bytes(b"caf\xe9"), "h");
        // ignored by the tree, by `info/exclude`, and by the global file
        f.write("a.log", "i");
        f.write("dir/b.log", "j");
        f.write(".git/info/exclude", "excluded\n");
        f.write("excluded", "k");
        let global = f.tmp.path().join("home/.config/git");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("ignore"), "*.tmp\n").unwrap();
        f.write("global.tmp", "l");

        let (listed, spawns) = f.list();
        assert_eq!(
            listed,
            ListedFiles {
                files: paths(&[
                    b".gitignore",
                    b"caf\xe9",
                    b"dir/new",
                    b"dir/x",
                    b"line\nbreak",
                    b"t\tab",
                    b"tracked",
                    b"untracked",
                    b"\xff\xfe",
                ]),
                gitlinks: vec![],
                nested_repos: vec![],
            }
        );
        assert_eq!(spawns, 1);
    }

    /// The global excludes file is found through the environment's `HOME`.
    #[test]
    fn the_global_excludes_file_needs_home() {
        let f = Fixture::new();
        let global = f.tmp.path().join("home/.config/git");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("ignore"), "*.tmp\n").unwrap();
        f.write("global.tmp", "a");
        assert_eq!(f.list().0.files, Vec::<PathBuf>::new());

        let mut homeless = f.env.clone();
        homeless.retain(|(k, _)| k != "HOME");
        let (listed, _) = list_with(&f.repo(), homeless);
        assert_eq!(listed.files, paths(&[b"global.tmp"]));
    }

    #[test]
    fn nested_repos_and_gitlinks_are_listed_apart_and_not_descended() {
        let f = Fixture::new();
        f.write("file", "a");
        // an untracked repo
        f.git(&["init", "-q", "nested"]);
        f.write("nested/inner", "b");
        // a populated gitlink, and one with nothing on disk
        f.git(&["init", "-q", "sub"]);
        f.write("sub/inner", "c");
        f.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{COMMIT},sub"),
        ]);
        f.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{COMMIT},unpopulated"),
        ]);

        let (listed, spawns) = f.list();
        assert_eq!(
            listed,
            ListedFiles {
                files: paths(&[b"file"]),
                gitlinks: paths(&[b"sub", b"unpopulated"]),
                nested_repos: paths(&[b"nested"]),
            }
        );
        assert_eq!(spawns, 1);
    }

    /// Index entries are listed whatever the disk holds.
    #[test]
    fn deleted_and_skip_worktree_entries_are_listed() {
        let f = Fixture::new();
        f.write("deleted", "a");
        f.write("skipped", "b");
        f.write("kept", "c");
        f.git(&["add", "-A"]);
        f.git(&["update-index", "--skip-worktree", "skipped"]);
        std::fs::remove_file(f.repo().join("deleted")).unwrap();
        std::fs::remove_file(f.repo().join("skipped")).unwrap();
        assert_eq!(f.list().0.files, paths(&[b"deleted", b"kept", b"skipped"]));
    }

    #[test]
    fn a_conflicted_path_is_listed_once() {
        let f = Fixture::new();
        let blob = f.git_in(
            &f.repo(),
            &["hash-object", "-w", "--stdin"],
            Some(b"x".as_slice()),
        );
        let blob = blob.trim();
        // every stage a file; and one stage a gitlink
        let index_info = format!(
            "100644 {blob} 1\tconflicted\n100644 {blob} 2\tconflicted\n100644 {blob} 3\tconflicted\n\
             100644 {blob} 1\tlinked\n160000 {COMMIT} 2\tlinked\n100644 {blob} 3\tlinked\n"
        );
        f.git_in(
            &f.repo(),
            &["update-index", "--index-info"],
            Some(index_info.as_bytes()),
        );
        let stages = f.git(&["ls-files", "-s"]);
        assert_eq!(stages.lines().count(), 6, "{stages}");

        let (listed, spawns) = f.list();
        assert_eq!(
            listed,
            ListedFiles {
                files: paths(&[b"conflicted"]),
                gitlinks: paths(&[b"linked"]),
                nested_repos: vec![],
            }
        );
        assert_eq!(spawns, 1);
    }

    #[test]
    fn an_empty_repo_lists_nothing() {
        let f = Fixture::new();
        assert_eq!(f.list(), (ListedFiles::default(), 1));
    }

    /// A dir inside the working tree lists its own subtree, relative to it.
    #[test]
    fn a_subdir_lists_its_subtree_relative_to_itself() {
        let f = Fixture::new();
        f.write("top", "a");
        f.write("dir/tracked", "b");
        f.git(&["add", "-A"]);
        f.write("dir/deeper/untracked", "c");
        let (listed, _) = list_with(&f.repo().join("dir"), f.env);
        assert_eq!(listed.files, paths(&[b"deeper/untracked", b"tracked"]));
    }

    #[test]
    fn a_dir_outside_any_working_tree_fails() {
        let f = Fixture::new();
        let outside = f.tmp.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let git = Git::with_clean_env(f.env.clone());
        let opts = CallOptions {
            ceiling: Some(f.tmp.path()),
            ..CallOptions::default()
        };
        let e = git.ls_files(&outside, opts).unwrap_err();
        assert!(matches!(e, GitError::Failed { .. }), "{e}");

        // a plain dir in the repo resolves to it, unless the ceiling stops
        // discovery at the repo
        let repo = f.repo();
        let inner = repo.join("inner");
        std::fs::create_dir(&inner).unwrap();
        let opts = CallOptions {
            ceiling: Some(&repo),
            ..CallOptions::default()
        };
        let e = git.ls_files(&inner, opts).unwrap_err();
        assert!(matches!(e, GitError::Failed { .. }), "{e}");
        let listed = git.ls_files(&inner, CallOptions::default()).unwrap();
        assert_eq!(listed, ListedFiles::default());
    }

    #[test]
    fn parses_records() {
        let entry = |path: &'static [u8], gitlink| Some(Record::Entry { path, gitlink });
        for (record, expected) in [
            (&b"? a/b"[..], Some(Record::Untracked(b"a/b"))),
            (b"? nested/", Some(Record::Untracked(b"nested/"))),
            // a name that looks like an entry is still untracked
            (
                b"? H 100644 abc 0\tx",
                Some(Record::Untracked(b"H 100644 abc 0\tx")),
            ),
            (b"H 100644 0123abcdef 0\tp", entry(b"p", false)),
            (b"S 100755 0123abcdef 0\tp", entry(b"p", false)),
            (b"M 160000 0123abcdef 2\tp", entry(b"p", true)),
            // the path runs from the first tab
            (b"H 120000 0123abcdef 0\ta\tb", entry(b"a\tb", false)),
            // not a record
            (b"", None),
            (b"?", None),
            (b"? ", None),
            (b"?x", None),
            (b"a/b", None),
            (b"H 100644 0123abcdef 0", None),
            (b"H 100644 0123abcdef 0\t", None),
            (b"H 10064 0123abcdef 0\tp", None),
            (b"H 100648 0123abcdef 0\tp", None),
            (b"H 100644 xyz 0\tp", None),
            (b"H 100644 0123abcdef 4\tp", None),
            (b"H 100644 0123abcdef\tp", None),
            (b"H 100644 0123abcdef 0 extra\tp", None),
            (b"h 100644 0123abcdef 0\tp", None),
        ] {
            assert_eq!(parse_record(record), expected, "{record:?}");
        }
    }

    #[test]
    fn an_unrecognized_listing_names_its_record() {
        assert_eq!(parse_listing(b""), Ok(ListedFiles::default()));
        // the last record unterminated
        assert_eq!(parse_listing(b"? a\0? b"), Err(&b"? b"[..]));
        assert_eq!(parse_listing(b"? b"), Err(&b"? b"[..]));
        assert_eq!(parse_listing(b"? a\0junk\0"), Err(&b"junk"[..]));
        assert_eq!(parse_listing(b"? a\0\0? b\0"), Err(&b""[..]));
        assert_eq!(quote_record(&[b'x'; 200]).len(), QUOTED_RECORD_CAP);
        // non-UTF-8 bytes past the cap's worth aren't decoded
        assert_eq!(
            quote_record(&[0xff; 1000]).chars().count(),
            QUOTED_RECORD_CAP
        );
        assert_eq!(quote_record(b"a\tb\xff"), "a\\tb\u{fffd}");
    }
}
