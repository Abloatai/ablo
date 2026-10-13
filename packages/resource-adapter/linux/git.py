"""Validate native Git publication below the filesystem authority."""
import json
import os
import subprocess
import tempfile
import time

from store import Rejected


def git(directory, arguments, data=None):
    environment = {"PATH": "/usr/bin:/bin", "HOME": directory,
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_OPTIONAL_LOCKS": "0"}
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
                             "-C", directory, *arguments], input=data, env=environment,
                            capture_output=True, timeout=30)
    if result.returncode:
        raise Rejected("git_candidate_invalid")
    return result.stdout


def export_repository(store, directory, operation=None):
    paths = {row[0] for row in store.db.execute("SELECT path FROM files WHERE path LIKE '.git/%'")}
    if operation:
        paths.update(row[0] for row in store.db.execute("SELECT path FROM staging WHERE operation=? AND path LIKE '.git/%'", (operation,)))
    for path in sorted(paths):
        if path in (".git/commondir", ".git/gitdir", ".git/worktrees", ".git/modules") or path.startswith((".git/objects/info/", ".git/worktrees/", ".git/modules/")):
            raise Rejected("git_candidate_invalid")
        row = store.file(path, operation)
        if not row:
            continue
        if row["kind"] == "symlink":
            raise Rejected("git_candidate_invalid")
        target = os.path.join(directory, path)
        if row["kind"] == "directory":
            os.makedirs(target, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as output:
                output.write(row["content"])
    # Worker-authored Git configuration must never execute under supervisor authority.
    with open(os.path.join(directory, ".git/config"), "w") as output:
        output.write("[core]\nrepositoryformatversion = 0\nbare = false\n")


def refs(directory):
    return dict(line.split(" ", 1) for line in
                git(directory, ["for-each-ref", "--format=%(refname) %(objectname)"]).decode().splitlines())


def head(directory):
    try:
        return git(directory, ["rev-parse", "--verify", "HEAD"]).decode().strip()
    except Rejected:
        return None


def initialize_refs(store):
    dotgit = store.file(".git")
    if dotgit and dotgit["kind"] != "directory":
        raise Rejected("git_candidate_invalid")
    if store.meta("git_initialized") is None and store.file(".git/HEAD"):
        with tempfile.TemporaryDirectory(prefix="ablo-git-") as directory:
            export_repository(store, directory)
            values = {**refs(directory), "HEAD": head(directory)}
            for name, content in values.items():
                store.db.execute("INSERT INTO refs VALUES (?,?,1)", (name, content))
            store.db.execute("INSERT INTO meta VALUES ('git_initialized','1')")


def validate_git_publication(store, operation):
    changed = [row[0] for row in store.db.execute("SELECT path FROM staging WHERE operation=?", (operation,))]
    if not any(path.startswith(".git/") for path in changed):
        return {}
    row, request = store.validate(operation)
    claims = {claim["resource"]: claim["claim"] for claim in request["claims"]}
    with tempfile.TemporaryDirectory(prefix="ablo-git-") as before, tempfile.TemporaryDirectory(prefix="ablo-git-") as after:
        export_repository(store, before)
        export_repository(store, after, operation)
        git(after, ["fsck", "--no-reflogs", "--no-progress", "--no-dangling"])
        previous, candidate = refs(before), refs(after)
        updates = {name: candidate.get(name) for name in previous.keys() | candidate.keys() if previous.get(name) != candidate.get(name)}
        if head(before) != head(after):
            updates["HEAD"] = head(after)
        affected = set()
        empty_tree = git(after, ["hash-object", "-w", "-t", "tree", "--stdin"], b"").decode().strip()
        for name in previous.keys() | candidate.keys():
            old, new = previous.get(name), candidate.get(name)
            if old == new:
                continue
            resource = "ref:" + name
            store.authorize(row["owner"], resource, claims.get(resource, "missing"))
            if new and name.startswith("refs/heads/"):
                if git(after, ["cat-file", "-t", new]).strip() != b"commit":
                    raise Rejected("git_candidate_invalid")
                if any(entry.startswith(b"160000 ") for entry in git(after, ["ls-tree", "-r", "-z", new]).split(b"\0")):
                    raise Rejected("git_candidate_invalid")
            paths = git(after, ["diff-tree", "--no-commit-id", "--no-ext-diff", "--no-textconv",
                                "--no-renames", "--name-only", "-r", "-z", old or empty_tree, new or empty_tree])
            affected.update(path.decode() for path in paths.split(b"\0") if path)
        if head(before) != head(after):
            paths = git(after, ["diff-tree", "--no-commit-id", "--no-ext-diff", "--no-textconv",
                                "--no-renames", "--name-only", "-r", "-z", head(before) or empty_tree, head(after) or empty_tree])
            affected.update(path.decode() for path in paths.split(b"\0") if path)
        for name in updates:
            active = store.db.execute("SELECT * FROM leases WHERE resource=? AND active=1 AND expires>?", ("ref:" + name, time.time())).fetchone()
            if active and (active["owner"] != row["owner"] or claims.get("ref:" + name) != active["claim"]):
                raise Rejected("claim_conflict", ["ref:" + name])
        old_head, new_head = store.file(".git/HEAD"), store.file(".git/HEAD", operation)
        if old_head["content"] != new_head["content"]:
            store.authorize(row["owner"], "ref:HEAD", claims.get("ref:HEAD", "missing"))
        # Ref admission and affected-file ownership share the publication lock.
        for path in affected | {path for path in changed if not path.startswith(".git/")}:
            active = store.db.execute("SELECT * FROM leases WHERE resource=? AND active=1 AND expires>?",
                                      ("file:" + path, time.time())).fetchone()
            if active and (active["owner"] != row["owner"] or claims.get("file:" + path) != active["claim"]):
                raise Rejected("claim_conflict", [path])
        return updates
