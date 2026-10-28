import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { join } from 'node:path';

import type { LocalRepo } from './local_repo.ts';
import type { PublishedVersion } from './multi_repo_publisher.ts';
import {
	create_changeset_for_dependency_updates,
	create_dependency_updates
} from './changeset_generator.ts';
import { to_updated_range, type VersionStrategy } from './version_utils.ts';
import type { GitOperations, FsOperations } from './operations.ts';
import { default_git_operations, default_fs_operations } from './operations_defaults.ts';

export interface UpdatePackageJsonOptions {
	strategy?: VersionStrategy;
	published_versions?: Map<string, PublishedVersion>;
	log?: Logger;
	git_ops?: GitOperations;
	fs_ops?: FsOperations;
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/**
 * Updates `package.json` dependencies and creates changeset if needed.
 *
 * Workflow:
 * 1. Rewrites each updated name in every section that lists it (dependencies,
 *    devDependencies, peerDependencies), so a package that is both a peer and a
 *    dev dependency moves in one commit
 * 2. Writes updated `package.json` with tabs formatting
 * 3. Creates auto-changeset if `published_versions` provided (for transitive updates)
 * 4. Commits both `package.json` and changeset with standard message
 *
 * Each range keeps its existing prefix, else takes the strategy's (`to_updated_range`).
 * When no entry's value changes — every range already names its version — it writes,
 * creates, and commits nothing, or throws when `published_versions` is given.
 *
 * @throws {Error} if file operations or git operations fail, or if nothing changes for a
 *   republishing dependent (`published_versions` given), whose changeset would go missing
 */
export const update_package_json = async (
	repo: LocalRepo,
	updates: Map<string, string>,
	options: UpdatePackageJsonOptions = {}
): Promise<void> => {
	const {
		strategy = 'caret',
		published_versions,
		log,
		git_ops = default_git_operations,
		fs_ops = default_fs_operations
	} = options;
	if (updates.size === 0) return;

	const package_json_path = join(repo.repo_dir, 'package.json');

	// Read current package.json
	const content_result = await fs_ops.readFile({ path: package_json_path, encoding: 'utf8' });
	if (!content_result.ok) {
		throw new Error(`Failed to read package.json: ${content_result.message}`);
	}
	const package_json = JSON.parse(content_result.value);

	let updated = false;
	for (const section of DEPENDENCY_SECTIONS) {
		const deps: Record<string, string> | undefined = package_json[section];
		if (!deps) continue;
		for (const [name, version] of updates) {
			if (!(name in deps)) continue;
			const next = to_updated_range(deps[name]!, version, strategy);
			if (next === deps[name]) continue;
			deps[name] = next;
			updated = true;
		}
	}

	if (!updated) {
		// a republishing dependent always has a range to move: the plan read this file and saw
		// it behind, so an unchanged one means it changed since — fail rather than skip its changeset
		if (published_versions) {
			throw new Error(
				`${repo.library.name}'s package.json already names every updated version, so it ` +
					`would republish without its auto-changeset — it changed since the plan read it`
			);
		}
		return;
	}

	// Write updated package.json
	const write_result = await fs_ops.writeFile({
		path: package_json_path,
		content: JSON.stringify(package_json, null, '\t') + '\n'
	});
	if (!write_result.ok) {
		throw new Error(`Failed to write package.json: ${write_result.message}`);
	}

	const staged: Array<string> = [];

	// Create changeset if we have published version info
	if (published_versions && published_versions.size > 0) {
		// Build dependency updates info for changeset
		const all_deps: Map<string, string> = new Map();

		// Collect all current dependencies with their versions
		for (const deps of [repo.dependencies, repo.dev_dependencies, repo.peer_dependencies]) {
			if (!deps) continue;
			for (const [name, version] of deps) {
				if (updates.has(name)) {
					all_deps.set(name, version);
				}
			}
		}

		const dependency_updates = create_dependency_updates(all_deps, published_versions);

		if (dependency_updates.length > 0) {
			const changeset_path = await create_changeset_for_dependency_updates(
				repo,
				dependency_updates,
				{ log, fs_ops }
			);

			// Add changeset to git
			const add_result = await git_ops.add({ files: changeset_path, cwd: repo.repo_dir });
			if (!add_result.ok) {
				throw new Error(`Failed to stage changeset: ${add_result.message}`);
			}
			staged.push(changeset_path);
		}
	}

	// Commit the changes (including both package.json and changeset)
	const add_pkg_result = await git_ops.add({ files: 'package.json', cwd: repo.repo_dir });
	if (!add_pkg_result.ok) {
		throw new Error(`Failed to stage package.json: ${add_pkg_result.message}`);
	}
	staged.push('package.json');

	// commit only what this staged, so nothing else in the index rides along
	const commit_result = await git_ops.commit({
		message: `update dependencies after publishing`,
		files: staged,
		cwd: repo.repo_dir
	});
	if (!commit_result.ok) {
		throw new Error(`Failed to commit: ${commit_result.message}`);
	}
};
