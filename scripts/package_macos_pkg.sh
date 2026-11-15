#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/desktop/src-tauri/target/release/bundle/macos/MakeItDrumless.app"
OUT="$ROOT/desktop/src-tauri/target/release/bundle/macos/MakeItDrumless.pkg"
PKGROOT="$(mktemp -d)"
trap 'rm -rf "$PKGROOT"' EXIT
mkdir -p "$PKGROOT/Applications"
cp -R "$APP" "$PKGROOT/Applications/MakeItDrumless.app"
pkgbuild --root "$PKGROOT" --identifier com.makeitdrumless.desktop --version 0.1.0 \
  --scripts "$ROOT/desktop/src-tauri/macos/scripts" --install-location / "$OUT"
echo "Built installer: $OUT"
