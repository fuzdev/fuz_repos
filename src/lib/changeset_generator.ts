/**
 * Auto-generation of changesets for dependency updates during a release.
 *
 * Creates changesets when packages need to republish due to updated dependencies.
 * For parsing existing changesets, see `changeset_reader.ts`.
 *
 * @module
 */

import { join } from 'node:path';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { LocalRepo } from './local_repo.ts';
import type { DependencyUpdate } from './publishing_plan.ts';
import {
	strip_version_prefix,
	required_bump_for_dependency_update,
	compare_bump_types,
	to_range_update_bump,
	type BumpType
} from './version_utils.ts';
import type { FsOperations } from './operations.ts';
import { default_fs_operations } from './operations_defaults.ts';

export interface DependencyVersionChange {
	package_name: string;
	from_version: string;
	to_version: string;
	bump_type: 'major' | 'minor' | 'patch';
	breaking: boolean;
}

/**
 * The auto-generated changeset's filename. A dependent keeps one, rewritten as
 * each of its dependencies publishes, so its release notes list every
 * dependency that moved under one entry rather than one entry per publish.
 */
export const DEPENDENCY_UPDATES_CHANGESET_FILENAME = 'dependency-updates.md';

/**
 * Writes the dependent's auto-generated changeset, merging `updates` into the
 * one it already has: an earlier step of the release wrote it when another
 * dependency was rewritten. A dependency listed in both
 * keeps its earliest `from_version` and takes the latest `to_version`; the bump
 * is recomputed over the merged list, never below the file's own.
 *
 * @returns the changeset's path
 * @throws {Error} if a file at that name isn't an auto-generated dependency changeset, or on fs failure
 */
export const write_dependency_updates_changeset = async (
	repo: LocalRepo,
	updates: Array<DependencyVersionChange>,
	options: { log?: Logger; fs_ops?: FsOperations } = {}
): Promise<string> => {
	const { log, fs_ops = default_fs_operations } = options;
	const changesets_dir = join(repo.repo_dir, '.changeset');
	const filepath = join(changesets_dir, DEPENDENCY_UPDATES_CHANGESET_FILENAME);

	let merged = updates;
	// a bump raised by hand in the file's frontmatter is kept as a floor
	let existing_bump: BumpType | null = null;
	if (await fs_ops.exists({ path: filepath })) {
		const read = await fs_ops.readFile({ path: filepath, encoding: 'utf8' });
		if (!read.ok) {
			throw new Error(`Failed to read changeset file: ${read.message}`);
		}
		const existing = parse_dependency_updates_changeset(read.value, repo.library.name);
		if (!existing) {
			throw new Error(
				`${filepath} exists but isn't an auto-generated dependency changeset — ` +
					`rename it so the cascade can write its own`
			);
		}
		merged = merge_dependency_updates(existing.updates, updates);
		existing_bump = existing.bump_type;
	} else if (!(await fs_ops.exists({ path: changesets_dir }))) {
		const mkdir_result = await fs_ops.mkdir({ path: changesets_dir, recursive: true });
		if (!mkdir_result.ok) {
			throw new Error(`Failed to create .changeset directory: ${mkdir_result.message}`);
		}
	}

	const computed_bump = calculate_required_bump(repo, merged);
	const required_bump =
		existing_bump && compare_bump_types(existing_bump, computed_bump) > 0
			? existing_bump
			: computed_bump;
	const content = generate_changeset_content(repo.library.name, merged, required_bump);

	const write_result = await fs_ops.writeFile({ path: filepath, content });
	if (!write_result.ok) {
		throw new Error(`Failed to write changeset file: ${write_result.message}`);
	}

	log?.info(`  Wrote changeset: ${DEPENDENCY_UPDATES_CHANGESET_FILENAME}`);

	return filepath;
};

/**
 * Merges new dependency changes into existing ones, in order: a dependency in
 * both keeps its first `from_version`, takes the later `to_version`, the larger
 * bump, and is breaking if either change was.
 */
export const merge_dependency_updates = (
	existing: Array<DependencyVersionChange>,
	updates: Array<DependencyVersionChange>
): Array<DependencyVersionChange> => {
	const merged: Map<string, DependencyVersionChange> = new Map(
		existing.map((u) => [u.package_name, u])
	);
	for (const update of updates) {
		const prior = merged.get(update.package_name);
		merged.set(
			update.package_name,
			prior
				? {
						package_name: update.package_name,
						from_version: prior.from_version,
						to_version: update.to_version,
						bump_type:
							compare_bump_types(update.bump_type, prior.bump_type) > 0
								? update.bump_type
								: prior.bump_type,
						breaking: prior.breaking || update.breaking
					}
				: update
		);
	}
	return Array.from(merged.values());
};

