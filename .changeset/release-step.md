---
'@fuzdev/fuz_repos': minor
---

feat: `gro gitops_release` steps a multi-repo release from observed state — it fetches the repos, asks the registry which current versions are out, rewrites the ranges of released dependencies' dependents (with their auto-changesets, under `--wetrun`), and names the wave to publish; publishing is yours, `gro publish` in each named repo inside one 2FA window, and `--wait` waits out the registry before a step. A cascade stopped partway or published by hand is picked up the same way. A repo that isn't ready is held, and with it what depends on it, since its checkout may hide a changeset

feat: the plan groups the packages that publish into `waves` (a wave's packages don't depend on each other), resolves the cascade in one pass in dependency order, and, given registry observations, reports `awaiting_registry` and `never_published`; `gitops_analyze` shows dependency `levels`

fix: a range moves only forward (a range staged ahead of its dependency is left alone), and whether a move is breaking is measured from the range's base version, so a range lagging a dependency's last release takes the bump it skipped

break: remove `gro gitops_publish` and the executor behind it (`multi_repo_publisher.ts`, `publish_gate.ts`, `publish_steps.ts`, `publishing_event.ts`, `publishing_event_handler.ts`, `preflight_checks.ts`), with `--emit_json`, `--preview`, `--deploy`, and the `PreflightOperations`, `BuildOperations`, and `ProcessOperations` groups, `GitopsOperations`, `default_gitops_operations`, and `GitOperations.current_commit_hash`; consumers re-export `gitops_release.task.ts` in place of `gitops_publish.task.ts`

break: the plan's `publishing_order` is `waves` (publishing packages only), `DependencyUpdate` gains `breaking`, `verbose_data` drops its iterations, and `GITOPS_MAX_ITERATIONS_DEFAULT` is gone; `validate_dependency_graph`'s `publishing_order` is `order` beside `levels`, and `analyze_repos` returns `levels`; `gitops_plan --format json` and `gitops_analyze --format json` follow

break: `NpmOperations` is `view_version` (`RegistryVersion`) and `wait_for_package`, without `check_auth` and `check_registry`; `update_package_json` takes the plan's `DependencyUpdate`s and a `changeset` flag in place of a version map and `published_versions`, and `create_dependency_updates` is `to_dependency_version_changes`; `check_publish_readiness`, `format_readiness_ahead`, and `gate_publish_readiness` give way to `check_release_readiness`
