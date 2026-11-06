#!/usr/bin/env node
/**
 * verify-remote-setup.mjs - end-to-end acceptance run for the one-click remote
 * desktop provisioning (project "next step" #1).
 *
 * Credentials come from the environment only: they are never written to argv,
 * files, or the report.
 *
 *   DESK_TARGET_HOST=192.168.100.134 DESK_TARGET_USER=ubuntu \
 *   DESK_TARGET_PASS=... node scripts/verify-remote-setup.mjs
 *
 * Optional: DESK_SSH_PORT (22), DESK_WEB_PORT (6080), DESK_VNC_PASS,
 *           DESK_VERIFY_OUT (write the JSON report to this path).
 *
 * Flow: read-only SSH preflight -> the real createProvisioner (upload script,
 * sudo, install, wait for the port) -> poll the job -> SSH postflight checks
 * -> JSON verdict.
 *
 * WARNING: the setup script installs packages and restarts the display manager
 * and VNC services on the target. Only run this against a machine you are
 * explicitly allowed to reconfigure. A machine that already has a desktop is
 * NOT a blank machine: it exercises the "already installed" branch only.
 */

import { Client } from 'ssh2';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  DESK_TARGET_HOST,
  DESK_TARGET_USER,
  DESK_TARGET_PASS,
  DESK_VNC_PASS = 'desk-accept-1234',
  DESK_SSH_PORT = '22',
  DESK_WEB_PORT = '6080',
  DESK_VERIFY_OUT,
} = process.env;

const missing = ['DESK_TARGET_HOST', 'DESK_TARGET_USER', 'DESK_TARGET_PASS']
  .filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`缺少环境变量: ${missing.join(', ')}`);
  console.error('用法: DESK_TARGET_HOST=... DESK_TARGET_USER=... DESK_TARGET_PASS=... node scripts/verify-remote-setup.mjs');
  process.exit(2);
}

// The provisioner caches remote-info.json in ASSIST_HOME. Isolate the run so an
// acceptance test never touches real user data.
const tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'desk-verify-'));
process.env.ASSIST_HOME = tempHome;
const { createProvisioner, probeTcp } = await import('../src/remote.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('error', reject);
    client.connect({
      host: DESK_TARGET_HOST,
      port: Number(DESK_SSH_PORT),
      username: DESK_TARGET_USER,
      password: DESK_TARGET_PASS,
      readyTimeout: 20000,
    });
  });
}

function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = '';
      const consume = (chunk) => { output += chunk.toString('utf8'); };
      stream.on('data', consume);
      stream.stderr?.on('data', consume);
      stream.on('close', (code) => resolve({ code: code ?? 0, output: output.trim() }));
    });
  });
}

async function inspect(client, label, commands) {
  const result = {};
  console.log(`\n=== ${label} ===`);
  for (const [key, command] of Object.entries(commands)) {
    try {
      const { code, output } = await exec(client, command);
      result[key] = { code, output: output.slice(0, 2000) };
      console.log(`  ${key}: ${output.slice(0, 300).replace(/\s+/g, ' ') || '(empty)'}`);
    } catch (err) {
      result[key] = { code: -1, output: String(err.message) };
      console.log(`  ${key}: ERROR ${err.message}`);
    }
  }
  return result;
}

const PREFLIGHT = {
  os: '. /etc/os-release; echo "$PRETTY_NAME"',
  uid: 'id -u',
  sudo: 'sudo -n true >/dev/null 2>&1 && echo passwordless || echo needs-password',
  apt: 'command -v apt-get || echo missing',
  displayManagers: 'for d in gdm3 lightdm sddm; do command -v "$d" >/dev/null 2>&1 && echo "$d"; done',
  xsessions: 'ls /usr/share/xsessions/ 2>/dev/null || echo none',
  vncTools: 'for t in x11vnc websockify; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done',
  listening: 'ss -ltn 2>/dev/null | tail -n +2',
  wayland: "grep -h '^WaylandEnable=' /etc/gdm3/custom.conf 2>/dev/null || echo unset",
  timezone: 'timedatectl show -p Timezone --value 2>/dev/null || echo unknown',
};

