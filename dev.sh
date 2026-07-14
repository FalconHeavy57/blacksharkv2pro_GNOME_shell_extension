#!/bin/bash
# Live-preview the extension in a NESTED GNOME Shell window (no relogin needed).
# Edit extension.js, close the window, run this again - two-second iteration.
set -e
cd "$(dirname "$0")"

UUID="blackshark@blacksharkv2pro.dev"

# sync the working tree into the installed extension dir
./install.sh >/dev/null 2>&1 || true

# make sure the uuid is in the enabled list (works even when the running
# shell doesn't know the extension yet; also covers the next real login)
python3 - <<'EOF'
import subprocess
uuid = "blackshark@blacksharkv2pro.dev"
out = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
                     capture_output=True, text=True).stdout.strip()
import ast
lst = [] if out in ("@as []", "[]") else list(ast.literal_eval(out))
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)])
    print("enabled-extensions: added", uuid)
EOF

echo "Opening nested shell (close the window to stop) ..."
echo "A private OpenRazer daemon runs inside it, so the indicator is live."
# the nested session gets a fresh D-Bus, so org.razer must be started on it;
# -F keeps the daemon in the foreground so it dies with the session
# GNOME >= 49 replaced the old "--nested" mode with the development kit
# (needs /usr/libexec/mutter-devkit: sudo dnf install mutter-devel).
# The private daemon gets its own run dir so its pidfile can't clash with
# the real session's daemon.
if [ ! -x /usr/libexec/mutter-devkit ]; then
    echo "NOTE: mutter-devkit is missing - install it with: sudo dnf install mutter-devel" >&2
fi
DEVRUN=$(mktemp -d /tmp/blackshark-devkit-razer.XXXXXX)
trap 'rm -rf "$DEVRUN"' EXIT
export DEVRUN
dbus-run-session -- sh -c \
    '(openrazer-daemon -F --run-dir "$DEVRUN" >/dev/null 2>&1 &) ; exec gnome-shell --devkit'
