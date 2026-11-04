<script lang="ts">
	import LibrarySummary from '@fuzdev/fuz_ui/LibrarySummary.svelte';
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';

	import type { Repo } from './repo.svelte.ts';
	import ReposTreeNav from './ReposTreeNav.svelte';

	const {
		repos,
		selected_repo,
		nav
	}: {
		repos: Array<Repo>;
		selected_repo?: Repo | undefined;
		nav: Snippet;
	} = $props();
</script>

<div class="repos-tree">
	<ReposTreeNav {repos} {selected_repo}>
		{@render nav()}
	</ReposTreeNav>
	{#if selected_repo}
		<section class="detail-wrapper">
			<div class="panel detail p_md">
				<LibrarySummary library={selected_repo.library} />
			</div>
		</section>
	{:else}
		<menu class="summaries">
			{#each repos as repo (repo.name)}
				<li class="panel p_md box">
					<LibrarySummary library={repo.library}>
						{#snippet repo_name(repo_name)}
							<a href={resolve('/tree/[slug]', { slug: repo_name })} class="repo-name">
								{repo_name}
							</a>
						{/snippet}
					</LibrarySummary>
				</li>
			{/each}
		</menu>
	{/if}
</div>

<style>
	.repos-tree {
		width: 100%;
		display: flex;
		flex-direction: row;
		align-items: flex-start;
	}
	.summaries {
		padding: var(--space_lg);
		gap: var(--space_lg);
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		justify-content: flex-start;
		align-items: flex-start;
	}
	.summaries li {
		margin-bottom: var(--space_xl);
	}
	.repo-name {
		font-size: var(--font_size_xl2);
		font-weight: 500;
		text-align: center;
		margin-bottom: var(--space_xl);
	}
	.detail-wrapper {
		padding: var(--space_lg);
		width: 100%;
	}
	.detail {
		display: flex;
	}
</style>
