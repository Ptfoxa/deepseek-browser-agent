import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = resolve(import.meta.dirname, '../icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = Math.round(size * 0.24);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      let inside = true;
      if (dx < radius && dy < radius) {
        const d = Math.hypot(radius - dx, radius - dy);
        inside = d <= radius;
      }
      if (!inside) {
        raw[offset + 3] = 0;
        continue;
      }
      const t = y / Math.max(1, size - 1);
      const r = Math.round(36 + 26 * (1 - t));
      const g = Math.round(110 + 70 * (1 - t));
      const b = Math.round(240 - 30 * t);
      const cx = size / 2;
      const cy = size / 2;
      const ring = Math.hypot(x - cx, y - cy);
      const isSpark =
        ring < size * 0.14 ||
        (Math.abs(x - cx) < size * 0.035 && Math.abs(y - cy) < size * 0.31) ||
        (Math.abs(y - cy) < size * 0.035 && Math.abs(x - cx) < size * 0.31);
      raw[offset] = isSpark ? 255 : r;
      raw[offset + 1] = isSpark ? 255 : g;
      raw[offset + 2] = isSpark ? 255 : b;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(resolve(outDir, `icon-${size}.png`), makePng(size));
}
process.stdout.write(`Icons written to ${outDir}\n`);
