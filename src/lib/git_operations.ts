import { to_spawn_result_message, spawn_result_is_ok } from '@fuzdev/gro/cli.ts';
import type { SpawnCallOptions, SpawnProgram } from '@fuzdev/gro/spawn.ts';

import { spawn_capture } from './spawn_capture.ts';

/**
 * Adds files to git staging area and throws if anything goes wrong.
 */
export const git_add = async (
	git: SpawnProgram,
	files: string | Array<string>,
	options?: SpawnCallOptions
): Promise<void> => {
	const file_list = Array.isArray(files) ? files : [files];
	const output = await spawn_capture(git, ['add', ...file_list], options);
	if (!spawn_result_is_ok(output)) {
		const { stderr } = output;
		throw Error(
			`git_add failed with ${to_spawn_result_message(output)}${stderr ? ': ' + stderr.trim() : ''}`
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
	const output = await spawn_capture(git, ['commit', '-m', message, '--', ...files], options);
	if (!spawn_result_is_ok(output)) {
		const { stderr } = output;
		throw Error(
			`git_commit failed with ${to_spawn_result_message(output)}${stderr ? ': ' + stderr.trim() : ''}`
		);
	}
};
