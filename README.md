# pointpick-lab

**Ray picking on a 250,000-point cloud: 39.9 µs/ray with an octree vs 1,032.3 µs/ray with the linear scan in [`baseline/brute.mjs`](baseline/brute.mjs) — 25.9× faster, with 400/400 identical hit/miss results and a max nearest-distance error of 0.0.**

Upstream: https://github.com/mrdoob/three.js

The upstream relationship is the render layer only: `main.js` draws with three.js r169 from a pinned CDN importmap. The octree, the ray traversal and every number below are original and run in plain node — `src/core.mjs` imports no three.js and touches no DOM.

## What this is

A point-cloud picking lab. `src/core.mjs` builds a flat, typed-array octree over an xyz buffer and answers "which point is nearest this ray, within radius r?" by pruning node boxes against the current best hit. The page is a 250k-point cloud you can orbit; hover to probe, and press <kbd>B</kbd> to swap the octree for the brute-force baseline and watch the HUD jump from tens of microseconds to about a millisecond.

## Run it

```bash
node tools/gen-sample.mjs && python3 -m http.server 4173
# open http://localhost:4173
```

Regenerating the sample is deterministic (seed `20261030`); `data/cloud.bin` is committed so the page works without the first step.

Verify and time the core (no browser involved):

```bash
node bench/verify.mjs   # 11 assertions, exit 0 only if all hold
node bench/bench.mjs    # writes bench/result.json
```

## Evidence

From [`bench/result.json`](bench/result.json) (node v24.19.0, AMD EPYC 7K62, 4 cores, 250,000 points, 400 rays/rep, 7 reps after 1 warmup, pick radius 0.08):

| path | median / 400 rays | per ray | p95 | rel. stddev |
| --- | --- | --- | --- | --- |
| octree (`src/core.mjs`) | 15.943 ms | **39.9 µs** | 16.69 ms | 3.1% |
| linear scan (`baseline/brute.mjs`) | 412.915 ms | **1,032.3 µs** | 414.73 ms | 0.3% |

- **25.9× median speedup**, 26.8× on best-of-7 minima. Cold start (very first call, JIT cold): 1.26 ms vs 9.45 ms.
- **400/400 rays agree** on hit vs miss; 392 hit within radius 0.08. Max |Δdistance| = 0.0 (exact same nearest distance).
- Octree build: **83.7 ms median** (min 64.7) for 250k points → 57,981 nodes / 50,751 leaves. Build is excluded from pick timings and reported separately.
- Build time's relative stddev is 17.0%, above the 10% flag: it is a one-shot allocation-heavy phase, so GC scheduling dominates the spread. Pick timings, which are what the claim is about, sit at 3.1% and 0.3%.
- Sample integrity: `data/cloud.bin` sha256 `098999f2…511d31` is recorded in `data/meta.json` and re-checked by `bench/verify.mjs`, which also regenerates 50k points twice and byte-compares them.

`bench/verify.mjs` asserts, against the committed sample: sha256 match, 250,000 points, generator determinism, octree covering every index exactly once, 400/400 hit agreement at radius 0.08, 150/150 at radius 0.02 (radius-pruning path), zero cases where the octree returns a farther point, identical hit counts, and ≥8× speedup.

## How it works

1. `buildOctree` cubes the bounds, then partitions point indices into octants in place (`order` array), stopping at 16 points/leaf or depth 14. Nodes are flattened into typed arrays.
2. `pickRay` walks nodes near-first. A node is pruned when `dist(ray, nodeCentre) − halfDiagonal` exceeds the current best distance — a valid lower bound, so pruning never loses the true nearest point.
3. `pickRayBrute` in `baseline/brute.mjs` is the control: the same distance metric over every point, no index. Both return `{ index, distance }`.

## Known limitations

- Static clouds only; there is no incremental insert/remove, so a moving cloud must be rebuilt (83.7 ms at 250k).
- The radius is a world-space constant supplied by the caller; the page scales it with camera distance, the bench fixes it at 0.08.
- Timings are single-process, single-thread on a shared 4-core VM; the ratio is stable, the absolute microseconds will move on other hardware.
- The cloud is synthetic and clustered (85% blobs, 15% uniform background); uniformly random clouds give shallower trees and a smaller win.
