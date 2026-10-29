import { assert, describe, test } from 'vitest';
import { join } from 'node:path';

import { update_package_json } from '#lib/dependency_updater.ts';
import { create_mock_repo, create_mock_git_ops, create_mock_fs_ops } from './test_helpers.ts';
import type { GitOperations } from '#lib/operations.ts';
import type { LocalRepo } from '#lib/local_repo.ts';
import type { DependencyUpdate } from '#lib/publishing_plan.ts';

/**
 * The dependency updates moving each named dependency of `repo` to its
 * version, one per section that lists it, as the plan reports them.
 */
const to_updates = (repo: LocalRepo, versions: Map<string, string>): Array<DependencyUpdate> => {
	const updates: Array<DependencyUpdate> = [];
	const sections = [
		['dependencies', repo.dependencies],
		['peerDependencies', repo.peer_dependencies],
		['devDependencies', repo.dev_dependencies]
	] as const;
	for (const [name, version] of versions) {
		let listed = false;
		for (const [type, deps] of sections) {
			const current = deps?.get(name);
			if (current === undefined) continue;
			listed = true;
			updates.push({
				dependent_package: repo.library.name,
				updated_dependency: name,
				current_version: current,
				new_version: version,
				type,
				breaking: false
			});
		}
		// a dependency the repo doesn't list still reaches the rewrite, which skips it
		if (!listed) {
			updates.push({
				dependent_package: repo.library.name,
				updated_dependency: name,
				current_version: '0.0.0',
				new_version: version,
				type: 'dependencies',
				breaking: false
			});
		}
	}
	return updates;
};

/**
 * Creates mock git operations that track calls
 */
const create_trackable_git_ops = (): GitOperations & {
	added_files: Array<string>;
	commits: Array<string>;
	committed_files: Array<Array<string>>;
} => {
	const added_files: Array<string> = [];
	const commits: Array<string> = [];
	const committed_files: Array<Array<string>> = [];

	const git_ops = create_mock_git_ops({
		add: async (options) => {
			if (Array.isArray(options.files)) {
				added_files.push(...options.files);
			} else {
				added_files.push(options.files);
			}
			return { ok: true };
		},
		commit: async (options) => {
			commits.push(options.message);
			committed_files.push(options.files);
			return { ok: true };
		}
	});

	return {
		...git_ops,
		added_files,
		commits,
		committed_files
	};
};

