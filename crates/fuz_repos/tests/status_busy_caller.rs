//! The caller's own session: excluded at its places and where the tool runs,
//! its subagents' worktrees, which share its pid, still held.

// helpers outside `#[test]` fns fail the test the way an assertion would
#![allow(clippy::unwrap_used)]

mod support;

use std::path::{Path, PathBuf};

use fuz_repos::report::{EntryStatus, Sessions};
use fuz_repos::sessions::{LiveSessions, Session, SessionSource};
use fuz_repos::state::{BranchHold, Verdict};
use support::busy::{ahead_branch, app, calling, held, push, session};
use support::cli::{REPOS, parse};
use support::{FixtureWorkspace, branch, find_entry, path, proc_start};

/// `app` with `main` ahead in the primary and two agent worktrees where
/// Claude Code puts a subagent's, `w1` on `feat` and `w2` on `side`, each
/// ahead 1; returns the primary and the two.
fn app_with_agent_worktrees(ws: &mut FixtureWorkspace) -> (PathBuf, PathBuf, PathBuf) {
    let app = app(ws);
    ws.commit(&app, "local");
    ahead_branch(ws, &app, "feat");
    ahead_branch(ws, &app, "side");
    let w1 = app.join(".claude/worktrees/w1");
    let w2 = app.join(".claude/worktrees/w2");
    ws.add_worktree(&app, &w1, &["feat"]);
    ws.add_worktree(&app, &w2, &["side"]);
    std::fs::create_dir(w1.join("src")).unwrap();
    ws.assert_clean(&app);
    (app, w1, w2)
}

/// The sessions busy in each of `e`'s checkouts, by path, the idle ones
/// left out.
fn busy_by_checkout(e: &EntryStatus) -> Vec<(String, Vec<Session>)> {
    e.checkouts
        .iter()
        .filter(|c| !c.busy.is_empty())
        .map(|c| (c.path.clone(), c.busy.clone()))
        .collect()
}

/// `app`'s branches, each ahead 1, held as busy or acting, by name.
fn assert_verdicts(e: &EntryStatus, busy: &[&str], acting: &[&str]) {
    for name in busy {
        assert_eq!(
            branch(e, name).verdict,
            held(push(1), BranchHold::Busy),
            "{name}"
        );
    }
    for name in acting {
        assert_eq!(
            branch(e, name).verdict,
            Verdict::Act { action: push(1) },
            "{name}"
        );
    }
}

#[test]
fn the_callers_agent_worktrees_hold_but_the_one_the_tool_runs_in() {
    let mut ws = FixtureWorkspace::new();
    let (app, w1, w2) = app_with_agent_worktrees(&mut ws);
    let s = session(9, &app, SessionSource::SessionFile);

    // run from its own cwd, or from where it can't be told: its subagents'
    // worktrees are held, its own checkout isn't
    for cwd in [None, Some(app.as_path()), Some(&app.join(".claude"))] {
        let caller = calling(s.clone(), cwd);
        let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
        assert_eq!(run.sessions, Sessions::Available { unscoped: vec![] });
        let e = find_entry(&run.entries, "app");
        assert_eq!(
            busy_by_checkout(e),
            [
                (path(&w1), vec![caller.clone()]),
                (path(&w2), vec![caller.clone()]),
            ],
            "{cwd:?}"
        );
        // its subagents' worktrees aren't where it works itself
        assert!(e.checkouts.iter().all(|c| c.working.is_empty()), "{cwd:?}");
        assert_verdicts(e, &["feat", "side"], &["main"]);
    }

    // run by the subagent in `w1`, anywhere in it or in its git dir: `w1`
    // is its own
    for cwd in [w1.clone(), w1.join("src"), app.join(".git/worktrees/w1")] {
        let caller = calling(s.clone(), Some(&cwd));
        let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
        let e = find_entry(&run.entries, "app");
        assert_eq!(busy_by_checkout(e), [(path(&w2), vec![caller])]);
        assert_verdicts(e, &["side"], &["main", "feat"]);
    }

    // another session there holds them all, wherever the tool runs
    let other = session(8, &app, SessionSource::SessionFile);
    let caller = calling(s, Some(&w1));
    let run = ws.status_live(&LiveSessions::Known(vec![other.clone(), caller.clone()]));
    let e = find_entry(&run.entries, "app");
    assert_eq!(
        busy_by_checkout(e),
        [
            (path(&app), vec![other.clone()]),
            (path(&w1), vec![other.clone()]),
            (path(&w2), vec![other, caller]),
        ]
    );
    assert_verdicts(e, &["main", "feat", "side"], &[]);
}

#[test]
fn the_caller_in_an_agent_worktree_holds_its_siblings_not_itself() {
    let mut ws = FixtureWorkspace::new();
    let (app, w1, w2) = app_with_agent_worktrees(&mut ws);
    // entered `w1` (its recorded cwd rewritten), the tool run from the
    // primary: `w1` is its own, as `app` is where the tool runs
    let caller = calling(session(9, &w1, SessionSource::SessionFile), Some(&app));
    let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
    let e = find_entry(&run.entries, "app");
    assert_eq!(busy_by_checkout(e), [(path(&w2), vec![caller])]);
    assert_verdicts(e, &["side"], &["main", "feat"]);
}

