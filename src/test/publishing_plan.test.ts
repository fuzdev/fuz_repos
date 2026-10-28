import { assert, test } from 'vitest';

import type { LocalRepo } from '#lib/local_repo.ts';
import { generate_publishing_plan, version_change_kind } from '#lib/publishing_plan.ts';
import { log_publishing_plan } from '#lib/publishing_plan_logging.ts';
import type { ChangesetOperations } from '#lib/operations.ts';
import { parse_changeset_content } from '#lib/changeset_reader.ts';
import type { RegistryVersion } from '#lib/npm_registry.ts';
import { create_mock_repo, create_stream_log } from './test_helpers.ts';

test('detects breaking change cascades', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0' }),
		create_mock_repo({ name: 'pkg-b', version: '0.2.0', deps: { 'pkg-a': '0.1.0' } }),
		create_mock_repo({ name: 'pkg-c', version: '0.3.0', deps: { 'pkg-b': '0.2.0' } })
	];

	// Mock changeset operations to simulate breaking changes
	const mock_ops: ChangesetOperations = {
		has_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name === 'pkg-a'
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) => {
			if (options.repo.library.name === 'pkg-a') {
				// Simulate a breaking change for pkg-a
				return { ok: true, version: '0.2.0', bump_type: 'minor' as const };
			}
			return null;
		}
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// pkg-a should have a breaking change (0.x.x minor bump)
	assert.strictEqual(
		plan.version_changes.find((vc) => vc.package_name === 'pkg-a')?.breaking,
		true
	);

	// pkg-b should cascade the breaking change
	assert.strictEqual(plan.breaking_cascades.has('pkg-a'), true);
	assert.ok(plan.breaking_cascades.get('pkg-a')!.includes('pkg-b'));
});

test('handles bump escalation', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0' }),
		create_mock_repo({ name: 'pkg-b', version: '0.2.0', deps: { 'pkg-a': '0.1.0' } })
	];

	// Mock operations where pkg-a has breaking change and pkg-b has patch
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) => {
			if (options.repo.library.name === 'pkg-a') {
				return { ok: true, version: '0.2.0', bump_type: 'minor' as const }; // breaking
			}
			if (options.repo.library.name === 'pkg-b') {
				return { ok: true, version: '0.2.1', bump_type: 'patch' as const }; // non-breaking
			}
			return null;
		}
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// pkg-b should have bump escalation due to breaking dep
	const pkg_b_change = plan.version_changes.find((vc) => vc.package_name === 'pkg-b');
	assert.strictEqual(pkg_b_change?.needs_bump_escalation, true);
	assert.strictEqual(pkg_b_change?.required_bump, 'minor');
});

test('generates auto-changesets for dependency updates', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0' }),
		create_mock_repo({ name: 'pkg-b', version: '0.2.0', deps: { 'pkg-a': '0.1.0' } }),
		create_mock_repo({ name: 'pkg-c', version: '0.3.0', dev_deps: { 'pkg-a': '0.1.0' } }) // devDep only
	];

	// Mock operations where only pkg-a has changesets
	const mock_ops: ChangesetOperations = {
		has_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name === 'pkg-a'
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) => {
			if (options.repo.library.name === 'pkg-a') {
				return { ok: true, version: '0.1.1', bump_type: 'patch' as const };
			}
			return null;
		}
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// pkg-b should get auto-changeset for dependency update
	const pkg_b_change = plan.version_changes.find((vc) => vc.package_name === 'pkg-b');
	assert.strictEqual(pkg_b_change?.will_generate_changeset, true);
	assert.strictEqual(pkg_b_change?.has_changesets, false);

	// pkg-c should not get auto-changeset (dev dependency only)
	const pkg_c_change = plan.version_changes.find((vc) => vc.package_name === 'pkg-c');
	assert.strictEqual(pkg_c_change, undefined);
});

test('handles circular dev dependencies', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0', dev_deps: { 'pkg-b': '0.2.0' } }),
		create_mock_repo({ name: 'pkg-b', version: '0.2.0', dev_deps: { 'pkg-a': '0.1.0' } })
	];

	// Mock operations with no changesets
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// Should have info about dev cycles (not warnings anymore)
	assert.ok(plan.info.some((i) => i.includes('dev dependency cycle(s) detected')));

	// Nothing publishes, so there are no waves
	assert.deepEqual(plan.waves, []);

	// Should not have errors
	assert.strictEqual(plan.errors.length, 0);
});

