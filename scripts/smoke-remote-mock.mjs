#!/usr/bin/env node
/**
 * smoke-remote-mock.mjs - drive the one-click provisioning end to end against
 * a fake SSH host, so the whole chain (auth -> sudo -> upload -> install log ->
 * timezone -> port probe -> verdict) is regression-tested without a real VM.
 *
 * It boots a local ssh2 server plus a TCP listener that stands in for noVNC,
 * then runs scripts/verify-remote-setup.mjs against them using throwaway
 * credentials. No real machine is contacted or modified.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';

const { Server } = ssh2;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'ubuntu';
const PASSWORD = 'mock-pass';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const STEP_LOG = [
  '[desk-setup] [1/9] 检查桌面环境',
  '[desk-setup] [2/9] 没有图形桌面，安装最小 Ubuntu 桌面（首次约 5-10 分钟）',
  '[desk-setup] [3/9] 安装 x11vnc / noVNC / websockify',
  '[desk-setup] [4/9] 关闭 Wayland（x11vnc 需要 Xorg）',
  '[desk-setup] [5/9] 写入 VNC 密码与服务启动脚本',
  '[desk-setup] [6/9] 安装 systemd 服务',
  '[desk-setup] [7/9] 重启显示管理器（会短暂黑屏）',
  '[desk-setup] [8/9] 防火墙与自检',
  '[desk-setup] [9/9] 完成',
  '[desk-setup] timezone=Asia/Shanghai',
  '[desk-setup] address=192.168.100.134',
  '[desk-setup] novnc=http://192.168.100.134:6080/vnc.html',
].join('\n');

const LISTENING = [
  'LISTEN 0 128 127.0.0.1:5900 0.0.0.0:*',
  'LISTEN 0 128 0.0.0.0:6080 0.0.0.0:*',
].join('\n');

const seen = [];

function respond(command) {
  seen.push(command.split('\n')[0].slice(0, 90));
  if (command === 'id -u') return '1000\n';
  if (command.includes('sudo -S -p')) return '';
  if (command.includes('sudo -n true')) return 'needs-password\n';
  if (command.includes('/etc/os-release')) return 'Ubuntu 24.04 LTS\n';
  if (command.includes('cat > /tmp/desk-remote-setup.sh')) return '';
  if (command.includes('bash /tmp/desk-remote-setup.sh')) return `${STEP_LOG}\n`;
  if (command.includes('timedatectl')) return 'Asia/Shanghai\n';
  if (command.includes('command -v apt-get')) return '/usr/bin/apt-get\n';
  if (command.includes('for d in gdm3')) return '';
  if (command.includes('ls /usr/share/xsessions')) return 'none\n';
  if (command.includes('for t in x11vnc')) return '';
  if (command.includes('systemctl is-active')) return 'active\nactive\n';
  if (command.includes('systemctl is-enabled')) return 'enabled\nenabled\n';
  if (command.includes('ss -ltn')) return `${LISTENING}\n`;
  if (command.includes('stat -c')) return '600 root:root\n';
  if (command.includes('^WaylandEnable=')) return 'WaylandEnable=false\n';
  if (command.includes('ls /tmp/.X11-unix')) return 'X0\n';
  if (command.includes('ls -l /tmp/desk-remote-setup.sh')) return '-rwxr-xr-x 1 root root 6028 /tmp/desk-remote-setup.sh\n';
  return '';
}

const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
    else ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(respond(info.command));
        stream.exit(0);
        stream.end();
      });
    });
  });
});

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const fakeNoVnc = net.createServer((socket) => socket.end());
const [sshPort, webPort] = await Promise.all([listen(ssh), listen(fakeNoVnc)]);
console.log(`模拟 SSH :${sshPort} / 模拟 noVNC :${webPort}`);

const child = spawn(process.execPath, ['scripts/verify-remote-setup.mjs'], {
  cwd: REPO,
  env: {
    ...process.env,
    DESK_TARGET_HOST: '127.0.0.1',
    DESK_TARGET_USER: USER,
    DESK_TARGET_PASS: PASSWORD,
    DESK_SSH_PORT: String(sshPort),
    DESK_WEB_PORT: String(webPort),
  },
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { output += chunk; process.stderr.write(chunk); });

const exitCode = await new Promise((resolve) => child.on('close', resolve));

const checks = [
  ['验收脚本以 PASS 退出', exitCode === 0],
  ['走完了 SSH 连接', seen.some((c) => c === 'id -u')],
  ['检查了 sudo', seen.some((c) => c.includes('sudo -S -p'))],
  ['上传了配置脚本', seen.some((c) => c.includes('cat > /tmp/desk-remote-setup.sh'))],
  ['执行了配置脚本', seen.some((c) => c.includes('bash /tmp/desk-remote-setup.sh'))],
  ['读取了时区', seen.some((c) => c.includes('timedatectl'))],
  ['执行了验收后检查', seen.some((c) => c.includes('systemctl is-active'))],
  ['输出了 PASS 结论', /结论: PASS/.test(output)],
];

console.log('\n=== 模拟验收链路 ===');
for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);

ssh.close();
fakeNoVnc.close();
process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
