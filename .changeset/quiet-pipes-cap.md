---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: require gro 0.230, delete `spawn_capture` for `SpawnProgram.out` with `stdin: 'inherit'`; `gitops_run` caps each stream at 64 MiB, a command past it failing with an output limit error, and adds `truncated` to its results
