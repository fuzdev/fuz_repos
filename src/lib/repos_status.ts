/**
 * Schemas for the `repos status --json` document, the report the Rust
 * `repos` tool (`crates/fuz_repos`) prints, and the error document it prints
 * in place of the report on a fatal error.
 *
 * The schemas mirror the Rust types by hand, each named as its Rust type
 * prefixed `Repos` (`EntryStatus` is `ReposEntryStatus`), with fields as
 * serde writes them: snake_case, a tagged enum as an object whose `kind`
 * names its variant, an `Option` as `null` (never omitted), counts as
 * integers, and times as unix seconds. A flattened enum's `kind`
 * and payload sit beside its struct's own fields, so those structs are
 * unions here (`ReposUnregisteredClone`, `ReposStatusErrorBody`) — or, for
 * an enum with no payloads, an object whose `kind` is an enum
 * (`ReposProbeError`). Where a
 * Rust enum holds variants the status document never carries, the mirror
 * leaves them out: `ReposFetchFailure` has no push rejection, and
 * `ReposStatusErrorBody` holds only the errors `repos status --json` can
 * print.
 *
 * Every object is strict and every union closed, so a field or variant the
 * mirror doesn't know fails the parse. The Rust side bumps `version` on any
 * change to the document's shape; a consumer checks it first, and on a
 * mismatch reports both versions and how to install the binary this repo
 * builds (`cargo install --path crates/fuz_repos --locked`) rather than a
 * parse error.
 *
 * Drift is caught by the golden fixtures: a Rust test writes every status
 * document shape to `src/test/fixtures/repos_status/`, covering every
 * variant the status report and its error document can hold, and a TS test
 * parses each with these schemas. The field semantics live in the Rust
 * rustdoc and the JSON contract in `docs/repos.md`. The `repos sync --json`
 * and `repos push --json` documents have no TS consumer and aren't
 * mirrored here.
 *
 * @module
 */

import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

/**
 * The `repos status --json` document's format version, Rust's
 * `STATUS_FORMAT_VERSION`: the one these schemas parse.
 */
export const REPOS_STATUS_FORMAT_VERSION = 19;

// u32 and u64 on the Rust side
const Count = s.pipe(s.number, s.safe_integer, s.min_value(0));
const UnixSeconds = meta(Count, { description: 'a time in unix seconds' });

// --- sessions ---

/** Where a live Claude Code session was recorded. */
export const ReposSessionSource = s.one_of(['session_file', 'roster_worker']);
export type ReposSessionSource = s.Infer<typeof ReposSessionSource>;

/** A live Claude Code session: its process, and where it works. */
export const ReposSession = s.object({
	pid: Count,
	cwd: s.string,
	worktree: s.nullable(s.string),
	process_cwd: s.nullable(s.string),
	source: ReposSessionSource
});
export type ReposSession = s.Infer<typeof ReposSession>;

/** Why busy detection can't vouch for every live session. */
export const ReposUnavailable = s.variant('kind', [
	s.object({ kind: s.literal('home_unknown') }),
	s.object({ kind: s.literal('relative_config_dir'), path: s.string }),
	s.object({ kind: s.literal('unreadable'), path: s.string, error: s.string }),
	s.object({ kind: s.literal('unparseable'), path: s.string, error: s.string }),
	s.object({
		kind: s.literal('foreign_pid_domain'),
		path: s.string,
		pid_domain: s.string,
		source: ReposSessionSource
	})
]);
export type ReposUnavailable = s.Infer<typeof ReposUnavailable>;

/** Busy detection as the report carries it. */
export const ReposSessions = s.variant('kind', [
	s.object({ kind: s.literal('available'), unscoped: s.array(ReposSession) }),
	s.object({ kind: s.literal('unavailable'), reason: ReposUnavailable })
]);
export type ReposSessions = s.Infer<typeof ReposSessions>;

// --- registry ---

/** Which registry table an entry comes from. */
export const ReposEntryKind = s.one_of(['repo', 'reference']);
export type ReposEntryKind = s.Infer<typeof ReposEntryKind>;

