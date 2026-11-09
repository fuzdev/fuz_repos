/**
 * Production implementations of operations interfaces.
 *
 * Provides real git, npm, fs, and `repos` operations for production use.
 * For interface definitions and dependency injection pattern, see `operations.ts`.
 *
 * @module
 */

import { spawn_result_is_ok, to_spawn_result_message } from '@fuzdev/gro/cli.ts';
import { fs } from '@fuzdev/gro/fs.ts';
import { to_git_program } from '@fuzdev/gro/git.ts';
import { spawn, type SpawnCallOptions, type SpawnProgram } from '@fuzdev/gro/spawn.ts';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { wait } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { has_changesets, read_changesets, predict_next_version } from './changeset_reader.ts';
import { wait_for_package, type NpmRegistryDeps } from './npm_registry.ts';
import { git_add, git_commit } from './git_operations.ts';
import type {
	ChangesetOperations,
	GitOperations,
	NpmOperations,
	FsError,
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

/**
 * `git` for the release's commits. `pass_env: 'all'` because commit hooks, signing, and
 * clean filters are the user's setup, not a closed set of variables.
 */
const to_release_git = (): SpawnProgram => to_git_program(spawn, { pass_env: 'all' });

const to_call_options = async (cwd: string | undefined): Promise<SpawnCallOptions | undefined> =>
	cwd ? { cwd: await fs.open_dir(resolve(cwd)) } : undefined;

export const default_git_operations: GitOperations = {
	add: async (options) => {
		const { files, cwd } = options;
		return wrap_void(async () => git_add(to_release_git(), files, await to_call_options(cwd)));
	},

	commit: async (options) => {
		const { message, files, cwd } = options;
		return wrap_void(async () =>
			git_commit(to_release_git(), message, files, await to_call_options(cwd))
		);
	}
};

export const default_repos_operations: ReposOperations = {
	status: async (options) => {
		const { keys, registry, fetch } = options;
		const args = [...(registry === undefined ? [] : ['--registry', registry]), 'status'];
		if (fetch) args.push('--fetch');
		// `--` so a key can never read as a flag
		args.push('--json', '--', ...keys);
		try {
			// `pass_env: 'all'` because `repos` runs git against the remotes (ssh agent, credential
			// helpers) and reads the session environment; `repos` fetches non-interactively, so
			// `out`'s new session costs nothing
			const repos = spawn.find('repos', { pass_env: 'all' });
			if (!repos) return { ok: false, kind: 'not_found', message: 'repos not found on PATH' };
			const output = await repos.out(args);
			if (output.kind === 'signaled') {
				return { ok: false, kind: 'failed', message: `repos was killed by ${output.signal}` };
			}
			if (output.kind !== 'exited') {
				return { ok: false, kind: 'failed', message: to_spawn_result_message(output) };
			}
			return {
				ok: true,
				output: { stdout: output.stdout, stderr: output.stderr, exit_code: output.code }
			};
		} catch (error) {
			return { ok: false, kind: 'failed', message: to_error_message(error) };
		}
	}
};

/**
 * The npm operations over a `npm` program, resolved each time one runs.
 *
 * @param to_npm - makes the `npm` handle, called per operation so a missing `npm`
 * reports as a failed operation rather than at import
 */
export const create_npm_operations = (to_npm: () => SpawnProgram): NpmOperations => {
	const registry_deps: NpmRegistryDeps = {
		run_npm: async (args) => (await to_npm().out(args)).stdout,
		wait,
		now: () => Date.now()
	};
	return {
		view_version: async (options) => {
			const { pkg, version } = options;
			try {
				const spawned = await to_npm().out(['view', `${pkg}@${version}`, 'version']);
				if (spawn_result_is_ok(spawned)) {
					// an existing package without the version prints nothing
					const listed = spawned.stdout.trim() === version;
					return { ok: true, value: listed ? 'listed' : 'unlisted' };
				}
				// a package the registry doesn't know was never published
				if (spawned.stderr.includes('E404')) return { ok: true, value: 'unknown' };
				const stderr = spawned.stderr.trim();
				return {
					ok: false,
					message:
						`\`npm view ${pkg}@${version}\` failed (${to_spawn_result_message(spawned)})` +
						(stderr ? `: ${stderr.split('\n', 1)[0]}` : '')
				};
			} catch (error) {
				return { ok: false, message: String(error) };
			}
		},

		wait_for_package: async (options) => {
			const { pkg, version, wait_options, log } = options;
			try {
				await wait_for_package(pkg, version, { ...wait_options, log }, registry_deps);
				return { ok: true };
			} catch (error) {
				return { ok: false, message: String(error) };
			}
		}
	};
};

// `pass_env: 'all'` because `~/.npmrc` interpolates whatever `${VAR}` the user wrote and
// a variable it names being unset is a config error, and proxies and CA bundles are env too
export const default_npm_operations: NpmOperations = create_npm_operations(() =>
	spawn.program('npm', { pass_env: 'all' })
);

/**
 * Classifies a thrown filesystem error by its Node `code`. Unknown codes and
 * values without one are `io_error`.
 */
const fs_classify_error = (error: unknown): FsError => {
	const message = to_error_message(error);
	if (error && typeof error === 'object' && 'code' in error) {
		switch ((error as { code: string }).code) {
			case 'ENOENT':
				return { kind: 'not_found', message };
			case 'EACCES':
			case 'EPERM':
				return { kind: 'permission_denied', message };
			case 'EEXIST':
				return { kind: 'already_exists', message };
		}
	}
	return { kind: 'io_error', message };
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
