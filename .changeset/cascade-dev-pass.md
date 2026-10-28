---
'@fuzdev/fuz_repos': minor
---

fix: a dependency that is both a peer and a dev dependency moves in both sections in one commit, each keeping its prefix, and the plan's diffs show each range as it will be written

break: remove `update_all_repos` and `find_updates_needed` (`dependency_updater.ts`); `VersionStrategy` moves to `version_utils.ts`; the plan's `verbose_data.propagation_chains` is `propagations` (`VerbosePropagation`, its `chain` now `dependents`)