/** A repo's declared visibility on its host. */
export const ReposVisibility = s.one_of(['public', 'private']);
export type ReposVisibility = s.Infer<typeof ReposVisibility>;

/** A repo's list of the sibling checkouts it uses. */
export const ReposCheckoutList = s.one_of(['requires', 'consults']);
export type ReposCheckoutList = s.Infer<typeof ReposCheckoutList>;

/** An entry by table and key. */
export const ReposEntryName = s.object({ kind: ReposEntryKind, key: s.string });
export type ReposEntryName = s.Infer<typeof ReposEntryName>;

/** A registry integrity rule broken. */
export const ReposRegistryIssue = s.variant('kind', [
	s.object({ kind: s.literal('repo_not_owned'), key: s.string, account: s.string }),
	s.object({ kind: s.literal('fork_not_owned'), key: s.string }),
	s.object({ kind: s.literal('dir_not_a_name'), entry: ReposEntryName, dir: s.string }),
	s.object({
		kind: s.literal('dir_claimed_twice'),
		dir: s.string,
		first: ReposEntryName,
		second: ReposEntryName
	}),
	s.object({ kind: s.literal('key_in_both'), key: s.string }),
	s.object({ kind: s.literal('key_is_other_dir'), key: s.string, entry: ReposEntryName }),
	s.object({
		kind: s.literal('unknown_checkout_ref'),
		key: s.string,
		field: ReposCheckoutList,
		target: s.string
	}),
	s.object({ kind: s.literal('self_ref'), key: s.string, field: ReposCheckoutList }),
	s.object({ kind: s.literal('requires_and_consults'), key: s.string, target: s.string })
]);
export type ReposRegistryIssue = s.Infer<typeof ReposRegistryIssue>;

// --- verdicts ---

/** What holds a branch's action back. */
export const ReposBranchHold = s.one_of([
	'pinned',
	'entry',
	'push_url',
	'fetch_failed',
	'dirty_checkout',
	'unprobed_worktree',
	'several_checkouts',
	'busy',
	'busy_unknown'
]);
export type ReposBranchHold = s.Infer<typeof ReposBranchHold>;

/** What holds a reference's refresh back. */
export const ReposRefreshHold = s.one_of(['pinned', 'entry', 'origin_not_https']);
export type ReposRefreshHold = s.Infer<typeof ReposRefreshHold>;

/** What holds a missing entry's clone back. */
export const ReposCloneHold = s.one_of(['entry', 'busy', 'unprobed_worktree']);
export type ReposCloneHold = s.Infer<typeof ReposCloneHold>;

/** What a run does about refreshing a third-party reference or a pin. */
export const ReposRefreshVerdict = s.variant('kind', [
	s.object({ kind: s.literal('act') }),
	s.object({ kind: s.literal('held'), by: ReposRefreshHold })
]);
export type ReposRefreshVerdict = s.Infer<typeof ReposRefreshVerdict>;

/** Whether a repo is at the entry's dir. */
export const ReposPresence = s.variant('kind', [
	s.object({ kind: s.literal('present') }),
	s.object({ kind: s.literal('missing') }),
	s.object({ kind: s.literal('not_a_repo') })
]);
export type ReposPresence = s.Infer<typeof ReposPresence>;

/** How sync would clone a missing entry. */
export const ReposCloneRecipe = s.object({
	url: s.string,
	branch: s.nullable(s.string),
	shallow: s.boolean,
	sparse: s.nullable(s.string)
});
export type ReposCloneRecipe = s.Infer<typeof ReposCloneRecipe>;

/** What sync does about a missing entry: clone it, or why not yet. */
export const ReposCloneVerdict = s.variant('kind', [
	s.object({ kind: s.literal('act'), recipe: ReposCloneRecipe }),
	s.object({ kind: s.literal('held'), recipe: ReposCloneRecipe, by: ReposCloneHold })
]);
export type ReposCloneVerdict = s.Infer<typeof ReposCloneVerdict>;

