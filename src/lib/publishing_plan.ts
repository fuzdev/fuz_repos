/**
 * The publishing plan: what a release of the configured packages publishes,
 * in what versions, and the dependency rewrites that go with it.
 *
 * `generate_publishing_plan` resolves the whole cascade in one pass over the
 * prod/peer topological order — explicit changesets, bump escalations a
 * breaking dependency forces, and auto-generated changesets for dependents —
 * then groups the packages that publish into waves: a wave's packages don't
 * depend on each other, so they publish together.
 *
 * The plan reads each package as its checkout sits. Given what the registry
 * shows (`GeneratePlanOptions.registry`), it also accounts for releases already
 * made: a package whose current version is out counts as released, and a
 * dependent whose range still trails it gets the rewrite it missed.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { styleText as st } from 'node:util';

import { repo_is_npm, type LocalRepo } from './local_repo.ts';
import { validate_dependency_graph } from './graph_validation.ts';
import { group_into_levels, to_rank, type DependencyGraph } from './dependency_graph.ts';
import {
	type BumpType,
	is_breaking_change,
	compare_bump_types,
	calculate_next_version,
	required_bump_for_dependency_update
} from './version_utils.ts';
import type { ChangesetOperations } from './operations.ts';
import type { RegistryVersion } from './npm_registry.ts';
import { default_changeset_operations } from './operations_defaults.ts';
import { calculate_dependency_updates, to_dependency_updates } from './publishing_plan_helpers.ts';

export interface VersionChange {
	package_name: string;
	from: string;
	to: string;
	bump_type: BumpType;
	breaking: boolean;
	has_changesets: boolean;
	will_generate_changeset?: boolean; // True if changeset will be auto-generated for dependency updates
	needs_bump_escalation?: boolean; // True if existing changesets need escalation for dependencies
	existing_bump?: BumpType; // The bump type from existing changesets
	required_bump?: BumpType; // The required bump type from dependencies
}

/**
 * How a version change arises in the plan: from the package's own changesets
 * (`explicit`), from its changesets with the bump raised to what a breaking
 * dependency requires (`escalation`), or from a changeset generated for a
 * dependency update (`auto`).
 */
export type VersionChangeKind = 'explicit' | 'escalation' | 'auto';

/**
 * Classifies a version change — the one classification the plan's logger,
 * markdown, and release step share. A change without changesets of its own is
 * `auto` even if its bump was raised.
 */
export const version_change_kind = (change: VersionChange): VersionChangeKind =>
	!change.has_changesets ? 'auto' : change.needs_bump_escalation ? 'escalation' : 'explicit';

/** A dependency range that moves to name its dependency's version after the release. */
export interface DependencyUpdate {
	dependent_package: string;
	updated_dependency: string;
	/** The range as the dependent's `package.json` has it. */
	current_version: string;
	/** The dependency's version after the release. */
	new_version: string;
	type: 'dependencies' | 'devDependencies' | 'peerDependencies';
	/** Whether the move from the range's base version is breaking. */
	breaking: boolean;
}

/** A package whose current version the registry doesn't show, with no changesets to publish. */
export interface AwaitingRegistry {
	name: string;
	version: string;
}

// Verbose data types for diagnostic output
export interface VerboseChangesetDetail {
	package_name: string;
	files: Array<{ filename: string; bump_type: BumpType; summary: string }>;
}

/** A breaking package and the direct prod/peer dependents its release rewrites. */
export interface VerbosePropagation {
	source: string;
	dependents: Array<{ pkg: string; dep_type: 'prod' | 'peer'; action: string }>;
}

export interface VerboseGraphSummary {
	package_count: number;
	internal_dep_count: number;
	prod_peer_edges: Array<{ from: string; to: string; type: 'prod' | 'peer' }>;
	dev_edges: Array<{ from: string; to: string }>;
	prod_cycle_count: number;
	dev_cycle_count: number;
}

export interface VerboseData {
	changeset_details: Array<VerboseChangesetDetail>;
	propagations: Array<VerbosePropagation>;
	graph_summary: VerboseGraphSummary;
}

export interface PublishingPlan {
	/**
	 * The packages that publish, grouped by their longest prod/peer path to
	 * other packages that publish: a wave's packages depend only on earlier
	 * waves, never on each other, so each wave publishes together. In config
	 * order within a wave.
	 */
	waves: Array<Array<string>>;
	version_changes: Array<VersionChange>;
	dependency_updates: Array<DependencyUpdate>;
	breaking_cascades: Map<string, Array<string>>;
	/**
	 * Packages whose current version the registry doesn't show, with no
	 * changesets: just published and still propagating, or a publish that
	 * failed. A package the registry has never seen is here too when another
	 * configured package has a prod/peer range on it — a first publish npm
	 * answers E404 for until it shows. Empty without registry observations.
	 */
	awaiting_registry: Array<AwaitingRegistry>;
	/**
	 * Packages the registry has never seen, with no changesets of their own and
	 * no configured package depending on them for prod or peer — apps or sites
	 * that never publish, most likely, which `private` would say. Like private
	 * packages they're update-only leaves: no auto-bump, and no range moves for
	 * them. Empty without registry observations.
	 */
	never_published: Array<string>;
	warnings: Array<string>;
	/** Informational sentences, not warnings: excluded non-npm repos, dev dependency cycles. */
	info: Array<string>;
	/** Package names with no changesets and no version change — nothing to publish. */
	no_changes: Array<string>;
	errors: Array<string>;
	verbose_data?: VerboseData;
}

