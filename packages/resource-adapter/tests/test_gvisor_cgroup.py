"""Fail-closed admission checks; real kernel OOM behavior is exercised on Linux."""
from pathlib import Path
import os
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from gvisor_cgroup import MemoryCgroups, attach, cgroup2, claim_root, memory_limit
from gvisor import execute


class GvisorMemoryAdmission(unittest.TestCase):
    def test_memory_budgets_must_be_positive_integral_mib(self):
        for value in [None, True, -1, 0, 1, 1.5, '1048576']:
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, 'whole number'):
                memory_limit(value)
        self.assertEqual(memory_limit(5 * 1024**3), 5 * 1024**3)

    def test_ordinary_filesystem_cannot_impersonate_a_cgroup(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertFalse(cgroup2(temporary))
            with self.assertRaisesRegex(RuntimeError, 'delegated cgroup2'):
                MemoryCgroups(temporary, 256 * 1024**2, 2)

    def test_overcommitted_parent_budget_fails_before_creating_a_job(self):
        contents = {'/proc/self/cgroup': '0::/supervisor\n', '/sys/fs/cgroup/jobs/memory.max': str(256 * 1024**2)}
        with patch('gvisor_cgroup.cgroup2', return_value=True), patch.object(Path, 'read_text', lambda path: contents[str(path)]):
            with self.assertRaisesRegex(RuntimeError, 'exceed'):
                MemoryCgroups('/sys/fs/cgroup/jobs', 256 * 1024**2, 2)

    def test_supervisor_cannot_share_the_job_aggregate(self):
        with patch('gvisor_cgroup.cgroup2', return_value=True), patch.object(Path, 'read_text', return_value='0::/jobs/controller\n'):
            with self.assertRaisesRegex(RuntimeError, 'outside'):
                MemoryCgroups('/sys/fs/cgroup/jobs', 256 * 1024**2, 1)

    def test_real_hierarchy_root_may_omit_memory_max_but_other_ancestors_must_not(self):
        contents = {'/proc/self/cgroup': '0::/pool/supervisor\n', '/sys/fs/cgroup/pool/jobs/memory.max': str(512 * 1024**2),
                    '/sys/fs/cgroup/pool/memory.max': str(1024**3), '/sys/fs/cgroup/pool/jobs/cgroup.procs': '',
                    '/sys/fs/cgroup/pool/jobs/cgroup.subtree_control': 'memory\n'}
        def read(path):
            if str(path) not in contents:
                raise FileNotFoundError(str(path))
            return contents[str(path)]
        with patch('gvisor_cgroup.cgroup2', return_value=True), patch.object(Path, 'read_text', read), patch('gvisor_cgroup.claim_root'):
            MemoryCgroups('/sys/fs/cgroup/pool/jobs', 256 * 1024**2, 2)
            del contents['/sys/fs/cgroup/pool/memory.max']
            with self.assertRaises(FileNotFoundError):
                MemoryCgroups('/sys/fs/cgroup/pool/jobs', 256 * 1024**2, 2)

    def test_supervisor_reserve_and_delegation_are_required(self):
        contents = {'/proc/self/cgroup': '0::/supervisor\n', '/sys/fs/cgroup/jobs/memory.max': str(512 * 1024**2),
                    '/sys/fs/cgroup/memory.max': str(512 * 1024**2), '/sys/fs/cgroup/jobs/cgroup.procs': '',
                    '/sys/fs/cgroup/jobs/cgroup.subtree_control': 'memory\n'}
        with patch('gvisor_cgroup.cgroup2', return_value=True), patch.object(Path, 'read_text', lambda path: contents[str(path)]):
            with self.assertRaisesRegex(RuntimeError, 'Reserve'):
                MemoryCgroups('/sys/fs/cgroup/jobs', 256 * 1024**2, 2)
            contents['/sys/fs/cgroup/memory.max'] = str(1024**3)
            contents['/sys/fs/cgroup/jobs/cgroup.procs'] = '123\n'
            with self.assertRaisesRegex(RuntimeError, 'empty'):
                MemoryCgroups('/sys/fs/cgroup/jobs', 256 * 1024**2, 2)

    def test_membership_must_be_confirmed_before_releasing_the_child_gate(self):
        with patch.object(Path, 'write_text'), patch.object(Path, 'read_text', return_value='999\n'):
            with self.assertRaisesRegex(RuntimeError, 'did not enter'):
                attach(Path('/sys/fs/cgroup/jobs/operation'), 123)
        with patch('gvisor.os.fork', return_value=123), patch('gvisor.os.read', return_value=b'R'), \
                patch.object(Path, 'write_text'), patch('gvisor.attach', side_effect=RuntimeError('membership failed')), \
                patch('gvisor.os.write') as release, patch('gvisor.os.kill') as kill, patch('gvisor.os.waitpid') as reap:
            with self.assertRaisesRegex(RuntimeError, 'membership failed'):
                execute(10000, Path('/unused'), Path('/sys/fs/cgroup/jobs/operation'))
            release.assert_not_called()
            kill.assert_called_once_with(123, signal.SIGKILL)
            reap.assert_called_once_with(123, 0)

    def test_jobs_root_has_one_supervisor_and_children_cannot_inherit_its_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            descriptor = claim_root(root)
            try:
                self.assertFalse(os.get_inheritable(descriptor))
                with patch('gvisor_cgroup.os.close', wraps=os.close) as close:
                    with self.assertRaisesRegex(RuntimeError, 'already has a supervisor'):
                        claim_root(root)
                    close.assert_called_once()
            finally:
                os.close(descriptor)
            released = claim_root(root)
            os.close(released)

    def test_orphan_children_reject_startup_and_release_the_failed_constructor_lock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'orphan').mkdir()
            with patch('gvisor_cgroup.os.close', wraps=os.close) as close:
                with self.assertRaisesRegex(RuntimeError, 'Drain orphan'):
                    claim_root(root)
                close.assert_called_once()
            (root / 'orphan').rmdir()
            released = claim_root(root)
            os.close(released)


if __name__ == '__main__':
    unittest.main()
