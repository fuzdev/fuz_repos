//! Finding the registry, the workspace root it names, and the entries a
//! command's targets select.

use std::collections::HashSet;
use std::convert::Infallible;
use std::path::{Path, PathBuf};

use fuz_git::{CallOptions, Git, GitError, VersionError};

use crate::classify::origin_matches;
use crate::error::{Error, Result};
use crate::gitdir::dot_git_target;
use crate::paths::same_canonical;
use crate::registry::{Entry, RegistryDirs, ValidRegistry};

/// Maps the runner's version failure to the run-stopping error, whose text
/// the user sees.
fn version_error(e: VersionError) -> Error {
    match e {
        VersionError::NotFound => Error::GitNotFound,
        VersionError::TooOld { found, required } => Error::GitTooOld { found, required },
        VersionError::Run(e) => Error::Io {
            context: "failed to run git --version".into(),
            source: std::io::Error::other(e),
        },
    }
}

/// The registry's file name, found by walking up from the cwd.
pub const REGISTRY_FILE: &str = "repos.toml";

/// Where the caller says the registry and the workspace root are
/// (`--registry`, `--root`), each relative to the cwd; `None` finds them
/// (`find_registry`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Locate<'a> {
    pub registry: Option<&'a Path>,
    pub root: Option<&'a Path>,
}

/// A workspace loaded: its registry found, validated, and its root vouched
/// for (`Workspace::load`) — what every command starts from.
#[derive(Debug)]
pub struct Workspace {
    pub location: RegistryLocation,
    pub registry: ValidRegistry,
    /// Every entry, as `ValidRegistry::entries` orders them.
    pub entries: Vec<Entry>,
}

impl Workspace {
    /// Checks that git is there and new enough, finds the registry
    /// (`find_registry`: walking up from `start`, unless `locate` names it,
    /// relative to `cwd`), loads and validates it, and refuses a root
    /// found walking up whose own `.git` is a symlink, or that a symlinked
    /// `.git` kept from the registry's link above, or that is an entry's
    /// checkout (`check_discovered_root`).
    ///
    /// # Errors
    ///
    /// `GitNotFound` or `GitTooOld` first, since discovery runs git too;
    /// then what `find_registry` and `ValidRegistry::load` return, and
    /// `RootGitSymlink` or `RootInEntry`.
    pub fn load(git: &Git, cwd: &Path, start: &Path, locate: Locate<'_>) -> Result<Self> {
        git.check_version(cwd).map_err(version_error)?;
        let registry = locate.registry.map(|r| cwd.join(r));
        let root = locate.root.map(|r| cwd.join(r));
        let location = find_registry(start, registry.as_deref(), root.as_deref(), git)?;
        // validated before targets resolve and anything is probed
        let registry = ValidRegistry::load(&location.path)?;
        let entries = registry.entries();
        check_discovered_root(&location, &entries, git)?;
        Ok(Self {
            location,
            registry,
            entries,
        })
    }

    /// The workspace root entry dirs resolve against.
    pub fn root(&self) -> &Path {
        &self.location.root
    }

    /// Every entry's dir, canonicalized (`RegistryDirs`).
    pub fn registry_dirs(&self) -> RegistryDirs {
        RegistryDirs::new(&self.location.root, &self.entries)
    }
}

/// Where the registry was found.
///
/// `root` is the directory holding `path` as found — never the target of a
/// symlinked registry. A registry found inside a checkout is found where a
/// link above that checkout names it, when one does (`Walk::walk_up`).
#[derive(Debug, Clone)]
pub struct RegistryLocation {
    pub path: PathBuf,
    pub root: PathBuf,
    /// The root was found walking up — neither `--registry` nor `--root`
    /// named it — so `check_discovered_root` applies.
    pub discovered: bool,
}

/// Locates the registry and the workspace root.
///
/// The registry is `explicit` if given (relative to `cwd`), its dir taken
/// as the root as it stands — explicit is explicit, links or not. Else it's
/// the first `repos.toml` in `cwd` or an ancestor, read physically (`cwd`
/// canonicalized), and placed by `Walk::walk_up` — no env var, no `$HOME`
/// fallback. When that walk finds nothing and `cwd` is inside a linked
/// worktree, it runs once more from the repo's main checkout, so a linked
/// worktree outside the workspace finds its repo's registry: that is
/// `discover_registry` with no bound, taking every candidate. The root is
/// `root` if given (relative to `cwd`), for a registry kept outside the
/// workspace, else the registry's dir.
///
/// # Errors
///
/// `RegistryNotFound` when neither walk finds a registry (or `cwd` doesn't
/// exist); `RootNotFound` when `root` isn't a directory — a mistyped root
/// would otherwise read every entry as missing.
pub fn find_registry(
    cwd: &Path,
    explicit: Option<&Path>,
    root: Option<&Path>,
    git: &Git,
) -> Result<RegistryLocation> {
    let mut found = if let Some(explicit) = explicit {
        let path = cwd.join(explicit);
        let root = path.parent().map_or_else(|| cwd.to_owned(), Path::to_owned);
        RegistryLocation {
            path,
            root,
            discovered: false,
        }
    } else {
        let Ok(found) = discover_registry(cwd, None, git, |_| Ok::<_, Infallible>(Some(())));
        found
            .map(|(location, ())| location)
            .ok_or_else(|| Error::RegistryNotFound {
                start: cwd.to_owned(),
            })?
    };
    if let Some(root) = root {
        let root = cwd.join(root);
        if !root.is_dir() {
            return Err(Error::RootNotFound { root });
        }
        found.root = root;
        found.discovered = false;
    }
    Ok(found)
}

