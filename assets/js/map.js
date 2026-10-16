// The Verse: 3D map of Sector 005.
// Map view: hex grid with star systems above and below the plane. Click a star to fly in
// to its colony planet, with the star far away in the background and the info panel open.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const app = document.getElementById("map-app");
const BASE = app.dataset.base || "/";
const RAW = JSON.parse(document.getElementById("map-data").textContent);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- data
const [header, ...rows] = RAW.systems;
const systems = rows
  .filter((r) => r.length >= header.length - 2 && r[0])
  .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
const byHex = new Map(systems.map((s) => [s.hex, s]));
const factions = RAW.factions || {};
const founders = RAW.founders || {};
const grades = RAW.grades || {};

const SQ3 = Math.sqrt(3);
const COLS = 23, ROWS = 20;
const NEBULA_HEXES = ["H4", "H5", "H6", "I4", "I5", "I6", "J4", "J5", "J6"];
const OFFSET = { x: ((COLS - 1) * 1.5) / 2, z: ((ROWS - 1) * SQ3 + SQ3 / 2) / 2 };

function parseHex(code) {
  return { c: code.charCodeAt(0) - 65, r: parseInt(code.slice(1), 10) };
}
function hexCode(c, r) {
  return String.fromCharCode(65 + c) + r;
}
function hexXZ(code) {
  const { c, r } = parseHex(code);
  return { x: c * 1.5 - OFFSET.x, z: (r - 1) * SQ3 + (c % 2 ? SQ3 / 2 : 0) - OFFSET.z };
}
// Adjacency as in the Hex Register: odd-index columns sit half a hex lower.
function neighbours(code) {
  const { c, r } = parseHex(code);
  const d = c % 2 === 0
    ? [[0, -1], [1, -1], [1, 0], [0, 1], [-1, 0], [-1, -1]]
    : [[0, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  return d.map(([dc, dr]) => [c + dc, r + dr])
    .filter(([cc, rr]) => cc >= 0 && cc < COLS && rr >= 1 && rr <= ROWS)
    .map(([cc, rr]) => hexCode(cc, rr));
}
// Stable pseudo-random numbers from a string, so every visit looks the same.
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
function url(path) { return path ? BASE.replace(/\/$/, "") + path : ""; }
function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

const STAR = {
  B: { colour: 0x9fb8ff, size: 2.6, label: "B" },
  F: { colour: 0xf4f1ff, size: 1.55, label: "F" },
  G: { colour: 0xfff0d6, size: 1.35, label: "G" },
  K: { colour: 0xffcf98, size: 1.15, label: "K" },
  M: { colour: 0xffa86a, size: 0.9, label: "M" },
};

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById("map-canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const labelRenderer = new CSS2DRenderer({ element: document.getElementById("map-labels") });

const mapScene = new THREE.Scene();
const planetScene = new THREE.Scene();
mapScene.background = new THREE.Color(0x02030a);
planetScene.background = new THREE.Color(0x010207);

const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 5000);
const HOME = { pos: new THREE.Vector3(0, 30, 31), target: new THREE.Vector3(0, 0, 1) };
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = false;
controls.minDistance = 2.5;
controls.maxDistance = 75;
controls.maxPolarAngle = 1.38;
controls.target.copy(HOME.target);

const pcamera = new THREE.PerspectiveCamera(40, 1, 0.01, 20000);
const pcontrols = new OrbitControls(pcamera, canvas);
pcontrols.enableDamping = true;
pcontrols.enablePan = false;
pcontrols.minDistance = 1.6;
pcontrols.maxDistance = 14;
pcontrols.enabled = false;

function resize() {
  const w = app.clientWidth, h = app.clientHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = pcamera.aspect = w / h;
  camera.updateProjectionMatrix();
  pcamera.updateProjectionMatrix();
}
window.addEventListener("resize", () => { resize(); if (mode === "planet") framePlanet(); });

// ---------------------------------------------------------------- textures
function radialTexture(stops) {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([o, col]) => grd.addColorStop(o, col));
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const GLOW = radialTexture([[0, "rgba(255,255,255,1)"], [0.12, "rgba(255,255,255,0.85)"], [0.32, "rgba(255,255,255,0.22)"], [1, "rgba(255,255,255,0)"]]);
const CORE = radialTexture([[0, "rgba(255,255,255,1)"], [0.35, "rgba(255,255,255,0.9)"], [1, "rgba(255,255,255,0)"]]);

function cloudTexture(seed) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d"), rnd = seeded(seed);
  for (let i = 0; i < 26; i++) {
    const x = 60 + rnd() * 136, y = 60 + rnd() * 136, r = 30 + rnd() * 60;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${0.10 + rnd() * 0.12})`); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- background starfield
function starfield(count, rMin, rMax, seed) {
  const rnd = seeded(seed), pos = [], col = [], c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Concentrate a third of the stars in a band, like the galactic plane.
    let u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
    if (i % 3 === 0) u = (rnd() - 0.5) * 0.25;
    const r = rMin + rnd() * (rMax - rMin), s = Math.sqrt(1 - u * u);
    const v = new THREE.Vector3(s * Math.cos(th), u, s * Math.sin(th)).applyAxisAngle(new THREE.Vector3(1, 0, 0.3).normalize(), 0.5);
    pos.push(v.x * r, v.y * r, v.z * r);
    const t = rnd();
    c.setHSL(t < 0.15 ? 0.6 : t < 0.3 ? 0.08 : 0.12, t < 0.3 ? 0.5 : 0.1, 0.65 + rnd() * 0.35);
    col.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
}
mapScene.add(starfield(9000, 600, 1400, "sky"));
planetScene.add(starfield(9000, 4000, 9000, "sky2"));

// Faint distant nebulosity for depth.
function distantClouds(scene, seed, radius, n) {
  const rnd = seeded(seed);
  for (let i = 0; i < n; i++) {
    const m = new THREE.SpriteMaterial({ map: cloudTexture(seed + i), color: new THREE.Color().setHSL(0.55 + rnd() * 0.25, 0.6, 0.5), transparent: true, opacity: 0.12 + rnd() * 0.1, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Sprite(m);
    const th = rnd() * Math.PI * 2, ph = (rnd() - 0.5) * 1.2;
    s.position.set(Math.cos(th) * Math.cos(ph) * radius, Math.sin(ph) * radius, Math.sin(th) * Math.cos(ph) * radius);
    s.scale.setScalar(radius * (0.5 + rnd() * 0.6));
    scene.add(s);
  }
}
distantClouds(mapScene, "far", 900, 7);

// ---------------------------------------------------------------- hex grid
const PX = 112; // canvas pixels per map unit
const minX = -1 - OFFSET.x, maxX = (COLS - 1) * 1.5 + 1 - OFFSET.x;
const minZ = -SQ3 / 2 - OFFSET.z, maxZ = (ROWS - 1) * SQ3 + SQ3 - OFFSET.z;
const W = maxX - minX, H = maxZ - minZ;
function buildGrid() {
  const c = document.createElement("canvas");
  c.width = Math.ceil(W * PX); c.height = Math.ceil(H * PX);
  const g = c.getContext("2d");
  const toPx = (x, z) => [(x - minX) * PX, (z - minZ) * PX];
  const corners = (x, z, r) => Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k; return toPx(x + r * Math.cos(a), z + r * Math.sin(a));
  });
  const path = (pts) => { g.beginPath(); pts.forEach(([px, pz], i) => (i ? g.lineTo(px, pz) : g.moveTo(px, pz))); g.closePath(); };
  for (let col = 0; col < COLS; col++) for (let row = 1; row <= ROWS; row++) {
    const code = hexCode(col, row), { x, z } = hexXZ(code), s = byHex.get(code);
    const f = s && factions[s.control];
    if (f && f.colour) {
      path(corners(x, z, 0.96)); g.fillStyle = f.colour + "4d"; g.fill();
      g.lineWidth = 5; g.strokeStyle = f.colour + "e6"; g.stroke();
    }
    if (NEBULA_HEXES.includes(code)) { path(corners(x, z, 1)); g.fillStyle = "rgba(120,90,255,0.10)"; g.fill(); }
    path(corners(x, z, 1)); g.lineWidth = 2; g.strokeStyle = "rgba(130,165,230,0.30)"; g.stroke();
    const [px, pz] = toPx(x, z + 0.62);
    g.font = "600 19px system-ui, sans-serif"; g.textAlign = "center"; g.fillStyle = "rgba(170,195,240,0.42)";
    g.fillText(code, px, pz);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(minX + W / 2, 0, minZ + H / 2);
  mapScene.add(plane);
}
buildGrid();

// ---------------------------------------------------------------- star systems
const pickables = [];
const labelObjects = [];
const hitGeo = new THREE.SphereGeometry(0.6, 10, 8);
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

systems.forEach((s) => {
  const { x, z } = hexXZ(s.hex);
  const rnd = seeded("h" + s.hex);
  let y = (rnd() * 2 - 1) * 2.2; if (Math.abs(y) < 0.45) y = y < 0 ? -0.45 : 0.45;
  s.pos = new THREE.Vector3(x, y, z);
  const st = STAR[s.star_type] || STAR.G;
  const unrecorded = !s.system;
  const group = new THREE.Group(); group.position.copy(s.pos);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: st.colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: unrecorded ? 0.55 : 0.95 }));
  glow.scale.setScalar(st.size * (unrecorded ? 0.7 : 1));
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: CORE, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.scale.setScalar(st.size * 0.32);
  group.add(glow, core);
  s.glow = glow; s.baseScale = glow.scale.x; s.twinkle = rnd() * 10;

  const hit = new THREE.Mesh(hitGeo, hitMat); hit.userData.system = s; group.add(hit); pickables.push(hit);
  mapScene.add(group);

  // Stalk to the hex, so you can read which hex the star belongs to.
  const f = factions[s.control];
  const stalkColour = f && f.colour ? new THREE.Color(f.colour) : new THREE.Color(0x8aa6d8);
  const stalk = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, z), s.pos.clone()]),
    new THREE.LineBasicMaterial({ color: stalkColour, transparent: true, opacity: 0.45 }));
  mapScene.add(stalk);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 24), new THREE.MeshBasicMaterial({ color: stalkColour, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.01, z); mapScene.add(ring);

  const el = document.createElement("div");
  el.className = "map-label" + (unrecorded ? " unrecorded" : "");
  el.textContent = s.system || s.hex;
  el.addEventListener("click", () => select(s));
  const lab = new CSS2DObject(el); lab.position.set(0, st.size * 0.42 + 0.15, 0); group.add(lab);
  s.label = el; labelObjects.push({ s, el });
});

// Bramble Patch Nebula.
(function nebula() {
  const rnd = seeded("bramble"), centres = NEBULA_HEXES.map(hexXZ);
  for (let i = 0; i < 46; i++) {
    const c = centres[Math.floor(rnd() * centres.length)];
    const hue = [0.72, 0.64, 0.78, 0.6][i % 4];
    const m = new THREE.SpriteMaterial({ map: cloudTexture("neb" + i), color: new THREE.Color().setHSL(hue, 0.85, 0.32), transparent: true, opacity: 0.05 + rnd() * 0.07, blending: THREE.AdditiveBlending, depthWrite: false, rotation: rnd() * 6.3 });
    const sp = new THREE.Sprite(m);
    sp.position.set(c.x + (rnd() - 0.5) * 1.9, (rnd() - 0.5) * 4.2, c.z + (rnd() - 0.5) * 1.9);
    sp.scale.setScalar(2.2 + rnd() * 3.6); mapScene.add(sp);
  }
  const { x, z } = hexXZ("I5");
  const el = document.createElement("div"); el.className = "map-label feature"; el.textContent = "Bramble Patch Nebula";
  const lab = new CSS2DObject(el); lab.position.set(x, 3.1, z); mapScene.add(lab);
  labelObjects.push({ s: { pos: new THREE.Vector3(x, 3.1, z), feature: true }, el });
})();

// Bionid hazard at Andor.
let hazard;
(function bionid() {
  const s = byHex.get("U19"); if (!s) return;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(20,12,0,0.75)"; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.lineWidth = 6; g.strokeStyle = "#ffb000"; g.stroke();
  g.fillStyle = "#ffb000"; g.font = "bold 82px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("☣", 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  hazard = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  hazard.scale.setScalar(0.9); hazard.position.copy(s.pos).add(new THREE.Vector3(0, 1.25, 0)); mapScene.add(hazard);
})();

// ---------------------------------------------------------------- labels and hover
let labelsOn = true;
const tmp = new THREE.Vector3();
function updateLabels(cam) {
  labelObjects.forEach(({ s, el }) => {
    const d = cam.position.distanceTo(s.pos || tmp);
    let o = s.feature ? 1 - (d - 30) / 40 : 1 - (d - 16) / 30;
    if (s === hovered || s === selected) o = 1;
    o = labelsOn || s === hovered ? Math.max(0, Math.min(1, o)) : 0;
    el.style.opacity = o.toFixed(2);
    el.style.pointerEvents = o > 0.3 ? "auto" : "none";
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null, selected = null, mode = "map", busy = false;

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  return hit ? hit.object.userData.system : null;
}
canvas.addEventListener("pointermove", (ev) => {
  if (mode !== "map" || busy) return;
  const s = pick(ev);
  if (s !== hovered) {
    if (hovered) hovered.label.classList.remove("hover");
    hovered = s; if (s) s.label.classList.add("hover");
    canvas.style.cursor = s ? "pointer" : "";
  }
});
let downAt = null;
canvas.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener("pointerup", (ev) => {
  if (!downAt || mode !== "map" || busy) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 6) return;
  const s = pick(ev); if (s) select(s);
});

// ---------------------------------------------------------------- camera flights
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function tween(ms, fn) {
  return new Promise((done) => {
    if (reduceMotion) { fn(1); return done(); }
    const t0 = performance.now();
    const step = (now) => { const t = Math.min(1, (now - t0) / ms); fn(ease(t)); t < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  });
}
function flyMap(toPos, toTarget, ms = 1300) {
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  return tween(ms, (k) => { camera.position.lerpVectors(p0, toPos, k); controls.target.lerpVectors(t0, toTarget, k); });
}
const fade = document.getElementById("map-fade");
function fadeTo(opacity, ms = 450) {
  return new Promise((done) => {
    if (reduceMotion) { fade.style.opacity = opacity; return done(); }
    fade.style.transition = `opacity ${ms}ms ease`; fade.style.opacity = opacity;
    setTimeout(done, ms);
  });
}

// ---------------------------------------------------------------- planet close-up
const SUN_DIR = new THREE.Vector3(-1, 0.22, -0.55).normalize();
// Camera position around the planet: angle 0 puts the star directly behind the planet.
function orbitPoint(angle, dist, lift) {
  const back = SUN_DIR.clone().negate();
  return back.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).multiplyScalar(dist).add(new THREE.Vector3(0, lift, 0));
}
// Keep the planet in the clear part of the screen, beside or above the info panel.
function framePlanet() {
  const w = app.clientWidth, h = app.clientHeight, p = panel.hidden ? null : panel.getBoundingClientRect();
  pcamera.clearViewOffset();
  if (p && w > 700) pcamera.setViewOffset(w, h, p.width / 2, 0, w, h);
  else if (p) pcamera.setViewOffset(w, h, 0, p.height / 2, w, h);
  pcamera.updateProjectionMatrix();
}
const sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
planetScene.add(sunLight, new THREE.AmbientLight(0x2a3a55, 0.5));
let planetGroup = null, planetSpin = null;

// 3D value noise, so the texture wraps round the sphere with no seam.
function makeNoise(seed) {
  const rnd = seeded(seed), P = new Uint8Array(512), perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
  const val = new Float32Array(256).map(() => rnd());
  const lerp = (a, b, t) => a + (b - a) * t, sm = (t) => t * t * (3 - 2 * t);
  const h = (x, y, z) => val[P[P[P[x & 255] + (y & 255)] + (z & 255)]];
  const noise = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    return lerp(lerp(lerp(h(xi, yi, zi), h(xi + 1, yi, zi), xf), lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      lerp(lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf), zf);
  };
  return (x, y, z, oct = 5) => { let a = 0.5, f = 1, s = 0, n = 0; for (let o = 0; o < oct; o++) { s += a * noise(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2.03; } return s / n; };
}

// Colour ramps by planet type: [height, colour] pairs, sea level, cloud cover, atmosphere colour.
const TYPES = {
  temperate: { sea: 0.52, ramp: [[0, "#0b2350"], [0.5, "#1f5aa0"], [0.52, "#c8b98a"], [0.56, "#3f7a3a"], [0.68, "#5f7240"], [0.78, "#8d846c"], [0.86, "#f0f0f0"]], clouds: 0.5, atmo: "#7fb2ff", ice: 0.82 },
  ocean: { sea: 0.7, ramp: [[0, "#06204a"], [0.68, "#1d64b0"], [0.7, "#d6c99a"], [0.74, "#4c8a45"], [0.85, "#8a8a70"]], clouds: 0.55, atmo: "#86bcff", ice: 0.86 },
  archipelago: { sea: 0.62, ramp: [[0, "#06275a"], [0.58, "#1876b8"], [0.62, "#36a4c4"], [0.63, "#e0d5a8"], [0.66, "#3f8f45"], [0.8, "#6d7a50"]], clouds: 0.45, atmo: "#8cc6ff", ice: 0.9 },
  "storm-ocean": { sea: 0.72, ramp: [[0, "#071a3d"], [0.7, "#1a4f8a"], [0.72, "#4d7d48"], [0.85, "#6a7556"]], clouds: 0.8, atmo: "#93b8ff", ice: 0.9, swirl: true },
  "ocean-rocky": { sea: 0.56, ramp: [[0, "#081d3e"], [0.54, "#1a4f86"], [0.56, "#6b6458"], [0.64, "#7b7064"], [0.76, "#958a7d"], [0.9, "#b8b0a5"]], clouds: 0.35, atmo: "#9db6e6", ice: 0.9 },
  arid: { sea: 0.28, ramp: [[0, "#1d3e5e"], [0.27, "#2f5f82"], [0.29, "#b89a64"], [0.45, "#c6a46a"], [0.65, "#a77d4b"], [0.85, "#e3d2b0"]], clouds: 0.18, atmo: "#e8c79a", ice: 0.94 },
  desert: { sea: -1, ramp: [[0, "#7a3b19"], [0.35, "#b5622a"], [0.6, "#d58c45"], [0.85, "#f0c27e"]], clouds: 0.05, atmo: "#ffb070", ice: 2 },
  savannah: { sea: 0.44, ramp: [[0, "#0d2e57"], [0.43, "#22609a"], [0.45, "#c9b47a"], [0.5, "#b3a058"], [0.62, "#7f8a3e"], [0.78, "#8f7a52"]], clouds: 0.3, atmo: "#a9c7ff", ice: 0.9 },
  jungle: { sea: 0.44, ramp: [[0, "#0a2a4e"], [0.43, "#1f5d8f"], [0.45, "#2b5d27"], [0.6, "#1f4d1f"], [0.75, "#3d5d2a"], [0.88, "#6e6e55"]], clouds: 0.7, atmo: "#9fe0c0", ice: 0.95 },
  forest: { sea: 0.5, ramp: [[0, "#0b2a4d"], [0.49, "#1f5a90"], [0.5, "#5f6f3d"], [0.55, "#2a5230"], [0.7, "#36593a"], [0.82, "#7d7a68"], [0.9, "#eeeeee"]], clouds: 0.5, atmo: "#93c4ff", ice: 0.84 },
  alpine: { sea: 0.4, ramp: [[0, "#0d2c54"], [0.39, "#265f96"], [0.4, "#5c7346"], [0.5, "#6c7353"], [0.6, "#8a8576"], [0.68, "#d8dde6"], [0.8, "#ffffff"]], clouds: 0.45, atmo: "#a6c8ff", ice: 0.78 },
  ice: { sea: 0.45, ramp: [[0, "#4f7ea6"], [0.45, "#9cc6e0"], [0.46, "#dfeaf3"], [0.7, "#f4f8fc"], [0.85, "#c9d7e6"]], clouds: 0.35, atmo: "#cfe6ff", ice: 0 },
  tundra: { sea: 0.4, ramp: [[0, "#1d3550"], [0.39, "#3a5a76"], [0.4, "#77786b"], [0.55, "#8d8b7f"], [0.7, "#b5b6b1"], [0.8, "#e9eef2"]], clouds: 0.6, atmo: "#c3d2e6", ice: 0.6, mist: true },
  volcanic: { sea: -1, ramp: [[0, "#120c0b"], [0.45, "#261b18"], [0.65, "#3b2c26"], [0.85, "#5a4a42"]], clouds: 0.25, atmo: "#ff8a5a", ice: 2, lava: true },
  toxic: { sea: 0.35, ramp: [[0, "#2c2a10"], [0.34, "#4a4a16"], [0.36, "#6b5a2a"], [0.6, "#7d6a3a"], [0.85, "#a08f5a"]], clouds: 0.95, cloudColour: "#d8d06a", atmo: "#d6e070", ice: 2 },
  barren: { sea: -1, ramp: [[0, "#3b2f2a"], [0.4, "#6a5146"], [0.6, "#8a6c5c"], [0.8, "#a8907e"]], clouds: 0.04, atmo: "#c9a68e", ice: 2, craters: true },
  scorched: { sea: -1, ramp: [[0, "#1a0f0a"], [0.4, "#3a2216"], [0.6, "#5e3a22"], [0.85, "#8a5a36"]], clouds: 0.1, atmo: "#ff9c66", ice: 2 },
  industrial: { sea: 0.5, ramp: [[0, "#0c2448"], [0.49, "#1f5590"], [0.5, "#8f8a72"], [0.56, "#566a44"], [0.7, "#6e6c5c"], [0.85, "#e8e8e8"]], clouds: 0.4, atmo: "#9cbfff", ice: 0.86, lights: true },
  bionid: { sea: 0.42, ramp: [[0, "#1a0718"], [0.41, "#3a0e30"], [0.43, "#6b1a3a"], [0.6, "#8a2a4a"], [0.75, "#b04a5a"], [0.9, "#d0907a"]], clouds: 0.3, cloudColour: "#c08aa8", atmo: "#d070b0", ice: 2, veins: true },
};
function rampColour(ramp, v) {
  let i = 0; while (i < ramp.length - 1 && v > ramp[i + 1][0]) i++;
  const [a0, c0] = ramp[i], [a1, c1] = ramp[Math.min(i + 1, ramp.length - 1)];
  const t = a1 === a0 ? 0 : Math.min(1, Math.max(0, (v - a0) / (a1 - a0)));
  return new THREE.Color(c0).lerp(new THREE.Color(c1), t);
}

function planetTextures(s) {
  const type = TYPES[s.planet_type] || TYPES.temperate;
  const Wt = 768, Ht = 384;
  const n = makeNoise("terrain" + s.system), nc = makeNoise("clouds" + s.system);
  const cm = document.createElement("canvas"); cm.width = Wt; cm.height = Ht;
  const cc = document.createElement("canvas"); cc.width = Wt; cc.height = Ht;
  const ce = document.createElement("canvas"); ce.width = Wt; ce.height = Ht;
  const gm = cm.getContext("2d"), gc = cc.getContext("2d"), ge = ce.getContext("2d");
  const im = gm.createImageData(Wt, Ht), ic = gc.createImageData(Wt, Ht), ie = ge.createImageData(Wt, Ht);
  const pop = parseFloat(s.population_m) || 0;
  const lights = type.lights || pop > 25;
  const cloudCol = new THREE.Color(type.cloudColour || "#ffffff");
  const sc = 1.6;
  for (let j = 0; j < Ht; j++) {
    const lat = (j / (Ht - 1) - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < Wt; i++) {
      const lon = (i / Wt) * Math.PI * 2, x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      let h = n(x * sc + 10, y * sc + 10, z * sc + 10, 6);
      h = Math.min(1, Math.max(0, (h - 0.5) * 1.9 + 0.5));
      if (type.craters) { const k = n(x * 7, y * 7, z * 7, 2); if (k > 0.66) h -= (k - 0.66) * 1.2; }
      let col = rampColour(type.ramp, h);
      // Polar caps.
      if (Math.abs(sl) > type.ice - (h - 0.5) * 0.15) col.lerp(new THREE.Color("#f4f8ff"), 0.85);
      const o = (j * Wt + i) * 4;
      im.data[o] = col.r * 255; im.data[o + 1] = col.g * 255; im.data[o + 2] = col.b * 255; im.data[o + 3] = 255;
      // Night-side and lava glow.
      let er = 0, eg = 0, eb = 0;
      if (type.lava) { const k = n(x * 5 + 3, y * 5, z * 5, 3); const crack = 1 - Math.abs(k - 0.5) * 18; if (crack > 0) { er = 255 * crack; eg = 90 * crack; } }
      if (type.veins) { const k = n(x * 4, y * 4 + 7, z * 4, 3); const v = 1 - Math.abs(k - 0.5) * 22; if (v > 0) { er = 150 * v; eb = 120 * v; } }
      if (lights && h > type.sea + 0.01 && h < 0.8) { const k = nc(x * 22, y * 22, z * 22, 2); if (k > 0.62) { const b = (k - 0.62) * 6; er = 255 * b; eg = 200 * b; eb = 120 * b; } }
      ie.data[o] = er; ie.data[o + 1] = eg; ie.data[o + 2] = eb; ie.data[o + 3] = 255;
      // Clouds.
      const cn = nc(x * 4.2 + (type.swirl ? Math.sin(y * 7) * 0.8 : 0), y * 5.2, z * 4.2, 5);
      const th = 0.64 - type.clouds * 0.2;
      let cv = Math.min(1, Math.max(0, (cn - th) / 0.12));
      cv = cv * cv * (3 - 2 * cv) * 0.92;
      ic.data[o] = cloudCol.r * 255; ic.data[o + 1] = cloudCol.g * 255; ic.data[o + 2] = cloudCol.b * 255; ic.data[o + 3] = Math.min(255, cv * 255);
    }
  }
  gm.putImageData(im, 0, 0); gc.putImageData(ic, 0, 0); ge.putImageData(ie, 0, 0);
  const tx = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  return { map: tx(cm), clouds: tx(cc), emissive: tx(ce), type };
}

function atmosphere(colour, radius) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), new THREE.ShaderMaterial({
    uniforms: { c: { value: new THREE.Color(colour) } },
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
    fragmentShader: "uniform vec3 c; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.6); gl_FragColor = vec4(c, f*0.9); }",
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
  }));
}

function buildPlanet(s) {
  if (planetGroup) { planetScene.remove(planetGroup); planetGroup.traverse((o) => { o.geometry && o.geometry.dispose(); }); }
  planetGroup = new THREE.Group();
  const rnd = seeded("p" + s.system);
  const tex = planetTextures(s);
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), new THREE.MeshStandardMaterial({
    map: tex.map, emissiveMap: tex.emissive, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1.1, roughness: 0.85, metalness: 0,
  }));
  planet.rotation.z = 0.35 * (rnd() - 0.5);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 72), new THREE.MeshStandardMaterial({ map: tex.clouds, transparent: true, depthWrite: false, roughness: 1 }));
  const atmo = atmosphere(tex.type.atmo, 1.09);
  planetGroup.add(planet, clouds, atmo);
  if (tex.type.mist) { const mist = atmosphere("#dfe7f0", 1.03); mist.material.uniforms.c.value.multiplyScalar(0.6); planetGroup.add(mist); }

  // Moons: Moon Weaver has many; others have up to two.
  const moons = s.system === "Moon Weaver" ? 7 : Math.floor(rnd() * 3);
  for (let i = 0; i < moons; i++) {
    const r = 0.06 + rnd() * 0.12, d = 1.8 + i * 0.55 + rnd() * 0.4, a = rnd() * Math.PI * 2;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.08, 0.1, 0.45 + rnd() * 0.25), roughness: 1 }));
    m.position.set(Math.cos(a) * d, (rnd() - 0.5) * 0.4, Math.sin(a) * d); planetGroup.add(m);
  }

  // The parent star: far away, so it reads as a bright point with a little glow.
  const st = STAR[s.star_type] || STAR.G;
  const sunDir = SUN_DIR;
  sunLight.position.copy(sunDir.clone().multiplyScalar(50));
  sunLight.color.set(st.colour);
  const sun = new THREE.Group(); sun.position.copy(sunDir.clone().multiplyScalar(3000));
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: st.colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sunGlow.scale.setScalar(st.size * 210);
  const sunCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: CORE, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sunCore.scale.setScalar(st.size * 60);
  sun.add(sunGlow, sunCore); planetGroup.add(sun);

  // Skaro sits inside the Bramble Patch Nebula.
  if (s.system === "Skaro" || NEBULA_HEXES.includes(s.hex)) {
    const r2 = seeded("skaro-neb");
    for (let i = 0; i < 40; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTexture("sk" + i), color: new THREE.Color().setHSL([0.72, 0.62, 0.8][i % 3], 0.75, 0.5), transparent: true, opacity: 0.18 + r2() * 0.2, blending: THREE.AdditiveBlending, depthWrite: false }));
      const th = r2() * Math.PI * 2, ph = (r2() - 0.5) * 2;
      const d = 30 + r2() * 120;
      sp.position.set(Math.cos(th) * Math.cos(ph) * d, Math.sin(ph) * d, Math.sin(th) * Math.cos(ph) * d);
      sp.scale.setScalar(d * (0.6 + r2()));
      planetGroup.add(sp);
    }
  }
  planetScene.add(planetGroup);
  planetSpin = { planet, clouds };
}

// ---------------------------------------------------------------- info panel
const panel = document.getElementById("map-panel");
const panelBody = document.getElementById("map-panel-body");
let stories = null;
async function loadStories() {
  if (stories) return stories;
  try { const r = await fetch(app.dataset.stories); stories = await r.json(); } catch (e) { stories = []; }
  return stories;
}
function formatPop(m) {
  const v = parseFloat(m);
  if (!isFinite(v)) return "Not recorded";
  if (v === 0) return "None";
  if (v >= 1000) return (v / 1000).toLocaleString("en-GB", { maximumFractionDigits: 2 }) + " billion";
  if (v >= 1) return v.toLocaleString("en-GB", { maximumFractionDigits: 1 }) + " million";
  return Math.round(v * 1e6).toLocaleString("en-GB");
}
function row(label, value) { return `<dt>${label}</dt><dd>${value}</dd>`; }
function factionHTML(code) {
  const f = factions[code];
  if (!code) return "Not recorded";
  if (!f) return esc(code);
  const sw = f.colour ? `<span class="swatch" style="background:${f.colour}"></span>` : "";
  const name = esc(f.name) + (code !== "IND" && code !== "UNITY 5" ? ` (${esc(code)})` : "");
  return f.url ? `${sw}<a href="${url(f.url)}">${name}</a>` : sw + name;
}
function mentionPattern(s) {
  try {
    if (s.gnn_terms) return new RegExp(s.gnn_terms);
    return new RegExp("(?<![\\w-])" + s.system.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])");
  } catch (e) { return null; }
}
async function renderPanel(s) {
  panel.hidden = false;
  if (!s.system) {
    panelBody.innerHTML = `<p class="kicker">Hex ${esc(s.hex)}</p><h2>Unnamed star</h2><p>A star marker on the Turn 9 map with no record.</p>`;
    return;
  }
  const g = grades[s.grade];
  const f = founders[s.founder];
  const adj = neighbours(s.hex).map((h) => byHex.get(h)).filter((x) => x && x.system);
  panelBody.innerHTML = `
    <p class="kicker">Hex ${esc(s.hex)}</p>
    <h2>${esc(s.system)}</h2>
    <dl class="map-facts">
      ${row("Colony world", esc(s.system))}
      ${row("Controlled by", factionHTML(s.control))}
      ${row("Population", formatPop(s.population_m))}
      ${row("Colony status", s.grade ? (g ? `${esc(g)} (${esc(s.grade)})` : esc(s.grade)) : "Not recorded")}
      ${row("Support Value", s.sv !== "" ? esc(s.sv) : "Not recorded")}
      ${row("Planets", s.planets !== "" ? esc(s.planets) : "Not recorded")}
      ${row("Asteroid belts", s.belts !== "" ? esc(s.belts) : "Not recorded")}
      ${row("M25 limit", s.m25_au !== "" ? esc(parseFloat(s.m25_au)) + " AU" : "Not recorded")}
      ${row("Colonised by", s.founder ? (f ? `${esc(f)} (${esc(s.founder)})` : esc(s.founder)) : "Not recorded")}
    </dl>
    <h3>In the GNN</h3><div id="map-gnn"><p class="muted">Loading…</p></div>
    <h3>Adjacent systems</h3>
    ${adj.length ? `<ul class="map-adjacent">${adj.map((a) => `<li><button type="button" data-hex="${a.hex}"><span class="swatch" style="background:${(factions[a.control] && factions[a.control].colour) || "transparent"}"></span>${esc(a.system)}</button></li>`).join("")}</ul>` : "<p class=\"muted\">No neighbouring systems.</p>"}`;
  panelBody.querySelectorAll(".map-adjacent button").forEach((b) => b.addEventListener("click", () => select(byHex.get(b.dataset.hex))));
  const list = await loadStories();
  if (selected !== s) return;
  const re = mentionPattern(s);
  const hits = re ? list.filter((x) => re.test(x.text)) : [];
  const box = document.getElementById("map-gnn");
  if (!hits.length) { box.innerHTML = "<p class=\"muted\">No mentions yet.</p>"; return; }
  const shown = hits.slice(0, 8);
  box.innerHTML = `<ul class="map-gnn">${shown.map((h) => `<li><a href="${esc(h.url)}"><span class="turn">Turn ${h.turn}</span> ${esc(h.title)}</a></li>`).join("")}</ul>` +
    (hits.length > shown.length ? `<p class="muted">and ${hits.length - shown.length} more.</p>` : "");
}

// ---------------------------------------------------------------- selecting a system
const station = document.getElementById("station-view");
let mapCameraBefore = null;

async function select(s) {
  if (!s || busy) return;
  busy = true;
  if (selected && selected.label) selected.label.classList.remove("selected");
  selected = s; s.label && s.label.classList.add("selected");
  history.replaceState(null, "", "#" + s.hex);

  const fromCloseup = mode !== "map";
  if (fromCloseup) { await fadeTo(1, 350); leavePlanetScene(); }
  else mapCameraBefore = { pos: camera.position.clone(), target: controls.target.clone() };

  // Fly in to the star, keeping roughly the current viewing angle.
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.35) { dir.y = 0.35; dir.normalize(); }
  await flyMap(s.pos.clone().add(dir.multiplyScalar(3.2)), s.pos.clone(), fromCloseup ? 10 : 1300);
  renderPanel(s);

  if (!s.system) { await fadeTo(0, 300); busy = false; return; }
  if (fromCloseup) fade.style.opacity = 1;
  await fadeTo(1, 420);
  if (s.planet_type === "station") {
    mode = "station"; station.hidden = false; station.classList.remove("zoom"); void station.offsetWidth; station.classList.add("zoom");
    await fadeTo(0, 600);
  } else {
    buildPlanet(s);
    mode = "planet";
    controls.enabled = false;
    pcontrols.target.set(0, 0, 0);
    framePlanet();
    pcamera.position.copy(orbitPoint(0.3, 11, 0.6)); pcamera.lookAt(0, 0, 0);
    await fadeTo(0, 500);
    await tween(3600, (k) => { pcamera.position.copy(orbitPoint(0.3 + k * 1.75, 12 - k * 6.3, 0.6 - k * 0.2)); pcamera.lookAt(0, 0, 0); });
    pcontrols.enabled = true;
  }
  busy = false;
}

function leavePlanetScene() {
  station.hidden = true;
  pcontrols.enabled = false; controls.enabled = true;
  mode = "map";
}

async function backToMap() {
  if (busy) return;
  busy = true;
  if (mode !== "map") { await fadeTo(1, 380); leavePlanetScene(); await fadeTo(0, 380); }
  panel.hidden = true;
  if (selected && selected.label) selected.label.classList.remove("selected");
  selected = null; history.replaceState(null, "", location.pathname);
  if (mapCameraBefore) await flyMap(mapCameraBefore.pos, mapCameraBefore.target, 1100);
  busy = false;
}
document.getElementById("map-back").addEventListener("click", backToMap);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") backToMap(); });

// ---------------------------------------------------------------- toolbar and key
const list = document.getElementById("map-system-list");
systems.filter((s) => s.system).sort((a, b) => a.system.localeCompare(b.system)).forEach((s) => {
  const o = document.createElement("option"); o.value = s.system; list.appendChild(o);
});
const search = document.getElementById("map-search");
search.addEventListener("change", () => {
  const q = search.value.trim().toLowerCase();
  const s = systems.find((x) => x.system.toLowerCase() === q) || systems.find((x) => x.hex.toLowerCase() === q);
  if (s) { search.blur(); select(s); }
});
const labelsBtn = document.getElementById("map-labels-toggle");
labelsBtn.addEventListener("click", () => { labelsOn = !labelsOn; labelsBtn.setAttribute("aria-pressed", String(labelsOn)); });
document.getElementById("map-reset").addEventListener("click", async () => {
  if (mode !== "map" || selected) { await backToMap(); }
  if (!busy) { busy = true; await flyMap(HOME.pos, HOME.target, 1200); busy = false; }
});
const legend = document.getElementById("map-legend-list");
const counts = {};
systems.forEach((s) => { if (s.control) counts[s.control] = (counts[s.control] || 0) + 1; });
Object.entries(factions).filter(([code]) => counts[code]).forEach(([code, f]) => {
  const li = document.createElement("li");
  li.innerHTML = `<span class="swatch" style="background:${f.colour || "transparent"}"></span>${esc(code === "IND" ? "Independent" : code)} <span class="muted">${counts[code]}</span>`;
  legend.appendChild(li);
});
const hz = document.createElement("li"); hz.innerHTML = `<span class="swatch hazard">☣</span>Bionid hazard`; legend.appendChild(hz);

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function frame() {
  const t = clock.getElapsedTime();
  if (mode === "planet") {
    pcontrols.update();
    if (planetSpin) { planetSpin.planet.rotation.y = t * 0.035; planetSpin.clouds.rotation.y = t * 0.045; }
    renderer.render(planetScene, pcamera);
    labelRenderer.domElement.style.visibility = "hidden";
  } else {
    controls.update();
    // Keep the view over the sector.
    controls.target.x = Math.max(minX, Math.min(maxX, controls.target.x));
    controls.target.z = Math.max(minZ, Math.min(maxZ, controls.target.z));
    systems.forEach((s) => {
      if (!s.glow) return;
      // Shrink the glow as the camera closes in, so a star stays a point of light rather than a blob.
      const near = Math.min(1, Math.max(0.28, camera.position.distanceTo(s.pos) / 9));
      s.glow.scale.setScalar(s.baseScale * near * (1 + 0.05 * Math.sin(t * 1.7 + s.twinkle)));
    });
    if (hazard) hazard.material.opacity = 0.75 + 0.25 * Math.sin(t * 2.4);
    updateLabels(camera);
    renderer.render(mapScene, camera);
    labelRenderer.domElement.style.visibility = mode === "station" ? "hidden" : "visible";
    labelRenderer.render(mapScene, camera);
  }
  app.classList.toggle("closeup", mode !== "map");
  requestAnimationFrame(frame);
}
resize();
frame();

// Open a system named in the address, e.g. /map/#H6.
const startHex = decodeURIComponent(location.hash.slice(1));
if (startHex && byHex.get(startHex)) setTimeout(() => select(byHex.get(startHex)), 400);
