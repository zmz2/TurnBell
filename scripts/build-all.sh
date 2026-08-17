#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$ROOT/extension/manifest.json")}"
rm -rf "$ROOT/dist"
python3 "$ROOT/scripts/package-artifacts.py" --root "$ROOT" --version "$VERSION"
python3 "$ROOT/scripts/verify-artifacts.py" --root "$ROOT" --version "$VERSION"
