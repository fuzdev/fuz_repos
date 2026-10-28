/**
 * Where a release stands, derived from observed state: the plan made with
 * what the registry shows (`generate_publishing_plan`'s `registry` option)
 * and each repo's readiness. `gitops_release` derives it each time it runs,
 * applies the rewrites, and names the packages to publish, so a release
 * proceeds in steps with no state of its own between them.
 *
 * A dependency is **released** when it has nothing left to publish and the
 * registry shows its current version: dependents' ranges can move to it now,
 * and their installs will find it. A package publishes **now** when it's in
 * the plan's first wave, depends (prod/peer) on no package still awaiting the
 * registry, and its repo is ready.
 *
 * The plan reads every repo as it sits, so a repo that isn't ready — behind
 * origin, off its branch, dirty — may hide a changeset, and what it says of
 * its package can't be trusted. Its dependents are held too: a rewrite to its
 * version, and the publish of every package depending on it for prod or peer,
 * however deep.
 *
 * Pure — the plan, the repos, and their readiness in; the step out.
 *
 * @module
 */

import type { LocalRepo } from './local_repo.ts';
import type { DependencyUpdate, PublishingPlan } from './publishing_plan.ts';

/** One dependent's rewrite: its ranges for released dependencies, in one commit. */
export interface ReleaseRewrite {
	/** The dependent's package name. */
	name: string;
	updates: Array<DependencyUpdate>;
	/** Whether the dependent republishes, so its prod/peer updates go in its auto-changeset. */
	changeset: boolean;
}

/** A rewrite or publish that waits, and why. */
export interface ReleaseHeld {
	/** The held package's name. */
	name: string;
	/** Why it waits, each a line naming the fix. */
	reasons: Array<string>;
}

export interface ReleaseState {
	/** Rewrites whose dependencies are released and whose repos are ready. */
	rewrites: Array<ReleaseRewrite>;
	/** Rewrites whose dependencies are released but whose repos aren't ready. */
	rewrites_held: Array<ReleaseHeld & { updates: Array<DependencyUpdate> }>;
	/** Packages to publish now, in dependency order: the first wave's ready ones. */
	publish_now: Array<string>;
	/** The first wave's packages that can't publish yet, and why. */
	publish_held: Array<ReleaseHeld>;
	/** Nothing left to publish, rewrite, or wait for. */
	done: boolean;
}

export interface ToReleaseStateOptions {
	/** The plan, generated with registry observations. */
	plan: PublishingPlan;
	/** The configured npm repos, as loaded. */
	repos: ReadonlyArray<LocalRepo>;
	/**
	 * Why each repo isn't ready to be written or published, by package name: a
	 * repo absent or with no reasons is ready. Its dependents are held with it.
	 */
	not_ready: ReadonlyMap<string, ReadonlyArray<string>>;
	/** Problems with the whole report, which hold every repo. */
	held_all?: ReadonlyArray<string>;
}

/**
 * Derives the release step from the plan and each repo's readiness.
 */
export const to_release_state = (options: ToReleaseStateOptions): ReleaseState => {
	const { plan, repos, not_ready, held_all = [] } = options;
	const pending: Set<string> = new Set(plan.version_changes.map((vc) => vc.package_name));
	const awaiting: Map<string, string> = new Map(
		plan.awaiting_registry.map((a) => [a.name, a.version])
	);
	const reasons_for = (name: string): Array<string> => [
		...held_all,
		...(not_ready.get(name) ?? [])
	];
	const repo_by_name: Map<string, LocalRepo> = new Map(repos.map((r) => [r.library.name, r]));
	const untrusted_dependencies = create_untrusted_dependencies(repo_by_name, not_ready);

	// group the released dependencies' updates by dependent, in the plan's order; a
	// dependency whose repo isn't ready may not be released, so its updates wait apart
	const by_dependent: Map<
		string,
		{ released: Array<DependencyUpdate>; untrusted: Array<DependencyUpdate> }
	> = new Map();
	for (const update of plan.dependency_updates) {
		const dep = update.updated_dependency;
		if (pending.has(dep) || awaiting.has(dep)) continue;
		let entry = by_dependent.get(update.dependent_package);
		if (!entry) {
			entry = { released: [], untrusted: [] };
			by_dependent.set(update.dependent_package, entry);
		}
		(not_ready.has(dep) ? entry.untrusted : entry.released).push(update);
	}

	const rewrites: Array<ReleaseRewrite> = [];
	const rewrites_held: ReleaseState['rewrites_held'] = [];
	for (const [name, { released, untrusted }] of by_dependent) {
		const untrusted_reasons = [...new Set(untrusted.map((u) => u.updated_dependency))].map(
			to_untrusted_reason
		);
		const reasons = reasons_for(name);
		if (reasons.length > 0) {
			rewrites_held.push({
				name,
				reasons: [...reasons, ...untrusted_reasons],
				updates: [...released, ...untrusted]
			});
			continue;
		}
		if (released.length > 0) {
			const changeset = pending.has(name) && released.some((u) => u.type !== 'devDependencies');
			rewrites.push({ name, updates: released, changeset });
		}
		if (untrusted.length > 0) {
			rewrites_held.push({ name, reasons: untrusted_reasons, updates: untrusted });
		}
	}

	const publish_now: Array<string> = [];
	const publish_held: Array<ReleaseHeld> = [];
	for (const name of plan.waves[0] ?? []) {
		const reasons: Array<string> = [];
		const repo = repo_by_name.get(name);
		for (const dep of to_prod_peer_dependency_names(repo)) {
			const version = awaiting.get(dep);
			if (version !== undefined) {
				reasons.push(`waiting for ${dep}@${version} to show on the registry`);
			}
		}
		reasons.push(...reasons_for(name));
		reasons.push(...untrusted_dependencies(name).map(to_untrusted_reason));
		if (reasons.length > 0) publish_held.push({ name, reasons });
		else publish_now.push(name);
	}

	const done =
		plan.version_changes.length === 0 &&
		plan.awaiting_registry.length === 0 &&
		by_dependent.size === 0;

	return { rewrites, rewrites_held, publish_now, publish_held, done };
};

const to_prod_peer_dependency_names = (repo: LocalRepo | undefined): Array<string> =>
	repo ? [...(repo.dependencies?.keys() ?? []), ...(repo.peer_dependencies?.keys() ?? [])] : [];

const to_untrusted_reason = (dep: string): string =>
	`${dep}'s repo isn't ready, so whether it has more to publish can't be read — see its hold`;

/**
 * Each package's prod/peer dependencies, direct or deeper, whose repos aren't
 * ready, as a lookup memoized over the configured packages. A cycle (a plan
 * error, so never reached by a step) ends the walk rather than looping.
 */
const create_untrusted_dependencies = (
	repo_by_name: ReadonlyMap<string, LocalRepo>,
	not_ready: ReadonlyMap<string, ReadonlyArray<string>>
): ((name: string) => Array<string>) => {
	const memo: Map<string, Array<string>> = new Map();
	const visit = (name: string): Array<string> => {
		const cached = memo.get(name);
		if (cached) return cached;
		const found: Array<string> = [];
		memo.set(name, found); // a cycle reads this partial list
		for (const dep of to_prod_peer_dependency_names(repo_by_name.get(name))) {
			if (!repo_by_name.has(dep)) continue;
			if (not_ready.has(dep) && !found.includes(dep)) found.push(dep);
			for (const deeper of visit(dep)) if (!found.includes(deeper)) found.push(deeper);
		}
		return found;
	};
	return visit;
};
