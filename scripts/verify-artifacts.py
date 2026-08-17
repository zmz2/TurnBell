#!/usr/bin/env python3
"""Verify extension-only release archives and checksums."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

REQUIRED_PERMISSIONS = {"notifications", "storage", "offscreen", "scripting"}
REQUIRED_HOSTS = {"https://chatgpt.com/*", "https://chat.openai.com/*"}
FORBIDDEN_RUNTIME_FILES = {
    "src/main-world-stream.js",
    "src/stream-metadata-core.js",
    "src/network-core.js",
    "src/completion-ledger-core.js",
    "assets/sounds/done.wav",
}
FORBIDDEN_RUNTIME_MARKERS = (
    b"chrome.webRequest",
    b"globalThis.fetch =",
    b"window.fetch =",
    b"stream-final",
    b"MAIN_WORLD_SOURCE",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_members(archive: zipfile.ZipFile) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError(f"unsafe ZIP member: {info.filename}")
        if info.is_dir():
            continue
        result[info.filename] = archive.read(info)
    return result


def assert_extension_manifest(manifest_bytes: bytes, version: str) -> dict:
    manifest = json.loads(manifest_bytes)
    if manifest.get("manifest_version") != 3:
        raise ValueError("extension is not Manifest V3")
    if manifest.get("version") != version:
        raise ValueError("extension version mismatch")
    permissions = set(manifest.get("permissions", []))
    if permissions != REQUIRED_PERMISSIONS:
        raise ValueError(
            f"permissions must be exactly {sorted(REQUIRED_PERMISSIONS)}, got {sorted(permissions)}",
        )
    hosts = set(manifest.get("host_permissions", []))
    if hosts != REQUIRED_HOSTS:
        raise ValueError(f"host permissions must be exactly {sorted(REQUIRED_HOSTS)}, got {sorted(hosts)}")
    return manifest


def verify_extension_zip(path: Path, version: str) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        members = safe_members(archive)
    if "manifest.json" not in members:
        raise ValueError("extension ZIP has no root manifest.json")
    assert_extension_manifest(members["manifest.json"], version)
    if any(name.startswith("tests/") for name in members):
        raise ValueError("runtime extension ZIP contains tests")
    if any(name.lower().endswith(".exe") for name in members):
        raise ValueError("runtime extension ZIP contains an executable")
    forbidden_files = FORBIDDEN_RUNTIME_FILES.intersection(members)
    if forbidden_files:
        raise ValueError(f"runtime extension ZIP contains removed interception files: {sorted(forbidden_files)}")
    for name, data in members.items():
        if not name.endswith(".js"):
            continue
        for marker in FORBIDDEN_RUNTIME_MARKERS:
            if marker in data:
                raise ValueError(f"runtime JavaScript contains forbidden interception marker {marker!r}: {name}")
    return members


def verify_release_zip(path: Path, version: str, extension_members: dict[str, bytes]) -> None:
    prefix = f"TurnBell-{version}-Edge-Only/"
    required = {
        prefix + "README.md",
        prefix + "INSTALL-WINDOWS.md",
        prefix + "CHANGELOG.md",
        prefix + "PRIVACY.md",
        prefix + "LICENSE",
        prefix + "Install-Or-Update-Current-Edge.cmd",
        prefix + "Open-Windows-Notification-Settings.cmd",
        prefix + f"VERIFICATION-{version}.txt",
        prefix + "VERSION.txt",
        prefix + "extension/manifest.json",
    }
    with zipfile.ZipFile(path) as archive:
        members = safe_members(archive)
    missing = required - set(members)
    if missing:
        raise ValueError(f"release ZIP missing files: {sorted(missing)}")
    if any(not name.startswith(prefix) for name in members):
        raise ValueError("release ZIP contains files outside its top-level directory")
    if any(name.lower().endswith(".exe") for name in members):
        raise ValueError("extension-only release contains an EXE")
    if any("extension/tests/" in name for name in members):
        raise ValueError("release ZIP contains extension tests")
    assert_extension_manifest(members[prefix + "extension/manifest.json"], version)
    for name, data in extension_members.items():
        release_name = prefix + "extension/" + name
        if members.get(release_name) != data:
            raise ValueError(f"release extension differs from standalone extension: {name}")


def verify_project_zip(path: Path, version: str) -> None:
    prefix = f"TurnBell-{version}-project/"
    required = {
        prefix + "README.md",
        prefix + "extension/manifest.json",
        prefix + "extension/tests/background-integration.test.js",
        prefix + "scripts/package-artifacts.py",
        prefix + "scripts/verify-artifacts.py",
    }
    with zipfile.ZipFile(path) as archive:
        members = safe_members(archive)
    missing = required - set(members)
    if missing:
        raise ValueError(f"project ZIP missing files: {sorted(missing)}")
    if any(name.startswith(prefix + "native/") for name in members):
        raise ValueError("project ZIP contains the removed native helper")
    if any(name.lower().endswith(".exe") for name in members):
        raise ValueError("project ZIP contains an EXE")
    if any(name.startswith(prefix + "dist/") for name in members):
        raise ValueError("project ZIP contains its own dist directory")
    assert_extension_manifest(members[prefix + "extension/manifest.json"], version)


def verify_checksums(path: Path, dist: Path) -> None:
    rows = [row.strip() for row in path.read_text(encoding="utf-8").splitlines() if row.strip()]
    if not rows:
        raise ValueError("checksum file is empty")
    for row in rows:
        expected, filename = row.split(maxsplit=1)
        artifact = dist / filename.lstrip("*")
        if not artifact.is_file():
            raise ValueError(f"checksum references a missing file: {artifact.name}")
        actual = sha256(artifact)
        if actual != expected:
            raise ValueError(f"checksum mismatch for {artifact.name}")


def verify_all(root: Path, version: str) -> None:
    dist = root / "dist"
    extension = dist / f"TurnBell-{version}-extension.zip"
    release = dist / f"TurnBell-{version}-Edge-Only.zip"
    project = dist / f"TurnBell-{version}-project.zip"
    checksums = dist / "SHA256SUMS.txt"
    for path in (extension, release, project, checksums):
        if not path.is_file():
            raise ValueError(f"missing artifact: {path}")
    extension_members = verify_extension_zip(extension, version)
    verify_release_zip(release, version, extension_members)
    verify_project_zip(project, version)
    verify_checksums(checksums, dist)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--version")
    args = parser.parse_args()
    root = args.root.resolve()
    version = args.version or json.loads(
        (root / "extension" / "manifest.json").read_text(encoding="utf-8"),
    )["version"]
    verify_all(root, version)
    print("Artifact verification passed: safe ZIP paths/CRC, Manifest V3, extension-only layout, byte-identical runtime, and SHA-256.")


if __name__ == "__main__":
    main()
