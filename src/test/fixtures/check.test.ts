import { test, assert, describe, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validate_dependency_graph } from '#lib/graph_validation.ts';
import { generate_publishing_plan } from '#lib/publishing_plan.ts';
import { load_gitops_config } from '#lib/gitops_config.ts';
import { to_release_state } from '#lib/release_state.ts';
import { create_fixture_gitops_ops } from './mock_operations.ts';
import { fixture_to_local_repos } from './load_repo_fixtures.ts';
import type { LocalRepo } from '#lib/local_repo.ts';
import { basic_publishing } from './repo_fixtures/basic_publishing.ts';
import { deep_cascade } from './repo_fixtures/deep_cascade.ts';
import { circular_dev_deps } from './repo_fixtures/circular_dev_deps.ts';
import { three_way_dev_cycle } from './repo_fixtures/three_way_dev_cycle.ts';
import { private_packages } from './repo_fixtures/private_packages.ts';
import { major_bumps } from './repo_fixtures/major_bumps.ts';
import { peer_deps_only } from './repo_fixtures/peer_deps_only.ts';
import { circular_prod_deps_error } from './repo_fixtures/circular_prod_deps_error.ts';
import { isolated_packages } from './repo_fixtures/isolated_packages.ts';
import { multiple_dep_types } from './repo_fixtures/multiple_dep_types.ts';
import type { RepoFixtureSet } from './repo_fixture_types.ts';
import { assert_order, assert_version_changes, assert_messages } from './helpers.ts';

// All fixture sets
const FIXTURES: Array<RepoFixtureSet> = [
	basic_publishing,
	deep_cascade,
	circular_dev_deps,
	three_way_dev_cycle,
	private_packages,
	major_bumps,
	peer_deps_only,
	circular_prod_deps_error,
	isolated_packages,
	multiple_dep_types
];

// Categorize fixtures by type
const SUCCESS_FIXTURES = FIXTURES.filter(
	(f) => !f.expected_outcomes.errors || f.expected_outcomes.errors.length === 0
);
const ERROR_FIXTURES = FIXTURES.filter(
	(f) => f.expected_outcomes.errors && f.expected_outcomes.errors.length > 0
);

// Cache for fixture LocalRepo objects (avoids redundant conversions)
const fixture_repos_cache: Map<string, Array<LocalRepo>> = new Map();

/**
 * Get or compute LocalRepo objects for a fixture.
 * Caches results to avoid redundant object allocation across tests.
 */
const get_fixture_repos = (fixture: RepoFixtureSet): Array<LocalRepo> => {
	let cached = fixture_repos_cache.get(fixture.name);
	if (!cached) {
		cached = fixture_to_local_repos(fixture);
		fixture_repos_cache.set(fixture.name, cached);
	}
	return cached;
};

/**
 * Helper to set up common test data for plan tests.
 * Creates mock operations, loads repos, and generates publishing plan.
 */
const setup_plan_test = async (fixture: RepoFixtureSet) => {
	const mock_ops = create_fixture_gitops_ops(fixture);
	const local_repos = get_fixture_repos(fixture);
	const plan = await generate_publishing_plan(local_repos, { ops: mock_ops.changeset });
	return { mock_ops, local_repos, plan };
};

// Clear cache after all tests to prevent memory leaks
afterAll(() => {
	fixture_repos_cache.clear();
});

/**
 * In-memory tests that avoid subprocess spawning and I/O.
 * Uses direct function calls with mocked operations for performance.
 */

/**
 * Success scenario fixtures - validate normal publishing workflows
 */
describe('Success scenario fixtures', () => {
	for (const fixture of SUCCESS_FIXTURES) {
		describe(fixture.name, () => {
			describe('analyze', () => {
				test('produces expected topological order', () => {
					// No need for mock_ops in analyze - it doesn't use operations
					const local_repos = get_fixture_repos(fixture);
					const { order } = validate_dependency_graph(local_repos);
					assert_order(order, fixture.expected_outcomes.order);
				});
			});

			describe('plan', () => {
				test('predicts correct version changes', async () => {
					const { plan } = await setup_plan_test(fixture);

					// Verify version changes
					if (fixture.expected_outcomes.version_changes.length > 0) {
						assert_version_changes(plan.version_changes, fixture.expected_outcomes.version_changes);
					} else {
						assert.equal(plan.version_changes.length, 0, 'Expected no version changes');
					}
				});

				test('groups the packages that publish into waves', async () => {
					const { plan } = await setup_plan_test(fixture);
					assert.deepEqual(plan.waves, fixture.expected_outcomes.waves);
					// every version change publishes in exactly one wave
					assert.deepEqual(
						plan.waves.flat().sort(),
						plan.version_changes.map((vc) => vc.package_name).sort()
					);
				});

				// Only define if this fixture tests breaking cascades
				if (fixture.expected_outcomes.breaking_cascades) {
					test('tracks breaking cascades', async () => {
						const { plan } = await setup_plan_test(fixture);

						// Verify breaking cascades exist
						for (const [pkg, expected_affected] of Object.entries(
							fixture.expected_outcomes.breaking_cascades!
						)) {
							assert.ok(plan.breaking_cascades.has(pkg), `Should have breaking cascade for ${pkg}`);

							// Verify affected packages match
							const actual_affected = plan.breaking_cascades.get(pkg) || [];
							for (const expected_pkg of expected_affected) {
								assert.ok(
									actual_affected.includes(expected_pkg),
									`${pkg} should affect ${expected_pkg}`
								);
							}
						}
					});
				}

				// Only define if this fixture tests warnings
				if (fixture.expected_outcomes.warnings && fixture.expected_outcomes.warnings.length > 0) {
					test('reports warnings', async () => {
						const { plan } = await setup_plan_test(fixture);
						assert_messages(plan.warnings, fixture.expected_outcomes.warnings!, 'warnings');
					});
				}

				// Only define if this fixture tests info messages
				if (fixture.expected_outcomes.info && fixture.expected_outcomes.info.length > 0) {
					test('reports info', async () => {
						const { plan } = await setup_plan_test(fixture);
						assert_messages(plan.info, fixture.expected_outcomes.info!, 'info');
					});
				}

				test('reports packages with no changes', async () => {
					const { plan } = await setup_plan_test(fixture);
					assert.deepEqual(
						[...plan.no_changes].sort(),
						[...(fixture.expected_outcomes.no_changes ?? [])].sort()
					);
				});
			});

			describe('release step', () => {
				test('names the first wave to publish now when everything is released and ready', async () => {
					const { plan, local_repos } = await setup_plan_test(fixture);
					const state = to_release_state({ plan, repos: local_repos, not_ready: new Map() });
					assert.deepEqual(state.publish_now, plan.waves[0] ?? []);
					assert.deepEqual(state.publish_held, []);
					assert.strictEqual(
						state.done,
						plan.version_changes.length === 0 && state.rewrites.length === 0
					);
				});
			});
		});
	}
});

