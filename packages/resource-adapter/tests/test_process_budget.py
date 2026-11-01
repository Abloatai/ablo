"""Fixed stdio budget and root dispatch regressions; no FUSE/model qualification."""
import base64
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'linux'))
from process import (ProcessChannel, FILESYSTEM_PROFILE_BUDGET, LIMIT,
                     FILESYSTEM_PROFILE_LIMIT, filesystem_budget, validate_filesystem_argv)
from store import Rejected


class DispatchTests(unittest.TestCase):
    def test_exact_root_configuration_and_dispatch(self):
        argv = ['/usr/bin/python3', '-I', '/fixed/sftp.py']
        request = dict(action='run', interactive=True, streamBudget=FILESYSTEM_PROFILE_BUDGET, argv=argv)
        self.assertEqual(FILESYSTEM_PROFILE_BUDGET, 'filesystem-profile-64m-v2')
        self.assertEqual(FILESYSTEM_PROFILE_LIMIT, 64 * 1024 * 1024)
        self.assertEqual(LIMIT, 16 * 1024 * 1024)
        self.assertEqual(filesystem_budget(0, request, argv), FILESYSTEM_PROFILE_BUDGET)
        for peer, changes, config in [(2001, {}, argv), (0, {}, None), (0, {'argv': ['/bin/sh']}, argv),
                                      (0, {'interactive': False}, argv), (0, {'action': 'read'}, argv),
                                      (0, {'env': {}}, argv), (0, {'streamBudget': '64m'}, argv),
                                      (0, {'streamBudget': None}, argv), (0, {'streamBudget': 'filesystem-profile-32m-v1'}, argv),
                                      (0, {'streamBudget': 67108864}, argv)]:
            with self.subTest(peer=peer, changes=changes, config=config), self.assertRaises(Rejected):
                filesystem_budget(peer, {**request, **changes}, config)
        self.assertIsNone(filesystem_budget(2001, {'action': 'run'}, argv))
        for invalid in [[], 'command', ['relative'], ['/bin/sh', 1], ['/bin/sh', '\0']]:
            with self.subTest(config=invalid), self.assertRaises(ValueError):
                validate_filesystem_argv(invalid)
        self.assertEqual(validate_filesystem_argv(argv), argv)

    def test_frame_limit_and_safe_diagnostic(self):
        class Connection:
            def __init__(self): self.frames = []
            def sendall(self, data): self.frames.append(json.loads(data))
        connection = Connection()
        channel = ProcessChannel(connection, io.BytesIO(b'x' * (1024 * 1024 + 1)), FILESYSTEM_PROFILE_BUDGET)
        channel.input(io.BytesIO())
        self.assertTrue(channel.failed)
        self.assertEqual(channel.action, 'abort')
        self.assertEqual(connection.frames, [{'diagnostic': dict(reason='frame_overflow', stream='stdin', stdinBytes=0, stdoutBytes=0, stderrBytes=0)}])
        self.assertEqual(channel.limit('stderr'), LIMIT)
        self.assertEqual(channel.limit('stdin'), FILESYSTEM_PROFILE_LIMIT)
        channel.fail(ValueError('private content'), 'stdin')
        self.assertEqual(len(connection.frames), 1)

    def test_actual_socket_input_bounds(self):
        for mode in [None, FILESYSTEM_PROFILE_BUDGET]:
            left, right = socket.socketpair()
            source = left.makefile('rb')
            channel = ProcessChannel(left, source, mode)
            with open(os.devnull, 'wb') as sink:
                thread = threading.Thread(target=channel.input, args=(sink,))
                thread.start()
                packet = json.dumps(dict(action='stdin', data=base64.b64encode(b'x' * 65536).decode())).encode() + b'\n'
                ceiling = channel.limit('stdin')
                for _ in range(ceiling // 65536 + 1):
                    right.sendall(packet)
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertTrue(channel.failed)
                self.assertEqual(channel.counts['stdin'], ceiling + 65536)
                self.assertEqual(json.loads(right.recv(4096))['diagnostic']['reason'], 'stream_overflow')
            source.close(); left.close(); right.close()

    def test_actual_socket_output_bounds(self):
        for mode, stream in [(None, 'stdout'), (FILESYSTEM_PROFILE_BUDGET, 'stdout'), (FILESYSTEM_PROFILE_BUDGET, 'stderr')]:
            left, right = socket.socketpair()
            channel = ProcessChannel(left, None, mode)
            reader, writer = os.pipe()
            diagnostics = []
            def receive():
                with right.makefile('rb') as source:
                    while raw := source.readline():
                        frame = json.loads(raw)
                        if 'diagnostic' in frame:
                            diagnostics.append(frame['diagnostic']); return
            consumer = threading.Thread(target=receive); consumer.start()
            with os.fdopen(reader, 'rb') as source:
                thread = threading.Thread(target=channel.output, args=(stream, source)); thread.start()
                ceiling = channel.limit(stream)
                with os.fdopen(writer, 'wb') as sink:
                    for _ in range(ceiling // 8192 + 1): sink.write(b'x' * 8192)
                thread.join(10); consumer.join(10)
                self.assertFalse(thread.is_alive()); self.assertFalse(consumer.is_alive())
                self.assertEqual(channel.counts[stream], ceiling + 8192)
                self.assertEqual(diagnostics[0]['reason'], 'stream_overflow')
            left.close(); right.close()


if __name__ == "__main__": unittest.main()
