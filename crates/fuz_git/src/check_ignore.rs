//! `Git::check_ignore`: which of a set of paths git's excludes ignore, for a
//! caller vetting paths one by one — a folded dir from `Git::ls_ignored`,
//! or a path that just appeared.

use std::ops::Range;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::records::{quote_record, split_records};
use crate::runner::{CallOptions, Git, GitError};

/// The check's arguments: paths on stdin and answers on stdout, both
/// NUL-terminated, so any name round-trips.
///
/// Not `--no-index`: without it a tracked path is never ignored, whatever
/// the excludes say, which is git's own answer for what it would add — and
/// what a caller pruning a walk wants, since tracked files stay listed.
/// Not `--verbose`: it reports paths a negation matched too, which aren't
/// ignored, where the plain form reports exactly the ignored ones.
const ARGS: &[&str] = &["check-ignore", "--stdin", "-z"];

/// How git refuses a path inside a submodule, under the runner's `LC_ALL=C`:
/// `fatal: Pathspec '<path>' is in submodule '<name>'`.
const SUBMODULE_PREFIX: &str = "fatal: Pathspec '";
const SUBMODULE_INFIX: &str = "' is in submodule '";

impl Git {
    /// Returns the paths among `paths` that git's excludes ignore, in their
    /// given order, with one `git check-ignore` call (one spawn), or none
    /// when `paths` is empty.
    ///
    /// Each path is relative to `dir` (a working tree's top level or a dir
    /// inside one), or absolute. The excludes are those `Git::ls_ignored`
    /// applies.
    ///
    /// - **Paths are normalized** on their bytes before they're sent, as git
    ///   would normalize them itself, the disk untouched: `.` components and
    ///   repeated `/` dropped, each `x/..` resolved lexically (so through a
    ///   symlink named `x` too), and trailing slashes stripped. The caller
    ///   still gets its own paths back, each one answered, duplicates and
    ///   paths that normalize alike included. A relative path that
    ///   normalizes to `dir` itself (`""`, `.`, `./`, `a/..`) or climbs
    ///   above it (`../x`, `a/../../x`) is refused: to ask about `dir`, ask
    ///   from its parent. An absolute path normalizes the same way, with a
    ///   `..` at `/` staying there (git itself refuses such a path; this
    ///   answers it as POSIX resolves it); git refuses one outside the
    ///   working tree.
    /// - **Dirs** are asked about without their trailing `/`: with one, git
    ///   answers a dir as ignored when a pattern matches its contents
    ///   (`logs/*`) though a negation keeps some of them (`!logs/keep.log`).
    ///   git learns that a path is a dir from the disk, so a dir-only
    ///   pattern like `build/` still matches an existing dir; a path that
    ///   doesn't exist is no dir, and no dir-only pattern matches it. Its
    ///   answer is about a file, then: a caller that later finds a dir
    ///   there asks again. The dirs above a missing path still count as
    ///   dirs, so under `build/` a missing `nowhere/build/x` is ignored.
    ///
    /// - **Tracked paths** are never ignored (see `ARGS`).
    /// - **A path under an ignored dir** is ignored, as git can't re-include
    ///   a file whose dir is excluded, even with a negation naming it.
    /// - **A path inside a submodule** fails the whole call: callers filter
    ///   out paths under the gitlinks `Git::ls_files` lists first. A path
    ///   inside an untracked nested repo is answered by the outer repo's
    ///   excludes, as git would if it descended there.
    /// - **Names** are git's bytes: each relative path is sent as `./<path>`,
    ///   so a name starting with `:` is a name, not pathspec magic (which
    ///   `check-ignore` honours and `--literal-pathspecs` would refuse).
    ///
    /// `opts` is the call's, as for `Git::ls_ignored`, except `opts.stdin`,
    /// which this call replaces with `paths`.
    ///
    /// # Errors
    ///
    /// `PathHasNul` when a path holds a NUL byte, and `PathNotBelowDir` when
    /// a relative path normalizes to `dir` or above it, before anything
    /// runs.
    /// `InSubmodule` when a path is inside a submodule. As `Git::run`
    /// otherwise, plus `Failed` on any exit but `0` (some ignored) and `1`
    /// (none ignored) — `dir` outside a working tree, or a path outside it.
    /// `UnexpectedOutput` when git answers with a path it wasn't asked
    /// about, out of order, or unterminated. A path beyond a symlink
    /// (`fatal: pathspec … is beyond a symbolic link`, exit 128) is
    /// `Failed`.
    ///
    /// Any one bad path fails the whole batch, discarding git's answers for
    /// the rest: a caller treats a failure as "re-prune" (drop the bad path
    /// and check again, or fall back to its own walk), never as "nothing
    /// ignored".
    pub fn check_ignore<P: AsRef<Path>>(
        &self,
        dir: &Path,
        paths: &[P],
        opts: CallOptions<'_>,
    ) -> Result<Vec<PathBuf>, GitError> {
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let (stdin, sent) = encode_paths(paths)?;
        let out = self.run(
            dir,
            ARGS,
            CallOptions {
                stdin: Some(&stdin),
                ..opts
            },
        )?;
        match out.status.code() {
            Some(0 | 1) => {}
            Some(128) if is_submodule_refusal(&out.stderr) => {
                return Err(GitError::InSubmodule {
                    args: ARGS.join(" "),
                    stderr: out.stderr.trim().to_owned(),
                });
            }
            code => {
                return Err(GitError::Failed {
                    args: ARGS.join(" "),
                    code,
                    stderr: out.stderr.trim().to_owned(),
                });
            }
        }
        let ignored = match_answers(&out.stdout, &stdin, &sent).map_err(|record| {
            GitError::UnexpectedOutput {
                args: ARGS.join(" "),
                detail: format!("record `{}`", quote_record(record)),
            }
        })?;
        Ok(ignored
            .into_iter()
            .map(|i| paths[i].as_ref().to_path_buf())
            .collect())
    }
}

