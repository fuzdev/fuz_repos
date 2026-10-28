---
'@fuzdev/fuz_repos': minor
---

feat: a dependent keeps one auto-changeset, `.changeset/dependency-updates.md`, each rewrite of its ranges merging into it, and each rewrite's commit names the versions it moved to (`update dependencies: <name> <version>`)

break: `create_changeset_for_dependency_updates` is renamed `write_dependency_updates_changeset`
