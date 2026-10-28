import { assert, describe, test } from 'vitest';
import {
	generate_changeset_content,
	to_dependency_version_changes,
	write_dependency_updates_changeset,
	merge_dependency_updates,
	parse_dependency_updates_changeset,
	type DependencyVersionChange
} from '#lib/changeset_generator.ts';
import type { DependencyUpdate } from '#lib/publishing_plan.ts';
import { create_mock_repo, create_mock_fs_ops } from './test_helpers.ts';

describe('changeset_generator', () => {
	describe('generate_changeset_content', () => {
		test('generates content for patch updates', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'lib-a',
					from_version: '1.0.0',
					to_version: '1.0.1',
					bump_type: 'patch',
					breaking: false
				},
				{
					package_name: 'lib-b',
					from_version: '2.1.0',
					to_version: '2.1.5',
					bump_type: 'patch',
					breaking: false
				}
			];

			const content = generate_changeset_content('my-package', updates, 'patch');

			assert.ok(content.includes('"my-package": patch'));
			assert.ok(content.includes('Update dependencies'));
			assert.ok(content.includes('Updated dependencies:'));
			assert.ok(content.includes('- lib-a: 1.0.0 → 1.0.1 (patch)'));
			assert.ok(content.includes('- lib-b: 2.1.0 → 2.1.5 (patch)'));
			assert.ok(!content.includes('BREAKING'));
		});

		test('generates content for breaking changes', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'lib-breaking',
					from_version: '0.5.0',
					to_version: '0.6.0',
					bump_type: 'minor',
					breaking: true
				}
			];

			const content = generate_changeset_content('my-package', updates, 'minor');

			assert.ok(content.includes('"my-package": minor'));
			assert.ok(content.includes('Update dependencies (BREAKING CHANGES)'));
			assert.ok(content.includes('Breaking dependency changes:'));
			assert.ok(content.includes('- lib-breaking: 0.5.0 → 0.6.0 (minor)'));
		});

		test('generates content for mixed breaking and regular updates', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'breaking-lib',
					from_version: '1.0.0',
					to_version: '2.0.0',
					bump_type: 'major',
					breaking: true
				},
				{
					package_name: 'regular-lib',
					from_version: '1.0.0',
					to_version: '1.0.1',
					bump_type: 'patch',
					breaking: false
				}
			];

			const content = generate_changeset_content('my-package', updates, 'major');

			assert.ok(content.includes('"my-package": major'));
			assert.ok(content.includes('Update dependencies (BREAKING CHANGES)'));
			assert.ok(content.includes('Breaking dependency changes:'));
			assert.ok(content.includes('- breaking-lib: 1.0.0 → 2.0.0 (major)'));
			assert.ok(content.includes('Other dependency updates:'));
			assert.ok(content.includes('- regular-lib: 1.0.0 → 1.0.1 (patch)'));
		});

		test('handles empty updates array', () => {
			const content = generate_changeset_content('my-package', [], 'patch');

			assert.ok(content.includes('"my-package": patch'));
			assert.ok(content.includes('Update dependencies'));
			assert.ok(!content.includes('Updated dependencies:'));
			assert.ok(!content.includes('Breaking dependency changes:'));
		});

		test('generates valid changeset format', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'lib',
					from_version: '1.0.0',
					to_version: '1.1.0',
					bump_type: 'minor',
					breaking: false
				}
			];

			const content = generate_changeset_content('test-pkg', updates, 'minor');

			// Should start with frontmatter
			assert.match(content, /^---\n/);
			// Should have package declaration
			assert.ok(content.includes('"test-pkg": minor'));
			// Should close frontmatter
			assert.match(content, /\n---\n/);
			// Should have summary after frontmatter
			assert.match(content, /---\n\nUpdate dependencies/);
		});

		test('escapes package names in frontmatter', () => {
			const updates: Array<DependencyVersionChange> = [];

			const content = generate_changeset_content('@scope/package-name', updates, 'patch');

			assert.ok(content.includes('"@scope/package-name": patch'));
		});
	});

	describe('to_dependency_version_changes', () => {
		const update = (overrides: Partial<DependencyUpdate>): DependencyUpdate => ({
			dependent_package: 'app',
			updated_dependency: 'lib',
			current_version: '^1.0.0',
			new_version: '1.0.1',
			type: 'dependencies',
			breaking: false,
			...overrides
		});

		test('measures each move from the range base, prefix stripped', () => {
			assert.deepEqual(
				to_dependency_version_changes([
					update({ updated_dependency: 'a', current_version: '^1.0.0', new_version: '1.0.1' }),
					update({
						updated_dependency: 'b',
						current_version: '>=0.54.0',
						new_version: '0.55.1',
						type: 'peerDependencies',
						breaking: true
					})
				]),
				[
					{
						package_name: 'a',
						from_version: '1.0.0',
						to_version: '1.0.1',
						bump_type: 'patch',
						breaking: false
					},
					{
						package_name: 'b',
						from_version: '0.54.0',
						to_version: '0.55.1',
						bump_type: 'minor',
						breaking: true
					}
				]
			);
		});

		test('leaves dev updates out of the changeset', () => {
			assert.deepEqual(to_dependency_version_changes([update({ type: 'devDependencies' })]), []);
		});

		test('one line per dependency when it appears in two sections', () => {
			const changes = to_dependency_version_changes([
				update({ type: 'dependencies' }),
				update({ type: 'peerDependencies', current_version: '>=1.0.0' })
			]);
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0]!.to_version, '1.0.1');
		});

		test('a wildcard range counts as a patch', () => {
			const [change] = to_dependency_version_changes([update({ current_version: '*' })]);
			assert.strictEqual(change!.bump_type, 'patch');
			assert.strictEqual(change!.from_version, '*');
		});

		test('nothing in, nothing out', () => {
			assert.deepEqual(to_dependency_version_changes([]), []);
		});
	});

	describe('write_dependency_updates_changeset', () => {
		test('writes a changeset file under .changeset and returns its path', async () => {
			const repo = create_mock_repo({ name: 'pkg', version: '1.0.0' });
			const fs = create_mock_fs_ops();
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'dep',
					from_version: '1.0.0',
					to_version: '2.0.0',
					bump_type: 'major',
					breaking: true
				}
			];

			const path = await write_dependency_updates_changeset(repo, updates, { fs_ops: fs });

			assert.strictEqual(path, '/test/pkg/.changeset/dependency-updates.md');
			const content = fs.get(path);
			assert.ok(content);
			// pkg is 1.0.0 and the dep change is breaking → required bump is major
			assert.ok(content.includes('"pkg": major'));
			assert.ok(content.includes('dep: 1.0.0 → 2.0.0 (major)'));
		});

		test('creates the .changeset directory when it is missing', async () => {
			const repo = create_mock_repo({ name: 'pkg', version: '0.5.0' });
			const fs = create_mock_fs_ops();
			let mkdir_path: string | undefined;
			const base_mkdir = fs.mkdir;
			fs.mkdir = async (options) => {
				mkdir_path = options.path;
				return base_mkdir(options);
			};

			await write_dependency_updates_changeset(
				repo,
				[
					{
						package_name: 'dep',
						from_version: '0.1.0',
						to_version: '0.2.0',
						bump_type: 'minor',
						breaking: true
					}
				],
				{ fs_ops: fs }
			);

			assert.strictEqual(mkdir_path, '/test/pkg/.changeset');
		});

		const change = (
			package_name: string,
			from_version: string,
			to_version: string,
			breaking = true
		): DependencyVersionChange => ({
			package_name,
			from_version,
			to_version,
			bump_type: 'minor',
			breaking
		});

		test('merges each publish into the one changeset', async () => {
			const repo = create_mock_repo({ name: 'ui', version: '0.220.0' });
			const fs = create_mock_fs_ops();

			await write_dependency_updates_changeset(repo, [change('util', '0.78.0', '0.79.0')], {
				fs_ops: fs
			});
			const path = await write_dependency_updates_changeset(
				repo,
				[change('css', '0.71.1', '0.72.0')],
				{ fs_ops: fs }
			);

			const content = fs.get(path)!;
			assert.strictEqual(content.match(/^"ui": minor$/gm)?.length, 1);
			assert.deepEqual(
				parse_dependency_updates_changeset(content, 'ui')?.updates.map((u) => u.package_name),
				['util', 'css']
			);
		});

		test('keeps a bump raised by hand in the frontmatter', async () => {
			const repo = create_mock_repo({ name: 'pkg', version: '1.0.0' });
			const fs = create_mock_fs_ops();
			const path = await write_dependency_updates_changeset(
				repo,
				[change('a', '1.0.0', '1.0.1', false)],
				{ fs_ops: fs }
			);
			fs.set(path, fs.get(path)!.replace('"pkg": patch', '"pkg": major'));

			await write_dependency_updates_changeset(repo, [change('b', '2.0.0', '2.0.1', false)], {
				fs_ops: fs
			});

			assert.include(fs.get(path)!, '"pkg": major');
		});

		test("refuses to overwrite a file at its name that isn't its own", async () => {
			const repo = create_mock_repo({ name: 'pkg', version: '1.0.0' });
			const fs = create_mock_fs_ops();
			fs.set(
				'/test/pkg/.changeset/dependency-updates.md',
				'---\n"pkg": patch\n---\n\nhand-written\n'
			);

			let error: unknown;
			try {
				await write_dependency_updates_changeset(repo, [change('dep', '1.0.0', '2.0.0')], {
					fs_ops: fs
				});
			} catch (e) {
				error = e;
			}

			assert(error instanceof Error);
			assert.include(error.message, "isn't an auto-generated dependency changeset");
			assert.include(fs.get('/test/pkg/.changeset/dependency-updates.md')!, 'hand-written');
		});
	});

	describe('parse_dependency_updates_changeset', () => {
		test('reads back what generate_changeset_content wrote', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: '@scope/a',
					from_version: '1.0.0',
					to_version: '2.0.0',
					bump_type: 'major',
					breaking: true
				},
				{
					package_name: 'b',
					from_version: '1.0.0',
					to_version: '1.0.1',
					bump_type: 'patch',
					breaking: false
				}
			];
			const content = generate_changeset_content('pkg', updates, 'major');
			assert.deepEqual(parse_dependency_updates_changeset(content, 'pkg'), {
				bump_type: 'major',
				updates
			});
			assert.deepEqual(
				parse_dependency_updates_changeset(content.replaceAll('\n', '\r\n'), 'pkg')?.updates,
				updates
			);
		});

		test('round-trips a range with spaces', () => {
			const updates: Array<DependencyVersionChange> = [
				{
					package_name: 'a',
					from_version: '1.0.0 - 2.0.0',
					to_version: '2.1.0',
					bump_type: 'minor',
					breaking: false
				}
			];
			const content = generate_changeset_content('pkg', updates, 'patch');
			assert.deepEqual(parse_dependency_updates_changeset(content, 'pkg')?.updates, updates);
		});

		test('rejects anything it did not write', () => {
			const ours = generate_changeset_content(
				'pkg',
				[
					{
						package_name: 'a',
						from_version: '1.0.0',
						to_version: '1.1.0',
						bump_type: 'minor',
						breaking: false
					}
				],
				'patch'
			);
			assert.ok(parse_dependency_updates_changeset(ours, 'pkg'));
			for (const content of [
				'---\n"pkg": patch\n---\n\nfix: a thing\n',
				ours.replace('Updated dependencies:', 'Updated dependencies:\nsome prose'),
				ours + '\na note added by hand\n'
			]) {
				assert.strictEqual(parse_dependency_updates_changeset(content, 'pkg'), null);
			}
			// another package's
			assert.strictEqual(parse_dependency_updates_changeset(ours, 'other'), null);
		});
	});

	describe('merge_dependency_updates', () => {
		test('keeps the first from_version and takes the later to_version and larger bump', () => {
			const merged = merge_dependency_updates(
				[
					{
						package_name: 'a',
						from_version: '1.0.0',
						to_version: '1.0.1',
						bump_type: 'patch',
						breaking: false
					}
				],
				[
					{
						package_name: 'a',
						from_version: '1.0.1',
						to_version: '2.0.0',
						bump_type: 'major',
						breaking: true
					},
					{
						package_name: 'b',
						from_version: '3.0.0',
						to_version: '3.1.0',
						bump_type: 'minor',
						breaking: false
					}
				]
			);
			assert.deepEqual(merged, [
				{
					package_name: 'a',
					from_version: '1.0.0',
					to_version: '2.0.0',
					bump_type: 'major',
					breaking: true
				},
				{
					package_name: 'b',
					from_version: '3.0.0',
					to_version: '3.1.0',
					bump_type: 'minor',
					breaking: false
				}
			]);
		});
	});
});
