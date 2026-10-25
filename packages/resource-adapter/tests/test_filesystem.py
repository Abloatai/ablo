"""Mount setup consumes admitted identity without querying the shared connection."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import threading
import stat
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "linux"))


class MountIdentity(unittest.TestCase):
    def test_private_mount_uses_the_admitted_operation_identity(self):
        # The kernel binding is unnecessary for checking mount construction on any host.
        binding = SimpleNamespace(Operations=object, FuseOSError=OSError, fuse_get_context=lambda: (0, 0, 0))
        spec = importlib.util.spec_from_file_location("mount_identity_fixture", Path(__file__).resolve().parents[1] / "linux/filesystem.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"fusepy": binding}):
            spec.loader.exec_module(module)
        database = Mock()
        database.execute.side_effect = RuntimeError("Shared connection cannot be queried without its lock")
        store = SimpleNamespace(db=database)
        admitted = {"id": "accepted-operation", "uid": 10042}
        private = module.Filesystem(store, {}, admitted)
        admitted["uid"] = 10043
        self.assertEqual(private.operation, "accepted-operation")
        self.assertEqual(private.owner_uid, 10042)
        shared = module.Filesystem(store, {})
        self.assertIsNone(shared.operation)
        self.assertEqual(shared.owner_uid, 0)
        database.execute.assert_not_called()

    def test_getattr_returns_persisted_wall_time_instead_of_revision(self):
        binding = SimpleNamespace(Operations=object, FuseOSError=OSError, fuse_get_context=lambda: (0, 0, 0))
        spec = importlib.util.spec_from_file_location("mount_time_fixture", Path(__file__).resolve().parents[1] / "linux/filesystem.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"fusepy": binding}):
            spec.loader.exec_module(module)
        database = MagicMock()
        database.execute.return_value.fetchone.return_value = None
        store = SimpleNamespace(db=database, lock=threading.RLock(), metadata=lambda *_: {
            "kind": "file", "mode": 0o644, "size": 4, "revision": 2, "mtime": 1800000000.25})
        attributes = module.Filesystem(store, {}).getattr("/source")
        self.assertEqual(attributes["st_mtime"], 1800000000.25)
        self.assertEqual(attributes["st_ctime"], 1800000000.25)


    def test_directory_entries_supply_types_without_claiming_child_observations(self):
        binding = SimpleNamespace(Operations=object, FuseOSError=OSError, fuse_get_context=lambda: (0, 0, 0))
        spec = importlib.util.spec_from_file_location("directory_types_fixture", Path(__file__).resolve().parents[1] / "linux/filesystem.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"fusepy": binding}):
            spec.loader.exec_module(module)
        store = SimpleNamespace(db=MagicMock(), lock=threading.RLock(), capture=Mock(),
                                children=lambda *_: ["src/file", "src/directory", "src/symlink"],
                                metadata=lambda path, operation: {"kind": path.split("/")[-1]})
        filesystem = module.Filesystem(store, {})
        filesystem.context = lambda: ("operation", "owner")
        entries = filesystem.readdir("/src", None)
        self.assertEqual(entries, [".", "..", ("file", {"st_mode": stat.S_IFREG}, 0),
                                  ("directory", {"st_mode": stat.S_IFDIR}, 0), ("symlink", {"st_mode": stat.S_IFLNK}, 0)])
        store.capture.assert_called_once_with("operation", "src")
