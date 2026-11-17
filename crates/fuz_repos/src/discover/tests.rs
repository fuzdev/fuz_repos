use std::os::unix::fs::PermissionsExt as _;

use fuz_git::MIN_GIT_VERSION;

use super::*;

#[test]
fn version_failures_map_to_the_run_errors() {
    assert!(matches!(
        version_error(VersionError::NotFound),
        Error::GitNotFound
    ));
    let too_old = version_error(VersionError::TooOld {
        found: "2.30.0".into(),
        required: MIN_GIT_VERSION,
    });
    assert!(matches!(
        &too_old,
        Error::GitTooOld { found, required } if found == "2.30.0" && *required == MIN_GIT_VERSION
    ));
    let run = version_error(VersionError::Run(GitError::NotFound));
    assert!(matches!(
        &run,
        Error::Io { context, .. } if context == "failed to run git --version"
    ));
    // the cause stays in the chain for the printed report
    assert!(std::error::Error::source(&run).is_some());
}

#[test]
fn walks_up_to_the_first_registry() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("ws");
    let nested = root.join("repo/src/lib");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(root.join(REGISTRY_FILE), "owners = []\n").unwrap();

    let git = Git::new();
    let found = find_registry(&nested, None, None, &git).unwrap();
    assert_eq!(found.root, root);
    assert_eq!(found.path, root.join(REGISTRY_FILE));
    // the fallback through git runs only when the walk finds nothing
    assert_eq!(git.spawns(), 0);
}

#[test]
fn a_symlinked_registry_roots_at_the_link() {
    let tmp = tempfile::tempdir().unwrap();
    let meta = tmp.path().join("meta");
    let ws = tmp.path().join("ws");
    std::fs::create_dir_all(&meta).unwrap();
    std::fs::create_dir_all(ws.join("repo")).unwrap();
    std::fs::write(meta.join(REGISTRY_FILE), "owners = []\n").unwrap();
    std::os::unix::fs::symlink(meta.join(REGISTRY_FILE), ws.join(REGISTRY_FILE)).unwrap();

    let found = find_registry(&ws.join("repo"), None, None, &Git::new()).unwrap();
    assert_eq!(found.root, ws);
}

/// Writes `dir/repos.toml` — the registry for real, or a symlink to
/// `target` — creating `dir`.
fn place(dir: &Path, target: Option<&Path>) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join(REGISTRY_FILE);
    match target {
        Some(target) => std::os::unix::fs::symlink(target, &path).unwrap(),
        None => std::fs::write(&path, "owners = []\n").unwrap(),
    }
    path
}

/// Makes `dir` look like a main checkout to discovery: a `.git` dir.
fn checkout(dir: &Path) {
    std::fs::create_dir_all(dir.join(".git")).unwrap();
}

#[test]
fn a_registry_in_a_checkout_roots_at_the_nearest_link_above_it() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    // kept in `meta` under `reg/`, linked inside `meta` too; the root's
    // link names that one, and a stray link further out names the root's
    let real = place(&meta.join("reg"), None);
    let inside = place(&meta, Some(Path::new("reg/repos.toml")));
    let link = place(&ws, Some(&inside));
    place(top, Some(&link));
    checkout(&meta);
    for path in [&inside, &link, &top.join(REGISTRY_FILE)] {
        assert_eq!(path.canonicalize().unwrap(), real);
    }
    let deep = meta.join("reg/src/lib");
    std::fs::create_dir_all(&deep).unwrap();

    let git = Git::new();
    for start in [&deep, &meta.join("reg"), &meta, &ws] {
        let found = find_registry(start, None, None, &git).unwrap();
        assert_eq!(found.root, ws, "from {}", start.display());
        assert_eq!(found.path, link);
        assert!(found.discovered);
    }
    // outside any checkout, the first found is the root
    let found = find_registry(top, None, None, &git).unwrap();
    assert_eq!(found.root, top);
    // a `.git` dir: no spawn
    assert_eq!(git.spawns(), 0);

    // not a checkout: `meta`'s own links are where it's found
    std::fs::remove_dir(meta.join(".git")).unwrap();
    let found = find_registry(&deep, None, None, &git).unwrap();
    assert_eq!(found.root, meta.join("reg"));
    let found = find_registry(&meta, None, None, &git).unwrap();
    assert_eq!(found.root, meta);

    // a hard link is the same file too
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let real = place(&ws.join("meta"), None);
    checkout(&ws.join("meta"));
    std::fs::hard_link(&real, ws.join(REGISTRY_FILE)).unwrap();
    let found = find_registry(&ws.join("meta"), None, None, &git).unwrap();
    assert_eq!(found.root, ws);
}

#[test]
fn a_different_registry_further_out_never_captures() {
    let tmp = tempfile::tempdir().unwrap();
    // an outer workspace with a registry of its own, and an inner one
    // whose registry the outer's copies
    let top = tmp.path();
    let outer = top.join("outer");
    let inner = outer.join("inner");
    let real = place(&inner, None);
    std::fs::copy(&real, outer.join(REGISTRY_FILE)).unwrap();
    assert_ne!(file_id(&real), file_id(&outer.join(REGISTRY_FILE)));

    let git = Git::new();
    let found = find_registry(&inner, None, None, &git).unwrap();
    assert_eq!(found.root, inner);
    assert_eq!(found.path, real);
    checkout(&inner);
    let found = find_registry(&inner, None, None, &git).unwrap();
    assert_eq!(found.root, inner);

    // nor does it stop the search: a link to the inner one further out
    // still roots there
    place(top, Some(&real));
    let found = find_registry(&inner, None, None, &git).unwrap();
    assert_eq!(found.root, top);
    assert_eq!(found.path, top.join(REGISTRY_FILE));
    // and from the outer workspace, its own registry is the one
    let found = find_registry(&outer, None, None, &git).unwrap();
    assert_eq!(found.root, outer);
}

