---
'@fuzdev/fuz_repos': minor
---

feat: require fuz_css 0.65 (breaking: the `@fuzdev/fuz_css` peer is `>=0.65.0`, was `>=0.62.0`) and fuz_ui 0.210.0

- `ModulesDetail` colors its file-type links and declaration kinds from fuz_css's renamed `--palette_X_50` variables (was `--color_X_50`), which an older fuz_css doesn't define
