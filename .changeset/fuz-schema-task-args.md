---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: the `gitops_*` tasks' `Args` are `@fuzdev/fuz_schema` schemas instead of zod, for Gro `0.217.0`, which parses task args with them (`@fuzdev/gro` peer `>=0.217.0`, `@fuzdev/fuz_util` peer `>=0.73.0`, and a new `@fuzdev/fuz_schema` peer `^0.2.0`)

- install `@fuzdev/fuz_schema` `^0.2.0` beside Gro `>=0.217.0` and fuz_util `>=0.73.0`
- code that parses an exported `Args` itself, such as `Args.parse(value)` on `gitops_publish`'s, calls `s.parse_or_throw(Args, value)` with `* as s` from `@fuzdev/fuz_schema/schema.ts`; the `Args` types are unchanged
- `--help` quotes an enum arg's values as JSON, so `"stdout" | "json" | "markdown"` where it printed `'stdout' | 'json' | 'markdown'`, and an args validation error is fuz_schema's `format_issue` text, like `concurrency: expected >= 1, received number`
- zod stays a peer, for the schemas of `repos` output, the GitHub data, the config, and the publishing events
