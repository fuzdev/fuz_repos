# Troubleshooting

Common errors, solutions, and debugging tips for fuz_repos.

## Table of Contents

- [Common Errors](#common-errors)
- [Unexpected Behavior](#unexpected-behavior)
- [Debugging Tips](#debugging-tips)

## Common Errors

### "the `repos` binary was not found on PATH" or "prints status format …"

Every task reads repo state from `repos status --json`, and the `repos` binary
isn't in the npm package. Install it from a checkout of this repo at the
version of `@fuzdev/fuz_repos` you use — its format version must match the
package's:

```bash
cargo install --path crates/fuz_repos --locked
```

### "the gitops config lists `…`, which the registry (repos.toml) doesn't name"

The config lists `repos.toml` keys, not URLs, dir names, or paths; the message
suggests the keys it resembles.

### "a configured repo can't be loaded" or "configured repos can't be loaded"

Each problem names a key in `gitops.config.ts`:

- **the dir of another entry, not a registry key** — list the key it names
- **a third-party reference** — the config lists owned repos only
- **missing** — `repos sync <key>` clones it
- **isn't a git repo** or **probing failed** — `repos status <key>` shows what
  it found
- **private, and a public package** — `gitops_sync` writes each repo's
  metadata into the host's public `repos.json`, so a public host can't list
  repos the registry declares private

When no `repos.toml` is found walking up from the cwd, pass
`--registry <path>`.

### "held rewrite of …'s ranges" or "held publish of …"

`gro gitops_release` fetches every npm repo in the config and holds a rewrite
or a publish in one that isn't ready, carrying on with the others. It moves no
repo to get there; each line names what's wrong and the fix:

- **…'s repo isn't ready, so whether it has more to publish can't be read** —
  a dependency's repo is held (its own lines say why), and it may hide a
  changeset, so this dependent waits with it: fix that repo and step again

- **on `feature`, not `main`** (or **detached at …**) — the primary checkout
  isn't on the branch the registry entry follows: switch back once the work
  there is committed or stashed
- **uncommitted changes (… staged, … unstaged, … untracked, … conflicted)** —
  commit, stash, or discard them; untracked files count. After a failed
  `gro publish`, see [Uncommitted changes after a failed `changeset publish`](#uncommitted-changes-after-a-failed-changeset-publish)
  before committing
- **a rebase is in progress** (or merge, cherry-pick, …) — finish or abort it
- **`main` is N commits behind origin** — `repos sync <key>` fast-forwards it
- **`main` has diverged from origin** — `repos sync <key>`, or `repos push`
  from its checkout, rebases it onto origin and pushes it when its commits
  replay cleanly (no conflict, none of them on another remote branch, no
  merge or tag among them, a clean checkout); otherwise rebase or merge by
  hand, then push
- **`main` tracks no upstream on origin**, **tracks an upstream gone from
  origin**, or **isn't compared with origin** — set or repoint its upstream;
  `repos status <key>` says what it found
- **fetching origin failed (…)** — fix the remote (network, auth, a gone ref)
  and rerun; `repos status --fetch <key>` retries the fetch
- **another live Claude Code session works in its checkout (pid …)** — the
  step commits there, so wait for that session to finish
- **busy detection is unavailable (…)** — a session file couldn't be read or
  vouched for, so no checkout can be ruled out, and every repo is held;
  `repos status` says why
- **origin isn't the registry's repo**, or another `needs_human` reason —
  `repos status <key>` names the fix

A branch ahead of origin isn't held (see
[Readiness](publishing.md#readiness)). The diagnostics (`gitops_plan`,
`gitops_analyze`, `gitops_validate`) print the same problems as warnings, from
local refs, before you step.

### "not generating the site data: … on its registry branch, clean, and idle"

`gro gitops_sync` writes the dashboard's `repos.json` from each repo's working
tree beside origin's CI, so it refuses a repo that would show something else:
off the branch its registry entry follows, dirty (untracked files count), or
mid-operation — each line names the repo, what's wrong, and the fix, as the
release step's holds above do. It refuses before any fetch and changes nothing.
Move the repo back, or pass `--allow_dirty` to generate from the repos as they
sit, with each problem logged as a warning. `gro gitops_sync --check` prints
the same report from local refs, without a token, and exits non-zero when a
run would refuse.

It only warns on a branch behind or ahead of origin (the modules are the
local tree's, the CI origin's tip — `repos sync` lines them up) and on a failed
fetch (the last fetch's view stands).

### "not generating the site data: … dependencies installed"

`gro gitops_sync` also refuses, before any fetch, an npm repo with no
`node_modules`, or with no `node_modules/$app/tsconfig.json` when its tsconfig
extends `$app/tsconfig`: the library analysis would read the repo's external
types as `any`, and gro can cache the analysis at `.gro/library.json` keyed on
the repo's commit, so that degraded library can stay until the next commit.
Each line names the repo, what it lacks, and the fix — `npm install`,
`gro sync` (which runs `svelte-kit sync`), or both, in that repo; `gitops_sync`
installs nothing, and `--allow_dirty` doesn't reach this refusal.
`gro gitops_sync --check` reports it too.

The other tasks (`gitops_analyze`, `gitops_plan`, `gitops_release`,
`gitops_validate`) load each repo from its `package.json` alone — no module
analysis and no `.gro/library.json` — so loading needs no installed
dependencies (the `gro publish` you run in each repo does). A `.gro/library.json` cached by an analysis without the
dependencies (another `library_load_from_repo` caller, or an older
fuz_repos) stays at its commit: if the dashboard shows `any` for a repo whose
dependencies are installed, delete it and run `gro gitops_sync` again.

### "couldn't read the registry, so nothing was changed"

The step asks npm (`npm view <pkg>@<version>`) whether each publishable
package's current version is out, and stops before writing anything when npm
can't answer for one — offline, an auth or registry error, npm missing — so an
outage never reads as unpublished. Each line names the package and npm's
error. npm's own config (`.npmrc`, `npm_config_registry`) picks the registry.

### "Awaiting the registry"

A package the registry knows whose current version it doesn't show, with no
changesets left: either `gro publish` put it out moments ago and it's still
propagating (npm's CDN can take minutes), or the publish never finished. The
step holds its dependents — their ranges and publishes — until it shows.
Rerun later, or pass `--wait` to poll for it (`--max_wait`, in ms, 10 minutes
by default).

If it never shows, the version wasn't published: `gro publish` bumped it but
failed before or during `changeset publish`. Check that repo's `git status`
(see [below](#uncommitted-changes-after-a-failed-changeset-publish)) and run
`gro publish` there again.

### "never published, with nothing to publish"

The registry has never seen the package, it has no changesets, and no
configured package depends on it for prod or peer — an app or site that never
publishes, most likely. It's an update-only leaf, like a private package: its
own ranges move without an auto-bump, no range moves for it, and it doesn't
hold the release. Mark it `"private": true` if it never will publish; add a
changeset to publish it for the first time.

A package the registry has never seen that something depends on for prod or
peer is listed as awaiting the registry instead: npm answers a first publish
with E404 until it propagates, so step again in a few minutes or pass
`--wait`. If it never shows, it was never published — publish it, or drop
the dependency on it.

### "the plan has errors, so nothing was changed"

The plan couldn't be fully computed — a production dependency cycle, a
changeset that couldn't be read or predicted — so the step writes nothing.
Each error is listed; fix them and step again.

### "… rewrite(s) failed, the rest were committed"

A dependent's `package.json` rewrite failed (each line names it); the others
committed, and the failed one isn't named to publish. It may hold a written
`package.json` and a staged changeset — check its `git status` and commit or
restore them, then step again: the step reads the state afresh and redoes any
rewrite still due.

A republishing dependent whose `package.json` already names the new version
fails here too: it changed after the step read it, and skipping its rewrite
would drop its auto-changeset.

### "npm authentication failed" or `E401`/`ENEEDAUTH`/`EOTP` from `gro publish`

Log in to npm, and have the one-time password ready: npm asks for it per
publish unless its 2FA window is still open, which is why a wave is best
published in one go.

```bash
npm login
npm whoami  # verify login
```

### A release commit and tag left local (the push was rejected)

`gro publish` doesn't check its own `git push`. If origin moved after it
pulled, git rejects the push, but `gro publish` still succeeds: the version is
on npm. Git's rejection in the output is the only sign. The release commit and
its `vX.Y.Z` tag stay local, on a branch now diverged from origin, and the
next step holds the repo. Merge origin's branch in (a rebase would leave the
tag on a commit the branch no longer holds — which is why `repos sync` and
`repos push` leave a diverged branch with a tag on its local commits to a
person), push the branch with `repos push`, and push the tag by hand, since
`repos` never pushes tags.

### Uncommitted changes after a failed `changeset publish`

A `gro publish` that fails partway through `changeset version` or `changeset
publish` can leave the tree dirty with the consumed changesets deleted. gro's
own advice there is `git reset --hard`: committing would drop the changesets,
so the retry would have nothing to publish. The step reports the dirt without
knowing which case it is — check `git status` before choosing.

### "Production dependency cycle: a → b"

Production/peer circular dependencies are plan errors that block publishing.
You must:

1. Identify the cycle in `gro gitops_analyze` output
2. Move one dependency to devDependencies
3. Or restructure to remove the cycle

Note: Dev dependency cycles are normal and allowed, reported as info.

## Unexpected Behavior

### "Auto-changeset generated when I didn't expect it"

This happens when:

- A dependency was released with a new version
- Your package names that dependency in dependencies or peerDependencies, in
  a range whose base version is older

This is correct behavior - packages must republish when their dependencies
change. A range that lagged behind before the release counts too: the step
rewrites it, and its move is measured from the range's base (see
[Dependency Update Behavior](publishing.md#dependency-update-behavior)).

### "analyze/plan show stale data or the wrong branch"

The diagnostics (`gitops_analyze`, `gitops_plan`, `gitops_validate`) read each
repo's working tree **as-is** — whatever branch is checked out, including
uncommitted changes. They move no ref: no branch switch, no pull. Each prints
a "not at rest" block naming the repos off their registry branch, dirty,
mid-operation, or out of sync with origin as of the last fetch. To run against
each repo's registry branch with the latest changes:

```bash
repos sync       # fetch, fast-forward what's behind, push what's ahead
gro gitops_plan  # then read the repos at rest
```

`repos sync` never switches a branch or touches uncommitted work: a repo off
its branch or dirty stays as it is until you move it.

### "Package not publishing even though I have a changeset"

When the repo has changeset files but none yields a bump for its package, the
plan takes no bump from those files (it publishes only if a dependency update
gives it an auto-changeset) and warns, naming the repo and why — none of the
files parses, or none that parses names the package. Check:

1. Changeset file is in `.changeset/` directory
2. Changeset file is not `README.md`
3. Changeset references the correct package name
4. Changeset has valid frontmatter format

### "How does picking up a release work?"

Each step derives the release from what it observes — changesets, each
`package.json`, and what the registry shows — so there's nothing to resume
and no state to go stale:

1. `gro publish` consumes a package's changesets and puts its new version out
2. The next step sees that version on the registry, so the package is
   released: it rewrites the dependents still trailing it (with their
   auto-changesets) and names the next wave
3. A step that ran early, a release made by hand, or a wave whose step never
   ran all come out the same: the dependents' ranges still trail the released
   version, so the step rewrites them
4. A failed `gro publish` leaves its changesets (or a dirty tree, above); fix
   it and publish that package again

## Debugging Tips

### View detailed dependency graph

```bash
gro gitops_analyze --format markdown --outfile deps.md
```

### Preview a step

```bash
gro gitops_release  # the rewrites it would commit and the wave it would name; writes nothing
```

### Extra lines before the JSON on stdout

Gro prints `[<task>] invoking <task>` and `[<task>] → <task> …` before running
a task, out of the task's reach, so they lead stdout even under `--format
json`. Everything after is the document (the log goes to stderr). Write the
report with `--outfile`, or skip the two lines (`tail -n +3` at the default
log level). If `.svelte-kit` or SvelteKit's generated
`node_modules/$app/tsconfig.json` is missing, gro runs `svelte-kit sync`
first, and its output can land there too.

### Check what changed since last publish

```bash
# In each repo
git log --oneline
ls .changeset/
```
