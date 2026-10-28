import { assert, describe, test } from 'vitest';

import type { LocalRepo } from '#lib/local_repo.ts';
import type { ChangesetOperations } from '#lib/operations.ts';
import { generate_publishing_plan } from '#lib/publishing_plan.ts';
import { to_release_state } from '#lib/release_state.ts';
import type { RegistryVersion } from '#lib/npm_registry.ts';
import { create_mock_repo } from './test_helpers.ts';

/** Changeset ops where `bumps` names each package with changesets and its predicted version. */
const create_ops = (bumps: Record<string, string>): ChangesetOperations => ({
	has_changesets: async (options) => ({
		ok: true,
		value: options.repo.library.name in bumps
	}),
	read_changesets: async () => ({ ok: true, value: [] }),
	predict_next_version: async (options) => {
		const version = bumps[options.repo.library.name];
		return version ? { ok: true, version, bump_type: 'minor' as const } : null;
	}
});

const plan_state = async (
	repos: Array<LocalRepo>,
	bumps: Record<string, string>,
	options: {
		registry?: Map<string, RegistryVersion>;
		not_ready?: Map<string, Array<string>>;
		held_all?: Array<string>;
	} = {}
) => {
	const plan = await generate_publishing_plan(repos, {
		ops: create_ops(bumps),
		registry: options.registry
	});
	return {
		plan,
		state: to_release_state({
			plan,
			repos,
			not_ready: options.not_ready ?? new Map(),
			held_all: options.held_all
		})
	};
};