/**
 * Error scenario fixtures - validate error detection and reporting
 */
describe('Error scenario fixtures', () => {
	for (const fixture of ERROR_FIXTURES) {
		describe(fixture.name, () => {
			describe('analyze', () => {
				test('detects circular dependencies', () => {
					const local_repos = get_fixture_repos(fixture);

					// Validate dependency graph - should detect cycles, leaving no order
					const { order, levels } = validate_dependency_graph(local_repos);
					assert.deepEqual(order, fixture.expected_outcomes.order);
					assert.deepEqual(levels, []);
				});
			});

			describe('plan', () => {
				test('reports errors', async () => {
					// the plan reports its errors rather than throwing them
					const { plan } = await setup_plan_test(fixture);
					assert_messages(plan.errors, fixture.expected_outcomes.errors!, 'errors');
				});
			});
		});
	}
});

/**
 * Test that configs can actually be loaded.
 * This ensures the config files are valid, and list their fixture's repos as keys.
 */
describe('Config loading validation', () => {
	const FIXTURES_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

	for (const fixture of FIXTURES) {
		test(`${fixture.name} config loads successfully`, async () => {
			const config_path = join(FIXTURES_DIR, 'fixtures/configs', `${fixture.name}.config.ts`);

			// Verify config file exists
			assert.ok(existsSync(config_path), `Config file should exist at ${config_path}`);

			// Load and validate the config: its keys are the fixture's repos, in order
			const config = await load_gitops_config(config_path);
			assert.ok(config, 'Config should load successfully');
			assert.deepEqual(
				config.repos,
				fixture.repos.map((r) => r.repo_name)
			);
		});
	}
});

/**
 * Test JSON output format structure.
 * Uses basic_publishing fixture as it has comprehensive data for structure validation.
 */
describe('JSON output format tests', () => {
	const fixture = basic_publishing;

	test('plan output has expected JSON structure', async () => {
		const { plan } = await setup_plan_test(fixture);

		// Verify plan structure matches expected JSON format
		assert.ok(Array.isArray(plan.waves), 'Should have waves array');
		assert.ok(Array.isArray(plan.awaiting_registry), 'Should have awaiting_registry array');
		assert.ok(Array.isArray(plan.version_changes), 'Should have version_changes array');
		assert.ok(Array.isArray(plan.dependency_updates), 'Should have dependency_updates array');
		assert.ok(plan.breaking_cascades instanceof Map, 'Should have breaking_cascades map');
		assert.ok(Array.isArray(plan.warnings), 'Should have warnings array');
		assert.ok(Array.isArray(plan.errors), 'Should have errors array');
		assert.ok(Array.isArray(plan.info), 'Should have info array');
		assert.ok(Array.isArray(plan.no_changes), 'Should have no_changes array');

		// Verify version change structure
		if (plan.version_changes.length > 0) {
			const change = plan.version_changes[0]!;
			assert.ok('package_name' in change, 'Version change should have package_name');
			assert.ok('from' in change, 'Version change should have from version');
			assert.ok('to' in change, 'Version change should have to version');
			assert.ok('bump_type' in change, 'Version change should have bump_type');
			assert.ok('breaking' in change, 'Version change should have breaking flag');
			assert.ok('has_changesets' in change, 'Version change should have has_changesets flag');
		}
	});

	test('analyze output has expected JSON structure', () => {
		const local_repos = get_fixture_repos(fixture);

		const result = validate_dependency_graph(local_repos);

		assert.ok(result.graph, 'Should have dependency graph');
		assert.ok(Array.isArray(result.order), 'Should have an order');
		assert.ok(Array.isArray(result.levels), 'Should have levels');
		assert.ok(result.graph.nodes instanceof Map, 'Graph should have nodes map');

		// Verify node structure
		if (result.graph.nodes.size > 0) {
			const node = result.graph.nodes.values().next().value;
			if (node) {
				assert.ok('name' in node, 'Node should have name');
				assert.ok('version' in node, 'Node should have version');
				assert.ok('dependencies' in node, 'Node should have dependencies');
				assert.ok('dependents' in node, 'Node should have dependents');
			}
		}
	});
});
