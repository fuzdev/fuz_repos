/**
 * Shared initialization logic for all gitops tasks.
 *
 * `resolve_gitops_repos()` loads the config's registry keys, runs
 * `repos status <keys…> --json`, and resolves each key to its checkout.
 * `get_gitops_ready()` then loads each repo's `package.json` as its working
 * tree sits, without the module analysis. `log_readiness_block()` is the
 * diagnostics' report of repos not at rest (over `repo_readiness.ts`).
 *
 * Used by: `gitops_sync.task.ts`, `gitops_analyze.task.ts`, `gitops_plan.task.ts`,
 * `gitops_release.task.ts`, `gitops_validate.task.ts`, and `gitops_run.task.ts`.
 *
 * Accepts `repos_ops` to support testing via the operations pattern (see
 * `operations.ts` for dependency injection details).
 *
 * @module
 */

import { TaskError } from '@fuzdev/gro';
import { styleText as st } from 'node:util';
import { resolve } from 'node:path';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';

import { load_gitops_config, type GitopsConfig } from './gitops_config.ts';
import {
	local_repos_load,
	local_repos_resolve,
	repo_is_npm,
	type LocalRepo,
	type LocalRepoPath
} from './local_repo.ts';
import { load_repos_status } from './repos_status_load.ts';
import { format_readiness_block, repos_not_at_rest } from './repo_readiness.ts';
import type { ReposStatusReport } from './repos_status.ts';
import type { ReposOperations } from './operations.ts';
import { default_repos_operations } from './operations_defaults.ts';

export interface ResolveGitopsReposOptions {
	/** Path to the gitops config, absolute or relative to the cwd. */
	config: string;
	/** A `repos.toml` to use instead of the one `repos` finds walking up from the cwd. */
	registry?: string;
	/**
	 * Fetch each repo from origin first (`repos status --fetch`), which writes
	 * remote-tracking refs and nothing else, so the report's relations to origin
	 * are current.
	 */
	fetch?: boolean;
	/**
	 * The package whose generated data the run writes; when it's public, a
	 * private repo in the config fails the resolve.
	 */
	host?: { name: string; private: boolean };
	log?: Logger;
	repos_ops?: ReposOperations;
}

/**
 * Resolves the gitops config's repos through `repos status`: loads the
 * config's registry keys, reports on them, and resolves each to its checkout,
 * in config order. Reads nothing but git state, and writes nothing but the
 * remote-tracking refs a `fetch` refreshes.
 *
 * @returns the config, the `repos status` report, and each repo's path and entry
 * @throws {TaskError} if the config is missing, invalid, or lists no repos, `repos status` fails, or any configured repo is unknown, a reference, missing, not a repo, unprobed, or private under a public `host`
 */
export const resolve_gitops_repos = async (
	options: ResolveGitopsReposOptions
): Promise<{
	config_path: string;
	gitops_config: GitopsConfig;
	report: ReposStatusReport;
	local_repo_paths: Array<LocalRepoPath>;
}> => {
	const { config, registry, fetch, host, log, repos_ops = default_repos_operations } = options;
	const config_path = resolve(config);
	const gitops_config = await import_gitops_config(config_path);
	const keys = gitops_config.repos;
	if (keys.length === 0) {
		throw new TaskError(`No repos are configured in ${config_path}`);
	}

	log?.info(
		fetch
			? `fetching ${keys.length} repos and reading their state from \`repos status --fetch\``
			: `reading the state of ${keys.length} repos from \`repos status\``
	);
	log?.debug('repos status targets', keys);
	const loaded = await load_repos_status({ keys, registry, fetch, repos_ops });
	if (!loaded.ok) {
		// an unknown key is the config's to fix, so name the config
		throw new TaskError(
			loaded.error?.kind === 'unknown_entry' ? `${config_path}: ${loaded.message}` : loaded.message
		);
	}
	const { report } = loaded;

	const resolved = local_repos_resolve({ keys, report, host, registry });
	if (!resolved.ok) {
		throw new TaskError(`${config_path}: ${resolved.message}`);
	}

	return { config_path, gitops_config, report, local_repo_paths: resolved.value };
};

/**
 * Central initialization function for the publishing and dependency tasks
 * (`gitops_analyze`, `gitops_plan`, `gitops_release`, `gitops_validate`):
 * resolves the config's repos through `repos status` (`resolve_gitops_repos`),
 * then loads each repo as its working tree sits (`local_repos_load`) with no
 * module analysis — those tasks read each package's name, version, and
 * dependencies, never its modules — so it moves no ref and writes nothing.
 *
 * @returns the loaded repos, in config order, and the `repos status` report they came from
 * @throws {TaskError} if resolving the repos or loading them fails
 */
export const get_gitops_ready = async (
	options: ResolveGitopsReposOptions
): Promise<{ local_repos: Array<LocalRepo>; report: ReposStatusReport }> => {
	const { local_repo_paths, report } = await resolve_gitops_repos(options);
	const local_repos = await local_repos_load({
		local_repo_paths,
		modules: false,
		log: options.log
	});
	return { local_repos, report };
};

/**
 * Logs the diagnostics' readiness block as warnings (stderr, so a `--format
 * json` or `markdown` document on stdout stays clean): each npm repo not at
 * rest, and how. Logs nothing when every one is at rest. Reads the entries
 * `repos status` already reported, from local refs.
 *
 * @param local_repos - the loaded repos; the npm ones are reported
 * @param log - where the warnings go
 * @param now - the current time in unix seconds (defaults to the clock)
 */
export const log_readiness_block = (
	local_repos: ReadonlyArray<LocalRepo>,
	log: Logger,
	now: number = Math.floor(Date.now() / 1000)
): void => {
	const not_ready = repos_not_at_rest(local_repos.filter(repo_is_npm).map((r) => r.entry));
	for (const line of format_readiness_block(not_ready, now)) {
		log.warn(st('yellow', line));
	}
};

const import_gitops_config = async (config_path: string): Promise<GitopsConfig> => {
	let gitops_config: GitopsConfig | null;
	try {
		gitops_config = await load_gitops_config(config_path);
	} catch (err) {
		// an invalid config is the user's to fix, not an unexpected task failure
		throw new TaskError(to_error_message(err));
	}
	if (!gitops_config) {
		throw new TaskError(st('red', `No gitops config found at ${config_path}`));
	}
	return gitops_config;
};
