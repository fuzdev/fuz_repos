---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: `repos` refuses a discovered root whose own `.git` is a symlink (`root_git_symlink`, exit 2) — a symlinked `.git` further up, like a dotfiles repo's at `$HOME`, is passed over, unless it's the nearest `.git` above the root and a `repos.toml` above that repo links the registry, which is refused too (a registry not linked above that repo, in a subdirectory of it, still runs, and a sync there clones into the checkout) — and discovery's git calls stop below a symlinked `.git` past one git can't use; the error documents carry the new kind (breaking: the `--json` formats are `repos status` 21, `repos sync` 15, and `repos push` 13 — reinstall the `repos` binary with `cargo install --path crates/fuz_repos --locked`)
