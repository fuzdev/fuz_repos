//! The fixture repo the read ops' tests run against.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::runner::{CallOptions, Git};

/// A repo at `<tmp>/repo` with a home at `<tmp>/home`, and the clean
/// environment its runners see: `PATH`, that `HOME`, and no system config.
pub struct Fixture {
    pub tmp: tempfile::TempDir,
    pub env: Vec<(OsString, OsString)>,
}

impl Fixture {
    pub fn new() -> Self {
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

    pub fn repo(&self) -> PathBuf {
        self.tmp.path().join("repo")
    }

    /// A fresh runner over the fixture's environment.
    pub fn runner(&self) -> Git {
        Git::with_clean_env(self.env.clone())
    }

    /// Runs a setup call in `dir` on a runner of its own.
    pub fn git_in(&self, dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> String {
        let opts = CallOptions {
            stdin,
            ..CallOptions::default()
        };
        self.runner().output_string(dir, args, opts).unwrap()
    }

    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.repo(), args, None)
    }

    /// Writes `contents` at `name` under the repo, creating its dirs.
    pub fn write(&self, name: impl AsRef<OsStr>, contents: &str) {
        let path = self.repo().join(name.as_ref());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// Makes an empty dir at `name` under the repo.
    pub fn mkdir(&self, name: impl AsRef<OsStr>) {
        std::fs::create_dir_all(self.repo().join(name.as_ref())).unwrap();
    }
}

/// Paths from raw names.
pub fn paths(names: &[&[u8]]) -> Vec<PathBuf> {
    names
        .iter()
        .map(|n| PathBuf::from(OsStr::from_bytes(n)))
        .collect()
}

/// The raw bytes of `paths`, for comparing where a trailing `/` matters:
/// `PathBuf`'s `==` drops it.
pub fn names(paths: &[PathBuf]) -> Vec<&[u8]> {
    paths.iter().map(|p| p.as_os_str().as_bytes()).collect()
}
