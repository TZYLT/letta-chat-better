#!/usr/bin/env node
/**
 * Regenerates assets/tutor-profile.png — the tutorial agent's default avatar.
 *
 * Why this exists: the upstream image that used to sit at this path is a Letta
 * brand asset, and the "Brand Assets Exclusion" in LICENSE says brand images are
 * not covered by the Apache-2.0 grant and may not be used in derivative works.
 * This script draws a replacement that is original to this fork, and keeps the
 * asset reproducible instead of being a binary of unknown origin.
 *
 * Pure Node: pixels come from signed-distance functions and the PNG is written
 * by hand (zlib + CRC32), so no image library enters the dependency tree.
 *
 * Usage: node scripts/generate-tutor-avatar.cjs [output.png]
 *        (defaults to assets/tutor-profile.png; 512x512 RGBA)
 */
const fs = require("node:fs");
const zlib = require("node:zlib");
const path = require("node:path");

const OUT = process.argv[2] || path.join(process.cwd(), "assets", "tutor-profile.png");
const SIZE = 512;
const SS = 2; // supersample factor for antialiasing
const N = SIZE * SS;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── geometry ────────────────────────────────────────────────────────────────
function capsuleDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const t = clamp01((apx * abx + apy * aby) / (abx * abx + aby * aby));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return Math.hypot(dx, dy);
}

const C = N / 2;
const ARM = N * 0.30;
const ARM_HALF = N * 0.013;
const BRANCH_HALF = N * 0.010;
const BRANCH_LEN = N * 0.088;
const HUB = N * 0.075;
const TIP = N * 0.026;

const strokes = [];
for (let i = 0; i < 6; i += 1) {
  const angle = (i * Math.PI) / 3 - Math.PI / 2;
  const ex = C + Math.cos(angle) * ARM;
  const ey = C + Math.sin(angle) * ARM;
  strokes.push({ ax: C, ay: C, bx: ex, by: ey, half: ARM_HALF });
  for (const [at, spread] of [
    [0.52, 0.72],
    [0.82, 0.72],
  ]) {
    const bx0 = C + Math.cos(angle) * ARM * at;
    const by0 = C + Math.sin(angle) * ARM * at;
    for (const sign of [1, -1]) {
      const branchAngle = angle + (sign * spread * Math.PI) / 2.2;
      strokes.push({
        ax: bx0,
        ay: by0,
        bx: bx0 + Math.cos(branchAngle) * BRANCH_LEN,
        by: by0 + Math.sin(branchAngle) * BRANCH_LEN,
        half: BRANCH_HALF,
      });
    }
  }
}

/** Signed coverage of the mark: >0 inside, in supersampled pixel units. */
function markDistance(x, y) {
  let best = Math.hypot(x - C, y - C) - HUB;
  for (const s of strokes) {
    const d = capsuleDistance(x, y, s.ax, s.ay, s.bx, s.by) - s.half;
    if (d < best) {
      best = d;
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const angle = (i * Math.PI) / 3 - Math.PI / 2;
    const dx = x - (C + Math.cos(angle) * ARM);
    const dy = y - (C + Math.sin(angle) * ARM);
    const d = Math.hypot(dx, dy) - TIP;
    if (d < best) {
      best = d;
    }
  }
  return best;
}

// ── background: cold spring-snow blue radial gradient ───────────────────────
const INNER = [244, 250, 255];
const OUTER = [53, 103, 158];
const CORNER = [26, 55, 92];

function background(x, y) {
  const u = (x - N * 0.42) / (N * 0.78);
  const v = (y - N * 0.36) / (N * 0.78);
  const t = clamp01(Math.hypot(u, v));
  const eased = t * t * (3 - 2 * t);
  let rgb = [
    lerp(INNER[0], OUTER[0], eased),
    lerp(INNER[1], OUTER[1], eased),
    lerp(INNER[2], OUTER[2], eased),
  ];
  const cu = Math.max(Math.abs(x / N - 0.5), Math.abs(y / N - 0.5)) * 2;
  const corner = clamp01((cu - 0.62) / 0.38) * 0.45;
  rgb = [
    lerp(rgb[0], CORNER[0], corner),
    lerp(rgb[1], CORNER[1], corner),
    lerp(rgb[2], CORNER[2], corner),
  ];
  return rgb;
}

// ── rasterize ───────────────────────────────────────────────────────────────
const SHADOW_OFFSET = N * 0.010;
const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const px = x * SS + sx + 0.5;
        const py = y * SS + sy + 0.5;
        let [cr, cg, cb] = background(px, py);

        const shadow = clamp01(0.5 - markDistance(px - SHADOW_OFFSET, py - SHADOW_OFFSET));
        if (shadow > 0) {
          const a = shadow * 0.30;
          cr = lerp(cr, 18, a);
          cg = lerp(cg, 42, a);
          cb = lerp(cb, 74, a);
        }

        const cover = clamp01(0.5 - markDistance(px, py));
        if (cover > 0) {
          cr = lerp(cr, 255, cover * 0.97);
          cg = lerp(cg, 255, cover * 0.97);
          cb = lerp(cb, 255, cover * 0.97);
        }

        r += cr;
        g += cg;
        b += cb;
      }
    }
    const samples = SS * SS;
    const offset = (y * SIZE + x) * 4;
    pixels[offset] = Math.round(r / samples);
    pixels[offset + 1] = Math.round(g / samples);
    pixels[offset + 2] = Math.round(b / samples);
    pixels[offset + 3] = 255;
  }
}

// ── PNG container ───────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB)`);