/** A sync action on a branch. */
export const ReposSyncAction = s.variant('kind', [
	s.object({ kind: s.literal('push'), commits: Count }),
	s.object({ kind: s.literal('fast_forward'), commits: Count }),
	s.object({ kind: s.literal('move') }),
	s.object({ kind: s.literal('rebase'), ahead: Count, behind: Count })
]);
export type ReposSyncAction = s.Infer<typeof ReposSyncAction>;

/** Why a branch is left to a person. */
export const ReposBranchNeedsHuman = s.one_of([
	'diverged',
	'diverged_published',
	'diverged_merge',
	'diverged_tagged',
	'unmapped',
	'archived_ahead',
	'shallow_local_work',
	'upstream_not_a_branch'
]);
export type ReposBranchNeedsHuman = s.Infer<typeof ReposBranchNeedsHuman>;

/** Why a branch reads as cleanup. */
export const ReposCleanupReason = s.one_of(['merged', 'upstream_gone']);
export type ReposCleanupReason = s.Infer<typeof ReposCleanupReason>;

/** What sync does about a branch. */
export const ReposVerdict = s.variant('kind', [
	s.object({ kind: s.literal('quiet') }),
	s.object({ kind: s.literal('act'), action: ReposSyncAction }),
	s.object({ kind: s.literal('held'), action: ReposSyncAction, by: ReposBranchHold }),
	s.object({ kind: s.literal('needs_human'), reason: ReposBranchNeedsHuman }),
	s.object({ kind: s.literal('local_only') }),
	s.object({
		kind: s.literal('cleanup'),
		reason: ReposCleanupReason,
		removable_worktree: s.nullable(s.string)
	})
]);
export type ReposVerdict = s.Infer<typeof ReposVerdict>;

// --- checkouts and branches ---

/** A clone's shape: shallow, sparse, or partial. */
export const ReposLayout = s.object({
	shallow: s.boolean,
	sparse: s.boolean,
	partial_filter: s.nullable(s.string)
});
export type ReposLayout = s.Infer<typeof ReposLayout>;

/**
 * A checkout's HEAD: a probed checkout's, an unprobed worktree's, or an
 * unlisted git dir's — the last two `null` when it can't be read.
 */
export const ReposHead = s.variant('kind', [
	s.object({ kind: s.literal('branch'), name: s.string }),
	s.object({ kind: s.literal('detached'), commit: s.string })
]);
export type ReposHead = s.Infer<typeof ReposHead>;

/** A checkout's uncommitted work, by kind. */
export const ReposUncommitted = s.object({
	staged: Count,
	unstaged: Count,
	untracked: Count,
	conflicted: Count
});
export type ReposUncommitted = s.Infer<typeof ReposUncommitted>;

/** A git operation in progress. */
export const ReposInProgressOp = s.one_of([
	'rebase',
	'merge',
	'cherry_pick',
	'revert',
	'bisect',
	'sequencer',
	'am'
]);
export type ReposInProgressOp = s.Infer<typeof ReposInProgressOp>;

/** One checkout of a repo: its primary, or a linked worktree probed. */
export const ReposCheckout = s.object({
	path: s.string,
	primary: s.boolean,
	head: ReposHead,
	uncommitted: ReposUncommitted,
	in_progress: s.nullable(ReposInProgressOp),
	locked: s.boolean,
	linked: s.boolean,
	submodules: s.nullable(s.boolean),
	busy: s.array(ReposSession)
});
export type ReposCheckout = s.Infer<typeof ReposCheckout>;

/** A branch's relation to its upstream. */
export const ReposRelation = s.variant('kind', [
	s.object({ kind: s.literal('in_sync') }),
	s.object({ kind: s.literal('ahead'), commits: Count }),
	s.object({ kind: s.literal('behind'), commits: Count }),
	s.object({ kind: s.literal('diverged'), ahead: Count, behind: Count }),
	s.object({ kind: s.literal('shallow') }),
	s.object({ kind: s.literal('gone') }),
	s.object({ kind: s.literal('unmapped') }),
	s.object({ kind: s.literal('untracked') })
]);
export type ReposRelation = s.Infer<typeof ReposRelation>;

