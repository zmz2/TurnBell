#!/usr/bin/env python3
"""Build a deterministic runtime-only extension ZIP for embedding/distribution."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import zipfile

EXCLUDED_PARTS = {"tests", "__pycache__", ".git"}
EXCLUDED_NAMES = {".DS_Store"}
FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)


def runtime_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for candidate in root.rglob("*"):
        relative = candidate.relative_to(root)
        if not candidate.is_file():
            continue
        if any(part in EXCLUDED_PARTS for part in relative.parts):
            continue
        if candidate.name in EXCLUDED_NAMES:
            continue
        files.append(candidate)
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


def build(source: Path, output: Path) -> None:
    manifest_path = source / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"Missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("Only Manifest V3 extensions are supported")

    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file_path in runtime_files(source):
            relative = file_path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(relative, FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file_path.read_bytes())
    temp.replace(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("extension"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.source.resolve(), args.output.resolve())


if __name__ == "__main__":
    main()
