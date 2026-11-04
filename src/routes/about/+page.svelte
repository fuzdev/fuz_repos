<script lang="ts">
	import LibrarySummary from '@fuzdev/fuz_ui/LibrarySummary.svelte';
	import EcosystemLinksPanel from '@fuzdev/fuz_ui/EcosystemLinksPanel.svelte';
	import { Library, library_context } from '@fuzdev/fuz_ui/library.svelte.ts';
	import { site_context } from '@fuzdev/fuz_ui/site.svelte.ts';
	import { library_json } from '#routes/library.ts';

	import PageFooter from '#lib/PageFooter.svelte';
	import PageHeader from '#lib/PageHeader.svelte';

	const library = new Library(library_json);
	library_context.set(() => library);
	const site = site_context.get();
</script>

<svelte:head>
	<title>about {site.glyph} fuz_repos</title>
</svelte:head>

<main class="width_atmost_md box mx_auto">
	<div class="p_lg">
		<PageHeader repo={library}></PageHeader>
	</div>
	<section class="box mb_lg">
		<div class="panel p_md width_atmost_md">
			<LibrarySummary {library} />
		</div>
	</section>
	<EcosystemLinksPanel />
	<PageFooter />
</main>
