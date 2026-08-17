from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "package-artifacts.py"
VERSION = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]


def load_module():
    spec = importlib.util.spec_from_file_location("package_artifacts", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load packaging module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PackageLayoutTest(unittest.TestCase):
    def test_release_is_extension_only_and_contains_update_entrypoint(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            artifacts = module.build_all(ROOT, dist, VERSION)
            release = artifacts["release"]
            prefix = f"TurnBell-{VERSION}-Edge-Only/"
            with zipfile.ZipFile(release) as archive:
                names = set(archive.namelist())
            self.assertIn(prefix + "Install-Or-Update-Current-Edge.cmd", names)
            self.assertIn(prefix + "Open-Windows-Notification-Settings.cmd", names)
            self.assertIn(prefix + "PRIVACY.md", names)
            self.assertIn(prefix + f"VERIFICATION-{VERSION}.txt", names)
            self.assertIn(prefix + "extension/manifest.json", names)
            self.assertNotIn(prefix + "TurnBell.exe", names)
            self.assertFalse(any(name.endswith(".exe") for name in names))
            self.assertFalse(any("extension/tests/" in name for name in names))


    def test_installer_preserves_existing_unpackaged_extension_path_to_avoid_duplicate_ids(self) -> None:
        script = (ROOT / "Install-Or-Update-Current-Edge.cmd").read_text(encoding="utf-8")
        self.assertIn(r"%LOCALAPPDATA%\GPTReplyNotifier\extension", script)
        self.assertIn(r"%LOCALAPPDATA%\TurnBell\extension", script)
        self.assertIn(r'if exist "%LEGACY_TARGET%\manifest.json"', script)
        self.assertIn('robocopy "%SOURCE%" "%TARGET%" /MIR', script)

    def test_extension_zip_is_manifest_v3_runtime_only(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = module.build_all(ROOT, Path(temporary), VERSION)
            with zipfile.ZipFile(artifacts["extension"]) as archive:
                names = set(archive.namelist())
                manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(manifest["manifest_version"], 3)
            self.assertEqual(manifest["version"], VERSION)
            self.assertEqual(
                set(manifest.get("permissions", [])),
                {"notifications", "storage", "offscreen", "scripting"},
            )
            self.assertEqual(
                set(manifest.get("host_permissions", [])),
                {"https://chatgpt.com/*", "https://chat.openai.com/*"},
            )
            self.assertFalse(any(name.startswith("tests/") for name in names))
            for forbidden in (
                "src/main-world-stream.js",
                "src/stream-metadata-core.js",
                "src/network-core.js",
                "src/completion-ledger-core.js",
                "assets/sounds/done.wav",
            ):
                self.assertNotIn(forbidden, names)

    def test_project_archive_contains_tests_but_no_legacy_native_helper(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = module.build_all(ROOT, Path(temporary), VERSION)
            prefix = f"TurnBell-{VERSION}-project/"
            with zipfile.ZipFile(artifacts["project"]) as archive:
                names = set(archive.namelist())
            self.assertIn(prefix + "extension/tests/background-integration.test.js", names)
            self.assertIn(prefix + "scripts/package-artifacts.py", names)
            self.assertFalse(any(name.startswith(prefix + "native/") for name in names))
            self.assertFalse(any(name.endswith(".exe") for name in names))


if __name__ == "__main__":
    unittest.main()
