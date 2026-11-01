"""Root-controlled native-turn streams and exclusive, owner-bound CLI profiles."""
import base64
import json
import os
import shutil
import stat
import threading
import time
import uuid

from store import Rejected, canonical
from sandbox_masks import SANDBOX_MASKS

HOME = "/tmp/ablo-native-profile"
LIMIT = 16 * 1024 * 1024
FILESYSTEM_PROFILE_BUDGET = "filesystem-profile-64m-v2"
FILESYSTEM_PROFILE_LIMIT = 64 * 1024 * 1024


def filesystem_budget(peer, request, configured_argv):
    """Root dispatch selects a fixed budget for one configured filesystem command."""
    mode = request.get("streamBudget")
    if "streamBudget" not in request:
        return None
    if (peer != 0 or request.get("interactive") is not True or request.get("action") != "run"
            or mode != FILESYSTEM_PROFILE_BUDGET or not configured_argv
            or request.get("argv") != configured_argv or "env" in request):
        raise Rejected("capability_unavailable")
    return mode


def filesystem_sandbox_masks(peer, request, configured_argv, configured_mode):
    if "sandboxMasks" not in request:
        return None
    if (configured_mode != SANDBOX_MASKS or request["sandboxMasks"] != SANDBOX_MASKS
            or filesystem_budget(peer, request, configured_argv) != FILESYSTEM_PROFILE_BUDGET):
        raise Rejected("capability_unavailable")
    return SANDBOX_MASKS


def validate_filesystem_argv(argv):
    if argv is not None and (not isinstance(argv, list) or not argv
            or not all(isinstance(arg, str) and arg and "\0" not in arg for arg in argv)
            or not os.path.isabs(argv[0])):
        raise ValueError("Invalid trusted filesystem command")
    return argv


def await_domain_exit(uid):
    deadline = time.monotonic() + 10
    while True:
        alive = False
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                with open("/proc/" + name + "/status") as source:
                    status = dict(line.split(":", 1) for line in source if ":" in line)
                if int(status["Uid"].split()[0]) == uid and not status["State"].lstrip().startswith("Z"):
                    alive = True
                    break
            except (FileNotFoundError, ProcessLookupError):
                pass
        if not alive:
            return
        if time.monotonic() > deadline:
            raise Rejected("operation_teardown_failed")
        time.sleep(.01)


class ProcessChannel:
    def __init__(self, connection, source, stream_budget=None, sandbox_masks=None):
        if stream_budget not in (None, FILESYSTEM_PROFILE_BUDGET):
            raise Rejected("capability_unavailable")
        if sandbox_masks not in (None, SANDBOX_MASKS) or sandbox_masks and stream_budget != FILESYSTEM_PROFILE_BUDGET:
            raise Rejected("capability_unavailable")
        self.sandbox_masks = sandbox_masks
        self.stream_budget = stream_budget
        self.connection, self.source = connection, source
        self.lock = threading.Lock()
        self.decision = threading.Event()
        self.action = None
        self.failed = False
        self.counts = {"stdin": 0, "stdout": 0, "stderr": 0}

    def limit(self, name):
        return FILESYSTEM_PROFILE_LIMIT if self.stream_budget and name != "stderr" else LIMIT

    def fail(self, error, stream):
        # First cause only; never send exception text, paths, identifiers or payloads.
        with self.lock:
            if self.failed:
                return
            self.failed = True
            self.action = "abort"
            self.decision.set()
            code = getattr(error, "code", None)
            reason = {"stream_overflow": "stream_overflow", "stream_disconnected": "socket_lost",
                      "stream_frame": "frame_overflow"}.get(code,
                      "socket_lost" if isinstance(error, OSError) else "protocol_error")
            diagnostic = {"reason": reason, "stream": stream,
                          **{name + "Bytes": value for name, value in self.counts.items()}}
            try:
                self.connection.sendall(canonical({"diagnostic": diagnostic}).encode() + b"\n")
            except OSError:
                pass

    def send(self, frame):
        with self.lock:
            self.connection.sendall(canonical(frame).encode() + b"\n")

    def output(self, name, pipe):
        try:
            while True:
                data = os.read(pipe.fileno(), 8192)
                if not data:
                    return
                self.counts[name] += len(data)
                if self.counts[name] > self.limit(name):
                    raise Rejected("stream_overflow")
                self.send({"stream": name, "data": base64.b64encode(data).decode()})
        except Exception as error:
            self.fail(error, name)

    def input(self, pipe):
        try:
            while not self.decision.is_set():
                raw = self.source.readline(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise Rejected("stream_frame")
                if not raw or not raw.endswith(b"\n"):
                    raise Rejected("stream_disconnected")
                frame = json.loads(raw)
                if frame.get("action") in ("complete", "abort"):
                    self.action = frame["action"]
                    self.decision.set()
                    return
                if frame.get("action") == "stdin":
                    data = base64.b64decode(frame["data"], validate=True)
                    self.counts["stdin"] += len(data)
                    if self.counts["stdin"] > self.limit("stdin"):
                        raise Rejected("stream_overflow")
                    pipe.write(data)
                    pipe.flush()
                elif frame.get("action") == "eof":
                    pipe.close()
                else:
                    raise Rejected("stream_invalid")
        except Exception as error:
            self.fail(error, "stdin")


class Profile:
    def __init__(self, store, operation, identifier):
        try:
            if str(uuid.UUID(identifier)) != identifier:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise Rejected("profile_invalid") from None
        self.store, self.operation, self.identifier = store, operation, identifier
        self.path = os.path.join(store.directory, "profiles", identifier)
        with store.lock, store.db:
            row = store.db.execute("SELECT * FROM profiles WHERE id=?", (identifier,)).fetchone()
            if row and row["owner"] != operation["owner"]:
                raise Rejected("permission_denied")
            if row and row["operation"]:
                raise Rejected("profile_busy")
            if row and (not os.path.isdir(self.path) or os.path.islink(self.path)):
                raise Rejected("profile_unavailable")
            if not row:
                os.makedirs(self.path, mode=0o700)
                store.db.execute("INSERT INTO profiles VALUES (?,?,NULL)", (identifier, operation["owner"]))
            store.db.execute("UPDATE profiles SET operation=? WHERE id=?", (operation["id"], identifier))
        self.own(operation["uid"])

    def own(self, uid):
        # Never follow a worker-created link while the supervisor owns profile metadata.
        for root, directories, files in os.walk(self.path, followlinks=False):
            for path in [root, *[os.path.join(root, name) for name in directories + files]]:
                info = os.lstat(path)
                if not stat.S_ISLNK(info.st_mode) and not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    raise Rejected("profile_corrupt")
                if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                    raise Rejected("profile_corrupt")
                os.chown(path, uid, uid, follow_symlinks=False)
        os.chmod(self.path, 0o700)

    def close(self):
        temporary = os.path.join(self.path, "tmp")
        if os.path.islink(temporary):
            raise Rejected("profile_corrupt")
        if os.path.isdir(temporary):
            shutil.rmtree(temporary)
        self.own(0)
        # Persist CLI history before its terminal receipt can acknowledge the turn.
        for root, _, files in os.walk(self.path, followlinks=False):
            for name in files:
                path = os.path.join(root, name)
                if os.path.islink(path):
                    continue
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
