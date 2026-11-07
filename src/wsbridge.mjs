/**
 * wsbridge.mjs - a WebSocket <-> TCP bridge, enough for noVNC to reach a VNC
 * server. Linux hubs use websockify for this; Windows has none, so the hub
 * does it itself (RFC 6455: handshake, masked client frames, unmasked binary
 * server frames, ping/pong, close). The VNC stream is a byte stream, so
 * fragmented messages are forwarded as they arrive.
 */

import crypto from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(payload, opcode = 0x2) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Take over an HTTP upgrade (already authorised by the caller) and connect it
 * to host:port. Returns false when the request is not a WebSocket handshake.
 */
export function bridgeWebSocket(req, socket, head, { host = '127.0.0.1', port }) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return false;
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim()).filter(Boolean);
  const protocol = offered.includes('binary') ? 'binary' : '';

  const upstream = net.connect(port, host);
  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let open = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.end(frame(Buffer.alloc(0), 0x8)); } catch { /* gone */ }
    socket.destroy();
    upstream.destroy();
  };

  const pump = () => {
    // Parse as many complete client frames as are buffered.
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let len = pending[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (pending.length < 4) return;
        len = pending.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (pending.length < 10) return;
        len = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + len) return;
      const payload = Buffer.from(pending.subarray(offset, offset + len));
      if (masked) {
        const mask = pending.subarray(maskAt, maskAt + 4);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      pending = pending.subarray(offset + len);
      if (opcode === 0x8) { close(); return; }
      if (opcode === 0x9) { socket.write(frame(payload, 0xa)); continue; }
      if (opcode === 0xa) continue;
      upstream.write(payload); // text, binary or continuation: bytes for VNC
    }
  };

  upstream.on('connect', () => {
    open = true;
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
      '',
      '',
    ].join('\r\n'));
    pump();
  });
  upstream.on('data', (chunk) => socket.write(frame(chunk)));
  upstream.on('error', () => {
    if (!open) {
      try { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { /* gone */ }
    }
    close();
  });
  upstream.on('close', close);
  socket.on('data', (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    if (open) pump();
  });
  socket.on('error', close);
  socket.on('close', close);
  return true;
}
