/**
 * Helper functions for publishing plan calculations: the dependency updates a
 * release implies and the bump they require.
 *
 * @module
 */

import type { LocalRepo } from './local_repo.ts';
import { needs_update, to_range_update_bump } from './version_utils.ts';
import type { DependencyUpdate, VersionChange } from './publishing_plan.ts';

/** A `package.json` dependency section. */
export type DependencySection = DependencyUpdate['type'];

/** Every dependency section, in the order updates are listed. */
export const DEPENDENCY_SECTIONS: ReadonlyArray<DependencySection> = [
	'dependencies',
	'peerDependencies',
	'devDependencies'
];

const to_section_dependencies = (
	repo: LocalRepo,
	section: DependencySection
): Map<string, string> | undefined =>
	section === 'dependencies'
		? repo.dependencies
		: section === 'peerDependencies'
			? repo.peer_dependencies
			: repo.dev_dependencies;

/**
 * The updates one package's dependency ranges need so each names its
 * dependency's version after the release: `targets` maps every package to
 * that version, its predicted one when it publishes and its current one
 * otherwise. A range already naming it, or staged ahead of it, needs none
 * (`needs_update`).
 *
 * An update is breaking when the move from the range's base version is
 * (`to_range_update_bump`), so a range lagging its dependency's last release
 * counts what it skips; a range with no `x.y.z` base takes the dependency's
 * own change's breaking flag.
 *
 * @param repo - the dependent package
 * @param targets - every package's version after the release, by name
 * @param changes - the version changes the release makes, by name
 * @param sections - the dependency sections to read
 */
export const to_dependency_updates = (
	repo: LocalRepo,
	targets: ReadonlyMap<string, string>,
	changes: ReadonlyMap<string, VersionChange>,
	sections: ReadonlyArray<DependencySection> = DEPENDENCY_SECTIONS
): Array<DependencyUpdate> => {
	const updates: Array<DependencyUpdate> = [];
	for (const section of sections) {
		const deps = to_section_dependencies(repo, section);
		if (!deps) continue;
		for (const [dep_name, current_version] of deps) {
			const new_version = targets.get(dep_name);
			if (!new_version || !needs_update(current_version, new_version)) continue;
			const range_bump = to_range_update_bump(current_version, new_version);
			updates.push({
				dependent_package: repo.library.name,
				updated_dependency: dep_name,
				current_version,
				new_version,
				type: section,
				breaking: range_bump?.breaking ?? changes.get(dep_name)?.breaking ?? false
			});
		}
	}
	return updates;
};

/**
 * Calculates every dependency update between packages (`to_dependency_updates`
 * for each repo, in `repos` order) and the breaking cascades: each package whose release is breaking for some dependent's
 * prod/peer range, with those dependents.
 */
export const calculate_dependency_updates = (
	repos: ReadonlyArray<LocalRepo>,
	targets: ReadonlyMap<string, string>,
	changes: ReadonlyMap<string, VersionChange>
): {
	dependency_updates: Array<DependencyUpdate>;
	breaking_cascades: Map<string, Array<string>>;
} => {
	const dependency_updates = repos.flatMap((repo) => to_dependency_updates(repo, targets, changes));
	const breaking_cascades: Map<string, Array<string>> = new Map();
	for (const update of dependency_updates) {
		if (update.type === 'devDependencies' || !update.breaking) continue;
		const affected = breaking_cascades.get(update.updated_dependency);
		if (!affected) {
			breaking_cascades.set(update.updated_dependency, [update.dependent_package]);
		} else if (!affected.includes(update.dependent_package)) {
			affected.push(update.dependent_package);
		}
	}
	return { dependency_updates, breaking_cascades };
};
