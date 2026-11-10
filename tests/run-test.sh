#!/bin/bash
# Entry point: sets up a throwaway home/runtime dir, installs the extension
# from this checkout, and runs session-test.sh in a private D-Bus session.
# Meant for a disposable container (see .github/workflows/gnome-compat.yml);
# locally, see "Testing" in README.md.
set -euo pipefail

UUID=external-night-light@nathan-weinberg.github.io
SRC=$(cd "$(dirname "$0")/.." && pwd)

export HOME=$(mktemp -d)
export XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
export XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share
export ARTIFACTS_DIR=${ARTIFACTS_DIR:-$SRC/test-artifacts}
# Software rendering; there is no GPU in CI.
export LIBGL_ALWAYS_SOFTWARE=1

dest=$XDG_DATA_HOME/gnome-shell/extensions/$UUID
mkdir -p "$dest"
cp "$SRC/extension.js" "$SRC/metadata.json" "$dest/"

exec dbus-run-session -- "$SRC/tests/session-test.sh"