test('detects production circular dependencies', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0', deps: { 'pkg-b': '0.2.0' } }),
		create_mock_repo({ name: 'pkg-b', version: '0.2.0', deps: { 'pkg-a': '0.1.0' } })
	];

	// Mock operations with no changesets
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// Should have errors for production cycles
	assert.ok(plan.errors.some((e) => e.includes('Production dependency cycle')));

	// Should not compute waves
	assert.deepEqual(plan.waves, []);
});

test('a deep breaking chain resolves in one pass, one wave per level', async () => {
	// listed dependents first, so config order is the worst case for the pass
	const repos: Array<LocalRepo> = Array.from({ length: 12 }, (_, i) => {
		const level = 12 - i;
		return create_mock_repo({
			name: `level-${level}`,
			version: '0.1.0',
			deps: level === 1 ? undefined : { [`level-${level - 1}`]: '^0.1.0' }
		});
	});
	const mock_ops: ChangesetOperations = {
		has_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name === 'level-1'
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) =>
			options.repo.library.name === 'level-1'
				? { ok: true, version: '0.2.0', bump_type: 'minor' as const }
				: null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.strictEqual(plan.version_changes.length, repos.length);
	assert.ok(plan.version_changes.every((vc) => vc.breaking && vc.to === '0.2.0'));
	assert.deepEqual(
		plan.waves,
		Array.from({ length: 12 }, (_, i) => [`level-${i + 1}`])
	);
	assert.deepEqual(plan.warnings, []);
});

test('waves put packages that do not depend on each other together', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'app', version: '0.1.0', deps: { ui: '^0.1.0', css: '^0.1.0' } }),
		create_mock_repo({ name: 'ui', version: '0.1.0', deps: { util: '^0.1.0' } }),
		create_mock_repo({ name: 'css', version: '0.1.0', deps: { util: '^0.1.0' } }),
		create_mock_repo({ name: 'util', version: '0.1.0' }),
		create_mock_repo({ name: 'docs', version: '0.1.0' })
	];
	const with_changesets = new Set(['util', 'docs']);
	const mock_ops: ChangesetOperations = {
		has_changesets: async (options) => ({
			ok: true,
			value: with_changesets.has(options.repo.library.name)
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => ({
			ok: true,
			version: '0.1.1',
			bump_type: 'patch' as const
		})
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(
		plan.waves.map((wave) => [...wave].sort()),
		[['docs', 'util'], ['css', 'ui'], ['app']]
	);
});

test('a range lagging its dependency is rewritten, and the move counts from its base', async () => {
	// `lib` released 0.55.0 already; `app` still names ^0.54.0, which skips a breaking minor
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'lib', version: '0.55.0' }),
		create_mock_repo({ name: 'app', version: '0.3.0', peer_deps: { lib: '>=0.54.0' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.dependency_updates, [
		{
			dependent_package: 'app',
			updated_dependency: 'lib',
			current_version: '>=0.54.0',
			new_version: '0.55.0',
			type: 'peerDependencies',
			breaking: true
		}
	]);
	const app = plan.version_changes.find((vc) => vc.package_name === 'app');
	assert.ok(app);
	assert.strictEqual(version_change_kind(app), 'auto');
	assert.strictEqual(app.to, '0.4.0');
	assert.deepEqual(plan.waves, [['app']]);
	assert.deepEqual(plan.breaking_cascades.get('lib'), ['app']);
});

test("a patch release is breaking for a range that lags behind the dependency's last minor", async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'lib', version: '0.55.0' }),
		create_mock_repo({ name: 'app', version: '0.3.0', deps: { lib: '^0.54.0' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async (options) => ({ ok: true, value: options.repo.library.name === 'lib' }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => ({ ok: true, version: '0.55.1', bump_type: 'patch' as const })
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	const lib = plan.version_changes.find((vc) => vc.package_name === 'lib');
	assert.strictEqual(lib?.breaking, false);
	const update = plan.dependency_updates.find((u) => u.dependent_package === 'app');
	assert.strictEqual(update?.new_version, '0.55.1');
	assert.strictEqual(update?.breaking, true);
	assert.strictEqual(plan.version_changes.find((vc) => vc.package_name === 'app')?.to, '0.4.0');
});

test('a range staged ahead of its dependency is left alone', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'lib', version: '0.55.0' }),
		create_mock_repo({ name: 'app', version: '0.3.0', deps: { lib: '^0.56.0' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.dependency_updates, []);
	assert.deepEqual(plan.version_changes, []);
});

test('a dependent waits on a dependency that publishes even when its range needs no move', async () => {
	// `app` already names lib's predicted version, so no rewrite, yet it must publish after lib
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'lib', version: '0.1.0' }),
		create_mock_repo({ name: 'app', version: '0.1.0', deps: { lib: '^0.1.1' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => ({ ok: true, version: '0.1.1', bump_type: 'patch' as const })
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.waves, [['lib'], ['app']]);
});

test('a current version the registry lacks, with no changesets, is awaiting the registry', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'lib', version: '0.2.0' }),
		create_mock_repo({ name: 'other', version: '1.0.0' }),
		create_mock_repo({ name: 'app', version: '0.1.0', deps: { lib: '^0.1.0' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};
	const registry = new Map<string, RegistryVersion>([
		['lib', 'unlisted'],
		['other', 'listed'],
		['app', 'listed']
	]);

	const plan = await generate_publishing_plan(repos, { ops: mock_ops, registry });

	assert.deepEqual(plan.awaiting_registry, [{ name: 'lib', version: '0.2.0' }]);
	assert.ok(!plan.no_changes.includes('lib'));
	// the dependent still plans its rewrite and republish, which the release step holds
	assert.ok(plan.version_changes.some((vc) => vc.package_name === 'app'));
	// without observations, nothing awaits
	assert.deepEqual(
		(await generate_publishing_plan(repos, { ops: mock_ops })).awaiting_registry,
		[]
	);
});