/// How far up a walk (`discover_registry`, `entry_holding_root`) may look.
///
/// Resolved when it's made: the dir is canonicalized, so the bound is
/// compared over physical paths, and a caller learns at construction — not
/// as a silent miss — that a bound can't be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bound {
    dir: PathBuf,
    inclusive: bool,
}

impl Bound {
    /// Only dirs strictly below `dir`: neither `dir` nor anything above it
    /// is looked at, as git's `GIT_CEILING_DIRECTORIES` bounds its
    /// discovery. The bound for "strictly below `$HOME`".
    ///
    /// # Errors
    ///
    /// The `io::Error` canonicalizing `dir`; `InvalidInput` when it isn't a
    /// directory, or when the dir git is given as its ceiling (`dir`
    /// itself) holds a `:`, which `GIT_CEILING_DIRECTORIES` reads as a
    /// separator and has no escape for.
    pub fn below(dir: &Path) -> std::io::Result<Self> {
        Self::new(dir, false)
    }

    /// `dir` and the dirs under it. The bound for "at most an allowlisted
    /// root".
    ///
    /// # Errors
    ///
    /// The `io::Error` canonicalizing `dir`; `InvalidInput` when it isn't a
    /// directory, or when the dir git is given as its ceiling (the parent
    /// of `dir`) holds a `:`, as `Bound::below`.
    pub fn within(dir: &Path) -> std::io::Result<Self> {
        Self::new(dir, true)
    }

    /// A bound at `dir`, canonicalized, checked to be a directory git's
    /// ceiling can name.
    fn new(dir: &Path, inclusive: bool) -> std::io::Result<Self> {
        use std::os::unix::ffi::OsStrExt as _;
        let bound = Self {
            dir: dir.canonicalize()?,
            inclusive,
        };
        if !std::fs::metadata(&bound.dir)?.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} isn't a directory", bound.dir.display()),
            ));
        }
        if let Some(ceiling) = bound.git_ceiling()
            && ceiling.as_os_str().as_bytes().contains(&b':')
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "{} holds a `:`, which git's ceiling can't name",
                    ceiling.display()
                ),
            ));
        }
        Ok(bound)
    }

    /// The bound's dir, canonicalized.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Whether `path` is inside the bound, compared by components.
    fn contains(&self, path: &Path) -> bool {
        path.starts_with(&self.dir) && (self.inclusive || path != self.dir)
    }

    /// The dir git's own discovery must not enter
    /// (`GIT_CEILING_DIRECTORIES`): the bound's dir, or for an inclusive
    /// bound its parent (none for `/`, which bounds nothing).
    fn git_ceiling(&self) -> Option<&Path> {
        if self.inclusive {
            self.dir.parent()
        } else {
            Some(&self.dir)
        }
    }
}

/// Whether `dir` is inside `bound`; with none, every dir is.
fn in_bound(dir: &Path, bound: Option<&Bound>) -> bool {
    bound.is_none_or(|b| b.contains(dir))
}

/// A file's identity: its device and inode, as the walk read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

/// A `repos.toml` the walk (`discover_registry`) would take, offered to its
/// `accept` hook first.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    /// The registry file as the walk found it, `dir` joined with
    /// `REGISTRY_FILE`: possibly a symlink (`Candidate::link_target`).
    pub path: &'a Path,
    /// The directory holding `path`, physical (the walk's start is
    /// canonicalized): the workspace root if the walk ends on this
    /// candidate.
    pub dir: &'a Path,
    pub kind: CandidateKind,
    /// The file the walk saw at `path`, through symlinks: for a `Link`, the
    /// identity it matched. A hook that opens `path` checks its open
    /// descriptor against this, so a file swapped in after the walk looked
    /// is never the one taken. It opens with `O_NONBLOCK` and checks the
    /// descriptor is a regular file before reading: the walk saw a regular
    /// file, but a FIFO swapped in since would block a plain open.
    pub file: FileId,
}

impl Candidate<'_> {
    /// Where `path` leads when it is itself a symlink: `Some` of the target
    /// canonicalized, else `None`. A caller that follows a symlinked
    /// registry only when its target stays inside the root compares this
    /// with `dir`: the target is inside `dir` exactly when it is inside the
    /// root this candidate makes if the walk ends on it.
    ///
    /// # Errors
    ///
    /// The `io::Error` reading the link or resolving its target.
    pub fn link_target(&self) -> std::io::Result<Option<PathBuf>> {
        if std::fs::symlink_metadata(self.path)?
            .file_type()
            .is_symlink()
        {
            self.path.canonicalize().map(Some)
        } else {
            Ok(None)
        }
    }
}

/// Which step of the walk (`discover_registry`) offers a `Candidate`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    /// A `repos.toml` at or above the walk's start that is a file (through
    /// symlinks): the first one, and after the hook skips one, each next
    /// one further up. On the fallback walk from a linked worktree's main
    /// checkout, the start is that main checkout. Taken, it roots the
    /// workspace at its dir, unless it is inside a checkout and a `Link`
    /// above that checkout is taken next.
    Nearest,
    /// A `repos.toml` strictly above the checkout holding the taken
    /// `Nearest` that is the same file (`Candidate::file`) — or, from a
    /// linked worktree, the same file as the main checkout's copy, above
    /// that checkout. Taken, it roots the workspace at its dir.
    Link,
}

