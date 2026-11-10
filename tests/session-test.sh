#!/bin/bash
# Runs inside a private D-Bus session (see run-test.sh). Starts a headless
# gnome-shell with the extension enabled, then checks that it:
#   1. loads without errors,
#   2. runs its gamma-less monitor detection without errors, and puts a tint
#      overlay on the headless virtual monitor,
#   3. tints the screen by exactly Mutter's Night Light factors when the
#      temperature drops (driven by a mock gsd-color), and
#   4. disables cleanly.
set -euo pipefail

UUID=external-night-light@nathan-weinberg.github.io
HERE=$(cd "$(dirname "$0")" && pwd)
ART=${ARTIFACTS_DIR:-$PWD/test-artifacts}
mkdir -p "$ART"
LOG=$ART/gnome-shell.log

fail() { echo "FAIL: $*" >&2; exit 1; }

shell_eval() {
    # Prints the JSON result of evaluating $1 in gnome-shell (unsafe mode).
    local out
    out=$(gdbus call --session --dest org.gnome.Shell \
        --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1") \
        || return 1
    python3 -c '
import ast, sys
out = sys.argv[1].strip()  # gdbus prints e.g. (true, "<json>")
ok = out.startswith("(true,")
res = ast.literal_eval(out[out.index(",") + 1:-1].strip())
print(res)
sys.exit(0 if ok else 1)' "$out"
}

wait_for() { # wait_for <seconds> <description> <command...>
    local secs=$1 what=$2
    shift 2
    for ((i = 0; i < secs * 4; i++)); do
        "$@" >/dev/null 2>&1 && return 0
        sleep 0.25
    done
    fail "timed out after ${secs}s waiting for $what"
}

set_temperature() {
    gdbus call --session --dest org.gnome.SettingsDaemon.Color \
        --object-path /org/gnome/SettingsDaemon/Color \
        --method org.freedesktop.DBus.Properties.Set \
        org.gnome.SettingsDaemon.Color Temperature "<uint32 $1>" >/dev/null
}

screenshot() { # screenshot <file>; prints the mean RGB of the whole screen
    gdbus call --session --dest org.gnome.Shell.Screenshot \
        --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$1" >/dev/null
    # Newer shells reply before the PNG is fully written.
    wait_for 10 "screenshot $1" python3 "$HERE/mean-rgb.py" "$1"
    python3 "$HERE/mean-rgb.py" "$1"
}

cleanup() {
    [[ -n ${SHELL_PID:-} ]] && kill "$SHELL_PID" 2>/dev/null || true
    [[ -n ${MOCK_PID:-} ]] && kill "$MOCK_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT

# The mock must be up before the shell so the extension finds Temperature.
python3 -W ignore::DeprecationWarning "$HERE/mock-gsd-color.py" &
MOCK_PID=$!
wait_for 10 "mock gsd-color" gdbus introspect --session \
    --dest org.gnome.SettingsDaemon.Color --object-path /org/gnome/SettingsDaemon/Color

gsettings set org.gnome.shell enabled-extensions "['$UUID']"
# Load the extension even when metadata.json doesn't list this shell version
# yet: the point is to find out whether the code works there.
gsettings set org.gnome.shell disable-extension-version-validation true
# No welcome dialog / tour on first login.
gsettings set org.gnome.shell welcome-dialog-last-shown-version '999' 2>/dev/null || true

gnome-shell --version
gnome-shell --headless --wayland --no-x11 --unsafe-mode \
    --virtual-monitor 1280x720 >"$LOG" 2>&1 &
SHELL_PID=$!

wait_for 60 "gnome-shell to start" \
    shell_eval 'if (Main.layoutManager._startingUp) throw new Error(); true'

# --- 1. extension loaded -------------------------------------------------
# ExtensionState: ACTIVE/ENABLED = 1 on every supported version, ERROR = 3.
info=$(shell_eval "(() => {
    const e = Main.extensionManager.lookup('$UUID');
    return e ? {state: e.state, error: e.error ?? null} : null;
})()") || fail "Eval failed: $info"
echo "extension: $info"
python3 -c '
import json, sys
info = json.loads(sys.argv[1])
if info is None: sys.exit("extension not found by the shell")
if info["state"] != 1: sys.exit(f"extension not active: {info}")' "$info" \
    || fail "extension did not load"

overlay_state='(() => {
    const ext = Main.extensionManager.lookup("'$UUID'").stateObj;
    const o = ext._overlays ?? [];
    return {
        connectors: ext._connectors,
        overlays: o.length,
        visible: o.filter(a => a.visible).length,
        inUiGroup: o.filter(a => a.get_parent() === Main.uiGroup).length,
    };
})()'

ov() { # ov <field>: prints one numeric field of $overlay_state
    shell_eval "$overlay_state" | python3 -c \
        'import json, sys; print(json.loads(sys.stdin.read())[sys.argv[1]])' "$1"
}

