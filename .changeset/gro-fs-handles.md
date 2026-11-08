---
'@fuzdev/fuz_repos': minor
---

break: require `@fuzdev/gro` >=0.227.0: `local_repo_load` and `local_repos_load` take `fs_paths` with `modules: true`, `GitopsSyncDeps.load_token` is async, and `LocalRepoLoadOptions` is now a union rather than an interface, so a `boolean` variable for `modules` without `fs_paths`, or an `interface X extends` of it, no longer compiles

`gitops_sync` reads `SECRET_GITHUB_API_TOKEN` from `process.env`, the project's `.env`, then `../.env`
