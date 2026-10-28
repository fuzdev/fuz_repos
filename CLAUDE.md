# fuz_repos

> Multi-repo management - alternative to monorepo pattern

fuz_repos (`@fuzdev/fuz_repos`) loosely couples repos with cascade publishing
and cross-repo automation.

For coding conventions, see Skill(fuz-stack).

## Table of Contents

- [Scope and boundaries](#scope-and-boundaries)
- [Core functionality](#core-functionality)
- [Architecture](#architecture)
- [Patterns](#patterns)
- [Configuration](#configuration)
- [Main operations](#main-operations)
- [Data types](#data-types)
- [UI components](#ui-components)
- [Commands](#commands)
- [Dependencies](#dependencies)
- [General Patterns](#general-patterns)
- [Testability & Operations Pattern](#testability--operations-pattern)
- [Testing](#testing)
- [Generated Files & Caches](#generated-files--caches)
- [Additional Documentation](#additional-documentation)

The Rust `repos` tool's command reference is [docs/repos.md](docs/repos.md).

## Scope and boundaries

fuz_repos runs **deterministic, config-driven operations over a declared set
of repos — and is the gateway agents use for sensitive git operations.** Every
word is load-bearing:

- **deterministic** — no LLM in the loop. Same config plus same repo states
  produce the same plan. Everything here is reproducible and reviewable.
- **config-driven** — the repo set comes from a declared list (a `repos.toml`
  registry, and a project's `gitops.config.ts` naming a subset of its keys for
  the TS tasks), not from scanning a directory. Scanning only reports what the
  list misses.
- **operations** — it acts, or faithfully previews acting. Observation that
  never leads to an action belongs in whatever tool owns your policy checks.
- **the gateway** — agents push through the tool instead of raw git, so write
  policy lives in one place. Write authority is derived from the registry's
  owner accounts, never declared per repo.

The package is **fuz_repos**, with a `repos` binary. The `gitops_*` task names,
`Gitops*` identifiers and `gitops.config.ts` keep an older name: "GitOps" names
the inverse relationship (git as the desired state, infrastructure as the
target), where this tool treats the repos themselves as the target.

Publishing is the flagship vertical of the TS side, not the identity.

### Capability tiers

Multi-repo work doesn't carry uniform risk, so the tiers are keyed by what a
command may write, ordered by blast radius. A command maps onto every row it
writes: `repos sync` fetches, converges, and pushes; `repos push` fetches and
pushes, and converges the one branch it's asked to push when that branch
diverged.

| Writes | Tier | Commands |
| --- | --- | --- |
| nothing in git | **observe** | `repos status` (local refs), `repos status --brief`; `gitops_analyze`, `gitops_plan`, `gitops_validate`, `gitops_sync --check`, `gitops_run` with read-only commands |
| remote-tracking refs only, plus the objects, `FETCH_HEAD`, and shallow boundary a fetch writes | **observe** (refreshed) | `repos status --fetch`; the fetch that starts `repos sync`, `repos push`, and `gitops_release` (without `--wetrun`, all it writes), and `gitops_sync`'s fetch before it writes its host's site data |
| local branches, working trees, new clones, and the commit objects a rebase replays | **converge** | `repos sync` (fast-forwards, shallow moves, a diverged registry branch's local-only commits replayed onto its fetched upstream, clones of missing entries, references refreshed when named or under `--references`); `repos push` only rebases, and only the branch checked out at a target when it diverged and that checkout is clean; it never fast-forwards, moves, or clones |
| local commits: dependency-range rewrites and their auto-changesets | **rewrite** | `gitops_release --wetrun`, in ready repos only: one commit per dependent of `package.json` and its `.changeset/dependency-updates.md`, on the branch it's on |
| remote branches, under policy | **gateway** | `repos push`, and the push step of `repos sync` (a rebased branch's included, under either): fast-forwards only, under a lease, to the registry's SSH URL, owned entries only, no tags or force; a new remote branch is `repos push --new-branch`, the user's |
| releases: npm, git commits and tags, deploys | **publish** | `gro publish` and `gro deploy`, run by the user in the repos `gitops_release` names — the user's |

"Nothing in git" is exact for `repos status` and for the TS observe tasks:
they read each repo's files as they sit (`package.json`, changesets, workflow
files), without gro's module analysis, and write nothing in it; `--outfile`
writes where it's told. `gitops_sync` writes its own host's site data
(`repos.json`, `repos.ts`, in the routes dir or `--outdir`) and its GitHub
fetch cache under the host's `.gro/`; in the other repos it writes only the
library metadata cache of its module analysis (gro's
`library_load_from_repo`), at `.gro/library.json` inside each repo, only at a
clean commit, and gro's `git status` there may refresh a repo's index. A fetch
stays in **observe**: it refreshes the view of origin and moves no branch
anyone works on.
`gitops_plan` and `gitops_release` without `--wetrun` belong to the
publishing vertical but sit in **observe**: they write nothing in git.
`gitops_validate` composes analyze, plan, and `ci_reconcile`, each in its
observe form.

### The authoring rule

`repos` moves refs it didn't author — it fetches, fast-forwards, moves
shallow branches, clones, and pushes commits that already exist — and reports
git state. The one thing it rewrites is a diverged registry branch's
local-only commits, which `repos sync` — and `repos push`, for the branch
it's asked to push — replays onto the fetched upstream:
new commit objects carrying the same changes, messages, authors, and author
dates, committed by whoever runs the tool, and no content of its own. The TS
tasks and gro author content — commits, changesets, release
tags — and own package meaning: npm, changesets, the dependency graph, the
GitHub API, library analysis, the dashboard. Release pushes (`gro publish`'s
push with `--follow-tags`, `gro deploy`'s push to the deploy branch) stay
gro's, in the publish tier.

### What `repos` never does

Each is structural, in the code (the rustdoc of `sync.rs`, `push.rs`,
`clone.rs`, `git.rs`, `probe.rs` (fetch confinement), and `busy.rs` and
`sessions.rs` (busy detection) says how):

- never `pull`s, merges anything but a fast-forward, or resolves a conflict.
  The one history change is a rebase (`repos sync`'s, and `repos push`'s for
  the branch it's asked to push): a diverged registry branch's local-only
  commits are replayed onto the fetched upstream (`git replay`, in memory).
  Any conflict stops it with nothing moved, and no merge driver settles one,
  the user's or git's `union`. It never rewrites a commit a remote holds (a
  branch ahead by one any remote-tracking ref holds is a person's), so what
  it pushes is still a fast-forward of linear history, and host repo rules
  never need modelling. Any other diverged branch stops and reports
- never creates a commit of new content, a tag, or a changeset: a rebase's
  replayed commits are new objects with the changes, messages, authors, and
  author dates of the ones they replace
- never force-pushes: a push is a fast-forward of exactly the tip the fetch
  saw, under a lease, and sends no tags or push options; a remote branch is
  created only by the user's `repos push --new-branch`, refused in an agent's
  shell
- never deletes a branch, local or remote — the fetch's `--prune` deletes
  only remote-tracking refs gone upstream
- never prunes or removes a worktree, and never switches a checkout to
  another branch: a fast-forward, move, or rebase in a checkout runs only
  after reading it on that branch and clean (a switch by another hand in the
  instant between is the window left; `sync.rs` says what each action checks
  after). `repos push` touches a working tree only to rebase: a branch ahead
  pushes from a dirty checkout, and a diverged one in a dirty checkout is
  held, nothing moved
- never touches a pin once it's cloned, refreshes a third-party reference
  only when the run names it or passes `--references`, and writes to a remote
  only for owned entries
- never acts on a branch checked out where it finds another live Claude Code
  session working (busy — [what it can't see](docs/repos.md#busy-detection)),
  and holds every branch action when it can't vouch for the sessions — a
  clone of a missing entry still runs, since it only creates a dir
- never runs hooks, an fsmonitor, or background maintenance — Git LFS's
  `pre-push` upload among them, so a push that would send Git LFS pointers
  is held until the user uploads them and runs `repos push --lfs-uploaded`.
  Programs the user's own git config names (filter drivers, the gpg
  program, credential helpers, SSH) run as in any git call, with one
  exception: a rebase's replay runs no merge driver — git is handed a
  command that fails in its place — since merging a path is settling a
  conflict
- never installs, builds, calls the GitHub API, or reads env files: git is
  the only program it runs (and `kill`, to stop a timed-out call), and it
  holds no credential of its own

What each command writes, exactly — the fetch's confinement, sync's writes,
a push's rebase, clone placement, `--new-branch`'s upstream config, partial
clones' lazy fetching — is in docs/repos.md: [status](docs/repos.md#repos-status),
[Fetching](docs/repos.md#fetching), [sync](docs/repos.md#repos-sync),
[push](docs/repos.md#repos-push-the-gateway),
[`--new-branch`](docs/repos.md#--new-branch), and
[clones](docs/repos.md#cloning-missing-entries).

### Out of scope

- **Single-repo work** — build, check, publish, gen, format. That's `gro`. (A
  single-repo *push* by an agent is the exception: it goes through the gateway.)
  fuz_repos orchestrates gro across many repos and delegates hard: it carries
  no install or cache-healing logic of its own because gro's install path
  already self-heals npm's stale-cache failure. If gro can do it for one repo,
  fuz_repos's job is ordering and reporting, not reimplementation.
- **Work that needs judgment per repo** — a refactor whose resolution differs
  in each repo, a migration with per-repo edge cases. The rule that follows:
  **where a plan would have to guess, it must stop and report rather than
  guess.** A tool that resolves ambiguity on your behalf across many repos
  multiplies its mistakes.
- **Secrets and env files.** fuz_repos never stores, transports, or reads
  secret material as data — not as a convenience, not behind a flag. Its own
  operating credential (`SECRET_GITHUB_API_TOKEN`, read from `.env` and sent
  only to the GitHub API) is the tool authenticating itself, not fleet secrets
  passing through it. A gitops config is committed and often public-adjacent;
  a tool that reads it should never be somewhere secrets could land. Reporting
  an env file's *presence* is legitimate fleet state; its contents never are.
- **Machine and server state.** Provisioning and deployment convergence is a
  different target with its own tooling.

### The TS and Rust halves

Every TS entry point is a Gro task (`src/lib/gitops_*.task.ts`), so it runs
from a Gro project, consumers add one-line re-export shims, and `--config`
defaults to the CWD's config. `gro gitops_*` stays the supported invocation for
a project's own config, publishing, and dashboard data.

The Rust side lives in this repo as one crate, `crates/fuz_repos` (a library
plus the `repos` binary), and moves refs under the authoring rule above — git
only, no API calls. `repos status` reports each entry's git state from local
refs (`--fetch` refreshes them first), `repos sync` carries out the
fast-forwards, moves, rebases, pushes, and clones `status` previews, and `repos push`,
the gateway, pushes one checkout's branch through sync's own push, rebasing
it first through sync's own rebase when it diverged — each in
[docs/repos.md](docs/repos.md#commands).

The structured model of each repo's git state — every local branch against
its upstream, dirt by kind, local-only work, stashes, operations in progress,
missing clones — is the Rust tool's alone. The TS side has no git-state model
of its own: it consumes `repos status --json` rather than growing
`GitOperations` or parsing `git status` porcelain.

TS keeps everything else: the dashboard, its data step (GitHub metadata and
svelte-docinfo library analysis, which only `gitops_sync` runs), and the
release step. A project's `gitops.config.ts` is a list of registry keys, and every TS task resolves
them through `repos status <keys…> --json` — each repo's dir, URL, branch,
visibility, `ci`, and `archived` come from the registry, and the TS side
clones nothing. Readiness is read from the report too: a release step
holds a rewrite or publish on each npm repo's `at_rest` facts after a
`--fetch`, the diagnostics report the repos not at rest, and `gitops_sync` refuses to
generate the dashboard's data from a repo off its branch, dirty,
mid-operation, or without the installed dependencies its library analysis
reads. No TS task switches a branch, pulls, or installs: moving
repos is `repos sync`'s, and installing dependencies is out of scope.

## Core functionality

- Fetches metadata from repo collections via GitHub API
- Reads each repo's git state from the `repos` binary, never moving a repo
- Generates typesafe JSON from package.json and exported modules metadata
- Publishes docs websites for repo collections
- Tracks CI status and pull requests

## Architecture

```
gitops.config.ts (registry keys) -> repos status --json -> local repos -> GitHub API -> repos.ts -> UI components
```

### Key files

Every `src/lib` module is listed here or under
[Key Publishing Modules](#key-publishing-modules):

- `gitops.config.ts` - user config listing the repos by registry key
- `src/lib/gitops_config.ts` - config schema, loading, and the public-host
  leak guard
- `src/lib/gitops_task_helpers.ts` - `resolve_gitops_repos` (config keys →
  `repos status` → checkouts), shared by every task, and `get_gitops_ready`
  (plus loading each repo's `package.json`, no module analysis) for the
  publishing and dependency tasks; `log_readiness_block`
- `src/lib/repos_status_load.ts` - runs `repos status --json` through the
  injected `ReposOperations` and parses its report or error document
- `src/lib/repo_readiness.ts` - pure readiness predicates over the report's
  entries: at rest (the diagnostics' block), ready to rewrite or publish
  (`check_release_readiness`, the release step's holds), and ready to
  generate (`gitops_sync`)
- `src/lib/gitops_sync.task.ts` - generates the dashboard's data from each
  repo as it sits, refusing one not ready to generate from
- `src/lib/gitops_analyze.task.ts` - analyzes dependencies and changesets
- `src/lib/gitops_plan.task.ts` - the offline publishing plan: waves, version
  changes, rewrites
- `src/lib/gitops_release.task.ts` - one release step: observes, rewrites
  released dependencies' dependents (`--wetrun`), names the wave to publish
- `src/lib/gitops_validate.task.ts` - runs all validation checks
- `src/lib/gitops_run.task.ts` - runs a shell command in every configured repo
- `src/lib/ci_reconcile.ts` - compares each repo's registry `ci` flag with the
  workflow files in its checkout (`missing_ci`, `stray_ci`), skipping archived
  repos; `gitops_validate`'s last step
- `src/lib/local_repo.ts` - resolves config keys against the report
  (`local_repos_resolve`) and loads each repo's library as it sits — with
  its modules (svelte-docinfo analysis, for the dashboard) or from its
  `package.json` alone (`modules`, chosen at each load site)
- `src/lib/github.ts` - GitHub API client for PRs, CI status
- `src/lib/github_helpers.ts` - flattens repos' pull requests for the
  dashboard, with an optional filter, and builds PR URLs
- `src/lib/fetch_repo_data.ts` - fetches each repo's CI status and PRs
- `src/lib/fs_fetch_value_cache.ts` - the GitHub fetch cache on disk
- `src/lib/repo.svelte.ts` - the `Repo` class and its serialized shape
- `src/lib/cargo_toml.ts` - the identity fields read from a Rust repo's
  `Cargo.toml`
- `src/routes/repos.ts` - generated data file with all repo info
- `src/lib/gitops_constants.ts` - the tasks' defaults
- `src/lib/output_helpers.ts`, `src/lib/log_helpers.ts` - report formats,
  stdout routing, and log formatting
- `src/lib/repos_status.ts` - fuz_schema mirror of the `repos status --json`
  document (report and error document), guarded by the goldens
- `crates/fuz_repos/` - the Rust `repos` tool: a library — registry, git
  runner, probe, unregistered scan, busy detection, classification, sync,
  push, and the entry points that load a registry and return a finished
  report (`status_report`, `sync_report`, `push_report`) — and the `repos`
  binary, which parses arguments, renders, and owns exit codes
- `crates/fuz_repos/tests/` - its integration tests over fixture workspaces
  (`tests/support`)
- `docs/repos.md` - the `repos` command reference

## Patterns

### State-Derived Release Steps

A release proceeds in steps, each derived from observed state, with publishing
left to the user:

- **Plan** (`generate_publishing_plan`) resolves the whole cascade in one pass
  over the prod/peer topological order — each package's dependencies are
  settled before it's reached, so its required bump is final when computed:
  explicit changesets, bump escalations from breaking dependencies, and
  auto-generated changesets for dependents. No iteration. The packages that
  publish are grouped into **waves** (`group_into_levels`): a wave's packages
  depend only on earlier waves, so each wave publishes together, in config
  order within it.
- **Every package's version after the release** is its predicted one when it
  publishes and its current one otherwise, so a dependent whose range trails a
  dependency's current version gets that rewrite too — and, for a prod/peer
  range, an auto-bump. The first step over a workspace catches up every
  lagging range this way, `>=` floors included, the way the old cascade
  rewrote them on each publish. A range moves only
  forward (`needs_update`), and whether a move is breaking is measured from the
  range's base version (`to_range_update_bump`), so a lagging range takes the
  bump it skipped.
- **Step** (`gro gitops_release`) observes — a fetch, each `package.json` and
  its changesets, and what the registry shows for each current version
  (`NpmOperations.view_version`) — plans from that, and derives the step
  (`to_release_state`): the dependents of **released** dependencies (nothing
  left to publish, version on the registry) get their ranges rewritten and,
  when they republish, their auto-changeset, one commit each (`--wetrun`); the
  plan's first wave, less any held, is named to publish.
- **Publish** is the user's: `gro publish` in each repo named, inside one npm
  2FA window. The next step sees the versions on the registry and goes on.

There's no state between steps and no frozen plan to drift from: a step that
runs early, a wave published by hand, or a cascade stopped partway all read
the same way — whatever is released and whose dependents still trail it.

The dependency-driven bump rule (pre-1.0 → minor for a breaking dep, else patch;
1.0+ → major or patch) lives once in `required_bump_for_dependency_update`
(`version_utils.ts`), shared by the plan and the auto-changeset generator so the
two never disagree.

### Registry States

What the registry shows for a package's current version, when it has no
changesets of its own (`RegistryVersion`):

- `listed` — **released**: dependents still trailing it are rewritten
- `unlisted` — the registry knows the package, not this version:
  **awaiting the registry** (still propagating, or a failed publish). Its
  dependents' rewrites and publishes are held; `--wait` polls for it
- `unknown` — the registry has never seen the package. When some configured
  package depends on it for prod or peer, it's **awaiting the registry** too:
  a first publish npm answers E404 for until it shows. Otherwise it's **never
  published**: an app or site, most likely, that should be `private`. No range
  moves for it and it doesn't hold the release

npm can't answer → the step stops before writing anything, so an outage never
reads as unpublished.

### No Rollback Support

fuz_repos does not support rollback of published packages:

- NPM does not support reliable unpublishing of packages
- Once a package is published to NPM, it cannot be easily reverted
- If a publish fails, you publish forward (fix the issue and publish again)

### No Concurrent Steps

Running two `gro gitops_release --wetrun` at once is not supported: both
would rewrite the same dependents' `package.json` and changeset files.

## Configuration

```ts
// gitops.config.ts
import type { GitopsConfig } from '@fuzdev/fuz_repos/gitops_config.ts';

const config: GitopsConfig = {
	repos: ['fuz_util', 'gro', 'fuz_ui'] // repos.toml registry keys, in display order
};

export default config;
```

The config lists owned repos by their `repos.toml` key and nothing else: each
repo's dir, URL, branch, visibility, `ci`, and `archived` come from the
registry through `repos status <keys…> --json`, so the tasks need the `repos`
binary on `PATH` (`cargo install --path crates/fuz_repos --locked`, from a
fuz_repos checkout — the npm package doesn't carry it) and a registry
`repos` can find from the cwd, or `--registry <path>`. The default export
may also be a function returning the config. Every task resolves the keys
the same way and refuses to run, naming each problem, when a key is
unknown, names a third-party reference, or its repo is missing (`repos sync
<key>` clones it), isn't a git repo, or failed to probe. Repos keep the
config's order.

Requires `SECRET_GITHUB_API_TOKEN` in `.env` for API access.

## Main operations

### `gro gitops_sync` Task

Generates the dashboard's data from each repo as it sits — it never switches
a branch, pulls, or installs:

1. Loads the config's registry keys and resolves them through `repos status`
   (local refs), refusing to run when a public host package's config lists
   repos the registry declares private (`gitops_config_leaked_private_repos`)
   — the generated `repos.json` is that package's public site data
2. Refuses, before any network, a repo off its registry branch, dirty
   (untracked files count), or mid-operation, naming each with its fix
   (`check_gen_readiness`): the site would show that tree's modules beside
   origin's CI. `--allow_dirty` reads such repos as they sit, warning instead.
   It also refuses each npm repo the library analysis can't fully read — no
   `node_modules`, or no `node_modules/$app/tsconfig.json` its tsconfig
   extends — naming the fix (`npm install`, `gro sync`, or both, in that
   repo): external types would read as `any`, and gro can cache the analysis at
   `.gro/library.json` keyed on the commit, so the degraded library can
   outlive the fix. `--allow_dirty` doesn't reach this refusal. `--check`
   stops here: it logs the report and exits non-zero when a real run would
   refuse — no fetch, no token, nothing written
3. Reads `SECRET_GITHUB_API_TOKEN`
4. Fetches the repos from origin (`repos status <keys…> --fetch --json`) and
   checks them again, warning on a followed branch not in sync with origin
   (behind: CI is origin's tip, the modules the local tree) and a failed
   fetch (the last fetch's view stands)
5. Loads each repo's library, fetches GitHub data (CI, PRs), and writes
   `repos.json` + `repos.ts` (running `gro gen` when `repos.json` changed),
   then updates the fetch cache

### Data fetching

- Pull requests via GitHub API
- CI check runs and status, for repos whose registry entry declares `ci`
  (a branch with no check runs is `null`, not a failure)
- Caches responses to minimize API calls

### Multi-repo releases

#### The release loop

- `gro gitops_release` - previews a step: the rewrites it would commit and the
  wave to publish; writes nothing in git (its fetch refreshes remote-tracking
  refs)
- `gro gitops_release --wetrun` - the step: commits the rewrites, then names
  the wave to publish
- `gro publish` in each repo named, inside one npm 2FA window — the user's
- `gro gitops_release --wetrun --wait` - first waits for the versions awaiting
  the registry (the wave just published, polling, `--max_wait`, 10 minutes by
  default), then steps
- `gro gitops_plan` - the whole release offline: its waves, version changes,
  and rewrites, counting every current version as released
- `gro gitops_analyze` - the dependency graph, its levels, and its cycles
- Handles circular dev dependencies by excluding them from the topological sort

**Readiness (holds, never moves)**

A step never moves a repo to get it ready. Its fetch reads every npm repo
(`repos status --fetch --json`), and `check_release_readiness`
(`repo_readiness.ts`) holds a rewrite or publish in any repo not at rest, not
in sync with origin or ahead, busy, or with a `needs_human` reason, naming the
fix. The plan reads every repo as it sits, so a repo not ready may hide a
changeset: its dependents' rewrites to it and the publishes of everything
depending on it for prod or peer, however deep, are held too. The report-wide problems (an unfetched report, busy detection
unavailable) hold every repo. A branch ahead of origin is ready — the step's
own rewrite commits leave a dependent ahead, and its `gro publish` pushes them
with the release; a dependent that doesn't publish (a dev-only rewrite, a
private or never-published leaf) keeps them unpushed until `repos sync` or
`repos push`. Detail: [docs/publishing.md](docs/publishing.md#readiness).

**What the user's `gro publish` does**

The step prints plain `gro publish` (naming `--branch` when the entry follows
a branch other than `main`): gro checks out the branch, pulls, installs
(healing npm's stale-cache ETARGET when a just-released version isn't visible
yet), runs `gro check` against the rewritten ranges, builds, runs `changeset
publish` (npm's 2FA prompt), and pushes the release commit and tag — with the
step's rewrite commits under it. fuz_repos installs, builds, and publishes
nothing itself.

**Machine-readable stdout**: under `--format json` or `markdown` without
`--outfile` (`gitops_analyze`, `gitops_plan`; `gitops_run --format json`), each
task routes its logger to stderr (`route_human_output` in `output_helpers.ts`)
— the plan, the readiness block, and gro's lines after the task — so stdout
carries the document alone. Gro's two lines before a task runs (`invoking`,
`→ <task>`) are out of the task's reach and stay on stdout; `--outfile` gives a
file free of them.

#### Changeset Semantics

The publishing scenarios (see ./docs/publishing.md for
details):

1. **Explicit changesets** - Normal publishing with version bump from changesets
2. **Bump escalation** - Changeset bump overridden by dependency requirements
3. **Auto-generated** - No changesets but prod/peer deps updated
4. **No changes** - Skipped (normal behavior)

**Dependency behavior**: Production/peer deps trigger republish; dev deps only
update package.json without republishing.

#### Private Packages

Packages with `"private": true` never publish. They are excluded from the plan's
version changes and waves — no publish, bump escalation, or auto-changeset —
though they keep their slot in the topological order. A private package that
depends on a released one is handled as an **update-only leaf**: its dependency
ranges are rewritten and committed _without_ a changeset (it won't republish).
A private package carrying its own changeset is flagged in the plan's warnings,
since that changeset can't be published.

#### Key Publishing Modules

- `publishing_plan.ts` - Plan generation: the one-pass cascade, waves, and the
  registry states (`awaiting_registry`, `never_published`)
- `publishing_plan_helpers.ts` - The plan's dependency updates and required bumps
  (`to_dependency_updates`, `calculate_dependency_updates`,
  `get_required_bump_for_dependencies`)
- `publishing_plan_logging.ts` - Prints a plan to the log (`log_publishing_plan`,
  `format_waves`)
- `release_state.ts` - Pure: a plan and each repo's readiness in, the step out
  (`to_release_state`: rewrites, holds, the packages to publish now, done)
- `changeset_reader.ts` - Parses changesets and predicts versions
- `changeset_generator.ts` - Auto-generates changesets for dependency updates
- `dependency_graph.ts` - Topological sorting, level grouping (`group_into_levels`),
  cycle detection, and wildcard analysis
- `graph_validation.ts` - `validate_dependency_graph` (graph, cycles by type,
  order, levels; reports, never throws) and `analyze_repos` for the analysis
  tasks
- `version_utils.ts` - Version comparison, range moves (`needs_update`,
  `to_range_update_bump`), and bump type detection
- `npm_registry.ts` - Registry waits with retry (`NpmRegistryDeps` injects npm,
  the sleep, and the clock) and `RegistryVersion`
- `dependency_updater.ts` - One dependent's `package.json` rewrite and commit,
  with its auto-changeset when it republishes
- `repo_readiness.ts` - The readiness predicates the step's holds and the
  diagnostics' block read
- `operations.ts` - Dependency injection interfaces for testability;
  `operations_defaults.ts` holds the real implementations and
  `git_operations.ts` the throwing git helpers under them

#### Planning Algorithms

See ./docs/publishing.md for detailed algorithm
descriptions.

**One pass**: the plan walks the prod/peer topological order once; each
package's dependencies are settled when it's reached, so no iteration is
needed. **Waves** group the packages that publish by their longest prod/peer
path to others that publish.

**Cycle Detection**: Production/peer cycles block publishing (error). Dev cycles
allowed (reported as info, excluded from topological sort). The order is
computed via topological sort on prod/peer deps only.

## Data types

```ts
class Repo {
	readonly library: Library;
	readonly package_json: PackageJson; // the full package.json, deps included
	readonly branch: string; // the registry branch CI was fetched for; the dashboard's links use it
	check_runs: GithubCheckRunsItem | null;
	pull_requests: Array<GithubPullRequest> | null;
}

interface LocalRepo {
	// `npm` repos (with a package.json) take part in publishing; `cargo` repos
	// (a Rust Cargo.toml, no package.json) are dashboard-only — see below.
	kind: 'npm' | 'cargo';
	library: Library;
	package_json: PackageJson;
	repo_dir: string;
	entry: ReposEntryStatus; // the registry entry as `repos status --json` reported it
	dependencies?: Map<string, string>;
	dev_dependencies?: Map<string, string>;
	peer_dependencies?: Map<string, string>;
}

interface LocalRepoPath {
	repo_name: string; // the registry key
	repo_dir: string; // the workspace root joined with the entry's dir
	repo_url: string;
	entry: ReposEntryStatus;
}
```

### Non-npm repos (dashboard-only)

A configured repo without a `package.json` but with a Rust `Cargo.toml` (e.g.
`tsv`) loads as a `kind: 'cargo'` `LocalRepo`. It has no npm identity, so there's
no `svelte-docinfo` analysis and no dependency graph — `local_repo.ts` synthesizes
a lightweight `Library` from the `Cargo.toml` (best-effort name/version/description,
via `cargo_toml.ts`), falling back to the registry key and URL. These repos are still
rendered on the dashboard (CI status, PRs, identity) but are excluded from
publishing and dependency analysis: `generate_publishing_plan`, `analyze_repos`,
and the release step filter to `repo_is_npm` first. A repo with neither
manifest is unsupported and fails loud.

## UI components

Pages compose a detail component between `PageHeader.svelte` and
`PageFooter.svelte`:

- `TablePage.svelte` → `ReposTable.svelte` - dependency matrix view
- `TreePage.svelte`, `TreeItemPage.svelte` → `ReposTree.svelte` (with
  `ReposTreeNav.svelte`) - hierarchical repo browser
- `ModulesPage.svelte` → `ModulesDetail.svelte` (with `ModulesNav.svelte`) -
  module exploration
- `PullRequestsPage.svelte` → `PullRequestsDetail.svelte` - PR tracking

## Commands

```bash
npm i -D @fuzdev/fuz_repos

# Dashboard data (reads each repo as it sits; `repos sync` moves them)
gro gitops_sync               # fetch, check each repo is ready, then write repos.json + repos.ts from GitHub and library data
gro gitops_sync --check       # the readiness report alone, from local refs and installed dependencies: no fetch, no token, nothing written; non-zero when a run would refuse
gro gitops_sync --allow_dirty # read repos off their branch, dirty, or mid-operation as they sit, warning instead of refusing
gro gitops_sync --outdir <dir> # write the data somewhere other than the routes dir
gro gitops_sync --registry ../repos.toml # every task takes a registry repos wouldn't find from the cwd

# Run commands across repos (reads repos as-is, no branch switch/pull; a missing repo fails the run)
gro gitops_run "npm test"                          # run command in all repos (parallel, concurrency: 5)
gro gitops_run "npm audit" --concurrency 3         # limit parallelism
gro gitops_run "gro check" --format json           # JSON on stdout, the log on stderr
gro gitops_run "gro check" --format json --outfile out.json # clean JSON to a file

# Releasing
gro gitops_validate              # validate configuration (runs analyze, plan, and ci_reconcile)
gro gitops_analyze               # analyze dependencies: levels, cycles, wildcards
gro gitops_plan                  # the release offline: waves, version changes, rewrites
gro gitops_plan --verbose        # show additional details
gro gitops_release               # preview a step: the rewrites it would commit and the wave to publish
gro gitops_release --wetrun      # step: commit the rewrites, name the wave to publish
gro gitops_release --wetrun --wait # first wait for versions awaiting the registry, then step
gro gitops_release --wetrun --wait --max_wait 1200000 # wait timeout in ms (default 600000, 10 minutes)
gro gitops_release --range_strategy gte # prefix for a rewritten range that has none: exact, caret (default), tilde, gte; an existing prefix is kept

# Output formats (analyze, plan)
gro gitops_analyze --format json --outfile analysis.json
gro gitops_plan --format markdown --outfile plan.md

# Development
gro dev        # start dev server
gro build      # build static site
gro deploy     # deploy to GitHub Pages

# Fixtures
gro test src/test/fixtures/check # validate the analysis, plan, and release step against fixture expectations
```

The Rust `repos` tool lives in `crates/fuz_repos`, a Cargo workspace beside
the SvelteKit app; gro never invokes cargo. Its commands and flags — status,
`--brief`, fetching, sync, push, references, clones, exit codes, and the test
harness — are in [docs/repos.md](docs/repos.md#commands); install and gates:

```bash
cargo install --path crates/fuz_repos --locked # install the `repos` binary (git 2.44+; busy detection needs Linux)

cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
UPDATE_GOLDEN=1 cargo test --test golden # regenerate the --json golden fixtures in src/test/fixtures/repos_status/ (never hand-edit)
```

**Agents push through `repos push`**, never raw `git push` — a Claude Code
deny rule on the latter is guidance, not a boundary
([docs/repos.md](docs/repos.md#agents-push-through-repos-push)). A push of a
diverged registry branch rebases it first, from a clean checkout: the report's
`rebased` line means earlier commit ids are stale and earlier checks ran on
the old base.

### Command Workflow

- `gitops_validate` runs: `gitops_analyze` + `gitops_plan` + `ci_reconcile`.
  It hard-fails (throws) on any error from any step — a production dependency
  cycle, a plan error, or CI drift — so a clear problem stops the run.
  Warnings stay non-fatal.
- `gitops_release` runs: a fetch + the registry reads + the plan +
  `to_release_state`, then (with `--wetrun`) the rewrites

## Dependencies

- `@fuzdev/gro` - build tool and task runner
- `@fuzdev/fuz_ui` - UI components and utilities
- `@fuzdev/fuz_util` - utility functions
- `@fuzdev/fuz_css` - semantic-first CSS framework and design system
- `@sveltejs/kit` - web framework
- `svelte` - UI framework
- `@fuzdev/fuz_schema` - every schema: the tasks' `Args`, which Gro parses, the `package.json` read without analysis, `repos` output, GitHub data, the config, and publishing events

## General Patterns

- Uses Gro's well-known package.json patterns for metadata
- Generates static JSON for fast client-side rendering
- Caches API responses to minimize API calls
- Generated files are formatted, and written only when their content changed
- Repo dirs come from the registry, never the config
- Functional programming patterns (arrow functions, pure functions)
- Changeset-driven versioning with auto-generation
- Natural resumption via changeset consumption (no state files needed)

### Peer Dependency Versioning Strategy

For packages you control, use `>=` instead of `^` for peer dependencies:

```json
"peerDependencies": {
  "@fuzdev/fuz_util": ">=0.38.0", // controlled package - use >=
  "@fuzdev/gro": ">=0.174.0",   // controlled package - use >=
  "@sveltejs/kit": "^3",          // third-party - use ^
  "svelte": "^5"                  // third-party - use ^
}
```

**Why `>=` for controlled packages:**

- Eliminates npm peer dependency resolution conflicts when publishing sequentially
- `^0.37.0` means `>=0.37.0 <0.38.0` in 0.x semver (excludes next minor)
- When you publish `fuz_css@0.38.0`, packages with `"@fuzdev/fuz_css": "^0.37.0"`
  conflict
- `>=0.37.0` allows any version `>=0.37.0`, including `0.38.0` and beyond
- No need for `--legacy-peer-deps` flag

**Why `^` for third-party packages:**

- You don't control when they make breaking changes
- `^` protects users from accidental incompatibility

**Version prefix preservation:**

When fuz_repos updates dependencies, it preserves existing prefixes:

- `>=0.38.0` updates to `>=0.39.0` (preserves `>=`)
- `^1.0.0` updates to `^1.1.0` (preserves `^`)
- `~1.0.0` updates to `~1.1.0` (preserves `~`)

## Testability & Operations Pattern

This project uses **dependency injection** for the side effects of the release
step, making it testable without mocking libraries. Outside that, several
modules touch the fs directly: the readers of a repo's own files
(`changeset_reader.ts`, `cargo_toml.ts`, `local_repo.ts`, `gitops_config.ts`,
`ci_reconcile.ts`), the fetch cache (`fs_fetch_value_cache.ts`), and the
writers of task output (`gitops_sync.task.ts`, `gitops_run.task.ts`,
`output_helpers.ts`):

**Why:** Functions that call git, npm, or file system are hard to test. The
operations pattern abstracts these into interfaces.

**How:** See `src/lib/operations.ts` - all external dependencies (git, npm, fs,
and the `repos` binary) are defined as interfaces. Tests provide
mock implementations; `create_mock_repos_ops` injects a `repos status --json`
document, so no test spawns the binary.

**Benefits:**

- **No mocking libraries** - Just plain objects implementing interfaces
- **Type-safe tests** - Mock implementations must match interface signatures
- **Easy setup** - Return exactly what you want from fake operations
- **Fast tests** - No real git/npm/fs operations, instant execution
- **Predictable** - Control all side effects explicitly
- **Readable** - Test code shows exactly what operations do

**Example:**

- Production: `generate_publishing_plan(repos, options)` — `options.ops`
  defaults to `default_changeset_operations`; `run_gitops_release(args, log,
  deps)` defaults each of its `GitopsReleaseDeps`
- Tests: `generate_publishing_plan(repos, {ops: create_mock_gitops_ops().changeset})`,
  and `run_gitops_release(args, log, {npm_ops, fs_ops, …})` over an in-memory
  workspace

See `src/lib/operations_defaults.ts` for real implementations,
`src/test/test_helpers.ts` and `src/test/fixtures/mock_operations.ts` for the
mock factories.

**When writing new code:**

- Add side effects as operations interface methods (see `operations.ts`)
- New code takes small `*Deps` interfaces (as `GitopsReleaseDeps` does) rather
  than another `*Operations` group; the existing groups are legacy
- Call side effects through the injected deps: `await d.git_ops.commit(...)`
- Tests inject fake operations that return controlled data

## Testing

Uses vitest with **no mocking libraries** in the domain tests — they inject
plain-object operations (see above), and `npm_registry.test.ts` drives the
npm wait through `NpmRegistryDeps` with a fake registry and clock. The one
exception is `operations_defaults.test.ts`, which tests the real
implementations themselves: it stubs `spawn_out` for `npm view`.

```bash
gro test                         # run all tests
gro test version_utils           # run specific test file
gro test src/test/fixtures/check # validate the analysis, plan, and release step against fixture expectations
```

Each module's tests are `src/test/<module>.test.ts`, split by aspect where one
file would sprawl (`repo_readiness.publish.test.ts`,
`local_repo.resolve.test.ts`). The task tests (`gitops_release.test.ts`,
`gitops_sync.test.ts`, `gitops_run.test.ts`, …) drive each task's `run_*`
function (`prepare_gitops_sync` for sync) through its injected `Gitops*Deps`, which is where the order of
reads, gates, and writes is pinned.

### Fixture Testing

The fixture system builds `LocalRepo`s in memory from fixture data, with mock
operations standing in for git, npm, and the fs:

**Fixture Data:**

- `src/test/fixtures/repo_fixtures/*.ts` - Source of truth for test repo definitions
- `src/test/fixtures/repo_fixture_types.ts` - The fixture shape
- `src/test/fixtures/load_repo_fixtures.ts` - Converts a fixture to `LocalRepo`s
- `src/test/fixtures/mock_operations.ts`, `mock_changeset_operations.ts` - The
  operations a fixture runs under
- `src/test/fixtures/configs/*.config.ts` - Each fixture's repos as a key-list
  config, load-validated against the fixture (there's no fixture registry, so
  the tasks don't run on them)

**Fixture Scenarios:**

- `basic_publishing` - Every publishing scenario (explicit, auto-generated,
  bump escalation, no changes)
- `deep_cascade` - Multi-level dependency chains with cascading breaking changes
- `circular_dev_deps` - Dev dependency cycles (allowed, non-blocking)
- `circular_prod_deps_error` - Production circular dependencies (error
  detection)
- `private_packages` - Private package handling (skipped from publishing)
- `major_bumps` - Major version transitions (0.x → 1.0, 1.x → 2.0)
- `peer_deps_only` - Plugin/adapter patterns (peer dependencies only)
- `isolated_packages` - Independent packages with no internal dependencies
- `multiple_dep_types` - Packages with both peer and dev deps on same dependency
- `three_way_dev_cycle` - Complex dev dependency cycles with three packages

**Structured Validation:**

- `src/test/fixtures/check.test.ts` - Checks the analysis, plan, and release step against each fixture's `expected_outcomes`
- `src/test/fixtures/helpers.ts` - Assertion helpers
- `src/test/fixtures/repo_fixtures.test.ts` - Per-fixture assertions on the generated plan

**Workflow:**

1. Define fixture data with expected outcomes in `repo_fixtures/*.ts`
2. Run `gro test src/test/fixtures/check` to validate the plan and release
   step against expected outcomes

Each fixture runs in isolation, validating:

- Topological order and waves
- Version changes (explicit, auto-generated, bump escalation scenarios)
- Breaking change cascades
- Warnings, errors, and info messages

The Rust test harness is described in [docs/repos.md](docs/repos.md#testing),
along with the `repos --json` golden documents in
`src/test/fixtures/repos_status/` (regenerated with `UPDATE_GOLDEN=1 cargo
test --test golden`, never by hand). `src/test/repos_status.golden.test.ts`
parses the status goldens with the strict schemas of `src/lib/repos_status.ts`,
and the TS consumer's own tests take them as inputs: the parser
(`repos_status_load.test.ts`, each error document mapped to its message) and
the key resolution (`local_repo.resolve.test.ts`).

## Generated Files & Caches

- **Repo data** — `gro gitops_sync` writes `repos.json` + `repos.ts` to the
  SvelteKit routes dir (`src/routes/` by default, overridable with `--outdir`).
  These are committed (the site renders from them).
- **Caches** (gitignored, under `.gro/`) — the fetch-value cache at
  `.gro/build/fetch/`, and, in each repo `gitops_sync` analyzes, the
  `svelte-docinfo` library metadata at `.gro/library.json` (written by gro's
  `library_load_from_repo`, keyed by a clean `HEAD`). The other tasks read
  `package.json` alone and write no cache.

## Additional Documentation

- [Publishing Guide](docs/publishing.md) - Workflows, changeset semantics,
  examples
- [Troubleshooting](docs/troubleshooting.md) - Common errors and debugging tips
- [The `repos` tool](docs/repos.md) - Command reference: registry discovery,
  status, fetching, busy detection, sync, push, references, clones, testing