#[test]
fn an_ancestor_registry_that_cannot_be_read_is_passed_over() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    place(top, Some(&real));
    // between them: a dangling link, a loop, and a link into a dir that
    // can't be searched
    let dangling = place(&ws, Some(&top.join("nowhere")));
    let looped = ws.join("loop");
    place(&looped, Some(&looped.join(REGISTRY_FILE)));
    let sealed = top.join("sealed");
    place(&sealed, Some(&real));
    let blocked = ws.join("blocked");
    place(&blocked, Some(&sealed.join(REGISTRY_FILE)));
    let unreadable = [
        dangling,
        looped.join(REGISTRY_FILE),
        blocked.join(REGISTRY_FILE),
    ];

    let starts = [
        meta.clone(),
        place(&looped.join("meta"), Some(&real)),
        place(&blocked.join("meta"), Some(&real)),
    ]
    .map(|path| path.parent().unwrap().to_owned());
    for start in &starts {
        checkout(start);
    }

    let git = Git::new();
    std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable: Vec<bool> = unreadable
        .iter()
        .map(|path| std::fs::metadata(path).is_ok())
        .collect();
    let found = starts
        .clone()
        .map(|start| find_registry(&start, None, None, &git).unwrap());
    std::fs::set_permissions(&sealed, std::fs::Permissions::from_mode(0o755)).unwrap();
    // the superuser searches any dir: the sealed one reads then, the same
    // file
    assert!(matches!(readable[..], [false, false, _]), "{readable:?}");
    for (start, found) in starts.iter().zip(found) {
        assert_eq!(found.root, top, "from {}", start.display());
        assert_eq!(found.path, top.join(REGISTRY_FILE));
    }

    // with nothing further out, the registry stays where it's found
    std::fs::remove_file(top.join(REGISTRY_FILE)).unwrap();
    let found = find_registry(&meta, None, None, &git).unwrap();
    assert_eq!(found.root, meta);
}

#[test]
fn the_walk_is_over_the_physical_path() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    checkout(&meta);
    std::fs::create_dir(ws.join("app")).unwrap();
    // `decoy/..` is `ws` to the kernel, `elsewhere` read lexically, where
    // a stray link names the registry
    let elsewhere = top.join("elsewhere");
    place(&elsewhere, Some(&real));
    std::os::unix::fs::symlink(ws.join("app"), elsewhere.join("decoy")).unwrap();
    let dotted = elsewhere.join("decoy/../meta");
    assert_eq!(dotted.canonicalize().unwrap(), meta);

    let git = Git::new();
    let found = find_registry(&dotted, None, None, &git).unwrap();
    assert_eq!(found.root, meta);
    place(&ws, Some(&real));
    let found = find_registry(&dotted, None, None, &git).unwrap();
    assert_eq!(found.root, ws);
    assert_eq!(found.path, ws.join(REGISTRY_FILE));
    // a start that doesn't exist finds nothing
    let e = find_registry(&elsewhere.join("decoy/../nope"), None, None, &git).unwrap_err();
    assert!(matches!(e, Error::RegistryNotFound { .. }), "{e}");
}

#[test]
fn git_is_asked_only_where_a_linked_worktree_may_hold_the_registry() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    place(&repo, None);
    let deep = repo.join("src");
    std::fs::create_dir(&deep).unwrap();

    // no `.git` above, or a dir as a main checkout's is: no spawn
    let git = Git::new();
    assert_eq!(find_registry(&deep, None, None, &git).unwrap().root, repo);
    checkout(&repo);
    assert_eq!(find_registry(&deep, None, None, &git).unwrap().root, repo);
    assert_eq!(git.spawns(), 0);

    // a `.git` file, as a linked worktree's is: git decides, and a
    // failure keeps the registry where it's found
    std::fs::remove_dir(repo.join(".git")).unwrap();
    std::fs::write(repo.join(".git"), "gitdir: nowhere\n").unwrap();
    assert_eq!(find_registry(&deep, None, None, &git).unwrap().root, repo);
    assert_eq!(git.spawns(), 1);
}

#[test]
fn a_discovered_root_is_checked_only_inside_a_checkout() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    place(&ws, None);
    let es = entries(&["meta"]);
    let git = Git::new();
    // outside any checkout: no spawn
    let found = find_registry(&ws, None, None, &git).unwrap();
    check_discovered_root(&found, &es, &git).unwrap();
    assert_eq!(git.spawns(), 0);
    // named by `--root` or `--registry`: never checked
    checkout(&ws);
    let root = find_registry(&ws, None, Some(&ws), &git).unwrap();
    let explicit = find_registry(&ws, Some(Path::new("repos.toml")), None, &git).unwrap();
    for loc in [&root, &explicit] {
        assert!(!loc.discovered);
        check_discovered_root(loc, &es, &git).unwrap();
    }
    assert_eq!(git.spawns(), 0);
    // discovered in one: git reads its origin, as configured and as
    // resolved — here there's none
    let found = find_registry(&ws, None, None, &git).unwrap();
    check_discovered_root(&found, &es, &git).unwrap();
    assert_eq!(git.spawns(), 2);
}

/// `discover_registry` taking every candidate: the `(kind, dir)` of each
/// offered, and the root it found.
fn discover_all(
    start: &Path,
    bound: Option<&Bound>,
    git: &Git,
) -> (Vec<(CandidateKind, PathBuf)>, Option<PathBuf>) {
    let mut offered = Vec::new();
    let Ok(found) = discover_registry(start, bound, git, |c| {
        offered.push((c.kind, c.dir.to_owned()));
        Ok::<_, Infallible>(Some(()))
    });
    (offered, found.map(|(f, ())| f.root))
}

/// A bound strictly below `dir`.
fn bound_below(dir: &Path) -> Bound {
    Bound::below(dir).unwrap()
}

/// A bound at most `dir`.
fn bound_within(dir: &Path) -> Bound {
    Bound::within(dir).unwrap()
}

#[test]
fn the_bound_holds_the_walk() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    place(&ws, None);
    let deep = ws.join("a/b");
    std::fs::create_dir_all(&deep).unwrap();

    let git = Git::new();
    let root = |start: &Path, bound: Option<&Bound>| discover_all(start, bound, &git).1;
    assert_eq!(root(&deep, None), Some(ws.clone()));
    assert_eq!(root(&deep, Some(&bound_below(&top))), Some(ws.clone()));
    assert_eq!(root(&deep, Some(&bound_within(&ws))), Some(ws.clone()));
    // a registry at a `below` bound or above any bound isn't found
    assert_eq!(root(&deep, Some(&bound_below(&ws))), None);
    assert_eq!(root(&deep, Some(&bound_within(&ws.join("a")))), None);
    // nor from the bound's own dir when it's excluded, or from outside it
    assert_eq!(root(&ws, Some(&bound_below(&ws))), None);
    assert_eq!(root(&top, Some(&bound_within(&ws))), None);
    // each walk inside a bound that found nothing asked git once for a
    // main checkout (under the bound's ceiling); the rest never walked
    assert_eq!(git.spawns(), 2);

    // a bound that can't be resolved is refused when it's made
    assert!(Bound::below(&top.join("nope")).is_err());

    // a link to a checkout's registry, outside the bound, doesn't root it
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    checkout(&meta);
    place(&ws, Some(&real));
    assert_eq!(root(&meta, Some(&bound_below(&top))), Some(ws.clone()));
    assert_eq!(root(&meta, Some(&bound_within(&ws))), Some(ws.clone()));
    assert_eq!(root(&meta, Some(&bound_below(&ws))), Some(meta.clone()));
    assert_eq!(root(&meta, Some(&bound_within(&meta))), Some(meta.clone()));

    // a `.git` outside the bound makes no checkout: a linked worktree's
    // `.git` file there sends nothing to git
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().canonicalize().unwrap().join("ws");
    let inner = ws.join("inner");
    place(&inner, None);
    std::fs::write(ws.join(".git"), "gitdir: nowhere\n").unwrap();
    let git = Git::new();
    let found = discover_all(&inner, Some(&bound_below(&ws)), &git).1;
    assert_eq!(found, Some(inner.clone()));
    assert_eq!(git.spawns(), 0);
    assert_eq!(discover_all(&inner, None, &git).1, Some(inner));
    assert_eq!(git.spawns(), 1);
}

