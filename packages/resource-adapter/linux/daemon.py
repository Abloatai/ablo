"""Managed Linux adapter entry point; Unix peer credentials identify workers."""
import argparse
import json
import os
import signal
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time

from fusepy import FUSE
from filesystem import Filesystem
from commands import CommandServer
from git import initialize_refs, validate_git_publication
from store import Rejected, Store, canonical, path_name
from process import ProcessChannel, Profile, HOME, await_domain_exit


def resource_path(resource):
    if not isinstance(resource, str) or ":" not in resource:
        raise Rejected("invalid_resource")
    kind, name = resource.split(":", 1)
    path_name(name)
    if kind == "file" and name != ".git" and not name.startswith(".git/"):
        return name
    if kind == "ref" and (name == "HEAD" or name.startswith("refs/")):
        checked = subprocess.run(["git", "check-ref-format", name], capture_output=True) if name != "HEAD" else None
        if checked is None or checked.returncode == 0:
            return ".git/" + name
    raise Rejected("invalid_resource")


class Adapter:
    def __init__(self, store, workers, gateway, mountpoint, mount_tag):
        self.store, self.workers, self.gateway, self.mountpoint = store, workers, gateway, mountpoint
        self.mount_tag = mount_tag

    def upstream(self, owner, action, **fields):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(35)
            connection.connect(self.gateway)
            connection.sendall(canonical({"owner": owner, "action": action, **fields}).encode() + b"\n")
            raw = connection.makefile().readline(1024 * 1024)
            reply = json.loads(raw)
            if "error" in reply:
                raise Rejected(reply["error"]["code"])
            return reply["result"]

    def worker(self, peer, request):
        uid = request.get("workerUid", peer) if peer == 0 else peer
        if peer != 0 and "workerUid" in request:
            raise Rejected("permission_denied")
        if uid not in self.workers:
            raise Rejected("permission_denied")
        if "authority" in request:
            authority = request.pop("authority")
            scope = json.dumps([authority["organizationId"], authority["projectId"], authority["branchId"]], separators=(",", ":"), ensure_ascii=False)
            owner = [scope, authority["participantId"], authority["participantKind"], sorted(authority["syncGroups"]), sorted(authority["operations"])]
            if owner != json.loads(self.workers[uid]):
                raise Rejected("permission_denied")
        return self.workers[uid]

    def execute(self, owner, request, channel=None):
        try:
            return self._execute(owner, request, channel)
        finally:
            # Publication's transaction has exited, even if the caller loses its reply.
            if request.get("action") in ("write", "delete", "rename", "run"):
                with self.store.changed:
                    self.store.changed.notify_all()

    def _execute(self, owner, request, channel=None):
        action = request.get("action")
        if action == "ready":
            return {"ready": os.path.ismount(self.mountpoint)}
        if action in ("claim", "claim_install"):
            resource = request["resource"]
            if action == "claim":
                resource_path(resource)
                grant = self.upstream(owner, "claim", resource=resource, ttl=request.get("ttl", "30s"))
            else:
                grant = request["grant"]
            try:
                if action == "claim_install":
                    resource_path(resource)
                with self.store.lock, self.store.db:
                    return self.store.install(owner, resource, grant)
            except Exception:
                self.upstream(owner, "release", resource=resource, claim=grant["claim"])
                raise
        if action == "heartbeat":
            resource = request["resource"]
            with self.store.lock:
                self.store.authorize(owner, resource, request["claim"])
            try:
                beat = self.upstream(owner, "heartbeat", resource=resource, claim=request["claim"], ttl=request.get("ttl", "30s"))
            except Exception:
                with self.store.lock, self.store.db:
                    self.store.db.execute("UPDATE leases SET active=0 WHERE owner=? AND resource=? AND claim=?",
                                          (owner, resource, request["claim"]))
                raise
            with self.store.lock, self.store.db:
                self.store.authorize(owner, resource, request["claim"])
                self.store.renew(resource, beat["expires"])
            return beat
        if action == "release":
            with self.store.lock, self.store.db:
                self.store.db.execute("UPDATE leases SET active=0 WHERE owner=? AND resource=? AND claim=?",
                                      (owner, request["resource"], request["claim"]))
            return self.upstream(owner, "release", resource=request["resource"], claim=request["claim"])
        if action == "receipt":
            with self.store.lock:
                row = self.store.db.execute("SELECT * FROM operations WHERE id=? AND owner=?", (request["operationId"], owner)).fetchone()
                return json.loads(row["receipt"]) if row and row["receipt"] else {"operationId": request["operationId"], "status": "running" if row else "absent"}
        if action == "read":
            path = resource_path(request["resource"])
            with self.store.lock:
                if request["resource"].startswith("ref:"):
                    name = request["resource"].split(":", 1)[1]
                    ref = self.store.db.execute("SELECT * FROM refs WHERE name=?", (name,)).fetchone()
                    return {"resource": request["resource"], "content": ref["content"] if ref else None,
                            "revision": self.store.revision(name, "ref"), "evidence": self.store.evidence(owner, name, "ref")}
                row = self.store.file(path)
                if row and row["kind"] != "file":
                    raise Rejected("unsupported_file_type")
                try:
                    content = row["content"].decode() if row else None
                except UnicodeDecodeError:
                    raise Rejected("text_read_required") from None
                return {"resource": request["resource"], "content": content,
                        "revision": self.store.revision(path), "evidence": self.store.evidence(owner, path)}
        if action == "change_cursor":
            with self.store.lock:
                return {"cursor": self.store.db.execute("SELECT COALESCE(MAX(sequence),0) FROM events").fetchone()[0]}
        if action == "await_changes":
            after = request.get("after", 0)
            if not isinstance(after, int) or after < 0:
                raise Rejected("cursor_invalid")
            with self.store.changed:
                self.store.changed.wait_for(lambda: self.store.db.execute("SELECT COALESCE(MAX(sequence),0) FROM events").fetchone()[0] > after)
            request = {**request, "action": "changes"}
            action = "changes"
        if action == "changes":
            with self.store.lock:
                after = request.get("after", 0)
                if not isinstance(after, int) or after < 0:
                    raise Rejected("cursor_invalid")
                events = [dict(row) for row in self.store.db.execute("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 100", (after,))]
                stale = []
                for read in request.get("reads", []):
                    payload = self.store.decode_evidence(owner, read["evidence"])
                    if read["resource"] != payload["kind"] + ":" + payload["path"]:
                        raise Rejected("read_evidence_invalid")
                    if self.store.revision(payload["path"], payload["kind"]) != payload["revision"]:
                        stale.append({"resource": read["resource"], "action": "reread"})
                return {"events": events, "cursor": events[-1]["sequence"] if events else after, "stale": stale}
        if action not in ("write", "delete", "rename", "run"):
            raise Rejected("operation_invalid")
        if not isinstance(request.get("claims"), list) or (action != "run" and not request["claims"]):
            raise Rejected("claim_required")
        for claim in request["claims"]:
            resource_path(claim["resource"])
        with self.store.lock, self.store.db:
            try:
                operation, fresh = self.store.start(owner, request)
            except Rejected as error:
                row = self.store.db.execute("SELECT * FROM operations WHERE id=? AND owner=?", (request.get("operationId"), owner)).fetchone()
                if row and row["status"] == "running" and row["intent"] == canonical(request) and error.code in ("stale_context", "claim_lost", "read_evidence_conflict"):
                    return self.store.finish(row["id"], "rejected", {"code": error.code, "resources": error.resources})
                raise
            if not fresh:
                return json.loads(operation["receipt"]) if operation["receipt"] else {"operationId": operation["id"], "status": "running"}
        identifier = operation["id"]
        try:
            if action == "run":
                detail = self.run(operation, request, channel)
            else:
                with self.store.lock, self.store.db:
                    path = resource_path(request["resource"])
                    if request["resource"].startswith("ref:"):
                        raise Rejected("native_git_required")
                    dependencies = {row[0] for row in self.store.db.execute("SELECT path FROM dependencies WHERE operation=?", (identifier,))}
                    if path not in dependencies:
                        raise Rejected("read_required", [path])
                    self.store.authorize(owner, request["resource"], next((claim["claim"] for claim in request["claims"] if claim["resource"] == request["resource"]), "missing"))
                    original = self.store.file(path)
                    if action == "write":
                        if not isinstance(request.get("content"), str):
                            raise Rejected("content_invalid")
                        parent = self.store.file(os.path.dirname(path))
                        if not parent or parent["kind"] != "directory":
                            raise Rejected("parent_missing")
                        self.store.stage(identifier, path, "file", request["content"].encode(), original["mode"] if original else 0o644)
                    else:
                        if not original or original["kind"] != "file":
                            raise Rejected("resource_missing")
                        if action == "rename":
                            destination = resource_path(request["destination"])
                            if request["destination"].startswith("ref:") or destination not in dependencies:
                                raise Rejected("read_required", [destination])
                            self.store.authorize(owner, request["destination"], next((claim["claim"] for claim in request["claims"] if claim["resource"] == request["destination"]), "missing"))
                            self.store.stage(identifier, destination, "file", original["content"], original["mode"])
                        self.store.stage(identifier, path, "deleted", None, 0)
                    detail = {}
            with self.store.lock, self.store.db:
                self.store.validate(identifier)
                if detail.get("exitCode", 0):
                    return self.store.finish(identifier, "rejected", {"code": "command_failed", "resources": [], **detail})
                refs = validate_git_publication(self.store, identifier)
                return self.store.publish(identifier, detail, refs)
        except Rejected as error:
            with self.store.lock, self.store.db:
                return self.store.finish(identifier, "rejected", {"code": error.code, "resources": error.resources})
        except Exception:
            with self.store.lock, self.store.db:
                self.store.finish(identifier, "aborted", {"code": "operation_failed"})
            raise

    def run(self, operation, request, channel=None):
        if not os.path.ismount(self.mountpoint):
            raise Rejected("adapter_unavailable")
        argv, timeout = request.get("argv"), request.get("timeoutMs", 30000)
        if (not isinstance(argv, list) or not argv or not all(isinstance(arg, str) and "\0" not in arg for arg in argv)
                or not isinstance(timeout, int) or not 1 <= timeout <= 300000):
            raise Rejected("command_invalid")
        supplied = request.get("env", {})
        if not isinstance(supplied, dict) or not all(isinstance(k, str) and isinstance(v, str) and "\0" not in k + v and "=" not in k for k, v in supplied.items()):
            raise Rejected("environment_invalid")
        if request.get("interactive") and channel is None:
            raise Rejected("permission_denied")
        if channel and any(key in supplied for key in ("HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR")):
            raise Rejected("profile_environment_invalid")
        with self.store.lock:
            self.store.pin(operation["id"])
        uid = operation["uid"]
        private_mount = os.path.join(self.store.directory, "mounts", operation["id"])
        os.makedirs(private_mount, mode=0o700, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="ablo-worker-") as home:
            mount_failure = []
            def mount_operation():
                try:
                    FUSE(Filesystem(self.store, self.workers, operation), private_mount,
                         foreground=True, allow_other=True, direct_io=True, atomic_o_trunc=True,
                         attr_timeout=0, entry_timeout=0, negative_timeout=0, fsname=self.mount_tag + ":" + operation["id"])
                except Exception as error:
                    mount_failure.append(error)
            mount_thread = threading.Thread(target=mount_operation, daemon=True)
            mount_thread.start()
            process, reader, profile = None, None, None
            threads = []
            try:
                deadline = time.monotonic() + 10
                while not os.path.ismount(private_mount):
                    if mount_failure or time.monotonic() > deadline:
                        raise Rejected("adapter_unavailable")
                    time.sleep(0.01)
                os.chown(home, uid, uid)
                profile = Profile(self.store, operation, request.get("profileId")) if channel else None
                environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": HOME if profile else home, "TMPDIR": home, **supplied}
                if profile:
                    os.makedirs(HOME, mode=0o000, exist_ok=True)
                    for child in ("codex", "claude", "tmp"):
                        path = os.path.join(profile.path, child)
                        os.makedirs(path, mode=0o700, exist_ok=True)
                        if os.path.islink(path):
                            raise Rejected("profile_corrupt")
                        os.chown(path, uid, uid)
                    environment.update(CODEX_HOME=HOME + "/codex", CLAUDE_CONFIG_DIR=HOME + "/claude",
                                       TMPDIR=HOME + "/tmp", CLAUDE_CODE_TMPDIR=HOME + "/tmp")
                # Separate inode caches, with the same workspace path and publication store.
                command = ["unshare", "--mount", "--propagation", "private", "sh", "-c",
                           'set -e; mount --bind "$1" "$2"; if [ -n "$3" ]; then mount --bind "$3" "$4"; fi; cd "$2"; shift 4; exec "$@"',
                           "sh", private_mount, self.mountpoint, profile.path if profile else "", HOME,
                           "setpriv", "--reuid", str(uid), "--regid", str(uid), "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--", "/usr/bin/env", "-i", "--",
                           *[key + "=" + value for key, value in environment.items()], *argv]
                process = subprocess.Popen(command, cwd="/", env={"PATH": "/usr/bin:/bin"},
                                           stdin=subprocess.PIPE if channel else subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE if channel else subprocess.STDOUT, start_new_session=True)
                output = bytearray()
                def drain():
                    try:
                        while True:
                            chunk = process.stdout.read(8192)
                            if not chunk:
                                return
                            output.extend(chunk[:max(0, 1024 * 1024 - len(output))])
                    except OSError:
                        return
                if channel:
                    for name, pipe in [("stdout", process.stdout), ("stderr", process.stderr)]:
                        thread = threading.Thread(target=channel.output, args=(name, pipe), daemon=True)
                        thread.start()
                        threads.append(thread)
                    channel.send({"started": True, "homePath": HOME})
                    threading.Thread(target=channel.input, args=(process.stdin,), daemon=True).start()
                else:
                    reader = threading.Thread(target=drain, daemon=True)
                    reader.start()
                deadline = time.monotonic() + timeout / 1000
                heartbeat = time.monotonic() + 10
                while process.poll() is None:
                    with self.store.lock:
                        self.store.validate(operation["id"])
                        expiry = min((self.store.authorize(operation["owner"], claim["resource"], claim["claim"])["expires"] for claim in request["claims"]), default=time.time() + 30)
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Rejected("command_timeout")
                    if channel and channel.decision.is_set():
                        if channel.action != "complete" or channel.failed:
                            raise Rejected("operation_interrupted")
                        # Let native history flush and SRT remove temporary mount points.
                        process.stdin.close()
                        try:
                            process.wait(timeout=min(5, remaining))
                        except subprocess.TimeoutExpired:
                            raise Rejected("process_shutdown_failed") from None
                        break
                    interval = min(10, max(0.01, (expiry - time.time()) / 3), remaining)
                    try:
                        process.wait(timeout=min(interval, .1) if channel else interval)
                    except subprocess.TimeoutExpired:
                        if not channel or time.monotonic() >= heartbeat:
                            for claim in request["claims"]:
                                self.execute(operation["owner"], {"action": "heartbeat", **claim})
                            heartbeat = time.monotonic() + min(10, max(.01, (expiry - time.time()) / 3))
                if channel:
                    channel.decision.wait(timeout=max(0, min(5, deadline - time.monotonic())))
                    if not channel.decision.is_set() or channel.action != "complete" or channel.failed:
                        raise Rejected("operation_interrupted")
                    if process.returncode:
                        with self.store.lock:
                            self.store.validate(operation["id"])
                        raise Rejected("command_failed")
            finally:
                # Operation UIDs are never reused; escaped children cannot join later operations.
                subprocess.run(["pkill", "-KILL", "-u", str(uid)], capture_output=True)
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                await_domain_exit(uid)
                if reader is not None:
                    reader.join(timeout=2)
                for thread in threads:
                    thread.join(timeout=2)
                if profile:
                    profile.close()
                if os.path.ismount(private_mount):
                    subprocess.run(["fusermount", "-u", private_mount], check=True, capture_output=True)
                mount_thread.join(timeout=10)
                if os.path.isdir(private_mount) and not os.path.ismount(private_mount):
                    os.rmdir(private_mount)
                if channel and (channel.failed or any(thread.is_alive() for thread in threads)):
                    raise Rejected("stream_failed")
            return {"exitCode": 0} if channel else {"exitCode": process.returncode, "output": output.decode(errors="replace")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--mount", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--mount-tag", required=True)
    parser.add_argument("--seed")
    arguments = parser.parse_args()
    if os.getuid() != 0:
        raise RuntimeError("The managed adapter supervisor must run as root")
    workers = {int(uid): owner for uid, owner in json.loads(input()).items()}
    if not workers or any(uid <= 0 or uid >= 10000 or not isinstance(owner, str) or not owner for uid, owner in workers.items()):
        raise RuntimeError("Register authenticated worker UIDs in the range 1..9999")
    store = Store(arguments.state, arguments.workspace, arguments.seed)
    with store.db:
        initialize_refs(store)
    store.identities.register(workers)
    for interrupted in store.db.execute("SELECT uid,id FROM operations WHERE status='aborted' AND receipt LIKE '%operation_interrupted%'"):
        subprocess.run(["pkill", "-KILL", "-u", str(interrupted["uid"])], capture_output=True)
        abandoned = os.path.join(arguments.state, "mounts", interrupted["id"])
        if os.path.ismount(abandoned):
            subprocess.run(["fusermount", "-uz", abandoned], check=True, capture_output=True)
        if os.path.isdir(abandoned):
            os.rmdir(abandoned)
    adapter = Adapter(store, workers, arguments.gateway, arguments.mount, arguments.mount_tag)

    class Commands(socketserver.StreamRequestHandler):
        def handle(self):
            self.connection.settimeout(310)
            peer = struct.unpack("3i", self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            try:
                if peer != 0 and peer not in workers:
                    raise Rejected("permission_denied")
                raw = self.rfile.readline(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024 or not raw.endswith(b"\n"):
                    raise Rejected("request_too_large")
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise Rejected("request_invalid")
                owner = adapter.worker(peer, request)
                request.pop("workerUid", None)
                channel = None
                if request.get("interactive"):
                    if peer != 0 or request.get("action") != "run":
                        raise Rejected("permission_denied")
                    channel = ProcessChannel(self.connection, self.rfile)
                result = adapter.execute(owner, request, channel)
                response = {"result": result}
            except Rejected as error:
                response = {"error": {"code": error.code, "resources": error.resources}}
            except (KeyError, ValueError, TypeError):
                response = {"error": {"code": "request_invalid"}}
            except Exception:
                response = {"error": {"code": "adapter_unavailable"}}
            try:
                self.wfile.write(canonical(response).encode() + b"\n")
            except (BrokenPipeError, ConnectionResetError):
                pass  # The retained operation identity is the recovery boundary.

    if os.path.exists(arguments.socket):
        os.unlink(arguments.socket)
    server = CommandServer(arguments.socket, Commands)
    os.chmod(arguments.socket, 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    os.makedirs(arguments.mount, mode=0o755, exist_ok=True)
    FUSE(Filesystem(store, workers), arguments.mount, foreground=True, allow_other=True,
         direct_io=True, atomic_o_trunc=True, attr_timeout=0, entry_timeout=0, negative_timeout=0, fsname=arguments.mount_tag)
