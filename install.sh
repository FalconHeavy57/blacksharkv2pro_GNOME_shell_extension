#!/bin/bash
# Install the BlackShark V2 Pro GNOME Shell extension for the current user.
set -e
cd "$(dirname "$0")"

UUID="blackshark@blacksharkv2pro.dev"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "== checking environment =="
if ! command -v gnome-shell >/dev/null; then
    echo "ERROR: gnome-shell not found - this extension is for GNOME." >&2
    exit 1
fi
MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [ "$MAJOR" -lt 45 ]; then
    echo "ERROR: GNOME Shell 45 or newer is required (found $MAJOR)." >&2
    exit 1
fi
if ! gdbus call --session --dest org.razer --object-path /org/razer \
        --method razer.devices.getDevices >/dev/null 2>&1; then
    echo "WARNING: the OpenRazer daemon is not reachable on D-Bus." >&2
    echo "  The indicator will stay hidden until it is running (see README)." >&2
fi

echo "== installing =="
mkdir -p "${EXT_DIR}"
cp metadata.json extension.js "${EXT_DIR}/"
echo "Installed: ${EXT_DIR}"

echo "== enabling =="
if gnome-extensions enable "${UUID}" 2>/dev/null; then
    echo "Enabled. If the indicator does not appear, log out and back in once"
    echo "(a freshly installed extension is only picked up on login)."
else
    echo "Could not enable yet - the running shell has not seen the new"
    echo "extension. Log out and back in, then run:"
    echo "  gnome-extensions enable ${UUID}"
fi
