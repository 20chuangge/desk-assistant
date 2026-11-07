/**
 * render-icons.cjs - rasterise desktop/build/icon.svg into every PNG size the
 * app, the web manifest and the Windows .ico need. Runs inside Electron (the
 * only renderer already in the repo), then make-icons.mjs packs the .ico.
 *
 *   npm run desktop:icons
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const svg = fs.readFileSync(path.join(__dirname, 'build', 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 180, 192, 256, 512];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  const render = (size) => win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.querySelector('canvas');
        c.width = ${size}; c.height = ${size};
        const g = c.getContext('2d');
        g.clearRect(0, 0, ${size}, ${size});
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
  for (const size of SIZES) {
    fs.writeFileSync(path.join(root, 'public', 'icons', `icon-${size}.png`), Buffer.from(await render(size), 'base64'));
  }
  fs.writeFileSync(path.join(__dirname, 'build', 'icon-1024.png'), Buffer.from(await render(1024), 'base64'));
  console.log(`rendered ${SIZES.length + 1} sizes`);
  app.quit();
});
