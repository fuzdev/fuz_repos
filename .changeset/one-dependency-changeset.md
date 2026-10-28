---
'@fuzdev/fuz_repos': minor
---

feat: the publish cascade keeps one auto-changeset per dependent, `.changeset/dependency-updates.md`, merging each dependency that publishes into it, and each rewrite's commit names the versions it moved to (`update dependencies: <name> <version>`)

break: `create_changeset_for_dependency_updates` is renamed `write_dependency_updates_changeset`
