/**
 * Logging and formatting functions for publishing plans.
 *
 * Includes both regular plan output and verbose diagnostic sections.
 *
 * @module
 */

import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { styleText as st } from 'node:util';

import {
	version_change_kind,
	type PublishingPlan,
	type VersionChange,
	type DependencyUpdate,
	type VerboseData,
	type VerboseChangesetDetail,
	type VerboseIteration,
	type VerbosePropagation,
	type VerboseGraphSummary
} from './publishing_plan.ts';
import { to_updated_range, type VersionStrategy } from './version_utils.ts';

export interface LogPlanOptions {
	verbose?: boolean;
	/**
	 * The prefix strategy the executor rewrites unprefixed ranges with, so the diffs show
	 * what it writes. `gitops_plan` and `gitops_validate` take no strategy and show the default.
	 */
	version_strategy?: VersionStrategy;
}

const SEPARATOR = '────────────────────────────────────────';

/**
 * Logs a section header with separators.
 */
const log_section_header = (title: string, log: Logger): void => {
	log.info(st('dim', SEPARATOR));
	log.info(st('dim', title));
	log.info(st('dim', SEPARATOR));
};

/** The short label of a dependency section: `prod`, `peer`, or `dev`. */
export const to_dependency_type_label = (
	type: DependencyUpdate['type']
): 'prod' | 'peer' | 'dev' =>
	type === 'dependencies' ? 'prod' : type === 'peerDependencies' ? 'peer' : 'dev';

/**
 * Formats a package's dependency updates as diff-style lines, one `-`/`+` pair
 * per entry, each section labeled. The `+` side is the range the executor
 * writes (`to_updated_range`), its prefix kept.
 *
 * @param style - `color` for a publishing package, `dim` for one that doesn't republish
 */
const format_dependency_diffs = (
	pkg_name: string,
	dependency_updates: Array<DependencyUpdate>,
	strategy: VersionStrategy | undefined,
	style: 'color' | 'dim'
): Array<string> => {
	const lines: Array<string> = [];
	for (const update of dependency_updates) {
		if (update.dependent_package !== pkg_name) continue;
		const name = update.updated_dependency;
		const next = to_updated_range(update.current_version, update.new_version, strategy);
		const label = st('dim', `  # ${to_dependency_type_label(update.type)}`);
		const removed = `    - "${name}": "${update.current_version}"`;
		const added = `    + "${name}": "${next}"`;
		lines.push(
			(style === 'color' ? st('red', removed) : st('dim', removed)) + label,
			(style === 'color' ? st('green', added) : st('dim', added)) + label
		);
	}
	return lines;
};

/**
 * Logs a single version change with diff-style dependency updates.
 */
const log_version_change_with_diffs = (
	change: VersionChange,
	index: number,
	total: number,
	dependency_updates: Array<DependencyUpdate>,
	breaking_cascades: Map<string, Array<string>>,
	strategy: VersionStrategy | undefined,
	log: Logger
): void => {
	const breaking_indicator = change.breaking ? st('red', ' BREAKING') : '';
	const position = st('dim', `[${index + 1}/${total}]`);

	const kind = version_change_kind(change);

	// Determine scenario label
	let scenario_label = '';
	if (kind === 'escalation') {
		scenario_label = st('yellow', ` [${change.existing_bump} → ${change.required_bump}]`);
	} else if (kind === 'auto') {
		scenario_label = st('cyan', ' [auto-changeset]');
	}

	// Main version line
	log.info(
		`${position} ${change.package_name}: ${change.from} → ${st('green', change.to)} ` +
			`(${change.bump_type})${scenario_label}${breaking_indicator}`
	);

	// Show escalation reason
	if (kind === 'escalation') {
		log.info(
			st(
				'dim',
				`      changesets specify ${change.existing_bump}, dependencies require ${change.required_bump}`
			)
		);
	}

	// Show trigger reason for auto-changesets
	if (kind === 'auto') {
		// Find what triggered this
		const triggers: Array<string> = [];
		for (const [pkg, affected] of breaking_cascades) {
			if (affected.includes(change.package_name)) {
				triggers.push(`${pkg} (BREAKING)`);
			}
		}
		if (triggers.length > 0) {
			log.info(st('dim', `      triggered by: ${triggers.join(', ')}`));
		}
	}

	// Show dependency diffs for this package
	for (const line of format_dependency_diffs(
		change.package_name,
		dependency_updates,
		strategy,
		'color'
	)) {
		log.info(line);
	}
};

/**
 * Logs a complete publishing plan to the console.
 *
 * Displays errors, publishing order, version changes grouped by scenario,
 * dependency-only updates, warnings, and a summary.
 */