describe('dependency_updater', () => {
	describe('update_package_json', () => {
		test('updates production dependencies with caret prefix', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: {
					'dep-a': '^1.0.0',
					'dep-b': '^2.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: {
							'dep-a': '^1.0.0',
							'dep-b': '^2.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			assert.ok(updated !== undefined);

			const parsed = JSON.parse(updated);
			assert.strictEqual(parsed.dependencies['dep-a'], '^1.1.0');
			assert.strictEqual(parsed.dependencies['dep-b'], '^2.0.0'); // unchanged
		});

		test('updates devDependencies', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				dev_deps: {
					'dev-a': '^1.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						devDependencies: {
							'dev-a': '^1.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dev-a', '2.0.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.devDependencies['dev-a'], '^2.0.0');
		});

		test('updates peerDependencies', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				peer_deps: {
					'peer-a': '^3.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						peerDependencies: {
							'peer-a': '^3.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['peer-a', '3.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.peerDependencies['peer-a'], '^3.1.0');
		});

		test('preserves tilde prefix when using tilde strategy', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: {
					'dep-a': '~1.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: {
							'dep-a': '~1.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), {
				strategy: 'tilde',
				git_ops,
				fs_ops: fs
			});

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.dependencies['dep-a'], '~1.1.0');
		});

		test('uses exact versions with exact strategy', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: {
					'dep-a': '1.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: {
							'dep-a': '1.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), {
				strategy: 'exact',
				git_ops,
				fs_ops: fs
			});

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.dependencies['dep-a'], '1.1.0'); // no prefix
		});

		test('preserves >= prefix in peerDependencies', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				peer_deps: {
					'@fuzdev/fuz_util': '>=0.38.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						peerDependencies: {
							'@fuzdev/fuz_util': '>=0.38.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['@fuzdev/fuz_util', '0.39.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.peerDependencies['@fuzdev/fuz_util'], '>=0.39.0');
		});

		test('uses gte strategy for >= prefix on new deps', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: {
					'dep-a': '1.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: {
							'dep-a': '1.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), {
				strategy: 'gte',
				git_ops,
				fs_ops: fs
			});

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.dependencies['dep-a'], '>=1.1.0');
		});

		test('updates multiple dependencies at once', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: {
					'dep-a': '^1.0.0',
					'dep-b': '^2.0.0'
				},
				dev_deps: {
					'dev-a': '^3.0.0'
				}
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: {
							'dep-a': '^1.0.0',
							'dep-b': '^2.0.0'
						},
						devDependencies: {
							'dev-a': '^3.0.0'
						}
					},
					null,
					'\t'
				)
			);

			const updates = new Map([
				['dep-a', '1.2.0'],
				['dep-b', '2.5.0'],
				['dev-a', '3.1.0']
			]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			const parsed = JSON.parse(updated!);
			assert.strictEqual(parsed.dependencies['dep-a'], '^1.2.0');
			assert.strictEqual(parsed.dependencies['dep-b'], '^2.5.0');
			assert.strictEqual(parsed.devDependencies['dev-a'], '^3.1.0');
		});

		test('preserves JSON formatting with tabs', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: { 'dep-a': '^1.0.0' }
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: { 'dep-a': '^1.0.0' }
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			const updated = fs.get(package_json_path);
			assert.ok(updated!.includes('\n\t"name"'));
			assert.match(updated!, /\n$/); // ends with newline
		});

		test('preserves JSON formatting with two spaces', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: { 'dep-a': '^1.0.0' }
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			const package_json = {
				name: 'test-pkg',
				version: '1.0.0',
				dependencies: { 'dep-a': '^1.0.0' }
			};
			fs.set(package_json_path, JSON.stringify(package_json, null, 2) + '\n');

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			package_json.dependencies['dep-a'] = '^1.1.0';
			assert.strictEqual(fs.get(package_json_path), JSON.stringify(package_json, null, 2) + '\n');
		});

		test('creates git commit with correct message', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: { 'dep-a': '^1.0.0' }
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: { 'dep-a': '^1.0.0' }
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			assert.ok(git_ops.added_files.includes('package.json'));
			assert.strictEqual(git_ops.commits.length, 1);
			assert.strictEqual(git_ops.commits[0], 'update dependencies: dep-a 1.1.0');
			// only what it staged, so nothing else in the index rides along
			assert.deepEqual(git_ops.committed_files, [['package.json']]);
		});

		test('commits the changeset it creates with package.json, and nothing else', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: { 'dep-a': '^1.0.0' }
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: { 'dep-a': '^1.0.0' }
					},
					null,
					'\t'
				)
			);

			const updates = new Map([['dep-a', '1.1.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), {
				changeset: true,
				git_ops,
				fs_ops: fs
			});

			assert.strictEqual(git_ops.committed_files.length, 1);
			const committed = git_ops.committed_files[0]!;
			assert.strictEqual(committed.length, 2);
			const [changeset_path, package_json] = committed;
			assert(changeset_path !== undefined);
			assert.ok(changeset_path.startsWith(join(repo.repo_dir, '.changeset') + '/'));
			assert.ok(fs.get(changeset_path) !== undefined);
			assert.strictEqual(package_json, 'package.json');
		});

		test('does nothing when updates map is empty', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({ name: 'test-pkg' });

			const updates: Map<string, string> = new Map();
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			assert.strictEqual(git_ops.added_files.length, 0);
			assert.strictEqual(git_ops.commits.length, 0);
		});

		test('does nothing when no matching dependencies found', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				deps: { 'dep-a': '^1.0.0' }
			});

			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify(
					{
						name: 'test-pkg',
						version: '1.0.0',
						dependencies: { 'dep-a': '^1.0.0' }
					},
					null,
					'\t'
				)
			);

			// Update for a different dependency
			const updates = new Map([['dep-b', '2.0.0']]);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, updates), { git_ops, fs_ops: fs });

			assert.strictEqual(git_ops.commits.length, 0);
		});

		test('rewrites a peer and dev entry of one dependency in one commit', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				peer_deps: { lib: '>=1.0.0' },
				dev_deps: { lib: '^1.0.0' }
			});
			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
					peerDependencies: { lib: '>=1.0.0' },
					devDependencies: { lib: '^1.0.0' }
				})
			);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, new Map([['lib', '1.1.0']])), {
				git_ops,
				fs_ops: fs
			});

			const parsed = JSON.parse(fs.get(package_json_path)!);
			assert.strictEqual(parsed.peerDependencies.lib, '>=1.1.0');
			assert.strictEqual(parsed.devDependencies.lib, '^1.1.0');
			assert.strictEqual(git_ops.commits.length, 1);
		});

		test('never moves a range staged ahead in another section', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				peer_deps: { lib: '>=0.56.0' },
				dev_deps: { lib: '^0.54.0' }
			});
			const package_json_path = join(repo.repo_dir, 'package.json');
			fs.set(
				package_json_path,
				JSON.stringify({
					name: 'test-pkg',
					version: '1.0.0',
					peerDependencies: { lib: '>=0.56.0' },
					devDependencies: { lib: '^0.54.0' }
				})
			);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, new Map([['lib', '0.55.0']])), {
				git_ops,
				fs_ops: fs
			});

			const parsed = JSON.parse(fs.get(package_json_path)!);
			assert.strictEqual(parsed.peerDependencies.lib, '>=0.56.0');
			assert.strictEqual(parsed.devDependencies.lib, '^0.55.0');
		});

		// the dev-dependency pass after a peer rewrite already moved the dev entry:
		// committing an unchanged package.json would fail with "nothing to commit"
		test('writes and commits nothing when every range already names the version', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({
				name: 'test-pkg',
				peer_deps: { lib: '>=1.0.0' },
				dev_deps: { lib: '^1.0.0' }
			});
			const package_json_path = join(repo.repo_dir, 'package.json');
			const content = JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
				peerDependencies: { lib: '>=1.1.0' },
				devDependencies: { lib: '^1.1.0' }
			});
			fs.set(package_json_path, content);
			const git_ops = create_trackable_git_ops();

			await update_package_json(repo, to_updates(repo, new Map([['lib', '1.1.0']])), {
				git_ops,
				fs_ops: fs
			});

			assert.strictEqual(fs.get(package_json_path), content);
			assert.strictEqual(git_ops.added_files.length, 0);
			assert.strictEqual(git_ops.commits.length, 0);
		});

		test('throws for a republishing dependent with nothing to rewrite', async () => {
			const fs = create_mock_fs_ops();
			const repo = create_mock_repo({ name: 'test-pkg', deps: { lib: '^1.0.0' } });
			const package_json_path = join(repo.repo_dir, 'package.json');
			const content = JSON.stringify({
				name: 'test-pkg',
				version: '1.0.0',
				dependencies: { lib: '^1.1.0' }
			});
			fs.set(package_json_path, content);
			const git_ops = create_trackable_git_ops();

			let error: unknown;
			try {
				await update_package_json(repo, to_updates(repo, new Map([['lib', '1.1.0']])), {
					changeset: true,
					git_ops,
					fs_ops: fs
				});
			} catch (e) {
				error = e;
			}

			assert(error instanceof Error);
			assert.include(error.message, 'changed since the plan read it');
			assert.strictEqual(fs.get(package_json_path), content);
			assert.strictEqual(git_ops.commits.length, 0);
		});
	});
});
