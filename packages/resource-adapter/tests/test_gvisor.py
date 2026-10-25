"""Portable checks for the opt-in sandbox's trusted configuration and guest boundary."""
import os
import stat
from types import SimpleNamespace
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "linux"))
from gvisor import Gvisor, specification, trusted_path


class GvisorConfiguration(unittest.TestCase):
    def test_command_cannot_gain_host_paths_network_or_capabilities_through_argv(self):
        argv = ["node", "--root=/", "--network=host"]
        environment = {"PATH": "/usr/bin", "VALUE": "literal; $(touch /root/escape)"}
        spec = specification('/opt/image', '/workspace/repository', '/tmp/ablo-worker-fixture', environment, argv)
        self.assertEqual(spec['process']['args'], argv)
        self.assertEqual(spec['process']['env'], ['PATH=/usr/bin', 'VALUE=literal; $(touch /root/escape)'])
        self.assertTrue(spec['root']['readonly'])
        self.assertTrue(spec['process']['noNewPrivileges'])
        self.assertTrue(all(value == [] for value in spec['process']['capabilities'].values()))
        binds = [mount for mount in spec['mounts'] if mount['type'] == 'bind']
        self.assertEqual([mount['source'] for mount in binds], ['/workspace/repository', '/tmp/ablo-worker-fixture'])
        self.assertTrue(all(mount['source'] == mount['destination'] for mount in binds))
        self.assertIn({'type': 'network'}, spec['linux']['namespaces'])
        self.assertNotIn('uidMappings', spec['linux'])  # The parent namespace maps both gofer and Sentry.

    def test_live_host_root_cannot_be_used_as_the_runtime_image(self):
        with patch('gvisor.trusted_path', side_effect=lambda path: Path(path)), patch('gvisor.os.access', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'must not contain live source'):
                Gvisor('/', '/workspace/repository')

    def test_runtime_image_paths_reject_relative_paths_and_parent_traversal(self):
        for path in ['relative/rootfs', '/opt/../tmp/rootfs']:
            with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, 'absolute'):
                trusted_path(path)

    def test_runtime_image_paths_reject_symlinks_and_worker_writable_components(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            target = directory / 'rootfs'
            target.mkdir()
            link = directory / 'link'
            link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                trusted_path(link)
            for info in [SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o777),
                         SimpleNamespace(st_uid=1001, st_mode=stat.S_IFDIR | 0o755)]:
                with patch.object(Path, 'lstat', return_value=info):
                    with self.assertRaises(RuntimeError):
                        trusted_path('/opt/image')
