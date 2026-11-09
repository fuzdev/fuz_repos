---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: move git, npm, repos, and shell spawning onto gro's spawn host module: `git_add` and `git_commit` take a `git` `SpawnProgram` first and a `cwd` handle, `check_package_available` and `wait_for_package` require their deps, `default_npm_registry_deps` is gone in favor of `create_npm_operations`, and `spawn_capture` is added
