#!/bin/bash
# Installs test dependencies in a disposable Fedora or Ubuntu container (as
# root), then runs the test. See "Testing" in README.md.
set -euo pipefail

. /etc/os-release

if [[ ${SKIP_INSTALL:-} != 1 ]]; then
    case $ID in
    fedora)
        dnf -y -q install --setopt=install_weak_deps=False \
            gnome-shell mesa-dri-drivers colord-libs dbus-daemon dconf \
            python3-gobject python3-pillow glib2 >/dev/null
        ;;
    ubuntu)
        export DEBIAN_FRONTEND=noninteractive
        apt-get -qq update
        # gir1.2-colord-1.0 is a separate package on Ubuntu (the extension
        # needs it); the rest mirror the Fedora list.
        apt-get -qq install --no-install-recommends \
            gnome-shell libgl1-mesa-dri gir1.2-colord-1.0 dbus-daemon \
            dconf-gsettings-backend python3-gi python3-pil libglib2.0-bin \
            >/dev/null
        ;;
    *)
        echo "unsupported distro: $ID" >&2
        exit 1
        ;;
    esac
fi

# gnome-shell talks to the system bus at startup (accounts, upower, ...).
# There is no logind in a container; without /run/systemd/seats the shell
# uses its dummy login manager instead of trying to activate logind.
rm -rf /run/systemd/seats
mkdir -p /run/dbus
dbus-daemon --system --fork

exec "$(dirname "$0")/run-test.sh"