export const log_publishing_plan = (
	plan: PublishingPlan,
	log: Logger,
	options: LogPlanOptions = {}
): void => {
	const {
		publishing_order,
		version_changes,
		dependency_updates,
		breaking_cascades,
		warnings,
		info,
		no_changes,
		errors
	} = plan;

	// Errors first (blocking issues)
	if (errors.length > 0) {
		log.error(st('red', 'Errors:'));
		for (const error of errors) {
			log.error(`  ${error}`);
		}
		log.info('');
	}

	// Publishing order
	if (publishing_order.length > 0) {
		log.info(st('cyan', 'Publishing Order:'));
		log.info(`  ${publishing_order.join(' → ')}`);
		log.info('');
	}

	// Version changes with diffs
	if (version_changes.length > 0) {
		// Sort by publishing order
		const ordered_changes = [...version_changes].sort((a, b) => {
			const idx_a = publishing_order.indexOf(a.package_name);
			const idx_b = publishing_order.indexOf(b.package_name);
			return idx_a - idx_b;
		});

		// Separate into groups for headers; each change lands in exactly one
		const with_changesets = ordered_changes.filter((vc) => version_change_kind(vc) === 'explicit');
		const with_escalation = ordered_changes.filter(
			(vc) => version_change_kind(vc) === 'escalation'
		);
		const with_auto_changesets = ordered_changes.filter((vc) => version_change_kind(vc) === 'auto');

		// A single running counter across all groups so positions read 1..N with no
		// gaps. (Numbering per-group index would make the first group skip the numbers
		// that land in a later group, e.g. jump from `[9/12]` to `[11/12]`.)
		const total = ordered_changes.length;
		let position = 0;
		const log_change_group = (
			title: string,
			color: 'cyan' | 'yellow',
			changes: Array<VersionChange>
		): void => {
			if (changes.length === 0) return;
			log.info(st(color, title));
			for (const change of changes) {
				log_version_change_with_diffs(
					change,
					position++,
					total,
					dependency_updates,
					breaking_cascades,
					options.version_strategy,
					log
				);
			}
			log.info('');
		};

		log_change_group('Version Changes (from changesets):', 'cyan', with_changesets);
		log_change_group('Version Changes (bump escalation):', 'yellow', with_escalation);
		log_change_group('Version Changes (auto-generated):', 'cyan', with_auto_changesets);
	} else {
		log.info(st('dim', 'No packages to publish'));
		log.info('');
	}

	// Dependency-only updates (no republish) - packages getting dep updates but not publishing
	const dep_only_packages: Set<string> = new Set();
	for (const update of dependency_updates) {
		const has_version_change = version_changes.some(
			(vc) => vc.package_name === update.dependent_package
		);
		if (!has_version_change) {
			dep_only_packages.add(update.dependent_package);
		}
	}

	if (dep_only_packages.size > 0) {
		log.info(st('dim', 'Dependency Updates (no republish):'));
		for (const pkg of dep_only_packages) {
			log.info(st('dim', `  ${pkg}:`));
			for (const line of format_dependency_diffs(
				pkg,
				dependency_updates,
				options.version_strategy,
				'dim'
			)) {
				log.info(line);
			}
		}
		log.info('');
	}

	// Warnings
	if (warnings.length > 0) {
		log.warn(st('yellow', 'Warnings:'));
		for (const warning of warnings) {
			log.warn(`  ${warning}`);
		}
		log.info('');
	}

	// Info sentences, then the packages with nothing to publish (some may still take
	// dependency-only updates above)
	for (const line of info) {
		log.info(st('dim', line));
	}
	if (no_changes.length > 0) {
		log.info(st('dim', `Nothing to publish: ${no_changes.join(', ')}`));
	}
	if (info.length > 0 || no_changes.length > 0) {
		log.info('');
	}

	// Summary
	const major_count = version_changes.filter((vc) => vc.breaking).length;
	const auto_count = version_changes.filter((vc) => version_change_kind(vc) === 'auto').length;
	log.info(st('cyan', 'Summary:'));
	log.info(`  ${version_changes.length} packages to publish`);
	if (auto_count > 0) {
		log.info(`  ${auto_count} auto-generated changesets`);
	}
	if (major_count > 0) {
		log.info(st('yellow', `  ${major_count} breaking changes`));
	}
	log.info(`  ${dep_only_packages.size} packages with dependency-only updates`);
	if (warnings.length > 0) {
		log.info(st('yellow', `  ${warnings.length} warnings`));
	}
	if (errors.length > 0) {
		log.info(st('red', `  ${errors.length} errors`));
	}

	// Verbose output
	if (options.verbose && plan.verbose_data) {
		log_verbose(plan.verbose_data, log);
	}
};

//
// Verbose logging functions
//

/**
 * Logs all verbose sections in order.
 */
const log_verbose = (data: VerboseData, log: Logger): void => {
	log.info(''); // Blank line before verbose sections

	log_verbose_changeset_details(data.changeset_details, log);
	log_verbose_iteration_details(data.iterations, data.total_iterations, log);
	log_verbose_propagations(data.propagations, log);
	log_verbose_graph_summary(data.graph_summary, log);
};

