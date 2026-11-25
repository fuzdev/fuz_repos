//! `repos sync`'s fetch follows tags: it creates the ones origin has on
//! commits the repo holds, never moves or deletes one, and `status --fetch`
//! and `repos push` bring none.

mod support;

use std::path::PathBuf;

use fuz_repos::report::FetchOutcome;
use support::FixtureWorkspace;
use support::sync::outcomes;

/// `app`, owned and cloned, then tagged upstream after the clone: `v1`
/// (lightweight) and `v2` (annotated) on `main`'s tip, and `stray` on a
/// commit on no branch, which no fetch brings. Returns the clone.
fn tagged_after_clone(ws: &mut FixtureWorkspace) -> PathBuf {
    let app = ws.owned_repo("app", &[]);
    ws.write_registry();
    let up = ws.upstream("app");
    ws.upstream_commit("app", "main");
    ws.git(&up, &["tag", "v1"]);
    ws.git(&up, &["tag", "-a", "v2", "-m", "v2"]);
    ws.git(&up, &["checkout", "-q", "--detach"]);
    ws.commit(&up, "stray");
    ws.git(&up, &["tag", "stray"]);
    ws.git(&up, &["checkout", "-q", "main"]);
    ws.git(&up, &["push", "-q", "origin", "v1", "v2", "stray"]);
    app
}

fn local_tags(ws: &FixtureWorkspace, repo: &std::path::Path) -> Vec<String> {
    ws.git(repo, &["tag", "--list"])
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn sync_creates_the_tags_origin_has_on_commits_it_fetched() {
    let mut ws = FixtureWorkspace::new();
    let app = tagged_after_clone(&mut ws);
    let bare = ws.bare("app");

    let run = ws.sync();

    let e = outcomes(&run, "app");
    assert_eq!(e.fetch, FetchOutcome::Fetched);
    assert_eq!(e.tags, ["v1", "v2"]);
    assert_eq!(local_tags(&ws, &app), ["v1", "v2"]);
    // each the object origin has: the annotated tag stays a tag object
    for tag in ["v1", "v2"] {
        let r = format!("refs/tags/{tag}");
        assert_eq!(
            ws.git(&app, &["rev-parse", &r]),
            ws.git(&bare, &["rev-parse", &r])
        );
    }
    assert_eq!(ws.git(&app, &["cat-file", "-t", "v2"]), "tag");

    // again: nothing new to create
    let again = ws.sync();
    assert!(outcomes(&again, "app").tags.is_empty());
}

#[test]
fn a_local_tag_is_never_moved_or_deleted() {
    let mut ws = FixtureWorkspace::new();
    let app = tagged_after_clone(&mut ws);
    ws.sync();
    // then: `v1` here names another commit than origin's, `mine` is on no
    // remote, and `v2` is deleted upstream, under a config that prunes tags
    let root = ws.git(&app, &["rev-list", "--max-parents=0", "HEAD"]);
    ws.git(&app, &["tag", "-f", "v1", &root]);
    ws.git(&app, &["tag", "mine"]);
    ws.git(&app, &["config", "fetch.pruneTags", "true"]);
    ws.git(
        &ws.upstream("app"),
        &["push", "-q", "origin", "--delete", "v2"],
    );

    let run = ws.sync();

    // `v1` differs and stays, unreported
    assert_eq!(outcomes(&run, "app").fetch, FetchOutcome::Fetched);
    assert!(outcomes(&run, "app").tags.is_empty());
    assert_eq!(local_tags(&ws, &app), ["mine", "v1", "v2"]);
    assert_eq!(ws.git(&app, &["rev-parse", "v1"]), root);
}

#[test]
fn status_fetch_and_push_bring_no_tags() {
    let mut ws = FixtureWorkspace::new();
    let app = tagged_after_clone(&mut ws);

    ws.status_with_fetch();
    assert!(local_tags(&ws, &app).is_empty());
    ws.push(&["app"]);
    assert!(local_tags(&ws, &app).is_empty());
}

#[test]
fn a_tag_opt_in_the_config_keeps_tags_off() {
    for opt in ["--no-tags", "--tags"] {
        let mut ws = FixtureWorkspace::new();
        let app = tagged_after_clone(&mut ws);
        ws.git(&app, &["config", "remote.origin.tagOpt", opt]);

        let run = ws.sync();

        let e = outcomes(&run, "app");
        assert_eq!(e.fetch, FetchOutcome::Fetched, "{opt}");
        assert!(e.tags.is_empty(), "{opt}");
        assert!(local_tags(&ws, &app).is_empty(), "{opt}");
    }
}
