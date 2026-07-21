/* SPDX-License-Identifier: GPL-2.0-or-later */
/* BlackShark V2 Pro battery + quick settings for the GNOME top bar.
 * Talks to the OpenRazer daemon over D-Bus (org.razer on the session bus).
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

const BUS = 'org.razer';
const POLL_SECONDS = 30;
// The mute button is a physical control on the earcup, so poll it more often
// than the battery - a 30 s lag on a mute indicator is useless. Each read is
// a couple of short USB exchanges, so this stays cheap.
const MUTE_POLL_SECONDS = 5;
// Shown next to the headset icon only while the mic is muted on the device.
const MIC_MUTED_ICON = 'microphone-disabled-symbolic';

const PRESETS = [
    ['game', 'Game'],
    ['music', 'Music'],
    ['movie', 'Movie'],
    ['game1', 'Game EQ 1'],
    ['game2', 'Game EQ 2'],
    ['game3', 'Game EQ 3'],
    ['game4', 'Game EQ 4'],
    ['game5', 'Game EQ 5'],
    ['custom', 'Custom'],
];

const SLEEP_CHOICES = [
    [0, 'Off'],
    [15, '15 minutes'],
    [30, '30 minutes'],
    [45, '45 minutes'],
    [60, '60 minutes'],
];

function dbusCall(path, iface, method, args = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            BUS, path, iface, method, args, null,
            Gio.DBusCallFlags.NONE, 3000, null,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res).recursiveUnpack());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

const Indicator = GObject.registerClass(
class BlacksharkIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'BlackShark V2 Pro');

        this._devicePath = null;
        this._updatingUi = false;
        this._micLevelTimeout = null;
        // Sidetone is a single 0-100 value in the daemon API where 0 means
        // off; the daemon scales it to the headset's own range.
        // The menu splits it into a switch and a slider, so remember the last
        // non-zero level to restore when the switch goes back on.
        this._sidetoneLevel = 70;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            icon_name: 'audio-headset-symbolic',
            style_class: 'system-status-icon',
        }));
        // Struck-through mic, visible only while the headset's own mute
        // button is engaged. Sits between the headset icon and the battery.
        this._muteIcon = new St.Icon({
            icon_name: MIC_MUTED_ICON,
            style_class: 'system-status-icon',
            visible: false,
        });
        box.add_child(this._muteIcon);
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refreshMenu().catch(() => {});
        });

        this.visible = false;
        this._refreshBattery().catch(() => {});
        this._refreshMuteIcon().catch(() => {});
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refreshBattery().catch(() => {});
            return GLib.SOURCE_CONTINUE;
        });
        this._mutePoll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, MUTE_POLL_SECONDS, () => {
            this._refreshMuteIcon().catch(() => {});
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        this._statusItem = new PopupMenu.PopupMenuItem('BlackShark V2 Pro', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._presetSub = new PopupMenu.PopupSubMenuMenuItem('Equalizer preset');
        this._presetItems = new Map();
        for (const [key, label] of PRESETS) {
            const item = new PopupMenu.PopupMenuItem(label);
            // keep the menu open: bypass the default activate-and-close
            item.activate = () => this._setPreset(key);
            this._presetItems.set(key, item);
            this._presetSub.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._presetSub);

        this._sleepSub = new PopupMenu.PopupSubMenuMenuItem('Auto power-off');
        this._sleepItems = new Map();
        for (const [minutes, label] of SLEEP_CHOICES) {
            const item = new PopupMenu.PopupMenuItem(label);
            // keep the menu open: bypass the default activate-and-close
            item.activate = () => this._setSleep(minutes);
            this._sleepItems.set(minutes, item);
            this._sleepSub.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(this._sleepSub);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._micSwitch = new PopupMenu.PopupSwitchMenuItem('Sidetone', false);
        // keep the menu open when toggling
        this._micSwitch.activate = () => this._micSwitch.toggle();
        this._micSwitch.connect('toggled', (_item, state) => {
            if (this._updatingUi || !this._devicePath)
                return;
            this._setSidetone(state ? this._sidetoneLevel : 0);
        });
        this.menu.addMenuItem(this._micSwitch);

        const levelItem = new PopupMenu.PopupBaseMenuItem({activate: false});
        levelItem.add_child(new St.Label({
            text: 'Sidetone level',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._micSlider = new Slider.Slider(0.7);
        this._micSlider.connect('notify::value', () => {
            if (this._updatingUi || !this._devicePath)
                return;
            // a drag emits many changes; debounce before writing
            if (this._micLevelTimeout)
                GLib.source_remove(this._micLevelTimeout);
            this._micLevelTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._micLevelTimeout = null;
                const level = Math.round(this._micSlider.value * 100);
                if (level > 0) {
                    this._sidetoneLevel = level;
                    // moving the slider implies "on"
                    this._updatingUi = true;
                    this._micSwitch.setToggleState(true);
                    this._updatingUi = false;
                }
                this._setSidetone(level);
                return GLib.SOURCE_REMOVE;
            });
        });
        levelItem.add_child(this._micSlider);
        this.menu.addMenuItem(levelItem);

        this._dndSwitch = new PopupMenu.PopupSwitchMenuItem('Do not disturb', false);
        // keep the menu open when toggling
        this._dndSwitch.activate = () => this._dndSwitch.toggle();
        this._dndSwitch.connect('toggled', (_item, state) => {
            if (this._updatingUi || !this._devicePath)
                return;
            dbusCall(this._devicePath, 'razer.device.misc', 'setDnd',
                new GLib.Variant('(b)', [state])).catch(() => {});
        });
        this.menu.addMenuItem(this._dndSwitch);

        if (GLib.find_program_in_path('blackshark-gui')) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const guiItem = new PopupMenu.PopupMenuItem('Open control app');
            guiItem.connect('activate', () => {
                try {
                    Gio.Subprocess.new(['blackshark-gui'],
                        Gio.SubprocessFlags.NONE);
                } catch (_e) {
                    // app not installed or not launchable; nothing to do
                }
            });
            this.menu.addMenuItem(guiItem);
        }
    }

    async _findDevice() {
        const [serials] = await dbusCall('/org/razer', 'razer.devices', 'getDevices');
        for (const serial of serials) {
            const path = `/org/razer/device/${serial}`;
            const [name] = await dbusCall(path, 'razer.device.misc', 'getDeviceName');
            if (name.includes('BlackShark'))
                return path;
        }
        return null;
    }

    async _refreshBattery() {
        try {
            if (!this._devicePath)
                this._devicePath = await this._findDevice();
            if (!this._devicePath)
                throw new Error('no device');

            const [battery] = await dbusCall(this._devicePath, 'razer.device.power', 'getBattery');
            const [charging] = await dbusCall(this._devicePath, 'razer.device.power', 'isCharging');
            this._label.text = `${Math.round(battery)}%${charging ? ' ⚡' : ''}`;
            this._statusItem.label.text =
                `BlackShark V2 Pro — battery ${Math.round(battery)}%${charging ? ', charging' : ''}`;
            this.visible = true;
        } catch (_e) {
            // headset off/unplugged (or daemon down): hide, rediscover on the next poll
            this._devicePath = null;
            this._muteIcon.visible = false;
            this.visible = false;
        }
    }

    /* Track the headset's own mute button (read-only on the device) and show
     * the struck-through mic in the panel while it is engaged. */
    async _refreshMuteIcon() {
        if (!this._devicePath) {
            this._muteIcon.visible = false;
            return;
        }
        try {
            const [muted] = await dbusCall(this._devicePath, 'razer.device.audio', 'getMicMute');
            this._muteIcon.visible = !!muted;
        } catch (_e) {
            // older daemon without getMicMute, or the headset went away
            this._muteIcon.visible = false;
        }
    }

    _setSidetone(level) {
        if (!this._devicePath)
            return;
        dbusCall(this._devicePath, 'razer.device.audio', 'setSidetone',
            new GLib.Variant('(y)', [level])).catch(() => {});
    }

    async _refreshMenu() {
        await this._refreshBattery();
        if (!this._devicePath)
            return;
        this._updatingUi = true;
        try {
            const [preset] = await dbusCall(this._devicePath, 'razer.device.audio', 'getEqualizerPreset');
            for (const [key, item] of this._presetItems) {
                item.setOrnament(key === preset
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }

            const [seconds] = await dbusCall(this._devicePath, 'razer.device.power', 'getIdleTime');
            const minutes = Math.round(seconds / 60);
            for (const [choice, item] of this._sleepItems) {
                item.setOrnament(choice === minutes
                    ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            }

            const [sidetone] = await dbusCall(this._devicePath, 'razer.device.audio', 'getSidetone');
            this._micSwitch.setToggleState(sidetone > 0);
            if (sidetone > 0)
                this._sidetoneLevel = sidetone;
            this._micSlider.value = this._sidetoneLevel / 100;

            const [dnd] = await dbusCall(this._devicePath, 'razer.device.misc', 'getDnd');
            this._dndSwitch.setToggleState(dnd);
        } catch (_e) {
            // partial refresh is fine; battery/presence already handled
        } finally {
            this._updatingUi = false;
        }
    }

    _setPreset(key) {
        if (!this._devicePath)
            return;
        // optimistic check-mark; the write is confirmed by the next refresh
        for (const [k, item] of this._presetItems) {
            item.setOrnament(k === key
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        dbusCall(this._devicePath, 'razer.device.audio', 'setEqualizerPreset',
            new GLib.Variant('(s)', [key]))
            .catch(() => this._refreshMenu().catch(() => {}));
    }

    _setSleep(minutes) {
        if (!this._devicePath)
            return;
        for (const [choice, item] of this._sleepItems) {
            item.setOrnament(choice === minutes
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        dbusCall(this._devicePath, 'razer.device.power', 'setIdleTime',
            new GLib.Variant('(q)', [minutes * 60]))
            .catch(() => this._refreshMenu().catch(() => {}));
    }

    destroy() {
        if (this._poll) {
            GLib.source_remove(this._poll);
            this._poll = null;
        }
        if (this._mutePoll) {
            GLib.source_remove(this._mutePoll);
            this._mutePoll = null;
        }
        if (this._micLevelTimeout) {
            GLib.source_remove(this._micLevelTimeout);
            this._micLevelTimeout = null;
        }
        super.destroy();
    }
});

export default class BlacksharkExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
