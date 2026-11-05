#!/usr/bin/env bash
# =============================================================================
#  Desk Hub · 一键安装（Ubuntu / Debian 云主机或虚拟机）
#
#  装完就有三件事：
#    1. desk-hub  —— Bot 服务（systemd，开机自启，端口 4390）
#    2. 远程桌面  —— noVNC 网页版，浏览器里就能看/点/打字（端口 6080）
#    3. 配对码    —— 本地 Desk 客户端连过来用
#
#  用法（在放好本包的目录里）：
#      sudo bash install.sh
#      sudo bash install.sh --password 'MyVnc123' --port 4390
#      sudo bash install.sh --mode virtual      # 无桌面的云主机：开一个虚拟桌面
#      sudo bash install.sh --mode session     # 已有桌面：挂到登录会话上
#
#  支持的坑（都处理了）：Wayland、display 不是 :0、无桌面云主机、ssh 里没有
#  DISPLAY、MIT-SHM 权限、开机时序。
# =============================================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_PORT="${HUB_PORT:-4390}"
WEB_PORT="${WEB_PORT:-6080}"
VNC_PASS="${VNC_PASS:-desk1234}"
MODE="${MODE:-auto}"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

while [ $# -gt 0 ]; do
  case "$1" in
    --password=*) VNC_PASS="${1#*=}" ;;
    --port=*)     HUB_PORT="${1#*=}" ;;
    --mode=*)     MODE="${1#*=}" ;;
    --password)   VNC_PASS="$2"; shift ;;
    --port)       HUB_PORT="$2"; shift ;;
    --mode)       MODE="$2"; shift ;;
    -h|--help)    sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
  shift
done

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 sudo 运行：sudo bash install.sh"

say "0/7 环境检查"
. /etc/os-release
ok "系统：$PRETTY_NAME"
command -v systemctl >/dev/null || die "需要 systemd"
ok "systemd 可用"
ok "安装目录：$APP_DIR"
ok "运行用户：$RUN_USER（$RUN_HOME）"

say "1/7 安装基础依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg x11vnc novnc websockify >/dev/null
ok "curl / x11vnc / novnc / websockify"

say "2/7 安装 Node.js（>=20）"
need_node=1
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 20 ] && { need_node=0; ok "已装 Node $(node -v)"; }
fi
if [ "$need_node" = "1" ]; then
  if curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1; then
    apt-get install -y -qq nodejs >/dev/null && ok "Node $(node -v)"
  else
    warn "NodeSource 不可达，退回系统仓库的 nodejs"
    apt-get install -y -qq nodejs >/dev/null
    ok "Node $(node -v)（版本较低，浏览器工具会走兼容模式）"
  fi
fi

say "3/7 安装 Desk Hub 服务"
[ -f "$APP_DIR/src/server.mjs" ] || die "找不到 src/server.mjs，请在解压后的目录里运行"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR" 2>/dev/null || true
cat > /etc/systemd/system/desk-hub.service <<EOF
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
Environment=PORT=$HUB_PORT
Environment=BROWSER_HEADLESS=1
ExecStart=$(command -v node) src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now desk-hub >/dev/null
sleep 2
if curl -fs "http://127.0.0.1:$HUB_PORT/api/health" >/dev/null 2>&1 || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HUB_PORT/api/health")" = "401" ]; then
  ok "Hub 已启动：http://127.0.0.1:$HUB_PORT"
else
  warn "Hub 没起来，看日志：journalctl -u desk-hub -n 40"
fi

# --- VNC 密码 ---------------------------------------------------------------
mkdir -p /etc/desk
x11vnc -storepasswd "$VNC_PASS" /etc/desk/vnc.pass >/dev/null 2>&1 || true
chmod 600 /etc/desk/vnc.pass

# 两种模式都以 RUN_USER 身份跑 x11vnc，所以密码文件要放到它读得到的地方
mkdir -p "$RUN_HOME/.vnc"
cp /etc/desk/vnc.pass "$RUN_HOME/.vnc/passwd"
chown -R "$RUN_USER:$RUN_USER" "$RUN_HOME/.vnc"
chmod 700 "$RUN_HOME/.vnc"
chmod 600 "$RUN_HOME/.vnc/passwd"

# Desk 的「接管桌面」会把 noVNC 嵌进面板；noVNC 每次都要输密码很烦，
# 所以把明文密码交给 Hub（只存在本机的 data/vnc.json，600 权限）。
mkdir -p "$APP_DIR/data"
printf '{"password":"%s"}\n' "$VNC_PASS" > "$APP_DIR/data/vnc.json"
chmod 600 "$APP_DIR/data/vnc.json"
chown "$RUN_USER:$RUN_USER" "$APP_DIR/data/vnc.json"

say "4/7 决定桌面模式"
HAS_X=0
if ls /tmp/.X11-unix/X* >/dev/null 2>&1; then HAS_X=1; fi
if [ "$MODE" = "auto" ]; then
  if [ "$HAS_X" = "1" ]; then MODE="session"; else MODE="virtual"; fi
fi
ok "模式：$MODE"

