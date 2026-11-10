// Night Light for monitors whose KMS driver exposes no gamma LUT (DisplayLink /
// evdi). GNOME's Night Light works by having Mutter write a per-CRTC gamma
// ramp scaled by a blackbody color; on evdi CRTCs that ramp has size 0, so
// nothing happens. This extension reproduces the same scaling in a shader,
// restricted to the screen rectangles of those monitors.
//
// - Temperature: read live from gsd-color's D-Bus "Temperature" property, the
//   same value Mutter consumes (it includes the smooth fade in/out).
// - Color: colord's cd_color_get_blackbody_rgb_full(..., USE_PLANCKIAN), the
//   exact function Mutter uses, so tints match the gamma-capable displays.
// - Which monitors: any active CRTC for which Mutter reports an empty gamma
//   ramp (org.gnome.Mutter.DisplayConfig.GetCrtcGamma).

import Cogl from 'gi://Cogl';
import Colord from 'gi://Colord';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const EFFECT_NAME = 'external-night-light';
const MAX_RECTS = 4;
const NEUTRAL_TEMPERATURE = 6500;
const RECT_INDICES = [...Array(MAX_RECTS).keys()];

const SHADER_DECLARATIONS = `
uniform vec3 nl_factor;
${RECT_INDICES.map(i => `uniform vec4 nl_rect${i};`).join('\n')}

bool nl_inside(vec2 p, vec4 r) {
  return r.z > r.x && p.x >= r.x && p.x < r.z && p.y >= r.y && p.y < r.w;
}
`;

const SHADER_CODE = `
vec2 nl_pos = cogl_tex_coord_in[0].xy;
if (${RECT_INDICES.map(i => `nl_inside(nl_pos, nl_rect${i})`).join(' || ')})
  cogl_color_out.rgb *= nl_factor;
`;

const NightLightEffect = GObject.registerClass(
class NightLightEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._factorLoc = this.get_uniform_location('nl_factor');
        this._rectLocs = RECT_INDICES.map(i => this.get_uniform_location(`nl_rect${i}`));
        this.setFactor([1, 1, 1]);
        this.setRects([]);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            SHADER_DECLARATIONS, SHADER_CODE, false);
    }

    setFactor(rgb) {
        this.set_uniform_float(this._factorLoc, 3, rgb);
        this.queue_repaint();
    }

    // rects: [[x0, y0, x1, y1], ...] in normalized (0..1) actor coordinates
    setRects(rects) {
        for (const i of RECT_INDICES)
            this.set_uniform_float(this._rectLocs[i], 4, rects[i] ?? [0, 0, 0, 0]);
        this.queue_repaint();
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
        this._effect = new NightLightEffect();
        this._attached = false;
        this._connectors = []; // connectors whose CRTC has no gamma LUT
        this._temperature = NEUTRAL_TEMPERATURE;
        this._refreshSerial = 0;

        this._displayConfig = new DisplayConfigProxy(Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error)
                    console.error(`[${EFFECT_NAME}] DisplayConfig: ${error.message}`);
                else
                    this._refreshMonitors();
            });

        this._color = new ColorProxy(Gio.DBus.session,
            'org.gnome.SettingsDaemon.Color', '/org/gnome/SettingsDaemon/Color',
            (proxy, error) => {
                if (error) {
                    console.error(`[${EFFECT_NAME}] gsd-color: ${error.message}`);
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
        this._stageSizeId = global.stage.connect('notify::size',
            () => this._update());
    }

    disable() {
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        if (this._stageSizeId)
            global.stage.disconnect(this._stageSizeId);
        if (this._colorChangedId)
            this._color.disconnect(this._colorChangedId);
        this._monitorsChangedId = this._stageSizeId = this._colorChangedId = null;

        this._detach();
        this._effect = null;
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
            console.log(`[${EFFECT_NAME}] displays without gamma: ${connectors.join(', ') || 'none'}`);
            this._update();
        } catch (e) {
            if (serial === this._refreshSerial)
                console.error(`[${EFFECT_NAME}] refreshing monitors: ${e.message}`);
        }
    }

    _computeRects() {
        const monitorManager = global.backend.get_monitor_manager();
        const [stageW, stageH] = global.stage.get_size();
        if (!stageW || !stageH)
            return [];
        const rects = [];
        for (const connector of this._connectors) {
            const index = monitorManager.get_monitor_for_connector(connector);
            const m = Main.layoutManager.monitors[index];
            if (index < 0 || !m)
                continue;
            rects.push([m.x / stageW, m.y / stageH,
                (m.x + m.width) / stageW, (m.y + m.height) / stageH]);
        }
        return rects.slice(0, MAX_RECTS);
    }

    _update() {
        if (!this._effect)
            return;
        const rects = this._computeRects();
        if (this._temperature >= NEUTRAL_TEMPERATURE || rects.length === 0) {
            this._detach();
            return;
        }

        const rgb = new Colord.ColorRGB();
        if (!Colord.color_get_blackbody_rgb_full(this._temperature, rgb,
            Colord.ColorBlackbodyFlags.USE_PLANCKIAN))
            rgb.R = rgb.G = rgb.B = 1;

        this._effect.setFactor([rgb.R, rgb.G, rgb.B]);
        this._effect.setRects(rects);
        if (!this._attached) {
            // Only pay for the offscreen pass while there is something to tint.
            Main.uiGroup.add_effect_with_name(EFFECT_NAME, this._effect);
            this._attached = true;
        }
    }

    _detach() {
        if (this._attached) {
            Main.uiGroup.remove_effect(this._effect);
            this._attached = false;
        }
    }
}
