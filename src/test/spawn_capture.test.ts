import { assert, describe, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { spawn } from '@fuzdev/gro/spawn.ts';

import { spawn_capture } from '#lib/spawn_capture.ts';

describe('spawn_capture', () => {
	test('captures both streams and the exit code', async () => {
		const sh = spawn.program('sh');
		const output = await spawn_capture(sh, ['-c', 'printf out; printf err >&2; exit 3']);
		assert.strictEqual(output.kind, 'exited');
		assert.ok(output.kind === 'exited');
		assert.strictEqual(output.code, 3);
		assert.strictEqual(output.stdout, 'out');
		assert.strictEqual(output.stderr, 'err');
	});
});

describe('spawn_capture sessions and decoding', () => {
	const to_session = (stat: string): string => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[3]!;

	test('keeps the child in the host session, where /dev/tty still reaches it', async () => {
		const own = await readFile(`/proc/${process.pid}/stat`, 'utf8');
		const output = await spawn_capture(spawn.program('sh'), ['-c', 'cat /proc/$$/stat']);
		assert.ok(output.kind === 'exited' && output.code === 0);
		assert.strictEqual(to_session(output.stdout), to_session(own));
	});

	test('decodes a character split across chunks', async () => {
		const output = await spawn_capture(spawn.program('sh'), [
			'-c',
			"printf '\\342'; sleep 0.2; printf '\\202\\254'"
		]);
		assert.strictEqual(output.stdout, '€');
	});
});
