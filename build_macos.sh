#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
"$PYTHON" tools/make_platform_icons.py
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
    --icon "$ROOT/assets/specterew.icns"
    --collect-all rasterio
    --collect-all shapely
    --collect-all PIL
    --collect-all certifi
)
"$PYTHON" -m PyInstaller "${COMMON_ARGS[@]}" --onedir app.py
VALIDATION_EXE="$ROOT/build/validation-dist/SpecterEW/SpecterEW"
"$PYTHON" tools/smoke_test_executable.py "$VALIDATION_EXE"

"$PYTHON" -m PyInstaller --noconfirm --clean SpecterEW.spec
FINAL_EXE="$ROOT/dist/SpecterEW"
"$PYTHON" tools/smoke_test_executable.py "$FINAL_EXE"

# Build the Finder-launchable app separately from the terminal executable.
"$PYTHON" -m PyInstaller --noconfirm --clean --distpath dist/app \
    --workpath build/app-work SpecterEWApp.spec
APP_BUNDLE="$ROOT/dist/app/SpecterEW.app"
"$PYTHON" tools/smoke_test_executable.py "$APP_BUNDLE/Contents/MacOS/SpecterEW"

ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|arm64) ;;
    *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
esac

TERMINAL_DIR="$ROOT/build/package-macos-$ARCH"
mkdir -p "$TERMINAL_DIR"
install -m 0755 "$FINAL_EXE" "$TERMINAL_DIR/SpecterEW"
tar -C "$TERMINAL_DIR" -czf "release/SpecterEW-macos-$ARCH.tar.gz" SpecterEW
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" \
    "release/SpecterEW-macos-$ARCH-app.zip"

echo "Built macOS $ARCH artifacts in $ROOT/release"
