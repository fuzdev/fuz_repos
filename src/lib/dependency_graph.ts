/**
 * Dependency graph data structure and algorithms for multi-repo publishing.
 *
 * Provides the `DependencyGraph` class, built from local repos, with topological sort
 * (via `@fuzdev/fuz_util/sort.ts`), grouping into levels, cycle detection by
 * dependency type, and wildcard-range analysis.
 * For the order, the levels, and the analysis workflow, see `graph_validation.ts`.
 *
 * @module
 */

import { EMPTY_OBJECT } from '@fuzdev/fuz_util/object.ts';
import { topological_sort as topological_sort_generic } from '@fuzdev/fuz_util/sort.ts';

import type { LocalRepo } from './local_repo.ts';

export const DEPENDENCY_TYPE = {
	PROD: 'prod',
	PEER: 'peer',
	DEV: 'dev'
} as const;

export type DependencyType = (typeof DEPENDENCY_TYPE)[keyof typeof DEPENDENCY_TYPE];

export interface DependencySpec {
	type: DependencyType;
	version: string;
}

export interface DependencyGraphJson {
	nodes: Array<{
		name: string;
		version: string;
		dependencies: Array<{ name: string; spec: DependencySpec }>;
		dependents: Array<string>;
	}>;
	edges: Array<{ from: string; to: string }>;
}

export interface DependencyNode {
	name: string;
	version: string;
	dependencies: Map<string, DependencySpec>;
	dependents: Set<string>;
}

/** Cycles and wildcard dependencies found by `DependencyGraph.analyze`. */
export interface DependencyAnalysis {
	production_cycles: Array<Array<string>>;
	dev_cycles: Array<Array<string>>;
	wildcard_deps: Array<{ pkg: string; dep: string; version: string }>;
}

export class DependencyGraph {
	nodes: Map<string, DependencyNode> = new Map();
	edges: Map<string, Set<string>> = new Map(); // pkg -> dependents

	/**
	 * Builds the graph from local repos.
	 *
	 * Two passes: first creates nodes, then builds edges (dependents).
	 * Prioritizes prod/peer deps over dev deps when the same package appears in
	 * multiple dependency types (the stronger constraint wins).
	 */
	constructor(repos: Array<LocalRepo>) {
		// first pass: create nodes
		for (const repo of repos) {
			const { library, package_json } = repo;
			const node: DependencyNode = {
				name: library.name,
				version: package_json.version || '0.0.0',
				dependencies: new Map(),
				dependents: new Set()
			};

			const deps = package_json.dependencies || (EMPTY_OBJECT as Record<string, string>);
			const dev_deps = package_json.devDependencies || (EMPTY_OBJECT as Record<string, string>);
			const peer_deps = package_json.peerDependencies || (EMPTY_OBJECT as Record<string, string>);

			for (const [name, version] of Object.entries(deps)) {
				node.dependencies.set(name, { type: DEPENDENCY_TYPE.PROD, version });
			}
			for (const [name, version] of Object.entries(peer_deps)) {
				node.dependencies.set(name, { type: DEPENDENCY_TYPE.PEER, version });
			}
			for (const [name, version] of Object.entries(dev_deps)) {
				// only add dev deps if not already present as prod/peer
				if (!node.dependencies.has(name)) {
					node.dependencies.set(name, { type: DEPENDENCY_TYPE.DEV, version });
				}
			}

			this.nodes.set(library.name, node);
			this.edges.set(library.name, new Set());
		}

		// second pass: build edges (dependents) for internal dependencies
		for (const node of this.nodes.values()) {
			for (const [dep_name] of node.dependencies) {
				const dep_node = this.nodes.get(dep_name);
				if (dep_node) {
					dep_node.dependents.add(node.name);
					this.edges.get(dep_name)!.add(node.name);
				}
			}
		}
	}

	get_node(name: string): DependencyNode | undefined {
		return this.nodes.get(name);
	}

	/**
	 * Computes topological sort order for dependency graph.
	 *
	 * Delegates to `@fuzdev/fuz_util/sort.ts` for the sorting algorithm.
	 * Throws if cycles detected.
	 *
	 * @param exclude_dev - if true, excludes dev dependencies to break cycles
	 *   Publishing uses `exclude_dev`=true to handle circular dev deps.
	 * @returns array of package names in dependency order (dependencies before dependents)
	 * @throws {Error} if circular dependencies detected in included dependency types
	 */
	topological_sort(exclude_dev = false): Array<string> {
		const items = Array.from(this.nodes.values()).map((node) => ({
			id: node.name,
			depends_on: Array.from(node.dependencies.entries())
				.filter(([dep_name, spec]) => {
					if (exclude_dev && spec.type === DEPENDENCY_TYPE.DEV) return false;
					return this.nodes.has(dep_name);
				})
				.map(([dep_name]) => dep_name)
		}));
		const result = topological_sort_generic(items, 'package');
		if (!result.ok) {
			throw new Error(result.error);
		}
		return result.sorted.map((item) => item.id);
	}

	/**
	 * The names of a node's internal prod/peer dependencies — the edges that order
	 * publishing (dev edges never do).
	 */
	get_prod_peer_dependencies(name: string): Array<string> {
		const node = this.nodes.get(name);
		if (!node) return [];
		const deps: Array<string> = [];
		for (const [dep_name, spec] of node.dependencies) {
			if (spec.type !== DEPENDENCY_TYPE.DEV && this.nodes.has(dep_name)) deps.push(dep_name);
		}
		return deps;
	}

