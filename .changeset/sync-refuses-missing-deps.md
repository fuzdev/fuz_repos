---
'@fuzdev/fuz_repos': minor
---

**breaking** fix: `gitops_sync` refuses, before any network, an npm repo with no `node_modules` or with no `node_modules/$app/tsconfig.json` its tsconfig extends, rather than warning and caching a library analysis that reads external types as `any`

- gro can cache the analysis at `.gro/library.json` keyed on the repo's commit, so the degraded library could outlive `npm install` and `gro sync` until the next commit; each refusal line names the repo, what it lacks, and the fix (`npm install`, `gro sync`, or both, in that repo)
- `--check` reports it and exits non-zero; `--allow_dirty` doesn't reach it
- a `.gro/library.json` already cached without the dependencies stays at its commit — delete it to re-analyze
