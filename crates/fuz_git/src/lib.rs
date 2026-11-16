//! `fuz_git` — the hardened git runner shared across the ecosystem.
//!
//! `Git` runs git with a trust boundary the user's own git config sets
//! (hooks, fsmonitor, maintenance, and alternate-refs commands off; no
//! optional locks; no lazy fetch), a per-call timeout, and capped output;
//! the runner's module docs state it in full. `url` parses, redacts, and
//! escapes remote URLs, so no credential reaches an error or a report.
//!
//! Synchronous, with no async runtime: a caller on a runtime wraps calls in
//! `spawn_blocking`.
//!
//! Unix-only: it takes git's paths as raw bytes, as git does.

#![warn(missing_docs)]

mod runner;
pub mod url;

pub use runner::{
    CallOptions, Git, GitError, GitOutput, GitVersion, MIN_GIT_VERSION, NetworkOptions,
    VersionError,
};