export interface GeneratePlanOptions {
	log?: Logger;
	ops?: ChangesetOperations;
	verbose?: boolean;
	/**
	 * What the registry shows for each package's current version, by name. With
	 * no changesets, an `unlisted` one is `awaiting_registry`, and so is an
	 * `unknown` one some package depends on for prod or peer; any other
	 * `unknown` one is `never_published`. Without it, every current version
	 * counts as released.
	 */
	registry?: ReadonlyMap<string, RegistryVersion>;
}

/**
 * Generates the publishing plan in one pass over the prod/peer topological
 * order. Each package's dependencies are settled before it is reached, so its
 * required bump — from its prod/peer ranges against each dependency's version
 * after the release — is final when computed: explicit changesets, escalation,
 * or an auto-changeset, with no iteration.
 *
 * Every package's version after the release is its predicted one when it
 * publishes and its current one otherwise, so a dependent whose range trails a
 * dependency's current version gets that rewrite too, along with the bump it
 * implies.
 */
export const generate_publishing_plan = async (
	all_repos: Array<LocalRepo>,
	options: GeneratePlanOptions = {}
): Promise<PublishingPlan> => {
	const { log, ops = default_changeset_operations, verbose = false, registry } = options;
	log?.info(st('cyan', 'Generating publishing plan...'));

	const warnings: Array<string> = [];
	const info: Array<string> = [];
	const errors: Array<string> = [];

	// Publishing concerns only npm packages. Non-npm repos (e.g. Rust cargo repos) are
	// loaded for the dashboard but have no npm identity in the changeset cascade — drop them
	// before building the graph so they never appear in the plan.
	const non_npm_repos = all_repos.filter((r) => !repo_is_npm(r));
	if (non_npm_repos.length > 0) {
		info.push(
			`Excluded ${non_npm_repos.length} non-npm repo(s) from publishing: ` +
				non_npm_repos.map((r) => r.library.name).join(', ')
		);
	}
	const repos = all_repos.filter(repo_is_npm);

	// Build dependency graph and validate; cycles and a failed sort are reported, never thrown
	const validation = validate_dependency_graph(repos);
	const { order, production_cycles, dev_cycles, graph } = validation;
	if (validation.sort_error) {
		errors.push(validation.sort_error);
	}
	for (const cycle of production_cycles) {
		errors.push(`Production dependency cycle: ${cycle.join(' → ')}`);
	}
	// Dev cycles are shown in gitops_analyze, not repeated here
	if (dev_cycles.length > 0) {
		info.push(
			`${dev_cycles.length} dev dependency cycle(s) detected (normal, shown in gitops_analyze)`
		);
	}

	const changeset_presence: Map<string, ChangesetPresence> = new Map(
		await Promise.all(
			repos.map(async (repo) => [repo.library.name, await ops.has_changesets({ repo })] as const)
		)
	);
	const repo_by_name: Map<string, LocalRepo> = new Map(repos.map((r) => [r.library.name, r]));
	// one the registry has never seen that some package depends on is a first publish
	// still propagating (npm answers E404 until it shows), or one that failed: never an app
	const prod_peer_dependencies: Set<string> = new Set(
		order.flatMap((name) => graph.get_prod_peer_dependencies(name))
	);

	// each package's version after the release: predicted when it publishes, else current
	const targets: Map<string, string> = new Map();
	const changes: Map<string, VersionChange> = new Map();
	const version_changes: Array<VersionChange> = [];
	const awaiting_registry: Array<AwaitingRegistry> = [];
	const never_published: Array<string> = [];
	const repos_without_bump: Array<LocalRepo> = [];
	const changeset_details: Array<VerboseChangesetDetail> = [];

	for (const name of order) {
		const repo = repo_by_name.get(name);
		if (!repo) continue;
		const current = repo.package_json.version || '0.0.0';
		const presence = changeset_presence.get(name);
		const has_own_changesets = presence?.ok === true && presence.value;

		// Private packages never publish: no version change, and no target, so their
		// dependents never move for them. Their own ranges still update (an update-only leaf).
		if (repo.package_json.private) {
			if (has_own_changesets) {
				warnings.push(`${name} is private — its changeset(s) will not be published`);
			}
			continue;
		}

		let explicit: { version: string; bump_type: BumpType } | null = null;
		if (presence && !presence.ok) {
			errors.push(`Failed to check changesets for ${name}: ${presence.message}`);
		} else if (has_own_changesets) {
			const prediction = await ops.predict_next_version({ repo, log });
			if (!prediction) {
				// changeset files exist, but none yields a bump for this package
				repos_without_bump.push(repo);
			} else if (!prediction.ok) {
				errors.push(`Failed to predict version for ${name}: ${prediction.message}`);
			} else {
				explicit = { version: prediction.version, bump_type: prediction.bump_type };
				if (verbose) {
					const detail = await read_changeset_detail(repo, prediction.bump_type, ops, log);
					if (detail) changeset_details.push(detail);
				}
			}
		}

		// every prod/peer dependency precedes this package in `order`, so its target is final
		const updates = to_dependency_updates(repo, targets, changes, [
			'dependencies',
			'peerDependencies'
		]);

		// what the registry shows matters only for a current version with nothing to publish over it
		const shown = has_own_changesets ? undefined : registry?.get(name);
		if (shown === 'unknown' && !prod_peer_dependencies.has(name)) {
			// never published and nothing of its own to publish — an app or site, most likely: an
			// update-only leaf like a private package, with no auto-bump to schedule a first publish,
			// and no target, so no dependent's range moves to a version that was never published
			never_published.push(name);
			continue;
		}
		const change = to_version_change(name, current, explicit, to_required_bump(current, updates));
		if (change) {
			version_changes.push(change);
			changes.set(name, change);
			targets.set(name, change.to);
		} else {
			targets.set(name, current);
		}
		if (shown === 'unlisted' || shown === 'unknown') {
			awaiting_registry.push({ name, version: current });
		}
	}

	// Worded once the cascade settled whether each such repo publishes
	for (const repo of repos_without_bump) {
		warnings.push(
			await describe_changesets_without_bump(repo, changes.has(repo.library.name), ops)
		);
	}

	// the final updates over every section, in config order; the prod/peer ones match the pass
	const { dependency_updates, breaking_cascades } = calculate_dependency_updates(
		repos,
		targets,
		changes
	);

	const waves = group_into_levels(
		order,
		(name) => graph.get_prod_peer_dependencies(name),
		new Set(changes.keys()),
		to_rank(repos.map((r) => r.library.name))
	);

	const not_out = new Set([...awaiting_registry.map((a) => a.name), ...never_published]);
	const no_changes: Array<string> = [];
	for (const repo of repos) {
		const name = repo.library.name;
		if (changes.has(name) || not_out.has(name)) continue;
		const presence = changeset_presence.get(name);
		if (presence?.ok && !presence.value) {
			no_changes.push(name);
		}
	}

	const verbose_data = verbose
		? plan_verbose_data({
				graph,
				version_changes,
				dependency_updates,
				breaking_cascades,
				changeset_details,
				prod_cycle_count: production_cycles.length,
				dev_cycle_count: dev_cycles.length
			})
		: undefined;

	return {
		waves,
		version_changes,
		dependency_updates,
		breaking_cascades,
		awaiting_registry,
		never_published,
		warnings,
		info,
		no_changes,
		errors,
		verbose_data
	};
};

