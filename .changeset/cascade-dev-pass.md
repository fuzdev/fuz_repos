---
'@fuzdev/fuz_repos': minor
---

fix: the publish cascade no longer fails after every publish when a dependency is both a peer and a dev dependency (the dev pass skips the entry the peer rewrite moved), and a failed rewrite of a dependent's `package.json` is reported as that dependent's, with the new failure code `dependency_update`; the plan's diffs show each range as it will be written

break: remove `update_all_repos` and `find_updates_needed` (`dependency_updater.ts`); `VersionStrategy` moves to `version_utils.ts`; the plan's `verbose_data.propagation_chains` is `propagations` (`VerbosePropagation`, its `chain` now `dependents`)