test('excludes non-npm (cargo) repos from the plan', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '1.0.0' }),
		create_mock_repo({ name: 'rust-tool', version: '0.1.0', kind: 'cargo' })
	];

	// Even when the cargo repo "has changesets", it must be filtered out before any
	// changeset processing — so the filter, not the private/changeset logic, excludes it.
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) => ({
			ok: true,
			version: options.repo.library.name === 'pkg-a' ? '1.0.1' : '0.1.1',
			bump_type: 'patch' as const
		})
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	// The npm package still plans normally...
	assert.ok(plan.waves.flat().includes('pkg-a'));
	assert.ok(plan.version_changes.some((vc) => vc.package_name === 'pkg-a'));
	// ...while the cargo repo is absent from the order and version changes...
	assert.ok(!plan.waves.flat().includes('rust-tool'));
	assert.ok(!plan.version_changes.some((vc) => vc.package_name === 'rust-tool'));
	// ...and the exclusion is reported rather than silent.
	assert.ok(plan.info.some((line) => line.includes('non-npm') && line.includes('rust-tool')));
	// The sentence stays out of the package-name list
	assert.deepEqual(plan.no_changes, []);
});

test('lists packages with nothing to publish apart from info sentences', async () => {
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'pkg-a', version: '0.1.0', dev_deps: { 'pkg-b': '0.1.0' } }),
		create_mock_repo({ name: 'pkg-b', version: '0.1.0', dev_deps: { 'pkg-a': '0.1.0' } })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: false }),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.no_changes, ['pkg-a', 'pkg-b']);
	assert.deepEqual(plan.info, [
		'1 dev dependency cycle(s) detected (normal, shown in gitops_analyze)'
	]);
});

// `app` is listed before `lib`, which escalates to breaking, so a pass in config order
// would reach `app` before its dependency settled; the pass runs in dependency order.
const create_config_order_case = (): { repos: Array<LocalRepo>; ops: ChangesetOperations } => ({
	repos: [
		create_mock_repo({ name: 'app', version: '0.3.0', deps: { lib: '^0.2.0' } }),
		create_mock_repo({ name: 'lib', version: '0.2.0', deps: { core: '^0.1.0' } }),
		create_mock_repo({ name: 'core', version: '0.1.0' })
	],
	ops: {
		has_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name !== 'app'
		}),
		read_changesets: async () => ({ ok: true, value: [] }),
		predict_next_version: async (options) => {
			const name = options.repo.library.name;
			if (name === 'core') return { ok: true, version: '0.2.0', bump_type: 'minor' as const };
			if (name === 'lib') return { ok: true, version: '0.2.1', bump_type: 'patch' as const };
			return null;
		}
	}
});

test('a dependent listed before its escalating dependency gets the settled auto bump', async () => {
	const { repos, ops } = create_config_order_case();

	const plan = await generate_publishing_plan(repos, { ops });

	assert.deepEqual(plan.waves, [['core'], ['lib'], ['app']]);
	const kinds = new Map(plan.version_changes.map((vc) => [vc.package_name, vc]));

	const lib = kinds.get('lib');
	assert.ok(lib);
	assert.strictEqual(version_change_kind(lib), 'escalation');
	assert.strictEqual(lib.existing_bump, 'patch');
	assert.strictEqual(lib.to, '0.3.0');

	const app = kinds.get('app');
	assert.ok(app);
	assert.strictEqual(version_change_kind(app), 'auto');
	assert.strictEqual(app.will_generate_changeset, true);
	assert.strictEqual(app.needs_bump_escalation, undefined);
	assert.strictEqual(app.existing_bump, undefined);
	assert.strictEqual(app.bump_type, 'minor');
	assert.strictEqual(app.to, '0.4.0');
	assert.strictEqual(app.breaking, true);
});

