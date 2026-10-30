// Deterministic sample point cloud generator.
// Writes data/cloud.bin (Float32 xyz) and data/meta.json (count, seed, sha256).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller with a seeded uniform source.
function gauss(rnd) {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 250k points: 12 gaussian clusters (structured, octree-friendly) plus 15% uniform
 * background (the hard case for any spatial index). Clamped to [-10, 10]^3.
 */
export function generateCloud(count = 250000, seed = 20261030) {
  const rnd = mulberry32(seed);
  const out = new Float32Array(count * 3);
  const clusters = [];
  for (let i = 0; i < 12; i++) {
    clusters.push({
      x: (rnd() * 2 - 1) * 7.5,
      y: (rnd() * 2 - 1) * 7.5,
      z: (rnd() * 2 - 1) * 7.5,
      s: 0.55 + rnd() * 1.9,
    });
  }
  const bg = 0.15;
  for (let i = 0; i < count; i++) {
    let x, y, z;
    if (rnd() < bg) {
      x = (rnd() * 2 - 1) * 10;
      y = (rnd() * 2 - 1) * 10;
      z = (rnd() * 2 - 1) * 10;
    } else {
      const c = clusters[(rnd() * clusters.length) | 0];
      x = c.x + gauss(rnd) * c.s;
      y = c.y + gauss(rnd) * c.s;
      z = c.z + gauss(rnd) * c.s;
      x = Math.max(-10, Math.min(10, x));
      y = Math.max(-10, Math.min(10, y));
      z = Math.max(-10, Math.min(10, z));
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
}

export function cloudMeta(positions, seed) {
  const buf = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  return {
    count: positions.length / 3,
    seed,
    format: 'float32-le-xyz',
    bytes: positions.byteLength,
    bounds: [-10, 10],
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

export function writeSample(dir = join(ROOT, 'data'), count = 250000, seed = 20261030) {
  const positions = generateCloud(count, seed);
  const meta = cloudMeta(positions, seed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cloud.bin'), Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { positions, meta };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = Number(process.argv[2] || 250000);
  const { meta } = writeSample(join(ROOT, 'data'), count);
  console.log(`wrote data/cloud.bin  points=${meta.count}  bytes=${meta.bytes}  sha256=${meta.sha256.slice(0, 16)}…`);
}