#[test]
fn a_bound_is_physical_and_never_names_a_colon_to_git() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    place(&ws, None);
    let deep = ws.join("a/b");
    std::fs::create_dir_all(&deep).unwrap();
    let git = Git::new();

    // a bound given through a symlink, or spelled with `..`, is its target
    let alias = top.join("alias");
    std::os::unix::fs::symlink(&ws, &alias).unwrap();
    assert_eq!(bound_below(&alias), bound_below(&ws));
    assert_eq!(bound_within(&alias).dir(), ws);
    assert_eq!(bound_below(&ws.join("a/..")), bound_below(&ws));
    assert_eq!(
        discover_all(&deep, Some(&bound_below(&alias)), &git).1,
        None
    );
    assert_eq!(
        discover_all(&deep, Some(&bound_within(&alias)), &git).1,
        Some(ws.clone())
    );

    // a start through a symlinked dir is walked physically: into the
    // bound from outside it, or out of it from inside
    let outside = top.join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&deep, outside.join("in")).unwrap();
    std::os::unix::fs::symlink(&outside, deep.join("out")).unwrap();
    let bound = bound_within(&ws);
    assert_eq!(
        discover_all(&outside.join("in"), Some(&bound), &git).1,
        Some(ws)
    );
    assert_eq!(discover_all(&deep.join("out"), Some(&bound), &git).1, None);

    // git's ceiling — the dir, or an inclusive bound's parent — can't hold
    // a `:`; the bound's own name under `within` can
    let colon = top.join("a:b");
    std::fs::create_dir_all(colon.join("r")).unwrap();
    for e in [
        Bound::below(&colon).unwrap_err(),
        Bound::within(&colon.join("r")).unwrap_err(),
    ] {
        assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput, "{e}");
    }
    assert!(Bound::within(&colon).is_ok());

    // a bound is a directory
    let file = place(&top.join("f"), None);
    for e in [
        Bound::below(&file).unwrap_err(),
        Bound::within(&file).unwrap_err(),
    ] {
        assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput, "{e}");
    }
}

#[test]
fn the_hook_vets_each_candidate_and_a_skip_walks_on() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    // `meta`'s registry, linked at `ws`; an unrelated one further out
    let real = place(&meta, None);
    checkout(&meta);
    place(&ws, Some(&real));
    place(&top, None);

    let git = Git::new();
    let (offered, root) = discover_all(&meta, None, &git);
    assert_eq!(
        offered,
        [
            (CandidateKind::Nearest, meta.clone()),
            (CandidateKind::Link, ws.clone())
        ]
    );
    assert_eq!(root, Some(ws.clone()));

    // the root and token a hook skipping the candidates `skip` names
    // finds — its token, the candidate's place in the offers — and what
    // it was offered
    let skipping = |skip: &[(CandidateKind, &Path)]| {
        let mut offered = Vec::new();
        let Ok(found) = discover_registry(&meta, None, &git, |c| {
            offered.push((c.kind, c.dir.to_owned()));
            Ok::<_, Infallible>((!skip.contains(&(c.kind, c.dir))).then_some(offered.len()))
        });
        (offered, found.map(|(f, token)| (f.root, token)))
    };
    // the last taken is the result, with its token
    let (_, found) = skipping(&[]);
    assert_eq!(found, Some((ws.clone(), 2)));
    // a skipped link: the next one out, else the nearest's dir, with the
    // nearest's token
    let (offered, found) = skipping(&[(CandidateKind::Link, &ws)]);
    assert_eq!(offered.len(), 2);
    assert_eq!(found, Some((meta.clone(), 1)));
    // a skipped nearest: as though it weren't there — the link at `ws` is
    // then the nearest, outside any checkout
    let (offered, found) = skipping(&[(CandidateKind::Nearest, &meta)]);
    assert_eq!(
        offered,
        [
            (CandidateKind::Nearest, meta.clone()),
            (CandidateKind::Nearest, ws.clone())
        ]
    );
    assert_eq!(found, Some((ws.clone(), 2)));
    let (_, found) = skipping(&[
        (CandidateKind::Nearest, &meta),
        (CandidateKind::Nearest, &ws),
    ]);
    assert_eq!(found, Some((top.clone(), 3)));
    // every one skipped: nothing found, and git asked for a main checkout
    let spawns = git.spawns();
    let (offered, found) = skipping(&[
        (CandidateKind::Nearest, &meta),
        (CandidateKind::Nearest, &ws),
        (CandidateKind::Nearest, &top),
    ]);
    assert_eq!(offered.len(), 3);
    assert_eq!(found, None);
    assert_eq!(git.spawns(), spawns + 1);

    // an error ends the walk with it, offering nothing more
    let mut offered = 0;
    let refused = discover_registry(&meta, None, &git, |c| {
        offered += 1;
        if c.kind == CandidateKind::Link {
            Err(c.path.to_owned())
        } else {
            Ok(Some(()))
        }
    });
    assert_eq!(refused.unwrap_err(), ws.join(REGISTRY_FILE));
    assert_eq!(offered, 2);
}

