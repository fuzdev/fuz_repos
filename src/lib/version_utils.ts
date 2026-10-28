// TODO: candidate for extraction to `@fuzdev/fuz_util`

/** A semver bump kind: `major`, `minor`, or `patch`. */
export type BumpType = 'major' | 'minor' | 'patch';

export const is_wildcard = (version: string): boolean => {
	return version === '*';
};

/**
 * Strips version prefix (^, ~, >=, <=, etc) from a version string.
 */
export const strip_version_prefix = (version: string): string => {
	return version.replace(/^(>=|<=|>|<|=|\^|~)/, '');
};

/**
 * Gets the version prefix (^, ~, >=, <=, or empty string).
 */
export const get_version_prefix = (version: string): string => {
	const match = /^(>=|<=|>|<|=|\^|~)/.exec(version);
	return match ? match[1]! : '';
};

/**
 * Normalizes version string for comparison.
 *
 * Strips prefixes (^, ~, >=) to get bare version number.
 * Handles wildcards as-is. Used by `needs_update` to compare versions.
 *
 * @example
 * ```ts
 * normalize_version_for_comparison('^1.2.3') // '1.2.3'
 * ```
 * @example
 * ```ts
 * normalize_version_for_comparison('>=2.0.0') // '2.0.0'
 * ```
 * @example
 * ```ts
 * normalize_version_for_comparison('*') // '*'
 * ```
 */
export const normalize_version_for_comparison = (version: string): string => {
	// Handle wildcards
	if (is_wildcard(version)) return version;

	// Handle >= ranges - extract just the version number
	if (version.startsWith('>=')) {
		return version.substring(2).trim();
	}

	// Strip other prefixes
	return strip_version_prefix(version);
};

/**
 * Whether a dependency range must move to name `new_version`: a wildcard always
 * does, and so does a range whose base version is older. One already naming
 * it, or a newer version (a range staged ahead of a publish), doesn't — the
 * rewrite never moves a range backward. A base that isn't `x.y.z` moves
 * whenever it differs, and a protocol range (`file:`, `workspace:`, `npm:`) never.
 *
 * @example
 * ```ts
 * needs_update('^0.54.0', '0.55.0') // true
 * ```
 * @example
 * ```ts
 * needs_update('>=0.56.0', '0.55.0') // false
 * ```
 */
export const needs_update = (current: string, new_version: string): boolean => {
	// a protocol range (`file:`, `workspace:`, `npm:` alias) names no registry version to move
	if (current.includes(':')) return false;
	if (is_wildcard(current)) return true;
	const base = normalize_version_for_comparison(current);
	const next = normalize_version_for_comparison(new_version);
	if (base === next) return false;
	const order = compare_versions(base, next);
	return order === null || order < 0;
};

const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Compares two `x.y.z` versions.
 *
 * @returns negative when `a` is older, positive when newer, `0` when equal, or `null` when either isn't `x.y.z`
 */
export const compare_versions = (a: string, b: string): number | null => {
	const pa = VERSION_REGEX.exec(a);
	const pb = VERSION_REGEX.exec(b);
	if (!pa || !pb) return null;
	for (let i = 1; i <= 3; i++) {
		const diff = Number(pa[i]) - Number(pb[i]);
		if (diff !== 0) return diff;
	}
	return 0;
};

/**
 * The bump a dependency range's move to `new_version` amounts to, measured
 * from the range's base version, and whether that's breaking — so a range
 * lagging behind its dependency's last release counts what it skips.
 *
 * @example
 * ```ts
 * to_range_update_bump('^0.54.0', '0.55.1') // {bump_type: 'minor', breaking: true}
 * ```
 * @returns the bump, or `null` when the range has no `x.y.z` base (a wildcard, a compound range)
 */
export const to_range_update_bump = (
	current: string,
	new_version: string
): { bump_type: BumpType; breaking: boolean } | null => {
	const base = normalize_version_for_comparison(current);
	if (!VERSION_REGEX.test(base) || !VERSION_REGEX.test(new_version)) return null;
	const bump_type = detect_bump_type(base, new_version);
	return { bump_type, breaking: is_breaking_change(base, bump_type) };
};

/**
 * Determines version prefix to use when updating dependencies.
 *
 * Strategy:
 * - Wildcard (*): Use caret (^) as default
 * - Has existing prefix: Preserve it (^, ~, >=, <=, etc)
 * - No prefix: Use default_strategy
 *
 * This preserves user intent while handling wildcard replacements sensibly.
 *
 * @param default_strategy - prefix to use when no existing prefix found
 */
