---
'@fuzdev/fuz_repos': minor
---

**breaking** chore: support fuz_util `0.74.0`, whose `PackageJson` is a `@fuzdev/fuz_schema` schema, and Gro `0.218.0` (`@fuzdev/fuz_util` peer `>=0.74.0`, `@fuzdev/gro` peer `>=0.218.0`, `@fuzdev/fuz_schema` peer `^0.2.2`)

- install fuz_util `>=0.74.0` with Gro `>=0.218.0` and `@fuzdev/fuz_schema` `^0.2.2`; Gro 0.217 doesn't start with fuz_util 0.74
- the `gitops_*` tasks that read a `package.json` without module analysis (`gitops_analyze`, `gitops_plan`, `gitops_publish`, `gitops_validate`) validate it with fuz_schema, so a malformed manifest fails with `format_issue` text like `dependencies.x: expected string, received number` instead of Zod's
- `LocalRepo.package_json` and `RepoJson.package_json` narrow the record form of `exports` from `Record<string, unknown>` to fuz_util's `Record<string, ExportValue>`
- with fuz_util 0.74, `gitops_sync`'s GitHub fetch cache under `.gro/build/fetch/` survives a reload on any Zod version, where fuz_util 0.73 under Zod 4.4.3 and later refused any cache holding a request without params and the whole file was deleted
- the `zod` peer stays, for the schemas of `repos` output, the GitHub data, the config, and the publishing events
