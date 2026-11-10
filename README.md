# Night Light for Gamma-less Displays

A GNOME Shell 48 extension that makes the built-in Night Light work on
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

## Install (development)

```sh
ln -s ~/Projects/gnome-external-night-light \
  ~/.local/share/gnome-shell/extensions/external-night-light@local
# log out and back in (Wayland), then:
gnome-extensions enable external-night-light@local
```

Logs: `journalctl --user -b -o cat /usr/bin/gnome-shell | grep external-night-light`

## Limitations

- The hardware cursor isn't tinted.
- Screenshots of these monitors include the tint, unlike hardware Night Light.
  Clutter 16 gives JS no reliable way to skip screenshot paints.
- Changes to the code only take effect after logging out and back in (Wayland).
