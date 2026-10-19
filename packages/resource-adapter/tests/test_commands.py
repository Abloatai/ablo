import concurrent.futures
from pathlib import Path
import socket
import socketserver
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "linux"))
from commands import CommandServer


class Admission(unittest.TestCase):
    def test_burst_waits_for_accept_and_bounds_active_handlers(self):
        release, full = threading.Event(), threading.Event()
        lock = threading.Lock()
        active = peak = 0

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    if active == 32:
                        full.set()
                try:
                    self.request.settimeout(5)
                    release.wait(5)
                    self.wfile.write(self.rfile.readline())
                finally:
                    with lock:
                        active -= 1

        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "commands.sock")
            with CommandServer(path, Handler) as server:
                clients = []
                try:
                    # A stopped accept loop makes the old five-entry backlog fail deterministically.
                    for i in range(64):
                        client = socket.socket(socket.AF_UNIX)
                        clients.append(client)
                        client.settimeout(2)
                        client.connect(path)
                        client.sendall(f"read-{i}\n".encode())
                    serving = threading.Thread(target=server.serve_forever)
                    serving.start()
                    try:
                        self.assertTrue(full.wait(3))
                        self.assertEqual(peak, 32)
                        release.set()
                        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
                            replies = list(pool.map(lambda s: s.recv(100), clients))
                        self.assertEqual(replies, [f"read-{i}\n".encode() for i in range(64)])
                        self.assertEqual(peak, 32)
                    finally:
                        release.set()
                        server.shutdown()
                        serving.join()
                finally:
                    for client in clients:
                        client.close()
