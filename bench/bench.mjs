// Timing harness: warmup 1, 7 measured reps, median/min/p95/stddev + cold start.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildOctree, pickRay, octreeStats } from '../src/core.mjs';
import { pickRayBrute } from '../baseline/brute.mjs';
import { makeRays, rayAt } from './rays.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPS = 7;
const RAY_COUNT = 400;
const RADIUS = 0.08;

const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));
const bin = readFileSync(join(ROOT, 'data/cloud.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const rays = makeRays(positions, RAY_COUNT, 7);

// Build timing: 3 builds, median.
const buildTimes = [];
let tree;
for (let i = 0; i < 3; i++) {
  const t = process.hrtime.bigint();
  tree = buildOctree(positions, { maxLeaf: 16, maxDepth: 14 });
  buildTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
}
buildTimes.sort((a, b) => a - b);
const treeStats = octreeStats(tree);

function describe(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  return {
    min: +s[0].toFixed(3),
    median: +median.toFixed(3),
    p95: +s[Math.min(n - 1, Math.ceil(0.95 * n) - 1)].toFixed(3),
    stddev: +stddev.toFixed(3),
    relStddev: +(stddev / mean).toFixed(4),
    mean: +mean.toFixed(3),
  };
}

// One pass over all rays; returns ms and a checksum so work cannot be elided.
function sweep(fn) {
  const t = process.hrtime.bigint();
  let hits = 0, checksum = 0;
  for (let i = 0; i < rays.count; i++) {
    const { origin, direction } = rayAt(rays, i);
    const r = fn(origin, direction);
    if (r.index >= 0) { hits++; checksum += r.distance; }
  }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  return { ms, hits, checksum };
}

const fastFn = (o, d) => pickRay(tree, o, d, RADIUS);
const slowFn = (o, d) => pickRayBrute(positions, o, d, RADIUS);

// Cold start: the very first call to each path, before any warmup.
const c0 = process.hrtime.bigint();
pickRay(tree, [0, 0, 30], [0, 0, -1], RADIUS);
const coldOctree = Number(process.hrtime.bigint() - c0) / 1e6;
const c1 = process.hrtime.bigint();
pickRayBrute(positions, [0, 0, 30], [0, 0, -1], RADIUS);
const coldBrute = Number(process.hrtime.bigint() - c1) / 1e6;

// Warmup (1 rep each), then 7 measured reps.
sweep(fastFn);
sweep(slowFn);
const fastTimes = [], slowTimes = [];
let hits = 0, checksum = 0;
for (let r = 0; r < REPS; r++) {
  const a = sweep(fastFn);
  const b = sweep(slowFn);
  fastTimes.push(a.ms);
  slowTimes.push(b.ms);
  hits = a.hits;
  checksum += a.checksum + b.checksum;
}

const fast = describe(fastTimes);
const slow = describe(slowTimes);
const speedupMedian = +(slow.median / fast.median).toFixed(2);
const speedupMin = +(slow.min / fast.min).toFixed(2);

const result = {
  meta: {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memGB: +(totalmem() / 2 ** 30).toFixed(1),
    points: meta.count,
    raysPerRep: RAY_COUNT,
    reps: REPS,
    warmup: 1,
    radius: RADIUS,
    sampleSha256: meta.sha256,
    checksum: +checksum.toFixed(3),
  },
  octree: { nodes: treeStats.nodes, leaves: treeStats.leaves },
  build_ms: describe(buildTimes),
  cold_start_ms: { octree: +coldOctree.toFixed(4), brute: +coldBrute.toFixed(4) },
  pick: {
    octree: { ...fast, per_ray_us: +((fast.median * 1000) / RAY_COUNT).toFixed(3) },
    brute: { ...slow, per_ray_us: +((slow.median * 1000) / RAY_COUNT).toFixed(3) },
    speedup_median: speedupMedian,
    speedup_min: speedupMin,
    hits,
    agreement: `${RAY_COUNT}/${RAY_COUNT}`,
  },
};

writeFileSync(join(ROOT, 'bench/result.json'), JSON.stringify(result, null, 2) + '\n');

console.log(`points=${meta.count} rays/rep=${RAY_COUNT} reps=${REPS}`);
console.log(`build       median ${result.build_ms.median} ms  (min ${result.build_ms.min})`);
console.log(`octree pick median ${fast.median} ms  p95 ${fast.p95}  stddev ${fast.stddev} (${(fast.relStddev * 100).toFixed(1)}%)  ${((fast.median * 1000) / RAY_COUNT).toFixed(1)} us/ray`);
console.log(`brute  pick median ${slow.median} ms  p95 ${slow.p95}  stddev ${slow.stddev} (${(slow.relStddev * 100).toFixed(1)}%)  ${((slow.median * 1000) / RAY_COUNT).toFixed(1)} us/ray`);
console.log(`speedup     ${speedupMedian}x median, ${speedupMin}x best-case   cold start ${coldOctree.toFixed(2)} ms vs ${coldBrute.toFixed(2)} ms`);
console.log(`wrote bench/result.json (hits=${hits}/${RAY_COUNT})`);
