#!/usr/bin/env bash
# Build a single native binary (~95 MB) containing:
#   - the Bun runtime
#   - bundled server JS
#   - SPA assets (base64-embedded)
#
# No native addons are embedded: password hashing uses the built-in
# Bun.password (argon2id), and the PTY uses Bun.spawn — both are part of the
# Bun runtime, so the binary is self-contained with no .node files.
#
# Usage:
#   npm run build
#   ARCH=linux-arm64 npm run build
#
# Bun is bootstrapped into ./.bun if not already on PATH.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Host = machine running this script (bootstrap bun must match).
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   HOST_RELEASE=linux-x64 ;;
  Linux-aarch64)  HOST_RELEASE=linux-aarch64 ;;
  Darwin-arm64)   HOST_RELEASE=darwin-aarch64 ;;
  Darwin-x86_64)  HOST_RELEASE=darwin-x64 ;;
  *) echo "unsupported host: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

# Target = ARCH env or native host (bun --compile --target).
case "${ARCH:-}" in
  "") case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)   ARCH=linux-x64 ;;
        Linux-aarch64)  ARCH=linux-arm64 ;;
        Darwin-arm64)   ARCH=darwin-arm64 ;;
        Darwin-x86_64)  ARCH=darwin-x64 ;;
        *) echo "unsupported host: $(uname -s) $(uname -m); set ARCH=..." >&2; exit 1 ;;
      esac ;;
esac

case "$ARCH" in
  linux-x64)    BUN_TARGET=bun-linux-x64;    TARGET_RELEASE=linux-x64 ;;
  linux-arm64)  BUN_TARGET=bun-linux-arm64;  TARGET_RELEASE=linux-aarch64 ;;
  darwin-x64)   BUN_TARGET=bun-darwin-x64;   TARGET_RELEASE=darwin-x64 ;;
  darwin-arm64) BUN_TARGET=bun-darwin-arm64; TARGET_RELEASE=darwin-aarch64 ;;
  *) echo "no Bun target mapping for $ARCH" >&2; exit 1 ;;
esac

if [ "$HOST_RELEASE" = "$TARGET_RELEASE" ]; then
  echo ">>> target: $ARCH (native)"
else
  echo ">>> target: $ARCH (cross-compile from $HOST_RELEASE host)"
fi

BUN_VERSION="${BUN_VERSION:-1.3.14}"
BUN_BIN=""

if [ -x ".bun/package/bin/bun" ]; then
  BUN_BIN="$ROOT/.bun/package/bin/bun"
elif command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
else
  echo ">>> bootstrapping Bun ${BUN_VERSION} (${HOST_RELEASE} host) into ./.bun"
  mkdir -p .bun
  ZIP=".bun/bun-${BUN_VERSION}-${HOST_RELEASE}.zip"
  if [ ! -f "$ZIP" ]; then
    curl --max-time 180 --retry 3 -fL \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-${HOST_RELEASE}.zip" \
      -o "$ZIP"
  fi
  rm -rf ".bun/extract"
  mkdir -p ".bun/extract" ".bun/package/bin"
  ( cd .bun/extract && unzip -q "../$(basename "$ZIP")" )
  cp ".bun/extract/bun-${HOST_RELEASE}/bun" ".bun/package/bin/bun"
  chmod +x ".bun/package/bin/bun"
  rm -rf ".bun/extract"
  BUN_BIN="$ROOT/.bun/package/bin/bun"
fi
echo ">>> using bun: $BUN_BIN ($($BUN_BIN --version))"

echo ">>> building web bundle"
npm run build:web > /dev/null
echo ">>> embedding web assets"
npm run build:embed > /dev/null

mkdir -p release
OUT="release/omas"
rm -rf "$OUT"
echo ">>> compiling single binary → $OUT"
# argon2 is a *native* npm addon and is only imported on the Node code path
# (under Bun we use the built-in Bun.password). Mark it external so the bundler
# doesn't pull its node-gyp-build loader into the binary — that loader would
# fail at runtime with "no native build was found for argon2".
NODE_ENV=production "$BUN_BIN" build src/server/index.ts \
  --compile \
  --target "$BUN_TARGET" \
  --minify \
  --external argon2 \
  --define 'process.env.NODE_ENV="production"' \
  --outfile "$OUT"

chmod +x "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo ""
echo "=================================================="
echo "  out: $OUT ($SIZE)"
echo "  run: OMAS_PASSWORD=hunter2 $OUT serve --port 7681"
echo "  install: $OUT install --prefix ~/.local/bin"
echo "=================================================="
