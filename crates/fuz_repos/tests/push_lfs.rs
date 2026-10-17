//! Git LFS pointers among what a push would send: `repos push`, `repos sync`,
//! and a push's rebase and `--new-branch` creation hold the branch
//! (`lfs_objects`), `repos status` previews it, and `repos push
//! --lfs-uploaded` lifts it. The pointers are plain committed files — no
//! Git LFS runs here — read from the objects alone.

mod support;

use std::path::Path;

use fuz_repos::report::{BranchOutcome, BranchSyncHold, PushOutcome, RebasePush};
use fuz_repos::state::{BranchHold, SyncAction, Verdict};
use support::cli::{repos, stderr, stdout};
use support::push::{held, only, pushed, pushes_served, remote_refs};
use support::rebase::{push_rebased, rebase};
use support::sync::outcome;
use support::{FixtureWorkspace, branch, find_entry, write};

/// A Git LFS pointer, as Git LFS commits one in place of a file's content.
const POINTER: &str = "version https://git-lfs.github.com/spec/v1\n\
    oid sha256:fdee63c4a4dc23076dda04b32eb8505bcd41fb791e574a264026c43e700bf923\n\
    size 308880\n";

/// Writes `path` in `repo` with `content` and commits it; returns the
/// commit.
fn commit_file(ws: &FixtureWorkspace, repo: &Path, path: &str, content: &str) -> String {
    write(repo, path, content);
    ws.git(repo, &["add", "-A"]);
    ws.git(repo, &["commit", "-q", "-m", path]);
    ws.git(repo, &["rev-parse", "HEAD"])
}

/// `app`, owned, its `main` ahead of origin by a commit adding `content`
/// at `path`; returns the clone, origin's `main`, and that commit.
fn ahead_with(
    ws: &mut FixtureWorkspace,
    path: &str,
    content: &str,
) -> (std::path::PathBuf, String, String) {
    let app = ws.owned_repo("app", &[]);
    let origin = ws.git(&app, &["rev-parse", "origin/main"]);
    let tip = commit_file(ws, &app, path, content);
    ws.assert_track(&app, "main", "[ahead 1]");
    ws.write_registry();
    (app, origin, tip)
}

#[test]
fn a_pointer_ahead_holds_the_push_until_the_upload_is_said() {
    let mut ws = FixtureWorkspace::new();
    let (app, origin, _) = ahead_with(&mut ws, "Content/Hero.uasset", POINTER);
    // deleted again since: its commit still sends it
    ws.git(&app, &["rm", "-q", "Content/Hero.uasset"]);
    ws.git(&app, &["commit", "-q", "-m", "drop"]);
    let tip = ws.git(&app, &["rev-parse", "HEAD"]);
    let remote_before = remote_refs(&ws, "app");
    let local_before = ws.refs(&app);

    // status previews it, from local refs
    let entries = ws.status();
    assert_eq!(
        branch(find_entry(&entries, "app"), "main").verdict,
        Verdict::Held {
            action: SyncAction::Push { commits: 2 },
            by: BranchHold::LfsObjects,
        }
    );

    let run = ws.push(&["app"]);
    assert_eq!(
        only(&run),
        (Some("main"), &held(BranchSyncHold::LfsObjects))
    );
    assert_eq!(remote_refs(&ws, "app"), remote_before);
    assert_eq!(ws.refs(&app), local_before);
    assert!(pushes_served(&ws).is_empty());

    // the user uploaded them: the flag lifts the hold
    let run = ws.push_lfs_uploaded(&["app"]);
    assert_eq!(only(&run), (Some("main"), &pushed(&origin, &tip)));
    assert_eq!(ws.git(&ws.bare("app"), &["rev-parse", "main"]), tip);
}

#[test]
fn a_legacy_pointer_holds_it_too() {
    let mut ws = FixtureWorkspace::new();
    ahead_with(
        &mut ws,
        "old.bin",
        "version https://hawser.github.com/spec/v1\noid sha256:00\nsize 1\n",
    );
    let run = ws.push(&["app"]);
    assert_eq!(
        only(&run),
        (Some("main"), &held(BranchSyncHold::LfsObjects))
    );
}

/// Neither a small blob that isn't a pointer nor a blob at or past the size
/// a pointer stays under holds a push; one just under it does.
#[test]
fn only_a_small_blob_reading_as_a_pointer_holds() {
    let mut big = POINTER.to_owned();
    big.push_str(&"x".repeat(1024 - big.len()));
    assert_eq!(big.len(), 1024);
    for content in [
        "hello\n".to_owned(),
        format!("not a pointer: {POINTER}"),
        big.clone(),
    ] {
        let mut ws = FixtureWorkspace::new();
        let (_, origin, tip) = ahead_with(&mut ws, "file.bin", &content);
        let run = ws.push(&["app"]);
        assert_eq!(
            only(&run),
            (Some("main"), &pushed(&origin, &tip)),
            "{content:?}"
        );
    }
    let mut ws = FixtureWorkspace::new();
    ahead_with(&mut ws, "file.bin", &big[..1023]);
    let run = ws.push(&["app"]);
    assert_eq!(
        only(&run),
        (Some("main"), &held(BranchSyncHold::LfsObjects))
    );
}

