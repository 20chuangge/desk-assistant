/**
 * remote.mjs - turn a blank SSH machine into a controllable desktop.
 *
 * The human adds a machine (address + VNC password) and optionally gives an SSH
 * account. We upload one setup script, run it with sudo, and report progress.
 * Nothing is required on the target side beforehand, and the SSH password is
 * held in memory for this one job only - it is never persisted or logged.
 *
 * Readiness is a TCP probe of the noVNC port. The target's timezone is read at
 * the end of provisioning and cached next to the machine address, which is what
 * the UI uses for "follow the controlled machine" time.
 */

import net from 'node:net';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { P, readJson, writeJsonAtomic, uid, nowIso } from './store.mjs';
import { packApp, cleanupPack } from './bundle.mjs';

// ssh2 is only needed when this machine PROVISIONS another one. Importing it
// eagerly would make a freshly deployed hub crash on boot when node_modules was
// not shipped, so load it on first use instead.
let ssh2Module = null;
async function loadSsh2() {
  if (!ssh2Module) {
    try {
      ssh2Module = await import('ssh2');
    } catch {
      throw remoteError('REMOTE_NO_SSH2', '这台机器上没有 ssh2 依赖，无法再远程配置别的机器；请在 Desk 客户端里操作。');
    }
  }
  return ssh2Module;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILE = path.join(HERE, '..', 'hub', 'desk-remote-setup.sh');
const INFO_FILE = path.join(P.dataDir, 'remote-info.json');
const JOB_TIMEOUT_MS = 20 * 60 * 1000;

function remoteError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

/** Hostnames/IPs only. The value becomes an SSH target, never a shell string. */
export function assertHost(host) {
  const value = String(host ?? '').trim();
  if (!value || value.length > 253) throw remoteError('REMOTE_BAD_HOST', 'a machine address is required');
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw remoteError('REMOTE_BAD_HOST', `"${value}" is not a valid host`);
  if (value.startsWith('-')) throw remoteError('REMOTE_BAD_HOST', 'host must not start with "-"');
  return value;
}

function assertPort(value, fallback, name) {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw remoteError('REMOTE_BAD_PORT', `${name} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function assertCredential(value, name) {
  const text = String(value ?? '');
  if (!text) throw remoteError('REMOTE_CREDENTIALS', `${name} is required`);
  if (text.includes('\n') || text.includes('\r')) {
    throw remoteError('REMOTE_CREDENTIALS', `${name} must not contain a newline`);
  }
  return text;
}

/** One TCP reachability probe. Never throws. */
export function probeTcp(host, port, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function readInfoCache() {
  const raw = await readJson(INFO_FILE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

async function writeInfoCache(cache) {
  try {
    await writeJsonAtomic(INFO_FILE, cache);
  } catch (err) {
    console.error('[remote] could not write info cache:', err.message);
  }
}

/** Cached facts (timezone, last success) + a live TCP probe. */
export async function remoteInfo({ host, port = 6080 } = {}) {
  const address = assertHost(host);
  const webPort = assertPort(port, 6080, 'port');
  const cache = await readInfoCache();
  const saved = cache[address] || {};
  const probe = await probeTcp(address, webPort);
  return {
    host: address,
    port: webPort,
    reachable: probe.reachable,
    latencyMs: probe.latencyMs,
    timezone: saved.timezone || '',
    ready: Boolean(saved.ready),
    lastProvisionedAt: saved.lastProvisionedAt || null,
    webPort: saved.webPort || webPort,
  };
}

// ---------------------------------------------------------------------------
// ssh helpers
// ---------------------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** SSH errors are accurate but unreadable; say what the human can act on. */
function friendlySshError(err) {
  const message = String(err?.message || '');
  if (/authentication methods failed|All configured/i.test(message)) {
    return 'SSH 账号或密码不对，或者这个账号禁止密码登录。';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return '连不上 SSH 端口。确认机器已开机、SSH 服务在跑、端口没有写错。';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return '解析不到这个地址，检查 IP 或主机名。';
  }
  if (/timed out|ETIMEDOUT|timeout/i.test(message)) {
    return '连接 SSH 超时，检查两台机器是否在同一网络、防火墙是否放行。';
  }
  return message || '远程配置失败';
}

function connectSsh({ host, port, username, password }) {
  return new Promise(async (resolve, reject) => {
    const { Client } = await loadSsh2();
    const client = new Client();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) {
        client.end();
        reject(err);
      } else {
        resolve(client);
      }
    };
    client.once('ready', () => finish(null));
    client.once('error', (err) => finish(err));
    client.connect({
      host,
      port,
      username,
      password,
      readyTimeout: 25000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    });
  });
}

/**
 * Upload a local file to the target over SFTP. Used for the app tarball: piping
 * a megabyte through `exec` stdin works but is fragile on slow links.
 */
function uploadFile(client, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(remoteError('REMOTE_UPLOAD_FAILED', `SFTP 不可用：${err.message}`));
        return;
      }
      sftp.fastPut(localPath, remotePath, (putErr) => {
        sftp.end?.();
        if (putErr) reject(remoteError('REMOTE_UPLOAD_FAILED', `上传失败：${putErr.message}`));
        else resolve(true);
      });
    });
  });
}

/**
 * Exec one command, streaming output. `stdin` is written immediately (used for
 * the sudo password). Resolves with the exit code; throws on timeout.
 */
function execStream(client, command, { stdin = '', onLine = () => {}, timeoutMs = JOB_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let output = '';
    let pending = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(remoteError('REMOTE_TIMEOUT', 'the remote command took too long'));
    }, timeoutMs);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        done = true;
        reject(err);
        return;
      }
      const consume = (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        if (output.length > 200000) output = output.slice(-200000);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) onLine(line);
      };
      stream.on('data', consume);
      stream.stderr?.on('data', consume);
      stream.on('close', (code) => {
        clearTimeout(timer);
        if (pending) onLine(pending);
        if (done) return;
        done = true;
        resolve({ code: code ?? 0, output });
      });
      if (stdin) stream.write(stdin);
    });
  });
}

// ---------------------------------------------------------------------------
// provisioning jobs
// ---------------------------------------------------------------------------

export function createProvisioner() {
  /** @type {Map<string, object>} */
  const jobs = new Map();

  const publicJob = (job) => ({
    id: job.id,
    state: job.state,
    message: job.message,
    step: job.step,
    totalSteps: job.totalSteps,
    timezone: job.timezone || '',
    address: job.address || '',
    webPort: job.webPort,
    hubPort: job.hubPort,
    hubUrl: job.hubUrl || '',
    pairCode: job.pairCode || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    log: job.log.slice(-24),
  });

  const setProgress = (job, message) => {
    job.message = message;
    const match = /(\d+)\s*\/\s*(\d+)/.exec(message);
    if (match) {
      job.step = Number(match[1]);
      job.totalSteps = Number(match[2]);
    }
    job.log.push(message);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  async function run(job, options) {
    const {
      host, sshPort, username, password, vncPassword, webPort,
    } = options;
    const hubPort = Number(options.hubPort) > 0 ? Number(options.hubPort) : 4390;
    let client = null;
    try {
      setProgress(job, '正在连接 SSH…');
      client = await connectSsh({ host, port: sshPort, username, password });

      setProgress(job, '检查 sudo 权限…');
      const identity = await execStream(client, 'id -u', { timeoutMs: 15000 });
      const isRoot = identity.output.trim().split(/\s+/).pop() === '0';
      let sudoPrefix = '';
      if (!isRoot) {
        const check = await execStream(client, "sudo -S -p '' -v", {
          stdin: `${password}\n`,
          timeoutMs: 15000,
        });
        if (check.code !== 0) {
          throw remoteError(
            'REMOTE_NO_SUDO',
            '这个 SSH 账号不能 sudo；请换一个管理员账号，或先给该账号 sudo 权限。',
          );
        }
        sudoPrefix = "sudo -S -p '' ";
      }

      // --- 1) the hub itself -------------------------------------------------
      // A blank machine gets the whole product, not just a VNC viewer.
      setProgress(job, '打包 Desk 程序…');
      const packed = await packApp();
      try {
        setProgress(job, `上传程序（${Math.max(1, Math.round(packed.bytes / 1024 / 1024))} MB）…`);
        const remotePkg = '/tmp/desk-hub.tar.gz';
        await uploadFile(client, packed.file, remotePkg);

        const fullScript = await fsp.readFile(path.join(HERE, '..', 'hub', 'desk-full-setup.sh'), 'utf8');
        const fullMarker = 'DESK_FULL_SCRIPT_EOF';
        if (fullScript.includes(fullMarker)) throw remoteError('REMOTE_SCRIPT_INVALID', 'setup script contains its own marker');
        const upFull = await execStream(client, [
          `cat > /tmp/desk-full-setup.sh <<'${fullMarker}'`,
          fullScript,
          fullMarker,
          'chmod 755 /tmp/desk-full-setup.sh',
        ].join('\n'), { timeoutMs: 30000 });
        if (upFull.code !== 0) throw remoteError('REMOTE_UPLOAD_FAILED', 'could not write the setup script on the target');

        setProgress(job, '安装并启动 Hub（首次 2-5 分钟）…');
        const full = await execStream(
          client,
          `${sudoPrefix}bash /tmp/desk-full-setup.sh ${shellQuote(String(hubPort))} ${shellQuote(remotePkg)}`,
          {
            stdin: isRoot ? '' : `${password}\n`,
            onLine: (line) => {
              const text = line.trim();
              if (text && !/^DESK_/.test(text)) setProgress(job, text.slice(0, 300));
            },
            timeoutMs: JOB_TIMEOUT_MS,
          },
        );
        const urlMatch = /DESK_HUB_URL=(\S+)/.exec(full.output);
        const codeMatch = /DESK_PAIR_CODE=(\d{6,10})/.exec(full.output);
        job.hubUrl = urlMatch ? urlMatch[1] : `http://${host}:${hubPort}`;
        job.pairCode = codeMatch ? codeMatch[1] : '';
        if (full.code !== 0 || !job.pairCode) {
          const tail = full.output.trim().split(/\r?\n/).slice(-3).join(' / ') || `exit ${full.code}`;
          throw remoteError('REMOTE_HUB_FAILED', `Hub 部署失败：${tail}`);
        }
      } finally {
        cleanupPack(packed.file);
      }

      // --- 2) the desktop ---------------------------------------------------
      setProgress(job, '上传配置脚本…');
      const script = await fsp.readFile(SCRIPT_FILE, 'utf8');
      const marker = 'DESK_REMOTE_SCRIPT_EOF';
      if (script.includes(marker)) throw remoteError('REMOTE_SCRIPT_INVALID', 'setup script contains its own marker');
      const upload = [
        `cat > /tmp/desk-remote-setup.sh <<'${marker}'`,
        script,
        marker,
        'chmod 755 /tmp/desk-remote-setup.sh',
      ].join('\n');
      const uploaded = await execStream(client, upload, { timeoutMs: 30000 });
      if (uploaded.code !== 0) throw remoteError('REMOTE_UPLOAD_FAILED', 'could not write the setup script on the target');

      setProgress(job, '开始安装远程桌面（大约 3-10 分钟）…');
      const command = `${sudoPrefix}bash /tmp/desk-remote-setup.sh ${shellQuote(vncPassword)} ${webPort}`;
      const result = await execStream(client, command, {
        stdin: isRoot ? '' : `${password}\n`,
        onLine: (line) => {
          const text = line.trim();
          if (text) setProgress(job, text.slice(0, 300));
        },
        timeoutMs: JOB_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        const tail = result.output.trim().split(/\r?\n/).slice(-3).join(' / ') || `exit ${result.code}`;
        throw remoteError('REMOTE_SETUP_FAILED', `远程配置失败：${tail}`);
      }

      setProgress(job, '读取被控机器时区…');
      let timezone = '';
      try {
        const tz = await execStream(client, 'timedatectl show -p Timezone --value', { timeoutMs: 15000 });
        timezone = tz.output.trim().split(/\r?\n/).pop() || '';
      } catch {
        /* timezone is a bonus, not a failure */
      }

      // The service starts with Restart=always; give it a few seconds to bind.
      setProgress(job, '等待远程桌面端口就绪…');
      let reachable = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const probe = await probeTcp(host, webPort, 1200);
        if (probe.reachable) {
          reachable = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      // websockify binds the web port even when its VNC backend is down, so a
      // green TCP probe alone is NOT proof that the desktop is viewable.
      setProgress(job, '检查 VNC 后端 5900…');
      let vncReady = false;
      if (reachable) {
        try {
          const check = await execStream(client, "ss -ltn 2>/dev/null | grep -q ':5900\\b' && echo ok || echo missing", { timeoutMs: 15000 });
          vncReady = check.output.trim().split(/\s+/).pop() === 'ok';
        } catch { /* keep the warning path */ }
      }

      job.timezone = timezone;
      job.address = host;
      const cache = await readInfoCache();
      cache[host] = {
        ...(cache[host] || {}),
        timezone: timezone || cache[host]?.timezone || '',
        webPort,
        ready: reachable && vncReady,
        lastProvisionedAt: nowIso(),
      };
      await writeInfoCache(cache);

      if (!reachable) {
        job.state = 'warning';
        job.message = '系统配置完成，但 6080 端口还没响应；可能需要再等半分钟或检查防火墙。';
      } else if (!vncReady && !job.hubUrl) {
        job.state = 'warning';
        job.message = 'noVNC 网页已打开，但 VNC 后端 5900 未监听，桌面仍看不到。常见于 Wayland 会话：脚本已把默认会话固定为 Xorg，请重启机器并重新登录后重新运行。';
      } else {
        job.state = 'done';
        job.message = `远程桌面已就绪${timezone ? `（时区 ${timezone}）` : ''}。`;
      }
      job.finishedAt = nowIso();
    } catch (err) {
      job.state = 'error';
      job.message = /^REMOTE_/.test(String(err?.code || '')) ? (err.message || '远程配置失败') : friendlySshError(err);
      job.finishedAt = nowIso();
      job.log.push(`error: ${job.message}`);
    } finally {
      try { client?.end(); } catch { /* already gone */ }
      // Never keep the password beyond the job.
      job.password = undefined;
    }
  }

  return {
    start(input = {}) {
      const host = assertHost(input.host);
      const sshPort = assertPort(input.sshPort, 22, 'sshPort');
      const webPort = assertPort(input.webPort, 6080, 'webPort');
      const hubPort = assertPort(input.hubPort, 4390, 'hubPort');
      const username = assertCredential(input.username, 'SSH username');
      const password = assertCredential(input.password, 'SSH password');
      const vncPassword = String(input.vncPassword || 'desk1234').slice(0, 64);
      if (!vncPassword) throw remoteError('REMOTE_CREDENTIALS', 'VNC password is required');

      const job = {
        id: uid('prov'),
        state: 'running',
        message: '排队中…',
        step: 0,
        totalSteps: 9,
        address: host,
        webPort,
        hubPort,
        hubUrl: '',
        pairCode: '',
        timezone: '',
        startedAt: nowIso(),
        finishedAt: null,
        log: [],
      };
      jobs.set(job.id, job);
      // Drop old finished jobs so a long-running process does not grow forever.
      for (const [id, entry] of jobs) {
        if (entry.state !== 'running' && Date.now() - Date.parse(entry.startedAt) > 60 * 60 * 1000) {
          jobs.delete(id);
        }
      }
      run(job, { host, sshPort, username, password, vncPassword, webPort });
      return publicJob(job);
    },
    get(id) {
      const job = jobs.get(String(id || ''));
      return job ? publicJob(job) : null;
    },
    list() {
      return [...jobs.values()].map(publicJob);
    },
  };
}