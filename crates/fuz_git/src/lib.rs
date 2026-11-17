//! `fuz_git` — the hardened git runner shared across the ecosystem.
//!
//! `Git` runs git with a trust boundary the user's own git config sets
//! (hooks, fsmonitor, maintenance, and alternate-refs commands off; no
//! optional locks; no lazy fetch), a per-call timeout, and capped output;
//! the runner's module docs state it in full. `url` parses, redacts, and
//! escapes remote URLs, so no credential reaches an error or a report.
//!
//! Read ops on the runner: `Git::ls_files` lists a working tree's files,
//! tracked and untracked but not ignored, apart from the nested repos and
//! gitlinks it doesn't descend into; `Git::ls_ignored` lists the untracked
//! paths git ignores, folding whole dirs, and `Git::check_ignore` says which
//! of a set of paths are ignored — together, git's ignore rule for a caller
//! walking a tree itself.
//!
//! Synchronous, with no async runtime: a caller on a runtime wraps calls in
//! `spawn_blocking`.
//!
//! Unix-only: it takes git's paths as raw bytes, as git does.

#![warn(missing_docs)]

mod check_ignore;
mod ls_files;
mod ls_ignored;
mod records;
mod runner;
#[cfg(test)]
mod test_fixture;
pub mod url;

pub use ls_files::ListedFiles;
pub use ls_ignored::IgnoredPaths;
pub use runner::{
    CallOptions, Git, GitError, GitOutput, GitVersion, MIN_GIT_VERSION, NetworkOptions,
    VersionError,
};