const DEPENDENCY_LINE_REGEX = /^- (.+?): (.+?) → (.+?) \((major|minor|patch)\)$/;
const FRONTMATTER_LINE_REGEX = /^"(.+)": (major|minor|patch)$/;
const SUMMARY_LINES = ['Update dependencies', 'Update dependencies (BREAKING CHANGES)'];
const BREAKING_HEADING = 'Breaking dependency changes:';
const OTHER_HEADINGS = ['Updated dependencies:', 'Other dependency updates:'];

/**
 * Reads back a changeset `generate_changeset_content` wrote for `package_name`:
 * its frontmatter bump and each `- name: from → to (bump)` line, breaking under
 * its heading. Strict, so a merge never drops what it can't read: any other
 * line — prose, another package, a hand edit — means the file isn't one.
 *
 * @returns the bump and changes, or `null` when the content isn't such a changeset
 */
export const parse_dependency_updates_changeset = (
	content: string,
	package_name: string
): { bump_type: BumpType; updates: Array<DependencyVersionChange> } | null => {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== '---' || lines[2] !== '---') return null;
	const frontmatter = FRONTMATTER_LINE_REGEX.exec(lines[1]!);
	if (frontmatter?.[1] !== package_name) return null;

	const updates: Array<DependencyVersionChange> = [];
	let breaking: boolean | null = null; // null until a heading opens a list
	for (const line of lines.slice(3)) {
		if (line === '' || SUMMARY_LINES.includes(line)) continue;
		if (line === BREAKING_HEADING || OTHER_HEADINGS.includes(line)) {
			breaking = line === BREAKING_HEADING;
			continue;
		}
		const match = DEPENDENCY_LINE_REGEX.exec(line);
		if (!match || breaking === null) return null;
		updates.push({
			package_name: match[1]!,
			from_version: match[2]!,
			to_version: match[3]!,
			bump_type: match[4] as BumpType,
			breaking
		});
	}
	if (updates.length === 0) return null;
	return { bump_type: frontmatter[2] as BumpType, updates };
};

const calculate_required_bump = (
	repo: LocalRepo,
	updates: Array<DependencyVersionChange>
): BumpType =>
	required_bump_for_dependency_update(
		repo.package_json.version || '0.0.0',
		updates.some((u) => u.breaking)
	);

/**
 * Generates markdown changeset content for dependency updates.
 *
 * Creates properly formatted changeset with YAML frontmatter, summary,
 * and categorized list of breaking vs regular updates. Output format
 * matches changesets CLI for consistency.
 *
 * @param package_name - package receiving the dependency updates
 * @param updates - list of dependency changes with version info
 * @param bump_type - required bump type (calculated from breaking changes)
 * @returns markdown content ready to write to `.changeset/*.md` file
 */
export const generate_changeset_content = (
	package_name: string,
	updates: Array<DependencyVersionChange>,
	bump_type: 'major' | 'minor' | 'patch'
): string => {
	// Group updates by type
	const breaking_updates = updates.filter((u) => u.breaking);
	const regular_updates = updates.filter((u) => !u.breaking);

	let message = 'Update dependencies';

	if (breaking_updates.length > 0) {
		message = 'Update dependencies (BREAKING CHANGES)';
	}

	const lines: Array<string> = ['---', `"${package_name}": ${bump_type}`, '---', '', message, ''];

	if (breaking_updates.length > 0) {
		lines.push(BREAKING_HEADING);
		for (const update of breaking_updates) {
			lines.push(
				`- ${update.package_name}: ${update.from_version} → ${update.to_version} (${update.bump_type})`
			);
		}
		lines.push('');
	}

	if (regular_updates.length > 0) {
		if (breaking_updates.length > 0) {
			lines.push('Other dependency updates:');
		} else {
			lines.push('Updated dependencies:');
		}
		for (const update of regular_updates) {
			lines.push(
				`- ${update.package_name}: ${update.from_version} → ${update.to_version} (${update.bump_type})`
			);
		}
		lines.push('');
	}

	return lines.join('\n');
};

/**
 * The auto-changeset lines for a dependent's prod/peer dependency updates, one
 * per dependency: from the range's base version to the new one, with the bump
 * and breaking flag the move amounts to. A range with no `x.y.z` base (a
 * wildcard) counts as a patch.
 */
export const to_dependency_version_changes = (
	updates: ReadonlyArray<DependencyUpdate>
): Array<DependencyVersionChange> => {
	const by_name: Map<string, DependencyVersionChange> = new Map();
	for (const update of updates) {
		if (update.type === 'devDependencies') continue;
		const range_bump = to_range_update_bump(update.current_version, update.new_version);
		const change: DependencyVersionChange = {
			package_name: update.updated_dependency,
			from_version: strip_version_prefix(update.current_version).trim(),
			to_version: update.new_version,
			bump_type: range_bump?.bump_type ?? 'patch',
			breaking: update.breaking
		};
		const prior = by_name.get(change.package_name);
		by_name.set(
			change.package_name,
			prior ? (merge_dependency_updates([prior], [change])[0] ?? change) : change
		);
	}
	return Array.from(by_name.values());
};
