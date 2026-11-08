import { assert, afterEach, describe, test, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { default_fs_operations } from '#lib/operations_defaults.ts';

vi.mock('node:fs/promises', async (import_original) => {
	const actual = await import_original<typeof import('node:fs/promises')>();
	return { ...actual, readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() };
});

afterEach(() => {
	vi.restoreAllMocks();
});

const to_code_error = (code: string): Error =>
	Object.assign(new Error(`${code}: failed`), { code });

describe('default_fs_operations error classification', () => {
	test.each([
		['ENOENT', 'not_found'],
		['EACCES', 'permission_denied'],
		['EPERM', 'permission_denied'],
		['EEXIST', 'already_exists'],
		['EISDIR', 'io_error']
	])('a thrown %s is %s', async (code, kind) => {
		vi.mocked(readFile).mockRejectedValue(to_code_error(code));
		const result = await default_fs_operations.readFile({ path: 'a', encoding: 'utf8' });
		assert.deepEqual(result, { ok: false, kind, message: `${code}: failed` } as typeof result);
	});

	test('an error without a code is io_error', async () => {
		vi.mocked(readFile).mockRejectedValue(new Error('boom'));
		const result = await default_fs_operations.readFile({ path: 'a', encoding: 'utf8' });
		assert.deepEqual(result, { ok: false, kind: 'io_error', message: 'boom' });
	});

	test('a thrown non-object is io_error', async () => {
		vi.mocked(readFile).mockRejectedValue('boom');
		const result = await default_fs_operations.readFile({ path: 'a', encoding: 'utf8' });
		assert.isFalse(result.ok);
		assert.strictEqual(!result.ok && result.kind, 'io_error');
	});

	test('writeFile and mkdir classify too', async () => {
		vi.mocked(writeFile).mockRejectedValue(to_code_error('EACCES'));
		vi.mocked(mkdir).mockRejectedValue(to_code_error('EEXIST'));
		assert.deepEqual(await default_fs_operations.writeFile({ path: 'a', content: '' }), {
			ok: false,
			kind: 'permission_denied',
			message: 'EACCES: failed'
		});
		assert.deepEqual(await default_fs_operations.mkdir({ path: 'a' }), {
			ok: false,
			kind: 'already_exists',
			message: 'EEXIST: failed'
		});
	});
});
