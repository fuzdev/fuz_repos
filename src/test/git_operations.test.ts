import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import type { SpawnOutOptions, SpawnOutput, SpawnProgram } from '@fuzdev/gro/spawn.ts';

import { git_add, git_commit } from '#lib/git_operations.ts';

const fail_on_spawn = (): never => {
	throw Error('git was run');
};

// throws on any run, so a missing guard fails the test instead of committing a real index
const git: SpawnProgram = {
	name: 'git',
	path: '/nonexistent/git',
	run: fail_on_spawn,
	out: fail_on_spawn,
	out_bytes: fail_on_spawn,
	start: fail_on_spawn
};

/**
 * A `git` that answers every `out` with `output` and records its args and options.
 */
const create_fake_git = (
	output: SpawnOutput = { kind: 'exited', code: 0, stdout: '', stderr: '', truncated: false }
): {
	git: SpawnProgram;
	calls: Array<{ args: ReadonlyArray<string>; options: SpawnOutOptions | undefined }>;
} => {
	const calls: Array<{ args: ReadonlyArray<string>; options: SpawnOutOptions | undefined }> = [];
	return {
		calls,
		git: {
			...git,
			out: async (args, options) => {
				calls.push({ args, options });
				return output;
			}
		}
	};
};

describe('git_add', () => {
	test('inherits stdin, so git stays in the terminal session', async () => {
		const { git, calls } = create_fake_git();
		await git_add(git, ['a.ts', 'b.ts']);
		assert.deepEqual(calls, [{ args: ['add', 'a.ts', 'b.ts'], options: { stdin: 'inherit' } }]);
	});
});

describe('git_commit', () => {
	test('inherits stdin, so git stays in the terminal session', async () => {
		const { git, calls } = create_fake_git();
		await git_commit(git, 'message', ['a.ts']);
		assert.deepEqual(calls, [
			{ args: ['commit', '-m', 'message', '--', 'a.ts'], options: { stdin: 'inherit' } }
		]);
	});

	test('a clean exit with truncated output succeeds', async () => {
		const { git } = create_fake_git({
			kind: 'exited',
			code: 0,
			stdout: '',
			stderr: '',
			truncated: true
		});
		await git_commit(git, 'message', ['a.ts']);
	});

	test('the output limit killing git fails', async () => {
		const { git } = create_fake_git({
			kind: 'signaled',
			signal: 'SIGKILL',
			stdout: '',
			stderr: '',
			truncated: true
		});
		await assert_rejects(
			() => git_commit(git, 'message', ['a.ts']),
			/git_commit failed.*stale \.git\/index\.lock/
		);
	});

	test('refuses an empty file list before running git', async () => {
		await assert_rejects(
			() => git_commit(git, 'message', []),
			/an empty list would commit the whole index/
		);
	});
});
