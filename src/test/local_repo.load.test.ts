import { assert, describe, test } from 'vitest';
import { assert_rejects } from '@fuzdev/fuz_util/testing.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	local_repo_load,
	local_repos_load,
	repo_is_npm,
	type LocalRepoPath
} from '#lib/local_repo.ts';
import { create_mock_repos_entry } from './test_helpers.ts';

/** Builds a `LocalRepoPath` pointing at a real temp dir. */
const temp_local_repo_path = (repo_dir: string, name = 'rust-repo'): LocalRepoPath => ({
	repo_name: name,
	repo_dir,
	repo_url: `https://github.com/test/${name}`,
	entry: create_mock_repos_entry({ key: name })
});

// -- non-npm (cargo) repos --
describe('local_repo_load', () => {
	test('loads a workspace Cargo.toml (no package.json) as a cargo repo, falling back to the key and URL', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gitops-cargo-'));
		try {
			// A workspace root has no `name` and (here) no `repository` — both fall back to the entry's.
			writeFileSync(join(dir, 'Cargo.toml'), '[workspace.package]\nversion = "0.4.2"\n');

			const repo = await local_repo_load({
				local_repo_path: temp_local_repo_path(dir),
				modules: false
			});

			assert.strictEqual(repo.kind, 'cargo');
			assert.strictEqual(repo_is_npm(repo), false);
			assert.strictEqual(repo.library.name, 'rust-repo'); // the registry key, not Cargo.toml
			assert.strictEqual(repo.library.repo_url, 'https://github.com/test/rust-repo');
			assert.strictEqual(repo.package_json.version, '0.4.2');
			assert.strictEqual(repo.package_json.private, true);
			// No npm dependency maps on a cargo repo.
			assert.strictEqual(repo.dependencies, undefined);
			assert.strictEqual(repo.dev_dependencies, undefined);
			assert.strictEqual(repo.peer_dependencies, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('uses Cargo.toml [package] identity for a single-crate repo', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gitops-cargo-'));
		try {
			writeFileSync(
				join(dir, 'Cargo.toml'),
				'[package]\nname = "my_crate"\nversion = "1.2.3"\ndescription = "does a thing"\nrepository = "https://github.com/owner/my_crate"\n'
			);

			const repo = await local_repo_load({
				local_repo_path: temp_local_repo_path(dir),
				modules: false
			});

			assert.strictEqual(repo.kind, 'cargo');
			assert.strictEqual(repo.library.name, 'my_crate');
			assert.strictEqual(repo.package_json.version, '1.2.3');
			assert.strictEqual(repo.package_json.description, 'does a thing');
			assert.strictEqual(repo.library.repo_url, 'https://github.com/owner/my_crate');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a repo with neither package.json nor Cargo.toml still fails as a metadata-load error', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gitops-empty-'));
		try {
			for (const modules of [true, false]) {
				await assert_rejects(
					() => local_repo_load({ local_repo_path: temp_local_repo_path(dir), modules }),
					/Failed to load library metadata/
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// -- npm repos without the module analysis --
describe('local_repo_load without modules', () => {
	/**
	 * Writes an npm repo the analysis couldn't fully read: a module, a tsconfig
	 * extending `$app/tsconfig`, and no `node_modules`.
	 */
	const write_npm_repo = (dir: string, package_json: Record<string, unknown>): void => {
		writeFileSync(join(dir, 'package.json'), JSON.stringify(package_json));
		writeFileSync(join(dir, 'tsconfig.json'), '{"extends": "$app/tsconfig"}');
		mkdirSync(join(dir, 'src/lib'), { recursive: true });
		writeFileSync(join(dir, 'src/lib/a.ts'), 'export const a = 1;\n');
	};

	test('reads the package.json alone, with no modules', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gitops-npm-'));
		try {
			write_npm_repo(dir, {
				name: '@test/npm_repo',
				version: '0.3.1',
				repository: 'https://github.com/test/npm_repo',
				dependencies: { '@test/dep': '^1.0.0' },
				devDependencies: { '@test/dev': '>=0.2.0' },
				peerDependencies: { '@test/peer': '>=0.1.0' }
			});
			const repo = await local_repo_load({
				local_repo_path: temp_local_repo_path(dir, 'npm_repo'),
				modules: false
			});
			assert.strictEqual(repo.kind, 'npm');
			assert.strictEqual(repo.library.name, '@test/npm_repo');
			assert.strictEqual(repo.package_json.version, '0.3.1');
			assert.deepEqual(repo.library.source_json.modules, []);
			assert.deepEqual([...repo.dependencies!], [['@test/dep', '^1.0.0']]);
			assert.deepEqual([...repo.dev_dependencies!], [['@test/dev', '>=0.2.0']]);
			assert.deepEqual([...repo.peer_dependencies!], [['@test/peer', '>=0.1.0']]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fails a package.json without a version as a metadata-load error', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'gitops-npm-'));
		try {
			write_npm_repo(dir, { name: '@test/npm_repo', repository: 'https://github.com/test/x' });
			await assert_rejects(
				() =>
					local_repo_load({
						local_repo_path: temp_local_repo_path(dir, 'npm_repo'),
						modules: false
					}),
				/Failed to load library metadata for repo "npm_repo".*missing `version`/
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('local_repos_load', () => {
	test('aggregates the failures, naming each repo', async () => {
		const root = mkdtempSync(join(tmpdir(), 'gitops-load-'));
		try {
			// `ok` loads as a cargo repo; neither `bad-a` nor `bad-b` has a manifest
			for (const name of ['ok', 'bad-a', 'bad-b']) mkdirSync(join(root, name));
			writeFileSync(join(root, 'ok', 'Cargo.toml'), '[package]\nname = "ok"\n');
			const err = await assert_rejects(
				() =>
					local_repos_load({
						local_repo_paths: ['ok', 'bad-a', 'bad-b'].map((name) =>
							temp_local_repo_path(join(root, name), name)
						),
						modules: false
					}),
				/Failed to load 2 repos/
			);
			assert.include(err.message, 'bad-a: ');
			assert.include(err.message, 'bad-b: ');
			assert.notInclude(err.message, 'ok: ');
			assert.include(err.message, 'Failed to load library metadata');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('sequential mode throws on the first failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'gitops-load-'));
		try {
			for (const name of ['bad-a', 'bad-b']) mkdirSync(join(root, name));
			const err = await assert_rejects(
				() =>
					local_repos_load({
						local_repo_paths: ['bad-a', 'bad-b'].map((name) =>
							temp_local_repo_path(join(root, name), name)
						),
						modules: false,
						parallel: false
					}),
				/Failed to load library metadata for repo "bad-a"/
			);
			assert.notInclude(err.message, 'bad-b');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
