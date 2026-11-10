// Night Light for monitors whose KMS driver exposes no gamma LUT (DisplayLink /
// evdi). GNOME's Night Light works by having Mutter write a per-CRTC gamma
// ramp scaled by a blackbody color; on evdi CRTCs that ramp has size 0, so
// nothing happens. This extension reproduces the same scaling by painting a
// multiply-blended overlay over each of those monitors.
//
// - Temperature: read live from gsd-color's D-Bus "Temperature" property, the
//   same value Mutter consumes (it includes the smooth fade in/out).
// - Color: colord's cd_color_get_blackbody_rgb_full(..., USE_PLANCKIAN), the
//   exact function Mutter uses, so tints match the gamma-capable displays.
// - Which monitors: any active CRTC for which Mutter reports an empty gamma
//   ramp (org.gnome.Mutter.DisplayConfig.GetCrtcGamma).
// - How: one non-reactive actor per monitor on top of Main.uiGroup, painted
//   with a Cogl multiply blend (dst = src * dst). Unlike a shader effect on
//   the whole UI, this needs no offscreen pass and leaves other monitors
//   untouched. The per-monitor multiply overlay technique is adapted from
//   eitanf1336's DisplayLink Night Light (MIT):
//   https://github.com/eitanf1336/dotfiles/tree/HEAD/gnome-extensions/displaylink-nightlight@eitan.local

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Colord from 'gi://Colord';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const LOG_TAG = '[external-night-light]';
const NEUTRAL_TEMPERATURE = 6500;

// result = SRC_COLOR * DST_COLOR: scales each channel of what is already on
// screen, which is exactly what a scaled gamma ramp does.
// (Cogl's blend-string grammar has no ZERO color source; the literal 0 is the
// documented way to drop the second term.)
const MULTIPLY_BLEND = 'RGBA = ADD(SRC_COLOR*(DST_COLOR), 0)';

const TintOverlay = GObject.registerClass(
class TintOverlay extends Clutter.Actor {
    _init() {
        super._init({reactive: false});
        this._color = new Cogl.Color();
        this._color.init_from_4f(1, 1, 1, 1);
        this._pipeline = null;
        this._failed = false;
    }

    setColor([r, g, b]) {
        this._color.init_from_4f(r, g, b, 1);
        this._pipeline?.set_color(this._color);
        this.queue_redraw();
    }

    // Note: unlike hardware Night Light, this tint shows up in screenshots of
    // these monitors. Clutter 16 gives JS no way to tell a screenshot paint
    // from a stage view (rotated views also render offscreen), so it can't be
    // skipped reliably.
    vfunc_paint_node(root, paintContext) {
        const [w, h] = this.get_size();
        if (this._failed || w <= 0 || h <= 0)
            return;

        if (!this._pipeline) {
            try {
                const ctx = paintContext.get_framebuffer().get_context();
                const pipeline = Cogl.Pipeline.new(ctx);
                pipeline.set_blend(MULTIPLY_BLEND);
                pipeline.set_color(this._color);
                this._pipeline = pipeline;
            } catch (e) {
                // Don't throw on every frame; log once and stop painting.
                this._failed = true;
                console.error(`${LOG_TAG} creating multiply pipeline: ${e.message}`);
                return;
            }
        }

        const node = Clutter.PipelineNode.new(this._pipeline);
        node.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}));
        root.add_child(node);
    }
});

const DisplayConfigIface = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetResources">
      <arg name="serial" direction="out" type="u"/>
      <arg name="crtcs" direction="out" type="a(uxiiiiiuaua{sv})"/>
      <arg name="outputs" direction="out" type="a(uxiausauaua{sv})"/>
      <arg name="modes" direction="out" type="a(uxuudu)"/>
      <arg name="max_screen_width" direction="out" type="i"/>
      <arg name="max_screen_height" direction="out" type="i"/>
    </method>
    <method name="GetCrtcGamma">
      <arg name="serial" direction="in" type="u"/>
      <arg name="crtc" direction="in" type="u"/>
      <arg name="red" direction="out" type="aq"/>
      <arg name="green" direction="out" type="aq"/>
      <arg name="blue" direction="out" type="aq"/>
    </method>
  </interface>
</node>`;

const ColorIface = `
<node>
  <interface name="org.gnome.SettingsDaemon.Color">
    <property name="Temperature" type="u" access="readwrite"/>
    <property name="NightLightActive" type="b" access="read"/>
  </interface>
