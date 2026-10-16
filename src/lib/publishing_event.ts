/**
 * Structured events for multi-repo publishing.
 *
 * Publishing emits a stream of tagged events alongside its human-readable logging,
 * so machine consumers (CI, dashboards) can follow a run step by step. Every run
 * opens with a `run_started` event carrying `wetrun`: when `false`, the run is a dry
 * run and every `package_completed` is a prediction (its `commit` is `'simulated'`)
 * rather than an applied change. A run's `run_finished` summary is derived from the
 * same event list via `summarize_events`, so the stream and the summary never drift.
 *
 * Events are consumed through a `PublishingEventHandler` sink (see
 * `publishing_event_handler.ts`).
 *
 * @module
 */

import * as s from '@fuzdev/fuz_schema/schema.ts';
import { meta } from '@fuzdev/fuz_schema/meta.ts';

/**
 * Coarse triage classification for a failed package. Lets consumers branch on
 * failure kind without parsing the message.
 */
export const PublishingErrorCode = s.one_of([
	// the publish step failed — its cause is in the message, not yet classified further
	'publish',
	// the published version never appeared on the npm registry within the wait
	'network',
	// the real published version diverged from the frozen plan's prediction — an
	// invariant violation, distinct from an ordinary publish failure (see fail-loud
	// drift detection in `multi_repo_publisher.ts`)
	'drift',
	// the repo wasn't ready when re-checked right before its `gro publish` (origin moved,
	// a tracked edit, a live session, …) — aborted before any npm side effect
	'not_ready'
]);
export type PublishingErrorCode = s.Infer<typeof PublishingErrorCode>;

/** Tallied outcome of a publishing run, derived from its events via `summarize_events`. */
export const PublishingRunSummary = s.object({
	total: meta(s.number, { description: 'packages in the publishing order (the candidate set)' }),
	published: meta(s.number, { description: 'packages published (or, in a dry run, predicted)' }),
	failed: s.number,
	skipped: s.number,
	duration: meta(s.number, { description: 'wall-clock duration in milliseconds' })
});
export type PublishingRunSummary = s.Infer<typeof PublishingRunSummary>;

/**
 * A single structured event emitted during a publishing run. Tagged on `event` so the
 * union serializes as one self-describing JSON object per event (JSON-lines on the wire).
 */
export const PublishingEvent = s.variant('event', [
	s.object({
		event: s.literal('run_started'),
		wetrun: meta(s.boolean, {
			description: 'false means every package_completed is a prediction'
		}),
		total: s.number
	}),
	s.object({
		event: s.literal('package_skipped'),
		name: s.string,
		reason: s.string
	}),
	s.object({
		event: s.literal('package_completed'),
		name: s.string,
		old_version: s.string,
		new_version: s.string,
		// mirrors `BumpType` from `version_utils.ts`; inline so the event schema is self-contained
		bump_type: s.one_of(['major', 'minor', 'patch']),
		breaking: s.boolean,
		commit: meta(s.string, { description: "'simulated' in a dry run, otherwise the commit hash" }),
		tag: s.string
	}),
	s.object({
		event: s.literal('npm_waited'),
		name: s.string,
		version: meta(s.string, { description: 'the version waited on after publishing' })
	}),
	s.object({
		event: s.literal('package_failed'),
		name: s.string,
		error: s.string,
		code: PublishingErrorCode
	}),
	s.object({
		event: s.literal('dependency_updated'),
		dependent: s.string,
		dependency: s.string,
		version: s.string,
		// 'prod'/'peer' updates run inline in the publish pass; 'dev' updates run in the later
		// dev-dependency pass. Lets a consumer reconstruct which side-effect phase this is.
		dep_type: s.one_of(['prod', 'peer', 'dev']),
		// true when the update creates an auto-changeset (a publishable dependent republishes);
		// false for dev-dep updates and update-only leaves (private dependents never publish).
		creates_changeset: s.boolean
	}),
	s.object({
		event: s.literal('deploy_started'),
		name: s.string
	}),
	s.object({
		event: s.literal('deploy_completed'),
		name: s.string
	}),
	s.object({
		event: s.literal('deploy_failed'),
		name: s.string,
		error: s.string
	}),
	s.object({
		event: s.literal('run_finished'),
		summary: PublishingRunSummary
	})
]);
export type PublishingEvent = s.Infer<typeof PublishingEvent>;

/**
 * Derives a run summary from the captured event list — the single canonical path from
 * events to summary, so the `run_finished` summary always agrees with the stream.
 * Call before emitting `run_finished` (which is not itself counted).
 *
 * @param events - the events captured so far this run
 * @param duration - wall-clock duration in milliseconds
 */
export const summarize_events = (
	events: Array<PublishingEvent>,
	duration: number
): PublishingRunSummary => {
	let total = 0;
	let published = 0;
	let failed = 0;
	let skipped = 0;
	for (const event of events) {
		switch (event.event) {
			case 'run_started':
				total = event.total;
				break;
			case 'package_completed':
				published++;
				break;
			case 'package_failed':
				failed++;
				break;
			case 'package_skipped':
				skipped++;
				break;
			default:
				break;
		}
	}
	return { total, published, failed, skipped, duration };
};