/// `paths` as `check-ignore --stdin -z` reads them, each normalized
/// (`normalize_path`), with each one's range in that input.
fn encode_paths<P: AsRef<Path>>(paths: &[P]) -> Result<(Vec<u8>, Vec<Range<usize>>), GitError> {
    let mut stdin = Vec::new();
    let mut sent = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = path.as_ref().as_os_str().as_bytes();
        if bytes.contains(&0) {
            return Err(GitError::PathHasNul {
                path: quote_record(bytes),
            });
        }
        let start = stdin.len();
        if !normalize_path(bytes, &mut stdin) {
            return Err(GitError::PathNotBelowDir {
                path: quote_record(bytes),
            });
        }
        sent.push(start..stdin.len());
        stdin.push(0);
    }
    Ok((stdin, sent))
}

/// Appends `path` to `out` normalized textually, as git normalizes a path
/// before matching it: `.` components and empty ones (repeated or trailing
/// `/`) dropped, and each `..` taking the component before it. A relative
/// path is written as `./<path>` (`Git::check_ignore` says why), an
/// absolute one from its `/`, where a `..` stays.
///
/// Returns false, `out` then holding part of the path, when a relative path
/// normalizes to nothing (the dir it's asked from) or a `..` climbs above
/// its start.
fn normalize_path(path: &[u8], out: &mut Vec<u8>) -> bool {
    let absolute = path.starts_with(b"/");
    let mut parts: Vec<&[u8]> = Vec::new();
    for part in path.split(|&b| b == b'/') {
        match part {
            b"" | b"." => {}
            b".." => {
                if parts.pop().is_none() && !absolute {
                    return false;
                }
            }
            _ => parts.push(part),
        }
    }
    if absolute {
        out.push(b'/');
    } else if parts.is_empty() {
        return false;
    } else {
        out.extend_from_slice(b"./");
    }
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(b'/');
        }
        out.extend_from_slice(part);
    }
    true
}

