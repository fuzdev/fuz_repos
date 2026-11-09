import { TaskError, type Task } from '@fuzdev/gro';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { map_concurrent_settled } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { to_spawn_result_message } from '@fuzdev/gro/cli.ts';
import { fs, type FsReadDir } from '@fuzdev/gro/fs.ts';
import { spawn, type SpawnProgram } from '@fuzdev/gro/spawn.ts';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { styleText as st } from 'node:util';

import { resolve_gitops_repos } from './gitops_task_helpers.ts';
import { GITOPS_CONCURRENCY_DEFAULT, GITOPS_CONFIG_PATH_DEFAULT } from './gitops_constants.ts';
import type { ReposOperations } from './operations.ts';
import { default_repos_operations } from './operations_defaults.ts';
import { output_is_machine, route_human_output } from './output_helpers.ts';

/** @nodocs */
export const Args = s.object({
	// Positional rest args (gro convention) so
	// `gro task src/lib/gitops_run.task.ts "npm test"` works; joined with spaces
	// and passed to `sh -c`, so quote commands that contain flags.
	_: s.with_default_fn(
		meta(s.array(s.string), { description: 'shell command to run in each repo' }),
		() => []
	),
	config: s.with_default(
		meta(s.string, { description: 'path to the gitops config file' }),
		GITOPS_CONFIG_PATH_DEFAULT
	),
	registry: s.optional(
		meta(s.string, {
			description:
				'path to the repos.toml registry, when `repos` would not find it walking up from the cwd'
		})
	),
	concurrency: s.with_default(
		meta(s.pipe(s.number, s.safe_integer, s.min_value(1)), {
			description: 'maximum number of repos to run in parallel'
		}),
		GITOPS_CONCURRENCY_DEFAULT
	),
	format: s.with_default(
		meta(s.one_of(['text', 'json']), { description: 'output format' }),
		'text'
	),
	outfile: s.optional(
		meta(s.string, {
			description: 'with --format json, write clean JSON to this file instead of stdout'
		})
	)
});
export type Args = s.Infer<typeof Args>;

/**
 * How a command run in one repo ended: it exited with a code, a signal killed
 * it, or it hit an error: it never started, or passed the output limit.
 *
 * @nodocs
 */
export type GitopsRunOutcome =
	| { kind: 'exited'; code: number }
	| { kind: 'signaled'; signal: string }
	| { kind: 'error'; message: string };

/**
 * What a command run in one repo printed, and how it ended.
 *
 * @nodocs
 */
export interface GitopsRunCommandOutput {
	outcome: GitopsRunOutcome;
	stdout: string;
	stderr: string;
	/** Whether output may be missing from the end of `stdout` or `stderr`. */
	truncated: boolean;
}

/**
 * One repo's result, as the JSON output carries it.
 *
 * @nodocs
 */
export interface GitopsRunResult {
	repo_name: string;
	repo_dir: string;
	status: 'success' | 'failure';
	/** The command's exit code; `null` when a signal killed it or it never started. */
	exit_code: number | null;
	/** The signal that killed the command, else `null`. */
	signal: string | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
	/**
	 * Whether output may be missing from the end of `stdout` or `stderr`: the command passed the
	 * output limit, or a process it left running held a pipe past the wait for it.
	 */
	truncated: boolean;
	/** Why the command never started, or that it passed the output limit and was killed. */
	error?: string;
}

/**
 * The side effects `run_gitops_run` reaches through, injectable for tests.
 *
 * @nodocs
 */
export interface GitopsRunDeps {
	/** Runs `repos status` to resolve the config's repos. */
	repos_ops: ReposOperations;
	/** Runs `command` through `sh -c` in `cwd`, capturing its output. */
	run_command: (options: { command: string; cwd: string }) => Promise<GitopsRunCommandOutput>;
}

/** The most bytes kept of each of a command's stdout and stderr. */
const GITOPS_RUN_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Runs `command` through `sh`, so pipes, redirects, and globs work. The command is the user's,
 * so `sh` should carry their whole environment, and it stays in the terminal's session.
 *
 * @param sh - the shell program
 * @param command - the shell command
 * @param cwd - the directory to run it in
 * @returns how it ended, and its output
 * @throws `SpawnError` - if the shell can't start
 * @nodocs
 */
