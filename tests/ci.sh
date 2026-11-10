#!/bin/bash
# Installs test dependencies in a disposable Fedora container (as root), then
# runs the test. See "Testing" in README.md.
set -euo pipefail

if [[ ${SKIP_INSTALL:-} != 1 ]]; then
    dnf -y -q install --setopt=install_weak_deps=False \
        gnome-shell mesa-dri-drivers colord-libs dbus-daemon dconf \
        python3-gobject python3-pillow glib2 >/dev/null
fi

# gnome-shell talks to the system bus at startup (accounts, upower, ...).
# There is no logind in a container; without /run/systemd/seats the shell
# uses its dummy login manager instead of trying to activate logind.
rm -rf /run/systemd/seats
mkdir -p /run/dbus
dbus-daemon --system --fork

exec "$(dirname "$0")/run-test.sh"
