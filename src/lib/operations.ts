/**
 * Operations interfaces for dependency injection.
 *
 * This is the core pattern enabling testability without mocks.
 * All side effects (git, npm, fs, and the `repos` binary) are abstracted into
 * interfaces.
 *
 * **Design principles:**
 * - All operations accept a single `options` object parameter
 * - All fallible operations return `Result` from `@fuzdev/fuz_util`
 * - Never throw `Error` in operations - return `Result` with `ok: false`
 * - Use `null` for expected "not found" cases (not errors)
 * - Include `log?: Logger` in options where logging is useful
 *
 * **Production usage:**
 * ```typescript
 * import {default_npm_operations} from './operations_defaults.ts';
 * const result = await default_npm_operations.view_version({pkg: '@fuzdev/fuz_util', version: '0.1.0'});
 * if (!result.ok) {
 *   throw new TaskError(result.message);
 * }
 * const published = result.value;
 * ```
 *
 * **Test usage:**
 * ```typescript
 * import {create_mock_gitops_ops} from './test_helpers.ts';
 * const ops = create_mock_gitops_ops({
 *   changeset: {has_changesets: async () => ({ok: true, value: false})}
 * });
 * const plan = await generate_publishing_plan(repos, {ops: ops.changeset});
 * // Assert on the plan without any real git/npm calls
 * ```
 *
 * See `operations_defaults.ts` for real implementations, and the test-side mock
 * factories: `create_mock_gitops_ops` in `src/test/test_helpers.ts` (plain
 * objects with per-group overrides) and `create_fixture_gitops_ops` in
 * `src/test/fixtures/mock_operations.ts` (a fixture's changesets over
 * `create_mock_gitops_ops`, its fs empty).
 *
 * @module
 */

import type { Result } from '@fuzdev/fuz_util/result.ts';
import type { FsError } from '@fuzdev/fuz_util/fs.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';
import type { LocalRepo } from './local_repo.ts';
import type { ChangesetInfo } from './changeset_reader.ts';
import type { BumpType } from './version_utils.ts';
import type { RegistryVersion, WaitOptions } from './npm_registry.ts';

/**
 * Changeset operations for reading and predicting versions from `.changeset/*.md` files.
 */
export interface ChangesetOperations {
	/**
	 * Checks if a repo has any changeset files.
	 * Returns true if changesets exist, false if none found.
	 */
	has_changesets: (options: {
		repo: LocalRepo;
	}) => Promise<Result<{ value: boolean }, { message: string }>>;

	/**
	 * Reads all changeset files from a repo.
	 * Returns array of changeset info, or error if reading fails.
	 */
	read_changesets: (options: {
		repo: LocalRepo;
		log?: Logger;
	}) => Promise<Result<{ value: Array<ChangesetInfo> }, { message: string }>>;

	/**
	 * Predicts the next version based on changesets.
	 * Returns null if no changesets found (expected, not an error).
	 * Returns error `Result` if changesets exist but can't be read/parsed.
	 */
	predict_next_version: (options: {
		repo: LocalRepo;
		log?: Logger;
	}) => Promise<Result<{ version: string; bump_type: BumpType }, { message: string }> | null>;
}

/**
 * Git operations the release step authors with: staging and committing
 * dependency rewrites and auto-changesets. All operations return `Result`
 * instead of throwing errors. Where each repo sits (branch, dirt, relation to
 * origin) is `ReposOperations`'s to report.
 */
export interface GitOperations {
	/**
	 * Stages files for commit.
	 */
	add: (options: {
		files: string | Array<string>;
		cwd?: string;
	}) => Promise<Result<object, { message: string }>>;

	/**
	 * Commits `files` alone (`git commit -- <files>`), leaving anything else
	 * staged out of the commit; `files` must be non-empty.
	 */
	commit: (options: {
		message: string;
		files: Array<string>;
		cwd?: string;
	}) => Promise<Result<object, { message: string }>>;
}

/**
 * What a `repos` command printed and how it exited, unparsed.
 */
export interface ReposCommandOutput {
	stdout: string;
	stderr: string;
	/** `0` for a report, `2` for an error document, `1` for a fatal I/O error (maybe no JSON). */
	exit_code: number;
}

/**
 * Operations running the Rust `repos` binary, which owns fleet git state.
 * Parsing its output is `repos_status_load.ts`'s, not the runner's.
 */
export interface ReposOperations {
	/**
	 * Runs `repos [--registry <path>] status [--fetch] <keys…> --json` in the
	 * process's cwd and returns what it printed, whatever its exit code. With
	 * `fetch`, `repos` fetches each entry from origin first, which writes
	 * remote-tracking refs and nothing else. Fails only when the binary didn't
	 * run to an exit: `not_found` when it isn't on `PATH`.
	 */
	status: (options: {
		keys: Array<string>;
		registry?: string;
		fetch?: boolean;
	}) => Promise<
		Result<{ output: ReposCommandOutput }, { kind: 'not_found' | 'failed'; message: string }>
	>;
}

/**
 * Registry operations: whether a version is out, and waiting for one to
 * propagate. npm's own config picks the registry, so a scope pointed elsewhere
 * is read there.
 */
export interface NpmOperations {
	/**
	 * What the registry shows for `pkg@version` (`RegistryVersion`). Fails when
	 * npm can't answer (offline, auth, a crash), so an outage never reads as
	 * unpublished.
	 */
	view_version: (options: {
		pkg: string;
		version: string;
	}) => Promise<Result<{ value: RegistryVersion }, { message: string }>>;

	/**
	 * Waits for a package version to be available on NPM.
	 * Uses exponential backoff with configurable timeout.
	 */
	wait_for_package: (options: {
		pkg: string;
		version: string;
		wait_options?: WaitOptions;
		log?: Logger;
	}) => Promise<Result<object, { message: string }>>;
}

/**
 * File system operations for reading and writing files.
 *
 * Errors are typed via `FsError` (`not_found | permission_denied |
 * already_exists | io_error`) so callers can branch on `kind` instead of
 * regex-matching `message`. See `@fuzdev/fuz_util/fs.ts`.
 */
export interface FsOperations {
	/**
	 * Reads a file from the file system.
	 */
	readFile: (options: {
		path: string;
		encoding: BufferEncoding;
	}) => Promise<Result<{ value: string }, FsError>>;

	/**
	 * Writes a file to the file system.
	 */
	writeFile: (options: { path: string; content: string }) => Promise<Result<object, FsError>>;

	/**
	 * Creates a directory, optionally with recursive creation.
	 */
	mkdir: (options: { path: string; recursive?: boolean }) => Promise<Result<object, FsError>>;

	/**
	 * Checks if a path exists on the file system.
	 */
	exists: (options: { path: string }) => Promise<boolean>;
}