/// Finds the registry walking up from `start`, as `find_registry` does
/// without `--registry` or `--root`, inside `bound` and vetted by `accept`.
///
/// The walk is over `start` canonicalized, and is `Walk::walk_up`'s rule:
/// the first `repos.toml` at or above it, placed at the root of the nearest
/// link above the checkout holding it, else where it's found; when nothing
/// is found and `start` is in a linked worktree, the same walk from the
/// repo's main checkout. So the root need not hold `start`: from a linked
/// worktree, it's where the main checkout's registry is linked, wherever
/// that is inside the bound. The result is `discovered`, so
/// `entry_holding_root` applies.
///
/// `bound` holds every step: nothing outside it is looked at — no registry
/// or link there is found, a `.git` there makes no checkout, a main
/// checkout outside it is never walked from, and git's discovery stops at
/// its ceiling (`Bound`). A `start` outside it finds nothing. `None` walks
/// to `/`. git asked for a linked worktree's main checkout follows the
/// worktree's `.git` file to its common dir wherever that is, outside the
/// bound too, and reads that repo's config: a `rev-parse` on the runner's
/// hardened call, which turns off hooks and an fsmonitor.
///
/// `accept` is offered each registry before the walk takes it, in the
/// order the walk meets them (`CandidateKind`): `Ok(Some(token))` takes it,
/// `Ok(None)` skips it and the walk goes on as though it weren't there
/// (past a `Nearest`, to the next ancestor; past a `Link`, to the next link
/// further out, the root staying at the nearest's dir when none is taken),
/// and `Err` ends the walk with that error. The result is the last
/// candidate taken, with its token: a taken `Nearest`'s token is dropped
/// when a `Link` is taken after it. So a token can be the open file the
/// hook checked — opened without blocking, a regular file on the open
/// descriptor, its identity compared with `Candidate::file`, its trust
/// judged on the open file — and the caller then reads exactly the file it
/// checked (`ValidRegistry::parse`). Discovery doesn't judge trust.
///
/// A hook refuses with `Err` — not `Ok(None)` — a candidate it doesn't
/// trust or whose open file isn't `Candidate::file`. A skip widens: past a
/// `Nearest`, the root moves up to the next ancestor's registry; past a
/// `Link`, to a link further out, when one is the same file. `Ok(None)` is
/// for a candidate the caller means to look past.
///
/// git runs only when the nearest taken is in a linked worktree (a `.git`
/// file) and no link above it is taken, or when nothing is taken: one
/// `rev-parse` asks for the main checkout. A `.git` is a checkout's only as
/// a directory or a regular file, by `lstat` (`checkout_holding`): a
/// symlinked one makes no checkout, and no git call goes through one — git
/// runs at the checkout the walk found or at `start`, never in a dir whose
/// own `.git` is a symlink, and its own search, which passes over a `.git`
/// it can't use (an empty dir, a FIFO) and walks on up, is ceilinged below
/// the nearest symlinked `.git` above where it runs (`git_ceiling_at`).
///
/// # Errors
///
/// Only `accept`'s.
pub fn discover_registry<T, E>(
    start: &Path,
    bound: Option<&Bound>,
    git: &Git,
    accept: impl FnMut(&Candidate<'_>) -> std::result::Result<Option<T>, E>,
) -> std::result::Result<Option<(RegistryLocation, T)>, E> {
    let Ok(start) = start.canonicalize() else {
        return Ok(None);
    };
    if !in_bound(&start, bound) {
        return Ok(None);
    }
    let mut walk = Walk { bound, git, accept };
    if let Some(found) = walk.walk_up(&start)? {
        return Ok(Some(found));
    }
    match main_checkout(&start, false, git, bound) {
        Some(found) if in_bound(&found.main, bound) => walk.walk_up(&found.main),
        _ => Ok(None),
    }
}

/// One walk's bound, git runner, and hook (`discover_registry`).
struct Walk<'a, F> {
    bound: Option<&'a Bound>,
    git: &'a Git,
    accept: F,
}

