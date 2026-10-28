import { TaskError, type Task } from '@fuzdev/gro';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';
import { map_concurrent } from '@fuzdev/fuz_util/async.ts';
import { to_error_message } from '@fuzdev/fuz_util/error.ts';
import { relative } from 'node:path';
import { styleText as st } from 'node:util';

import { get_gitops_ready, type ResolveGitopsReposOptions } from './gitops_task_helpers.ts';
import { repo_is_npm, type LocalRepo } from './local_repo.ts';
import type { ReposStatusReport } from './repos_status.ts';
import type { RegistryVersion } from './npm_registry.ts';
import type {
	ChangesetOperations,
	FsOperations,
	GitOperations,
	NpmOperations
} from './operations.ts';
import {
	default_changeset_operations,
	default_fs_operations,
	default_git_operations,
	default_npm_operations
} from './operations_defaults.ts';
import { generate_publishing_plan, type PublishingPlan } from './publishing_plan.ts';
import { format_waves, to_dependency_type_label } from './publishing_plan_logging.ts';
import { check_release_readiness } from './repo_readiness.ts';
import { to_repos_command } from './repos_status_load.ts';
import { to_release_state, type ReleaseState } from './release_state.ts';
import { update_package_json } from './dependency_updater.ts';
import { to_updated_range } from './version_utils.ts';
import {
	GITOPS_CONCURRENCY_DEFAULT,
	GITOPS_CONFIG_PATH_DEFAULT,
	GITOPS_NPM_WAIT_TIMEOUT_DEFAULT
} from './gitops_constants.ts';

/** @nodocs */
export const Args = s.object({
	config: s.with_default(
		meta(s.string, {
			description: 'path to the gitops config file, absolute or relative to the cwd'
		}),
		GITOPS_CONFIG_PATH_DEFAULT
	),
	registry: s.optional(
		meta(s.string, {
			description:
				'path to the repos.toml registry, when `repos` would not find it walking up from the cwd'
		})
	),
	wetrun: s.with_default(
		meta(s.boolean, {
			description: 'commit the dependency rewrites; without it, the step changes nothing'
		}),
		false
	),
	wait: s.with_default(
		meta(s.boolean, {
			description:
				'first wait for every version awaiting the registry to show, then read the state again'
		}),
		false
	),
	max_wait: s.with_default(
		meta(s.pipe(s.number, s.safe_integer, s.min_value(0)), {
			description: 'with --wait, the most milliseconds to wait for the registry'
		}),
		GITOPS_NPM_WAIT_TIMEOUT_DEFAULT
	),
	range_strategy: s.with_default(
		meta(s.one_of(['exact', 'caret', 'tilde', 'gte']), {
			description: 'prefix for a rewritten range that has none; an existing prefix is kept'
		}),
		'caret'
	)
});
export type Args = s.Infer<typeof Args>;

/**
 * One step of a release, derived from observed state each time it runs:
 * fetches the repos, asks the registry which current versions are out, plans
 * the rest (`generate_publishing_plan`), rewrites the ranges of dependents
 * whose dependencies are released (with `--wetrun`), and names the wave to
 * publish now. Publishing stays yours — `gro publish` in each repo it names,
 * inside one 2FA window — and running it again picks up from there.
 *
 * Usage:
 *   `gro gitops_release` — what the step would do; changes nothing
 *   `gro gitops_release --wetrun` — commit the rewrites, then name the wave
 *   `gro gitops_release --wetrun --wait` — wait out the registry first
 *
 * @nodocs
 */
export const task: Task<Args> = {
	summary: 'step a multi-repo release: rewrite released dependencies, name the wave to publish',
	Args,
	run: async ({ args, log }): Promise<void> => {
		await run_gitops_release(args, log);
	}
};

/**
 * The side effects `run_gitops_release` reaches through, injectable for tests.
 *
 * @nodocs
 */
export interface GitopsReleaseDeps {
	/** Loads the configured repos as they sit, after a fetch (`get_gitops_ready`). */
	load_repos: (
		options: ResolveGitopsReposOptions
	) => Promise<{ local_repos: Array<LocalRepo>; report: ReposStatusReport }>;
	changeset_ops: ChangesetOperations;
	npm_ops: NpmOperations;
	git_ops: GitOperations;
	fs_ops: FsOperations;
	/** The directory publish commands are written relative to. */
	cwd: string;
}

const default_gitops_release_deps: GitopsReleaseDeps = {
	load_repos: get_gitops_ready,
	changeset_ops: default_changeset_operations,
	npm_ops: default_npm_operations,
	git_ops: default_git_operations,
	fs_ops: default_fs_operations,
	cwd: process.cwd()
};

/**
 * What a release step found and did.
 *
 * @nodocs
 */
