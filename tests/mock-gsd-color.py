#!/usr/bin/env python3
"""Stand-in for gsd-color's org.gnome.SettingsDaemon.Color on the session bus.

Only the two properties the extension reads are implemented. Temperature is
writable through org.freedesktop.DBus.Properties.Set (like the real daemon),
and every change emits PropertiesChanged, which is what drives the extension.
"""
import sys

from gi.repository import Gio, GLib

XML = """
<node>
  <interface name="org.gnome.SettingsDaemon.Color">
    <property name="Temperature" type="u" access="readwrite"/>
    <property name="NightLightActive" type="b" access="read"/>
  </interface>
</node>"""
IFACE = "org.gnome.SettingsDaemon.Color"
PATH = "/org/gnome/SettingsDaemon/Color"

state = {"Temperature": 6500}


def variant(name):
    if name == "Temperature":
        return GLib.Variant("u", state["Temperature"])
    return GLib.Variant("b", state["Temperature"] < 6500)


def get_property(conn, sender, path, iface, name):
    return variant(name)


def set_property(conn, sender, path, iface, name, value):
    if name != "Temperature":
        return False
    state["Temperature"] = value.unpack()
    changed = {n: variant(n) for n in ("Temperature", "NightLightActive")}
    conn.emit_signal(None, PATH, "org.freedesktop.DBus.Properties",
                     "PropertiesChanged",
                     GLib.Variant("(sa{sv}as)", (IFACE, changed, [])))
    return True


def on_bus(conn, name):
    info = Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0]
    conn.register_object(PATH, info, None, get_property, set_property)


def on_lost(conn, name):
    sys.exit(f"mock-gsd-color: could not own {name}")


loop = GLib.MainLoop()
Gio.bus_own_name(Gio.BusType.SESSION, IFACE, Gio.BusNameOwnerFlags.NONE,
                 on_bus, None, on_lost)
loop.run()
