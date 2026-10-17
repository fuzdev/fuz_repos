//! Git LFS pointers among the objects a push would send, read with git
//! alone.
//!
//! The tool never runs hooks (the `git` module says why), and pushes with
//! `git send-pack`, which runs no `pre-push` either, so Git LFS's upload of
//! the objects its pointers name never runs: a host that checks them
//! (GitHub's `GH008`) refuses the push, and one that doesn't takes refs
//! naming objects its LFS store lacks. So a branch whose push would add a
//! pointer is held (`BranchHold::LfsObjects`) until the user uploads them
//! (`git lfs push origin <branch>`) and says so (`repos push
//! --lfs-uploaded`).
//!
//! What's a pointer is read from the objects themselves, never from
//! `.gitattributes`, which is the repo's content and may be absent or say
//! otherwise: a blob under `POINTER_MAX_SIZE` bytes with a version line Git
//! LFS's parser accepts (`POINTER_VERSIONS`), then an `oid` and a `size`
//! line. Lines it doesn't need are passed over unchecked, so it holds every
//! pointer Git LFS writes and some it wouldn't read; it's stricter than Git
//! LFS only on forms no tool writes (whitespace around the blob, which Git
//! LFS trims, or an oid that isn't hex). Which objects:
//! those the branch's commit reaches past origin's remote-tracking refs, as git's
//! object walk reads them (`rev-list --objects <commit> --not
//! --remotes=origin`) — the walk a push's pack is built by, so what the push
//! would send. A pointer on the commits it stops at was accepted by origin
//! before; the walk excludes only the trees on that edge, so a blob only
//! another of origin's branches holds still counts, and holds the push.

use std::path::Path;

use crate::git::{CallOptions, Git, GitError};

/// The size Git LFS's scanner reads pointers under (its `blobSizeCutoff`):
/// a blob this size or larger is content, never a pointer.
const POINTER_MAX_SIZE: u64 = 1024;

/// The first line of a pointer, each spec URL Git LFS's parser accepts:
/// the current one, and the two it still reads from before its launch.
/// Any of them names an object the host's LFS store must hold.
const POINTER_VERSIONS: [&[u8]; 3] = [
    b"version https://git-lfs.github.com/spec/v1",
    b"version https://hawser.github.com/spec/v1",
    b"version http://git-media.io/v/2",
];

/// The most small blobs a scan reads: their contents come back in one
/// call's output, under the runner's cap. A range with more is held unread
/// (`LfsScan::TooLarge`).
const MAX_SCANNED_BLOBS: usize = 50_000;

/// What a branch's push would send holds of Git LFS pointers (`scan_lfs`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LfsScan {
    /// Not read: the branch is never pushed from here (a reference's, a
    /// pin's, an archived repo's, a symbolic ref, one level with or behind
    /// its upstream).
    #[default]
    Skipped,
    /// No pointer among the objects origin lacks.
    Clean,
    /// At least one pointer among them.
    Pointers,
    /// Too many objects to read, or a read that ran past the runner's
    /// timeout or output cap: whether a pointer is among them is unknown.
    TooLarge,
}

/// Reads the objects commit `oid` reaches past origin's remote-tracking
/// refs (the module doc says how exactly), for Git LFS pointers: the blobs under
/// `POINTER_MAX_SIZE` among them (`rev-list --objects`, filtered by type
/// and size), then their contents (`cat-file --batch`, the oids on its
/// stdin) — two calls, however many objects. A partial clone's missing
/// objects are skipped (`--missing=allow-promisor`): its promisor remote,
/// origin, sent them, so it holds them. Nothing is fetched, and no filter
/// driver runs on what's read.
///
/// # Errors
///
/// When git can't run or fails; a call that times out or overflows the
/// runner's output cap reads `TooLarge`, as a range over
/// `MAX_SCANNED_BLOBS` does.
pub fn scan_lfs(
    git: &Git,
    dir: &Path,
    oid: &str,
    opts: CallOptions<'_>,
) -> Result<LfsScan, GitError> {
    scan_lfs_bounded(git, dir, oid, opts, MAX_SCANNED_BLOBS)
}

/// `scan_lfs`, reading at most `max` small blobs.
fn scan_lfs_bounded(
    git: &Git,
    dir: &Path,
    oid: &str,
    opts: CallOptions<'_>,
    max: usize,
) -> Result<LfsScan, GitError> {
    let filter = format!("--filter=blob:limit={POINTER_MAX_SIZE}");
    let listed = match git.output_string(
        dir,
        &[
            "rev-list",
            "--objects",
            "--missing=allow-promisor",
            "--filter=object:type=blob",
            &filter,
            oid,
            "--not",
            "--remotes=origin",
        ],
        opts,
    ) {
        Ok(listed) => listed,
        Err(e) => return too_large(e),
    };
    let blobs = small_blobs(&listed);
    if blobs.is_empty() {
        return Ok(LfsScan::Clean);
    }
    if blobs.len() > max {
        return Ok(LfsScan::TooLarge);
    }
    let mut input = blobs.join("\n");
    input.push('\n');
    let out = match git.output(
        dir,
        &["cat-file", "--batch", "--buffer"],
        CallOptions {
            stdin: Some(input.as_bytes()),
            ..opts
        },
    ) {
        Ok(out) => out,
        Err(e) => return too_large(e),
    };
    match has_pointer(&out) {
        Some(true) => Ok(LfsScan::Pointers),
        Some(false) => Ok(LfsScan::Clean),
        None => Err(GitError::Failed {
            args: "cat-file --batch --buffer".into(),
            code: None,
            stderr: "unexpected output".into(),
        }),
    }
}

