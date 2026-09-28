#!/bin/sh
# latch installer — installs the product onto this machine from a local build
# (INV-11: no npm, no registry). Idempotent; re-running refreshes the install.
#
#   scripts/install.sh            install to $HOME/.latch + $HOME/.local/bin
#   PREFIX=/usr/local ...         override the command directory
#   LATCH_INSTALL_HOME=/opt/latch override the product home
#   scripts/install.sh --uninstall
#
# Layout:
#   $LATCH_INSTALL_HOME/bin/latch-harness     the SEA binary (standalone)
#   $LATCH_INSTALL_HOME/product/…             launcher + doctor + brand manifest
#   $PREFIX/latch                             the command on PATH
#
# The `latch` command runs the launcher (node), which fetches the live model
# catalog from the gateway, writes the 0600 provider config under
# $LATCH_INSTALL_HOME/v2, and execs the standalone harness binary.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PREFIX="${PREFIX:-$HOME/.local/bin}"
LATCH_HOME="${LATCH_INSTALL_HOME:-$HOME/.latch}"
PRODUCT_DIR="$LATCH_HOME/product"
BIN_DIR="$LATCH_HOME/bin"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$LATCH_HOME/bin" "$LATCH_HOME/product"
  rm -f "$PREFIX/latch"
  echo "latch: uninstalled (config and sessions under $LATCH_HOME/v2 were kept)"
  exit 0
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) SEABIN="latch-darwin-x64";;
  arm64|aarch64) SEABIN="latch-darwin-arm64";;
  *) echo "latch: unsupported arch '$ARCH' — install the SEA binary manually" >&2; exit 1;;
esac
SEA_SRC="$REPO_ROOT/apps/zcode-cli/packages/cli/dist/$SEABIN"
if [ ! -x "$SEA_SRC" ]; then
  echo "latch: $SEA_SRC not found — build it first: pnpm --dir apps/zcode-cli run build:sea" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$PREFIX"
cp -f "$SEA_SRC" "$BIN_DIR/latch-harness"
chmod 0755 "$BIN_DIR/latch-harness"

# Launcher + doctor + brand manifest keep their repo-relative layout so
# scripts/lib/brand.mjs still resolves product/identity/brand.yaml (INV-3).
rm -rf "$PRODUCT_DIR"
mkdir -p "$PRODUCT_DIR/product/identity"
cp -R "$REPO_ROOT/scripts" "$PRODUCT_DIR/scripts"
cp -f "$REPO_ROOT/product/identity/brand.yaml" "$PRODUCT_DIR/product/identity/brand.yaml"

cat > "$PREFIX/latch" <<EOF
#!/bin/sh
# latch product command — installed by scripts/install.sh
export LATCH_BIN="\${LATCH_BIN:-$BIN_DIR/latch-harness}"
export LATCH_HOME="\${LATCH_HOME:-$LATCH_HOME}"
exec node "$PRODUCT_DIR/scripts/latch.mjs" "\$@"
EOF
chmod 0755 "$PREFIX/latch"

cat > "$PREFIX/latch-doctor" <<EOF
#!/bin/sh
# latch doctor product command — installed by scripts/install.sh
exec node "$PRODUCT_DIR/scripts/latch-doctor.mjs" "\$@"
EOF
chmod 0755 "$PREFIX/latch-doctor"

echo "latch: installed"
echo "  harness : $BIN_DIR/latch-harness"
echo "  command : $PREFIX/latch  (doctor: $PREFIX/latch-doctor)"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "  NOTE    : $PREFIX is not on your PATH — add it to your shell profile";;
esac
echo "  login   : export LATCH_GATEWAY_URL=https://gateway.xlaunch.work LATCH_API_KEY=<your unified key>"
echo "  local   : LATCH_GATEWAY_URL=http://127.0.0.1:8787 LATCH_API_KEY=latch-key-pro (mock gateway)"