#[test]
fn a_worktree_locked_for_the_caller_is_where_it_works_but_where_the_tool_runs() {
    let mut ws = FixtureWorkspace::new();
    let (app, w1, w2) = app_with_agent_worktrees(&mut ws);
    let w1_s = path(&w1);
    ws.git(
        &app,
        &[
            "worktree",
            "lock",
            "--reason",
            "claude agent w1 (pid 9 start 0)",
            &w1_s,
        ],
    );
    let s = session(9, &app, SessionSource::SessionFile);
    let working = |cwd: &Path| {
        let caller = calling(s.clone(), Some(cwd));
        let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
        let e = find_entry(&run.entries, "app");
        assert!(
            e.checkouts
                .iter()
                .all(|c| c.path == w1_s || c.working.is_empty())
        );
        let w1 = e.checkouts.iter().find(|c| c.path == w1_s).unwrap();
        (w1.working.clone(), caller)
    };
    // its subagent works in it, under its pid
    let (at_w1, caller) = working(&app);
    assert_eq!(at_w1, [caller]);
    // unless that's where the tool runs: the subagent is the caller there
    assert_eq!(working(&w1.join("src")).0, []);
    // its sibling is held still
    let caller = calling(s, Some(&w1));
    let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
    let e = find_entry(&run.entries, "app");
    assert_eq!(busy_by_checkout(e), [(path(&w2), vec![caller])]);
}

#[test]
fn an_unscoped_caller_holds_nothing_and_is_never_unscoped() {
    let mut ws = FixtureWorkspace::new();
    let (_, _, _) = app_with_agent_worktrees(&mut ws);
    for cwd in [None, Some(ws.root())] {
        let caller = calling(
            session(9, &ws.root(), SessionSource::SessionFile),
            cwd.as_deref(),
        );
        let run = ws.status_live(&LiveSessions::Known(vec![caller]));
        assert_eq!(run.sessions, Sessions::Available { unscoped: vec![] });
        let e = find_entry(&run.entries, "app");
        assert_eq!(busy_by_checkout(e), []);
        assert_verdicts(e, &[], &["main", "feat", "side"]);
    }
}

#[test]
fn a_caller_place_that_cannot_be_resolved_marks_nothing() {
    let mut ws = FixtureWorkspace::new();
    let (app, w1, w2) = app_with_agent_worktrees(&mut ws);
    let looped = ws.outside("loop");
    std::os::unix::fs::symlink(&looped, &looped).unwrap();
    // its process somewhere no path resolves: the rest of it still counts
    let caller = calling(
        Session {
            process_cwd: Some(path(&looped.join("x"))),
            ..session(9, &app, SessionSource::SessionFile)
        },
        Some(&app),
    );
    let run = ws.status_live(&LiveSessions::Known(vec![caller.clone()]));
    assert_eq!(run.sessions, Sessions::Available { unscoped: vec![] });
    let e = find_entry(&run.entries, "app");
    assert_eq!(
        busy_by_checkout(e),
        [(path(&w1), vec![caller.clone()]), (path(&w2), vec![caller]),]
    );
}

/// `repos status --json`'s busy sessions' pids in `app`'s checkout at
/// `checkout`, run from `cwd` as the session `caller` names.
fn busy_pids(ws: &FixtureWorkspace, cwd: &Path, caller: u32, checkout: &Path) -> Vec<u64> {
    let out = ws
        .command(REPOS, cwd)
        .env("CLAUDE_CONFIG_DIR", ws.outside("claude"))
        .env("CLAUDE_PID", caller.to_string())
        .args(["status", "--json"])
        .output()
        .unwrap();
    let json = parse(&out);
    let checkouts = json["entries"][0]["checkouts"].as_array().unwrap();
    let c = checkouts
        .iter()
        .find(|c| c["path"] == path(checkout))
        .unwrap();
    c["busy"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["pid"].as_u64().unwrap())
        .collect()
}

#[test]
fn repos_holds_the_callers_agent_worktrees_but_the_one_it_runs_in() {
    let mut ws = FixtureWorkspace::new();
    let (app, w1, w2) = app_with_agent_worktrees(&mut ws);
    ws.write_registry();
    // the caller: this test process, which spawns the binary
    let me = std::process::id();
    let claude = support::ClaudeDir::new(ws.outside("claude"));
    claude.session(me, &proc_start(me), &app);
    let mine = u64::from(me);
    for cwd in [app.clone(), ws.root()] {
        assert!(busy_pids(&ws, &cwd, me, &app).is_empty());
        assert_eq!(busy_pids(&ws, &cwd, me, &w1), [mine]);
        assert_eq!(busy_pids(&ws, &cwd, me, &w2), [mine]);
    }
    for cwd in [w1.clone(), w1.join("src")] {
        assert!(busy_pids(&ws, &cwd, me, &app).is_empty());
        assert!(busy_pids(&ws, &cwd, me, &w1).is_empty());
        assert_eq!(busy_pids(&ws, &cwd, me, &w2), [mine]);
    }
}
