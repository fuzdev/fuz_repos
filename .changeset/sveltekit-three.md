---
'@fuzdev/fuz_repos': minor
---

**breaking** feat: support SvelteKit 3 (`@sveltejs/kit` peer `^3`, `@fuzdev/gro` peer `>=0.214.0`, the first Gro that supports SvelteKit 3)

- `gitops_sync` warns on an npm repo whose `tsconfig.json` extends `$app/tsconfig` but lacks SvelteKit's generated `node_modules/$app/tsconfig.json` (was `.svelte-kit/tsconfig.json`), and reports only the missing `node_modules` when that's absent
