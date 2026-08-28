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

# Migrate old keepalive.service if present (pre-prefix)
if [ -f "$HOME/.config/systemd/user/keepalive.service" ] && [ ! -f "$HOME/.config/systemd/user/dsh-web-keepalive.service" ]; then
  mv "$HOME/.config/systemd/user/keepalive.service" "$HOME/.config/systemd/user/dsh-web-keepalive.service" 2>/dev/null || cp "$HOME/.config/systemd/user/keepalive.service" "$HOME/.config/systemd/user/dsh-web-keepalive.service" 2>/dev/null || true
  echo "migrated keepalive.service → dsh-web-keepalive.service"
fi
install_one "$SYSTEMD_DIR/dsh-web.service.template" "$HOME/.config/systemd/user/dsh-web.service"
install_one "$SYSTEMD_DIR/dsh-web-supervisor.service.template" "$HOME/.config/systemd/user/dsh-web-supervisor.service"
install_one "$SYSTEMD_DIR/dsh-web-keepalive.service.template" "$HOME/.config/systemd/user/dsh-web-keepalive.service"

# Auto-enable without requiring the user to run systemctl manually (plugin spirit):
# keepalive prevents user manager exit when manager session is Removed (11:42:58 crash),
# dsh-web + supervisor are the actual workloads. Linger keeps manager alive after reboot.
# All commands are best-effort — failures are logged but never block install (e.g. bus dead).
try_enable() {
  if command -v loginctl >/dev/null 2>&1; then
    if [ ! -f /var/lib/systemd/linger/"$USER" ]; then
      loginctl enable-linger "$USER" 2>/dev/null || true
    fi
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload 2>/dev/null || true
    # Disable old keepalive.service if it was previously enabled
    systemctl --user disable keepalive.service 2>/dev/null || true
    systemctl --user enable dsh-web-keepalive.service 2>/dev/null || true
    systemctl --user enable dsh-web.service 2>/dev/null || true
    systemctl --user enable dsh-web-supervisor.service 2>/dev/null || true
    # Try to start if bus is alive; if user manager is dead (Connection refused) this is a no-op
    # and the next reboot / manual `systemctl --user start` will pick it up.
    systemctl --user start dsh-web-keepalive.service 2>/dev/null || true
    systemctl --user stop keepalive.service 2>/dev/null || true
    systemctl --user start dsh-web.service 2>/dev/null || true
    systemctl --user start dsh-web-supervisor.service 2>/dev/null || true
  fi
}
try_enable

echo "done. Units installed and auto-enabled (best-effort):"
echo "  dsh-web-keepalive.service + dsh-web.service + dsh-web-supervisor.service"
echo "  linger: $(test -f /var/lib/systemd/linger/$USER && echo enabled || echo not-enabled)"
echo "  check: systemctl --user status dsh-web-keepalive dsh-web dsh-web-supervisor --no-pager"