#[test]
fn a_candidate_reports_its_file_and_link_target() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    checkout(&meta);
    // linked relatively, as a workspace link usually is
    let link = place(&ws, Some(Path::new("meta/repos.toml")));
    let id = file_id(&real).unwrap();

    // a token tying the result to what the hook checked: the file it
    // opened (a real hook opens with `O_NONBLOCK`), a regular file on the
    // descriptor, its identity the walk's. A mismatch is an `Err`, never a
    // skip: skipping would let the walk widen the root past it.
    let mut seen = Vec::new();
    let (found, file) = discover_registry(&meta, None, &Git::new(), |c| {
        seen.push((c.kind, c.path.to_owned(), c.file, c.link_target()?));
        let file = std::fs::File::open(c.path)?;
        let opened = file.metadata()?;
        if !opened.is_file() || to_file_id(&opened) != c.file {
            return Err(std::io::Error::other("not the file the walk saw"));
        }
        Ok(Some(file))
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        seen,
        [
            (CandidateKind::Nearest, real.clone(), id, None),
            (CandidateKind::Link, link.clone(), id, Some(real)),
        ]
    );
    assert_eq!(to_file_id(&file.metadata().unwrap()), id);
    // the root is the link's dir, its path the link as found
    assert_eq!(found.root, ws);
    assert_eq!(found.path, link);
    assert!(found.discovered);
    // a target outside the dir it would root reads as such
    let outside = top.join("elsewhere");
    let far = place(&outside, None);
    let stray = place(&outside.join("in"), Some(&far));
    let candidate = Candidate {
        path: &stray,
        dir: stray.parent().unwrap(),
        kind: CandidateKind::Nearest,
        file: file_id(&stray).unwrap(),
    };
    let target = candidate.link_target().unwrap().unwrap();
    assert!(!target.starts_with(candidate.dir));
    // a dangling link: its target can't be resolved
    let dangling = top.join("dangling");
    std::os::unix::fs::symlink(top.join("nowhere"), &dangling).unwrap();
    let candidate = Candidate {
        path: &dangling,
        ..candidate
    };
    assert!(candidate.link_target().is_err());
}

/// Runs git in `dir` with no global or system config.
fn git_in(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .env_clear()
        .envs(std::env::var_os("PATH").map(|p| ("PATH", p)))
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// A repo at `main` with one commit, and a linked worktree of it at `wt`.
fn repo_with_worktree(main: &Path, wt: &Path) {
    std::fs::create_dir_all(main).unwrap();
    git_in(main, &["init", "-q", "-b", "main"]);
    git_in(main, &["commit", "-q", "--allow-empty", "-m", "x"]);
    let wt = wt.to_str().unwrap();
    git_in(main, &["worktree", "add", "-q", "-b", "wt", wt]);
}

#[test]
fn a_bound_holds_the_jump_from_a_linked_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = tmp.path().canonicalize().unwrap();
    // the worktree under `srv/r`; its main checkout beside it, in a
    // workspace linking its registry
    let r = srv.join("r");
    let wt = r.join("wt");
    let other = srv.join("other");
    let meta = other.join("meta");
    std::fs::create_dir_all(&r).unwrap();
    repo_with_worktree(&meta, &wt);
    let real = place(&meta, None);
    place(&other, Some(&real));
    // the worktree's own copy, linked nowhere
    place(&wt, None);

    let git = Git::new();
    // unbounded, or bounded where the main checkout is inside: the jump
    // roots at the link above the main checkout, which doesn't hold `wt`
    let unbounded = discover_all(&wt, None, &git);
    assert_eq!(
        unbounded,
        (
            vec![
                (CandidateKind::Nearest, wt.clone()),
                (CandidateKind::Link, other.clone())
            ],
            Some(other.clone())
        )
    );
    assert_eq!(
        discover_all(&wt, Some(&bound_within(&srv)), &git),
        unbounded
    );
    // within `r`, the main checkout is outside: no jump, and the
    // worktree's copy stays where it's found
    assert_eq!(
        discover_all(&wt, Some(&bound_within(&r)), &git),
        (vec![(CandidateKind::Nearest, wt.clone())], Some(wt.clone()))
    );

    // with no copy in the worktree, the fallback walk from the main
    // checkout: offered from there, a `Nearest` at the main checkout
    std::fs::remove_file(wt.join(REGISTRY_FILE)).unwrap();
    assert_eq!(
        discover_all(&wt, None, &git),
        (
            vec![
                (CandidateKind::Nearest, meta),
                (CandidateKind::Link, other.clone())
            ],
            Some(other)
        )
    );
    assert_eq!(
        discover_all(&wt, Some(&bound_within(&r)), &git),
        (vec![], None)
    );

    // the main checkout a sibling inside the bound: the jump stays inside
    let tmp = tempfile::tempdir().unwrap();
    let r = tmp.path().canonicalize().unwrap().join("r");
    let (meta, wt) = (r.join("meta"), r.join("wt"));
    std::fs::create_dir_all(&r).unwrap();
    repo_with_worktree(&meta, &wt);
    let real = place(&meta, None);
    place(&r, Some(&real));
    place(&wt, None);
    assert_eq!(
        discover_all(&wt, Some(&bound_within(&r)), &git).1,
        Some(r.clone())
    );
    assert_eq!(discover_all(&wt, Some(&bound_below(&r)), &git).1, Some(wt));
}

