#!/usr/bin/env bash
# =============================================================================
#  desk-full-setup.sh —— 把一台空白机器变成 Desk Hub
#
#  被 src/remote.mjs 调用：程序包已经由 SFTP 传到 /tmp/desk-hub.tar.gz，
#  这里只负责装依赖、解包、注册服务、启动，并把配对码打出来。
#
#  用法（在目标机上）： sudo bash /tmp/desk-full-setup.sh <端口> <程序包路径>
#  输出关键行：
#      DESK_HUB_URL=http://<ip>:<port>
#      DESK_PAIR_CODE=12345678
# =============================================================================
set -euo pipefail

PORT="${1:-4390}"
PKG="${2:-/tmp/desk-hub.tar.gz}"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
APP_DIR="${DESK_APP_DIR:-$RUN_HOME/desk-hub}"
SERVICE="${DESK_SERVICE_NAME:-desk-hub}"

say() { printf '\n[desk] %s\n' "$*"; }

[ -f "$PKG" ] || { echo "[desk] 程序包不存在: $PKG" >&2; exit 1; }

say "1/6 检查 Node.js"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$MAJOR" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" = "0" ]; then
  say "安装 Node.js 20"
  # 有的镜像没有 curl，优先 curl，退 wget
  if command -v curl >/dev/null 2>&1; then
    FETCH="curl -fsSL"
  else
    FETCH="wget -qO-"
  fi
  $FETCH https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  fi
fi
command -v node >/dev/null 2>&1 || { echo "[desk] Node.js 安装失败" >&2; exit 1; }
say "Node $(node -v)"

say "2/6 安装运行依赖（桌面相关失败不影响 Hub 本身）"
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb x11vnc novnc websockify >/dev/null 2>&1 || \
    echo "[desk] 警告：桌面依赖没装全，先只跑 Hub"
  if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium-browser >/dev/null 2>&1 || true
  fi
  # A viewable desktop needs a session environment. Prefer XFCE (light, installs
  # in ~1 min); if the machine already has GNOME the session helper uses that.
  if ! command -v xfce4-session >/dev/null 2>&1 && ! command -v gnome-session >/dev/null 2>&1; then
    say "安装桌面环境（XFCE，约 1-2 分钟）"
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xfce4 xfce4-terminal dbus-x11 >/dev/null 2>&1 || \
      echo "[desk] 警告：桌面环境没装成，Bot 桌面会是黑屏；Hub 本身不受影响"
  fi
fi

say "3/6 解开程序包到 $APP_DIR"
mkdir -p "$APP_DIR"
tar xzf "$PKG" -C "$APP_DIR"
[ -f "$APP_DIR/src/server.mjs" ] || { echo "[desk] 程序包内容不对，缺 src/server.mjs" >&2; exit 1; }
mkdir -p "$APP_DIR/data" "$APP_DIR/workspace"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# Per-bot desktop session launcher (GNOME when the host has the memory for it).
cat > /tmp/desk-bot-session <<'DESK_SESSION_EOF'
#!/bin/sh
DISP="$1"
[ -n "$DISP" ] || exit 1
export DISPLAY=":$DISP"
export XDG_SESSION_TYPE=x11
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export LIBGL_ALWAYS_SOFTWARE=1
export NO_AT_BRIDGE=1
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if command -v gnome-session >/dev/null 2>&1 && [ "$MEM_MB" -ge 6000 ]; then
  export XDG_CURRENT_DESKTOP=GNOME
  export GNOME_SHELL_SESSION_MODE=ubuntu
  exec dbus-launch --exit-with-session gnome-session --session=ubuntu
fi
export XDG_CURRENT_DESKTOP=XFCE
exec dbus-launch --exit-with-session xfce4-session
DESK_SESSION_EOF
install -m 755 /tmp/desk-bot-session /usr/local/bin/desk-bot-session

say "4/6 注册 ${SERVICE}.service"
CHROME_BIN=""
for c in /snap/bin/chromium /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
  [ -x "$c" ] && { CHROME_BIN="$c"; break; }
done
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Desk Hub (personal AI assistant)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=HOST=0.0.0.0
Environment=ASSIST_ALLOW_REMOTE=1
Environment=PORT=$PORT
${CHROME_BIN:+Environment=CHROME_PATH=$CHROME_BIN}
ExecStart=$(command -v node) src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

say "5/6 启动"
systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null 2>&1 || true
systemctl restart ${SERVICE}

# 等它把配对码写出来
CODE=""
for i in $(seq 1 30); do
  sleep 1
  if [ -f "$APP_DIR/data/security.json" ]; then
    CODE="$(grep -o '"code"[^,}]*' "$APP_DIR/data/security.json" | head -1 | grep -o '[0-9]\{6,10\}' || true)"
    [ -n "$CODE" ] && break
  fi
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "6/6 完成"

echo "DESK_HUB_URL=http://${IP}:${PORT}"
echo "DESK_PAIR_CODE=${CODE:-unknown}"
echo "DESK_APP_DIR=$APP_DIR"
systemctl is-active ${SERVICE} || true
