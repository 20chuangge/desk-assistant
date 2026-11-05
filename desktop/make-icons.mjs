/**
 * make-icons.mjs - assemble the Windows .ico (PNG-compressed, Vista+) and the
 * small convenience copies used by the web manifest and electron-builder.
 * Pure Node, no deps: an ICO is a 6-byte header + 16-byte entries + payloads.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const iconsDir = path.join(root, 'public', 'icons');
const buildDir = path.join(root, 'desktop', 'build');

function buildIco(sizes) {
  const pngs = sizes.map((s) => ({ size: s, buf: fs.readFileSync(path.join(iconsDir, `icon-${s}.png`)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(pngs.length, 4);  // image count

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const p of pngs) {
    const e = Buffer.alloc(16);
    e[0] = p.size >= 256 ? 0 : p.size;   // width  (0 means 256)
    e[1] = p.size >= 256 ? 0 : p.size;   // height
    e[2] = 0;                             // palette
    e[3] = 0;                             // reserved
    e.writeUInt16LE(1, 4);                // color planes
    e.writeUInt16LE(32, 6);               // bits per pixel
    e.writeUInt32LE(p.buf.length, 8);     // size in bytes
    e.writeUInt32LE(offset, 12);          // offset of payload
    entries.push(e);
    offset += p.buf.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]);
}

const ico = buildIco([16, 24, 32, 48, 64, 128, 256]);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(root, 'public', 'favicon.ico'), ico);
fs.writeFileSync(path.join(buildDir, 'icon.png'), fs.readFileSync(path.join(buildDir, 'icon-1024.png')));

// apple-touch-icon must be opaque-ish 180x180 and live at a stable URL
fs.copyFileSync(path.join(iconsDir, 'icon-180.png'), path.join(iconsDir, 'apple-touch-icon.png'));

for (const f of ['icon.ico', 'icon.png', 'icon-1024.png']) {
  const st = fs.statSync(path.join(buildDir, f));
  console.log(`${f.padEnd(14)} ${(st.size / 1024).toFixed(1)} KB`);
}
console.log('favicon.ico + apple-touch-icon.png written');