type ChangesetPresence = Awaited<ReturnType<ChangesetOperations['has_changesets']>>;

/** The bump a package's prod/peer updates require, or `null` with none. */
const to_required_bump = (
	current: string,
	updates: ReadonlyArray<DependencyUpdate>
): BumpType | null =>
	updates.length > 0
		? required_bump_for_dependency_update(
				current,
				updates.some((u) => u.breaking)
			)
		: null;

/**
 * A package's version change from its own changesets (`explicit`) and the bump
 * its dependency updates require: the changesets' bump, escalated when the
 * required one is larger, or an auto-changeset bump when it has none.
 *
 * @returns the change, or `null` when the package has neither
 */
const to_version_change = (
	package_name: string,
	from: string,
	explicit: { version: string; bump_type: BumpType } | null,
	required: BumpType | null
): VersionChange | null => {
	if (explicit) {
		if (required && compare_bump_types(required, explicit.bump_type) > 0) {
			return {
				package_name,
				from,
				to: calculate_next_version(from, required),
				bump_type: required,
				breaking: is_breaking_change(from, required),
				has_changesets: true,
				needs_bump_escalation: true,
				existing_bump: explicit.bump_type,
				required_bump: required
			};
		}
		return {
			package_name,
			from,
			to: explicit.version,
			bump_type: explicit.bump_type,
			breaking: is_breaking_change(from, explicit.bump_type),
			has_changesets: true
		};
	}
	if (!required) return null;
	return {
		package_name,
		from,
		to: calculate_next_version(from, required),
		bump_type: required,
		breaking: is_breaking_change(from, required),
		has_changesets: false,
		will_generate_changeset: true
	};
};