impl<T, E, F> Walk<'_, F>
where
    F: FnMut(&Candidate<'_>) -> std::result::Result<Option<T>, E>,
{
    /// The first `repos.toml` in `start` or an ancestor, placed at the
    /// workspace root it belongs to, with the token of the candidate taken.
    ///
    /// A registry is often kept in one of the workspace's own repos and
    /// linked at the workspace root. Found outside any checkout, it stays
    /// where it's found. Found inside a checkout — the nearest dir at or
    /// above it with a `.git` dir or regular file, read without git and not
    /// followed (`checkout_holding`) — the root is the nearest
    /// ancestor strictly above that checkout whose `repos.toml` is the same
    /// file: the same device and inode, followed through symlinks, so a
    /// hard link counts and no path spelling matters. Nearest, so the
    /// innermost workspace wins: a stray link further out never captures
    /// it. A link inside the checkout doesn't root it (a repo isn't a
    /// workspace), a different file above it (an unrelated registry)
    /// neither roots it nor stops the search, and one that can't be read
    /// (dangling, a loop, no permission) is passed over — doubt never
    /// moves the root. With no link above, it stays where it's found, and
    /// `check_discovered_root` refuses it if that checkout is an entry's.
    ///
    /// A registry committed in its repo has a copy in each linked worktree,
    /// found first from inside one and linked nowhere. So when no link
    /// above a linked worktree names its copy, the search runs from the
    /// same place in the repo's main checkout (`linked_from_main_checkout`):
    /// a link above the main checkout to its copy roots the workspace,
    /// which then reads that copy, not the worktree's.
    ///
    /// Every dir looked at is inside the bound, and every registry taken
    /// was accepted (`discover_registry`).
    fn walk_up(&mut self, start: &Path) -> std::result::Result<Option<(RegistryLocation, T)>, E> {
        let bound = self.bound;
        for dir in start.ancestors().take_while(|d| in_bound(d, bound)) {
            let path = dir.join(REGISTRY_FILE);
            // `is_file`, keeping the identity it read
            let Some(file) = std::fs::metadata(&path)
                .ok()
                .filter(std::fs::Metadata::is_file)
                .map(|m| to_file_id(&m))
            else {
                continue;
            };
            let candidate = Candidate {
                path: &path,
                dir,
                kind: CandidateKind::Nearest,
                file,
            };
            let Some(token) = (self.accept)(&candidate)? else {
                continue;
            };
            let linked = match checkout_holding(dir, bound) {
                Some((top, linked)) => match self.nearest_link_above(top, file)? {
                    Some(found) => Some(found),
                    None if linked => self.linked_from_main_checkout(top, dir)?,
                    None => None,
                },
                None => None,
            };
            let (root, token) = linked.unwrap_or_else(|| (dir.to_owned(), token));
            return Ok(Some((
                RegistryLocation {
                    path: root.join(REGISTRY_FILE),
                    root,
                    discovered: true,
                },
                token,
            )));
        }
        Ok(None)
    }

    /// The nearest accepted ancestor strictly above `top`, inside the
    /// bound, whose `repos.toml` is the file `id`, with its token.
    fn nearest_link_above(
        &mut self,
        top: &Path,
        id: FileId,
    ) -> std::result::Result<Option<(PathBuf, T)>, E> {
        let bound = self.bound;
        for dir in top.ancestors().skip(1).take_while(|d| in_bound(d, bound)) {
            let path = dir.join(REGISTRY_FILE);
            if file_id(&path) != Some(id) {
                continue;
            }
            let candidate = Candidate {
                path: &path,
                dir,
                kind: CandidateKind::Link,
                file: id,
            };
            if let Some(token) = (self.accept)(&candidate)? {
                return Ok(Some((dir.to_owned(), token)));
            }
        }
        Ok(None)
    }

    /// When `dir` is in the linked worktree `top` (`checkout_holding`): the
    /// nearest link above the repo's main checkout to the `repos.toml`
    /// there at `dir`'s relative path (`nearest_link_above`), with its
    /// token, or `None` — and `None` for a main checkout outside the bound,
    /// whose copy isn't read. `dir` is physical (`discover_registry`), as
    /// git's paths are.
    ///
    /// git runs in `top`, whose `.git` is the regular file the walk read,
    /// not in `dir`: a symlinked `.git` between them, passed over by the
    /// walk, would be followed by git's own discovery.
    fn linked_from_main_checkout(
        &mut self,
        top: &Path,
        dir: &Path,
    ) -> std::result::Result<Option<(PathBuf, T)>, E> {
        let Some(found) = main_checkout(top, true, self.git, self.bound) else {
            return Ok(None);
        };
        let Some(relative) = found
            .toplevel
            .as_deref()
            .and_then(|t| dir.strip_prefix(t).ok())
        else {
            return Ok(None);
        };
        if !in_bound(&found.main, self.bound) {
            return Ok(None);
        }
        match file_id(&found.main.join(relative).join(REGISTRY_FILE)) {
            Some(id) => self.nearest_link_above(&found.main, id),
            None => Ok(None),
        }
    }
}

/// The checkout holding `dir`, read without git: the nearest dir at or
/// above it, inside `bound`, with a `.git` that is a directory or a
/// regular file by `lstat`, and whether that `.git` is a file, as a linked
/// worktree's is. `None` outside any checkout.
///
/// Not followed: a symlink named `.git` makes no checkout, whatever it
/// points at, nor does any other kind of file or one that can't be read —
/// each is passed over for a checkout further up. So a link can't send the
/// walk, or the git calls a checkout gets, to a git dir elsewhere.
fn checkout_holding<'d>(dir: &'d Path, bound: Option<&Bound>) -> Option<(&'d Path, bool)> {
    dir.ancestors()
        .take_while(|a| in_bound(a, bound))
        .find_map(|a| {
            std::fs::symlink_metadata(a.join(".git"))
                .ok()
                .filter(|m| m.is_dir() || m.is_file())
                .map(|m| (a, m.is_file()))
        })
}

/// Whether `dir/.git` is a symlink, by `lstat`.
fn git_is_symlink(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok_and(|m| m.is_symlink())
}

/// Where a git call run in a dir may look for its repo (`git_ceiling_at`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitReach<'p> {
    /// Run, with this ceiling (`GIT_CEILING_DIRECTORIES`), if any.
    Ceiling(Option<&'p Path>),
    /// Don't run: git would reach a symlinked `.git` no ceiling can hide.
    Refused,
}

