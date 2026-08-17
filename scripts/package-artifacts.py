#!/usr/bin/env python3
"""Build deterministic extension-only release artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import stat
import zipfile

FIXED_TIMESTAMP = (2026, 8, 16, 0, 0, 0)
RUNTIME_EXCLUDED_PARTS = {"tests", "__pycache__", ".git"}
PROJECT_EXCLUDED_PARTS = {"dist", "__pycache__", ".git", ".pytest_cache"}
EXCLUDED_NAMES = {".DS_Store"}
STATIC_RELEASE_ROOT_FILES = (
    "README.md",
    "INSTALL-WINDOWS.md",
    "CHANGELOG.md",
    "PRIVACY.md",
    "LICENSE",
    "Install-Or-Update-Current-Edge.cmd",
    "Open-Windows-Notification-Settings.cmd",
)

def release_root_files(version: str) -> tuple[str, ...]:
    return (*STATIC_RELEASE_ROOT_FILES, f"VERIFICATION-{version}.txt")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def iter_files(root: Path, excluded_parts: set[str]) -> list[Path]:
    result: list[Path] = []
    for candidate in root.rglob("*"):
        if not candidate.is_file() or candidate.is_symlink():
            continue
        relative = candidate.relative_to(root)
        if any(part in excluded_parts for part in relative.parts):
            continue
        if candidate.name in EXCLUDED_NAMES or candidate.suffix in {".pyc", ".pyo"}:
            continue
        result.append(candidate)
    return sorted(result, key=lambda item: item.relative_to(root).as_posix())


def add_bytes(
    archive: zipfile.ZipFile,
    arcname: str,
    data: bytes,
    mode: int = 0o644,
) -> None:
    info = zipfile.ZipInfo(arcname.replace("\\", "/"), FIXED_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | mode) << 16
    archive.writestr(info, data)


def add_file(archive: zipfile.ZipFile, source: Path, arcname: str) -> None:
    mode = 0o755 if source.suffix in {".sh", ".py"} else 0o644
    add_bytes(archive, arcname, source.read_bytes(), mode)


def read_manifest(root: Path, version: str) -> dict:
    manifest_path = root / "extension" / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("extension must use Manifest V3")
    if manifest.get("version") != version:
        raise ValueError(
            f"manifest version {manifest.get('version')!r} does not match {version!r}",
        )
    return manifest


def build_extension_zip(root: Path, dist: Path, version: str) -> Path:
    read_manifest(root, version)
    output = dist / f"TurnBell-{version}-extension.zip"
    extension_root = root / "extension"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in iter_files(extension_root, RUNTIME_EXCLUDED_PARTS):
            add_file(archive, source, source.relative_to(extension_root).as_posix())
    return output


def build_release_zip(root: Path, dist: Path, version: str) -> Path:
    read_manifest(root, version)
    output = dist / f"TurnBell-{version}-Edge-Only.zip"
    prefix = f"TurnBell-{version}-Edge-Only"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in release_root_files(version):
            source = root / name
            if not source.is_file():
                raise ValueError(f"missing release file: {source}")
            add_file(archive, source, f"{prefix}/{name}")
        add_bytes(archive, f"{prefix}/VERSION.txt", f"{version}\n".encode("utf-8"))
        extension_root = root / "extension"
        for source in iter_files(extension_root, RUNTIME_EXCLUDED_PARTS):
            relative = source.relative_to(extension_root).as_posix()
            add_file(archive, source, f"{prefix}/extension/{relative}")
    return output


def build_project_zip(root: Path, dist: Path, version: str) -> Path:
    read_manifest(root, version)
    output = dist / f"TurnBell-{version}-project.zip"
    prefix = f"TurnBell-{version}-project"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source in iter_files(root, PROJECT_EXCLUDED_PARTS):
            relative = source.relative_to(root).as_posix()
            add_file(archive, source, f"{prefix}/{relative}")
    return output


def write_checksums(dist: Path, artifacts: list[Path]) -> Path:
    output = dist / "SHA256SUMS.txt"
    rows = [f"{sha256(path)}  {path.name}" for path in sorted(artifacts, key=lambda item: item.name)]
    output.write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")
    return output


def build_all(root: Path, dist: Path, version: str) -> dict[str, Path]:
    root = root.resolve()
    dist = dist.resolve()
    dist.mkdir(parents=True, exist_ok=True)
    extension = build_extension_zip(root, dist, version)
    release = build_release_zip(root, dist, version)
    project = build_project_zip(root, dist, version)
    checksums = write_checksums(dist, [extension, release, project])
    return {
        "extension": extension,
        "release": release,
        "project": project,
        "checksums": checksums,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--dist", type=Path)
    parser.add_argument("--version")
    args = parser.parse_args()
    root = args.root.resolve()
    dist = (args.dist or root / "dist").resolve()
    version = args.version or json.loads(
        (root / "extension" / "manifest.json").read_text(encoding="utf-8"),
    )["version"]
    for path in build_all(root, dist, version).values():
        print(path)


if __name__ == "__main__":
    main()