/**
 * Logs changeset file details per package.
 */
const log_verbose_changeset_details = (
	details: Array<VerboseChangesetDetail>,
	log: Logger
): void => {
	if (details.length === 0) return;

	log_section_header('Changeset Details', log);

	for (const pkg of details) {
		log.info(st('dim', `${pkg.package_name}:`));
		for (const file of pkg.files) {
			// the first line alone: a changeset body can run to paragraphs
			const summary = file.summary.trim();
			const first_line = summary.split('\n', 1)[0]!.trim();
			const more = summary.includes('\n') ? ' …' : '';
			const summary_text = first_line ? `: "${first_line}"${more}` : '';
			log.info(st('dim', `  .changeset/${file.filename} (${file.bump_type})${summary_text}`));
		}
	}
	log.info('');
};

/**
 * Logs fixed-point iteration details.
 */
const log_verbose_iteration_details = (
	iterations: Array<VerboseIteration>,
	total: number,
	log: Logger
): void => {
	if (iterations.length === 0) return;

	log_section_header('Fixed-Point Iteration', log);

	for (const iter of iterations) {
		if (iter.new_changes === 0 && iter.packages.length === 0) {
			log.info(st('dim', `Iteration ${iter.iteration}:`));
			log.info(st('dim', '  No new changes'));
			continue;
		}

		log.info(st('dim', `Iteration ${iter.iteration}:`));
		for (const pkg of iter.packages) {
			const parts: Array<string> = [];

			// Changeset info
			if (pkg.changeset_count > 0) {
				parts.push(`changesets=${pkg.changeset_count}`);
				if (pkg.bump_from_changesets) {
					parts.push(`bump=${pkg.bump_from_changesets}`);
				}
			} else {
				parts.push('no changesets');
			}

			// Required bump from deps
			if (pkg.required_bump && pkg.triggering_dep) {
				parts.push(`required=${pkg.required_bump} (from ${pkg.triggering_dep})`);
			}

			// Action
			if (pkg.action === 'auto_changeset') {
				parts.push('→ auto-generate');
			} else if (pkg.action === 'escalation') {
				parts.push('→ escalation');
			} else if (pkg.action === 'publish') {
				// Regular publish, no special label needed
			}

			// Version
			if (pkg.version_to) {
				const breaking_label = pkg.is_breaking ? ' (BREAKING)' : '';
				parts.push(`→ ${pkg.version_to}${breaking_label}`);
			}

			log.info(st('dim', `  ${pkg.name}: ${parts.join(', ')}`));
		}

		if (iter.new_changes > 0) {
			log.info(st('dim', `  New changes: ${iter.new_changes}`));
		}
	}

	log.info(st('dim', `Converged after ${total} iteration(s)`));
	log.info('');
};

/**
 * Logs each breaking package with the direct prod/peer dependents its publish
 * rewrites, one branch per dependent. Transitive spread shows as later sources,
 * since a dependent that republishes breaking is a source of its own.
 */
const log_verbose_propagations = (propagations: Array<VerbosePropagation>, log: Logger): void => {
	if (propagations.length === 0) return;

	log_section_header('Breaking Change Propagation', log);

	for (const { source, dependents } of propagations) {
		log.info(st('dim', `${source} (source)`));

		for (let i = 0; i < dependents.length; i++) {
			const item = dependents[i]!;
			const connector = i === dependents.length - 1 ? '└─' : '├─';
			log.info(st('dim', `${connector} ${item.pkg} (${item.dep_type} dep) → ${item.action}`));
		}
	}
	log.info('');
};

/**
 * Logs dependency graph summary.
 */
const log_verbose_graph_summary = (summary: VerboseGraphSummary, log: Logger): void => {
	log_section_header('Dependency Graph', log);

	log.info(
		st(
			'dim',
			`${summary.package_count} packages, ${summary.internal_dep_count} internal dependencies`
		)
	);
	log.info('');

	// Production/Peer edges
	if (summary.prod_peer_edges.length > 0) {
		log.info(st('dim', 'Production/Peer:'));
		for (const edge of summary.prod_peer_edges) {
			log.info(st('dim', `  ${edge.from} → ${edge.to} (${edge.type})`));
		}
	} else {
		log.info(st('dim', 'Production/Peer: (none)'));
	}

	// Dev edges
	if (summary.dev_edges.length > 0) {
		log.info(st('dim', 'Dev:'));
		for (const edge of summary.dev_edges) {
			log.info(st('dim', `  ${edge.from} → ${edge.to}`));
		}
	} else {
		log.info(st('dim', 'Dev: (none)'));
	}

	log.info('');
	log.info(
		st('dim', `Cycles: ${summary.prod_cycle_count} production, ${summary.dev_cycle_count} dev`)
	);
	log.info('');
};