const POSTFLIGHT = {
  services: 'systemctl is-active desk-vnc.service desk-novnc.service 2>&1',
  enabled: 'systemctl is-enabled desk-vnc.service desk-novnc.service 2>&1',
  listening: 'ss -ltn 2>/dev/null | grep -E ":(5900|6080)\\b" || echo none',
  passwdFile: 'stat -c "%a %U:%G" /etc/desk/vnc.passwd 2>/dev/null || echo missing',
  wayland: "grep -h '^WaylandEnable=' /etc/gdm3/custom.conf 2>/dev/null || echo unset",
  xSocket: 'ls /tmp/.X11-unix/ 2>/dev/null || echo none',
  script: 'ls -l /tmp/desk-remote-setup.sh 2>/dev/null || echo missing',
};

let client;
let report = { host: DESK_TARGET_HOST, webPort: Number(DESK_WEB_PORT), startedAt: new Date().toISOString() };
try {
  console.log(`目标: ${DESK_TARGET_USER}@${DESK_TARGET_HOST}:${DESK_SSH_PORT} (noVNC ${DESK_WEB_PORT})`);
  client = await connect();
  report.preflight = await inspect(client, '预检（只读）', PREFLIGHT);
  client.end();
  client = null;

  const blank = !/lightdm|gdm3|sddm/.test(report.preflight.displayManagers?.output || '')
    && !/x11vnc|websockify/.test(report.preflight.vncTools?.output || '');
  report.preflight.blankMachine = blank;
  console.log(`\n空白机器判定: ${blank ? '是 → 会走「从零安装桌面」分支' : '否 → 只会走「已有桌面」分支，不能代表完整验收'}`);

  console.log('\n=== 执行一键配置 ===');
  const provisioner = createProvisioner();
  const started = provisioner.start({
    host: DESK_TARGET_HOST,
    sshPort: Number(DESK_SSH_PORT),
    username: DESK_TARGET_USER,
    password: DESK_TARGET_PASS,
    vncPassword: DESK_VNC_PASS,
    webPort: Number(DESK_WEB_PORT),
  });

  let lastMessage = '';
  let job = started;
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    job = provisioner.get(started.id) || job;
    if (job.message !== lastMessage) {
      lastMessage = job.message;
      console.log(`  [${job.step}/${job.totalSteps}] ${job.message}`);
    }
    if (job.state !== 'running') break;
    await sleep(1500);
  }
  report.job = job;

  client = await connect();
  report.postflight = await inspect(client, '验收检查（只读）', POSTFLIGHT);
  client.end();
  client = null;

  const probe = await probeTcp(DESK_TARGET_HOST, Number(DESK_WEB_PORT), 2500);
  report.probe = probe;

  const checks = [
    ['provisioner 到达终态', job?.state !== 'running'],
    ['provisioner 报告成功', job?.state === 'done'],
    ['noVNC 端口可连', probe.reachable],
    ['desk-vnc 服务 active', /active/.test(report.postflight.services?.output || '')],
    ['desk-novnc 服务 active', (report.postflight.services?.output || '').match(/active/g)?.length === 2],
    ['5900 与 6080 都在监听', /:5900/.test(report.postflight.listening?.output || '') && /:6080/.test(report.postflight.listening?.output || '')],
    ['VNC 密码文件权限 600', /^600 /.test(report.postflight.passwdFile?.output || '')],
    ['Wayland 已关闭', /false/.test(report.postflight.wayland?.output || '')],
    ['X display 存在', /X\d/.test(report.postflight.xSocket?.output || '')],
  ];
  report.checks = checks.map(([name, ok]) => ({ name, ok: Boolean(ok) }));
  report.verdict = checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL';
} catch (err) {
  report.verdict = 'ERROR';
  report.error = String(err?.message || err);
  console.error(`\n验收中断: ${report.error}`);
} finally {
  try { client?.end(); } catch { /* already closed */ }
  await fsp.rm(tempHome, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  console.log(`\n=== 结论: ${report.verdict} ===`);
  if (report.checks) {
    for (const c of report.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  if (DESK_VERIFY_OUT) {
    await fsp.writeFile(DESK_VERIFY_OUT, JSON.stringify(report, null, 2), 'utf8');
    console.log(`报告已写入 ${DESK_VERIFY_OUT}`);
  }
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}
