/**
 * Shared constants for gitops tasks and operations.
 *
 * Naming convention: GITOPS_{NAME}_DEFAULT for user-facing defaults.
 *
 * @module
 */

/**
 * Default path to the gitops configuration file.
 */
export const GITOPS_CONFIG_PATH_DEFAULT = 'gitops.config.ts';

/**
 * Default number of repos to process concurrently during parallel operations.
 */
export const GITOPS_CONCURRENCY_DEFAULT = 5;

/**
 * Default timeout in milliseconds for `gitops_release --wait` to wait on registry
 * propagation (10 minutes). npm's CDN is eventually consistent, so a published
 * version can take minutes to show.
 */
export const GITOPS_NPM_WAIT_TIMEOUT_DEFAULT = 600_000; // 10 minutes