/** The changeset files naming a package, for verbose output. */
const read_changeset_detail = async (
	repo: LocalRepo,
	predicted_bump: BumpType,
	ops: ChangesetOperations,
	log: Logger | undefined
): Promise<VerboseChangesetDetail | null> => {
	const pkg_name = repo.library.name;
	const read = await ops.read_changesets({ repo, log });
	if (!read.ok) return null;
	const files = read.value
		.filter((cs) => cs.packages.some((p) => p.name === pkg_name))
		.map((cs) => ({
			filename: cs.filename,
			bump_type: cs.packages.find((p) => p.name === pkg_name)?.bump_type ?? predicted_bump,
			summary: cs.summary
		}));
	return files.length > 0 ? { package_name: pkg_name, files } : null;
};

/**
 * Words the warning for a repo whose changeset files yield no bump for its
 * package. It takes no bump from them: it publishes only as the auto-generated
 * change a dependency update requires, and otherwise not at all.
 *
 * @param publishes - whether the settled plan has a version change for the repo
 */
const describe_changesets_without_bump = async (
	repo: LocalRepo,
	publishes: boolean,
	ops: ChangesetOperations
): Promise<string> => {
	const pkg_name = repo.library.name;
	const consequence = publishes
		? 'it takes no bump from them and publishes only as the auto-generated change a dependency update requires'
		: 'it will not publish';
	// no `log`: `predict_next_version` already logged any invalid files
	const read = await ops.read_changesets({ repo });
	if (!read.ok) {
		return `${pkg_name} has changeset files that could not be read (${read.message}) — ${consequence}`;
	}
	if (read.value.length === 0) {
		return `${pkg_name} has changeset files, but none parses — ${consequence}; check their frontmatter`;
	}
	return (
		`${pkg_name} has changeset files, but none that parses names ${pkg_name} — ${consequence}; ` +
		`check the package names in their frontmatter`
	);
};

interface PlanVerboseDataOptions {
	graph: DependencyGraph;
	version_changes: Array<VersionChange>;
	dependency_updates: Array<DependencyUpdate>;
	breaking_cascades: Map<string, Array<string>>;
	changeset_details: Array<VerboseChangesetDetail>;
	prod_cycle_count: number;
	dev_cycle_count: number;
}

/**
 * Assembles the verbose diagnostics: propagation chains from the breaking
 * cascades and a summary of the dependency graph, beside the changeset
 * details the pass collected.
 */
const plan_verbose_data = (options: PlanVerboseDataOptions): VerboseData => {
	const { graph, version_changes, dependency_updates, breaking_cascades } = options;

	// Each breaking source with its direct dependents, from breaking_cascades
	const propagations: Array<VerbosePropagation> = [];
	for (const [source, affected] of breaking_cascades) {
		const dependents: VerbosePropagation['dependents'] = [];
		for (const pkg of affected) {
			const update = dependency_updates.find(
				(u) => u.dependent_package === pkg && u.updated_dependency === source
			);
			const dep_type: 'prod' | 'peer' = update?.type === 'peerDependencies' ? 'peer' : 'prod';
			const version_change = version_changes.find((vc) => vc.package_name === pkg);
			const kind = version_change && version_change_kind(version_change);
			const action =
				kind === 'auto' ? 'auto-changeset' : kind === 'escalation' ? 'bump escalation' : 'update';
			dependents.push({ pkg, dep_type, action });
		}
		if (dependents.length > 0) {
			propagations.push({ source, dependents });
		}
	}

	// Build graph summary
	const prod_peer_edges: Array<{ from: string; to: string; type: 'prod' | 'peer' }> = [];
	const dev_edges: Array<{ from: string; to: string }> = [];
	let internal_dep_count = 0;

	for (const [pkg_name, node] of graph.nodes) {
		for (const [dep_name, spec] of node.dependencies) {
			// Only count internal dependencies (deps that are also in the graph)
			if (graph.nodes.has(dep_name)) {
				internal_dep_count++;
				if (spec.type === 'dev') {
					dev_edges.push({ from: pkg_name, to: dep_name });
				} else {
					prod_peer_edges.push({
						from: pkg_name,
						to: dep_name,
						type: spec.type === 'peer' ? 'peer' : 'prod'
					});
				}
			}
		}
	}

	return {
		changeset_details: options.changeset_details,
		propagations,
		graph_summary: {
			package_count: graph.nodes.size,
			internal_dep_count,
			prod_peer_edges,
			dev_edges,
			prod_cycle_count: options.prod_cycle_count,
			dev_cycle_count: options.dev_cycle_count
		}
	};
};
