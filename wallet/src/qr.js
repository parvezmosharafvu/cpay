// QR codes for what this wallet shows to be paid: a Lightning invoice
// (lightning:<invoice>) or, on the test network, a deposit address
// (bitcoin:<address>). Drawn on a <canvas> from the module matrix of the
// pinned qrcode-generator library (vendor/qrcode.js), so no HTML string
// is built and nothing is fetched. Error correction M, 4-module quiet zone.
import qrcode from './vendor/qrcode.js';

export function qrMatrix(text) {
  const q = qrcode(0, 'M'); // 0 = smallest version that fits
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
    rows.push(row);
  }
  return rows;
}

export function drawQr(canvas, text, { px = 280 } = {}) {
  const m = qrMatrix(text);
  const quiet = 4;
  const cells = m.length + quiet * 2;
  const scale = Math.max(2, Math.floor(px / cells));
  const size = cells * scale;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  canvas.hidden = false;
}

export const lightningUri = (invoice) => `lightning:${invoice}`;
export const bitcoinUri = (address) => `bitcoin:${address}`;