/** One local branch and its verdict. */
export const ReposBranchStatus = s.object({
	name: s.string,
	upstream: s.nullable(s.string),
	worktree: s.nullable(s.string),
	symref: s.nullable(s.string),
	unique_commits: Count,
	newest_commit_at: UnixSeconds,
	relation: ReposRelation,
	verdict: ReposVerdict
});
export type ReposBranchStatus = s.Infer<typeof ReposBranchStatus>;

/** Whether an entry's primary checkout sits where the registry puts it. */
export const ReposAtRest = s.object({
	on_branch: s.nullable(s.boolean),
	clean: s.boolean,
	idle: s.boolean,
	followed: s.nullable(ReposRelation)
});
export type ReposAtRest = s.Infer<typeof ReposAtRest>;

// --- worktrees not probed ---

/** Why a worktree wasn't probed. */
export const ReposUnprobedWhy = s.variant('kind', [
	s.object({ kind: s.literal('prunable') }),
	s.object({ kind: s.literal('missing') }),
	s.object({ kind: s.literal('failed'), error: s.string })
]);
export type ReposUnprobedWhy = s.Infer<typeof ReposUnprobedWhy>;

/** What an unprobed worktree's git dir holds that a prune would lose. */
export const ReposGitDirHolds = s.object({
	submodules: s.boolean,
	worktree_refs: s.boolean,
	staged: s.nullable(s.boolean)
});
export type ReposGitDirHolds = s.Infer<typeof ReposGitDirHolds>;

/** What pruning an unprobed worktree would lose. */
export const ReposPruneLoss = s.variant('kind', [
	s.object({ kind: s.literal('operation'), op: ReposInProgressOp }),
	s.object({ kind: s.literal('detached_head') }),
	s.object({ kind: s.literal('unknown_head') }),
	s.object({ kind: s.literal('missing_branch'), name: s.string }),
	s.object({ kind: s.literal('submodules') }),
	s.object({ kind: s.literal('worktree_refs') }),
	s.object({ kind: s.literal('staged_changes') }),
	s.object({ kind: s.literal('unmatched_git_dir') }),
	s.object({ kind: s.literal('relative_gitdir'), git_dir: s.string })
]);
export type ReposPruneLoss = s.Infer<typeof ReposPruneLoss>;

/** Whether pruning an unprobed worktree is safe. */
export const ReposPrune = s.variant('kind', [
	s.object({ kind: s.literal('safe') }),
	s.object({ kind: s.literal('loses'), losses: s.array(ReposPruneLoss) }),
	s.object({ kind: s.literal('moved'), to: s.array(s.string) })
]);
export type ReposPrune = s.Infer<typeof ReposPrune>;

/** A worktree of the repo that couldn't be probed. */
export const ReposUnprobedWorktree = s.object({
	path: s.string,
	git_dir: s.nullable(s.string),
	head: meta(s.nullable(ReposHead), { description: 'null when its HEAD cannot be read' }),
	locked: s.boolean,
	in_progress: s.nullable(ReposInProgressOp),
	why: ReposUnprobedWhy,
	holds: s.nullable(ReposGitDirHolds)
});
export type ReposUnprobedWorktree = s.Infer<typeof ReposUnprobedWorktree>;

/** An unprobed worktree (flattened) with its prune verdict and live sessions. */
export const ReposUnprobedWorktreeStatus = s.object({
	...ReposUnprobedWorktree.def,
	prune: s.nullable(ReposPrune),
	busy: s.array(ReposSession)
});
export type ReposUnprobedWorktreeStatus = s.Infer<typeof ReposUnprobedWorktreeStatus>;

// --- remotes ---

/** The `origin` remote as git sees it, when it isn't the registry's `url`. */
export const ReposOriginRemote = s.variant('kind', [
	s.object({ kind: s.literal('url'), url: s.string }),
	s.object({ kind: s.literal('no_url') }),
	s.object({ kind: s.literal('missing') })
]);
export type ReposOriginRemote = s.Infer<typeof ReposOriginRemote>;

