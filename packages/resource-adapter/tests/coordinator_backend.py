"""Real adapter authority; kernel mounting and native execution are explicit test doubles."""
import json
import os
from pathlib import Path
import socketserver
import sys
import threading
import time
import types

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "linux"))
fuse = types.ModuleType("fusepy")
fuse.FUSE = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("FUSE is not exercised by this test"))
fuse.Operations, fuse.FuseOSError = object, OSError
fuse.fuse_get_context = lambda: (_ for _ in ()).throw(RuntimeError("No kernel context in this test"))
sys.modules["fusepy"] = fuse
from daemon import Adapter
from commands import CommandServer
from store import Store, Rejected, canonical

base = Path(sys.argv[1])
workers = {uid: f"worker-{uid}" for uid in range(1001, 2001)}
seed = base / "seed"
seed.mkdir(exist_ok=True)
for i in range(1000):
    (seed / f"file-{i}").write_text("BASE")
(seed / "large").write_text("🍞" * 300000)
state = base / "private"
fresh = not state.exists()
store = Store(str(state), "scale", str(seed), str(base / "identities"))
store.identities.register(workers)
if fresh:
    with store.db:
        store.db.execute("INSERT INTO events(path,revision,operation) VALUES (?,?,?)", ("historical", 1, "historical"))
        for i in range(1000):
            store.install(workers[1001 + i], f"file:file-{i}", {"claim": f"claim-{i}", "fence": i + 1, "expires": time.time() + 600})
adapter = Adapter(store, workers, "unused", "unused", "unused")
running, peak = 0, 0
running_lock = threading.Lock()

def run(operation, request, channel=None):
    global running, peak
    with running_lock:
        running += 1
        peak = max(peak, running)
        (base / "running").write_text(str(running))
    try:
        deadline = time.monotonic() + 90
        while not (base / "release").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        return {"exitCode": 0, "output": "synthetic native execution"}
    finally:
        with running_lock:
            running -= 1
adapter.run = run
counts = {}
def save_counts():
    (base / "counts.tmp").write_text(json.dumps({**counts, "peakExecution": peak}))
    (base / "counts.tmp").replace(base / "counts.json")
class Commands(socketserver.StreamRequestHandler):
    def handle(self):
        request = json.loads(self.rfile.readline())
        action = request.get("action")
        with store.lock:
            counts[action] = counts.get(action, 0) + 1
            if action == "await_changes" and "firstLiveCursor" not in counts:
                counts["firstLiveCursor"] = request["after"]
            save_counts()
        try:
            owner = adapter.worker(0, request)
            request.pop("workerUid", None)
            result = adapter.execute(owner, request)
            reply = {"result": result}
        except Rejected as error:
            reply = {"error": {"code": error.code}}
        except (KeyError, ValueError, TypeError):
            reply = {"error": {"code": "request_invalid"}}
        if action == "write" and str(request.get("content", "")).startswith("LOST_REPLY"):
            (base / "committed").touch()
            deadline = time.monotonic() + 10
            while not (base / "reply-release").exists() and time.monotonic() < deadline:
                time.sleep(.01)
        try:
            self.wfile.write(canonical(reply).encode() + b"\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        with store.lock:
            save_counts()

(state / "backend.sock").unlink(missing_ok=True)
server = CommandServer(str(state / "backend.sock"), Commands)
os.chmod(state / "backend.sock", 0o600)
print(json.dumps({str(uid): owner for uid, owner in workers.items()}), flush=True)
server.serve_forever()
