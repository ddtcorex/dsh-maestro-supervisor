#!/usr/bin/env bash
set -euo pipefail
TEMPLATE="$(dirname "$0")/../systemd/dsh-web-supervisor.service.template"
DEST="$HOME/.config/systemd/user/dsh-web-supervisor.service"
mkdir -p "$(dirname "$DEST")"
sed "s|%h|$HOME|g" "$TEMPLATE" > "$DEST"
echo "installed to $DEST"
echo "run: systemctl --user daemon-reload && systemctl --user enable --now dsh-web-supervisor"