/// Matches git's answers to the paths sent, each to the next one sent that
/// it equals (git answers in input order, echoing each path as sent),
/// returning their indexes, or the first answer that matches none.
fn match_answers<'a>(
    stdout: &'a [u8],
    stdin: &[u8],
    sent: &[Range<usize>],
) -> Result<Vec<usize>, &'a [u8]> {
    let mut ignored = Vec::new();
    let mut next = 0;
    for record in split_records(stdout)? {
        let found = sent[next..]
            .iter()
            .position(|range| &stdin[range.clone()] == record)
            .ok_or(record)?;
        ignored.push(next + found);
        next += found + 1;
    }
    Ok(ignored)
}

/// Whether `stderr` is git refusing a path inside a submodule. Tested on the
/// whole of `stderr`, not line by line, since the quoted path may hold a
/// newline itself.
fn is_submodule_refusal(stderr: &str) -> bool {
    stderr.contains(SUBMODULE_PREFIX) && stderr.contains(SUBMODULE_INFIX)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use super::*;
    use crate::test_fixture::{Fixture, names, paths};

    impl Fixture {
        /// Checks `names` in the repo on a fresh runner, asserting one spawn.
        fn check(&self, names: &[&[u8]]) -> Result<Vec<PathBuf>, GitError> {
            let git = self.runner();
            let result = git.check_ignore(&self.repo(), &paths(names), CallOptions::default());
            assert_eq!(git.spawns(), 1);
            result
        }
    }

    #[test]
    fn negations_are_answered_as_git_ignores() {
        let f = Fixture::new();
        f.write(
            ".gitignore",
            "build/\n!build/keep.txt\nlogs/*\n!logs/keep.log\n",
        );
        f.write("build/a", "a");
        f.write("build/keep.txt", "b");
        f.write("logs/a.log", "c");
        f.write("logs/keep.log", "d");
        f.write("sub/build/b", "e");
        let sent: &[&[u8]] = &[
            b"build/",
            b"build/keep.txt",
            b"logs/a.log",
            b"logs/keep.log",
            // a dir-only pattern matches a dir that exists, with or without
            // its `/`, at any depth
            b"build",
            b"sub/build/",
            // and no path that doesn't, its `/` stripped
            b"nowhere/build/",
            // though the dirs above a missing path count as dirs
            b"nowhere/build/x",
        ];
        // by bytes, pinning that the caller's own paths come back
        assert_eq!(
            names(&f.check(sent).unwrap()),
            [
                &b"build/"[..],
                b"build/keep.txt",
                b"logs/a.log",
                b"build",
                b"sub/build/",
                b"nowhere/build/x"
            ]
        );
    }

    /// A dir with a negated file inside isn't ignored, asked about with its
    /// `/` or without, though its other contents are.
    #[test]
    fn a_dir_keeping_a_negated_file_is_not_ignored() {
        let f = Fixture::new();
        f.write(
            ".gitignore",
            "logs/*\n!logs/keep.log\nfoo/**\n!foo/keep.txt\nout/*\n!out/keep/\n",
        );
        f.write("logs/a.log", "a");
        f.write("logs/keep.log", "b");
        f.write("foo/a", "c");
        f.write("foo/keep.txt", "d");
        f.write("out/a", "e");
        f.write("out/keep/b", "f");
        assert_eq!(
            names(
                &f.check(&[
                    b"logs/",
                    b"logs",
                    b"logs//",
                    b"logs/a.log",
                    b"foo/",
                    b"foo/a",
                    b"out/",
                    b"out/keep/",
                    b"out/a",
                ])
                .unwrap()
            ),
            [&b"logs/a.log"[..], b"foo/a", b"out/a"]
        );
    }

    /// The same dir asked about with its `/` and without is answered for
    /// each, as the caller spelled it, in order.
    #[test]
    fn a_dir_asked_twice_is_answered_twice() {
        let f = Fixture::new();
        f.write(".gitignore", "a/\n");
        f.write("a/x", "a");
        assert_eq!(
            names(&f.check(&[b"a/", b"b", b"a"]).unwrap()),
            [&b"a/"[..], b"a"]
        );
    }

    /// A dir `ls_ignored` folds because its only untracked file is ignored
    /// isn't ignored itself.
    #[test]
    fn a_folded_dir_of_ignored_files_is_not_ignored() {
        let f = Fixture::new();
        f.write(".gitignore", "*.local.json\n");
        f.write(".claude/settings.local.json", "a");
        assert_eq!(
            f.check(&[b".claude/", b".claude/settings.local.json"])
                .unwrap(),
            paths(&[b".claude/settings.local.json"])
        );
    }

    /// Without `--no-index`, a tracked file is never ignored, though its
    /// dir's pattern matches it.
    #[test]
    fn a_tracked_file_in_an_ignored_dir_is_not_ignored() {
        let f = Fixture::new();
        f.write(".gitignore", "gen/\n");
        f.write("gen/tracked", "a");
        f.git(&["add", "-f", "gen/tracked"]);
        f.write("gen/untracked", "b");
        assert_eq!(
            f.check(&[b"gen/tracked", b"gen/untracked"]).unwrap(),
            paths(&[b"gen/untracked"])
        );
    }

    /// git exits 1 when nothing is ignored, which is an answer, not a
    /// failure.
    #[test]
    fn none_ignored_is_empty() {
        let f = Fixture::new();
        f.write(".gitignore", "*.tmp\n");
        assert_eq!(f.check(&[b"a", b"b/"]).unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn no_paths_run_nothing() {
        let f = Fixture::new();
        let git = f.runner();
        let none: &[&Path] = &[];
        assert_eq!(
            git.check_ignore(&f.repo(), none, CallOptions::default())
                .unwrap(),
            Vec::<PathBuf>::new()
        );
        assert_eq!(git.spawns(), 0);
    }

    #[test]
    fn a_path_in_a_submodule_is_refused_distinctly() {
        let f = Fixture::new();
        f.write(".gitignore", "*.tmp\n");
        f.git(&["init", "-q", "sub"]);
        f.write("sub/inner", "a");
        f.git(&[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,1111111111111111111111111111111111111111,sub",
        ]);
        let e = f.check(&[b"a.tmp", b"sub/inner"]).unwrap_err();
        assert!(matches!(e, GitError::InSubmodule { .. }), "{e}");
        // the gitlink itself is an ordinary path
        assert_eq!(f.check(&[b"sub"]).unwrap(), Vec::<PathBuf>::new());
    }

    #[test]
    fn odd_names_round_trip_in_order() {
        let f = Fixture::new();
        // only a top-level `n.ign`: as magic, `:(top)n.ign` would name it
        f.write(".gitignore", "*.tmp\n/n.ign\n");
        let absolute = f.repo().join("abs.tmp");
        let names: Vec<PathBuf> = [
            &b"z.tmp"[..],
            b"-dash.tmp",
            b"with space.tmp",
            b"kept",
            b"line\nbreak.tmp",
            b"caf\xe9.tmp",
            b"\xff\xfe.tmp",
            b":(top)n.ign",
            // twice, answered twice
            b"z.tmp",
        ]
        .iter()
        .map(|n| PathBuf::from(OsStr::from_bytes(n)))
        .chain([absolute.clone()])
        .collect();
        let ignored = f
            .runner()
            .check_ignore(&f.repo(), &names, CallOptions::default())
            .unwrap();
        let mut expected = paths(&[
            b"z.tmp",
            b"-dash.tmp",
            b"with space.tmp",
            b"line\nbreak.tmp",
            b"caf\xe9.tmp",
            b"\xff\xfe.tmp",
            b"z.tmp",
        ]);
        expected.push(absolute);
        assert_eq!(ignored, expected);
    }

    #[test]
    fn a_path_with_a_nul_runs_nothing() {
        let f = Fixture::new();
        let git = f.runner();
        let e = git
            .check_ignore(
                &f.repo(),
                &[Path::new(OsStr::from_bytes(b"a\0b"))],
                CallOptions::default(),
            )
            .unwrap_err();
        assert!(matches!(e, GitError::PathHasNul { .. }), "{e}");
        assert_eq!(git.spawns(), 0);
    }

    #[test]
    fn a_path_outside_the_working_tree_fails() {
        let f = Fixture::new();
        let outside = f.tmp.path().join("x");
        let e = f
            .runner()
            .check_ignore(&f.repo(), &[outside], CallOptions::default())
            .unwrap_err();
        assert!(
            matches!(
                e,
                GitError::Failed {
                    code: Some(128),
                    ..
                }
            ),
            "{e}"
        );
    }

    /// A relative path naming `dir` itself or climbing above it is refused
    /// before git runs, alone or among others.
    #[test]
    fn a_path_at_or_above_dir_runs_nothing() {
        let f = Fixture::new();
        f.mkdir("logs");
        for (dir, name) in [
            ("", &b""[..]),
            ("", b"."),
            ("", b"./"),
            ("", b".//."),
            ("", b"a/.."),
            ("", b"a/../"),
            ("", b"../x"),
            ("", b"a/../../x"),
            ("", b".."),
            ("logs", b""),
            ("logs", b"."),
            ("logs", b"./"),
            ("logs", b"../logs/x"),
        ] {
            let git = f.runner();
            let e = git
                .check_ignore(
                    &f.repo().join(dir),
                    &paths(&[b"ok", name]),
                    CallOptions::default(),
                )
                .unwrap_err();
            assert!(
                matches!(e, GitError::PathNotBelowDir { .. }),
                "{dir:?} {name:?}: {e}"
            );
            assert_eq!(git.spawns(), 0);
        }
    }

    /// A path ending in `.` or `..` would reach git with a trailing `/`
    /// after its own normalization, which answers a dir keeping a negated
    /// file as ignored; normalized first, each is answered as the dir.
    #[test]
    fn dot_components_are_normalized_before_asking() {
        let f = Fixture::new();
        f.write(".gitignore", "logs/*\n!logs/keep.log\n");
        f.write("logs/a.log", "a");
        f.write("logs/keep.log", "b");
        let sent: &[&[u8]] = &[
            b"logs/.",
            b"logs/./",
            b"logs/a.log/..",
            b"logs/nope/..",
            b"./logs/./a.log",
            b"x/../logs//a.log/.",
        ];
        assert_eq!(
            names(&f.check(sent).unwrap()),
            [&b"./logs/./a.log"[..], b"x/../logs//a.log/."]
        );
        let absolute = f.repo().join("logs/.");
        let absolute_ignored = f.repo().join("logs/./a.log");
        assert_eq!(
            f.runner()
                .check_ignore(
                    &f.repo(),
                    &[absolute, absolute_ignored.clone()],
                    CallOptions::default()
                )
                .unwrap(),
            [absolute_ignored]
        );
        // from inside `logs`, a lexical `..` mid-path resolves within it
        assert_eq!(
            names(
                &f.runner()
                    .check_ignore(
                        &f.repo().join("logs"),
                        &paths(&[b"keep.log", b"x/../a.log", b"x/./../keep.log/"]),
                        CallOptions::default()
                    )
                    .unwrap()
            ),
            [&b"x/../a.log"[..]]
        );
    }

    /// Paths that differ only textually normalize alike, and each is
    /// answered as its caller spelled it.
    #[test]
    fn paths_normalizing_alike_are_each_answered() {
        let f = Fixture::new();
        f.write(".gitignore", "a\n");
        f.write("a", "a");
        let sent: &[&[u8]] = &[b"a", b"a/", b"./a", b"a/.", b"b", b"b/../a"];
        assert_eq!(
            names(&f.check(sent).unwrap()),
            [&b"a"[..], b"a/", b"./a", b"a/.", b"b/../a"]
        );
    }

    #[test]
    fn matches_answers_to_paths_sent() {
        let (stdin, sent) = encode_paths(&[
            Path::new("a"),
            Path::new("/abs/"),
            Path::new("a//"),
            Path::new("./b/."),
        ])
        .unwrap();
        // normalized
        assert_eq!(stdin, b"./a\0/abs\0./a\0./b\0");
        assert_eq!(match_answers(b"", &stdin, &sent), Ok(vec![]));
        assert_eq!(
            match_answers(b"./a\0./a\0./b\0", &stdin, &sent),
            Ok(vec![0, 2, 3])
        );
        // as sent, never stripped
        assert_eq!(match_answers(b"a\0", &stdin, &sent), Err(&b"a"[..]));
        // out of order
        assert_eq!(
            match_answers(b"/abs\0./a\0/abs\0", &stdin, &sent),
            Err(&b"/abs"[..])
        );
        assert_eq!(match_answers(b"./a", &stdin, &sent), Err(&b"./a"[..]));
    }

    #[test]
    fn normalizes_paths() {
        for (path, normalized) in [
            (&b"a"[..], Some(&b"./a"[..])),
            (b"a/", Some(b"./a")),
            (b"a//", Some(b"./a")),
            (b"a/b/", Some(b"./a/b")),
            (b"a//b", Some(b"./a/b")),
            (b"./a/./b/.", Some(b"./a/b")),
            (b"a/b/../c", Some(b"./a/c")),
            (b"a/b/c/../../d/..", Some(b"./a")),
            (b"a/./../b", Some(b"./b")),
            (b"...", Some(b"./...")),
            (b"..a/.b", Some(b"./..a/.b")),
            (b"/abs/", Some(b"/abs")),
            (b"/abs/./x/..", Some(b"/abs")),
            (b"/../abs", Some(b"/abs")),
            (b"/", Some(b"/")),
            (b"//", Some(b"/")),
            (b"/.", Some(b"/")),
            (b"", None),
            (b".", None),
            (b"./", None),
            (b"a/..", None),
            (b"..", None),
            (b"../a", None),
            (b"a/../../b", None),
        ] {
            let mut out = Vec::new();
            let ok = normalize_path(path, &mut out);
            assert_eq!(ok.then_some(&out[..]), normalized, "{}", quote_record(path));
        }
    }

    #[test]
    fn recognizes_a_submodule_refusal() {
        assert!(is_submodule_refusal(
            "fatal: Pathspec './sub/f' is in submodule 'sub'\n"
        ));
        assert!(is_submodule_refusal(
            "warning: x\nfatal: Pathspec 'a' is in submodule 'b'"
        ));
        // a path holding a newline splits the message across lines
        assert!(is_submodule_refusal(
            "fatal: Pathspec './sub/a\nb' is in submodule 'sub'\n"
        ));
        assert!(!is_submodule_refusal("fatal: '../x' is outside repository"));
        // the infix alone isn't the refusal
        assert!(!is_submodule_refusal(
            "fatal: '../x' is in submodule 'sub'\n"
        ));
    }

    /// An inherited pathspec mode would make git refuse every `./` path
    /// (`pathspec magic not supported`); the runner scrubs them.
    #[test]
    fn pathspec_modes_in_the_env_are_scrubbed() {
        for var in [
            "GIT_LITERAL_PATHSPECS",
            "GIT_GLOB_PATHSPECS",
            "GIT_NOGLOB_PATHSPECS",
            "GIT_ICASE_PATHSPECS",
        ] {
            let mut f = Fixture::new();
            f.write(".gitignore", "*.tmp\n");
            f.env.push((var.into(), "1".into()));
            assert_eq!(
                names(&f.check(&[b"a.tmp", b"b"]).unwrap()),
                [&b"a.tmp"[..]],
                "{var}"
            );
        }
    }
}
