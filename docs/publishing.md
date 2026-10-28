# Publishing Guide

This guide covers multi-repo releases: the release step, changeset semantics,
and the plan behind them.

## Table of Contents

- [Quick Start](#quick-start)
- [The Release Step](#the-release-step)
- [Changeset Semantics](#changeset-semantics)
- [The Plan](#the-plan)
- [Readiness](#readiness)
- [Planning Algorithms](#planning-algorithms)
- [Private Packages](#private-packages)
- [Workflows](#workflows)
- [Examples](#examples)

## Quick Start

```bash
# 1. Fetch, fast-forward what's behind, push what's ahead (repos off their branch or dirty are yours to move)
repos sync

# 2. Validate configuration (writes nothing in git)
gro gitops_validate

# 3. Review the waves the release will publish in
gro gitops_plan

# 4. Step the release: rewrite released dependencies, name the wave to publish
gro gitops_release --wetrun

# 5. Publish the named wave yourself, inside one 2FA window, then step again
gro gitops_release --wetrun --wait
```

## The Release Step

A release publishes in **waves**: a wave's packages depend only on earlier
waves, never on each other, so they publish together. Publishing is yours —
`gro publish` in each repo the step names, inside one npm 2FA window — and the
tool does the rest between waves. Each `gro gitops_release` derives where the
release stands from what it observes, so it keeps no state between steps and
is safe to run any time:

1. **Observe.** It fetches the configured repos (`repos status --fetch`, which
   moves only remote-tracking refs), loads each `package.json` and its
   changesets, and asks the registry (`npm view`) whether each publishable
   package's current version is out.
2. **Plan.** It plans the rest of the release from that (see
   [The Plan](#the-plan)).
3. **Rewrite.** For each dependency that is **released** — nothing left to
   publish, and the registry shows its current version — it moves the ranges
   of every dependent that still trails it, one commit per dependent
   (`update dependencies: <name> <version>`). A dependent that republishes
   gets its auto-changeset in the same commit. Only under `--wetrun`; without
   it the step says what it would write and changes nothing.
4. **Name the wave.** It prints the commands for the packages to publish now —
   the plan's first wave, less any held — with a line that runs them all, and
   the later waves as a forecast.

So the loop is: step, publish the wave, step again. A wave's versions take
minutes to show on the registry; a step before then reports them as
**awaiting the registry** and holds their dependents. `--wait` waits them out
(polling, up to `--max_wait`, 10 minutes by default) and then reads the state
again.

Each package lands in one state per step:

| State | Meaning | What the step does |
| --- | --- | --- |
| released | nothing to publish; the registry shows its current version | rewrites dependents still trailing it |
| pending | changesets, or a dependency forces a bump | publishes in its wave |
| awaiting the registry | its current version isn't on the registry yet, with no changesets: still propagating, or a publish that failed — a first publish too, when another configured package depends on it for prod or peer (npm answers E404 until it shows) | holds its dependents; `--wait` waits |
| never published | the registry has never seen the package, it has no changesets, and nothing configured depends on it for prod or peer | an update-only leaf like a private package: its own ranges move, and no range moves for it — mark it `private` if it never will publish |

The step holds a rewrite or a publish in a repo that isn't ready (see
[Readiness](#readiness)), naming why, along with what depends on it, and
carries on with the others.

The printed command is plain `gro publish` (naming `--branch` when the
registry entry follows a branch other than `main`): gro checks out the branch,
pulls, installs (healing npm's stale-cache ETARGET when a just-published
version isn't visible yet), runs `gro check` against the rewritten ranges,
builds, publishes, and pushes the release commit and tag — which carries the
step's rewrite commits with it.

A step changes no version and publishes nothing. It reaches the network twice:
the fetch, and `npm view`, which reads the registry npm's own config names.
When npm can't answer for a package, the step stops before writing anything,
so an outage never reads as unpublished.

## Changeset Semantics

Packages can publish in four distinct scenarios:

### 1. Explicit Changesets (Normal Publishing)

- Package has `.changeset/*.md` files
- Dependency updates don't require higher bump
- Behavior: Published with version bump from changesets
- Reported as: "Version Changes (from changesets)"

### 2. Explicit Changesets with Bump Escalation

- Package has `.changeset/*.md` files specifying bump type
- BUT dependency updates require a HIGHER bump
- Behavior: Published with escalated bump (e.g., `patch` → `minor` for breaking
  dep)
- Reported as: "Version Changes (bump escalation required)"
- Example: You write `patch` changeset, but `gro` (breaking) forces `minor`

### 3. Auto-Generated Changesets

- Package has NO `.changeset/*.md` files
- BUT has production/peer dependency updates
- Behavior: Changeset auto-generated by the step that rewrites its ranges, package republished
- Reported as: "Version Changes (auto-generated for dependency updates)"
- Example: `gro` publishes → `fuz` depends on `gro` → auto-changeset for `fuz`
- One file per dependent, `.changeset/dependency-updates.md`: each rewrite
  merges into it (its first `from`, its latest `to`, the bump recomputed), so
  the release notes carry one entry listing every dependency that moved
- A package with changesets of its own gets the same file beside them when a
  prod/peer dependency is released

### 4. No Changes to Publish

- Package has NO `.changeset/*.md` files
- Package has NO production/peer dependency updates
- Behavior: Skipped (not published)
- Reported as: "Nothing to publish", the plan's `no_changes` package list
  (not a warning) — a package there may still take dependency-only updates
- This is normal: Only packages with changes should publish

A package with changeset files that yield no bump for it — none parses, or
none that parses names it — takes no bump from them — it publishes only as an
auto-generated change if a dependency update requires one — and the plan warns,
naming the repo and why.

### Dependency Update Behavior

A range moves when its dependency's version after the release is newer than
the range's base version. A range already naming it, or staged ahead of it, is
left alone — a rewrite never moves a range backward.

- **Production/peer deps**: Package must republish (triggers auto-changeset if
  needed)
- **Dev deps**: Package.json updated, NO republish (dev-only changes)

Every lagging range counts, not just ones a release in progress moves: the
first step over a workspace rewrites each prod/peer range behind its
dependency's current version — `>=` floors included — and auto-bumps the
dependent, as the cascade always rewrote ranges when a dependency published.
Protocol ranges (`file:`, `workspace:`, `npm:` aliases) never move.

Whether a move is **breaking** is measured from the range's base version, not
just from the dependency's own release: a dependent naming `^0.54.0` whose
dependency goes `0.55.0 → 0.55.1` skips a breaking minor, so it takes the
bump that requires. This is what makes a range that lagged — a cascade stopped
partway, or a release made by hand — come out right.

When a package appears in both production/peer and dev dependencies,
production/peer takes priority for dependency graph calculations. A rewrite
moves every section that names the dependency, each keeping its own prefix
(`>=0.79.0` beside `^0.79.0`), in one commit. The plan's diffs show the ranges
as they'll be written.

## The Plan

### `gro gitops_plan`

- **Offline prediction** of the whole release: the waves, the version changes,
  and the dependency rewrites
- Shows every publishing scenario: explicit changesets, bump escalation,
  auto-generated changesets, and no changes — each package in exactly one
- Asks no registry, so it counts every current version as released: a range
  trailing one shows as a rewrite (with the bump it implies), and nothing is
  awaiting the registry. `gro gitops_release` plans the same way from what the
  registry shows
- `--format json` carries `waves`, `no_changes` (package names) apart from
  `info` (informational sentences: excluded non-npm repos, dev dependency
  cycles), and the registry fields `awaiting_registry` and `never_published`
- Read-only - moves no ref and writes nothing in git
- Reads each repo's `package.json` (name, version, dependencies) and its
  changesets, with no module analysis, so it needs no `node_modules` and
  writes no library cache
- Reads each repo's working tree **as-is** (whatever branch is checked out, even
  with uncommitted changes), and prints a readiness block naming each repo not
  at rest (see [Readiness](#readiness)), so a plan over a feature branch says
  so. Run `repos sync` beforehand so the plan reflects the canonical branches
  rather than your local checkout.

### Waves

```
Waves (each publishes together, after the ones above):
  1. @fuzdev/fuz_util
  2. @fuzdev/fuz_css, @fuzdev/gro, @fuzdev/mdz
  3. @fuzdev/fuz_app, @fuzdev/fuz_code
  4. @fuzdev/fuz_ui
```

A package's wave is one past the deepest wave among the packages it depends on
(prod/peer) that also publish; a dependency that doesn't publish doesn't
count. So a wave's packages never depend on each other, and the waves are as
few as the dependency chains allow. Within a wave, packages follow config
order. `gro gitops_analyze` shows the same grouping over every package, as
dependency levels.

## Readiness

A step commits rewrites in dependents and names packages to publish, so it
reads each npm repo's state from the fetch and holds a repo unless it's ready:

- on the branch its registry entry follows, clean (untracked files count), and
  with no rebase, merge, or other operation in progress
- that branch in sync with origin, as the fetch just saw it, or ahead of it —
  not behind or diverged — and the fetch didn't fail
- no other live Claude Code session working in its checkout, and busy
  detection able to vouch for every session
- nothing `repos status` leaves to a person (`needs_human`: origin drift, a
  branch with no upstream, …)

The plan reads every repo as it sits, so one that isn't ready may hide a
changeset, and what it says of its package can't be trusted. Its dependents
are held with it: their rewrites to its version, and the publish of every
package depending on it for prod or peer, however deep. Their other
rewrites go ahead.

A held repo is named with what's wrong and the fix; the step never moves a
repo. `repos sync` fast-forwards what's behind; the rest (switching branch,
committing, stashing, or discarding changes, finishing a rebase) is yours.

A branch **ahead** of origin is ready: origin's tip is an ancestor, so the
plan misses nothing, and `gro publish`'s push is still a fast-forward that
carries those commits. The step's own rewrite commits leave a dependent ahead
this way; one that doesn't publish (a dev-only rewrite, a private or
never-published leaf) keeps them unpushed until `repos sync`, `repos push`, or
its next release.

The diagnostics (`gitops_plan`, `gitops_analyze`, `gitops_validate`) read the
same facts from local refs, without fetching, and print a readiness block as
warnings on stderr, naming each npm repo not at rest. They still run: a plan
over a feature branch is useful, it just isn't the release a step would make.

## Planning Algorithms

### One Pass in Dependency Order

The plan resolves the whole cascade in one pass over the prod/peer topological
order:

1. Each package's version after the release is its predicted one when it
   publishes, its current one otherwise.
2. Reaching a package, every dependency it has (prod/peer) is already settled,
   so its ranges' updates — and whether each is breaking — are final.
3. Its version change follows: its changesets' bump, escalated when its
   dependency updates require more, or an auto-changeset bump when it has no
   changesets and an update requires one.
4. After the pass, the dev-dependency updates are computed against the final
   versions, and the packages that publish are grouped into waves.

Production cycles are errors, so the order always exists when the plan has no
errors, and the pass needs no iteration.

### Cycle Detection Strategy

The system uses topological sort with dev dependency exclusion:

- **Production/peer cycles**: Block publishing (error, must be resolved)
  - These create impossible ordering: Package A depends on Package B which
    depends on Package A
  - Solution: Move one dependency to devDependencies or restructure
- **Dev cycles**: Allowed and normal (reported as info, not a warning)
  - Dev dependencies don't affect runtime, so cycles are safe
  - Topological sort excludes dev deps (`exclude_dev=true`) to break these
    cycles
- **Order**: Computed via topological sort on prod/peer deps only
  - Ensures dependencies publish before dependents
  - Deterministic and reproducible
- **Dependency priority**: When a package appears in multiple dependency types,
  production/peer takes priority over dev

This strategy enables practical multi-repo patterns (e.g., shared test
utilities) while preventing runtime dependency issues.

## Private Packages

Packages with `"private": true` in package.json never publish:

- Excluded from the plan's version changes and waves — no publish, bump
  escalation, or auto-changeset
- A private package depending on a released one is updated as a leaf: its
  dependency ranges are rewritten and committed without a changeset (it won't
  republish)
- A private package carrying its own changeset is flagged in the plan's warnings,
  since that changeset can't be published
- Dependents can still publish normally
- Use for internal tools, test utilities, dev-only packages, and sites

## Workflows

### Safe Validation Workflow

Before a release, validate your configuration:

```bash
# 1. Fetch, fast-forward what's behind, push what's ahead, so the checks read the canonical branches
repos sync

# 2. Run comprehensive validation (writes nothing in git)
gro gitops_validate

# 3. Review analyze output
gro gitops_analyze

# 4. Review the plan's waves
gro gitops_plan

# 5. Preview the first step (writes nothing)
gro gitops_release

# 6. Step the release
gro gitops_release --wetrun
```

### Output Formats

Save analysis or plans to files for review:

```bash
gro gitops_analyze --format json --outfile analysis.json
gro gitops_plan --format markdown --outfile plan.md
```

Without `--outfile`, a `--format json` or `markdown` report goes to stdout, and
so do `gitops_run --format json`'s results. In those modes everything meant for
a person goes to stderr instead: the task's log (the plan, the readiness block)
and gro's own lines after the task. Gro prints two lines before a task runs
(`[gitops_plan] invoking gitops_plan` and `[gitops_plan] → gitops_plan …`) that
the task can't reach, so they still lead stdout; use `--outfile` for a file
holding the document alone, or skip them when piping (`tail -n +3` at the
default log level).

## Examples

### Publishing a single package with changesets

```bash
# Create a changeset for your package
cd my-package
gro changeset
# Follow prompts to describe changes
git commit -m "add changeset"  # the step holds a repo with uncommitted changes

# See what the step would do
gro gitops_release
# Publish now (one 2FA window):
#   cd ../my-package && gro publish

cd ../my-package && gro publish

# Rewrite its dependents once it shows on the registry, and name the next wave
gro gitops_release --wetrun --wait
```

### Publishing a cascade

```bash
# You have changesets in @my/core; @my/ui depends on @my/core

gro gitops_plan
# Waves (each publishes together, after the ones above):
#   1. @my/core
#   2. @my/ui
#   [1/2] @my/core: 1.0.0 → 2.0.0 (major) BREAKING
#   [2/2] @my/ui: 1.5.0 → 2.0.0 (major) [auto-changeset] BREAKING
#         triggered by: @my/core (BREAKING)

gro gitops_release --wetrun   # names @my/core
# publish @my/core
gro gitops_release --wetrun --wait   # rewrites @my/ui with its changeset, names it
# publish @my/ui
gro gitops_release --wetrun --wait   # nothing to release
```

### Picking up a release

```bash
# A wave went out, but the step after it never ran — or a package was published by hand
gro gitops_release --wetrun
# The registry shows the released versions, so the dependents still trailing
# them are rewritten (with their auto-changesets), and the next wave is named.
```

### Bump escalation

```bash
# You created a patch changeset for @my/app
# But @my/core (dependency) has a breaking change

gro gitops_plan
# Output:
#   [1/2] @my/core: 1.0.0 → 2.0.0 (major) BREAKING
#   [2/2] @my/app: 2.0.0 → 3.0.0 (major) [patch → major] BREAKING
#         changesets specify patch, dependencies require major

# The step that rewrites @my/app's range writes the auto-changeset at major
# beside your patch one, so `gro publish` releases 3.0.0
```
