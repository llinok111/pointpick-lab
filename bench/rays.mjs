// Deterministic ray set shared by verify and bench.
import { mulberry32 } from '../tools/gen-sample.mjs';

/** Origins on a radius-26 sphere, aimed at random cloud points with jitter. */
export function makeRays(positions, n = 400, seed = 7, radius = 26) {
  const rnd = mulberry32(seed);
  const count = positions.length / 3;
  const origins = new Float64Array(n * 3);
  const dirs = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Uniform point on a sphere.
    const u = rnd() * 2 - 1;
    const phi = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const ox = Math.cos(phi) * s * radius;
    const oy = u * radius;
    const oz = Math.sin(phi) * s * radius;
    origins[i * 3] = ox;
    origins[i * 3 + 1] = oy;
    origins[i * 3 + 2] = oz;

    const p = ((rnd() * count) | 0) * 3;
    const jx = (rnd() * 2 - 1) * 0.35;
    const jy = (rnd() * 2 - 1) * 0.35;
    const jz = (rnd() * 2 - 1) * 0.35;
    let dx = positions[p] + jx - ox;
    let dy = positions[p + 1] + jy - oy;
    let dz = positions[p + 2] + jz - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dirs[i * 3] = dx / len;
    dirs[i * 3 + 1] = dy / len;
    dirs[i * 3 + 2] = dz / len;
  }
  return { origins, dirs, count: n };
}

export function rayAt(rays, i) {
  return {
    origin: [rays.origins[i * 3], rays.origins[i * 3 + 1], rays.origins[i * 3 + 2]],
    direction: [rays.dirs[i * 3], rays.dirs[i * 3 + 1], rays.dirs[i * 3 + 2]],
  };
}