export const gitops_run_in_shell = async (
	sh: SpawnProgram,
	command: string,
	cwd: FsReadDir
): Promise<GitopsRunCommandOutput> => {
	const output = await sh.out(['-c', command], {
		cwd,
		stdin: 'inherit',
		max_bytes: GITOPS_RUN_MAX_OUTPUT_BYTES
	});
	const { stdout, stderr, truncated } = output;
	// the limit's kill isn't the command failing on its own. The cap keeps exactly `max_bytes` and
	// decoding never shrinks them, so a `SIGKILL` short of it came from elsewhere, the output cut by
	// a background process holding a pipe, and it keeps the command's own ending
	const at_limit =
		Buffer.byteLength(stdout) >= GITOPS_RUN_MAX_OUTPUT_BYTES ||
		Buffer.byteLength(stderr) >= GITOPS_RUN_MAX_OUTPUT_BYTES;
	if (truncated && at_limit && output.kind === 'signaled' && output.signal === 'SIGKILL') {
		const message = 'output limit hit: stdout or stderr passed 64 MiB, so the command was killed';
		return { outcome: { kind: 'error', message }, stdout, stderr, truncated };
	}
	const outcome: GitopsRunOutcome =
		output.kind === 'exited'
			? { kind: 'exited', code: output.code }
			: output.kind === 'signaled'
				? { kind: 'signaled', signal: output.signal }
				: { kind: 'error', message: to_spawn_result_message(output) };
	return { outcome, stdout, stderr, truncated };
};

const default_gitops_run_deps: GitopsRunDeps = {
	repos_ops: default_repos_operations,
	run_command: async ({ command, cwd }) => {
		try {
			const sh = spawn.program('sh', { pass_env: 'all' });
			return await gitops_run_in_shell(sh, command, await fs.open_dir(resolve(cwd)));
		} catch (error) {
			return {
				outcome: { kind: 'error', message: to_error_message(error) },
				stdout: '',
				stderr: '',
				truncated: false
			};
		}
	}
};

/** @nodocs */
export const task: Task<Args> = {
	Args,
	summary: 'run a shell command across all repos in parallel',
	run: async ({ args, log }) => {
		await run_gitops_run(args, log);
	}
};

/**
 * Runs `gro task src/lib/gitops_run.task.ts`: resolves the config's repos
 * through `repos status`, refusing a missing one, runs the command in each,
 * `concurrency` at a time, and reports every result. Under `--format json`
 * without `--outfile`, the log goes to stderr and stdout carries the JSON
 * alone (`route_human_output`).
 *
 * @throws {TaskError} when no command is given, resolving the repos fails, or the command fails in any repo (after reporting)
 * @nodocs
 */
export const run_gitops_run = async (
	args: Args,
	log: Logger,
	deps: Partial<GitopsRunDeps> = {}
): Promise<void> => {
	const { repos_ops, run_command } = { ...default_gitops_run_deps, ...deps };
	const { _, config, registry, concurrency, format, outfile } = args;
	const write_stdout = route_human_output(log, output_is_machine(format, outfile));

	const command = _.join(' ').trim();
	if (!command) {
		throw new TaskError(
			'No command provided, e.g. `gro task src/lib/gitops_run.task.ts "npm test"`'
		);
	}

	// Resolve repo paths through `repos status` (no library-metadata loading needed);
	// a configured repo that's missing or not a repo fails the run, naming it
	const { local_repo_paths: repos } = await resolve_gitops_repos({
		config,
		registry,
		log,
		repos_ops
	});

	log.info(
		`Running ${st('cyan', command)} across ${repos.length} repos (concurrency: ${concurrency})`
	);

	const start_time = performance.now();

	const settled = await map_concurrent_settled(
		repos,
		concurrency,
		async ({ repo_name, repo_dir }): Promise<GitopsRunResult> => {
			const repo_start = performance.now();
			const { outcome, stdout, stderr, truncated } = await run_command({
				command,
				cwd: repo_dir
			});
			return {
				repo_name,
				repo_dir,
				status: outcome.kind === 'exited' && outcome.code === 0 ? 'success' : 'failure',
				exit_code: outcome.kind === 'exited' ? outcome.code : null,
				signal: outcome.kind === 'signaled' ? outcome.signal : null,
				stdout,
				stderr,
				truncated,
				duration_ms: performance.now() - repo_start,
				...(outcome.kind === 'error' && { error: outcome.message })
			};
		}
	);

	const total_duration_ms = performance.now() - start_time;

	// Process results; a rejection is `run_command` throwing, which the default never does
	const successes: Array<GitopsRunResult> = [];
	const failures: Array<GitopsRunResult> = [];
	settled.forEach((result, i) => {
		if (result.status === 'fulfilled') {
			(result.value.status === 'success' ? successes : failures).push(result.value);
		} else {
			const { repo_name, repo_dir } = repos[i]!;
			failures.push({
				repo_name,
				repo_dir,
				status: 'failure',
				exit_code: null,
				signal: null,
				stdout: '',
				stderr: '',
				truncated: false,
				duration_ms: 0,
				error: to_error_message(result.reason)
			});
		}
	});

	// Output results based on format
	if (format === 'json') {
		const json_output = {
			command,
			concurrency,
			repos: [...successes, ...failures],
			summary: {
				total: repos.length,
				success: successes.length,
				failure: failures.length,
				duration_ms: Math.round(total_duration_ms)
			}
		};
		const json = JSON.stringify(json_output, null, 2);
		if (outfile) {
			// Clean machine-readable output, free of gro's logging prefixes.
			await writeFile(outfile, json);
			log.info(`wrote JSON output to ${outfile}`);
		} else {
			write_stdout(json);
		}
	} else {
		log_text_results({ successes, failures, total: repos.length, total_duration_ms }, log);
	}

	// Exit with error if any failures (so CI fails)
	if (failures.length > 0) {
		throw new TaskError(`${failures.length} repos failed`);
	}
};

