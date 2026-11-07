---
'@fuzdev/fuz_repos': patch
---

fix: a Rust-only repo takes its name and URL from the registry, not its root `Cargo.toml`, so a root crate named unlike the repo no longer breaks its CI and pull request fetches
