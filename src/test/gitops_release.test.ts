import { assert, describe, test } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { join } from 'node:path';

import {
	Args,
	run_gitops_release,
	type GitopsReleaseDeps,
	type GitopsReleaseResult
} from '#lib/gitops_release.task.ts';
import { parse_changeset_content } from '#lib/changeset_reader.ts';
import type { LocalRepo } from '#lib/local_repo.ts';
import type { ChangesetOperations, FsOperations } from '#lib/operations.ts';
import type { ReposEntryStatus } from '#lib/repos_status.ts';
import { calculate_next_version, compare_bump_types, type BumpType } from '#lib/version_utils.ts';
import {
	AT_REST,
	create_mock_git_ops,
	create_mock_repo,
	create_mock_repos_entry,
	create_mock_repos_report,
	create_stream_log,
	entry_with
} from './test_helpers.ts';

interface PackageJsonData {
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/**
 * An in-memory workspace: each repo's `package.json` and changesets as files,
 * the registry as the set of versions it shows, and the commits made — enough
 * to step a release from start to done the way a person would, publishing
 * each wave by hand between steps.
 */
const create_world = (
	packages: Array<PackageJsonData>,
	changesets: Record<string, string> = {}
) => {
	const files: Map<string, string> = new Map();
	const dir_of = (name: string): string => `/test/${name}`;
	const package_json_path = (name: string): string => join(dir_of(name), 'package.json');
	for (const pkg of packages) {
		files.set(package_json_path(pkg.name), JSON.stringify(pkg, null, '\t'));
	}
	for (const [name, bump] of Object.entries(changesets)) {
		files.set(
			join(dir_of(name), '.changeset', 'change.md'),
			`---\n"${name}": ${bump}\n---\n\nchange\n`
		);
	}
	const registry: Set<string> = new Set(packages.map((p) => `${p.name}@${p.version}`));
	const commits: Array<{ cwd: string; message: string; files: Array<string> }> = [];
	const entries: Map<string, ReposEntryStatus> = new Map();

	const read_package = (name: string): PackageJsonData =>
		JSON.parse(files.get(package_json_path(name))!);
	const changeset_files = (name: string): Array<[string, string]> =>
		Array.from(files).filter(([path]) => path.startsWith(join(dir_of(name), '.changeset') + '/'));

	const fs_ops: FsOperations = {
		readFile: async ({ path }) => {
			const value = files.get(path);
			return value === undefined
				? { ok: false, kind: 'not_found', message: `no ${path}` }
				: { ok: true, value };
		},
		writeFile: async ({ path, content }) => {
			files.set(path, content);
			return { ok: true };
		},
		mkdir: async () => ({ ok: true }),
		exists: async ({ path }) =>
			files.has(path) || Array.from(files.keys()).some((p) => p.startsWith(path + '/'))
	};

	/** The bump each package's changeset files give it, as `changeset version` would. */
	const changeset_bump = (name: string): BumpType | null => {
		let bump: BumpType | null = null;
		for (const [path, content] of changeset_files(name)) {
			const info = parse_changeset_content(content, path);
			for (const p of info?.packages ?? []) {
				if (p.name === name && (!bump || compare_bump_types(p.bump_type, bump) > 0)) {
					bump = p.bump_type;
				}
			}
		}
		return bump;
	};

	const changeset_ops: ChangesetOperations = {
		has_changesets: async ({ repo }) => ({
			ok: true,
			value: changeset_files(repo.library.name).length > 0
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async ({ repo }) => {
			const bump = changeset_bump(repo.library.name);
			if (!bump) return null;
			const current = repo.package_json.version || '0.0.0';
			return { ok: true, version: calculate_next_version(current, bump), bump_type: bump };
		}
	};

	const to_local_repo = (name: string): LocalRepo => {
		const pkg = read_package(name);
		const repo = create_mock_repo({
			name,
			version: pkg.version,
			private: pkg.private,
			deps: pkg.dependencies,
			peer_deps: pkg.peerDependencies,
			dev_deps: pkg.devDependencies
		});
		repo.entry = entries.get(name) ?? create_mock_repos_entry({ key: name });
		return repo;
	};

	const deps: Partial<GitopsReleaseDeps> = {
		load_repos: async () => {
			const local_repos = packages.map((p) => to_local_repo(p.name));
			return {
				local_repos,
				report: create_mock_repos_report(
					local_repos.map((r) => r.entry),
					{ fetched: true }
				)
			};
		},
		changeset_ops,
		npm_ops: {
			view_version: async ({ pkg, version }) => ({
				ok: true,
				value: registry.has(`${pkg}@${version}`)
					? 'listed'
					: Array.from(registry).some((v) => v.startsWith(`${pkg}@`))
						? 'unlisted'
						: 'unknown'
			}),
			wait_for_package: async ({ pkg, version }) =>
				registry.has(`${pkg}@${version}`) ? { ok: true } : { ok: false, message: 'timed out' }
		},
		git_ops: create_mock_git_ops({
			commit: async ({ message, files: committed, cwd }) => {
				commits.push({ cwd: cwd ?? '', message, files: committed });
				return { ok: true };
			}
		}),
		fs_ops,
		cwd: '/test/host'
	};

	/**
	 * Publishes a package by hand, as `gro publish` would: bumps its version per
	 * its changesets, consumes them, and (unless `visible` is false, still
	 * propagating) puts the version on the registry.
	 */
	const publish = (name: string, visible = true): string => {
		const bump = changeset_bump(name);
		assert.ok(bump, `${name} has nothing to publish`);
		const pkg = read_package(name);
		pkg.version = calculate_next_version(pkg.version, bump);
		files.set(package_json_path(name), JSON.stringify(pkg, null, '\t'));
		for (const [path] of changeset_files(name)) files.delete(path);
		if (visible) registry.add(`${name}@${pkg.version}`);
		return pkg.version;
	};

	return {
		deps,
		files,
		registry,
		commits,
		entries,
		read_package,
		publish,
		show: (name: string): void => {
			registry.add(`${name}@${read_package(name).version}`);
		},
		step: async (args: Partial<Args> = {}): Promise<GitopsReleaseResult> =>
			run_gitops_release(
				s.parse_or_throw(Args, { wetrun: true, ...args }),
				create_stream_log(),
				deps
			)
	};
};

/** core ← ui ← app, with docs dev-depending on core and a private site on ui. */
const create_cascade = () =>
	create_world(
		[
			{ name: 'core', version: '0.1.0' },
			{ name: 'ui', version: '0.1.0', peerDependencies: { core: '>=0.1.0' } },
			{ name: 'app', version: '0.1.0', dependencies: { ui: '^0.1.0' } },
			{ name: 'docs', version: '0.1.0', devDependencies: { core: '^0.1.0' } },
			{ name: 'site', version: '0.0.1', private: true, dependencies: { ui: '^0.1.0' } }
		],
		{ core: 'minor' }
	);

describe('run_gitops_release', () => {
	test('steps a breaking cascade to done, a wave at a time', async () => {
		const world = create_cascade();

		// 1: core has changesets; nothing is released yet, so it publishes alone
		let step = await world.step();
		assert.deepEqual(step.state.publish_now, ['core']);
		assert.deepEqual(step.rewritten, []);
		assert.deepEqual(step.plan.waves, [['core'], ['ui'], ['app']]);
		world.publish('core');

		// 2: core 0.2.0 is out, so its dependents' ranges move, ui's with a changeset
		step = await world.step();
		assert.deepEqual(step.rewritten.sort(), ['docs', 'ui']);
		assert.strictEqual(world.read_package('ui').peerDependencies!.core, '>=0.2.0');
		assert.strictEqual(world.read_package('docs').devDependencies!.core, '^0.2.0');
		assert.ok(world.files.has('/test/ui/.changeset/dependency-updates.md'));
		assert.ok(!world.files.has('/test/docs/.changeset/dependency-updates.md'));
		assert.deepEqual(step.state.publish_now, ['ui']);
		world.publish('ui');

		// 3: ui 0.2.0 (breaking, from core) is out: app and the private site move
		step = await world.step();
		assert.deepEqual(step.rewritten.sort(), ['app', 'site']);
		assert.strictEqual(world.read_package('app').dependencies!.ui, '^0.2.0');
		assert.strictEqual(world.read_package('site').dependencies!.ui, '^0.2.0');
		assert.ok(!world.files.has('/test/site/.changeset/dependency-updates.md'));
		assert.deepEqual(step.state.publish_now, ['app']);
		world.publish('app');

		// 4: done, and a step more changes nothing
		step = await world.step();
		assert.strictEqual(step.state.done, true);
		const commits = world.commits.length;
		await world.step();
		assert.strictEqual(world.commits.length, commits);

		assert.strictEqual(world.read_package('core').version, '0.2.0');
		assert.strictEqual(world.read_package('ui').version, '0.2.0');
		assert.strictEqual(world.read_package('app').version, '0.2.0');
		assert.strictEqual(world.read_package('docs').version, '0.1.0'); // dev-only, no republish
	});

	test('a version still propagating holds its dependents until the registry shows it', async () => {
		const world = create_cascade();
		await world.step();
		world.publish('core', false);

		let step = await world.step();
		assert.deepEqual(step.plan.awaiting_registry, [{ name: 'core', version: '0.2.0' }]);
		assert.deepEqual(step.rewritten, []);
		assert.deepEqual(step.state.publish_now, []);
		assert.deepEqual(
			step.state.publish_held.map((h) => h.name),
			['ui']
		);

		world.show('core');
		step = await world.step();
		assert.deepEqual(step.rewritten.sort(), ['docs', 'ui']);
	});

	test('--wait waits out the registry, then reads the state again', async () => {
		const world = create_cascade();
		await world.step();
		world.publish('core', false);
		const deps = world.deps;
		const wait_for_package = deps.npm_ops!.wait_for_package;
		deps.npm_ops!.wait_for_package = async (options) => {
			world.show(options.pkg);
			return wait_for_package(options);
		};

		const step = await world.step({ wait: true });
		assert.deepEqual(step.plan.awaiting_registry, []);
		assert.deepEqual(step.rewritten.sort(), ['docs', 'ui']);
	});

	test('picks up a cascade stopped after a publish, rewriting the dependents it missed', async () => {
		// core 0.2.0 went out by hand earlier; nothing has changesets and the ranges still lag
		const world = create_world([
			{ name: 'core', version: '0.2.0' },
			{ name: 'ui', version: '0.1.0', peerDependencies: { core: '>=0.1.0' } }
		]);
		const step = await world.step();
		assert.deepEqual(step.rewritten, ['ui']);
		assert.ok(world.files.has('/test/ui/.changeset/dependency-updates.md'));
		assert.deepEqual(step.state.publish_now, ['ui']);
	});

	test('without --wetrun it writes and commits nothing', async () => {
		const world = create_cascade();
		await world.step();
		world.publish('core');
		const before = new Map(world.files);

		const step = await world.step({ wetrun: false });

		assert.deepEqual(step.rewritten, []);
		assert.deepEqual(step.state.rewrites.map((r) => r.name).sort(), ['docs', 'ui']);
		assert.deepEqual(world.files, before);
		assert.strictEqual(world.commits.length, 0);
	});

	test('a dependent that is not ready is held, and the others still move', async () => {
		const world = create_cascade();
		await world.step();
		world.publish('core');
		world.entries.set(
			'ui',
			entry_with('ui', {
				checkout: { uncommitted: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } },
				at_rest: { ...AT_REST, clean: false }
			})
		);

		const step = await world.step();

		assert.deepEqual(step.rewritten, ['docs']);
		assert.deepEqual(
			step.state.rewrites_held.map((h) => h.name),
			['ui']
		);
		assert.include(step.state.rewrites_held[0]!.reasons[0], 'uncommitted changes');
		assert.deepEqual(step.state.publish_now, []);
	});

	test('a first publish still propagating holds its dependents until it shows', async () => {
		const world = create_world(
			[
				{ name: 'new', version: '0.0.1' },
				{ name: 'app', version: '0.1.0', dependencies: { new: '^0.0.1' } }
			],
			{ new: 'minor' }
		);
		world.registry.delete('new@0.0.1');

		let step = await world.step();
		assert.deepEqual(step.state.publish_now, ['new']);
		world.publish('new', false);

		// npm answers E404 until the first publish shows: not done, app held
		step = await world.step();
		assert.deepEqual(step.plan.never_published, []);
		assert.deepEqual(step.plan.awaiting_registry, [{ name: 'new', version: '0.1.0' }]);
		assert.deepEqual(step.rewritten, []);
		assert.deepEqual(
			step.state.publish_held.map((h) => h.name),
			['app']
		);
		assert.strictEqual(step.state.done, false);

		world.show('new');
		step = await world.step();
		assert.deepEqual(step.rewritten, ['app']);
		assert.strictEqual(world.read_package('app').dependencies!.new, '^0.1.0');
		assert.deepEqual(step.state.publish_now, ['app']);
	});

	test('a dependency that is not ready holds its dependents with it', async () => {
		// core 0.2.0 is out, but its checkout is dirty and may hide a changeset
		const world = create_world([
			{ name: 'core', version: '0.2.0' },
			{ name: 'ui', version: '0.1.0', peerDependencies: { core: '>=0.1.0' } }
		]);
		world.entries.set(
			'core',
			entry_with('core', {
				checkout: { uncommitted: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 } },
				at_rest: { ...AT_REST, clean: false }
			})
		);

		const step = await world.step();

		assert.deepEqual(step.rewritten, []);
		assert.strictEqual(world.commits.length, 0);
		assert.deepEqual(
			step.state.rewrites_held.map((h) => h.name),
			['ui']
		);
		assert.include(step.state.rewrites_held[0]!.reasons[0], "core's repo isn't ready");
		assert.deepEqual(step.state.publish_now, []);
		assert.strictEqual(step.state.done, false);
	});

	test('a never-published package with nothing to publish lets the release finish', async () => {
		const world = create_world([
			{ name: 'core', version: '0.1.0' },
			{ name: 'site', version: '0.0.1', dependencies: { core: '^0.1.0' } }
		]);
		world.registry.delete('site@0.0.1');
		const step = await world.step();
		assert.deepEqual(step.plan.never_published, ['site']);
		assert.strictEqual(step.state.done, true);
	});

	test('a registry that can not answer stops the step before any write', async () => {
		const world = create_cascade();
		world.deps.npm_ops!.view_version = async () => ({ ok: false, message: 'ENOTFOUND' });
		await assert_rejects(() => world.step(), /couldn't read the registry/);
		assert.strictEqual(world.commits.length, 0);
	});

	test('names each repo to publish with its command, from the cwd', async () => {
		const world = create_world(
			[
				{ name: 'a', version: '0.1.0' },
				{ name: 'b', version: '0.1.0' }
			],
			{ a: 'patch', b: 'patch' }
		);
		world.entries.set('b', create_mock_repos_entry({ key: 'b', branch: 'next' }));
		const log = create_stream_log();
		await run_gitops_release(s.parse_or_throw(Args, {}), log, world.deps);
		const lines = log.lines.join('\n');
		assert.include(lines, 'cd ../a && gro publish');
		assert.include(lines, 'cd ../b && gro publish --branch next');
		assert.include(lines, '(cd ../a && gro publish) && (cd ../b && gro publish --branch next)');
	});
});
