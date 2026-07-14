#!/bin/bash
# Remove the BlackShark V2 Pro GNOME Shell extension.
set -e

UUID="blackshark@blacksharkv2pro.dev"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

gnome-extensions disable "${UUID}" 2>/dev/null || true
if [ -d "${EXT_DIR}" ]; then
    rm -rf "${EXT_DIR}"
    echo "Removed: ${EXT_DIR}"
else
    echo "Not installed: ${EXT_DIR}"
fi
echo "Done. The indicator disappears immediately; the files are gone for good."
