/**
 * Dependency graph validation shared by the publishing plan and the analysis tasks.
 *
 * Builds the graph, detects cycles by type, and computes the topological order
 * and its levels, reporting cycles and sort failures in the result rather than throwing, so
 * each caller decides how to surface them: the plan turns them into errors,
 * `gitops_analyze` and `gitops_validate` format them.
 *
 * See also: `dependency_graph.ts` for the core graph data structure and algorithms.
 *
 * @module
 */

import {
	DependencyGraph,
	group_into_levels,
	to_rank,
	type DependencyAnalysis
} from './dependency_graph.ts';
import { repo_is_npm, type LocalRepo } from './local_repo.ts';

export interface GraphValidationResult {
	graph: DependencyGraph;
	/** Every package, dependencies before dependents over prod/peer edges. */
	order: Array<string>;
	/**
	 * `order` grouped by longest prod/peer dependency path (`group_into_levels`):
	 * each level depends only on earlier ones. In the repos' order within a level.
	 */
	levels: Array<Array<string>>;
	production_cycles: Array<Array<string>>;
	dev_cycles: Array<Array<string>>;
	/** Why the topological sort failed, when it did; `order` and `levels` are then empty. */
	sort_error?: string;
}

/**
 * Builds the dependency graph, detects cycles, and computes the topological order
 * and its levels (prod/peer dependencies only, so dev cycles don't block them).
 *
 * Never throws on cycles: a production/peer cycle leaves `order` and `levels`
 * empty and sets `sort_error`, and the caller reports it.
 *
 * @returns the graph, order, levels, and detected cycles
 */
export const validate_dependency_graph = (repos: Array<LocalRepo>): GraphValidationResult => {
	const graph = new DependencyGraph(repos);
	const { production_cycles, dev_cycles } = graph.detect_cycles_by_type();

	let order: Array<string>;
	let sort_error: string | undefined;
	try {
		order = graph.topological_sort(true); // exclude dev deps to break cycles
	} catch (error) {
		sort_error = 'Failed to compute publishing order: ' + error;
		order = [];
	}
	const levels = group_into_levels(
		order,
		(name) => graph.get_prod_peer_dependencies(name),
		undefined,
		to_rank(repos.map((r) => r.library.name))
	);

	return {
		graph,
		order,
		levels,
		production_cycles,
		dev_cycles,
		sort_error
	};
};

export interface RepoAnalysis {
	graph: DependencyGraph;
	analysis: DependencyAnalysis;
	/** The packages grouped into dependency levels, or `null` when prod/peer cycles prevent ordering. */
	levels: Array<Array<string>> | null;
}

/**
 * Builds the dependency graph and runs cycle/wildcard analysis, tolerating cycles
 * (reports rather than throws). The shared core of `gitops_analyze` and
 * `gitops_validate`, which format the result themselves.
 */
export const analyze_repos = (repos: Array<LocalRepo>): RepoAnalysis => {
	// only npm packages form the dependency graph; non-npm repos (e.g. cargo) are excluded
	const { graph, levels } = validate_dependency_graph(repos.filter(repo_is_npm));
	return {
		graph,
		analysis: graph.analyze(),
		levels: levels.length > 0 ? levels : null
	};
};
