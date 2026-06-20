#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VENV_DIR="${VENV_DIR:-$ROOT/.venv-build}"
PYTHON_BIN="${PYTHON:-python3.12}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    PYTHON_BIN=python3
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
PYTHON="$VENV_DIR/bin/python"

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
    "$PYTHON" -m pip install --upgrade pip
    "$PYTHON" -m pip install -r requirements.txt -r requirements-build.txt
fi

"$PYTHON" -m unittest
"$PYTHON" packaging/tools/make_platform_icons.py
rm -rf build/validation-dist build/validation-work dist release
mkdir -p release

COMMON_ARGS=(
    --noconfirm --clean --noupx
    --specpath build/onedir-spec
    --workpath build/validation-work
    --distpath build/validation-dist
    --name SpecterEW
    --add-data "$ROOT/templates:templates"
    --add-data "$ROOT/static:static"
    --add-data "$ROOT/LICENSE:."
    --collect-all rasterio
    --collect-all shapely
    --collect-all PIL
    --collect-all certifi
)
"$PYTHON" -m PyInstaller "${COMMON_ARGS[@]}" --onedir app.py
VALIDATION_EXE="$ROOT/build/validation-dist/SpecterEW/SpecterEW"
"$PYTHON" packaging/tools/smoke_test_executable.py "$VALIDATION_EXE"

"$PYTHON" -m PyInstaller --noconfirm --clean packaging/pyinstaller/SpecterEW.spec
FINAL_EXE="$ROOT/dist/SpecterEW"
"$PYTHON" packaging/tools/smoke_test_executable.py "$FINAL_EXE"

TERMINAL_DIR="$ROOT/build/package-linux-terminal"
DESKTOP_DIR="$ROOT/build/package-linux-desktop"
mkdir -p "$TERMINAL_DIR" "$DESKTOP_DIR"
install -m 0755 "$FINAL_EXE" "$TERMINAL_DIR/SpecterEW"
install -m 0755 "$FINAL_EXE" "$DESKTOP_DIR/SpecterEW"
install -m 0755 packaging/linux/SpecterEW.desktop "$DESKTOP_DIR/SpecterEW.desktop"
install -m 0755 packaging/linux/install-desktop.sh "$DESKTOP_DIR/install-desktop.sh"
install -m 0644 packaging/linux/README.txt "$DESKTOP_DIR/README.txt"
install -m 0644 assets/specterew.png "$DESKTOP_DIR/specterew.png"

tar -C "$TERMINAL_DIR" -czf release/SpecterEW-linux-x86_64.tar.gz SpecterEW
tar -C "$DESKTOP_DIR" -czf release/SpecterEW-linux-desktop-x86_64.tar.gz \
    SpecterEW SpecterEW.desktop install-desktop.sh README.txt specterew.png

echo "Built Linux artifacts in $ROOT/release"
