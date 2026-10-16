import { assert, describe, test } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';
import { readdirSync } from 'node:fs';

import {
	REPOS_STATUS_FORMAT_VERSION,
	ReposSessions,
	ReposStatusDocument,
	ReposStatusErrorBody,
	ReposStatusErrorReport,
	ReposStatusReport
} from '#lib/repos_status.ts';
import { GOLDEN_DIR, load_golden } from './test_helpers.ts';

/** A failed parse's issues, one a line, for an assertion message. */
const format_failure = (result: s.SchemaResult<unknown>): string | undefined =>
	result.ok ? undefined : result.issues.map(s.format_issue).join('\n');

type GoldenKind = 'report' | 'error' | 'sessions' | 'not_mirrored';

/**
 * Which schema a golden is parsed with, by name — `null` for a name no rule
 * knows, so a new golden fails until it's sorted here.
 */
const golden_kind = (name: string): GoldenKind | null => {
	if (/^status_report(_[a-z_]+)?\.json$/.test(name)) return 'report';
	if (/^error_report_[a-z_]+\.json$/.test(name)) return 'error';
	if (name === 'sessions.json') return 'sessions';
	// the sync and push documents have no TS mirror yet
	if (/^(sync|push)_[a-z_]+\.json$/.test(name)) return 'not_mirrored';
	return null;
};

const golden_names = readdirSync(GOLDEN_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
const goldens_of = (kind: GoldenKind): Array<string> =>
	golden_names.filter((f) => golden_kind(f) === kind);

describe('golden discovery', () => {
	test('every golden is sorted into a kind', () => {
		const unknown = golden_names.filter((f) => golden_kind(f) === null);
		assert.deepEqual(unknown, []);
	});

	test('the status goldens are all there', () => {
		assert.include(goldens_of('report'), 'status_report.json');
		assert.include(goldens_of('report'), 'status_report_targeted.json');
		assert.include(goldens_of('sessions'), 'sessions.json');
		assert.ok(goldens_of('error').length > 0, 'no error_report_<kind>.json goldens');
	});

	test('every error kind the mirror knows has its golden', () => {
		const kinds = ReposStatusErrorBody.def.options.map((o) => o.def.kind.def).sort();
		const named = goldens_of('error')
			.map((f) => f.slice('error_report_'.length, -'.json'.length))
			.sort();
		assert.deepEqual(named, kinds);
	});
});

describe('golden documents parse strictly', () => {
	test.each(goldens_of('report'))('%s', (name) => {
		const result = s.parse(ReposStatusReport, load_golden(name));
		assert.ok(result.ok, format_failure(result));
	});

	test.each(goldens_of('error'))('%s', (name) => {
		const result = s.parse(ReposStatusErrorReport, load_golden(name));
		assert.ok(result.ok, format_failure(result));
		// named for its kind
		assert.strictEqual(name, `error_report_${result.value.error.kind}.json`);
	});

	test('sessions.json', () => {
		const result = s.parse(s.array(ReposSessions), load_golden('sessions.json'));
		assert.ok(result.ok, format_failure(result));
	});

	test('either document parses as a status document', () => {
		for (const name of [...goldens_of('report'), ...goldens_of('error')]) {
			const result = s.parse(ReposStatusDocument, load_golden(name));
			assert.ok(result.ok, `${name}: ${format_failure(result)}`);
			assert.strictEqual('error' in result.value, golden_kind(name) === 'error', name);
		}
	});
});

/** The status report golden, parsed, then changed by `mutate`. */
const report_with = (
	mutate: (doc: ReposStatusReport, entry: ReposStatusReport['entries'][number]) => void
): unknown => {
	const doc = s.parse_or_throw(ReposStatusReport, load_golden('status_report.json'));
	const entry = doc.entries[0];
	assert.ok(entry);
	mutate(doc, entry);
	return doc;
};

/** An error golden, parsed, then changed by `mutate`. */
const error_with = (mutate: (doc: ReposStatusErrorReport) => void): unknown => {
	const doc = s.parse_or_throw(ReposStatusErrorReport, load_golden('error_report_io.json'));
	mutate(doc);
	return doc;
};

const assert_refused = (result: { ok: boolean }): void => {
	assert.ok(!result.ok, 'parsed a document the mirror should refuse');
};

describe('the mirror refuses drift', () => {
	test('an unknown field', () => {
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((doc) => Object.assign(doc, { x: 1 }))
			)
		);
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => Object.assign(entry, { x: 1 }))
			)
		);
		assert_refused(
			s.parse(
				ReposStatusErrorReport,
				error_with((doc) => Object.assign(doc.error, { x: 1 }))
			)
		);
	});

	test('an unknown kind', () => {
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => Object.assign(entry.presence, { kind: 'elsewhere' }))
			)
		);
		assert_refused(
			s.parse(
				ReposStatusErrorReport,
				error_with((doc) => Object.assign(doc.error, { kind: 'elsewhere' }))
			)
		);
	});

	test('a variant the status document never carries', () => {
		// a push's rejection is never a fetch's
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) =>
					Object.assign(entry, {
						fetch_error: { kind: 'rejected', reason: 'non-fast-forward', message: null }
					})
				)
			)
		);
		// a refresh's hold is never a branch's
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => {
					const branch = entry.branches[0];
					assert.ok(branch);
					branch.verdict = { kind: 'held', action: { kind: 'move' }, by: 'pinned' };
					Object.assign(branch.verdict, { by: 'origin_not_https' });
				})
			)
		);
		// an unreadable HEAD is `null`, never a kind of its own
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => {
					const unprobed = entry.unprobed_worktrees[0];
					assert.ok(unprobed);
					Object.assign(unprobed, { head: { kind: 'unknown' } });
				})
			)
		);
		// `repos push`'s alone
		assert_refused(
			s.parse(
				ReposStatusErrorReport,
				error_with((doc) => Object.assign(doc.error, { kind: 'no_checkout' }))
			)
		);
	});

	test('another version', () => {
		for (const version of [REPOS_STATUS_FORMAT_VERSION - 1, REPOS_STATUS_FORMAT_VERSION + 1]) {
			assert_refused(
				s.parse(
					ReposStatusReport,
					report_with((doc) => Object.assign(doc, { version }))
				)
			);
			assert_refused(
				s.parse(
					ReposStatusErrorReport,
					error_with((doc) => Object.assign(doc, { version }))
				)
			);
		}
	});

	test('a missing field', () => {
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((doc) => Reflect.deleteProperty(doc, 'sessions'))
			)
		);
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => Reflect.deleteProperty(entry, 'stashes'))
			)
		);
		// `null`, never omitted
		assert_refused(
			s.parse(
				ReposStatusReport,
				report_with((_, entry) => Reflect.deleteProperty(entry, 'probe_error'))
			)
		);
		assert_refused(
			s.parse(
				ReposStatusErrorReport,
				error_with((doc) => Reflect.deleteProperty(doc.error, 'hint'))
			)
		);
		const session = s.parse_or_throw(s.array(ReposSessions), load_golden('sessions.json'))[0];
		assert.ok(session?.kind === 'available');
		const unscoped = session.unscoped[0];
		assert.ok(unscoped);
		assert.strictEqual(unscoped.worktree, null);
		Reflect.deleteProperty(unscoped, 'worktree');
		assert_refused(s.parse(ReposSessions, session));
	});

	test('the document union refuses a report carrying an error', () => {
		const doc = report_with((d) =>
			Object.assign(d, { error: { kind: 'io', message: 'x', hint: null } })
		);
		assert_refused(s.parse(ReposStatusDocument, doc));
	});
});
