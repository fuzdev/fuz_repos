---
'@fuzdev/fuz_repos': minor
---

feat: `repos push` and `repos sync` hold a push that would send Git LFS pointers, since `repos` runs no hook and so no Git LFS upload; `repos push --lfs-uploaded` pushes it once `git lfs push origin <branch>` has uploaded them (breaking: the `repos status --json` format is 20 — reinstall the `repos` binary with `cargo install --path crates/fuz_repos --locked`)

- a branch's `held` verdict may be held by `lfs_objects` or `lfs_unscanned`; `ReposBranchHold` in `repos_status.ts` carries them