#[test]
fn a_symlinked_git_makes_no_checkout() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let git = Git::new();

    // a registry kept in `ws/meta`, linked at `ws`; `meta/.git` a symlink
    // to a real git dir, then to a gitfile: no checkout, so no link roots it
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    place(&ws, Some(&real));
    let real_repo = top.join("real");
    std::fs::create_dir_all(&real_repo).unwrap();
    git_in(&real_repo, &["init", "-q"]);
    std::fs::write(top.join("gitfile"), "gitdir: /nowhere\n").unwrap();
    for target in [real_repo.join(".git"), top.join("gitfile")] {
        std::os::unix::fs::symlink(&target, meta.join(".git")).unwrap();
        assert_eq!(
            discover_all(&meta, None, &git),
            (
                vec![(CandidateKind::Nearest, meta.clone())],
                Some(meta.clone())
            ),
            "{}",
            target.display()
        );
        assert!(entry_holding_root(&meta, &entries(&["meta"]), None, &git).is_none());
        std::fs::remove_file(meta.join(".git")).unwrap();
    }
    assert_eq!(git.spawns(), 0);
    // control: a `.git` dir roots it at the link
    checkout(&meta);
    assert_eq!(discover_all(&meta, None, &git).1, Some(ws));
    std::fs::remove_dir(meta.join(".git")).unwrap();

    // passed over for a real checkout further up
    let outer = top.join("o");
    let inner = outer.join("in");
    let real = place(&inner, None);
    place(&top, Some(&real));
    checkout(&outer);
    std::os::unix::fs::symlink(real_repo.join(".git"), inner.join(".git")).unwrap();
    assert_eq!(discover_all(&inner, None, &git).1, Some(top.clone()));
    std::fs::remove_file(top.join(REGISTRY_FILE)).unwrap();

    // a symlink to a linked worktree's gitfile, whose main checkout's
    // registry is linked above it: git isn't asked, so no jump there,
    // with a registry of its own or none
    let home = top.join("home");
    let (main, wt) = (home.join("ws/meta"), home.join("wt"));
    std::fs::create_dir_all(&home).unwrap();
    repo_with_worktree(&main, &wt);
    let real = place(&main, None);
    place(&home.join("ws"), Some(&real));
    let plain = home.join("plain");
    place(&plain, None);
    std::os::unix::fs::symlink("../wt/.git", plain.join(".git")).unwrap();
    let git = Git::new();
    assert_eq!(
        discover_all(&plain, None, &git),
        (
            vec![(CandidateKind::Nearest, plain.clone())],
            Some(plain.clone())
        )
    );
    std::fs::remove_file(plain.join(REGISTRY_FILE)).unwrap();
    assert_eq!(discover_all(&plain, None, &git), (vec![], None));
    assert_eq!(git.spawns(), 0);
    // control: from the worktree itself, git finds the main checkout
    assert_eq!(discover_all(&wt, None, &git).1, Some(home.join("ws")));

    // inside another linked worktree, a symlinked `.git` between the
    // registry and the worktree's top is passed over by git too: git
    // runs at the worktree's top, so `r`'s main checkout is asked, which
    // holds no `sub/repos.toml`
    let (r, rwt) = (home.join("r"), home.join("rwt"));
    repo_with_worktree(&r, &rwt);
    let sub = rwt.join("sub");
    place(&sub, None);
    std::os::unix::fs::symlink("../../wt/.git", sub.join(".git")).unwrap();
    assert_eq!(discover_all(&sub, None, &git).1, Some(sub.clone()));
}

#[test]
fn entry_holding_root_names_the_entry_whose_checkout_holds_the_root() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    // the registry's own repo, cloned with no link above it
    let meta = top.join("meta");
    place(&meta, None);
    git_in(&meta, &["init", "-q"]);
    git_in(
        &meta,
        &["remote", "add", "origin", "https://github.com/me/meta"],
    );
    let es = entries(&["app", "meta"]);
    let git = Git::new();

    let Ok(found) = discover_registry(&meta.join(".git"), None, &git, |_| {
        Ok::<_, Infallible>(Some(()))
    });
    let (found, ()) = found.unwrap();
    assert_eq!(found.root, meta);
    let named = |root: &Path, es: &[Entry], bound: Option<&Bound>| {
        entry_holding_root(root, es, bound, &git).map(|e| e.key.clone())
    };
    assert_eq!(named(&found.root, &es, None).as_deref(), Some("meta"));
    assert_eq!(
        named(&found.root, &es, Some(&bound_within(&meta))).as_deref(),
        Some("meta")
    );
    // `repos` refuses it
    let e = check_discovered_root(&found, &es, &git).unwrap_err();
    assert!(
        matches!(&e, Error::RootInEntry { key, root, .. } if key == "meta" && *root == meta),
        "{e}"
    );
    // a root spelled through a symlink is read physically, as the bound is
    let alias = top.join("alias");
    std::os::unix::fs::symlink(&meta, &alias).unwrap();
    assert_eq!(
        named(&alias, &es, Some(&bound_within(&meta))).as_deref(),
        Some("meta")
    );
    assert!(named(&top.join("nope"), &es, None).is_none());
    // a checkout of no entry, or no checkout, names none
    assert!(named(&found.root, &entries(&["app"]), None).is_none());
    assert!(named(&top, &es, None).is_none());
}

#[test]
fn entry_holding_root_reads_no_checkout_outside_the_bound() {
    // `$HOME` a dotfiles repo the registry lists, the workspace under it
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap().join("home");
    let dev = home.join("dev");
    std::fs::create_dir_all(&home).unwrap();
    git_in(&home, &["init", "-q"]);
    git_in(
        &home,
        &["remote", "add", "origin", "https://github.com/me/dots"],
    );
    place(&dev, None);
    let es = entries(&["app", "dots"]);

    let git = Git::new();
    let bound = bound_below(&home);
    let (_, root) = discover_all(&dev.join("."), Some(&bound), &git);
    assert_eq!(root.as_deref(), Some(dev.as_path()));
    // inside the bound, `$HOME`'s checkout isn't read
    assert!(entry_holding_root(&dev, &es, Some(&bound), &git).is_none());
    assert_eq!(git.spawns(), 0);
    // unbounded, as `repos` reads it, it is
    let named = |root: &Path, bound: Option<&Bound>| {
        entry_holding_root(root, &es, bound, &git).map(|e| e.key.clone())
    };
    assert_eq!(named(&dev, None).as_deref(), Some("dots"));

    // a `.git` that isn't a git dir, inside the bound: git, run there,
    // searches up — stopped by the bound's ceiling
    let x = dev.join("x");
    std::fs::create_dir_all(x.join(".git")).unwrap();
    assert_eq!(named(&x, None).as_deref(), Some("dots"));
    assert_eq!(named(&x, Some(&bound)), None);
    assert_eq!(named(&x, Some(&bound_within(&dev))), None);
}

#[test]
fn a_symlinked_git_above_the_bound_lifts_no_ceiling_past_it() {
    // a symlinked `.git` above an exclusive bound, a usable checkout at the
    // bound's dir: the symlink is out of reach, so the ceiling stays the
    // bound's, and git never reads the bound dir's `.git`
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let home = top.join("home");
    let dev = home.join("dev");
    std::fs::create_dir_all(&home).unwrap();
    git_in(&home, &["init", "-q"]);
    git_in(
        &home,
        &["remote", "add", "origin", "https://github.com/me/dots"],
    );
    place(&dev, None);
    let store = top.join("store/top.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    std::os::unix::fs::symlink(&store, top.join(".git")).unwrap();
    let es = entries(&["app", "dots"]);
    let git = Git::new();
    let bound = bound_below(&home);
    // a `.git` that isn't a git dir, inside the bound: git, run there,
    // searches up
    let x = dev.join("x");
    std::fs::create_dir_all(x.join(".git")).unwrap();
    assert_eq!(
        git_ceiling_at(&x, Some(&bound)),
        GitReach::Ceiling(Some(home.as_path()))
    );
    assert!(entry_holding_root(&x, &es, Some(&bound), &git).is_none());
    // control: unbounded, the symlink's dir is the ceiling, and git reads
    // `home`'s checkout below it
    assert_eq!(
        git_ceiling_at(&x, None),
        GitReach::Ceiling(Some(top.as_path()))
    );
    assert_eq!(
        entry_holding_root(&x, &es, None, &git).map(|e| e.key.as_str()),
        Some("dots")
    );
}

#[test]
fn an_explicit_registry_roots_at_its_dir_links_or_not() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let real = place(&ws.join("meta"), None);
    place(&ws, Some(&real));
    let found = find_registry(&ws, Some(Path::new("meta/repos.toml")), None, &Git::new()).unwrap();
    assert_eq!(found.root, ws.join("meta"));
    assert_eq!(found.path, real);
}

