#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$APPLICATIONS_DIR/specterew.desktop"
mkdir -p "$APPLICATIONS_DIR"

escaped_dir="${APP_DIR//\\/\\\\}"
escaped_dir="${escaped_dir//&/\\&}"
escaped_dir="${escaped_dir//|/\\|}"
sed "s|@APP_DIR@|$escaped_dir|g" "$APP_DIR/SpecterEW.desktop" > "$TARGET"
chmod 0755 "$TARGET"

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$APPLICATIONS_DIR" || true
fi

echo "Installed the Specter EW launcher at $TARGET"