export const get_update_prefix = (
	current_version: string,
	default_strategy: '^' | '~' | '' | '>=' = '^'
): string => {
	// Use caret for wildcard replacements
	if (is_wildcard(current_version)) {
		return '^';
	}

	// Preserve existing prefix if present
	const existing_prefix = get_version_prefix(current_version);
	if (existing_prefix) {
		return existing_prefix;
	}

	// Use default strategy
	return default_strategy;
};

/**
 * How a rewritten range is prefixed when the current one has no prefix of its
 * own (an existing prefix is always kept).
 */
export type VersionStrategy = 'exact' | 'caret' | 'tilde' | 'gte';

export const to_version_strategy_prefix = (strategy: VersionStrategy): '' | '^' | '~' | '>=' =>
	strategy === 'exact' ? '' : strategy === 'caret' ? '^' : strategy === 'gte' ? '>=' : '~';

/**
 * The range a dependency entry is rewritten to when `version` publishes: the
 * current range's prefix kept (see `get_update_prefix`), else the strategy's.
 * The release step writes it and the plan shows it, so the two agree.
 *
 * @example
 * ```ts
 * to_updated_range('>=0.78.0', '0.79.0') // '>=0.79.0'
 * ```
 */
export const to_updated_range = (
	current: string,
	version: string,
	strategy: VersionStrategy = 'caret'
): string => get_update_prefix(current, to_version_strategy_prefix(strategy)) + version;

/**
 * Determines if a bump is a breaking change based on semver rules.
 * Pre-1.0: minor bumps are breaking
 * 1.0+: major bumps are breaking
 */
export const is_breaking_change = (old_version: string, bump_type: BumpType): boolean => {
	const [major] = old_version.split('.').map(Number);
	const is_pre_1_0 = major === 0;

	if (is_pre_1_0) {
		// In 0.x.x, minor bumps are breaking changes
		return bump_type === 'minor' || bump_type === 'major';
	} else {
		// In 1.x.x+, only major bumps are breaking
		return bump_type === 'major';
	}
};

/**
 * The bump a package must take when one of its prod/peer dependencies updates.
 * Pre-1.0: `minor` for a breaking dependency, otherwise `patch`.
 * 1.0+: `major` for a breaking dependency, otherwise `patch`.
 *
 * Single source of truth for the dependency-driven bump rule, shared by the plan
 * (`generate_publishing_plan`) and the auto-changeset generator
 * (`calculate_required_bump`) so the two never drift.
 *
 * @param current_version - the package's current version, used to detect the pre-1.0 regime
 * @param has_breaking_deps - whether any updated dependency is a breaking change
 */
export const required_bump_for_dependency_update = (
	current_version: string,
	has_breaking_deps: boolean
): BumpType => {
	const [major] = current_version.split('.').map(Number);
	const is_pre_1_0 = major === 0;
	if (has_breaking_deps) {
		// Breaking changes propagate: pre-1.0 uses minor, 1.0+ uses major
		return is_pre_1_0 ? 'minor' : 'major';
	}
	// Non-breaking dependency updates only need a patch
	return 'patch';
};

export const detect_bump_type = (old_version: string, new_version: string): BumpType => {
	const old_parts = old_version.split('.').map(Number);
	const new_parts = new_version.split('.').map(Number);

	if (new_parts[0]! > old_parts[0]!) return 'major';
	if (new_parts[1]! > old_parts[1]!) return 'minor';
	return 'patch';
};

/**
 * Compares bump types. Returns positive if a > b, negative if a < b, 0 if equal.
 */
export const compare_bump_types = (a: BumpType, b: BumpType): number => {
	const order: Record<BumpType, number> = {
		major: 3,
		minor: 2,
		patch: 1
	};
	return order[a] - order[b];
};

export const calculate_next_version = (current_version: string, bump_type: BumpType): string => {
	const parts = current_version.split('.').map(Number);
	if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) {
		throw new Error(`Invalid version format: ${current_version}`);
	}

	const [major, minor, patch] = parts;

	switch (bump_type) {
		case 'major':
			return `${major! + 1}.0.0`;
		case 'minor':
			return `${major!}.${minor! + 1}.0`;
		case 'patch':
			return `${major!}.${minor!}.${patch! + 1}`;
		default:
			throw new Error(`Invalid bump type: ${bump_type}`);
	}
};
