#!/usr/bin/env bash
# =============================================================================
#  在 Ubuntu Hub 上开一个"能被 Desk 接管的桌面"。
#
#  踩过的坑（都在这份脚本里处理了）：
#   1. Ubuntu 24.04 默认 Wayland，x11vnc 抓不到 → 关掉 Wayland
#   2. x11vnc 跑在 SSH 里看不到桌面 → 必须显式 -display + -auth
#   3. display 不一定是 :0（Wayland→Xorg 切换后可能是 :1）→ 运行时自动探测
#   4. /run/user/*/gdm/Xauthority 只有 root 能读 → 服务跑成 root
#   5. systemd 启动时桌面还没起来 → -loop 一直等
#
#  用法：  sudo bash hub/vnc-setup.sh '你的VNC密码'
# =============================================================================
set -euo pipefail

PASS="${1:-desk1234}"
PORT="${VNC_WEB_PORT:-6080}"
TARGET_USER="${DESK_VNC_USER:-${SUDO_USER:-$USER}}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
UID_T="$TARGET_USER"

echo "[1/6] 安装 x11vnc / novnc / websockify"
sudo apt update
sudo apt install -y x11vnc novnc websockify

echo "[2/6] VNC 密码 → ${TARGET_HOME}/.vnc/passwd"
sudo -u "$TARGET_USER" mkdir -p "$TARGET_HOME/.vnc"
sudo -u "$TARGET_USER" x11vnc -storepasswd "$PASS" "$TARGET_HOME/.vnc/passwd" >/dev/null
sudo chmod 600 "$TARGET_HOME/.vnc/passwd"

echo "[3/6] 关掉 Wayland（x11vnc 需要 Xorg）"
CONF=/etc/gdm3/custom.conf
NEED_REBOOT=0
if [ -f "$CONF" ] && ! grep -q '^WaylandEnable=false' "$CONF"; then
  sudo sed -i 's/^#\?WaylandEnable=.*/WaylandEnable=false/' "$CONF"
  grep -q '^WaylandEnable=false' "$CONF" || echo 'WaylandEnable=false' | sudo tee -a "$CONF" >/dev/null
  NEED_REBOOT=1
fi

echo "[4/6] 启动脚本 /usr/local/bin/desk-vnc-start（自动探测 display + auth）"
sudo tee /usr/local/bin/desk-vnc-start >/dev/null <<EOF
#!/bin/sh
# 找当前登录的 X display（:0 / :1 / ... 都行）
D=\$(ls /tmp/.X11-unix/ 2>/dev/null | sed -n 's/^X//p' | head -1)
[ -z "\$D" ] && { echo "no X display yet"; exit 1; }
# 找该 display 的 MIT-MAGIC-COOKIE
AUTH=""
for f in /run/user/*/gdm/Xauthority ${TARGET_HOME}/.Xauthority; do
  [ -r "\$f" ] && { AUTH="\$f"; break; }
done
exec /usr/bin/x11vnc -display ":\$D" \${AUTH:+-auth "\$AUTH"} \\
  -forever -shared -noxdamage -repeat -loop \\
  -rfbauth ${TARGET_HOME}/.vnc/passwd -rfbport 5900 -o /var/log/desk-vnc.log
EOF
sudo chmod +x /usr/local/bin/desk-vnc-start

echo "[5/6] systemd 服务"
sudo tee /etc/systemd/system/desk-vnc.service >/dev/null <<'EOF'
[Unit]
Description=Desk VNC (attaches to whichever X display is logged in)
After=display-manager.service graphical.target

[Service]
Type=simple
ExecStart=/usr/local/bin/desk-vnc-start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/desk-novnc.service >/dev/null <<EOF
[Unit]
Description=Desk noVNC (websocket bridge ${PORT} -> 5900)
After=desk-vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc ${PORT} 127.0.0.1:5900
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now desk-novnc.service
sudo systemctl enable --now desk-vnc.service

echo "[6/6] 防火墙"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "${PORT}/tcp" || true
  sudo ufw allow 4390/tcp || true
fi

IP="$(hostname -I | awk '{print $1}')"
echo
echo "  网页地址： http://${IP}:${PORT}/vnc.html?autoconnect=1&resize=scale"
echo "  VNC 密码： ${PASS}"
echo "  自检：    ss -ltnp | grep 5900"
echo "            sudo tail -20 /var/log/desk-vnc.log"
echo
if [ "${NEED_REBOOT}" = "1" ]; then
  echo "  ⚠️ 刚关掉 Wayland，需要重启一次： sudo reboot"
  echo "     重启后在虚拟机窗口里登录（选 \"Ubuntu on Xorg\"），服务会自动接上。"
else
  echo "  提示：每次开机都要在虚拟机窗口里登录一次桌面，否则没有 X 会话可挂。"
fi
