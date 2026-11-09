import { to_spawn_result_message, spawn_result_is_ok } from '@fuzdev/gro/cli.ts';
import type { SpawnCallOptions, SpawnOutput, SpawnProgram } from '@fuzdev/gro/spawn.ts';

// `stdin: 'inherit'` keeps git in the terminal's session, so `/dev/tty` still reaches ssh, a hook,
// or a pinentry. `truncated` is ignored: stdout is never read, stderr only on failure, and the
// usual cause is a daemon a hook or ssh's `ControlPersist` left holding a pipe

// a `SIGKILL` skips git's cleanup, and the next git in this repo fails on the lock left behind
const to_killed_note = (output: SpawnOutput): string =>
	output.truncated && output.kind === 'signaled' && output.signal === 'SIGKILL'
		? ' after its output was cut; check for a stale .git/index.lock'
		: '';

/**
 * Adds files to git staging area and throws if anything goes wrong.
 */
export const git_add = async (
	git: SpawnProgram,
	files: string | Array<string>,
	options?: SpawnCallOptions
): Promise<void> => {
	const file_list = Array.isArray(files) ? files : [files];
	const output = await git.out(['add', ...file_list], { ...options, stdin: 'inherit' });
	if (!spawn_result_is_ok(output)) {
		const { stderr } = output;
		throw Error(
			`git_add failed with ${to_spawn_result_message(output)}${to_killed_note(output)}${stderr ? ': ' + stderr.trim() : ''}`
		);
	}
};

/**
 * Commits `files` alone with a message, leaving anything else staged out of
 * the commit, and throws if anything goes wrong. `files` must be non-empty:
 * an empty list would commit the whole index.
 */
export const git_commit = async (
	git: SpawnProgram,
	message: string,
	files: Array<string>,
	options?: SpawnCallOptions
): Promise<void> => {
	if (files.length === 0) {
		throw Error('git_commit needs at least one file: an empty list would commit the whole index');
	}
	const output = await git.out(['commit', '-m', message, '--', ...files], {
		...options,
		stdin: 'inherit'
	});
	if (!spawn_result_is_ok(output)) {
		const { stderr } = output;
		throw Error(
			`git_commit failed with ${to_spawn_result_message(output)}${to_killed_note(output)}${stderr ? ': ' + stderr.trim() : ''}`
		);
	}
};