/// The ceiling a git call run in `cwd` needs so its own discovery never
/// reaches a symlinked `.git`, which it would follow: the nearest ancestor
/// strictly above `cwd`, inside `bound`, whose `.git` is a symlink, else
/// the bound's ceiling (`Bound::git_ceiling`). git passes over a `.git` it
/// can't use (an empty or unreadable dir, a FIFO) and walks on up, so a
/// symlink above one is in its reach; the ceiling stops it below the
/// symlink's dir.
///
/// `Refused` when `cwd`'s own `.git` is a symlink (git reads `cwd` before
/// any ceiling applies), or the ceiling dir holds a `:`, which
/// `GIT_CEILING_DIRECTORIES` reads as a separator and has no escape for.
fn git_ceiling_at<'p>(cwd: &'p Path, bound: Option<&'p Bound>) -> GitReach<'p> {
    use std::os::unix::ffi::OsStrExt as _;
    if git_is_symlink(cwd) {
        return GitReach::Refused;
    }
    let Some(link) = cwd
        .ancestors()
        .skip(1)
        .take_while(|a| in_bound(a, bound))
        .find(|a| git_is_symlink(a))
    else {
        return GitReach::Ceiling(bound.and_then(Bound::git_ceiling));
    };
    if link.as_os_str().as_bytes().contains(&b':') {
        return GitReach::Refused;
    }
    GitReach::Ceiling(Some(link))
}

/// `root/.git`, when it is a symlink by `lstat` — where git, run at
/// `root`, would follow it to a git dir elsewhere (`check_discovered_root`).
/// Only the root's own `.git`: one further up is `linked_past_git_symlink`'s.
fn root_git_symlink(root: &Path) -> Option<PathBuf> {
    let git = root.join(".git");
    git_is_symlink(root).then_some(git)
}

/// The nearest `.git` strictly above `loc.root`, inside `bound`, when it is
/// a symlink by `lstat` and a `repos.toml` above its repo, inside `bound`,
/// is the registry's file (`file_id`): the symlink and that link, as
/// `(git, link)`. The nearest `.git` that is a dir, a regular file, or a
/// symlink — the kinds discovery reads — so a checkout's (which discovery
/// would have walked past to the link) ends the search, and a FIFO or
/// other special file, which discovery skips, doesn't.
///
/// The case the root's own `.git` (`root_git_symlink`) misses: a registry
/// below a repo's top, linked above the repo, roots at its own dir when the
/// repo's `.git` is a symlink — discovery sees no checkout, so the walk
/// never reaches the link (`check_discovered_root`).
fn linked_past_git_symlink(
    loc: &RegistryLocation,
    bound: Option<&Bound>,
) -> Option<(PathBuf, PathBuf)> {
    let id = file_id(&loc.path)?;
    let repo = loc
        .root
        .ancestors()
        .skip(1)
        .take_while(|a| in_bound(a, bound))
        .find(|a| {
            std::fs::symlink_metadata(a.join(".git"))
                .is_ok_and(|m| m.is_dir() || m.is_file() || m.is_symlink())
        })?;
    if !git_is_symlink(repo) {
        return None;
    }
    let link = repo
        .ancestors()
        .skip(1)
        .take_while(|a| in_bound(a, bound))
        .map(|a| a.join(REGISTRY_FILE))
        .find(|p| file_id(p) == Some(id))?;
    Some((repo.join(".git"), link))
}

/// The identity of the file at `path`, through symlinks, or `None` on any
/// error.
fn file_id(path: &Path) -> Option<FileId> {
    std::fs::metadata(path).ok().map(|m| to_file_id(&m))
}

/// The identity `m` reads.
fn to_file_id(m: &std::fs::Metadata) -> FileId {
    use std::os::unix::fs::MetadataExt as _;
    FileId {
        dev: m.dev(),
        ino: m.ino(),
    }
}

/// A linked worktree's repo, as `main_checkout` finds it.
struct MainCheckout {
    main: PathBuf,
    /// The linked worktree's top level, when asked for.
    toplevel: Option<PathBuf>,
}

/// The main checkout of the linked worktree `cwd` is in, and with
/// `toplevel` the worktree's top level, or `None` when `cwd` isn't in a
/// linked worktree, or on any git failure (the caller reports the registry
/// missing, or keeps it where it was found) — `toplevel` fails in a git
/// dir.
///
/// A linked worktree's git dir differs from its common dir; anywhere else
/// they're the same dir — a main checkout, a submodule, or a checkout whose
/// git dir lives elsewhere (`--separate-git-dir`), where the common dir's
/// parent is no checkout at all and must not be searched. The main checkout
/// is the common dir's parent only when the common dir is named `.git`: one
/// kept elsewhere (a linked worktree of a `--separate-git-dir` repo) says
/// nothing of where its main checkout is, unless it's named `.git` — then
/// its parent is taken as the main checkout, as `git worktree list` does.
///
/// No ceiling at the cwd: git's discovery walks up from `cwd` to the
/// worktree (the cwd may be deep inside it), which that would cut short.
/// Its ceiling is the nearest symlinked `.git` above `cwd`, else the
/// caller's `bound` (`git_ceiling_at`), and it doesn't run when `cwd`'s own
/// `.git` is a symlink.
fn main_checkout(
    cwd: &Path,
    toplevel: bool,
    git: &Git,
    bound: Option<&Bound>,
) -> Option<MainCheckout> {
    let mut args = vec![
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
    ];
    if toplevel {
        args.push("--show-toplevel");
    }
    let GitReach::Ceiling(ceiling) = git_ceiling_at(cwd, bound) else {
        return None;
    };
    let opts = CallOptions {
        ceiling,
        ..CallOptions::default()
    };
    let out = git.output_string(cwd, &args, opts).ok()?;
    let mut lines = out.lines();
    let (git_dir, common) = (Path::new(lines.next()?), Path::new(lines.next()?));
    if git_dir == common || common.file_name()? != ".git" {
        return None;
    }
    let toplevel = if toplevel {
        Some(PathBuf::from(lines.next()?))
    } else {
        None
    };
    Some(MainCheckout {
        main: common.parent()?.to_owned(),
        toplevel,
    })
}

