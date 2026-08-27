#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_DIR="$SCRIPT_DIR/../systemd"
# Detect harness root (three levels up from scripts/) — portable across machines
MAESTRO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

install_one() {
  local template="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  sed -e "s|%h|$HOME|g" -e "s|%MAESTRO_ROOT%|$MAESTRO_ROOT|g" "$template" > "$dest"
  echo "installed $dest (MAESTRO_ROOT=$MAESTRO_ROOT)"
}

install_one "$SYSTEMD_DIR/dsh-web.service.template" "$HOME/.config/systemd/user/dsh-web.service"
install_one "$SYSTEMD_DIR/dsh-web-supervisor.service.template" "$HOME/.config/systemd/user/dsh-web-supervisor.service"

echo "done. Run:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now dsh-web.service"
echo "  systemctl --user enable --now dsh-web-supervisor.service"
echo "  systemctl --user status dsh-web.service dsh-web-supervisor.service"
