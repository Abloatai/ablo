"""Run replacement-host regression against the adapter archive that will ship."""
import importlib.util
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest


with tempfile.TemporaryDirectory(prefix="ablo-packed-recovery-") as directory:
    with tarfile.open(sys.argv[1], "r:gz") as archive:
        for name in ("store", "identity"):
            source = archive.extractfile(f"package/linux/{name}.py")
            if source is None:
                raise RuntimeError(f"Missing packaged {name}.py")
            Path(directory, f"{name}.py").write_bytes(source.read())
    sys.path.insert(0, directory)
    # Load the packaged modules before the test adds its source checkout path.
    import store

    assert Path(store.__file__).parent == Path(directory)
    test = Path(__file__).resolve().parents[2] / "resource-adapter/tests/test_store.py"
    spec = importlib.util.spec_from_file_location("packed_store_tests", test)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    suite = unittest.TestSuite([
        module.Publication("test_restored_workspace_can_allocate_on_a_replacement_host"),
    ])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        sys.exit(1)