# --- 2. monitor detection + overlay --------------------------------------
# The detection path (DisplayConfig.GetResources / GetCrtcGamma) already ran
# in enable(); any D-Bus or API breakage there is logged and caught by the log
# check at the end. Headless virtual monitors aren't listed by GetResources,
# though, so it finds nothing to tint. Point the extension at the virtual
# monitor's connector by hand so the overlay/paint path gets exercised.
sleep 2
echo "detected gamma-less connectors: $(shell_eval "$overlay_state")"
shell_eval '(() => {
    const ext = Main.extensionManager.lookup("'$UUID'").stateObj;
    const mm = global.backend.get_monitor_manager();
    if (mm.get_monitor_for_connector("Meta-0") < 0)
        throw new Error("no virtual monitor Meta-0");
    ext._connectors = ["Meta-0"];
    ext._rebuildOverlays();
})()' >/dev/null || fail "could not attach overlay to the virtual monitor"
has_overlay() { (($(ov inUiGroup) > 0)); }
wait_for 15 "an overlay on the virtual monitor" has_overlay
echo "at 6500K: $(shell_eval "$overlay_state")"

# --- 3. tint applied -----------------------------------------------------
# Close the startup overview and let animations settle so the two
# screenshots differ only by the tint.
shell_eval 'Main.overview.hide()' >/dev/null
overview_hidden() { [[ $(shell_eval 'Main.overview.visible || Main.overview.animationInProgress') == false ]]; }
wait_for 10 "the overview to close" overview_hidden
sleep 2
read -r r0 g0 b0 < <(screenshot "$ART/neutral.png")
echo "neutral mean RGB: $r0 $g0 $b0"

TEMP=3000
set_temperature $TEMP
is_visible() { (($(ov visible) > 0)); }
wait_for 10 "the overlay to become visible" is_visible
echo "at ${TEMP}K: $(shell_eval "$overlay_state")"
sleep 1
read -r r1 g1 b1 < <(screenshot "$ART/tinted.png")
echo "tinted  mean RGB: $r1 $g1 $b1"

# A multiply blend scales every pixel by a constant per channel, so the mean
# of each channel must scale by exactly the blackbody factor Mutter would put
# in the gamma ramp.
python3 - $TEMP "$r0" "$g0" "$b0" "$r1" "$g1" "$b1" <<'EOF' || fail "tint does not match Night Light"
import sys
import gi
gi.require_version("Colord", "1.0")
from gi.repository import Colord

temp = int(sys.argv[1])
before = list(map(float, sys.argv[2:5]))
after = list(map(float, sys.argv[5:8]))
rgb = Colord.ColorRGB()
Colord.color_get_blackbody_rgb_full(temp, rgb, Colord.ColorBlackbodyFlags.USE_PLANCKIAN)
expected = [rgb.R, rgb.G, rgb.B]
bad = []
for name, b, a, e in zip("RGB", before, after, expected):
    # 8-bit rounding of dark pixels costs up to ~1.5 levels per channel.
    ok = abs(a - b * e) <= max(2.0, 0.04 * b)
    print(f"{name}: {b:6.1f} -> {a:6.1f}  expected {b * e:6.1f} (x{e:.3f})  {'ok' if ok else 'MISMATCH'}")
    if not ok:
        bad.append(name)
if before[2] < 20:
    sys.exit("neutral screenshot has too little blue to measure the tint")
if bad:
    sys.exit(f"channels off: {bad}")
EOF

set_temperature 6500
is_hidden() { (($(ov visible) == 0)); }
wait_for 10 "the overlay to hide again" is_hidden

# --- 4. clean disable ----------------------------------------------------
count_overlays='Main.uiGroup.get_children().filter(a => a.constructor.name === "TintOverlay").length'
before=$(shell_eval "$count_overlays")
shell_eval "Main.extensionManager.disableExtension('$UUID')" >/dev/null
sleep 1
state=$(shell_eval "Main.extensionManager.lookup('$UUID').state")
after=$(shell_eval "$count_overlays")
echo "disable: state $state, overlays in uiGroup $before -> $after"
((before == 1)) || fail "expected exactly one overlay in uiGroup before disable"
((after == 0)) || fail "overlays left behind after disable"
[[ $state == 1 ]] && fail "extension still active after disable"

# --- log check -----------------------------------------------------------
# Uncaught JS errors carry the extension's path in their stack trace; its own
# console.error calls carry the log tag. Neither should appear.
if grep -nF -e "$UUID" -e '[external-night-light]' "$LOG"; then
    fail "extension logged errors (full log: $LOG)"
fi

# --- metadata ------------------------------------------------------------
# The test forces the extension to load regardless of metadata.json; say so
# when this shell would actually refuse it (or EGO wouldn't list it).
major=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if ! python3 -c 'import json, sys; sys.exit(sys.argv[2] not in json.load(open(sys.argv[1]))["shell-version"])' \
        "$HERE/../metadata.json" "$major"; then
    msg="Works on GNOME $major, but metadata.json shell-version doesn't list \"$major\""
    [[ -n ${GITHUB_ACTIONS:-} ]] && echo "::warning title=GNOME $major not declared::$msg" || echo "WARNING: $msg"
fi

echo "PASS: $(gnome-shell --version)"