#[test]
fn explicit_path_is_relative_to_cwd() {
    let found = find_registry(
        Path::new("/a/b"),
        Some(Path::new("../reg/repos.toml")),
        None,
        &Git::new(),
    )
    .unwrap();
    assert_eq!(found.path, Path::new("/a/b/../reg/repos.toml"));
    assert_eq!(found.root, Path::new("/a/b/../reg"));
}

#[test]
fn root_overrides_the_registry_dir() {
    let tmp = tempfile::tempdir().unwrap();
    let ws = tmp.path().join("ws");
    let meta = tmp.path().join("meta");
    std::fs::create_dir_all(ws.join("repo")).unwrap();
    std::fs::create_dir_all(&meta).unwrap();
    std::fs::write(meta.join(REGISTRY_FILE), "owners = []\n").unwrap();

    // with an explicit registry
    let found = find_registry(
        &ws,
        Some(&meta.join(REGISTRY_FILE)),
        Some(Path::new(".")),
        &Git::new(),
    )
    .unwrap();
    assert_eq!(found.path, meta.join(REGISTRY_FILE));
    assert_eq!(found.root, ws.join("."));

    // with the walk-up
    let found = find_registry(&meta, None, Some(&ws), &Git::new()).unwrap();
    assert_eq!(found.path, meta.join(REGISTRY_FILE));
    assert_eq!(found.root, ws);
}

#[test]
fn a_missing_root_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(REGISTRY_FILE), "owners = []\n").unwrap();
    let e = find_registry(tmp.path(), None, Some(Path::new("nope")), &Git::new()).unwrap_err();
    assert!(matches!(e, Error::RootNotFound { .. }), "{e}");
    assert_eq!(e.exit_code(), 2);
}

#[test]
fn not_found_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let git = Git::new();
    let e = find_registry(tmp.path(), None, None, &git).unwrap_err();
    assert!(matches!(e, Error::RegistryNotFound { .. }));
    assert_eq!(git.spawns(), 1);
    assert!(e.hint().is_some_and(|h| h.contains("--registry")), "{e}");
}

#[test]
fn edit_distance_counts_each_edit_once() {
    for (a, b, d) in [
        ("", "", 0),
        ("gro", "gro", 0),
        ("gro", "", 3),
        ("gro", "gor", 1),  // transposition
        ("gro", "grp", 1),  // substitution
        ("gro", "groo", 1), // insertion
        ("fuz_ui", "fuz_css", 3),
        ("kitten", "sitting", 3),
        ("ca", "abc", 3),  // optimal string alignment, not full Damerau
        ("zzz", "żzz", 1), // chars, not bytes
    ] {
        assert_eq!(edit_distance(a, b), d, "{a} / {b}");
        assert_eq!(edit_distance(b, a), d, "{b} / {a}");
    }
}

/// Entries keyed `keys`, each in the dir of its name; `key:dir` names
/// another dir.
fn entries(keys: &[&str]) -> Vec<Entry> {
    use std::fmt::Write as _;
    let mut toml = String::from("owners = [\"me\"]\n");
    for k in keys {
        let (k, dir) = k.split_once(':').unwrap_or((k, k));
        let _ = write!(
            toml,
            "[repos.{k}]\nurl = \"https://github.com/me/{k}\"\nvisibility = \"public\"\n\
             purpose = \"x\"\ndir = \"{dir}\"\n"
        );
    }
    crate::registry::Registry::parse(&toml)
        .unwrap()
        .validate()
        .unwrap()
        .entries()
}

#[test]
fn suggests_close_keys_best_first() {
    let es = entries(&[
        "fuz_app", "fuz_css", "fuz_ui", "fuz_util", "gro", "graphite", "tsv", "zzz", "FuzDocs",
        "cm",
    ]);
    let suggest = |t: &str| suggest_keys(&es, t);
    // a typo, a transposition, a case slip
    assert_eq!(suggest("gor"), ["gro"]);
    assert_eq!(suggest("fzu_ui"), ["fuz_ui"]);
    assert_eq!(suggest("GRO"), ["gro"]);
    // the key's case ignored too, and suggested as declared
    assert_eq!(suggest("fuzdoc"), ["FuzDocs"]);
    // near ones by distance, then key; capped
    assert_eq!(suggest("fuz_u"), ["fuz_ui", "fuz_util"]);
    assert_eq!(suggest("fuz"), ["fuz_ui", "FuzDocs", "fuz_app"]);
    // a prefix too far to be a typo, and a key inside the target
    assert_eq!(suggest("grap"), ["graphite"]);
    assert_eq!(suggest("gro-old"), ["gro"]);
    // a path's last component
    assert_eq!(suggest("../tsb/"), ["tsv"]);
    assert_eq!(suggest("/elsewhere/zzz"), ["zzz"]);
    // a 2-char name still allows one edit
    assert_eq!(suggest("cn"), ["cm"]);
    // containment needs three chars: `fu` is in every `fuz_*`, and too
    // far from each by edits
    assert!(suggest("fu").is_empty());
    // nothing close
    assert!(suggest("lantern").is_empty());
    assert!(suggest(".").is_empty());
    assert!(suggest("..").is_empty());
    assert!(suggest("").is_empty());
    // short names match short keys only by edits, never by containment
    assert!(suggest("z").is_empty());
    assert_eq!(suggest("zz"), ["zzz"]);
}

#[test]
fn suggests_by_key_or_dir_named_by_key() {
    let es = entries(&["app_forge:vendor_app_forge", "app_os:vendor_app_os", "tsv"]);
    let suggest = |t: &str| suggest_keys(&es, t);
    // near the dir by one edit, and `app_os`'s dir by three
    assert_eq!(suggest("vendor_app_forg"), ["app_forge", "app_os"]);
    // the closer of key and dir ranks it: `app_os` by its key
    assert_eq!(suggest("app_o"), ["app_os"]);
    assert_eq!(suggest("../vendor_app_os/"), ["app_os", "app_forge"]);
}