export interface GitopsReleaseResult {
	plan: PublishingPlan;
	state: ReleaseState;
	/** The dependents whose rewrites were committed; empty without `--wetrun`. */
	rewritten: Array<string>;
}

/**
 * Runs one release step (see `task`).
 *
 * @throws {TaskError} if the registry can't be read, the plan has errors, or a rewrite fails (after the others ran)
 * @nodocs
 */
export const run_gitops_release = async (
	args: Args,
	log: Logger,
	deps: Partial<GitopsReleaseDeps> = {}
): Promise<GitopsReleaseResult> => {
	const d = { ...default_gitops_release_deps, ...deps };
	const { registry, wetrun, wait, max_wait, range_strategy } = args;

	let observed = await observe(args, log, d);
	if (wait && observed.plan.awaiting_registry.length > 0) {
		await wait_for_registry(observed.plan, max_wait, log, d.npm_ops);
		observed = await observe(args, log, d);
	}
	const { npm_repos, report, plan } = observed;

	if (plan.errors.length > 0) {
		throw new TaskError(
			`the plan has errors, so nothing was changed:\n  ${plan.errors.join('\n  ')}`
		);
	}
	for (const warning of plan.warnings) {
		log.warn(st('yellow', warning));
	}

	const repos_command = to_repos_command(registry);
	const readiness = check_release_readiness({
		report,
		keys: npm_repos.map((r) => r.entry.key),
		repos_command
	});
	const not_ready: Map<string, Array<string>> = new Map();
	for (const repo of npm_repos) {
		const reasons = readiness.by_key.get(repo.entry.key);
		if (reasons && reasons.length > 0) not_ready.set(repo.library.name, reasons);
	}

	const state = to_release_state({
		plan,
		repos: npm_repos,
		not_ready,
		held_all: readiness.global
	});
	const repo_by_name: Map<string, LocalRepo> = new Map(npm_repos.map((r) => [r.library.name, r]));

	if (plan.never_published.length > 0) {
		log.info(
			st(
				'dim',
				`never published, with nothing to publish (mark them \`private\` if they never will): ${plan.never_published.join(', ')}`
			)
		);
	}
	if (state.done) {
		log.info(st('green', 'nothing to release: every version is out and every range names it'));
		return { plan, state, rewritten: [] };
	}

	// rewrites: the dependents of released dependencies
	const rewritten: Array<string> = [];
	const rewrite_failures: Array<string> = [];
	if (state.rewrites.length > 0) {
		log.info(
			st(
				'cyan',
				wetrun
					? 'Rewriting the ranges of released dependencies:'
					: 'Would rewrite the ranges of released dependencies (--wetrun commits them):'
			)
		);
		for (const rewrite of state.rewrites) {
			log.info(
				`  ${rewrite.name}${rewrite.changeset ? st('dim', ' (with its auto-changeset)') : ''}`
			);
			for (const update of rewrite.updates) {
				const next = to_updated_range(update.current_version, update.new_version, range_strategy);
				log.info(
					st(
						'dim',
						// a dev rewrite never bumps, so breaking says nothing there
						`    ${update.updated_dependency}: ${update.current_version} → ${next}  # ${to_dependency_type_label(update.type)}${update.breaking && update.type !== 'devDependencies' ? ', breaking' : ''}`
					)
				);
			}
			if (!wetrun) continue;
			const repo = repo_by_name.get(rewrite.name);
			if (!repo) continue;
			try {
				await update_package_json(repo, rewrite.updates, {
					strategy: range_strategy,
					changeset: rewrite.changeset,
					log,
					git_ops: d.git_ops,
					fs_ops: d.fs_ops
				});
				rewritten.push(rewrite.name);
			} catch (error) {
				const message = `${rewrite.name}: ${to_error_message(error)}`;
				rewrite_failures.push(message);
				log.error(st('red', `  ❌ ${message}`));
			}
		}
		log.info('');
	}
	for (const held of state.rewrites_held) {
		log.warn(
			st('yellow', `held rewrite of ${held.name}'s ranges:\n    ${held.reasons.join('\n    ')}`)
		);
	}

	// what's out but not visible yet
	if (plan.awaiting_registry.length > 0) {
		log.info(
			st(
				'yellow',
				'Awaiting the registry, first publishes included (rerun once they show, or pass --wait; ' +
					"one that never shows wasn't published, so check its repo):"
			)
		);
		for (const { name, version } of plan.awaiting_registry) {
			log.info(`  ${name}@${version}`);
		}
		log.info('');
	}

	// the wave to publish now, and the forecast after it
	const failed_rewrites = new Set(
		state.rewrites.map((r) => r.name).filter((name) => wetrun && !rewritten.includes(name))
	);
	const publish_now = state.publish_now.filter((name) => !failed_rewrites.has(name));
	if (publish_now.length > 0) {
		const needs_rewrite = !wetrun && state.rewrites.length > 0;
		log.info(
			st(
				'cyan',
				needs_rewrite
					? 'Publish now, once --wetrun has committed the rewrites (one 2FA window):'
					: 'Publish now (one 2FA window):'
			)
		);
		const commands = publish_now.map((name) => to_publish_command(repo_by_name.get(name)!, d.cwd));
		for (const command of commands) {
			log.info(`  ${command}`);
		}
		if (commands.length > 1) {
			log.info(st('dim', '  or all together:'));
			log.info(`  ${commands.map((c) => `(${c})`).join(' && ')}`);
		}
		log.info('');
	}
	for (const held of state.publish_held) {
		log.warn(st('yellow', `held publish of ${held.name}:\n    ${held.reasons.join('\n    ')}`));
	}
	if (plan.waves.length > 1) {
		log.info(st('dim', 'Then, a step at a time:'));
		for (const line of format_waves(plan.waves).slice(1)) {
			log.info(st('dim', `  ${line}`));
		}
		log.info('');
	}

	log.info(
		st(
			'dim',
			publish_now.length > 0
				? 'After publishing, run `gro gitops_release --wetrun` again (add --wait to wait out the registry).'
				: 'Run `gro gitops_release --wetrun` again once the holds above clear.'
		)
	);

	if (rewrite_failures.length > 0) {
		throw new TaskError(
			`${rewrite_failures.length} rewrite(s) failed, the rest were committed:\n  ${rewrite_failures.join('\n  ')}`
		);
	}
	return { plan, state, rewritten };
};