const TRUNCATED_WARNING =
	'    output may be incomplete: it passed the output limit, or a process left running held a pipe';

const log_text_results = (
	data: {
		successes: Array<GitopsRunResult>;
		failures: Array<GitopsRunResult>;
		total: number;
		total_duration_ms: number;
	},
	log: Logger
): void => {
	const { successes, failures, total, total_duration_ms } = data;
	log.info(''); // blank line

	// Show successes, including the command's output so read-only commands
	// (`git rev-parse`, `cat package.json`, …) are useful without `--format json`.
	if (successes.length > 0) {
		log.info(st('green', `✓ ${successes.length} succeeded:`));
		for (const result of successes) {
			const duration = st('blue', `(${Math.round(result.duration_ms)}ms)`);
			const label = st('gray', `  ${result.repo_name}`);
			const out = result.stdout.trim();
			const out_lines = out ? out.split('\n') : [];
			if (out_lines.length <= 1) {
				// single-line (or empty) output inline after the repo name
				log.info(out ? `${label} ${out} ${duration}` : `${label} ${duration}`);
			} else {
				// multi-line output indented under the repo
				log.info(`${label} ${duration}`);
				for (const line of out_lines) {
					log.info(st('gray', `    ${line}`));
				}
			}
			if (result.truncated) log.warn(st('yellow', TRUNCATED_WARNING));
		}
	}

	// Show failures with details
	if (failures.length > 0) {
		log.info(''); // blank line
		log.error(st('red', `✗ ${failures.length} failed:`));
		for (const result of failures) {
			const duration = `${Math.round(result.duration_ms)}ms`;
			log.error(st('gray', `  ${result.repo_name} ${st('blue', `(${duration})`)}`));

			if (result.error) {
				log.error(st('gray', `    Error: ${result.error}`));
			} else if (result.signal) {
				log.error(st('gray', `    Killed by ${result.signal}`));
			} else if (result.exit_code !== null) {
				log.error(st('gray', `    Exit code: ${result.exit_code}`));
			}

			// the limit's own error already says so
			if (result.truncated && !result.error) log.warn(st('yellow', TRUNCATED_WARNING));

			if (result.stderr) {
				// Show first few lines of stderr
				const stderr_lines = result.stderr.trim().split('\n');
				const preview_lines = stderr_lines.slice(0, 3);
				for (const line of preview_lines) {
					log.error(st('gray', `    ${line}`));
				}
				if (stderr_lines.length > 3) {
					log.error(st('gray', `    ... (${stderr_lines.length - 3} more lines)`));
				}
			}
		}
	}

	// Summary
	log.info(''); // blank line
	const success_rate = ((successes.length / total) * 100).toFixed(0);
	const duration = `${Math.round(total_duration_ms)}ms`;

	if (failures.length === 0) {
		log.info(
			st('green', `✓ All ${total} repos succeeded in ${duration} (${success_rate}% success rate)`)
		);
	} else {
		log.info(
			st(
				'yellow',
				`⚠ ${successes.length}/${total} repos succeeded in ${duration} (${success_rate}% success rate)`
			)
		);
	}
};
