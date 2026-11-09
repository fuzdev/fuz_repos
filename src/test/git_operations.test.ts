import { describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { SpawnProgram } from '@fuzdev/gro/spawn.ts';

import { git_commit } from '#lib/git_operations.ts';

const fail_on_spawn = (): never => {
	throw Error('git was run');
};

// throws on any run, so a missing guard fails the test instead of committing a real index
const git: SpawnProgram = {
	name: 'git',
	path: '/nonexistent/git',
	run: fail_on_spawn,
	out: fail_on_spawn,
	start: fail_on_spawn
};

describe('git_commit', () => {
	test('refuses an empty file list before running git', async () => {
		await assert_rejects(
			() => git_commit(git, 'message', []),
			/an empty list would commit the whole index/
		);
	});
});