/** Why no `git remote` command fits an origin's fix. */
export const ReposOriginByHand = s.one_of([
	'outside_repo_file',
	'valueless_url',
	'empty_value',
	'several_urls'
]);
export type ReposOriginByHand = s.Infer<typeof ReposOriginByHand>;

/** How to point `origin` at the registry's URL. */
export const ReposOriginFix = s.variant('kind', [
	s.object({ kind: s.literal('add') }),
	s.object({ kind: s.literal('set_url') }),
	s.object({ kind: s.literal('by_hand'), reason: ReposOriginByHand })
]);
export type ReposOriginFix = s.Infer<typeof ReposOriginFix>;

/** Why a remote couldn't be reached. */
export const ReposUnreachableCause = s.one_of(['dns', 'connection', 'host_key', 'auth']);
export type ReposUnreachableCause = s.Infer<typeof ReposUnreachableCause>;

/** How to repair a fetch refspec naming a ref gone from origin. */
export const ReposRefGoneFix = s.variant('kind', [
	s.object({ kind: s.literal('unset_refspec'), pattern: s.string }),
	s.object({ kind: s.literal('set_branches'), branch: s.nullable(s.string) }),
	s.object({ kind: s.literal('by_hand') })
]);
export type ReposRefGoneFix = s.Infer<typeof ReposRefGoneFix>;

/**
 * Why a fetch or the visibility check failed, or why the tool refused to
 * fetch: Rust's `RemoteFailure` without `rejected`, which only a push meets.
 */
export const ReposFetchFailure = s.variant('kind', [
	s.object({ kind: s.literal('ref_gone'), refname: s.string, fix: ReposRefGoneFix }),
	s.object({
		kind: s.literal('unreachable'),
		cause: ReposUnreachableCause,
		message: s.string
	}),
	s.object({ kind: s.literal('repo_not_found'), message: s.string }),
	s.object({
		kind: s.literal('timed_out'),
		after_secs: meta(Count, { description: "the runner's timeout in seconds" })
	}),
	s.object({ kind: s.literal('failed'), message: s.string }),
	s.object({ kind: s.literal('refspec_outside_origin'), refspec: s.string }),
	s.object({
		kind: s.literal('origin_refs_shared'),
		remote: s.string,
		refspec: s.string
	}),
	s.object({ kind: s.literal('legacy_remotes_unreadable'), path: s.string })
]);
export type ReposFetchFailure = s.Infer<typeof ReposFetchFailure>;

/** What an anonymous read of a repo declared private found. */
export const ReposVisibilityCheck = s.variant('kind', [
	s.object({ kind: s.literal('leak') }),
	s.object({ kind: s.literal('private') }),
	s.object({ kind: s.literal('unknown'), failure: ReposFetchFailure })
]);
export type ReposVisibilityCheck = s.Infer<typeof ReposVisibilityCheck>;

// --- entries ---

/** What kind of failure stopped an entry's probe. */
export const ReposProbeErrorKind = s.one_of([
	'path_unreadable',
	'non_utf8_path',
	'config_unreadable',
	'fetch_url_unreadable',
	'push_urls_unreadable',
	'git_not_run',
	'git_timed_out',
	'git_failed',
	'unexpected_output'
]);
export type ReposProbeErrorKind = s.Infer<typeof ReposProbeErrorKind>;

/** Why an entry's probe failed: its kind, and a message for display. */
export const ReposProbeError = s.object({
	kind: ReposProbeErrorKind,
	message: s.string
});
export type ReposProbeError = s.Infer<typeof ReposProbeError>;