describe('to_release_state', () => {
	test('a pending dependency publishes first; its dependents wait without a rewrite', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.1.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.1.0' } })
			],
			{ core: '0.2.0' }
		);
		assert.deepEqual(state.rewrites, []);
		assert.deepEqual(state.publish_now, ['core']);
		assert.deepEqual(state.publish_held, []);
		assert.strictEqual(state.done, false);
	});

	test('a released dependency rewrites its dependents, the republishing ones with a changeset', async () => {
		// core 0.2.0 is out; ui and the private site still name ^0.1.0, docs as a dev dep
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', peer_deps: { core: '>=0.1.0' } }),
				create_mock_repo({ name: 'docs', version: '0.1.0', dev_deps: { core: '^0.1.0' } }),
				create_mock_repo({
					name: 'site',
					version: '0.1.0',
					private: true,
					deps: { core: '^0.1.0' }
				})
			],
			{}
		);
		const by_name = new Map(state.rewrites.map((r) => [r.name, r]));
		assert.deepEqual([...by_name.keys()].sort(), ['docs', 'site', 'ui']);
		assert.strictEqual(by_name.get('ui')!.changeset, true);
		assert.strictEqual(by_name.get('docs')!.changeset, false);
		assert.strictEqual(by_name.get('site')!.changeset, false);
		// ui republishes with the rewrite, so it's the wave to publish now
		assert.deepEqual(state.publish_now, ['ui']);
	});

	test('a dependency awaiting the registry holds both the rewrite and the dependent publish', async () => {
		const { plan, state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.1.0' } })
			],
			{},
			{
				registry: new Map([
					['core', 'unlisted'],
					['ui', 'listed']
				])
			}
		);
		assert.deepEqual(plan.awaiting_registry, [{ name: 'core', version: '0.2.0' }]);
		assert.deepEqual(state.rewrites, []);
		assert.deepEqual(state.publish_now, []);
		assert.deepEqual(state.publish_held, [
			{ name: 'ui', reasons: ['waiting for core@0.2.0 to show on the registry'] }
		]);
		assert.strictEqual(state.done, false);
	});

	test('a repo that is not ready holds its rewrite and its publish, naming why', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.1.0' } })
			],
			{},
			{ not_ready: new Map([['ui', ['uncommitted changes']]]) }
		);
		assert.deepEqual(state.rewrites, []);
		assert.strictEqual(state.rewrites_held.length, 1);
		assert.strictEqual(state.rewrites_held[0]!.name, 'ui');
		assert.deepEqual(state.rewrites_held[0]!.reasons, ['uncommitted changes']);
		assert.deepEqual(state.publish_held, [{ name: 'ui', reasons: ['uncommitted changes'] }]);
	});

	test('independent packages publish now together', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'a', version: '0.1.0' }),
				create_mock_repo({ name: 'b', version: '0.1.0' }),
				create_mock_repo({ name: 'c', version: '0.1.0', deps: { a: '^0.1.0' } })
			],
			{ a: '0.2.0', b: '0.2.0' }
		);
		assert.deepEqual([...state.publish_now].sort(), ['a', 'b']);
	});

	test('a never-published package moves no range and does not hold done', async () => {
		const { plan, state } = await plan_state(
			[
				create_mock_repo({ name: 'site', version: '0.0.1' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', dev_deps: { site: '^0.0.0' } })
			],
			{},
			{
				registry: new Map([
					['site', 'unknown'],
					['ui', 'listed']
				])
			}
		);
		assert.deepEqual(plan.never_published, ['site']);
		assert.deepEqual(plan.dependency_updates, []);
		assert.deepEqual(state.rewrites, []);
		assert.strictEqual(state.done, true);
	});

	test('a package the registry has never seen that others depend on is awaiting, not an app', async () => {
		// `new` was just published for the first time: npm answers E404 until it shows
		const { plan, state } = await plan_state(
			[
				create_mock_repo({ name: 'new', version: '0.1.0' }),
				create_mock_repo({ name: 'app', version: '0.1.0', deps: { new: '^0.1.0' } })
			],
			{ app: '0.2.0' },
			{
				registry: new Map([
					['new', 'unknown'],
					['app', 'listed']
				])
			}
		);
		assert.deepEqual(plan.never_published, []);
		assert.deepEqual(plan.awaiting_registry, [{ name: 'new', version: '0.1.0' }]);
		assert.deepEqual(state.publish_now, []);
		assert.deepEqual(state.publish_held, [
			{ name: 'app', reasons: ['waiting for new@0.1.0 to show on the registry'] }
		]);
	});

	test('a first publish still propagating keeps its trailing dependent from reading done', async () => {
		// `new` went 0.0.1 → 0.1.0 on its first publish; `app` has no changesets of its own
		const { plan, state } = await plan_state(
			[
				create_mock_repo({ name: 'new', version: '0.1.0' }),
				create_mock_repo({ name: 'app', version: '0.1.0', deps: { new: '^0.0.1' } })
			],
			{},
			{
				registry: new Map([
					['new', 'unknown'],
					['app', 'listed']
				])
			}
		);
		assert.deepEqual(plan.awaiting_registry, [{ name: 'new', version: '0.1.0' }]);
		// app still owes its rewrite and auto-bump, held until new shows
		assert.ok(plan.version_changes.some((vc) => vc.package_name === 'app'));
		assert.deepEqual(state.rewrites, []);
		assert.strictEqual(state.done, false);
	});

	test('a dependency whose repo is not ready holds its dependents, however deep', async () => {
		// core may hide a changeset: ui's lagging range waits, and app, two levels down, can't publish
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.2.0' } }),
				create_mock_repo({ name: 'app', version: '0.1.0', deps: { ui: '^0.1.0' } }),
				create_mock_repo({ name: 'docs', version: '0.1.0', dev_deps: { core: '^0.1.0' } }),
				create_mock_repo({ name: 'lone', version: '0.1.0' })
			],
			{ app: '0.2.0', lone: '0.2.0' },
			{ not_ready: new Map([['core', ['behind origin']]]) }
		);
		const reason =
			"core's repo isn't ready, so whether it has more to publish can't be read — see its hold";
		assert.deepEqual(state.rewrites, []);
		assert.deepEqual(
			state.rewrites_held.map((h) => [h.name, h.reasons]),
			[['docs', [reason]]]
		);
		assert.deepEqual(state.publish_now, ['lone']);
		assert.deepEqual(
			state.publish_held.map((h) => [h.name, h.reasons]),
			[['app', [reason]]]
		);
		assert.strictEqual(state.done, false);
	});

	test('a dependent rewrites its ranges on ready dependencies and holds only the rest', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'a', version: '0.2.0' }),
				create_mock_repo({ name: 'b', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { a: '^0.1.0', b: '^0.1.0' } })
			],
			{},
			{ not_ready: new Map([['b', ['dirty']]]) }
		);
		assert.deepEqual(
			state.rewrites.map((r) => [r.name, r.updates.map((u) => u.updated_dependency)]),
			[['ui', ['a']]]
		);
		assert.deepEqual(
			state.rewrites_held.map((h) => [h.name, h.updates.map((u) => u.updated_dependency)]),
			[['ui', ['b']]]
		);
	});

	test('report-wide problems hold every repo without naming dependencies', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.1.0' } })
			],
			{},
			{ held_all: ['busy detection is unavailable'] }
		);
		assert.deepEqual(
			state.rewrites_held.map((h) => [h.name, h.reasons]),
			[['ui', ['busy detection is unavailable']]]
		);
		assert.deepEqual(
			state.publish_held.map((h) => [h.name, h.reasons]),
			[['ui', ['busy detection is unavailable']]]
		);
	});

	test('a never-published app with lagging ranges is an update-only leaf, never scheduled', async () => {
		const { plan, state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'site', version: '0.0.1', deps: { core: '^0.1.0' } })
			],
			{},
			{
				registry: new Map([
					['core', 'listed'],
					['site', 'unknown']
				])
			}
		);
		assert.deepEqual(plan.version_changes, []);
		assert.deepEqual(plan.waves, []);
		assert.deepEqual(state.rewrites, [
			{ name: 'site', updates: plan.dependency_updates, changeset: false }
		]);
	});

	test('done when every version is out and every range names it', async () => {
		const { state } = await plan_state(
			[
				create_mock_repo({ name: 'core', version: '0.2.0' }),
				create_mock_repo({ name: 'ui', version: '0.1.0', deps: { core: '^0.2.0' } })
			],
			{}
		);
		assert.strictEqual(state.done, true);
		assert.deepEqual(state.publish_now, []);
	});
});
