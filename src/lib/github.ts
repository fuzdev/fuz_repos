import type { Logger } from '@fuzdev/fuz_util/log.ts';
import { fetch_value, type FetchValueCache } from '@fuzdev/fuz_util/fetch.ts';
import type { Result } from '@fuzdev/fuz_util/result.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';

/**
 * Minimal interface for GitHub API calls, satisfied structurally by fuz_ui's `Library`.
 */
export interface GithubRepoInfo {
	owner_name: string | null;
	repo_name: string;
}

// GitHub's responses carry many more fields than these, and add fields over
// time, so the objects accept unknown keys and drop them: what's kept is
// written into the generated `repos.json`, which carries only these

/**
 * @see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests
 */
export const GithubPullRequest = s.strip_object({
	number: s.number,
	title: s.string,
	user: s.strip_object({
		login: s.string
	}),
	draft: s.boolean
});
export type GithubPullRequest = s.Infer<typeof GithubPullRequest>;
export const GithubPullRequests = s.array(GithubPullRequest);
export type GithubPullRequests = s.Infer<typeof GithubPullRequests>;

/**
 * @see https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-pull-requests
 */
export const fetch_github_pull_requests = async (
	repo_info: GithubRepoInfo,
	options: {
		cache?: FetchValueCache;
		log?: Logger;
		token?: string;
		api_version?: string;
		fetch?: typeof globalThis.fetch;
	} = {}
): Promise<GithubPullRequests | null> => {
	const { cache, log, token, api_version, fetch } = options;
	if (!repo_info.owner_name) throw Error('owner_name is required');
	const headers = api_version ? new Headers({ 'x-github-api-version': api_version }) : undefined;
	const url = `https://api.github.com/repos/${repo_info.owner_name}/${repo_info.repo_name}/pulls`;
	const fetched = await fetch_value(url, {
		request: { headers },
		parse: (v) => s.parse_or_throw(GithubPullRequests, v),
		token,
		cache,
		log,
		fetch
	});
	if (!fetched.ok) {
		// TODO @many this is messy but I think it's the main case we need to worry about?
		if (fetched.status === 401) {
			throw Error(
				'401 response fetching github pull requests - check your SECRET_GITHUB_API_TOKEN'
			);
		}
		return null;
	}
	return fetched.value;
};

/**
 * @see https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference
 */
export const GithubCheckRunsItem = s.strip_object({
	status: s.one_of(['queued', 'in_progress', 'completed']),
	conclusion: s.nullable(
		s.one_of([
			'success',
			'failure',
			'neutral',
			'cancelled',
			'skipped',
			'timed_out',
			'action_required'
		])
	)
});
export type GithubCheckRunsItem = s.Infer<typeof GithubCheckRunsItem>;
export const GithubCheckRuns = s.strip_object({
	total_count: s.number,
	check_runs: s.array(GithubCheckRunsItem)
});
export type GithubCheckRuns = s.Infer<typeof GithubCheckRuns>;

/**
 * Fetches the check runs on `ref` and reduces them to one overall status and
 * conclusion.
 *
 * @param repo_info - the repo's GitHub owner and name
 * @param options - the cache, logger, token, API version, ref (`main` by default), and `fetch`
 * @returns the reduced check runs, `null` for a ref with none (a repo without CI, or a commit CI skipped), or a failure when the request or its parse failed
 * @throws {Error} on a 401 response (check `SECRET_GITHUB_API_TOKEN`) or a repo without an owner
 * @see https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference
 */
export const fetch_github_check_runs = async (
	repo_info: GithubRepoInfo,
	options: {
		cache?: FetchValueCache;
		log?: Logger;
		token?: string;
		api_version?: string;
		ref?: string;
		fetch?: typeof globalThis.fetch;
	} = {}
): Promise<Result<{ value: GithubCheckRunsItem | null }, { status: number; message: string }>> => {
	const { cache, log, token, api_version, ref = 'main', fetch } = options;
	if (!repo_info.owner_name) throw Error('owner_name is required');
	const headers = api_version ? new Headers({ 'x-github-api-version': api_version }) : undefined;
	const url = `https://api.github.com/repos/${repo_info.owner_name}/${repo_info.repo_name}/commits/${ref}/check-runs`;
	const fetched = await fetch_value(url, {
		request: { headers },
		parse: (v) => reduce_check_runs(s.parse_or_throw(GithubCheckRuns, v).check_runs),
		token,
		cache,
		log,
		fetch
	});
	if (!fetched.ok) {
		// TODO @many this is messy but I think it's the main case we need to worry about?
		if (fetched.status === 401) {
			throw Error('401 response fetching github CI status - check your SECRET_GITHUB_API_TOKEN');
		}
		return { ok: false, status: fetched.status, message: fetched.message };
	}
	return { ok: true, value: fetched.value };
};

const reduce_check_runs = (check_runs: Array<GithubCheckRunsItem>): GithubCheckRunsItem | null => {
	if (!check_runs.length) return null;
	// TODO fix these types and remove the eslint disable, `GithubCheckRunsItem` should maybe have nullable properties?
	let status!: GithubCheckRunsItem['status'];
	let conclusion!: GithubCheckRunsItem['conclusion'];
	for (const check_run of check_runs) {
		if (!status || status === 'completed') {
			status = check_run.status;
		}
		if (!conclusion || conclusion === 'success') {
			conclusion = check_run.conclusion;
		}
	}
	return { status, conclusion };
};