/// A pointer origin already holds was accepted there before: a push of a
/// copy of it, beside a plain change, sends neither.
#[test]
fn a_pointer_origin_holds_already_pushes() {
    let mut ws = FixtureWorkspace::new();
    ws.remote("app", &[("Content/Hero.uasset", POINTER)]);
    ws.declare_repo("app", "app", "");
    let app = ws.clone_owned("app", "app", &[]);
    let origin = ws.git(&app, &["rev-parse", "origin/main"]);
    write(&app, "Content/Copy.uasset", POINTER);
    let tip = commit_file(&ws, &app, "notes.txt", "notes\n");
    ws.write_registry();

    let run = ws.push(&["app"]);
    assert_eq!(only(&run), (Some("main"), &pushed(&origin, &tip)));
}

#[test]
fn sync_holds_the_push() {
    let mut ws = FixtureWorkspace::new();
    let (app, _, _) = ahead_with(&mut ws, "a.uasset", POINTER);
    let remote_before = remote_refs(&ws, "app");
    let local_before = ws.refs(&app);

    let run = ws.sync();
    assert_eq!(
        outcome(&run, "app", "main"),
        &BranchOutcome::Held {
            action: SyncAction::Push { commits: 1 },
            by: BranchSyncHold::LfsObjects,
        }
    );
    assert_eq!(remote_refs(&ws, "app"), remote_before);
    assert_eq!(ws.refs(&app), local_before);
    assert!(pushes_served(&ws).is_empty());
}

#[test]
fn a_rebase_is_held_with_nothing_moved_until_the_upload_is_said() {
    let mut ws = FixtureWorkspace::new();
    let app = ws.owned_repo("app", &[]);
    let local = commit_file(&ws, &app, "a.uasset", POINTER);
    let upstream = ws.upstream_commit("app", "main");
    ws.git(&app, &["fetch", "-q", "origin"]);
    ws.assert_track(&app, "main", "[ahead 1, behind 1]");
    ws.write_registry();
    let local_before = ws.refs(&app);
    let remote_before = remote_refs(&ws, "app");

    let entries = ws.status();
    assert_eq!(
        branch(find_entry(&entries, "app"), "main").verdict,
        Verdict::Held {
            action: rebase(1, 1),
            by: BranchHold::LfsObjects,
        }
    );
    let run = ws.push(&["app"]);
    assert_eq!(
        only(&run),
        (Some("main"), &held(BranchSyncHold::LfsObjects))
    );
    assert_eq!(ws.refs(&app), local_before);
    assert_eq!(remote_refs(&ws, "app"), remote_before);
    assert!(pushes_served(&ws).is_empty());

    // the flag lifts Git LFS's hold alone: dirt still holds the rebase
    write(&app, "scratch.txt", "mine\n");
    let run = ws.push_lfs_uploaded(&["app"]);
    assert_eq!(
        only(&run),
        (Some("main"), &held(BranchSyncHold::DirtyCheckout))
    );
    assert_eq!(ws.refs(&app), local_before);
    std::fs::remove_file(app.join("scratch.txt")).unwrap();

    let run = ws.push_lfs_uploaded(&["app"]);
    let (from, to, onto, push) = push_rebased(&run);
    assert_eq!((from, onto), (local.as_str(), upstream.as_str()));
    assert_eq!(push, &RebasePush::Pushed);
    assert_eq!(ws.git(&ws.bare("app"), &["rev-parse", "main"]), to);
}

#[test]
fn a_new_branch_is_held_until_the_upload_is_said() {
    let mut ws = FixtureWorkspace::new();
    let app = ws.owned_repo("app", &[]);
    ws.git(&app, &["switch", "-q", "-c", "topic"]);
    let tip = commit_file(&ws, &app, "a.uasset", POINTER);
    ws.write_registry();

    let run = ws.push_new_branch(&["app"]);
    assert_eq!(
        only(&run),
        (Some("topic"), &held(BranchSyncHold::LfsObjects))
    );
    assert!(!ws.has_ref(&ws.bare("app"), "refs/heads/topic"));
    assert!(pushes_served(&ws).is_empty());

    let run = ws.push_report_lfs(&["app"], &ws.root(), true, true);
    assert_eq!(
        only(&run),
        (Some("topic"), &PushOutcome::Created { to: tip.clone() })
    );
    assert_eq!(ws.git(&ws.bare("app"), &["rev-parse", "topic"]), tip);
}

#[test]
fn the_binary_says_how_to_lift_it() {
    let mut ws = FixtureWorkspace::new();
    let (app, _, tip) = ahead_with(&mut ws, "a.uasset", POINTER);

    let out = repos(&ws, &app, &["push"]);
    assert_eq!(out.status.code(), Some(1), "stderr: {}", stderr(&out));
    let text = stdout(&out);
    assert!(
        text.starts_with(
            "held          app +1 (Git LFS objects)\n              \
             hint: repos runs no hook, so Git LFS uploads nothing on its push: run git lfs \
             push origin main, then repos push --lfs-uploaded where it's checked out\n"
        ),
        "{text}"
    );
    let doc: serde_json::Value =
        serde_json::from_str(&stdout(&repos(&ws, &app, &["push", "--json"]))).unwrap();
    assert_eq!(doc["pushes"][0]["kind"], "held");
    assert_eq!(doc["pushes"][0]["by"], "lfs_objects");

    let out = repos(&ws, &app, &["status"]);
    assert!(
        stdout(&out).contains("hint: repos runs no hook, so Git LFS uploads nothing on its push: run git lfs push origin main, then"),
        "{}",
        stdout(&out)
    );

    let out = repos(&ws, &app, &["push", "--lfs-uploaded"]);
    assert_eq!(out.status.code(), Some(0), "stderr: {}", stderr(&out));
    assert_eq!(ws.git(&ws.bare("app"), &["rev-parse", "main"]), tip);
}
