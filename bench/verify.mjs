// Assertions over the real generated sample. Exit 0 only if every check holds.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildOctree, pickRay, octreeStats } from '../src/core.mjs';
import { pickRayBrute } from '../baseline/brute.mjs';
import { generateCloud } from '../tools/gen-sample.mjs';
import { makeRays, rayAt } from './rays.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let checks = 0;

function check(name, ok, detail) {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures.push(name);
}

const meta = JSON.parse(readFileSync(join(ROOT, 'data/meta.json'), 'utf8'));
const bin = readFileSync(join(ROOT, 'data/cloud.bin'));
const positions = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
const sha = createHash('sha256').update(bin).digest('hex');

check('sample sha256 matches meta.json', sha === meta.sha256, `${sha.slice(0, 12)}…`);
check('sample point count', positions.length / 3 === meta.count && meta.count === 250000,
  `${positions.length / 3} points, ${bin.byteLength} bytes`);

// Determinism: two independent generations must be byte-identical.
const g1 = Buffer.from(generateCloud(50000, 20261030).buffer);
const g2 = Buffer.from(generateCloud(50000, 20261030).buffer);
check('generator deterministic (50k prefix)', Buffer.compare(g1, g2) === 0,
  `sha256 ${createHash('sha256').update(g1).digest('hex').slice(0, 12)}…`);

const t0 = process.hrtime.bigint();
const tree = buildOctree(positions, { maxLeaf: 16, maxDepth: 14 });
const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
const stats = octreeStats(tree);
check('octree has leaves and branches', stats.nodes > 1000 && stats.leaves > 500,
  `${stats.nodes} nodes / ${stats.leaves} leaves, build ${buildMs.toFixed(1)} ms`);
check('octree indexes every point exactly once', (() => {
  const seen = new Uint8Array(positions.length / 3);
  for (let i = 0; i < tree.order.length; i++) seen[tree.order[i]] = 1;
  let sum = 0;
  for (let i = 0; i < seen.length; i++) sum += seen[i];
  return sum === seen.length;
})(), `${tree.order.length} indices`);

const rays = makeRays(positions, 400, 7);
let agree = 0, bothHits = 0, maxErr = 0, octreeBetter = 0;
for (let i = 0; i < rays.count; i++) {
  const { origin, direction } = rayAt(rays, i);
  const fast = pickRay(tree, origin, direction, 0.08);
  const slow = pickRayBrute(positions, origin, direction, 0.08);
  const sameHit = (fast.index < 0) === (slow.index < 0);
  if (sameHit) agree++;
  if (fast.index >= 0 && slow.index >= 0) {
    bothHits++;
    const err = Math.abs(fast.distance - slow.distance);
    if (err > maxErr) maxErr = err;
    if (fast.distance > slow.distance + 1e-9) octreeBetter++;
  }
}
check('hit/miss agreement with brute force', agree === rays.count, `${agree}/${rays.count} rays, ${bothHits} hits`);
check('nearest-distance error below 1e-6', maxErr < 1e-6, `max |Δd| = ${maxErr.toExponential(2)}`);
check('octree never returns a farther point than brute force', octreeBetter === 0, `${octreeBetter} violations`);

// Tight radius exercises the radius-pruning path.
let tightAgree = 0;
for (let i = 0; i < 150; i++) {
  const { origin, direction } = rayAt(rays, i);
  const a = pickRay(tree, origin, direction, 0.02);
  const b = pickRayBrute(positions, origin, direction, 0.02);
  const bothMiss = a.index < 0 && b.index < 0;
  if (bothMiss || ((a.index < 0) === (b.index < 0) && Math.abs(a.distance - b.distance) < 1e-6)) tightAgree++;
}
check('radius=0.02 pruning stays exact', tightAgree === 150, `${tightAgree}/150 rays`);

// Speed: best-of-3 over all 400 rays, same work for both implementations.
function run(fn) {
  const t = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < rays.count; i++) {
    const { origin, direction } = rayAt(rays, i);
    if (fn(origin, direction).index >= 0) hits++;
  }
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, hits };
}
const fastFn = (o, d) => pickRay(tree, o, d, 0.08);
const slowFn = (o, d) => pickRayBrute(positions, o, d, 0.08);
run(fastFn); run(slowFn); // warmup
let fast = Infinity, slow = Infinity, fastHits = 0, slowHits = 0;
for (let r = 0; r < 3; r++) {
  const a = run(fastFn), b = run(slowFn);
  fast = Math.min(fast, a.ms); slow = Math.min(slow, b.ms);
  fastHits = a.hits; slowHits = b.hits;
}
const speedup = slow / fast;
check('both paths report the same hit count', fastHits === slowHits, `${fastHits} hits`);
check('octree at least 8x faster than linear scan', speedup >= 8,
  `${fast.toFixed(2)} ms vs ${slow.toFixed(2)} ms  (${speedup.toFixed(1)}x)`);

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error('failed: ' + failures.join(', '));
  process.exit(1);
}
process.exit(0);