/// `home/ws/meta` a repo whose registry is linked at `home/ws`, with a
/// linked worktree at `home/wt`, and `home/plain/.git` a symlink to the
/// worktree's gitfile: `plain` returned.
fn symlinked_gitfile_shape(home: &Path) -> PathBuf {
    let (main, wt) = (home.join("ws/meta"), home.join("wt"));
    std::fs::create_dir_all(home).unwrap();
    repo_with_worktree(&main, &wt);
    let real = place(&main, None);
    place(&home.join("ws"), Some(&real));
    let plain = home.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    std::os::unix::fs::symlink("../wt/.git", plain.join(".git")).unwrap();
    plain
}

#[test]
fn git_never_reaches_a_symlinked_git_past_one_it_cannot_use() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap().join("home");
    let plain = symlinked_gitfile_shape(&home);
    let sub = plain.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let git = Git::new();
    // git passes over an empty `.git` dir or a FIFO and walks on up, to
    // the symlink and through it to the worktree: the ceiling at `plain`
    // stops it, so no jump to `ws`
    for fifo in [false, true] {
        let what = if fifo { "a FIFO" } else { "an empty dir" };
        if fifo {
            let status = std::process::Command::new("mkfifo")
                .arg(sub.join(".git"))
                .status()
                .unwrap();
            assert!(status.success());
        } else {
            std::fs::create_dir(sub.join(".git")).unwrap();
        }
        for bound in [None, Some(bound_below(&home))] {
            assert_eq!(
                discover_all(&sub, bound.as_ref(), &git),
                (vec![], None),
                "{what}, bound {bound:?}"
            );
        }
        let deep = sub.join("deep");
        std::fs::create_dir(&deep).unwrap();
        assert_eq!(discover_all(&deep, None, &git), (vec![], None), "{what}");
        // `sub` is a checkout to discovery when its `.git` is a dir: git,
        // asked there for its origin, stops at the ceiling too
        if !fifo {
            assert!(entry_holding_root(&sub, &entries(&["meta"]), None, &git).is_none());
        }
        std::fs::remove_dir_all(&sub).unwrap();
        std::fs::create_dir(&sub).unwrap();
    }
    // control: from the worktree itself, git still finds the main checkout
    assert_eq!(
        discover_all(&home.join("wt"), None, &git).1,
        Some(home.join("ws"))
    );
}

#[test]
fn entry_holding_root_reads_no_origin_through_a_symlinked_git_above_its_checkout() {
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let other = top.join("other");
    std::fs::create_dir_all(&other).unwrap();
    git_in(&other, &["init", "-q"]);
    git_in(
        &other,
        &["remote", "add", "origin", "https://github.com/me/meta"],
    );
    let plain = top.join("plain");
    let sub = plain.join("sub");
    std::fs::create_dir_all(sub.join(".git")).unwrap();
    std::os::unix::fs::symlink(other.join(".git"), plain.join(".git")).unwrap();
    let git = Git::new();
    let es = entries(&["meta"]);
    // `sub`'s `.git` is no git dir: git walks up from it, to the ceiling
    // below `plain`, never to `other`'s config
    assert!(entry_holding_root(&sub, &es, Some(&bound_below(&top)), &git).is_none());
    assert!(entry_holding_root(&sub, &es, None, &git).is_none());
    assert!(entry_holding_root(&plain, &es, None, &git).is_none());
}

#[test]
fn entry_holding_root_runs_git_at_the_checkout_holding_the_root() {
    // a real checkout `outer`, and below it `inner`, whose `.git` is a
    // symlink to another repo: each with an origin naming an entry
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let outer = top.join("outer");
    let inner = outer.join("inner");
    let elsewhere = top.join("elsewhere");
    for (dir, key) in [(&outer, "outer"), (&elsewhere, "inner")] {
        std::fs::create_dir_all(dir).unwrap();
        git_in(dir, &["init", "-q"]);
        let url = format!("https://github.com/me/{key}");
        git_in(dir, &["remote", "add", "origin", &url]);
    }
    std::fs::create_dir_all(&inner).unwrap();
    std::os::unix::fs::symlink(elsewhere.join(".git"), inner.join(".git")).unwrap();
    let git = Git::new();
    // `inner` first, so reading its origin would name it
    let es = entries(&["inner", "outer"]);
    for bound in [None, Some(bound_below(&top))] {
        let named = entry_holding_root(&inner, &es, bound.as_ref(), &git).map(|e| e.key.clone());
        assert_eq!(named.as_deref(), Some("outer"), "bound {bound:?}");
    }
}

#[test]
fn no_git_runs_where_its_ceiling_would_hold_a_colon() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().canonicalize().unwrap().join("ho:me");
    let plain = symlinked_gitfile_shape(&home);
    let sub = plain.join("sub");
    std::fs::create_dir_all(sub.join(".git")).unwrap();
    let git = Git::new();
    assert_eq!(discover_all(&sub, None, &git), (vec![], None));
    assert!(entry_holding_root(&sub, &entries(&["meta"]), None, &git).is_none());
    assert_eq!(git.spawns(), 0);
    assert_eq!(git_ceiling_at(&sub, None), GitReach::Refused);
    assert_eq!(git_ceiling_at(&plain, None), GitReach::Refused);
    // with no symlink in reach, a `:` above is no ceiling's business
    std::fs::remove_file(plain.join(".git")).unwrap();
    assert_eq!(git_ceiling_at(&sub, None), GitReach::Ceiling(None));
}

#[test]
fn a_discovered_root_whose_own_git_is_a_symlink_is_refused() {
    // a registry kept in `ws/meta`, linked at `ws`, whose `.git` is a
    // symlink to a git dir elsewhere: discovery sees no checkout, so from
    // inside `meta` the root is `meta`
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let real = place(&meta, None);
    place(&ws, Some(&real));
    let store = top.join("store/meta.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    git_in(
        &store,
        &["remote", "add", "origin", "https://github.com/me/meta"],
    );
    std::os::unix::fs::symlink(&store, meta.join(".git")).unwrap();
    let git = Git::new();
    let es = entries(&["app", "meta"]);
    let found = find_registry(&meta, None, None, &git).unwrap();
    assert_eq!(found.root, meta);
    let e = check_discovered_root(&found, &es, &git).unwrap_err();
    assert!(
        matches!(&e, Error::RootGitSymlink { root, git: link, .. }
            if *root == meta && *link == meta.join(".git")),
        "{e}"
    );
    // read without git
    assert_eq!(git.spawns(), 0);
    // and from below it, rooted at `meta` too
    let deep = meta.join("deep");
    std::fs::create_dir(&deep).unwrap();
    let found = find_registry(&deep, None, None, &git).unwrap();
    assert_eq!(found.root, meta);
    let e = check_discovered_root(&found, &es, &git);
    assert!(matches!(e, Err(Error::RootGitSymlink { .. })), "{e:?}");
    // named by `--root` or `--registry`, never checked
    let named = find_registry(&meta, None, Some(&meta), &git).unwrap();
    check_discovered_root(&named, &es, &git).unwrap();
    // control: from the link's dir the root is `ws`, which runs
    let found = find_registry(&ws, None, None, &git).unwrap();
    assert_eq!(found.root, ws);
    check_discovered_root(&found, &es, &git).unwrap();
}

