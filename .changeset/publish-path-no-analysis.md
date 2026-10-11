---
'@fuzdev/fuz_repos': minor
---

**breaking** perf: `gitops_analyze`, `gitops_plan`, `gitops_publish`, and `gitops_validate` read each npm repo's `package.json` alone, without the svelte-docinfo module analysis they never read, so loading them is faster, needs no `node_modules`, and writes no `.gro/library.json` (a `--wetrun` still builds each repo); `gitops_sync` still analyzes, for the dashboard

- `local_repo_load` and `local_repos_load` take a required `modules: boolean` (`LocalRepoLoadOptions`): `true` runs gro's `library_load_from_repo`, `false` builds the `Library` from the `package.json` with no modules
- `GitopsSyncDeps.load_repos` receives `modules`
