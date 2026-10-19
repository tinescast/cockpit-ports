#!/usr/bin/env bash
# Install or remove the cockpit-ports module.
#   ./install.sh                      install for the current user
#   sudo ./install.sh --system        install for all users
#   add --uninstall to remove
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/ports"
DEST="$HOME/.local/share/cockpit/ports"
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --system)    DEST="/usr/share/cockpit/ports" ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)   sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$UNINSTALL" = 1 ]; then
  rm -rf "$DEST"
  echo "Removed $DEST"
  exit 0
fi

mkdir -p "$DEST"
cp "$SRC"/manifest.json "$SRC"/index.html "$SRC"/ports.css "$SRC"/ports.js "$DEST"/
echo "Installed to $DEST"
echo "Reload Cockpit in your browser and open 'Ports' in the sidebar."
