# Night Light for Gamma-less Displays

A GNOME Shell 48–51 extension that makes the built-in Night Light work on
monitors whose driver has no gamma lookup table. The main case is DisplayLink
docks running on the `evdi` driver (for example via
[displaylink-rpm](https://github.com/displaylink-rpm/displaylink-rpm)).

## Why

GNOME Night Light tints each display by writing a scaled gamma ramp to its
CRTC. `evdi` CRTCs report a gamma ramp of size 0, so GNOME skips them without
an error. You can confirm this with:

```sh
# get CRTC ids from GetResources, then:
gdbus call --session --dest org.gnome.Mutter.DisplayConfig \
  --object-path /org/gnome/Mutter/DisplayConfig \
  --method org.gnome.Mutter.DisplayConfig.GetCrtcGamma <serial> <crtc>
# -> (@aq [], @aq [], @aq []) on DisplayLink outputs
```

## How it works

- Finds active outputs whose CRTC has an empty gamma ramp (through
  `org.gnome.Mutter.DisplayConfig`).
- Reads the live Night Light temperature from
  `org.gnome.SettingsDaemon.Color`, the same value Mutter uses. That includes
  the schedule, the fades and "disable until tomorrow".
- Converts the temperature to RGB with colord's
  `cd_color_get_blackbody_rgb_full(..., USE_PLANCKIAN)`, the same call Mutter
  makes, so the tint matches the displays that do support gamma.
- Puts a non-reactive overlay above each of those monitors at the top of
  `Main.uiGroup`, painted with a Cogl multiply blend (`dst = src × dst`).
  That's the same per-channel scaling a gamma ramp does, with no offscreen pass,
  and monitors that support gamma aren't touched. The overlays are hidden when
  the temperature is 6500K.

The per-monitor multiply overlay is adapted from
[eitanf1336's DisplayLink Night Light](https://github.com/eitanf1336/dotfiles/tree/HEAD/gnome-extensions/displaylink-nightlight@eitan.local)
(MIT).

## Requirements

- GNOME Shell 48, 49, 50 or 51
- colord's GObject introspection data (`Colord-1.0.typelib`). Fedora installs
  it by default; on Debian/Ubuntu it's `gir1.2-colord-1.0`.

## Install (development)

```sh
ln -s ~/Projects/gnome-external-night-light \
  ~/.local/share/gnome-shell/extensions/external-night-light@nathan-weinberg.github.io
# log out and back in (Wayland), then:
gnome-extensions enable external-night-light@nathan-weinberg.github.io
```

Logs: `journalctl --user -b -o cat /usr/bin/gnome-shell | grep external-night-light`

## Testing

`.github/workflows/gnome-compat.yml` runs `tests/` on every Fedora release
that ships a supported GNOME (42 → 48, 43 → 49, 44 → 50, 45 → 51), plus
rawhide as an early warning. Each job starts a real headless `gnome-shell`
with a virtual monitor and a mock `gsd-color`, then checks that the extension:

- loads, and runs its monitor detection without logging errors;
- tints the screen by exactly the factors colord gives Mutter for 3000K
  (compared with screenshots taken before and after);
- removes its overlay when disabled.

Headless virtual monitors don't show up in `DisplayConfig.GetResources`, so
the test points the extension at the virtual monitor by hand. The detection
itself is only checked for not erroring. The test loads the extension even
when `metadata.json` doesn't list that GNOME version, and prints a warning
when that's the case.

Run one version locally:

```sh
podman run --rm --privileged -v "$PWD:/src:z" -w /src \
  registry.fedoraproject.org/fedora:43 tests/ci.sh
```

`--privileged` is needed because GNOME 49+ encodes screenshots through
glycin, which sandboxes its loaders with bubblewrap. Logs and screenshots go
to `test-artifacts/`.

## Packaging for extensions.gnome.org

```sh
gnome-extensions pack --force \
  --extra-source=LICENSE --extra-source=THIRD-PARTY-NOTICES.md
```

This writes `external-night-light@nathan-weinberg.github.io.shell-extension.zip`,
which you upload at https://extensions.gnome.org/upload/.

## Limitations

- The hardware cursor isn't tinted.
- Screenshots of these monitors include the tint, unlike hardware Night Light.
  Clutter 16 gives JS no reliable way to skip screenshot paints.
- Changes to the code only take effect after logging out and back in (Wayland).

## License

MIT. See [LICENSE](LICENSE). The overlay technique is adapted from MIT-licensed
work; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