if [ "$MODE" = "session" ]; then
  say "5/7 挂到已有桌面（登录自启）"
  # x11vnc 由桌面会话自己起，避免 root 跨用户抓屏的 MIT-SHM 问题
  mkdir -p "$RUN_HOME/.config/autostart"
  cat > "$RUN_HOME/.config/autostart/desk-vnc.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Desk VNC
Exec=/usr/bin/x11vnc -display :0 -localhost -forever -shared -noxdamage -repeat -rfbport 5900 -rfbauth $RUN_HOME/.vnc/passwd -o $RUN_HOME/.vnc/x11vnc.log
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
  chown -R "$RUN_USER:$RUN_USER" "$RUN_HOME/.config/autostart"
  # 立刻起一个（当前已登录的会话）；以 RUN_USER 身份跑，避免 MIT-SHM 被拒
  AUTH_FILE="$(ls /run/user/*/gdm/Xauthority "$RUN_HOME/.Xauthority" 2>/dev/null | head -1 || true)"
  sudo -u "$RUN_USER" env DISPLAY=:0 ${AUTH_FILE:+XAUTHORITY="$AUTH_FILE"} \
    nohup x11vnc -display :0 -localhost -forever -shared -noxdamage -repeat -rfbport 5900 \
    -rfbauth "$RUN_HOME/.vnc/passwd" -o "$RUN_HOME/.vnc/x11vnc.log" >/dev/null 2>&1 &
  sleep 2
  ss -ltn | grep -q ':5900' && ok "5900 已监听（当前会话）" || warn "当前会话没起来，登录后自启会补上"
else
  say "5/7 创建虚拟桌面（无显示屏的云主机）"
  apt-get install -y -qq xvfb openbox xterm >/dev/null
  cat > /etc/systemd/system/desk-xvfb.service <<'EOF'
[Unit]
Description=Desk virtual X display (:99)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/desk-x11vnc.service <<EOF
[Unit]
Description=Desk VNC on the virtual display
After=desk-xvfb.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
Environment=DISPLAY=:99
ExecStart=/usr/bin/x11vnc -display :99 -localhost -forever -shared -noxdamage -repeat -noshm -rfbport 5900 -rfbauth $RUN_HOME/.vnc/passwd -o /var/log/desk-vnc.log
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now desk-xvfb >/dev/null
  sleep 1
  systemctl enable --now desk-x11vnc >/dev/null
  sleep 1
  if ss -ltn | grep -q ':5900'; then ok "虚拟桌面 :99 + VNC 5900"; else warn "5900 没起来，看 /var/log/desk-vnc.log"; fi
fi

say "6/7 启动 noVNC 网页桥（:$WEB_PORT）"
cat > /etc/systemd/system/desk-novnc.service <<EOF
[Unit]
Description=Desk noVNC (websocket bridge $WEB_PORT -> 5900)
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc $WEB_PORT 127.0.0.1:5900
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now desk-novnc >/dev/null
sleep 2
ss -ltn | grep -q ":$WEB_PORT" && ok "noVNC 已监听 :$WEB_PORT" || warn "noVNC 没起来：journalctl -u desk-novnc -n 30"

say "7/7 防火墙"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$HUB_PORT/tcp" >/dev/null || true
  ufw allow "$WEB_PORT/tcp" >/dev/null || true
  ok "ufw 已放行 $HUB_PORT / $WEB_PORT"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$HUB_PORT/tcp" >/dev/null
  firewall-cmd --permanent --add-port="$WEB_PORT/tcp" >/dev/null
  firewall-cmd --reload >/dev/null
  ok "firewalld 已放行 $HUB_PORT / $WEB_PORT"
else
  ok "没有启用防火墙（云厂商安全组记得放行 $HUB_PORT / $WEB_PORT）"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
CODE="$(grep -o '"code"[^,]*' "$APP_DIR/data/security.json" 2>/dev/null | head -1 | grep -o '[0-9]\{8\}' || true)"
[ -n "$CODE" ] || CODE="（见 Hub 设置页）"

cat <<EOF

────────────────────────────────────────────────────────
  安装完成
────────────────────────────────────────────────────────
  Hub 地址     http://$IP:$HUB_PORT
  配对码       $CODE
  远程桌面     http://$IP:$WEB_PORT/vnc.html?autoconnect=1&resize=scale
  VNC 密码     $VNC_PASS
  模式         $MODE

  常用命令
    systemctl status desk-hub --no-pager
    systemctl status desk-novnc --no-pager
    journalctl -u desk-hub -n 50
    ss -ltnp | grep -E '$HUB_PORT|$WEB_PORT|5900'
────────────────────────────────────────────────────────
EOF

if [ "$MODE" = "virtual" ]; then
  cat <<'EOF'
  提示：虚拟桌面是空的，需要什么就 apt install（图形程序）：
      sudo apt install -y chromium-browser   # 浏览器
      sudo apt install -y xfce4-terminal     # 终端
  每次重启后 VNC 会自己起来，不用登录（因为没有"用户登录"这回事）。
EOF
else
  cat <<'EOF'
  提示：session 模式依赖桌面会话——主机重启后请确认它自动登录到了桌面
  （设置 → 用户 → 自动登录），否则没有 :0 可挂。
EOF
fi
