import { assert, describe, test } from 'vitest';

import { format_readiness_block, repos_not_at_rest } from '#lib/repo_readiness.ts';
import { AT_REST, create_mock_repos_entry, entry_with } from './test_helpers.ts';

describe('format_readiness_block', () => {
	test('no lines when every repo is at rest', () => {
		const not_ready = repos_not_at_rest([create_mock_repos_entry({ key: 'a' })]);
		assert.deepEqual(format_readiness_block(not_ready, 0), []);
	});

	test('a line per problem, with how long ago a relation was fetched', () => {
		const now = 1_000_000;
		const not_ready = repos_not_at_rest([
			create_mock_repos_entry({ key: 'ok' }),
			entry_with('feature', {
				checkout: { head: { kind: 'branch', name: 'repos-tool' } },
				at_rest: { ...AT_REST, on_branch: false }
			}),
			entry_with('stale', {
				at_rest: { ...AT_REST, followed: { kind: 'behind', commits: 3 } },
				fetched_at: now - 7200
			}),
			entry_with('dirty', {
				checkout: { uncommitted: { staged: 0, unstaged: 0, untracked: 1, conflicted: 0 } },
				at_rest: { ...AT_REST, clean: false, followed: { kind: 'ahead', commits: 1 } }
			})
		]);
		assert.deepEqual(format_readiness_block(not_ready, now), [
			'not at rest, so read as they sit (a release step holds all but a branch ahead of origin):',
			'  feature: on `repos-tool`, not `main`',
			'  stale: `main` is 3 commits behind origin (fetched 2h ago)',
			'  dirty: uncommitted changes (1 untracked)',
			'  dirty: `main` is 1 commit ahead of origin (unpushed) (never fetched)'
		]);
	});
});
