import type { RepoFixtureSet } from './repo_fixture_types.ts';
import { create_fixture_changeset_ops } from './mock_changeset_operations.ts';
import { create_mock_fs_ops, create_mock_gitops_ops, type MockGitopsOps } from '../test_helpers.ts';

/**
 * Creates operations for a fixture: its changesets read from the fixture
 * data, an empty fs, and every other operation succeeding
 * (`create_mock_gitops_ops`). The fixture checks read no file; a rewrite reads
 * the dependent's `package.json`, which the empty fs fails as not found rather
 * than reading the default mock's `{}`.
 */
export const create_fixture_gitops_ops = (fixture: RepoFixtureSet): MockGitopsOps =>
	create_mock_gitops_ops({
		changeset: create_fixture_changeset_ops(fixture),
		fs: create_mock_fs_ops()
	});
