import { spawn_out, spawn_result_to_message } from '@fuzdev/fuz_util/process.ts';
import type { SpawnOptions } from 'node:child_process';

/**
 * Adds files to git staging area and throws if anything goes wrong.
 */
export const git_add = async (
	files: string | Array<string>,
	options?: SpawnOptions
): Promise<void> => {
	const file_list = Array.isArray(files) ? files : [files];
	const { result, stderr } = await spawn_out('git', ['add', ...file_list], options);
	if (!result.ok) {
		throw Error(
			`git_add failed with ${spawn_result_to_message(result)}${stderr ? ': ' + stderr.trim() : ''}`
		);
	}
};

/**
 * Commits `files` alone with a message, leaving anything else staged out of
 * the commit, and throws if anything goes wrong. `files` must be non-empty:
 * an empty list would commit the whole index.
 */
export const git_commit = async (
	message: string,
	files: Array<string>,
	options?: SpawnOptions
): Promise<void> => {
	if (files.length === 0) {
		throw Error('git_commit needs at least one file: an empty list would commit the whole index');
	}
	const { result, stderr } = await spawn_out(
		'git',
		['commit', '-m', message, '--', ...files],
		options
	);
	if (!result.ok) {
		throw Error(
			`git_commit failed with ${spawn_result_to_message(result)}${stderr ? ': ' + stderr.trim() : ''}`
		);
	}
};
