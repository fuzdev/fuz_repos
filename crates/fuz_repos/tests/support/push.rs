//! Helpers shared by the `push_*` tests: expected outcomes, the remote-side
//! refs, and the fixture repos.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::{FixtureWorkspace, write_executable};
use fuz_repos::push::PushRun;
use fuz_repos::report::{BranchSyncHold, PushOutcome};

/// The one target's outcome, and the branch it names.
pub fn only(run: &PushRun) -> (Option<&str>, &PushOutcome) {
    assert_eq!(run.pushes.len(), 1, "{:?}", run.pushes);
    let p = &run.pushes[0];
    (p.branch.as_deref(), &p.outcome)
}

pub fn pushed(from: &str, to: &str) -> PushOutcome {
    PushOutcome::Pushed {
        from: from.to_owned(),
        to: to.to_owned(),
    }
}

/// A target's push or rebase, held by `by`: nothing moved.
pub const fn held(by: BranchSyncHold) -> PushOutcome {
    PushOutcome::Held { by }
}

/// The remote's refs: every ref of `name`'s bare remote, tags included, and
/// its `HEAD`.
pub fn remote_refs(ws: &FixtureWorkspace, name: &str) -> BTreeMap<String, String> {
    ws.refs(&ws.bare(name))
}

/// `before` with `changes` applied.
pub fn with(
    before: &BTreeMap<String, String>,
    changes: &[(&str, &str)],
) -> BTreeMap<String, String> {
    let mut refs = before.clone();
    for (r, oid) in changes {
        refs.insert((*r).to_owned(), (*oid).to_owned());
    }
    refs
}

/// The calls `ssh_push_log` holds — every push, or try at one — each as the
/// command it asked the host for (the whole line when it named no host).
pub fn pushes_served(ws: &FixtureWorkspace) -> Vec<String> {
    ws.ssh_push_log()
        .into_iter()
        .map(|l| match l.rsplit_once(" git@github.com ") {
            Some((_, command)) => command.to_owned(),
            None => l,
        })
        .collect()
}

/// A `pre-receive` hook on `name`'s bare remote that moves the pushed ref
/// to `to` — a shell word, `"$new"` the pushed commit — from the commit the
/// remote advertised: after the lease passed, so the remote's own update
/// then fails its compare-and-swap (`cannot lock ref`).
pub fn move_ref_before_update(ws: &FixtureWorkspace, name: &str, to: &str) {
    update_ref_before_update(ws, name, &format!("\"$ref\" {to} \"$old\""));
}

/// A `pre-receive` hook on `name`'s bare remote that deletes the pushed ref
/// after the lease passed, so the remote's own update finds it gone.
pub fn delete_ref_before_update(ws: &FixtureWorkspace, name: &str) {
    update_ref_before_update(ws, name, "-d \"$ref\" \"$old\"");
}

/// A `pre-receive` hook running `git update-ref <args>` on the pushed ref.
/// Git forbids a ref update from inside the quarantine the hook runs in,
/// which unsetting its path lifts; the pushed objects stay readable.
fn update_ref_before_update(ws: &FixtureWorkspace, name: &str, args: &str) {
    write_executable(
        &ws.bare(name),
        "hooks/pre-receive",
        &format!(
            "#!/bin/sh\nread old new ref\nunset GIT_QUARANTINE_PATH\n\
             git update-ref {args}\n"
        ),
    );
}

/// Whether the git on `PATH` may refuse the update a `pre-receive` hook
/// raced (`move_ref_before_update`) in words naming no commit: 2.50 batches
/// receive-pack's ref updates, whose refusal reads (unverified here)
/// `incorrect old value provided`, so a ref moved to the very commit pushed
/// holds (`changed`) for a rerun where older git's `cannot lock ref` words
/// read it in sync at once. Older git always reads it in sync.
pub fn refusal_may_name_no_commit() -> bool {
    let out = Command::new("git").arg("--version").output().unwrap();
    let out = String::from_utf8(out.stdout).unwrap();
    let version = out.trim().strip_prefix("git version ").unwrap();
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap());
    (parts.next().unwrap(), parts.next().unwrap()) >= (2, 50)
}

/// `app`, owned, its `main` ahead of origin by one commit; returns the
/// clone and that commit.
pub fn ahead(ws: &mut FixtureWorkspace) -> (PathBuf, String) {
    let app = ws.owned_repo("app", &[]);
    let tip = ws.commit(&app, "local");
    ws.assert_track(&app, "main", "[ahead 1]");
    ws.write_registry();
    (app, tip)
}

/// `app` with `feat` on its remote, cloned, `feat` checked out tracking
/// origin's and a commit ahead of it; returns the clone and that commit.
pub fn feat_ahead(ws: &mut FixtureWorkspace) -> (PathBuf, String) {
    ws.remote("app", &[]);
    ws.upstream_commit("app", "feat");
    ws.declare_repo("app", "app", "");
    let app = ws.clone_owned("app", "app", &[]);
    ws.git(&app, &["switch", "-q", "feat"]);
    ws.assert_upstream(&app, "feat", "refs/remotes/origin/feat");
    let tip = ws.commit(&app, "local");
    ws.assert_track(&app, "feat", "[ahead 1]");
    ws.write_registry();
    (app, tip)
}

// --- --new-branch ---

/// `app` with a local `topic` checked out, no upstream, a commit on it;
/// returns the clone and that commit.
pub fn topic(ws: &mut FixtureWorkspace) -> (PathBuf, String) {
    let app = ws.owned_repo("app", &[]);
    ws.git(&app, &["switch", "-q", "-c", "topic"]);
    let tip = ws.commit(&app, "topic");
    ws.assert_upstream(&app, "topic", "");
    ws.write_registry();
    (app, tip)
}

/// Asserts `topic`'s upstream is origin's `topic` as `git push -u` sets it,
/// tracking the commit `tip`, in sync.
pub fn assert_tracks_origin(ws: &FixtureWorkspace, app: &Path, branch: &str, tip: &str) {
    let key = |k: &str| format!("branch.{branch}.{k}");
    assert_eq!(
        ws.git(app, &["config", "--get-all", &key("remote")]),
        "origin"
    );
    assert_eq!(
        ws.git(app, &["config", "--get-all", &key("merge")]),
        format!("refs/heads/{branch}")
    );
    ws.assert_upstream(app, branch, &format!("refs/remotes/origin/{branch}"));
    assert_eq!(
        ws.git(
            app,
            &["rev-parse", &format!("refs/remotes/origin/{branch}")]
        ),
        tip
    );
    ws.assert_track(app, branch, "");
}