/// Refuses a discovered root (`RegistryLocation::discovered`) whose own
/// `.git` is a symlink (`root_git_symlink`), or that is at or inside a
/// checkout of one of the registry's own entries (`entry_holding_root`,
/// unbounded).
///
/// A symlinked `.git` makes no checkout to discovery (`checkout_holding`),
/// so a registry kept at the top of a repo whose `.git` is one roots the
/// workspace there, links above it or not — and git, run there, would
/// follow the link, so whose checkout it is goes unread. A symlinked one
/// further up (a dotfiles repo's at `$HOME`, or the repo's when the
/// registry sits in a subdirectory of it) is passed over, and
/// `entry_holding_root` passes over it — unless a link above that repo
/// names the registry (`linked_past_git_symlink`), which the walk would
/// have rooted at but for the symlink, so it's refused too. Left running:
/// a registry not linked above that repo (unlinked, or linked only from
/// inside it) in a subdirectory of such a repo, which a sync
/// clones into — without git through the symlink, no different from a
/// workspace under a dotfiles `$HOME`. An entry's
/// checkout is the registry's repo cloned with no link at the workspace
/// root yet, a symlinked entry dir walked physically, a worktree whose own
/// copy of the registry won because the main checkout's is gone, or a bare
/// repo's worktree. Rooted in either, every other entry would read as
/// missing, and a sync would clone them into it.
///
/// # Errors
///
/// `RootGitSymlink` naming the symlink (and the link, when it's further
/// up), read first and without git; then
/// `RootInEntry` naming the first such entry, in registry order.
fn check_discovered_root(loc: &RegistryLocation, entries: &[Entry], git: &Git) -> Result<()> {
    if !loc.discovered {
        return Ok(());
    }
    // unbounded, as `find_registry`, which found it, is
    let bound = None;
    if let Some(link) = root_git_symlink(&loc.root) {
        return Err(Error::RootGitSymlink {
            root: loc.root.clone(),
            registry: loc.path.clone(),
            git: link,
            linked: None,
        });
    }
    if let Some((link, linked)) = linked_past_git_symlink(loc, bound) {
        return Err(Error::RootGitSymlink {
            root: loc.root.clone(),
            registry: loc.path.clone(),
            git: link,
            linked: Some(linked),
        });
    }
    entry_holding_root(&loc.root, entries, bound, git).map_or(Ok(()), |e| {
        Err(Error::RootInEntry {
            root: loc.root.clone(),
            registry: loc.path.clone(),
            key: e.key.clone(),
        })
    })
}

/// The first entry, in registry order, whose checkout holds `root`: the
/// case `repos` refuses as `RootInEntry` for a root it discovered
/// (`check_discovered_root`), with `entries` the registry found there.
///
/// `root` is read canonicalized, as the bound is (`None` when it can't
/// be). Read without git unless it is in a checkout (`checkout_holding`:
/// the nearest `.git` dir or regular file at or above it, a symlinked one
/// passed over, inside `bound` — a caller passes the bound it discovered
/// with, so a checkout the walk didn't see, like a dotfiles repo at
/// `$HOME`, isn't read here either); then git reads that checkout's
/// `origin` URLs, run there — not at `root`, whose own `.git` may be a
/// symlink passed over — under the ceiling `git_ceiling_at` gives (the
/// nearest symlinked `.git` above the checkout, else the bound's), both
/// as configured (`config
/// --get-all remote.origin.url`) and as git resolves them (`remote get-url
/// --all`: `insteadOf` applied, worktree config honored), and any of
/// either naming an entry as `origin_matches` reads an origin — owned and
/// third-party entries alike — names it. Both, since a rewrite can hide
/// the repo either way: an alias (`gh:o/meta`) names it only once
/// resolved, and a rewrite to a mirror or a local path only as configured.
/// The resolved read is skipped when the configured one matches. A
/// checkout of no entry (a dotfiles repo further out, a workspace that is
/// itself an unlisted repo) is `None`, as is any git failure: this is a
/// backstop, not the rule.
pub fn entry_holding_root<'e>(
    root: &Path,
    entries: &'e [Entry],
    bound: Option<&Bound>,
    git: &Git,
) -> Option<&'e Entry> {
    let root = root.canonicalize().ok()?;
    let (top, _) = checkout_holding(&root, bound)?;
    let GitReach::Ceiling(ceiling) = git_ceiling_at(top, bound) else {
        return None;
    };
    let opts = CallOptions {
        ceiling,
        ..CallOptions::default()
    };
    // the first entry, in registry order, one of the URLs git prints names
    let named = |args: &[&str]| {
        let out = git.output_string(top, args, opts).ok()?;
        entries
            .iter()
            .find(|e| out.lines().any(|origin| origin_matches(origin, &e.url)))
    };
    named(&["config", "--get-all", "remote.origin.url"])
        .or_else(|| named(&["remote", "get-url", "--all", "origin"]))
}

