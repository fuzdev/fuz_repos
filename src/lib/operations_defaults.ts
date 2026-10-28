/**
 * Production implementations of operations interfaces.
 *
 * Provides real git, npm, fs, and `repos` operations for production use.
 * For interface definitions and dependency injection pattern, see `operations.ts`.
 *
 * @module
 */

import { spawn_out, spawn_result_to_message } from '@fuzdev/fuz_util/process.ts';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fs_classify_error } from '@fuzdev/fuz_util/fs.ts';

import { has_changesets, read_changesets, predict_next_version } from './changeset_reader.ts';
import { wait_for_package } from './npm_registry.ts';
import { git_add, git_commit } from './git_operations.ts';
import type {
	ChangesetOperations,
	GitOperations,
	NpmOperations,
	FsOperations,
	ReposOperations
} from './operations.ts';

/** Wrap an async function that returns a value */
const wrap_with_value = async <T>(
	fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
	try {
		const value = await fn();
		return { ok: true, value };
	} catch (error) {
		return { ok: false, message: String(error) };
	}
};

/** Wrap an async function, ignoring its return value */
const wrap_void = async (
	fn: () => Promise<unknown>
): Promise<{ ok: true } | { ok: false; message: string }> => {
	try {
		await fn();
		return { ok: true };
	} catch (error) {
		return { ok: false, message: String(error) };
	}
};

export const default_changeset_operations: ChangesetOperations = {
	has_changesets: async (options) => {
		const { repo } = options;
		return wrap_with_value(() => has_changesets(repo));
	},

	read_changesets: async (options) => {
		const { repo, log } = options;
		return wrap_with_value(() => read_changesets(repo, log));
	},

	predict_next_version: async (options) => {
		const { repo, log } = options;
		try {
			const result = await predict_next_version(repo, log);
			if (result === null) {
				return null;
			}
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, message: String(error) };
		}
	}
};

export const default_git_operations: GitOperations = {
	add: async (options) => {
		const { files, cwd } = options;
		return wrap_void(() => git_add(files, cwd ? { cwd } : undefined));
	},

	commit: async (options) => {
		const { message, files, cwd } = options;
		return wrap_void(() => git_commit(message, files, cwd ? { cwd } : undefined));
	}
};

export const default_repos_operations: ReposOperations = {
	status: async (options) => {
		const { keys, registry, fetch } = options;
		const args = [...(registry === undefined ? [] : ['--registry', registry]), 'status'];
		if (fetch) args.push('--fetch');
		// `--` so a key can never read as a flag
		args.push('--json', '--', ...keys);
		const spawned = await spawn_out('repos', args);
		const { result } = spawned;
		if (result.kind === 'error') {
			const not_found = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
			return {
				ok: false,
				kind: not_found ? 'not_found' : 'failed',
				message: result.error.message
			};
		}
		if (result.kind === 'signaled') {
			return { ok: false, kind: 'failed', message: `repos was killed by ${result.signal}` };
		}
		return {
			ok: true,
			output: {
				stdout: spawned.stdout ?? '',
				stderr: spawned.stderr ?? '',
				exit_code: result.code
			}
		};
	}
};

export const default_npm_operations: NpmOperations = {
	view_version: async (options) => {
		const { pkg, version } = options;
		try {
			const spawned = await spawn_out('npm', ['view', `${pkg}@${version}`, 'version']);
			if (spawned.result.ok) {
				// an existing package without the version prints nothing
				const listed = (spawned.stdout ?? '').trim() === version;
				return { ok: true, value: listed ? 'listed' : 'unlisted' };
			}
			// a package the registry doesn't know was never published
			if (spawned.stderr?.includes('E404')) return { ok: true, value: 'unknown' };
			const stderr = spawned.stderr?.trim();
			return {
				ok: false,
				message:
					`\`npm view ${pkg}@${version}\` failed (${spawn_result_to_message(spawned.result)})` +
					(stderr ? `: ${stderr.split('\n', 1)[0]}` : '')
			};
		} catch (error) {
			return { ok: false, message: String(error) };
		}
	},

	wait_for_package: async (options) => {
		const { pkg, version, wait_options, log } = options;
		try {
			await wait_for_package(pkg, version, { ...wait_options, log });
			return { ok: true };
		} catch (error) {
			return { ok: false, message: String(error) };
		}
	}
};

export const default_fs_operations: FsOperations = {
	readFile: async (options) => {
		const { path, encoding } = options;
		try {
			const value = await readFile(path, encoding);
			return { ok: true, value };
		} catch (error) {
			return { ok: false, ...fs_classify_error(error) };
		}
	},

	writeFile: async (options) => {
		const { path, content } = options;
		try {
			await writeFile(path, content);
			return { ok: true };
		} catch (error) {
			return { ok: false, ...fs_classify_error(error) };
		}
	},

	mkdir: async (options) => {
		const { path, recursive } = options;
		try {
			await mkdir(path, { recursive });
			return { ok: true };
		} catch (error) {
			return { ok: false, ...fs_classify_error(error) };
		}
	},

	exists: async (options) => {
		try {
			await stat(options.path);
			return true;
		} catch {
			return false;
		}
	}
};
