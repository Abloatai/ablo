"""Opt-in, network-isolated command execution under the admitted host UID."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
from gvisor_cgroup import MemoryCgroups, attach

RUNSC = "/usr/local/bin/runsc"
# shortcut: crash metadata is operator-cleaned after host drain; add scoped reaping before pooling.
RUNTIMES = "/run/ablo-resource-gvisor"


def trusted_path(path):
    absolute = Path(path)
    if not absolute.is_absolute() or ".." in absolute.parts:
        raise RuntimeError("gVisor paths must be absolute")
    for entry in [absolute, *absolute.parents]:
        info = entry.lstat()
        if entry.is_symlink() or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError("gVisor paths must be root-owned and not writable by workers")
    return absolute


class Gvisor:
    def __init__(self, rootfs, mountpoint, cgroup_root=None, memory_limit=None, concurrency=8):
        self.rootfs = trusted_path(rootfs)
        trusted_path(RUNSC)
        if not self.rootfs.is_dir() or not os.access(RUNSC, os.X_OK):
            raise RuntimeError("gVisor needs its installed runtime and an immutable root filesystem")
        source = Path(mountpoint)
        if not source.is_absolute() or ".." in source.parts:
            raise RuntimeError("gVisor mountpoint must be absolute")
        if source.is_relative_to(self.rootfs) or Path(RUNTIMES).is_relative_to(self.rootfs):
            raise RuntimeError("gVisor image must not contain live source or runtime state")
        target = trusted_path(self.rootfs / str(source).lstrip("/"))
        scratch = self.rootfs / "tmp"
        info = scratch.lstat()
        if not target.is_dir() or scratch.is_symlink() or not scratch.is_dir() or info.st_uid != 0 or info.st_mode & 0o1777 != 0o1777:
            raise RuntimeError("Prepare the source mount target and a root-owned sticky tmp directory in the gVisor image")
        self.mountpoint = str(source)
        if cgroup_root is None:
            raise RuntimeError('gVisor requires a delegated cgroup2 directory and command memory budget')
        self.cgroups = MemoryCgroups(trusted_path(cgroup_root), memory_limit, concurrency)

    def prepare(self, uid, home, environment, argv):
        os.makedirs(RUNTIMES, mode=0o755, exist_ok=True)
        trusted_path(RUNTIMES)
        os.chmod(RUNTIMES, 0o755)
        directory = Path(tempfile.mkdtemp(prefix=str(uid) + "-", dir=RUNTIMES))
        cgroup = None
        try:
            cgroup = self.cgroups.create(directory.name)
            spec = specification(str(self.rootfs), self.mountpoint, home, environment, argv)
            path = directory / "config.json"
            path.write_text(json.dumps(spec))
            os.chown(path, uid, uid)
            os.chown(directory, uid, uid)
            command = [sys.executable, __file__, str(uid), str(directory), str(os.getpid()), str(cgroup)]
            return directory, command
        except BaseException:
            if cgroup is not None:
                self.cgroups.close(directory.name)
            shutil.rmtree(directory)
            raise

    def close(self, directory, home):
        # The supervisor has killed/reaped both the launcher group and the UID domain.
        killed = self.cgroups.close(directory.name)
        shutil.rmtree(directory)
        target = self.rootfs / home.lstrip("/")
        try:
            target.rmdir()  # The gofer may create this empty mount target; never recurse into the image.
        except FileNotFoundError:
            pass
        return killed


def specification(rootfs, source, home, environment, argv):
    return {
        "ociVersion": "1.0.2", "root": {"path": rootfs, "readonly": True},
        "process": {"terminal": False, "user": {"uid": 0, "gid": 0}, "cwd": source,
                    "args": argv, "env": [key + "=" + value for key, value in environment.items()],
                    "noNewPrivileges": True,
                    "capabilities": {key: [] for key in ("bounding", "effective", "inheritable", "permitted", "ambient")}},
        "linux": {"namespaces": [{"type": kind} for kind in ("pid", "network", "ipc", "uts", "mount")]},
        "mounts": [
            {"destination": "/proc", "type": "proc", "source": "proc"},
            {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
            {"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]},
            {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]},
            {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777"]},
            *[{"destination": path, "type": "bind", "source": path, "options": ["rbind", "rw", "nosuid", "nodev"]} for path in (source, home)],
        ],
    }


def execute(uid, directory, cgroup):
    # Map the entire runtime tree, including Sentry FD reads, not only the gofer.
    ready_read, ready_write = os.pipe()
    go_read, go_write = os.pipe()
    parent_pid = os.getpid()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(ready_read)
            os.close(go_write)
            os.setgroups([])
            libc = ctypes.CDLL(None, use_errno=True)
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent_pid:
                raise RuntimeError("gVisor launcher parent disappeared")
            if libc.unshare(0x10000000):  # CLONE_NEWUSER
                raise OSError(ctypes.get_errno(), "Cannot create the gVisor user namespace")
            os.write(ready_write, b"R")
            os.close(ready_write)
            if os.read(go_read, 1) != b"G":
                raise RuntimeError("Namespace mapping was not authorized")
            os.close(go_read)
            os.setgid(0)
            os.setuid(0)
            # Credential changes clear PDEATHSIG; rearm and check before starting any payload.
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != parent_pid:
                raise RuntimeError("gVisor launcher parent disappeared")
            runtime = [RUNSC, "--rootless", "--root=" + str(directory / "runtime"), "--ignore-cgroups",
                       "--platform=systrap", "--network=none", "--overlay2=none", "--directfs=false",
                       "--file-access=shared", "--file-access-mounts=shared", "--gofer-network-namespace=new"]
            try:
                code = subprocess.call([*runtime, "run", "--bundle=" + str(directory), "command"])
            finally:
                stopped = subprocess.run([*runtime, "delete", "-force", "command"], capture_output=True, timeout=10)
                if stopped.returncode:
                    raise RuntimeError("gVisor teardown could not be confirmed")
            os._exit(code if code >= 0 else 128 - code)
        except BaseException:
            import traceback
            traceback.print_exc()
            os._exit(1)
    os.close(ready_write)
    os.close(go_read)
    try:
        if os.read(ready_read, 1) != b"R":
            raise RuntimeError("gVisor namespace setup failed")
        process = Path("/proc") / str(pid)
        (process / "setgroups").write_text("deny")
        (process / "uid_map").write_text("0 " + str(uid) + " 1")
        (process / "gid_map").write_text("0 " + str(uid) + " 1")
        # The child is blocked at the mapping gate; no payload can fork or allocate yet.
        attach(cgroup, pid)
        os.write(go_write, b"G")
    except BaseException:
        # The PID cannot be reused until this parent reaps it.
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(ready_read)
        os.close(go_write)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    if os.getuid() != 0:
        raise RuntimeError("Only the trusted supervisor may map a command namespace")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) or os.getppid() != int(sys.argv[3]):
        raise RuntimeError("The supervisor disappeared before sandbox launch")
    uid = int(sys.argv[1])
    if uid < 10000 or uid >= 2**31:
        raise RuntimeError("Invalid operation UID")
    sys.exit(execute(uid, Path(sys.argv[2]), Path(sys.argv[4])))
