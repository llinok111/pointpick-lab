// Pure point-cloud core: bounds, octree build, ray picking.
// No three.js, no DOM, no I/O. Everything here runs in plain node.

/** Axis-aligned bounds of an xyz Float32Array. */
export function computeBounds(positions) {
  if (!positions || positions.length < 3) throw new Error('empty point cloud');
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// Squared distance from a point to a ray (origin + t*dir, t >= 0, dir unit).
function pointRayDist2(px, py, pz, ox, oy, oz, dx, dy, dz) {
  const wx = px - ox, wy = py - oy, wz = pz - oz;
  let t = wx * dx + wy * dy + wz * dz;
  if (t < 0) t = 0;
  const qx = wx - t * dx, qy = wy - t * dy, qz = wz - t * dz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * Build an octree over positions (Float32Array, xyz interleaved).
 * Leaves hold at most maxLeaf point indices; depth is capped at maxDepth.
 * Returns flat typed arrays so the structure stays compact and GC-friendly.
 */
export function buildOctree(positions, options = {}) {
  const count = (positions.length / 3) | 0;
  if (count === 0) throw new Error('empty point cloud');
  const maxLeaf = options.maxLeaf ?? 16;
  const maxDepth = options.maxDepth ?? 14;
  const b = computeBounds(positions);
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1e-6);
  const half = span * 0.5 * 1.000001;
  const cx = (b.min[0] + b.max[0]) * 0.5;
  const cy = (b.min[1] + b.max[1]) * 0.5;
  const cz = (b.min[2] + b.max[2]) * 0.5;

  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;

  // Build nodes in a growable array, then flatten.
  const nodes = [{ cx, cy, cz, half, start: 0, count, child: null }];
  const stack = [[0, 0]];
  while (stack.length) {
    const [ni, depth] = stack.pop();
    const node = nodes[ni];
    if (node.count <= maxLeaf || depth >= maxDepth) continue;
    const start = node.start;
    const n = node.count;
    const counts = new Int32Array(8);
    const octant = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const idx = order[start + k];
      const x = positions[idx * 3], y = positions[idx * 3 + 1], z = positions[idx * 3 + 2];
      const o = (x >= node.cx ? 1 : 0) | (y >= node.cy ? 2 : 0) | (z >= node.cz ? 4 : 0);
      octant[k] = o;
      counts[o]++;
    }
    const offsets = new Int32Array(9);
    for (let o = 0; o < 8; o++) offsets[o + 1] = offsets[o] + counts[o];
    const cursor = offsets.slice(0, 8);
    const tmp = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const o = octant[k];
      tmp[cursor[o]++] = order[start + k];
    }
    order.set(tmp, start);

    const h = node.half * 0.5;
    const child = new Int32Array(8).fill(-1);
    for (let o = 0; o < 8; o++) {
      if (!counts[o]) continue;
      const childIndex = nodes.length;
      child[o] = childIndex;
      nodes.push({
        cx: node.cx + ((o & 1) ? h : -h),
        cy: node.cy + ((o & 2) ? h : -h),
        cz: node.cz + ((o & 4) ? h : -h),
        half: h,
        start: start + offsets[o],
        count: counts[o],
        child: null,
      });
      stack.push([childIndex, depth + 1]);
    }
    node.child = child;
  }

  const nodeCount = nodes.length;
  const out = {
    positions,
    order,
    count,
    bounds: b,
    root: { cx, cy, cz, half },
    nodes: {
      cx: new Float64Array(nodeCount),
      cy: new Float64Array(nodeCount),
      cz: new Float64Array(nodeCount),
      half: new Float64Array(nodeCount),
      start: new Int32Array(nodeCount),
      count: new Int32Array(nodeCount),
      child: new Int32Array(nodeCount * 8).fill(-1),
    },
  };
  for (let i = 0; i < nodeCount; i++) {
    const n = nodes[i];
    out.nodes.cx[i] = n.cx;
    out.nodes.cy[i] = n.cy;
    out.nodes.cz[i] = n.cz;
    out.nodes.half[i] = n.half;
    out.nodes.start[i] = n.start;
    out.nodes.count[i] = n.count;
    if (n.child) out.nodes.child.set(n.child, i * 8);
  }
  return out;
}

/**
 * Nearest point within `radius` of a ray. Returns { index, distance }.
 * index is -1 when nothing is within radius.
 */
export function pickRay(octree, origin, direction, radius = Infinity) {
  const { positions, order, nodes } = octree;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  let dx = direction[0], dy = direction[1], dz = direction[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;

  const limit = Number.isFinite(radius) ? radius * radius : Infinity;
  let best2 = limit;
  let bestIndex = -1;

  const stack = [0];
  const nearD = new Float64Array(8);
  const nearI = new Int32Array(8);
  const cx = nodes.cx, cy = nodes.cy, cz = nodes.cz, half = nodes.half;
  const start = nodes.start, count = nodes.count, child = nodes.child;

  while (stack.length) {
    const ni = stack.pop();
    // Lower bound: distance from ray to node centre minus the node's half-diagonal.
    const h = half[ni];
    const dCentre = Math.sqrt(pointRayDist2(cx[ni], cy[ni], cz[ni], ox, oy, oz, dx, dy, dz));
    const lb = dCentre - h * 1.7320508;
    if (lb > 0 && lb * lb > best2) continue;

    let isLeaf = true;
    for (let o = 0; o < 8; o++) { if (child[ni * 8 + o] !== -1) { isLeaf = false; break; } }
    if (isLeaf) {
      const s = start[ni], e = s + count[ni];
      for (let k = s; k < e; k++) {
        const idx = order[k];
        const px = positions[idx * 3], py = positions[idx * 3 + 1], pz = positions[idx * 3 + 2];
        const d2 = pointRayDist2(px, py, pz, ox, oy, oz, dx, dy, dz);
        if (d2 < best2) { best2 = d2; bestIndex = idx; }
      }
      continue;
    }

    // Visit the child whose centre is closest to the ray first (better pruning).
    // Fixed-size scratch buffers: no per-node allocation, insertion sort over <= 8.
    let m = 0;
    for (let o = 0; o < 8; o++) {
      const ci = child[ni * 8 + o];
      if (ci < 0) continue;
      const dh = half[ci];
      const dc = Math.sqrt(pointRayDist2(cx[ci], cy[ci], cz[ci], ox, oy, oz, dx, dy, dz));
      const lb = dc - dh * 1.7320508;
      let j = m - 1;
      while (j >= 0 && nearD[j] > lb) { nearD[j + 1] = nearD[j]; nearI[j + 1] = nearI[j]; j--; }
      nearD[j + 1] = lb;
      nearI[j + 1] = ci;
      m++;
    }
    for (let k = m - 1; k >= 0; k--) {
      if (nearD[k] > 0 && nearD[k] * nearD[k] > best2) continue;
      stack.push(nearI[k]);
    }
  }

  return { index: bestIndex, distance: bestIndex >= 0 ? Math.sqrt(best2) : Infinity };
}

/** Octree statistics used by the bench and the HUD. */
export function octreeStats(octree) {
  const { nodes } = octree;
  let leaves = 0;
  for (let i = 0; i < nodes.cx.length; i++) {
    if (nodes.child[i * 8] === -1) leaves++;
  }
  return { nodes: nodes.cx.length, leaves, points: octree.count };
}
