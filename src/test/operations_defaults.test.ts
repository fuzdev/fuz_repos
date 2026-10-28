import { assert, describe, test, vi, afterEach } from 'vitest';
import { spawn_out } from '@fuzdev/fuz_util/process.ts';

import { default_npm_operations } from '#lib/operations_defaults.ts';

// `spawn_out` is mocked for `npm view`
vi.mock('@fuzdev/fuz_util/process.ts', async (import_original) => {
	const actual = await import_original<typeof import('@fuzdev/fuz_util/process.ts')>();
	return { ...actual, spawn_out: vi.fn() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('default_npm_operations.view_version', () => {
	test('is true when `npm view` prints the version', async () => {
		vi.mocked(spawn_out).mockResolvedValue({
			result: { kind: 'exited', ok: true, code: 0 },
			stdout: '0.55.0\n',
			stderr: ''
		} as any);
		const result = await default_npm_operations.view_version({
			pkg: '@fuzdev/fuz_code',
			version: '0.55.0'
		});
		assert.deepEqual(result, { ok: true, value: 'listed' });
		assert.deepEqual(vi.mocked(spawn_out).mock.calls[0]?.slice(0, 2), [
			'npm',
			['view', '@fuzdev/fuz_code@0.55.0', 'version']
		]);
	});

	test('is false when the package exists without the version, which prints nothing', async () => {
		vi.mocked(spawn_out).mockResolvedValue({
			result: { kind: 'exited', ok: true, code: 0 },
			stdout: '',
			stderr: ''
		} as any);
		const result = await default_npm_operations.view_version({ pkg: 'a', version: '9.9.9' });
		assert.deepEqual(result, { ok: true, value: 'unlisted' });
	});

	test('is false for a package the registry has never seen (E404)', async () => {
		vi.mocked(spawn_out).mockResolvedValue({
			result: { kind: 'exited', ok: false, code: 1 },
			stdout: '',
			stderr: 'npm error code E404\nnpm error 404 Not Found'
		} as any);
		const result = await default_npm_operations.view_version({ pkg: 'a', version: '0.1.0' });
		assert.deepEqual(result, { ok: true, value: 'unknown' });
	});

	test('fails when npm can not answer, so an outage never reads as unpublished', async () => {
		vi.mocked(spawn_out).mockResolvedValue({
			result: { kind: 'exited', ok: false, code: 1 },
			stdout: '',
			stderr: 'npm error code ENOTFOUND\nnpm error network request failed'
		} as any);
		const result = await default_npm_operations.view_version({ pkg: 'a', version: '0.1.0' });
		assert.ok(!result.ok);
		assert.include(result.message, 'code 1');
		assert.include(result.message, 'ENOTFOUND');
	});
});
