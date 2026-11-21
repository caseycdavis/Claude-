#!/bin/bash
# Builds Parce and registers it to start whenever this macOS user is logged in.
# Run from anywhere inside the repository. Safe to run again after pulling an update.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
LABEL="com.parce.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA="${PARCE_DATA_DIR:-$HOME/.parce}"
PORT="${PARCE_PORT:-8787}"
DOMAIN="gui/$(id -u)"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is for macOS. On other systems run: npm ci && npm run build && npm start"
  exit 1
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "Node.js is not installed. Install Node 22 or later from https://nodejs.org and run this again."
  exit 1
fi
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Node $("$NODE" -v) is too old. Parce needs Node 22.13 or later."
  exit 1
fi

echo "Installing dependencies"
npm ci
echo "Building"
npm run build

mkdir -p "$DATA/logs" "$(dirname "$PLIST")"
chmod 700 "$DATA"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$REPO/dist/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PARCE_DATA_DIR</key><string>$DATA</string>
    <key>PARCE_PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DATA/logs/parce.log</string>
  <key>StandardErrorPath</key><string>$DATA/logs/parce.log</string>
</dict>
</plist>
EOF

# Stop an earlier copy if there is one, then start this one.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Waiting for Parce to answer"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/state" >/dev/null 2>&1; then
    NAME="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
    echo
    echo "Parce is running."
    echo "  On this Mac:            http://localhost:$PORT"
    echo "  From the same network:  http://$NAME.local:$PORT"
    echo "  Log file:               $DATA/logs/parce.log"
    echo "  To stop it:             launchctl bootout $DOMAIN/$LABEL"
    exit 0
  fi
  sleep 1
done

echo "Parce did not answer on port $PORT. The last lines of its log:"
tail -n 30 "$DATA/logs/parce.log" 2>/dev/null || echo "(no log yet)"
exit 1
