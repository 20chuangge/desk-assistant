#!/usr/bin/env bash
# =============================================================================
#  在 Ubuntu Hub 上开一个"能被 Desk 接管的桌面"。
#
#  做的事：
#   1. x11vnc 挂到当前已登录的 X 会话（display :0）
#   2. noVNC + websockify 把 5900 转成网页 6080
#   3. 两个 systemd 服务，开机自起
#
#  用法：  bash hub/vnc-setup.sh '你的VNC密码'
#
#  ⚠️ Ubuntu 24.04 默认是 Wayland，x11vnc 抓不到画面。脚本会关掉 Wayland，
#     需要重启一次才会切到 Xorg 会话。
# =============================================================================
set -euo pipefail

PASS="${1:-desk1234}"
PORT="${VNC_WEB_PORT:-6080}"

echo "[1/6] 安装 x11vnc / novnc / websockify"
sudo apt update
sudo apt install -y x11vnc novnc websockify

echo "[2/6] 写 VNC 密码"
sudo mkdir -p /etc/desk
sudo x11vnc -storepasswd "$PASS" /etc/desk/vnc.pass >/dev/null
sudo chmod 600 /etc/desk/vnc.pass

echo "[3/6] 关掉 Wayland（x11vnc 需要 Xorg）"
CONF=/etc/gdm3/custom.conf
if [ -f "$CONF" ]; then
  if grep -q '^WaylandEnable=false' "$CONF"; then
    echo "      已经是 Xorg 配置"
  else
    sudo sed -i 's/^#\?WaylandEnable=.*/WaylandEnable=false/' "$CONF"
    grep -q '^WaylandEnable=false' "$CONF" || echo 'WaylandEnable=false' | sudo tee -a "$CONF" >/dev/null
    NEED_REBOOT=1
  fi
fi

echo "[4/6] 装 desk-vnc（x11vnc）"
sudo tee /etc/systemd/system/desk-vnc.service >/dev/null <<EOF
[Unit]
Description=Desk VNC (attach to the logged-in X session)
After=display-manager.service

[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/x11vnc -display :0 -auth guess -forever -shared -noxdamage -repeat \\
          -rfbauth /etc/desk/vnc.pass -rfbport 5900 -o /var/log/desk-vnc.log
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "[5/6] 装 desk-novnc（6080 -> 5900 网页桥）"
sudo tee /etc/systemd/system/desk-novnc.service >/dev/null <<EOF
[Unit]
Description=Desk noVNC (websocket bridge ${PORT} -> 5900)
After=desk-vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc ${PORT} localhost:5900
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now desk-novnc.service
sudo systemctl enable desk-vnc.service

echo "[6/6] 防火墙"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow "${PORT}/tcp" || true
fi

IP="$(hostname -I | awk '{print $1}')"
echo
echo "  网页地址： http://${IP}:${PORT}/vnc.html?autoconnect=1&resize=scale"
echo "  VNC 密码： ${PASS}"
echo
if [ "${NEED_REBOOT:-0}" = "1" ]; then
  echo "  ⚠️ 刚关掉 Wayland，需要重启一次： sudo reboot"
  echo "     重启后登录（选 \"Ubuntu on Xorg\"），再执行："
  echo "     sudo systemctl start desk-vnc && sudo systemctl status desk-vnc --no-pager"
fi
