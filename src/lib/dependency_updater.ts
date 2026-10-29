import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { join } from 'node:path';

import type { LocalRepo } from './local_repo.ts';
import type { DependencyUpdate } from './publishing_plan.ts';
import {
	write_dependency_updates_changeset,
	to_dependency_version_changes
} from './changeset_generator.ts';
import { needs_update, to_updated_range, type VersionStrategy } from './version_utils.ts';
import type { GitOperations, FsOperations } from './operations.ts';
import { default_git_operations, default_fs_operations } from './operations_defaults.ts';

export interface UpdatePackageJsonOptions {
	strategy?: VersionStrategy;
	/**
	 * Whether the dependent republishes, so its prod/peer updates go in its
	 * auto-changeset. A dev-only rewrite or a private dependent takes none.
	 */
	changeset?: boolean;
	log?: Logger;
	git_ops?: GitOperations;
	fs_ops?: FsOperations;
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

/**
 * Reads the indentation of a JSON document's first indented line, defaulting to tabs.
 */
const to_json_indent = (content: string): string => /^([ \t]+)\S/m.exec(content)?.[1] ?? '\t';

/**
 * Rewrites one dependent's `package.json` for its dependency updates and commits it,
 * with its auto-changeset when it republishes.
 *
 * Workflow:
 * 1. Rewrites each updated name in every section that lists it (dependencies,
 *    devDependencies, peerDependencies), so a package that is both a peer and a
 *    dev dependency moves in one commit
 * 2. Writes updated `package.json` in the indentation it was read with, so the
 *    rewrite moves only the ranges (npm also takes its lockfile's indentation from it)
 * 3. With `changeset`, writes the dependent's one auto-changeset for its prod/peer
 *    updates, merging into it when an earlier rewrite wrote it
 *    (`write_dependency_updates_changeset`)
 * 4. Commits both `package.json` and changeset, the message naming each updated version
 *
 * Each range keeps its existing prefix, else takes the strategy's (`to_updated_range`).
 * When no entry's value changes — every range already names its version — it writes,
 * creates, and commits nothing, or throws under `changeset`.
 *
 * @param repo - the dependent
 * @param updates - its dependency updates, all naming `repo` as the dependent
 * @throws {Error} if file operations or git operations fail, or if nothing changes for a
 *   republishing dependent (`changeset`), whose changeset would go missing
 */
export const update_package_json = async (
	repo: LocalRepo,
	updates: ReadonlyArray<DependencyUpdate>,
	options: UpdatePackageJsonOptions = {}
): Promise<void> => {
	const {
		strategy = 'caret',
		changeset = false,
		log,
		git_ops = default_git_operations,
		fs_ops = default_fs_operations
	} = options;
	if (updates.length === 0) return;
	const versions: Map<string, string> = new Map(
		updates.map((u) => [u.updated_dependency, u.new_version])
	);

	const package_json_path = join(repo.repo_dir, 'package.json');

	// Read current package.json
	const content_result = await fs_ops.readFile({ path: package_json_path, encoding: 'utf8' });
	if (!content_result.ok) {
		throw new Error(`Failed to read package.json: ${content_result.message}`);
	}
	const package_json = JSON.parse(content_result.value);

	// the versions some entry actually moved to, for the commit message
	const moved: Map<string, string> = new Map();
	for (const section of DEPENDENCY_SECTIONS) {
		const deps: Record<string, string> | undefined = package_json[section];
		if (!deps) continue;
		for (const [name, version] of versions) {
			if (!(name in deps)) continue;
			// each section on its own: a range staged ahead in one never moves back for another
			if (!needs_update(deps[name]!, version)) continue;
			const next = to_updated_range(deps[name]!, version, strategy);
			if (next === deps[name]) continue;
			deps[name] = next;
			moved.set(name, version);
		}
	}

	if (moved.size === 0) {
		// a republishing dependent always has a range to move: the plan read this file and saw
		// it behind, so an unchanged one means it changed since — fail rather than skip its changeset
		if (changeset) {
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
		content: JSON.stringify(package_json, null, to_json_indent(content_result.value)) + '\n'
	});
	if (!write_result.ok) {
		throw new Error(`Failed to write package.json: ${write_result.message}`);
	}

	const staged: Array<string> = [];

	if (changeset) {
		const dependency_updates = to_dependency_version_changes(updates);
		if (dependency_updates.length > 0) {
			const changeset_path = await write_dependency_updates_changeset(repo, dependency_updates, {
				log,
				fs_ops
			});

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
		message: to_dependency_update_commit_message(moved),
		files: staged,
		cwd: repo.repo_dir
	});
	if (!commit_result.ok) {
		throw new Error(`Failed to commit: ${commit_result.message}`);
	}
};

/**
 * The commit message for a dependency rewrite, naming each dependency and the
 * version it moved to, so the history says what each of a cascade's commits did.
 *
 * @example
 * ```ts
 * to_dependency_update_commit_message(new Map([['@fuzdev/fuz_util', '0.79.0']]))
 * // 'update dependencies: @fuzdev/fuz_util 0.79.0'
 * ```
 */
export const to_dependency_update_commit_message = (updates: Map<string, string>): string =>
	`update dependencies: ${Array.from(updates, ([name, version]) => `${name} ${version}`).join(', ')}`;
