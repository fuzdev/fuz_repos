---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: every schema is a `@fuzdev/fuz_schema` schema, and `zod` is no longer a peer (`@fuzdev/fuz_schema` peer `^0.4.0`)

- `repos_status.ts`, `github.ts`, `gitops_config.ts`, and `publishing_event.ts` export fuz_schema schemas instead of zod; their inferred types are unchanged
- code that parses one itself, such as `ReposStatusReport.parse(value)`, calls `s.parse_or_throw(ReposStatusReport, value)` or `s.parse(ReposStatusReport, value)` with `* as s` from `@fuzdev/fuz_schema/schema.ts`
- the same documents, GitHub responses, and configs are accepted and refused: the `repos status --json` mirror stays strict, and the GitHub objects still drop the fields they don't name
- a parse failure in `parse_repos_status_output`, `parse_gitops_config`, and the GitHub fetches is fuz_schema's `format_issue` text, like `entries.0.stashes: expected safe_integer, received number`, instead of zod's
