import { assert, describe, test } from 'vitest';
import type { SpawnOutput, SpawnProgram } from '@fuzdev/gro/spawn.ts';

import { create_npm_operations } from '#lib/operations_defaults.ts';

const fail_on_call = (): never => {
	throw Error('unexpected spawn');
};

/**
 * An `npm` that answers every `out` with `output` and records its args.
 */
const create_fake_npm = (output: {
	code: number;
	stdout?: string;
	stderr?: string;
}): { npm: SpawnProgram; calls: Array<ReadonlyArray<string>> } => {
	const calls: Array<ReadonlyArray<string>> = [];
	const npm: SpawnProgram = {
		name: 'npm',
		path: '/fake/npm',
		run: fail_on_call,
		start: fail_on_call,
		out_bytes: fail_on_call,
		out: async (args): Promise<SpawnOutput> => {
			calls.push(args);
			return { kind: 'exited', stdout: '', stderr: '', truncated: false, ...output };
		}
	};
	return { npm, calls };
};

describe('create_npm_operations view_version', () => {
	test('is true when `npm view` prints the version', async () => {
		const { npm, calls } = create_fake_npm({ code: 0, stdout: '0.55.0\n' });
		const result = await create_npm_operations(() => npm).view_version({
			pkg: '@fuzdev/fuz_code',
			version: '0.55.0'
		});
		assert.deepEqual(result, { ok: true, value: 'listed' });
		assert.deepEqual(calls, [['view', '@fuzdev/fuz_code@0.55.0', 'version']]);
	});

	test('is false when the package exists without the version, which prints nothing', async () => {
		const { npm } = create_fake_npm({ code: 0 });
		const result = await create_npm_operations(() => npm).view_version({
			pkg: 'a',
			version: '9.9.9'
		});
		assert.deepEqual(result, { ok: true, value: 'unlisted' });
	});

	test('is false for a package the registry has never seen (E404)', async () => {
		const { npm } = create_fake_npm({
			code: 1,
			stderr: 'npm error code E404\nnpm error 404 Not Found'
		});
		const result = await create_npm_operations(() => npm).view_version({
			pkg: 'a',
			version: '0.1.0'
		});
		assert.deepEqual(result, { ok: true, value: 'unknown' });
	});

	test('fails when npm can not answer, so an outage never reads as unpublished', async () => {
		const { npm } = create_fake_npm({
			code: 1,
			stderr: 'npm error code ENOTFOUND\nnpm error network request failed'
		});
		const result = await create_npm_operations(() => npm).view_version({
			pkg: 'a',
			version: '0.1.0'
		});
		assert.ok(!result.ok);
		assert.include(result.message, 'code 1');
		assert.include(result.message, 'ENOTFOUND');
	});
});