#[test]
fn a_discovered_root_under_a_symlinked_git_runs() {
    // `$HOME` a dotfiles repo whose `.git` is a symlink, the workspace
    // `home/dev` no checkout of its own: only the root's own `.git` is
    // read, so it runs
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let home = top.join("home");
    let dev = home.join("dev");
    place(&dev, None);
    let store = top.join("store/dots.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    git_in(
        &store,
        &["remote", "add", "origin", "https://github.com/me/dots"],
    );
    std::os::unix::fs::symlink(&store, home.join(".git")).unwrap();
    // a link at the dotfiles repo's own top is inside that repo, not above
    // it: it doesn't make the registry linked past the symlink
    place(&home, Some(&dev.join(REGISTRY_FILE)));
    let git = Git::new();
    let es = entries(&["app", "dots"]);
    for start in [dev.clone(), dev.join("app")] {
        std::fs::create_dir_all(&start).unwrap();
        let found = find_registry(&start, None, None, &git).unwrap();
        assert_eq!(found.root, dev);
        check_discovered_root(&found, &es, &git).unwrap();
    }
    // the symlink passed over, no git runs
    assert_eq!(git.spawns(), 0);
}

#[test]
fn a_registry_below_the_top_of_a_repo_with_a_symlinked_git_runs() {
    // the registry kept in `meta/sub`, `meta`'s `.git` a symlink:
    // discovery sees no checkout, so the root is `meta/sub`, whose own
    // `.git` isn't one — not refused, and its entries read as missing
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let meta = top.join("ws/meta");
    let sub = meta.join("sub");
    place(&sub, None);
    let store = top.join("store/meta.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    git_in(
        &store,
        &["remote", "add", "origin", "https://github.com/me/meta"],
    );
    std::os::unix::fs::symlink(&store, meta.join(".git")).unwrap();
    let git = Git::new();
    let es = entries(&["app", "meta"]);
    let found = find_registry(&sub, None, None, &git).unwrap();
    assert_eq!(found.root, sub);
    check_discovered_root(&found, &es, &git).unwrap();
    assert_eq!(git.spawns(), 0);
}

#[test]
fn a_registry_below_the_top_of_a_repo_with_a_symlinked_git_linked_above_is_refused() {
    // the `cfg/` layout: the registry in `meta/cfg`, linked at `ws`, but
    // `meta`'s `.git` a symlink: discovery sees no checkout, so the walk
    // never reaches the link and the root is `meta/cfg` — refused, since
    // a sync there would clone the fleet into `meta`
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let cfg = meta.join("cfg");
    let real = place(&cfg, None);
    place(&ws, Some(&real));
    let store = top.join("store/meta.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    std::os::unix::fs::symlink(&store, meta.join(".git")).unwrap();
    let git = Git::new();
    let es = entries(&["app", "meta"]);
    for start in [cfg.clone(), cfg.join("deep")] {
        std::fs::create_dir_all(&start).unwrap();
        let found = find_registry(&start, None, None, &git).unwrap();
        assert_eq!(found.root, cfg);
        let e = check_discovered_root(&found, &es, &git).unwrap_err();
        assert!(
            matches!(&e, Error::RootGitSymlink { root, git: link, linked: Some(linked), .. }
                if *root == cfg && *link == meta.join(".git")
                    && *linked == ws.join(REGISTRY_FILE)),
            "{e}"
        );
    }
    // read without git
    assert_eq!(git.spawns(), 0);
    // named, never checked; from the link's dir the root is `ws`
    let named = find_registry(&cfg, None, Some(&cfg), &git).unwrap();
    check_discovered_root(&named, &es, &git).unwrap();
    let found = find_registry(&ws, None, None, &git).unwrap();
    assert_eq!(found.root, ws);
    check_discovered_root(&found, &es, &git).unwrap();
    // a link naming some other file isn't this registry's
    std::fs::remove_file(ws.join(REGISTRY_FILE)).unwrap();
    std::fs::write(ws.join(REGISTRY_FILE), "").unwrap();
    let found = find_registry(&cfg, None, None, &git).unwrap();
    check_discovered_root(&found, &es, &git).unwrap();
}

#[test]
fn a_fifo_git_below_the_symlinked_one_hides_no_link_above() {
    // the `cfg/` layout one level deeper, with a FIFO `.git` at `meta/a`:
    // discovery skips the FIFO and the symlink, so the root is
    // `meta/a/cfg`; the search for the repo skips the FIFO too, so the
    // link at `ws` is still found and the root refused
    let tmp = tempfile::tempdir().unwrap();
    let top = tmp.path().canonicalize().unwrap();
    let ws = top.join("ws");
    let meta = ws.join("meta");
    let cfg = meta.join("a/cfg");
    let real = place(&cfg, None);
    place(&ws, Some(&real));
    let store = top.join("store/meta.git");
    std::fs::create_dir_all(&store).unwrap();
    git_in(&store, &["init", "-q", "--bare"]);
    std::os::unix::fs::symlink(&store, meta.join(".git")).unwrap();
    let status = std::process::Command::new("mkfifo")
        .arg(meta.join("a/.git"))
        .status()
        .unwrap();
    assert!(status.success());
    let git = Git::new();
    let es = entries(&["app", "meta"]);
    let found = find_registry(&cfg, None, None, &git).unwrap();
    assert_eq!(found.root, cfg);
    let e = check_discovered_root(&found, &es, &git).unwrap_err();
    assert!(
        matches!(&e, Error::RootGitSymlink { git: link, linked: Some(linked), .. }
            if *link == meta.join(".git") && *linked == ws.join(REGISTRY_FILE)),
        "{e}"
    );
}