/** Why sync would stop on an entry and leave it to a person. */
export const ReposNeedsHuman = s.variant('kind', [
	s.object({ kind: s.literal('not_a_repo'), detail: s.string }),
	s.object({
		kind: s.literal('operation_in_progress'),
		checkout: s.string,
		op: ReposInProgressOp
	}),
	s.object({
		kind: s.literal('origin_mismatch'),
		origin: ReposOriginRemote,
		expected: s.string,
		fix: ReposOriginFix
	}),
	s.object({
		kind: s.literal('origin_not_https'),
		fetch_url: s.string,
		expected: s.string,
		fix: s.nullable(ReposOriginFix)
	}),
	s.object({
		kind: s.literal('fetch_url_mismatch'),
		fetch_url: s.string,
		expected: s.string,
		fix: s.nullable(ReposOriginFix)
	}),
	s.object({ kind: s.literal('worktree_unreadable'), path: s.string }),
	s.object({ kind: s.literal('default_branch_missing'), branch: s.string }),
	s.object({ kind: s.literal('default_branch_no_upstream'), branch: s.string }),
	s.object({ kind: s.literal('default_branch_gone'), branch: s.string }),
	s.object({ kind: s.literal('unexpected_detached'), checkout: s.string }),
	s.object({
		kind: s.literal('checkout_unresolvable'),
		checkout: s.string,
		path: s.string,
		error: s.string
	}),
	s.object({
		kind: s.literal('unlisted_git_dir'),
		git_dir: s.string,
		head: meta(s.nullable(ReposHead), { description: 'null when its HEAD cannot be read' }),
		busy: s.array(ReposSession)
	}),
	s.object({
		kind: s.literal('push_url_mismatch'),
		push_urls: s.array(s.string),
		expected: s.string
	}),
	s.object({ kind: s.literal('clone_shares_repo'), with: s.string }),
	s.object({ kind: s.literal('cloned_unregistered'), dir: s.string })
]);
export type ReposNeedsHuman = s.Infer<typeof ReposNeedsHuman>;

/** One registry entry's state. */
export const ReposEntryStatus = s.object({
	key: s.string,
	kind: ReposEntryKind,
	dir: s.string,
	url: s.string,
	writable: s.boolean,
	archived: s.boolean,
	visibility: s.nullable(ReposVisibility),
	ci: s.boolean,
	branch: s.nullable(s.string),
	pinned: s.boolean,
	refresh: s.nullable(ReposRefreshVerdict),
	presence: ReposPresence,
	clone: s.nullable(ReposCloneVerdict),
	layout: s.nullable(ReposLayout),
	checkouts: s.array(ReposCheckout),
	branches: s.array(ReposBranchStatus),
	at_rest: s.nullable(ReposAtRest),
	stashes: Count,
	fetched_at: s.nullable(UnixSeconds),
	needs_human: s.array(ReposNeedsHuman),
	probe_error: s.nullable(ReposProbeError),
	unprobed_worktrees: s.array(ReposUnprobedWorktreeStatus),
	fetch_error: s.nullable(ReposFetchFailure),
	visibility_check: s.nullable(ReposVisibilityCheck)
});
export type ReposEntryStatus = s.Infer<typeof ReposEntryStatus>;

// --- unregistered clones ---

/** What keeps a moved worktree's repair from being offered. */
export const ReposRepairBlock = s.variant('kind', [
	s.object({ kind: s.literal('rewrites'), path: s.string, git_dir: s.string }),
	s.object({ kind: s.literal('claimed_dir'), git_dir: s.string }),
	s.object({ kind: s.literal('swapped'), git_dir: s.string, with: s.string }),
	s.object({ kind: s.literal('relative_gitdir'), git_dir: s.string }),
	s.object({ kind: s.literal('unreadable_gitdir'), git_dir: s.string }),
	s.object({ kind: s.literal('non_utf8_path') }),
	s.object({ kind: s.literal('nul_in_gitdir'), git_dir: s.string })
]);
export type ReposRepairBlock = s.Infer<typeof ReposRepairBlock>;

// `UnregisteredClone`'s own fields, beside its flattened `UnregisteredKind`
const unregistered_clone_fields = {
	dir: s.string,
	origin: s.nullable(s.string),
	owned: s.boolean
};

