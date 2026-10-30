import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildOctree, pickRay, octreeStats } from './src/core.mjs';
import { pickRayBrute } from './baseline/brute.mjs';

const canvas = document.getElementById('view');
const hud = {
  build: document.getElementById('build'),
  pick: document.getElementById('pick'),
  mode: document.getElementById('mode'),
  index: document.getElementById('index'),
  dist: document.getElementById('dist'),
};

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x07090f, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07090f, 0.012);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 400);
camera.position.set(22, 13, 26);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 90;

scene.add(new THREE.AmbientLight(0xffffff, 1.4));
const key = new THREE.DirectionalLight(0x9fd8ff, 1.6);
key.position.set(12, 18, 10);
scene.add(key);

const marker = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0x66f0ff, transparent: true, opacity: 0.95 }),
);
marker.visible = false;
scene.add(marker);
const halo = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0x66f0ff, transparent: true, opacity: 0.18, depthWrite: false }),
);
marker.add(halo);
halo.scale.setScalar(2.6);

let tree = null;
let positions = null;
let radius = 0.06;
let mode = 'octree';

const t0 = performance.now();
const [meta, buffer] = await Promise.all([
  fetch('./data/meta.json').then((r) => r.json()),
  fetch('./data/cloud.bin').then((r) => r.arrayBuffer()),
]);
const loadMs = performance.now() - t0;
positions = new Float32Array(buffer);

const b0 = performance.now();
tree = buildOctree(positions, { maxLeaf: 16, maxDepth: 14 });
const buildMs = performance.now() - b0;
const stats = octreeStats(tree);
hud.build.textContent = `${meta.count.toLocaleString()} pts · ${stats.nodes.toLocaleString()} nodes · build ${buildMs.toFixed(0)} ms · load ${loadMs.toFixed(0)} ms`;

// Colour by height so the clusters read as volume rather than noise.
const colors = new Float32Array(positions.length);
const lo = -10, hi = 10;
for (let i = 0; i < positions.length; i += 3) {
  const t = Math.min(1, Math.max(0, (positions[i + 1] - lo) / (hi - lo)));
  const c = new THREE.Color().setHSL(0.55 + t * 0.18, 0.75, 0.28 + t * 0.42);
  colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const points = new THREE.Points(geometry, new THREE.PointsMaterial({
  size: 0.055, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.9,
}));
scene.add(points);

const raycasterOrigin = new THREE.Vector3();
const pointer = new THREE.Vector2();
const tmp = new THREE.Vector3();
let last = { ms: 0, index: -1 };

function updateHud() {
  hud.mode.textContent = mode === 'octree' ? 'octree' : 'brute force';
  hud.mode.className = mode === 'octree' ? 'good' : 'bad';
  hud.pick.textContent = `${(last.ms * 1000).toFixed(1)} µs`;
  hud.index.textContent = last.index >= 0 ? last.index.toLocaleString() : '—';
  hud.dist.textContent = last.index >= 0 ? last.dist.toFixed(2) : '—';
}

function pick() {
  if (!tree) return;
  const ndcX = (pointer.x / innerWidth) * 2 - 1;
  const ndcY = -(pointer.y / innerHeight) * 2 + 1;
  tmp.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  const origin = [camera.position.x, camera.position.y, camera.position.z];
  const dir = [tmp.x, tmp.y, tmp.z];
  radius = 0.05 * (camera.position.length() / 26);

  const t = performance.now();
  const hit = mode === 'octree'
    ? pickRay(tree, origin, dir, radius)
    : pickRayBrute(positions, origin, dir, radius);
  last.ms = (performance.now() - t) / 1000;

  if (hit.index >= 0) {
    const i = hit.index * 3;
    marker.position.set(positions[i], positions[i + 1], positions[i + 2]);
    marker.scale.setScalar(Math.max(0.05, radius * 0.45));
    marker.visible = true;
    last.index = hit.index;
    last.dist = hit.distance;
  } else {
    marker.visible = false;
    last.index = -1;
  }
  updateHud();
}

canvas.addEventListener('pointermove', (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pick();
});
canvas.addEventListener('pointerleave', () => {
  marker.visible = false;
  last.index = -1;
  updateHud();
});
addEventListener('keydown', (e) => {
  if (e.key === 'b' || e.key === 'B') {
    mode = mode === 'octree' ? 'brute' : 'octree';
    pick();
  }
  if (e.key === 'r' || e.key === 'R') {
    camera.position.set(22, 13, 26);
    controls.target.set(0, 0, 0);
    controls.update();
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

updateHud();
renderer.setAnimationLoop(() => {
  controls.update();
  if (marker.visible) halo.scale.setScalar(2.2 + Math.sin(performance.now() * 0.004) * 0.5);
  renderer.render(scene, camera);
});