/// Selects the entries `targets` name, in registry order.
///
/// No targets selects every entry. A target is a registry key, else an
/// entry's dir name, else a path (relative to `cwd`) inside a checkout —
/// the entry whose own checkout it is, else resolved through its git common
/// dir, so a linked worktree outside the workspace resolves too
/// (`entry_of_repo`).
///
/// # Errors
///
/// `UnknownEntry` for a target that matches nothing; `GitNotFound` when a
/// path target can't be resolved for lack of git.
pub fn resolve_targets(
    entries: &[Entry],
    root: &Path,
    cwd: &Path,
    targets: &[String],
    git: &Git,
) -> Result<Vec<Entry>> {
    if targets.is_empty() {
        return Ok(entries.to_vec());
    }
    let mut selected = HashSet::new();
    for target in targets {
        let found = entries
            .iter()
            .position(|e| e.key == *target)
            .or_else(|| entries.iter().position(|e| e.dir == *target))
            .map_or_else(
                || resolve_path(entries, root, &cwd.join(target), git),
                |i| Ok(Some(i)),
            )?;
        let Some(i) = found else {
            return Err(Error::UnknownEntry {
                name: target.clone(),
                suggestions: suggest_keys(entries, target),
            });
        };
        selected.insert(i);
    }
    Ok(entries
        .iter()
        .enumerate()
        .filter(|(i, _)| selected.contains(i))
        .map(|(_, e)| e.clone())
        .collect())
}

/// How many close keys an unknown target suggests.
const MAX_SUGGESTIONS: usize = 3;

/// The registry keys close to `target`, best first. An entry is close when
/// its key or its dir name — both are targets — is within a small edit
/// distance of the target (a third of the longer name's length, at least one
/// edit), or one contains the other (at least three chars), compared
/// case-insensitively; it ranks by the closer of the two, then by key, and is
/// suggested by its key. A path-shaped target is compared by its last
/// component.
fn suggest_keys(entries: &[Entry], target: &str) -> Vec<String> {
    let name = Path::new(target)
        .components()
        .next_back()
        .and_then(|c| match c {
            std::path::Component::Normal(n) => n.to_str(),
            _ => None,
        })
        .unwrap_or("")
        .to_lowercase();
    if name.is_empty() {
        return Vec::new();
    }
    // the distance to `candidate` when it's close, else `None`
    let score = |candidate: &str| {
        let candidate = candidate.to_lowercase();
        let distance = edit_distance(&name, &candidate);
        let longer = name.chars().count().max(candidate.chars().count());
        let near = distance <= (longer / 3).max(1);
        let contains =
            |outer: &str, inner: &str| inner.chars().count() >= 3 && outer.contains(inner);
        (near || contains(&candidate, &name) || contains(&name, &candidate)).then_some(distance)
    };
    let mut close: Vec<(usize, &str)> = entries
        .iter()
        .filter_map(|e| {
            let distance = [score(&e.key), score(&e.dir)].into_iter().flatten().min()?;
            Some((distance, e.key.as_str()))
        })
        .collect();
    close.sort_unstable();
    // a key in both tables (which validation rejects) is suggested once
    close.dedup_by(|a, b| a.1 == b.1);
    close
        .into_iter()
        .take(MAX_SUGGESTIONS)
        .map(|(_, key)| key.to_owned())
        .collect()
}

/// The optimal-string-alignment distance: insertions, deletions,
/// substitutions, and transpositions of adjacent chars, each one edit.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    // three rows: two back, one back, current
    let mut prev2 = vec![0; b.len() + 1];
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for i in 1..=a.len() {
        cur[0] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut d = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d = d.min(prev2[j - 2] + 1);
            }
            cur[j] = d;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// A path resolved down to the checkout holding it (`resolve_checkout`).
#[derive(Debug, Clone)]
pub struct PathTarget {
    /// The entry the path names, as a path target names it.
    pub entry: Entry,
    /// The top level of the checkout holding the path, as git finds it
    /// from there: a linked worktree's own, not the entry's dir.
    pub checkout: PathBuf,
}

/// The entry whose checkout holds `path`, and that checkout's top level.
///
/// The entry is resolved as a path target's is (`entry_of_repo`: an
/// entry's own checkout, else through its git common dir, so a linked
/// worktree outside the workspace resolves too). `None` when `path` is in
/// no entry's checkout — at the workspace root, in an unregistered clone,
/// outside the workspace, or where git finds no work tree (inside a git
/// dir).
///
/// # Errors
///
/// `GitNotFound` when `path` can't be resolved for lack of git.
pub fn resolve_checkout(
    entries: &[Entry],
    root: &Path,
    path: &Path,
    git: &Git,
) -> Result<Option<PathTarget>> {
    let Some(out) = rev_parse(
        path,
        &["--git-dir", "--git-common-dir", "--show-toplevel"],
        git,
    )?
    else {
        return Ok(None);
    };
    let mut lines = out.lines();
    let (Some(git_dir), Some(common), Some(toplevel)) = (lines.next(), lines.next(), lines.next())
    else {
        return Ok(None);
    };
    let toplevel = Path::new(toplevel);
    let git_dir = Path::new(git_dir);
    // a work tree elsewhere (`core.worktree`) is another checkout's files:
    // no entry's checkout to name
    if !owns_git_dir(toplevel, git_dir) {
        return Ok(None);
    }
    let dirs = RepoDirs {
        git_dir,
        common: Path::new(common),
        toplevel: Some(toplevel),
    };
    Ok(entry_of_repo(entries, root, &dirs).map(|i| PathTarget {
        entry: entries[i].clone(),
        checkout: toplevel.to_owned(),
    }))
}