	/**
	 * Detects circular dependencies, categorized by severity.
	 *
	 * Production/peer cycles prevent publishing (impossible to order packages).
	 * Dev cycles are normal (test utils, shared configs) and safely ignored.
	 *
	 * Uses DFS traversal with recursion stack to identify back edges.
	 * Deduplicates cycles using sorted cycle keys.
	 *
	 * @returns object with `production_cycles` (errors) and `dev_cycles` (info)
	 */
	detect_cycles_by_type(): {
		production_cycles: Array<Array<string>>;
		dev_cycles: Array<Array<string>>;
	} {
		const production_cycles = this.#find_cycles((spec) => spec.type !== DEPENDENCY_TYPE.DEV);
		const dev_cycles = this.#find_cycles((spec) => spec.type === DEPENDENCY_TYPE.DEV);
		return { production_cycles, dev_cycles };
	}

	/**
	 * Reports cycles by type and wildcard (`*`) dependency ranges.
	 * Tolerates cycles: it reports them rather than throwing.
	 */
	analyze(): DependencyAnalysis {
		const { production_cycles, dev_cycles } = this.detect_cycles_by_type();
		const wildcard_deps: DependencyAnalysis['wildcard_deps'] = [];
		for (const node of this.nodes.values()) {
			for (const [dep_name, spec] of node.dependencies) {
				if (spec.version === '*') {
					wildcard_deps.push({ pkg: node.name, dep: dep_name, version: spec.version });
				}
			}
		}
		return { production_cycles, dev_cycles, wildcard_deps };
	}

	/** DFS cycle detection following only edges that match the filter. */
	#find_cycles(include: (spec: DependencySpec) => boolean): Array<Array<string>> {
		const cycles: Array<Array<string>> = [];
		const visited: Set<string> = new Set();
		const rec_stack: Set<string> = new Set();

		const dfs = (name: string, path: Array<string>): void => {
			visited.add(name);
			rec_stack.add(name);
			path.push(name);

			const node = this.nodes.get(name);
			if (node) {
				for (const [dep_name, spec] of node.dependencies) {
					if (!include(spec)) continue;

					if (this.nodes.has(dep_name)) {
						if (!visited.has(dep_name)) {
							dfs(dep_name, [...path]);
						} else if (rec_stack.has(dep_name)) {
							const cycle_start = path.indexOf(dep_name);
							const cycle = path.slice(cycle_start).concat(dep_name);
							const cycle_key = [...cycle].sort().join(',');
							const exists = cycles.some((c) => [...c].sort().join(',') === cycle_key);
							if (!exists) {
								cycles.push(cycle);
							}
						}
					}
				}
			}

			rec_stack.delete(name);
		};

		for (const name of this.nodes.keys()) {
			if (!visited.has(name)) {
				dfs(name, []);
			}
		}

		return cycles;
	}

	toJSON(): DependencyGraphJson {
		const nodes = Array.from(this.nodes.values()).map((node) => ({
			name: node.name,
			version: node.version,
			dependencies: Array.from(node.dependencies.entries()).map(([name, spec]) => ({
				name,
				spec
			})),
			dependents: Array.from(node.dependents)
		}));

		const edges: Array<{ from: string; to: string }> = [];
		for (const [from, tos] of this.edges) {
			for (const to of tos) {
				edges.push({ from, to });
			}
		}

		return { nodes, edges };
	}
}

/**
 * Groups names into levels by their longest dependency path: a name's level is one
 * past the deepest of its dependencies in `names`, and dependencies outside
 * `names` don't count. So a level's names never depend on each other, and each
 * depends only on names in earlier levels — work within a level can run in
 * parallel. Within a level, names follow `rank` when given (config order, say),
 * else `order`.
 *
 * @param order - every name to group, dependencies before dependents (a topological order)
 * @param get_dependencies - the names one name depends on
 * @param names - the names to group, a subset of `order`; defaults to all of it
 * @param rank - each name's position within its level; names it lacks go last
 * @returns the levels, shallowest first, with no empty level
 */
export const group_into_levels = (
	order: ReadonlyArray<string>,
	get_dependencies: (name: string) => Iterable<string>,
	names?: ReadonlySet<string>,
	rank?: ReadonlyMap<string, number>
): Array<Array<string>> => {
	const level_by_name: Map<string, number> = new Map();
	const levels: Array<Array<string>> = [];
	for (const name of order) {
		if (names && !names.has(name)) continue;
		let level = 0;
		for (const dep of get_dependencies(name)) {
			const dep_level = level_by_name.get(dep);
			if (dep_level !== undefined && dep_level >= level) level = dep_level + 1;
		}
		level_by_name.set(name, level);
		(levels[level] ??= []).push(name);
	}
	if (rank) {
		const position = (name: string): number => rank.get(name) ?? Number.MAX_SAFE_INTEGER;
		for (const level of levels) level.sort((a, b) => position(a) - position(b));
	}
	return levels;
};

/** Each name's position in `names`, for `group_into_levels`'s `rank`. */
export const to_rank = (names: Iterable<string>): Map<string, number> => {
	const rank: Map<string, number> = new Map();
	for (const name of names) if (!rank.has(name)) rank.set(name, rank.size);
	return rank;
};