/**
 * A child of the workspace root holding a `.git` that no registry entry
 * claims, its `kind` flattened beside its own fields.
 */
export const ReposUnregisteredClone = s.variant('kind', [
	s.object({ ...unregistered_clone_fields, kind: s.literal('clone') }),
	s.object({ ...unregistered_clone_fields, kind: s.literal('worktree') }),
	s.object({
		...unregistered_clone_fields,
		kind: s.literal('moved_worktree'),
		entry: s.string,
		blocked_by: s.nullable(ReposRepairBlock),
		exit_noise: s.nullable(s.string)
	}),
	s.object({
		...unregistered_clone_fields,
		kind: s.literal('orphaned_worktree'),
		entry: s.string
	}),
	s.object({
		...unregistered_clone_fields,
		kind: s.literal('shared_git_dir'),
		entry: s.string,
		with: s.nullable(s.string)
	}),
	s.object({ ...unregistered_clone_fields, kind: s.literal('unfinished_clone') })
]);
export type ReposUnregisteredClone = s.Infer<typeof ReposUnregisteredClone>;

// --- the documents ---

/** The `repos status --json` report. */
export const ReposStatusReport = s.object({
	version: s.literal(REPOS_STATUS_FORMAT_VERSION),
	workspace: s.string,
	registry: s.string,
	fetched: s.boolean,
	sessions: ReposSessions,
	entries: s.array(ReposEntryStatus),
	unregistered: meta(s.nullable(s.array(ReposUnregisteredClone)), {
		description: 'null when the scan did not run (a run with targets)'
	})
});
export type ReposStatusReport = s.Infer<typeof ReposStatusReport>;

// `ErrorBody`'s own fields, beside its flattened `ErrorKind`
const error_body_fields = {
	message: s.string,
	hint: s.nullable(s.string)
};

/**
 * A fatal error as `repos status --json` prints it, its `kind` flattened
 * beside `message` and `hint`. Only the kinds `status` can print: the rest
 * of Rust's `ErrorKind` are `repos push`'s, or precede knowing `--json`.
 */
export const ReposStatusErrorBody = s.variant('kind', [
	s.object({ ...error_body_fields, kind: s.literal('references_with_targets') }),
	s.object({ ...error_body_fields, kind: s.literal('root_not_found') }),
	s.object({ ...error_body_fields, kind: s.literal('registry_not_found') }),
	s.object({ ...error_body_fields, kind: s.literal('root_in_entry'), key: s.string }),
	s.object({ ...error_body_fields, kind: s.literal('registry_read') }),
	s.object({ ...error_body_fields, kind: s.literal('registry_parse') }),
	s.object({
		...error_body_fields,
		kind: s.literal('registry_invalid'),
		issues: s.array(ReposRegistryIssue)
	}),
	s.object({ ...error_body_fields, kind: s.literal('git_not_found') }),
	s.object({
		...error_body_fields,
		kind: s.literal('git_too_old'),
		found: s.string,
		required: s.string
	}),
	s.object({
		...error_body_fields,
		kind: s.literal('unknown_entry'),
		name: s.string,
		suggestions: s.array(s.string)
	}),
	s.object({ ...error_body_fields, kind: s.literal('io') })
]);
export type ReposStatusErrorBody = s.Infer<typeof ReposStatusErrorBody>;

/** The document `repos status --json` prints on a fatal error, in place of the report. */
export const ReposStatusErrorReport = s.object({
	version: s.literal(REPOS_STATUS_FORMAT_VERSION),
	error: ReposStatusErrorBody
});
export type ReposStatusErrorReport = s.Infer<typeof ReposStatusErrorReport>;

/**
 * Either document `repos status --json` prints. No tag is needed: `error`
 * is the error document's alone, and each side's strictness refuses the
 * other's fields. A consumer wanting a sharper parse error branches on
 * `error` first and parses with that side's schema.
 */
export const ReposStatusDocument = s.union([ReposStatusReport, ReposStatusErrorReport]);
export type ReposStatusDocument = s.Infer<typeof ReposStatusDocument>;
