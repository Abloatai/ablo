"""Trusted per-command memory accounting outside the gVisor user namespace."""
import ctypes
import fcntl
import os
from pathlib import Path
import sys
import time

CGROUP_ROOT = Path('/sys/fs/cgroup')


def cgroup2(path):
    if sys.platform != 'linux':
        return False
    info = ctypes.create_string_buffer(4096)
    libc = ctypes.CDLL(None, use_errno=True)
    return not libc.statfs(os.fsencode(path), info) and ctypes.cast(info, ctypes.POINTER(ctypes.c_long))[0] == 0x63677270


def memory_limit(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value % (1024 * 1024):
        raise RuntimeError('gVisor memory limit must be a positive whole number of MiB in bytes')
    return value


def claim_root(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('The gVisor jobs cgroup already has a supervisor') from error
        if any(entry.is_dir() for entry in directory.iterdir()):
            raise RuntimeError('Drain orphan gVisor job cgroups before starting a supervisor')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class MemoryCgroups:
    def __init__(self, root, limit, concurrency):
        self.root, self.limit = Path(root), memory_limit(limit)
        if not self.root.is_relative_to(CGROUP_ROOT) or self.root == CGROUP_ROOT or not cgroup2(self.root):
            raise RuntimeError('gVisor needs a delegated cgroup2 directory below /sys/fs/cgroup')
        if isinstance(concurrency, bool) or not isinstance(concurrency, int) or not 1 <= concurrency <= 64:
            raise RuntimeError('Invalid gVisor command concurrency')
        current = Path('/proc/self/cgroup').read_text().strip()
        if not current.startswith('0::/') or '\n' in current or '..' in Path(current[3:]).parts:
            raise RuntimeError('Cannot verify the supervisor cgroup')
        if (CGROUP_ROOT / current[3:].lstrip('/')).is_relative_to(self.root):
            raise RuntimeError('The supervisor must stay outside the gVisor jobs cgroup')
        aggregate = (self.root / 'memory.max').read_text().strip()
        if not aggregate.isdecimal() or self.limit * concurrency > int(aggregate):
            raise RuntimeError('gVisor command budgets exceed the finite delegated memory budget')
        ancestors = [parent for parent in self.root.parents if parent.is_relative_to(CGROUP_ROOT)]
        bounds = []
        for parent in ancestors:
            try:
                bounds.append((parent / 'memory.max').read_text().strip())
            except FileNotFoundError:
                if parent != CGROUP_ROOT:
                    raise
        finite = [int(bound) for bound in bounds if bound.isdecimal()]
        if not finite or int(aggregate) >= min(finite):
            raise RuntimeError('Reserve supervisor memory outside the delegated jobs budget')
        if (self.root / 'cgroup.procs').read_text().strip() or 'memory' not in (self.root / 'cgroup.subtree_control').read_text().split():
            raise RuntimeError('Delegate an empty memory-enabled cgroup for gVisor jobs')
        self.lock = claim_root(self.root)  # Held only by this daemon; exec children cannot retain it.

    def create(self, name):
        directory = self.root / name
        directory.mkdir(mode=0o700)
        try:
            for filename, value in [('memory.max', str(self.limit)), ('memory.swap.max', '0'), ('memory.oom.group', '1')]:
                (directory / filename).write_text(value)
                if (directory / filename).read_text().strip() != value:
                    raise RuntimeError('The kernel did not enforce the gVisor memory budget')
            if not (directory / 'cgroup.kill').is_file():
                raise RuntimeError('gVisor command teardown requires cgroup.kill')
            return directory
        except BaseException:
            directory.rmdir()
            raise

    def close(self, name):
        directory = self.root / name
        (directory / 'cgroup.kill').write_text('1')
        deadline = time.monotonic() + 10
        while 'populated 1' in (directory / 'cgroup.events').read_text():
            if time.monotonic() >= deadline:
                raise RuntimeError('gVisor command cgroup did not drain')
            time.sleep(0.01)
        events = dict(line.split() for line in (directory / 'memory.events').read_text().splitlines())
        killed = int(events.get('oom_kill', '0')) > 0
        directory.rmdir()
        return killed


def attach(directory, pid):
    (directory / 'cgroup.procs').write_text(str(pid))
    if str(pid) not in (directory / 'cgroup.procs').read_text().split():
        raise RuntimeError('gVisor child did not enter its memory cgroup')