/// A read that ran too long or too large is `TooLarge`; any other failure
/// stays one.
fn too_large(e: GitError) -> Result<LfsScan, GitError> {
    match e {
        GitError::Timeout { .. } | GitError::OutputTooLarge { .. } => Ok(LfsScan::TooLarge),
        e => Err(e),
    }
}

/// The blobs `rev-list --objects` listed: each line naming one with its
/// path (`<oid> <path>`), where a commit's line is its oid alone.
fn small_blobs(listed: &str) -> Vec<&str> {
    listed
        .lines()
        .filter_map(|l| l.split_once(' ').map(|(oid, _)| oid))
        .collect()
}

/// Whether `cat-file --batch`'s output holds a blob that reads as a
/// pointer: each object is `<oid> <type> <size>\n`, its contents, and a
/// newline; one it can't find is `<oid> missing\n`, skipped. `None` when
/// the output isn't that.
fn has_pointer(mut out: &[u8]) -> Option<bool> {
    let mut found = false;
    while !out.is_empty() {
        let end = out.iter().position(|&b| b == b'\n')?;
        let header = std::str::from_utf8(&out[..end]).ok()?;
        out = &out[end + 1..];
        let mut fields = header.split(' ');
        let (_oid, kind) = (fields.next()?, fields.next()?);
        if kind == "missing" {
            continue;
        }
        let size: usize = fields.next()?.parse().ok()?;
        let contents = out.get(..size)?;
        if out.get(size) != Some(&b'\n') {
            return None;
        }
        out = &out[size + 1..];
        found |= kind == "blob" && is_pointer(contents);
    }
    Some(found)
}

/// Whether a blob's contents read as a Git LFS pointer: under
/// `POINTER_MAX_SIZE` bytes, a first non-blank line that's one of `POINTER_VERSIONS`,
/// and among the `key value` lines after it an `oid <algo>:<hex>` and a
/// `size <digits>` — the keys Git LFS's parser requires, so a document that
/// only opens with a version line is content. Lines end in `\n` or `\r\n`
/// and blank ones are skipped, as Git LFS's line scanner reads them, so a
/// pointer with CRLF endings or a leading blank line still counts. Other
/// lines (an extension's `ext-…`) are passed over, not checked.
fn is_pointer(contents: &[u8]) -> bool {
    if contents.len() as u64 >= POINTER_MAX_SIZE {
        return false;
    }
    let Ok(text) = std::str::from_utf8(contents) else {
        return false;
    };
    let mut lines = text.lines().filter(|l| !l.is_empty());
    if !lines
        .next()
        .is_some_and(|first| POINTER_VERSIONS.contains(&first.as_bytes()))
    {
        return false;
    }
    let (mut oid, mut size) = (false, false);
    for (key, value) in lines.filter_map(|l| l.split_once(' ')) {
        match key {
            "oid" => {
                oid |= value.split_once(':').is_some_and(|(algo, hex)| {
                    !algo.is_empty()
                        && !hex.is_empty()
                        && hex.bytes().all(|b| b.is_ascii_hexdigit())
                });
            }
            "size" => size |= !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()),
            _ => {}
        }
    }
    oid && size
}

#[cfg(test)]
mod tests {
    use super::*;

    const POINTER: &[u8] = b"version https://git-lfs.github.com/spec/v1\n\
        oid sha256:fdee63c4a4dc23076dda04b32eb8505bcd41fb791e574a264026c43e700bf923\n\
        size 308880\n";

