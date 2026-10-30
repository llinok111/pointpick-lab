// Baseline: linear scan over every point, same distance metric as src/core.mjs.
// This file is the control group for bench/bench.mjs and for the in-page "B" toggle.

function pointRayDist2(px, py, pz, ox, oy, oz, dx, dy, dz) {
  const wx = px - ox, wy = py - oy, wz = pz - oz;
  let t = wx * dx + wy * dy + wz * dz;
  if (t < 0) t = 0;
  const qx = wx - t * dx, qy = wy - t * dy, qz = wz - t * dz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * Nearest point within `radius` of a ray, by scanning all points.
 * Returns { index, distance } — identical contract to pickRay in src/core.mjs.
 */
export function pickRayBrute(positions, origin, direction, radius = Infinity) {
  const ox = origin[0], oy = origin[1], oz = origin[2];
  let dx = direction[0], dy = direction[1], dz = direction[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;

  let best2 = Number.isFinite(radius) ? radius * radius : Infinity;
  let bestIndex = -1;
  for (let idx = 0; idx < positions.length / 3; idx++) {
    const d2 = pointRayDist2(
      positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2],
      ox, oy, oz, dx, dy, dz,
    );
    if (d2 < best2) { best2 = d2; bestIndex = idx; }
  }
  return { index: bestIndex, distance: bestIndex >= 0 ? Math.sqrt(best2) : Infinity };
}
