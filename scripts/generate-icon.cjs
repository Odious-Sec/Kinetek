/**
 * Generates a 1024x1024 source app icon (app-icon.png) with no external
 * dependencies — just Node's built-in zlib. Run `npx tauri icon app-icon.png`
 * afterwards to produce the platform icon set in src-tauri/icons/.
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const SIZE = 1024;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Distance from point p to segment a-b.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// Raw RGBA pixel buffer.
const raw = Buffer.alloc(SIZE * SIZE * 4);

const radius = SIZE * 0.22; // rounded-corner radius
const stroke = SIZE * 0.072;

// "K" geometry (centered).
const cx = SIZE / 2;
const kx = SIZE * 0.36; // stem x
const top = SIZE * 0.28;
const bot = SIZE * 0.72;
const mid = SIZE * 0.5;
const right = SIZE * 0.68;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;

    // Rounded-square alpha mask.
    const dx = Math.max(radius - x, x - (SIZE - radius), 0);
    const dy = Math.max(radius - y, y - (SIZE - radius), 0);
    const cornerDist = Math.hypot(dx, dy);
    let alpha = cornerDist <= radius ? 255 : 0;
    // antialias the corner edge
    if (cornerDist > radius && cornerDist < radius + 1.5) {
      alpha = Math.round(255 * (1 - (cornerDist - radius) / 1.5));
    }

    // Diagonal indigo gradient background.
    const t = (x + y) / (2 * SIZE);
    let r = lerp(99, 49, t); // #6366f1 -> #4f46e5-ish deeper
    let g = lerp(102, 46, t);
    let b = lerp(241, 160, t);

    // White "K" strokes: vertical stem + two diagonal arms.
    const dArmUp = segDist(x, y, kx, mid, right, top);
    const dArmDn = segDist(x, y, kx, mid, right, bot);
    const stemHit =
      x >= kx - stroke / 2 && x <= kx + stroke / 2 && y >= top && y <= bot;
    const inK = stemHit || dArmUp <= stroke / 2 || dArmDn <= stroke / 2;
    if (inK && alpha > 0) {
      r = 255;
      g = 255;
      b = 255;
    }

    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = alpha;
  }
}

// Add PNG filter byte (0 = none) per scanline.
const stride = SIZE * 4;
const filtered = Buffer.alloc((stride + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  filtered[y * (stride + 1)] = 0;
  raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(filtered, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "app-icon.png");
fs.writeFileSync(out, png);
console.log(`Wrote ${out} (${SIZE}x${SIZE}, ${png.length} bytes)`);