test('the logged plan lists each change once', async () => {
	const { repos, ops } = create_config_order_case();
	const plan = await generate_publishing_plan(repos, { ops });

	const log = create_stream_log();
	log_publishing_plan(plan, log);

	const positions = log.lines.filter((line) => /\[\d+\/\d+\]/.test(line));
	assert.deepEqual(
		positions.map((line) => /\[(\d+\/\d+)\]/.exec(line)![1]),
		['1/3', '2/3', '3/3']
	);
	assert.strictEqual(log.lines.filter((line) => line.includes('changesets specify')).length, 1);
	assert.ok(positions.some((line) => line.includes('app:') && line.includes('[auto-changeset]')));
});

test('warns on a repo whose changesets yield no bump for its package', async () => {
	const named_other = parse_changeset_content('---\n"other": patch\n---\n\nfix\n', 'other.md');
	assert.ok(named_other);
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'unnamed', version: '0.1.0' }),
		create_mock_repo({ name: 'unparsed', version: '0.1.0' })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name === 'unnamed' ? [named_other] : []
		}),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.version_changes, []);
	assert.deepEqual(plan.no_changes, []);
	assert.strictEqual(plan.warnings.length, 2);
	const unnamed = plan.warnings.find((w) => w.startsWith('unnamed '));
	assert.ok(unnamed);
	assert.ok(unnamed.includes('none that parses names unnamed'));
	assert.ok(unnamed.includes('will not publish'));
	const unparsed = plan.warnings.find((w) => w.startsWith('unparsed '));
	assert.ok(unparsed?.includes('none parses'));
});

test('warns on a repo whose changeset files could not be read', async () => {
	const repos: Array<LocalRepo> = [create_mock_repo({ name: 'unreadable', version: '0.1.0' })];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async () => ({ ok: false, message: 'EACCES' }),
		predict_next_version: async () => null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	assert.deepEqual(plan.version_changes, []);
	assert.deepEqual(plan.errors, []);
	assert.strictEqual(plan.warnings.length, 1);
	const warning = plan.warnings[0]!;
	assert.ok(warning.startsWith('unreadable has changeset files that could not be read (EACCES)'));
	assert.ok(warning.includes('will not publish'));
});

test('a repo whose changesets yield no bump is warned it publishes only as an auto change', async () => {
	const named_old = parse_changeset_content('---\n"old-name": patch\n---\n\nfix\n', 'old.md');
	assert.ok(named_old);
	const repos: Array<LocalRepo> = [
		create_mock_repo({ name: 'app', version: '0.3.0', deps: { lib: '^0.2.0' } }),
		create_mock_repo({ name: 'lib', version: '0.2.0' })
	];
	const mock_ops: ChangesetOperations = {
		has_changesets: async () => ({ ok: true, value: true }),
		read_changesets: async (options) => ({
			ok: true,
			value: options.repo.library.name === 'app' ? [named_old] : []
		}),
		predict_next_version: async (options) =>
			options.repo.library.name === 'lib'
				? { ok: true, version: '0.3.0', bump_type: 'minor' as const }
				: null
	};

	const plan = await generate_publishing_plan(repos, { ops: mock_ops });

	const app = plan.version_changes.find((vc) => vc.package_name === 'app');
	assert.ok(app);
	assert.strictEqual(version_change_kind(app), 'auto');
	assert.strictEqual(plan.warnings.length, 1);
	const warning = plan.warnings[0]!;
	assert.ok(warning.startsWith('app has changeset files, but none that parses names app'));
	assert.ok(warning.includes('publishes only as the auto-generated change'));
	assert.ok(!warning.includes('will not publish'));
	assert.ok(warning.includes('check the package names in their frontmatter'));
});

test('checks each repo for changesets once', async () => {
	const { repos, ops } = create_config_order_case();
	const checked: Array<string> = [];
	const plan = await generate_publishing_plan(repos, {
		ops: {
			...ops,
			has_changesets: async (options) => {
				checked.push(options.repo.library.name);
				return ops.has_changesets(options);
			}
		}
	});

	assert.strictEqual(plan.version_changes.length, 3);
	assert.deepEqual([...checked].sort(), ['app', 'core', 'lib']);
});
