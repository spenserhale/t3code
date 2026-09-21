#!/usr/bin/env bash
# SECode installer. Run from the root of a checkout of spenserhale/t3code:
#
#   git clone git@github.com:spenserhale/t3code.git secode && cd secode
#   git checkout secode && ./install.sh
#
# Gets the dependencies in place and tells you how to run. It never touches
# ~/.t3: SECode shares that directory with an official T3 Code install, so the
# two take turns rather than running at once.
#
# This file lives on `fork-infra` and is merged into `secode`. It is fork-only
# and never goes upstream.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail() { echo "error: $*" >&2; exit 1; }

# --- branch ---------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "secode" ]; then
  echo "warning: on branch '$branch', not 'secode'."
  echo "         'secode' is the branch that carries every patch. Switch with:"
  echo "           git fetch origin && git checkout secode"
  echo
fi

# --- node -----------------------------------------------------------------
command -v node >/dev/null || fail "node is not installed. This needs Node 24."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
want_major="$(node -p 'require("./package.json").engines.node.replace(/[^0-9.]/g, "").split(".")[0]')"
[ "$node_major" = "$want_major" ] ||
  echo "warning: node $node_major is installed, package.json asks for $want_major."

# --- pnpm -----------------------------------------------------------------
if ! command -v pnpm >/dev/null; then
  command -v corepack >/dev/null ||
    fail "pnpm is missing and corepack is not available. Install pnpm, then re-run."
  echo "pnpm missing; enabling it through corepack"
  corepack enable
fi
corepack prepare "$(node -p 'require("./package.json").packageManager')" --activate >/dev/null 2>&1 || true

# --- dependencies ---------------------------------------------------------
echo "installing dependencies (this takes a few minutes the first time)"
pnpm install

# --- report ---------------------------------------------------------------
cat <<'EOF'

SECode is installed.

  pnpm dev                 run the server and web client for this checkout
  pnpm dev:desktop         run the Electron desktop app
  pnpm build:desktop       build a desktop bundle
  pnpm dist:desktop:dmg    package a macOS .dmg

State lives in ~/.t3, the same directory the official T3 Code uses. Do not run
SECode and an official build at the same time; one at a time is safe, and
either can open the other's threads.

To update later, because `secode` is force-pushed on every rebuild:

  git fetch origin && git reset --hard origin/secode && ./install.sh
EOF