interface Observed {
	npm_repos: Array<LocalRepo>;
	report: ReposStatusReport;
	plan: PublishingPlan;
}

/**
 * Fetches and loads the repos, asks the registry whether each publishable
 * package's current version is out, and plans from that.
 *
 * @throws {TaskError} if npm can't answer for some package
 */
const observe = async (args: Args, log: Logger, d: GitopsReleaseDeps): Promise<Observed> => {
	const { config, registry } = args;
	const { local_repos, report } = await d.load_repos({ config, registry, fetch: true, log });
	const npm_repos = local_repos.filter(repo_is_npm);
	const publishable = npm_repos.filter((r) => !r.package_json.private);

	log.info(`asking the registry for ${publishable.length} packages' current versions`);
	const answers = await map_concurrent(publishable, GITOPS_CONCURRENCY_DEFAULT, async (repo) => {
		const pkg = repo.library.name;
		const version = repo.package_json.version || '0.0.0';
		return { pkg, version, result: await d.npm_ops.view_version({ pkg, version }) };
	});
	const visible: Map<string, RegistryVersion> = new Map();
	const failures: Array<string> = [];
	for (const { pkg, version, result } of answers) {
		if (result.ok) visible.set(pkg, result.value);
		else failures.push(`${pkg}@${version}: ${result.message}`);
	}
	if (failures.length > 0) {
		throw new TaskError(
			`couldn't read the registry, so nothing was changed:\n  ${failures.join('\n  ')}`
		);
	}

	const plan = await generate_publishing_plan(local_repos, {
		log,
		ops: d.changeset_ops,
		registry: visible
	});
	return { npm_repos, report, plan };
};

/** Waits for every version awaiting the registry, together, logging the ones that never show. */
const wait_for_registry = async (
	plan: PublishingPlan,
	max_wait: number,
	log: Logger,
	npm_ops: NpmOperations
): Promise<void> => {
	log.info(
		`waiting up to ${Math.round(max_wait / 1000)}s for ${plan.awaiting_registry.length} version(s) to show on the registry`
	);
	const waited = await Promise.all(
		plan.awaiting_registry.map(async ({ name, version }) => ({
			name,
			version,
			result: await npm_ops.wait_for_package({
				pkg: name,
				version,
				wait_options: { timeout: max_wait },
				log
			})
		}))
	);
	for (const { name, version, result } of waited) {
		if (!result.ok) log.warn(st('yellow', `${name}@${version} didn't show: ${result.message}`));
	}
};

/**
 * The command that publishes one repo, from `cwd`: `gro publish`, naming the
 * registry branch when it isn't gro's default `main`.
 */
const to_publish_command = (repo: LocalRepo, cwd: string): string => {
	const dir = relative(cwd, repo.repo_dir) || '.';
	const branch = repo.entry.branch;
	const branch_arg = branch && branch !== 'main' ? ` --branch ${branch}` : '';
	return `cd ${dir} && gro publish${branch_arg}`;
};
