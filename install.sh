#!/usr/bin/env bash
# SECode installer. Clones or updates the `secode` branch into ~/.secode/src,
# installs dependencies, builds the desktop app into ~/.secode/built, and on
# macOS copies it into /Applications. Run it again to update.
#
#   curl -fsSL https://raw.githubusercontent.com/spenserhale/t3code/secode/install.sh | bash
#
# or from any checkout: ./install.sh [--no-build] [--no-applications]
#
# Layout:
#   ~/.secode/src     clone of spenserhale/t3code on `secode`, managed by this script
#   ~/.secode/built   the built SECode.app and the zip it came from
#
# It never touches ~/.t3. SECode reads and writes that directory, the same one
# an official T3 Code install uses, so both see the same threads. Run one at a
# time, not both at once.
#
# Environment overrides: SECODE_HOME (default ~/.secode), SECODE_REPO (default
# the GitHub https URL), SECODE_BRANCH (default secode), SECODE_APPLICATIONS_DIR
# (default /Applications).
#
# Windows uses install.ps1 instead. This file lives on `fork-infra` and is
# merged into `secode`. It is fork-only and never goes upstream.
set -euo pipefail

SECODE_HOME="${SECODE_HOME:-$HOME/.secode}"
SECODE_REPO="${SECODE_REPO:-https://github.com/spenserhale/t3code.git}"
SECODE_BRANCH="${SECODE_BRANCH:-secode}"
APPLICATIONS_DIR="${SECODE_APPLICATIONS_DIR:-/Applications}"
SRC="$SECODE_HOME/src"
BUILT="$SECODE_HOME/built"
APP_ID="com.spenser.secode"

build=1
install_app=1
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0; install_app=0 ;;
    --no-applications) install_app=0 ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option '$arg'" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

command -v git >/dev/null || fail "git is not installed."

# --- source ---------------------------------------------------------------
# `secode` is rebuilt and force-pushed, so updating is a reset, not a pull.
# Local edits in ~/.secode/src would be lost, so refuse rather than discard.
if [ -d "$SRC/.git" ]; then
  step "updating $SRC to origin/$SECODE_BRANCH"
  [ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] ||
    fail "$SRC has local changes. It is managed by this script; commit them elsewhere or discard them first."
  git -C "$SRC" fetch --quiet origin "+refs/heads/$SECODE_BRANCH:refs/remotes/origin/$SECODE_BRANCH"
  git -C "$SRC" checkout --quiet -B "$SECODE_BRANCH" "origin/$SECODE_BRANCH"
else
  [ ! -e "$SRC" ] || fail "$SRC exists but is not a git checkout. Move it away and re-run."
  step "cloning $SECODE_REPO ($SECODE_BRANCH) into $SRC"
  mkdir -p "$SECODE_HOME"
  git clone --branch "$SECODE_BRANCH" --single-branch "$SECODE_REPO" "$SRC"
fi
cd "$SRC"
echo "at $(git log -1 --format='%h %s')"

# --- node -----------------------------------------------------------------
# Vite+ ships a Node that follows the repo's engines field; prefer it when present.
[ -d "$HOME/.vite-plus/bin" ] && PATH="$HOME/.vite-plus/bin:$PATH"
command -v node >/dev/null || fail "node is not installed. Install the version package.json's engines field names."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
want_major="$(node -p 'require("./package.json").engines.node.replace(/[^0-9.]/g, "").split(".")[0]')"
[ "$node_major" = "$want_major" ] ||
  echo "warning: node $node_major is on PATH, package.json asks for $want_major. The build may fail."

# --- pnpm -----------------------------------------------------------------
if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null ||
    fail "pnpm is missing and corepack is not available. Install pnpm, then re-run."
  echo "pnpm missing; enabling it through corepack"
  corepack enable
fi
corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate >/dev/null 2>&1 || true

# --- dependencies ---------------------------------------------------------
step "installing dependencies"
pnpm install
# The build script shells out to repo-local bins such as `vp`. pnpm scripts put
# node_modules/.bin on PATH themselves; plain `node` does not.
PATH="$SRC/node_modules/.bin:$PATH"

if [ "$build" = 0 ]; then
  echo; echo "Dependencies installed in $SRC. Skipped the desktop build (--no-build)."
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo
  echo "Desktop build and install are automated on macOS here and on Windows by"
  echo "install.ps1. From $SRC run"
  echo "  pnpm dist:desktop:linux    or    pnpm dev:desktop"
  exit 0
fi

# --- build ----------------------------------------------------------------
# The `zip` target yields one file holding the .app; the artifact script only
# copies files out of its stage, so a bare `dir` target would leave nothing.
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) fail "unsupported mac architecture $(uname -m)" ;;
esac
artifacts="$BUILT/artifacts"
step "building the desktop app ($arch); this takes several minutes"
rm -rf "$artifacts"
node scripts/build-desktop-artifact.ts --platform mac --target zip --arch "$arch" --output-dir "$artifacts"

zip="$(find "$artifacts" -maxdepth 1 -name '*.zip' | head -n 1)"
[ -n "$zip" ] || fail "the build produced no zip in $artifacts"

# Unpack next to the old app first, then swap, so a failed unpack keeps the old one.
unpacked="$BUILT/.unpack"
rm -rf "$unpacked"
mkdir -p "$unpacked"
ditto -x -k "$zip" "$unpacked"
app_src="$(find "$unpacked" -maxdepth 1 -name '*.app' | head -n 1)"
[ -n "$app_src" ] || fail "no .app inside $zip"
# Unsigned builds carry only Electron's linker stub signature (identifier
# "Electron", sealed resources missing). An ad-hoc re-sign seals the bundle
# under its own id, which is what macOS keys permissions and keychain items on.
codesign --force --deep --sign - "$app_src"
codesign --verify --deep --strict "$app_src" || fail "the re-signed app does not verify"
app_name="$(basename "$app_src")"
rm -rf "${BUILT:?}/$app_name"
mv "$app_src" "$BUILT/$app_name"
rm -rf "$unpacked"
echo "built $BUILT/$app_name"

# --- install --------------------------------------------------------------
installed_to="not copied"
if [ "$install_app" = 1 ]; then
  if [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null)" = "true" ]; then
    echo
    echo "SECode is running, so $APPLICATIONS_DIR was left alone. Quit it and run:"
    echo "  ditto \"$BUILT/$app_name\" \"$APPLICATIONS_DIR/$app_name\""
  else
    step "copying into $APPLICATIONS_DIR"
    [ -w "$APPLICATIONS_DIR" ] || fail "$APPLICATIONS_DIR is not writable. Re-run with SECODE_APPLICATIONS_DIR=\$HOME/Applications."
    rm -rf "${APPLICATIONS_DIR:?}/$app_name"
    ditto "$BUILT/$app_name" "$APPLICATIONS_DIR/$app_name"
    installed_to="$APPLICATIONS_DIR/$app_name"
    echo "installed $installed_to"
  fi
fi

cat <<EOF

SECode is installed.

  source   $SRC ($SECODE_BRANCH)
  build    $BUILT/$app_name
  app      $installed_to

State lives in ~/.t3, shared with the official T3 Code: threads and settings
show up in both. Run one at a time, not both at once.

To update, run this installer again.
EOF