    fn batch(objects: &[(&str, &str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (oid, kind, contents) in objects {
            out.extend(format!("{oid} {kind} {}\n", contents.len()).bytes());
            out.extend_from_slice(contents);
            out.push(b'\n');
        }
        out
    }

    #[test]
    fn a_pointer_is_a_small_blob_with_a_spec_version_an_oid_and_a_size() {
        assert!(is_pointer(POINTER));
        assert!(is_pointer(
            b"version https://hawser.github.com/spec/v1\noid sha256:00\nsize 1\n"
        ));
        assert!(is_pointer(
            b"version http://git-media.io/v/2\noid sha256:ab\nsize 0\n"
        ));
        // an extension's line, sorted before the oid
        assert!(is_pointer(
            b"version https://git-lfs.github.com/spec/v1\n\
              ext-0-foo sha256:0123\n\
              oid sha256:4d7a\n\
              size 12345\n"
        ));
        assert!(!is_pointer(b"hello\n"));
        // leading whitespace: Git LFS trims it, but no tool writes one
        assert!(!is_pointer(
            b" version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"
        ));
        // a document that only opens as one
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\n\nWhat a pointer file is.\n"
        ));
        assert!(!is_pointer(b"version https://git-lfs.github.com/spec/v1\n"));
        // each key required, and well-formed
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\nsize 1\n"
        ));
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:00\n"
        ));
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:zz\nsize 1\n"
        ));
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid 00\nsize 1\n"
        ));
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1kb\n"
        ));
        assert!(!is_pointer(
            b"version https://git-lfs.github.com/spec/v1x\noid sha256:00\nsize 1\n"
        ));
        // CRLF endings, and blank lines before or among the keys
        assert!(is_pointer(
            b"version https://git-lfs.github.com/spec/v1\r\noid sha256:00\r\nsize 1\r\n"
        ));
        assert!(is_pointer(
            b"\nversion https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n"
        ));
        assert!(is_pointer(
            b"\r\n\r\nversion https://git-lfs.github.com/spec/v1\r\n\r\noid sha256:00\r\nsize 1"
        ));
        // at the cut, content
        let mut big = POINTER.to_vec();
        big.resize(1024, b'x');
        assert!(!is_pointer(&big));
        big.truncate(1023);
        assert!(is_pointer(&big));
    }

    #[test]
    fn reads_the_batch_output() {
        assert_eq!(has_pointer(b""), Some(false));
        let out = batch(&[("a", "blob", b"plain\n"), ("b", "blob", POINTER)]);
        assert_eq!(has_pointer(&out), Some(true));
        let out = batch(&[("a", "blob", b"plain\n"), ("c", "commit", POINTER)]);
        assert_eq!(has_pointer(&out), Some(false));
        // contents holding newlines and what reads as a header
        let out = batch(&[("a", "blob", b"x\nb blob 3\n"), ("b", "blob", b"\n\n")]);
        assert_eq!(has_pointer(&out), Some(false));
        let mut out = b"d missing\n".to_vec();
        out.extend(batch(&[("b", "blob", POINTER)]));
        assert_eq!(has_pointer(&out), Some(true));
        // truncated, or a size that isn't one
        assert_eq!(has_pointer(b"a blob 5\nab"), None);
        assert_eq!(has_pointer(b"a blob x\n"), None);
        assert_eq!(has_pointer(b"a blob 2\nabc"), None);
    }

    /// A repo in a tempdir, git's environment cleared but for an identity.
    struct Repo {
        _tmp: tempfile::TempDir,
        dir: std::path::PathBuf,
        env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    }

    impl Repo {
        fn new() -> Self {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().to_owned();
            let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = vec![
                ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
                ("GIT_AUTHOR_NAME".into(), "a".into()),
                ("GIT_AUTHOR_EMAIL".into(), "a@example.com".into()),
                ("GIT_COMMITTER_NAME".into(), "a".into()),
                ("GIT_COMMITTER_EMAIL".into(), "a@example.com".into()),
            ];
            env.extend(std::env::var_os("PATH").map(|p| ("PATH".into(), p)));
            let repo = Self {
                _tmp: tmp,
                dir,
                env,
            };
            repo.git(&["init", "-q", "-b", "main"]);
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = std::process::Command::new("git")
                .env_clear()
                .envs(self.env.iter().map(|(k, v)| (k, v)))
                .current_dir(&self.dir)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        }

        /// Commits `files` (path, contents); returns the commit.
        fn commit(&self, files: &[(&str, &[u8])]) -> String {
            for (path, contents) in files {
                std::fs::write(self.dir.join(path), contents).unwrap();
            }
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", "c"]);
            self.git(&["rev-parse", "HEAD"])
        }

        fn scan(&self, oid: &str, max: usize) -> LfsScan {
            let git = Git::with_clean_env(self.env.clone());
            scan_lfs_bounded(&git, &self.dir, oid, CallOptions::default(), max).unwrap()
        }
    }

    /// The bound counts the small blobs read, not the large or the commits,
    /// and a range past it is held unread, pointer or not.
    #[test]
    fn a_range_past_the_bound_is_unscanned() {
        let repo = Repo::new();
        let big = vec![b'x'; 2048];
        let plain = repo.commit(&[("a", b"a\n"), ("b", b"b\n"), ("big", &big)]);
        assert_eq!(repo.scan(&plain, 2), LfsScan::Clean);
        assert_eq!(repo.scan(&plain, 1), LfsScan::TooLarge);
        let pointer = repo.commit(&[("p", POINTER)]);
        assert_eq!(repo.scan(&pointer, 3), LfsScan::Pointers);
        assert_eq!(repo.scan(&pointer, 2), LfsScan::TooLarge);
        // nothing small at all: nothing to read
        let empty = Repo::new();
        let only_big = empty.commit(&[("big", &big)]);
        assert_eq!(empty.scan(&only_big, 0), LfsScan::Clean);
    }

    #[test]
    fn lists_the_blobs_alone() {
        let listed = "c1\nb1 a/b.uasset\nc2\nb2 with space.txt\n";
        assert_eq!(small_blobs(listed), ["b1", "b2"]);
    }
}
