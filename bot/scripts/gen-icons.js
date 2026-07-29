import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'panel', 'static');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const v = pixel(x, y);
      raw[p++] = v; raw[p++] = v; raw[p++] = v;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SS = 4;

function mark(size) {
  const c = (size - 1) / 2;
  const rOuter = size * 0.350;
  const rGap = size * 0.245;
  const rCore = size * 0.150;

  const inside = (x, y) => {
    const d = Math.abs(x - c) + Math.abs(y - c);
    if (d <= rCore) return true;
    if (d > rGap && d <= rOuter) return true;
    return false;
  };

  return (x, y) => {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (inside(x + (sx + 0.5) / SS - 0.5, y + (sy + 0.5) / SS - 0.5)) hit++;
      }
    }
    return Math.round((hit / (SS * SS)) * 255);
  };
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  const buf = png(size, mark(size));
  fs.writeFileSync(file, buf);
  console.log(`${path.relative(process.cwd(), file)}  ${size}x${size}  ${buf.length} б`);
}