</node>`;

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);
const ColorProxy = Gio.DBusProxy.makeProxyWrapper(ColorIface);

export default class ExternalNightLightExtension extends Extension {
    enable() {
        this._overlays = [];
        this._connectors = []; // connectors whose CRTC has no gamma LUT
        this._temperature = NEUTRAL_TEMPERATURE;
        this._refreshSerial = 0;

        this._displayConfig = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error)
                    console.error(`${LOG_TAG} DisplayConfig: ${error.message}`);
                else
                    this._refreshMonitors();
            });

        this._color = new ColorProxy(Gio.DBus.session,
            'org.gnome.SettingsDaemon.Color', '/org/gnome/SettingsDaemon/Color',
            (proxy, error) => {
                if (error) {
                    console.error(`${LOG_TAG} gsd-color: ${error.message}`);
                    return;
                }
                if (!this._color)
                    return; // disabled before the proxy finished initializing
                this._colorChangedId = proxy.connect('g-properties-changed',
                    () => this._updateTemperature());
                this._updateTemperature();
            });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._refreshMonitors());
        // Keep the overlays above anything added to uiGroup later.
        this._childAddedId = Main.uiGroup.connect('child-added',
            (group, child) => {
                if (!this._overlays.includes(child))
                    this._raiseOverlays();
            });
    }

    disable() {
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        if (this._childAddedId)
            Main.uiGroup.disconnect(this._childAddedId);
        if (this._colorChangedId)
            this._color.disconnect(this._colorChangedId);
        this._monitorsChangedId = this._childAddedId = this._colorChangedId = null;

        this._destroyOverlays();
        this._overlays = null;
        this._color = null;
        this._displayConfig = null;
        this._refreshSerial++; // invalidate in-flight async refreshes
    }

    _updateTemperature() {
        const t = this._color?.Temperature;
        this._temperature = t && t >= 1000 && t <= 10000 ? t : NEUTRAL_TEMPERATURE;
        this._update();
    }

    async _refreshMonitors() {
        if (!this._displayConfig)
            return;
        const serial = ++this._refreshSerial;
        try {
            const [resSerial, , outputs] = await this._displayConfig.GetResourcesAsync();
            const connectors = [];
            for (const [, , crtc, , name] of outputs) {
                if (crtc < 0)
                    continue;
                const [red] = await this._displayConfig.GetCrtcGammaAsync(resSerial, crtc);
                if (red.length === 0)
                    connectors.push(name);
            }
            if (serial !== this._refreshSerial)
                return;
            this._connectors = connectors;
            console.log(`${LOG_TAG} displays without gamma: ${connectors.join(', ') || 'none'}`);
            this._rebuildOverlays();
        } catch (e) {
            if (serial === this._refreshSerial)
                console.error(`${LOG_TAG} refreshing monitors: ${e.message}`);
        }
    }

    _rebuildOverlays() {
        this._destroyOverlays();
        const monitorManager = global.backend.get_monitor_manager();
        for (const connector of this._connectors) {
            const index = monitorManager.get_monitor_for_connector(connector);
            const m = Main.layoutManager.monitors[index];
            if (index < 0 || !m)
                continue;
            const overlay = new TintOverlay();
            overlay.set_position(m.x, m.y);
            overlay.set_size(m.width, m.height);
            // uiGroup tears its children down at logout without calling
            // disable(); forget the overlay so later updates don't touch it.
            overlay.connect('destroy', () => {
                const i = this._overlays?.indexOf(overlay) ?? -1;
                if (i >= 0)
                    this._overlays.splice(i, 1);
            });
            Main.uiGroup.add_child(overlay);
            this._overlays.push(overlay);
        }
        this._raiseOverlays();
        this._update();
    }

    _raiseOverlays() {
        for (const overlay of this._overlays)
            Main.uiGroup.set_child_above_sibling(overlay, null);
    }

    _destroyOverlays() {
        // Copy: each destroy() removes itself from this._overlays.
        for (const overlay of [...this._overlays ?? []])
            overlay.destroy();
        if (this._overlays)
            this._overlays.length = 0;
    }

    _update() {
        if (!this._overlays?.length)
            return;
        const active = this._temperature < NEUTRAL_TEMPERATURE;

        const rgb = new Colord.ColorRGB();
        if (!active || !Colord.color_get_blackbody_rgb_full(this._temperature, rgb,
            Colord.ColorBlackbodyFlags.USE_PLANCKIAN))
            rgb.R = rgb.G = rgb.B = 1;

        for (const overlay of this._overlays) {
            overlay.setColor([rgb.R, rgb.G, rgb.B]);
            overlay.visible = active;
        }
    }
}
