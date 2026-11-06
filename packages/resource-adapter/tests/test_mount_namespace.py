"""Syscall failure/order guards; real FUSE overlap is a separate Linux fixture."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
import process


class MountNamespaceTests(unittest.TestCase):
    def exercise(self, failure=None):
        calls=[]
        def unshare(flags):
            calls.append(('unshare', flags))
            return -1 if failure == ('enter' if flags & 0x20000 else 'detach') else 0
        def restore(fd, flags):
            calls.append(('restore',fd,flags))
            return -1 if failure=='restore' else 0
        def mount(*args, **kwargs):
            calls.append(('private',args[0]))
            if failure=='private': raise subprocess.CalledProcessError(1,args[0])
        libc=Mock(unshare=Mock(side_effect=unshare),setns=Mock(side_effect=restore))
        with patch.object(process.ctypes,'CDLL',return_value=libc), \
             patch.object(process.os,'open',return_value=17) as opened, \
             patch.object(process.os,'close',side_effect=lambda fd:calls.append(('close',fd))), \
             patch.object(process.subprocess,'run',side_effect=mount):
            def run():
                with process.operation_mount_namespace():
                    calls.append(('body',))
                    if failure=='body': raise RuntimeError('fixture teardown failure')
            if failure:
                with self.assertRaises((OSError,subprocess.CalledProcessError,RuntimeError)): run()
            else: run()
            opened.assert_called_once_with('/proc/thread-self/ns/mnt', process.os.O_RDONLY | process.os.O_CLOEXEC)
        self.assertEqual(calls[-1],('close',17))
        if failure=='enter': self.assertEqual(calls,[('unshare',0x20200),('close',17)])
        else:
            self.assertEqual(calls[:2],[('unshare',0x20200),('private',['mount','--make-rprivate','/'])])
            self.assertIn(('unshare',0x200),calls)
            if failure!='detach': self.assertEqual(calls[-2],('restore',17,0x20000))
            else: self.assertFalse(any(c[0]=='restore' for c in calls))
        if failure in ('enter','private'): self.assertNotIn(('body',),calls)
        return calls

    def test_isolate_before_body_and_restore_after(self):
        self.assertEqual(self.exercise()[2],('body',))

    def test_failures_never_fall_back_to_shared_namespace_or_hide_teardown_error(self):
        for failure in ('enter','private','body','detach','restore'):
            with self.subTest(failure=failure): self.exercise(failure)


if __name__=='__main__': unittest.main()
