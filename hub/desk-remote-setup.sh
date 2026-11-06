#!/usr/bin/env bash
# =============================================================================
#  Desk remote setup - turn a blank Ubuntu machine into a controllable desktop.
#
#  Run as root (Desk does it over SSH with sudo):
#      bash desk-remote-setup.sh 'vnc-password' 6080
#
#  What it does, in order:
#    1. installs the X desktop + x11vnc + noVNC/websockify when missing
#    2. disables Wayland so x11vnc can see the session
#    3. writes a loopback VNC password and systemd units
#    4. restarts the display manager so an Xorg login screen appears
#    5. opens the noVNC port in ufw and prints the timezone
#
#  It deliberately does NOT enable auto-login: the VNC viewer shows the normal
#  login screen and the human signs in there, exactly like sitting in front of
#  the machine. That keeps the machine's security model intact.
# =============================================================================
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

PASS="${1:-desk1234}"
PORT="${2:-6080}"
LOG_TAG="[desk-setup]"

step() { echo "$LOG_TAG $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must run as root (Desk calls it through sudo)." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script currently supports apt-based systems (Ubuntu/Debian)." >&2
  exit 1
fi

# --- 1. desktop + remote tools ----------------------------------------------
step "[1/9] 检查桌面环境"
HAVE_DM=""
for dm in gdm3 lightdm sddm; do
  if command -v "$dm" >/dev/null 2>&1; then HAVE_DM="$dm"; break; fi
done

if [ -z "$HAVE_DM" ]; then
  step "[2/9] 没有图形桌面，安装最小 Ubuntu 桌面（首次约 5-10 分钟）"
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ubuntu-desktop-minimal xserver-xorg lightdm lightdm-gtk-greeter \
    xterm dbus-x11
  HAVE_DM="lightdm"
else
  step "[2/9] 已有桌面环境：$HAVE_DM"
fi

step "[3/9] 安装 x11vnc / noVNC / websockify"
apt-get update -y
apt-get install -y x11vnc novnc websockify

# --- 2. Wayland off ----------------------------------------------------------
step "[4/9] 关闭 Wayland（x11vnc 需要 Xorg）"
if [ -f /etc/gdm3/custom.conf ]; then
  if grep -q '^WaylandEnable=' /etc/gdm3/custom.conf; then
    sed -i 's/^WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
  elif grep -q '^#.*WaylandEnable=' /etc/gdm3/custom.conf; then
    sed -i 's/^#.*WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
  else
    printf '\n[daemon]\nWaylandEnable=false\n' >> /etc/gdm3/custom.conf
  fi
fi
# LightDM is Xorg by default; make sure a stale Wayland session cannot win.
if [ -d /etc/lightdm/lightdm.conf.d ]; then
  printf '[Seat:*]\nuser-session=ubuntu\n' > /etc/lightdm/lightdm.conf.d/50-desk-xorg.conf
fi

# --- 2b. pin an Xorg login session ------------------------------------------
# WaylandEnable=false only affects GDM's own greeter. The session a user lands
# in is chosen by AccountsService's Session= value; when it is empty GDM picks
# the Wayland session, leaving x11vnc attached to a rootless Xwayland where
# X_GetImage always fails. Pin it to the Xorg session so a fresh login works.
step "[4.5/9] 固定登录会话为 Xorg"
XSESSION=""
if [ -f /usr/share/xsessions/ubuntu-xorg.desktop ]; then
  XSESSION="ubuntu-xorg"
elif [ -f /usr/share/xsessions/xorg.desktop ]; then
  XSESSION="xorg"
fi
if [ -n "$XSESSION" ]; then
  for uf in /var/lib/AccountsService/users/*; do
    [ -f "$uf" ] || continue
    case "$(basename "$uf")" in
      gdm|nobody|root|*.desk-bak) continue ;;
    esac
    [ -f "${uf}.desk-bak" ] || cp -a "$uf" "${uf}.desk-bak" 2>/dev/null || true
    if grep -q '^Session=' "$uf"; then
      sed -i "s/^Session=.*/Session=$XSESSION/" "$uf"
    elif grep -q '^\[User\]' "$uf"; then
      sed -i "/^\[User\]/a Session=$XSESSION" "$uf"
    else
      printf '\n[User]\nSession=%s\n' "$XSESSION" >> "$uf"
    fi
  done
  step "默认会话已设为 $XSESSION（原文件备份为 *.desk-bak），重启后生效"
else
  step "warning: 找不到 Xorg session 文件，跳过会话固定"
fi

# --- 3. VNC password + launcher ---------------------------------------------
step "[5/9] 写入 VNC 密码与服务启动脚本"
install -d -m 700 /etc/desk
x11vnc -storepasswd "$PASS" /etc/desk/vnc.passwd >/dev/null 2>&1
chmod 600 /etc/desk/vnc.passwd

cat > /usr/local/bin/desk-vnc-start <<'START'
#!/bin/sh
# Attach to whichever X display exists (greeter now, user session after login).
D=$(ls /tmp/.X11-unix/ 2>/dev/null | sed -n 's/^X//p' | sort -n | head -1)
if [ -z "$D" ]; then
  echo "no X display yet; waiting"
  exit 1
fi

AUTH=""
# GDM/LightDM expose the greeter's Xauthority at stable paths. Try those first:
# walking /proc/*/environ can pick up an unrelated XAUTHORITY (an app's Xwayland
# cookie, for instance) and point x11vnc at the wrong display.
for f in \
  /run/user/*/gdm/Xauthority \
  /run/user/*/lightdm/Xauthority \
  /var/run/lightdm/root/:$D \
  /var/lib/gdm3/.Xauthority \
  /root/.Xauthority; do
  [ -r "$f" ] && { AUTH="$f"; break; }
done
if [ -z "$AUTH" ]; then
  for p in /proc/[0-9]*; do
    [ -r "$p/environ" ] || continue
    candidate=$(tr '\0' '\n' < "$p/environ" 2>/dev/null | sed -n 's/^XAUTHORITY=//p' | head -1)
    [ -n "$candidate" ] && [ -r "$candidate" ] && { AUTH="$candidate"; break; }
  done
fi

if [ -n "$AUTH" ]; then
  AUTHARG="-auth $AUTH"
else
  AUTHARG="-auth guess"
fi

exec /usr/bin/x11vnc -display ":$D" $AUTHARG \
  -forever -shared -loop -noshm -noxdamage -repeat \
  -rfbauth /etc/desk/vnc.passwd -rfbport 5900 -o /var/log/desk-vnc.log
START
chmod 755 /usr/local/bin/desk-vnc-start

# --- 4. systemd units --------------------------------------------------------
step "[6/9] 安装 systemd 服务"
cat > /etc/systemd/system/desk-vnc.service <<'UNIT'
[Unit]
Description=Desk VNC (attaches to the active Xorg display)
# Do NOT put graphical.target in After= while installing under multi-user.target:
# systemd sees a stop ordering cycle and kills the unit right after boot.
After=display-manager.service
Wants=display-manager.service

[Service]
Type=simple
ExecStart=/usr/local/bin/desk-vnc-start
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
UNIT

cat > /etc/systemd/system/desk-novnc.service <<UNIT
[Unit]
Description=Desk noVNC bridge (${PORT} -> 5900)
After=desk-vnc.service
Wants=desk-vnc.service

[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 0.0.0.0:${PORT} 127.0.0.1:5900
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
UNIT

# Older installs linked these into multi-user.target. Drop the stale links so
# the units are pulled in once, from graphical.target only.
rm -f /etc/systemd/system/multi-user.target.wants/desk-vnc.service \
      /etc/systemd/system/multi-user.target.wants/desk-novnc.service
systemctl daemon-reload
systemctl enable desk-vnc.service desk-novnc.service

# --- 5. restart the display manager so Xorg appears --------------------------
step "[7/9] 重启显示管理器（会短暂黑屏）"
if systemctl list-unit-files | grep -q '^gdm3\.service'; then
  systemctl restart gdm3
elif systemctl list-unit-files | grep -q '^lightdm\.service'; then
  systemctl restart lightdm
elif systemctl list-unit-files | grep -q '^sddm\.service'; then
  systemctl restart sddm
fi

# Wait for an X socket (up to 60s). A missing socket is reported, not fatal:
# the services keep retrying and will attach when the greeter appears.
for _ in $(seq 1 60); do
  [ -n "$(ls /tmp/.X11-unix/ 2>/dev/null)" ] && break
  sleep 1
done
systemctl restart desk-vnc.service desk-novnc.service || true

# --- 6. firewall + report ----------------------------------------------------
step "[8/9] 防火墙与自检"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
fi

# x11vnc can only attach to an Xorg display, never a rootless Xwayland one.
# WaylandEnable=false plus a gdm3 restart is NOT enough when a user session is
# already running: the login screen must be used to pick "Ubuntu on Xorg".
if ps -eo args | grep -q '[X]wayland' && ! ps -eo args | grep -q '[/]usr/bin/Xorg'; then
  step "warning: 检测到 Wayland/Xwayland 会话且没有 Xorg；x11vnc 无法接管桌面"
  step "warning: 默认会话已固定为 Xorg，请重启机器并重新登录后再运行本脚本"
fi

TIMEZONE="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
step "[9/9] 完成"
echo "$LOG_TAG timezone=${TIMEZONE:-UTC}"
echo "$LOG_TAG address=${IP:-127.0.0.1}"
echo "$LOG_TAG novnc=http://${IP:-127.0.0.1}:${PORT}/vnc.html"
# websockify can bind the web port while its VNC backend is dead, so check both.
if ss -ltn 2>/dev/null | grep -Eq ':5900\b'; then
  step "VNC 后端 5900 已监听"
else
  step "warning: VNC 后端 5900 未监听；noVNC 网页会打开但看不到桌面"
fi
if ! ss -ltn 2>/dev/null | grep -Eq ":${PORT}\b"; then
  step "warning: noVNC ${PORT} 未监听；服务会自动重试"
fi