/// Resolves `repos push`'s targets to the checkouts they name, in the order
/// given, each checkout once.
///
/// No targets names the checkout holding `cwd` (`resolve_checkout`). A
/// target that's a registry key or an entry's dir name names that entry's
/// dir, its primary checkout; else it's a path (relative to `cwd`) naming
/// the checkout holding it — a linked worktree's own, wherever it is.
///
/// # Errors
///
/// `NoCheckout` without targets when `cwd` is in no entry's checkout;
/// `UnknownEntry` for a target that names nothing; `GitNotFound` when a
/// path can't be resolved for lack of git.
pub fn resolve_push_targets(
    entries: &[Entry],
    root: &Path,
    cwd: &Path,
    targets: &[String],
    git: &Git,
) -> Result<Vec<PathTarget>> {
    if targets.is_empty() {
        return resolve_checkout(entries, root, cwd, git)?
            .map(|t| vec![t])
            .ok_or_else(|| Error::NoCheckout {
                path: cwd.to_path_buf(),
            });
    }
    let mut resolved: Vec<PathTarget> = Vec::with_capacity(targets.len());
    for target in targets {
        let named = entries
            .iter()
            .find(|e| e.key == *target)
            .or_else(|| entries.iter().find(|e| e.dir == *target));
        let found = match named {
            Some(e) => PathTarget {
                entry: e.clone(),
                checkout: root.join(&e.dir),
            },
            None => resolve_checkout(entries, root, &cwd.join(target), git)?.ok_or_else(|| {
                Error::UnknownEntry {
                    name: target.clone(),
                    suggestions: suggest_keys(entries, target),
                }
            })?,
        };
        // the same checkout named twice, by a key and a path, say
        let seen = resolved.iter().any(|t| {
            t.entry.key == found.entry.key
                && (t.checkout == found.checkout || same_canonical(&t.checkout, &found.checkout))
        });
        if !seen {
            resolved.push(found);
        }
    }
    Ok(resolved)
}

/// The entry whose checkout holds `path` (`entry_of_repo`). Inside a git
/// dir, where `--show-toplevel` fails, it's found without a top level.
fn resolve_path(entries: &[Entry], root: &Path, path: &Path, git: &Git) -> Result<Option<usize>> {
    let out = match rev_parse(
        path,
        &["--git-dir", "--git-common-dir", "--show-toplevel"],
        git,
    )? {
        Some(out) => out,
        None => match rev_parse(path, &["--git-dir", "--git-common-dir"], git)? {
            Some(out) => out,
            None => return Ok(None),
        },
    };
    let mut lines = out.lines();
    let (Some(git_dir), Some(common)) = (lines.next(), lines.next()) else {
        return Ok(None);
    };
    let dirs = RepoDirs {
        git_dir: Path::new(git_dir),
        common: Path::new(common),
        toplevel: lines.next().map(Path::new),
    };
    Ok(entry_of_repo(entries, root, &dirs))
}

/// `git rev-parse --path-format=absolute` with `args`, run in `path`: its
/// stdout, or `None` when `path` doesn't exist or git fails there.
fn rev_parse(path: &Path, args: &[&str], git: &Git) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let args: Vec<&str> = ["rev-parse", "--path-format=absolute"]
        .into_iter()
        .chain(args.iter().copied())
        .collect();
    match git.output_string(path, &args, CallOptions::default()) {
        Ok(out) => Ok(Some(out)),
        Err(GitError::NotFound) => Err(Error::GitNotFound),
        Err(_) => Ok(None),
    }
}

/// Where git finds a path's repo, as `rev-parse --path-format=absolute`
/// prints it: `--git-dir`, `--git-common-dir`, and `--show-toplevel` when
/// the path has a work tree.
struct RepoDirs<'a> {
    git_dir: &'a Path,
    common: &'a Path,
    toplevel: Option<&'a Path>,
}

/// The entry `dirs` names, compared canonicalized: the first entry whose
/// dir is the checkout's top level, when that checkout's `.git` names the
/// path's git dir (`owns_git_dir`) — the checkout holding the path is an
/// entry's own, wherever its git dir is (`--separate-git-dir`, or a linked
/// worktree's), but a work tree a repo's `core.worktree` points at is
/// another checkout's files — else the dir holding the common dir, when
/// that's a `.git`: the main checkout of a linked worktree elsewhere, or of
/// a path inside a `.git`.
///
/// Outside the workspace, a linked worktree of a repo whose common dir
/// isn't a `.git` names no entry: of a `--separate-git-dir` repo, nothing
/// in its git dirs says where the main checkout is (git's own worktree list
/// prints the git dir in its place); of a bare repo, no entry's probe reads
/// one (it has no work tree).
fn entry_of_repo(entries: &[Entry], root: &Path, dirs: &RepoDirs<'_>) -> Option<usize> {
    let main_checkout = dirs
        .common
        .parent()
        .filter(|_| dirs.common.file_name().is_some_and(|n| n == ".git"));
    let entry_dirs: Vec<Option<PathBuf>> = entries
        .iter()
        .map(|e| root.join(&e.dir).canonicalize().ok())
        .collect();
    let own = dirs.toplevel.filter(|t| owns_git_dir(t, dirs.git_dir));
    [own, main_checkout]
        .into_iter()
        .flatten()
        .filter_map(|c| c.canonicalize().ok())
        .find_map(|repo| entry_dirs.iter().position(|d| d.as_ref() == Some(&repo)))
}

/// Whether `toplevel`'s own `.git` names `git_dir` (`dot_git_target`),
/// compared canonicalized: true of a main checkout, a linked worktree, and
/// a `--separate-git-dir` checkout; false of a work tree a repo's
/// `core.worktree` points at, whose `.git` is its own or none.
fn owns_git_dir(toplevel: &Path, git_dir: &Path) -> bool {
    let named = dot_git_target(&toplevel.join(".git")).ok();
    match (
        named.and_then(|d| d.canonicalize().ok()),
        git_dir.canonicalize(),
    ) {
        (Some(named), Ok(git_dir)) => named == git_dir,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
