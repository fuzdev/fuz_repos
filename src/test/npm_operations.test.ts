import { test, assert, describe } from 'vitest';

import { create_mock_npm_ops } from './test_helpers.ts';

describe('wait_for_package operation', () => {
	test('completes successfully when package becomes available', async () => {
		const mock_ops = create_mock_npm_ops();
		const result = await mock_ops.wait_for_package({ pkg: 'foo', version: '1.0.0' });
		assert.ok(result.ok);
	});

	test('accepts optional wait options', async () => {
		const mock_ops = create_mock_npm_ops();
		const result = await mock_ops.wait_for_package({
			pkg: 'foo',
			version: '1.0.0',
			wait_options: { max_attempts: 5 }
		});
		assert.ok(result.ok);
	});

	test('accepts optional logger', async () => {
		const mock_ops = create_mock_npm_ops();
		const result = await mock_ops.wait_for_package({
			pkg: 'foo',
			version: '1.0.0',
			log: undefined
		});
		assert.ok(result.ok);
	});

	test('can override behavior in mock', async () => {
		let wait_called = false;
		let pkg_name: string | undefined;
		let pkg_version: string | undefined;

		const mock_ops = create_mock_npm_ops({
			wait_for_package: async (options) => {
				wait_called = true;
				pkg_name = options.pkg;
				pkg_version = options.version;
				return { ok: true };
			}
		});

		await mock_ops.wait_for_package({ pkg: '@my/package', version: '3.2.1' });

		assert.ok(wait_called);
		assert.equal(pkg_name, '@my/package');
		assert.equal(pkg_version, '3.2.1');
	});
});
