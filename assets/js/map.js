// The Verse: 3D map of Sector 005.
// Map view: hex grid with star systems above and below the plane. Click a star to fly in
// to its colony planet, with the star far away in the background and the info panel open.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const app = document.getElementById("map-app");
let boardOn = false;
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
const descriptions = RAW.descriptions || {};

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

// Alt-drag rotates (Windows convention); OrbitControls already rotates on Cmd, Ctrl or Shift-drag.
canvas.addEventListener("pointerdown", (e) => {
  if (mode === "map" && e.altKey && !boardOn) controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
}, true);
window.addEventListener("pointerup", () => { controls.mouseButtons.LEFT = THREE.MOUSE.PAN; });
const controls = new OrbitControls(camera, canvas);
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.zoomToCursor = true;
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
const skyGroup = new THREE.Group(); mapScene.add(skyGroup);
skyGroup.add(starfield(9000, 600, 1400, "sky"));
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
distantClouds(skyGroup, "far", 900, 7);

// ---------------------------------------------------------------- hex grid
const PX = 112; // canvas pixels per map unit
const minX = -1 - OFFSET.x, maxX = (COLS - 1) * 1.5 + 1 - OFFSET.x;
const minZ = -SQ3 / 2 - OFFSET.z, maxZ = (ROWS - 1) * SQ3 + SQ3 - OFFSET.z;
const W = maxX - minX, H = maxZ - minZ;
function gridTexture(withFills) {
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
    if (withFills && f && f.colour) {
      path(corners(x, z, 0.96)); g.fillStyle = f.colour + "8c"; g.fill();
      g.lineWidth = 7; g.strokeStyle = f.colour; g.stroke();
      path(corners(x, z, 0.84)); g.lineWidth = 3; g.strokeStyle = f.colour + "66"; g.stroke();
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
  return tex;
}
const gridTex = { fill: gridTexture(true), plain: gridTexture(false) };
const gridPlane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: gridTex.fill, transparent: true, depthWrite: false }));
gridPlane.rotation.x = -Math.PI / 2;
gridPlane.position.set(minX + W / 2, 0, minZ + H / 2);
// The plane layers draw first, so stars, units and trails always sit on top of the hexes.
gridPlane.renderOrder = -3;
mapScene.add(gridPlane);

// ---------------------------------------------------------------- star systems
const pickables = [];
const labelObjects = [];
const hitGeo = new THREE.SphereGeometry(0.6, 10, 8);
const hitMat = new THREE.MeshBasicMaterial({ visible: false });

systems.forEach((s) => {
  const { x, z } = hexXZ(s.hex);
  const rnd = seeded("h" + s.hex);
  const y = 0.45 + rnd() * 1.75; // every star sits above the galactic plane
  s.pos = new THREE.Vector3(x, y, z);
  const st = STAR[s.star_type] || STAR.G;
  const unrecorded = !s.system;
  const group = new THREE.Group(); group.position.copy(s.pos);

  const fc = factions[s.control] && factions[s.control].colour;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: fc ? new THREE.Color(fc) : st.colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: unrecorded ? 0.55 : 1 }));
  glow.scale.setScalar(st.size * (unrecorded ? 0.7 : 1));
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: CORE, color: fc ? new THREE.Color(fc).lerp(new THREE.Color(0xffffff), 0.45) : 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.scale.setScalar(st.size * 0.32);
  group.add(glow, core);
  s.group = group; s.core = core; s.baseOpacity = glow.material.opacity;
  s.glow = glow; s.baseScale = glow.scale.x; s.twinkle = rnd() * 10;

  const hit = new THREE.Mesh(hitGeo, hitMat); hit.userData.system = s; group.add(hit); pickables.push(hit);
  mapScene.add(group);

  // Stalk to the hex, so you can read which hex the star belongs to.
  const f = factions[s.control];
  const stalkColour = f && f.colour ? new THREE.Color(f.colour) : new THREE.Color(0x8aa6d8);
  const stalk = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0, z), s.pos.clone()]),
    new THREE.LineBasicMaterial({ color: stalkColour, transparent: true, opacity: 0.45 }));
  mapScene.add(stalk); s.stalk = stalk;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 24), new THREE.MeshBasicMaterial({ color: stalkColour, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.01, z); ring.renderOrder = -1; mapScene.add(ring); s.ring = ring;

  const el = document.createElement("div");
  el.className = "map-label" + (unrecorded ? " unrecorded" : "");
  el.textContent = s.system || s.hex;
  el.addEventListener("click", () => onSystemClick(s));
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
  const lab = new CSS2DObject(el); lab.position.set(x, 0, z); mapScene.add(lab);
  labelObjects.push({ s: { pos: new THREE.Vector3(x, 0, z), feature: true }, el });
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
    // In Board view names stay readable from higher up.
    let o = s.feature ? 1 - (d - 30) / 40 : boardOn ? 1 - (d - 45) / 20 : 1 - (d - 16) / 30;
    if (s === hovered || s === selected) o = 1;
    o = labelsOn || s === hovered ? Math.max(0, Math.min(1, o)) : 0;
    el.style.opacity = o.toFixed(2);
    el.style.pointerEvents = o > 0.3 ? "auto" : "none";
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null, selected = null, mode = "map", busy = false;

const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hexCentres = [];
for (let col = 0; col < COLS; col++) for (let row = 1; row <= ROWS; row++) { const code = hexCode(col, row); hexCentres.push({ code, ...hexXZ(code) }); }
function hexAt(x, z) {
  let best = null, bd = 0.92 * 0.92;
  hexCentres.forEach((h) => { const d = (h.x - x) ** 2 + (h.z - z) ** 2; if (d < bd) { bd = d; best = h.code; } });
  return best;
}
// Highlight for the hex under the pointer.
const hexShape = new THREE.Shape(Array.from({ length: 6 }, (_, k) => new THREE.Vector2(Math.cos((Math.PI / 3) * k), Math.sin((Math.PI / 3) * k))));
const hexHighlight = new THREE.Group(); hexHighlight.visible = false; mapScene.add(hexHighlight);
hexHighlight.add(new THREE.Mesh(new THREE.ShapeGeometry(hexShape), new THREE.MeshBasicMaterial({ color: 0xf0b429, transparent: true, opacity: 0.18, depthWrite: false })));
hexHighlight.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexShape.getPoints().map((p) => new THREE.Vector3(p.x, p.y, 0))), new THREE.LineBasicMaterial({ color: 0xf0b429 })));
hexHighlight.rotation.x = Math.PI / 2;
hexHighlight.children.forEach((c) => { c.renderOrder = -1; });
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables.filter((o) => o.visible !== false && (!o.parent || o.parent.visible !== false)), false)[0];
  if (hit) return hit.object.userData.system;
  const v = new THREE.Vector3();
  if (!raycaster.ray.intersectPlane(groundPlane, v)) return null;
  const code = hexAt(v.x, v.z);
  return code ? byHex.get(code) || null : null;
}
canvas.addEventListener("pointermove", (ev) => {
  if (mode !== "map" || busy) return;
  const s = pick(ev);
  if (s !== hovered) {
    if (hovered) hovered.label.classList.remove("hover");
    hovered = s; if (s) s.label.classList.add("hover");
    canvas.style.cursor = s ? "pointer" : "";
    if (s) { const { x, z } = hexXZ(s.hex); hexHighlight.position.set(x, 0.025, z); hexHighlight.visible = true; }
    else hexHighlight.visible = false;
    hoverSummary(s);
  }
});
let downAt = null;
canvas.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener("pointerup", (ev) => {
  if (!downAt || mode !== "map" || busy) return;
  const moved = Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]);
  downAt = null;
  if (moved > 6) return;
  const s = pick(ev); if (!s) return;
  // On a touchscreen there is no hover, so the first tap shows the summary and the button.
  if (ev.pointerType === "touch" && summaryWanted(s) && summaryFor !== s) { showSummary(s); return; }
  onSystemClick(s);
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
// A newer flight takes over from one still in progress.
let flightToken = 0;
function flyMap(toPos, toTarget, ms = 1300) {
  const my = ++flightToken;
  const p0 = camera.position.clone(), t0 = controls.target.clone();
  return tween(ms, (k) => { if (my !== flightToken) return; camera.position.lerpVectors(p0, toPos, k); controls.target.lerpVectors(t0, toTarget, k); });
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
const sunDir = SUN_DIR.clone(); // the current close-up's sun; Parliament is lit from behind the camera
// Camera position around the planet: angle 0 puts the star directly behind the planet.
function orbitPoint(angle, dist, lift) {
  const back = sunDir.clone().negate();
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
const sunLight = new THREE.DirectionalLight(0xffffff, 3.3);
planetScene.add(sunLight, new THREE.AmbientLight(0x2a3a55, 0.28));
let planetGroup = null, planetSpin = null, traffic = [], orbiters = [];
const sunDirView = new THREE.Vector3();
const nightMaterials = [];

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

// Reflections for the metal stations (not used on the planets themselves).
let stationEnv = null;
async function getStationEnv() {
  if (stationEnv) return stationEnv;
  const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
  const pm = new THREE.PMREMGenerator(renderer);
  stationEnv = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  return stationEnv;
}

// ---------------------------------------------------------------- planet textures (in a worker)
// Simplex noise sampled on the sphere, so textures wrap with no seam and no pole pinching.
const WORKER_SRC = `
const F3 = 1 / 3, G3 = 1 / 6;
const grad = new Float32Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1]);
function makeSimplex(seed) {
  let h = 2166136261; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const p = new Uint8Array(256).map((_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512), pm12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }
  return function (x, y, z) {
    const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3, x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) { if (y0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=1;k2=0; } else if (x0 >= z0) { i1=1;j1=0;k1=0;i2=1;j2=0;k2=1; } else { i1=0;j1=0;k1=1;i2=1;j2=0;k2=1; } }
    else { if (y0 < z0) { i1=0;j1=0;k1=1;i2=0;j2=1;k2=1; } else if (x0 < z0) { i1=0;j1=1;k1=0;i2=0;j2=1;k2=1; } else { i1=0;j1=1;k1=0;i2=1;j2=1;k2=0; } }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3, x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0*x0 - y0*y0 - z0*z0; if (tt > 0) { g = pm12[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (grad[g]*x0 + grad[g+1]*y0 + grad[g+2]*z0); }
    tt = 0.6 - x1*x1 - y1*y1 - z1*z1; if (tt > 0) { g = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (grad[g]*x1 + grad[g+1]*y1 + grad[g+2]*z1); }
    tt = 0.6 - x2*x2 - y2*y2 - z2*z2; if (tt > 0) { g = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (grad[g]*x2 + grad[g+1]*y2 + grad[g+2]*z2); }
    tt = 0.6 - x3*x3 - y3*y3 - z3*z3; if (tt > 0) { g = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (grad[g]*x3 + grad[g+1]*y3 + grad[g+2]*z3); }
    return 32 * n; // about -1 .. 1
  };
}
function fbm(n, x, y, z, oct, lac, gain) { let a = 0.5, f = 1, s = 0, w = 0; for (let o = 0; o < oct; o++) { s += a * n(x*f, y*f, z*f); w += a; a *= gain; f *= lac; } return s / w; }
function ramp(r, v, out) {
  let i = 0; while (i < r.length - 1 && v > r[i + 1][0]) i++;
  const a = r[i], b = r[Math.min(i + 1, r.length - 1)];
  const t = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (v - a[0]) / (b[0] - a[0])));
  out[0] = a[1] + (b[1] - a[1]) * t; out[1] = a[2] + (b[2] - a[2]) * t; out[2] = a[3] + (b[3] - a[3]) * t;
}
onmessage = (e) => {
  const { name, type, W, H, lights } = e.data;
  const nt = makeSimplex("t" + name), nw = makeSimplex("w" + name), nc = makeSimplex("c" + name), nl = makeSimplex("l" + name);
  const col = new Uint8ClampedArray(W * H * 4), bump = new Uint8ClampedArray(W * H * 4), rough = new Uint8ClampedArray(W * H * 4);
  const night = new Uint8ClampedArray(W * H * 4), lava = new Uint8ClampedArray(W * H * 4);
  const CW = W / 2, CH = H / 2, cloud = new Uint8ClampedArray(CW * CH * 4);
  const c = [0, 0, 0], sea = type.sea;
  for (let j = 0; j < H; j++) {
    const lat = (j / (H - 1) - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < W; i++) {
      const lon = (i / W) * Math.PI * 2, x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      // Domain-warped terrain gives continents with ragged coasts rather than blobs.
      const wx = fbm(nw, x * 1.3, y * 1.3, z * 1.3, 3, 2.1, 0.5) * 0.45;
      let h = fbm(nt, x * 1.7 + wx, y * 1.7 - wx, z * 1.7 + wx, 8, 2.05, 0.52) * 0.5 + 0.5;
      // Ridged detail for mountain ranges above the coast.
      const ridge = 1 - Math.abs(fbm(nl, x * 4.5, y * 4.5, z * 4.5, 4, 2.1, 0.5));
      if (h > sea) h += (ridge * ridge - 0.5) * 0.06 * Math.min(1, (h - sea) * 6);
      h = Math.min(1, Math.max(0, (h - 0.5) * 1.75 + 0.5));
      if (type.craters) { const k = Math.abs(nl(x * 9, y * 9, z * 9)); if (k < 0.08) h -= (0.08 - k) * 2.2; }
      ramp(type.ramp, h, c);
      const ice = type.ice - (h - 0.5) * 0.15 + nw(x * 6, y * 6, z * 6) * 0.03;
      let isIce = Math.abs(sl) > ice;
      if (isIce) { c[0] += (244 - c[0]) * 0.88; c[1] += (248 - c[1]) * 0.88; c[2] += (255 - c[2]) * 0.88; }
      const o = (j * W + i) * 4;
      col[o] = c[0]; col[o+1] = c[1]; col[o+2] = c[2]; col[o+3] = 255;
      const water = sea > 0 && h <= sea && !isIce;
      const hb = water ? sea * 255 : h * 255;
      bump[o] = bump[o+1] = bump[o+2] = hb; bump[o+3] = 255;
      const rg = water ? 70 : isIce ? 150 : 235;
      rough[o] = rough[o+1] = rough[o+2] = rg; rough[o+3] = 255;
      if (lights && !water && !isIce && h < 0.82) {
        const k = fbm(nc, x * 30, y * 30, z * 30, 3, 2.2, 0.5) + fbm(nl, x * 6, y * 6, z * 6, 2, 2, 0.5) * 0.6;
        if (k > 0.32) { const b = Math.min(1, (k - 0.32) * 3.5); night[o] = 255 * b; night[o+1] = 196 * b; night[o+2] = 120 * b; }
      }
      night[o+3] = 255;
      if (type.lava) { const k = 1 - Math.abs(nl(x * 5 + 3, y * 5, z * 5)) * 14; if (k > 0) { lava[o] = 255 * k; lava[o+1] = 95 * k; lava[o+2] = 20 * k; } }
      if (type.veins) { const k = 1 - Math.abs(nl(x * 4, y * 4 + 7, z * 4)) * 16; if (k > 0) { lava[o] = 170 * k; lava[o+1] = 20 * k; lava[o+2] = 140 * k; } }
      lava[o+3] = 255;
    }
  }
  const cc = type.cloudColour;
  for (let j = 0; j < CH; j++) {
    const lat = (j / (CH - 1) - 0.5) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < CW; i++) {
      const lon = (i / CW) * Math.PI * 2, x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon);
      const sw = type.swirl ? Math.sin(y * 7 + fbm(nw, x * 2, y * 2, z * 2, 2, 2, 0.5) * 3) * 0.5 : 0;
      const wq = fbm(nw, x * 2.2, y * 2.2, z * 2.2, 3, 2, 0.5) * 0.6;
      let v = fbm(nc, x * 2.6 + wq + sw, y * 5.0 + wq, z * 2.6 - wq, 6, 2.1, 0.55) * 0.5 + 0.5;
      const th = 0.69 - type.clouds * 0.2;
      v = Math.min(1, Math.max(0, (v - th) / 0.14)); v = v * v * (3 - 2 * v) * 0.95;
      const o = (j * CW + i) * 4;
      cloud[o] = cc[0]; cloud[o+1] = cc[1]; cloud[o+2] = cc[2]; cloud[o+3] = v * 255;
    }
  }
  postMessage({ col, bump, rough, night, lava, cloud, W, H, CW, CH }, [col.buffer, bump.buffer, rough.buffer, night.buffer, lava.buffer, cloud.buffer]);
};`;
const workerURL = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
const hexRGB = (h) => { const c = new THREE.Color(h); return [c.r * 255, c.g * 255, c.b * 255]; };

function planetTextures(s) {
  const type = TYPES[s.planet_type] || TYPES.temperate;
  const pop = parseFloat(s.population_m) || 0;
  const payload = {
    name: s.system, W: 2048, H: 1024, lights: !!type.lights || pop > 25,
    type: { sea: type.sea, ice: type.ice, clouds: type.clouds, craters: !!type.craters, lava: !!type.lava, veins: !!type.veins, swirl: !!type.swirl,
      ramp: type.ramp.map(([h, c]) => [h, ...hexRGB(c)]), cloudColour: hexRGB(type.cloudColour || "#ffffff") },
  };
  return new Promise((resolve) => {
    const w = new Worker(workerURL);
    w.onmessage = ({ data }) => {
      w.terminate();
      const tex = (arr, W, H, srgb) => {
        const t = new THREE.DataTexture(arr, W, H, THREE.RGBAFormat);
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = THREE.RepeatWrapping; t.flipY = true;
        t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.needsUpdate = true; return t;
      };
      resolve({ type, map: tex(data.col, data.W, data.H, true), bump: tex(data.bump, data.W, data.H), rough: tex(data.rough, data.W, data.H),
        night: tex(data.night, data.W, data.H, true), lava: tex(data.lava, data.W, data.H, true), clouds: tex(data.cloud, data.CW, data.CH, true) });
    };
    w.postMessage(payload);
  });
}

// City lights only on the night side; lava and Bionid veins glow everywhere.
function planetMaterial(t) {
  const m = new THREE.MeshStandardMaterial({
    map: t.map, bumpMap: t.bump, bumpScale: 2.2, roughnessMap: t.rough, roughness: 1, metalness: 0,
    emissiveMap: t.night, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 1.2,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.sunDirView = { value: sunDirView };
    sh.uniforms.lavaMap = { value: t.lava };
    sh.fragmentShader = "uniform vec3 sunDirView;\nuniform sampler2D lavaMap;\n" + sh.fragmentShader.replace("#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n totalEmissiveRadiance *= smoothstep(0.12, -0.22, dot(normal, sunDirView));\n totalEmissiveRadiance += texture2D(lavaMap, vMapUv).rgb * 1.3;");
  };
  nightMaterials.push(m);
  return m;
}

// Thin, translucent atmosphere: a rim that is bright on the sunlit limb and fades on the night side.
function atmosphereShell(colour, radius, back, strength) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), new THREE.ShaderMaterial({
    uniforms: { c: { value: new THREE.Color(colour) }, sunDirView: { value: sunDirView }, k: { value: strength } },
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }",
    fragmentShader: back
      ? "uniform vec3 c; uniform vec3 sunDirView; uniform float k; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(max(0.0, 0.66 + dot(vN, vV)), 5.0); float lit = smoothstep(-0.35, 0.55, dot(-vN, sunDirView)); gl_FragColor = vec4(c, f * lit * k); }"
      : "uniform vec3 c; uniform vec3 sunDirView; uniform float k; varying vec3 vN; varying vec3 vV; void main(){ float rim = 1.0 - max(dot(vN, vV), 0.0); float f = pow(rim, 3.5); float lit = smoothstep(-0.2, 0.6, dot(vN, sunDirView)); gl_FragColor = vec4(c * (0.6 + lit), f * lit * k); }",
    transparent: true, blending: THREE.AdditiveBlending, side: back ? THREE.BackSide : THREE.FrontSide, depthWrite: false,
  }));
}

// ---------------------------------------------------------------- orbital stations and traffic
const metal = (env, colour = 0xb8bec8, rough = 0.35) => new THREE.MeshStandardMaterial({ color: colour, metalness: 0.85, roughness: rough, envMap: env, envMapIntensity: 0.9 });
const glowMat = (colour) => new THREE.MeshBasicMaterial({ color: colour });

function miniStation(env, rnd) {
  const g = new THREE.Group(), m = metal(env);
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.5, 12), m));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 8, 32), m); ring.rotation.x = Math.PI / 2; g.add(ring);
  for (let k = 0; k < 4; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.02), m); sp.rotation.y = (k * Math.PI) / 4; g.add(sp); }
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.6), metal(env, 0x2a3f6e, 0.4));
  panel.position.y = 0.32; g.add(panel);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), glowMat(0x9fd2ff)); light.position.y = -0.27; g.add(light);
  g.scale.setScalar(0.06); g.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
  return g;
}
function miniDock(env) {
  const g = new THREE.Group(), m = metal(env, 0x9aa0aa, 0.5);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.12), m); g.add(frame);
  for (let k = -2; k <= 2; k++) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 6, 16), m); r.position.x = k * 0.13; r.rotation.y = Math.PI / 2; g.add(r); }
  g.scale.setScalar(0.04); return g;
}
function miniCollector(env) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.01, 0.3), metal(env, 0x24366a, 0.3)));
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.3, 6), metal(env)); mast.rotation.z = Math.PI / 2; g.add(mast);
  g.scale.setScalar(0.035); return g;
}

// An orbit: a pivot that turns slowly about a tilted axis, carrying its object at radius r.
function makeOrbit(obj, r, tilt, speed, phase) {
  const pivot = new THREE.Group(); pivot.rotation.set(tilt, phase, tilt * 0.4);
  const arm = new THREE.Group(); arm.add(obj); obj.position.set(r, 0, 0);
  // Traffic hangs off this anchor: it rides along the orbit but does not tumble with the object.
  const anchor = new THREE.Group(); anchor.position.set(r, 0, 0); arm.add(anchor);
  pivot.add(arm); planetGroup.add(pivot);
  orbiters.push({ arm, speed });
  return { pivot, arm, obj, anchor };
}

const TRAFFIC = { CC: 70, VR: 50, RC: 34, AA: 7, AC: 5, BA: 4, PC: 3 };
const STATION_GRADES = ["BA", "AC", "AA", "RC", "VR", "CC"];
const INFRA_GRADES = ["RC", "VR", "CC"];

// Ships: specks that leave the station accelerating (bright drive flare behind them) or arrive
// decelerating (bright braking burn). Paths always head away from the planet, so none cross it.
function buildTraffic(anchor, count, rnd, fromSurface) {
  const bodies = new Float32Array(count * 3), flares = new Float32Array(count * 3), fcol = new Float32Array(count * 3);
  const ships = [];
  for (let i = 0; i < count; i++) {
    let d;
    do { d = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); } while (d.lengthSq() > 1 || d.lengthSq() < 0.05);
    d.normalize(); if (d.x < 0.2) d.x = 0.2 + Math.abs(d.x); d.normalize(); // the anchor sits on +x, away from the planet
    ships.push({ d, L: 0.35 + rnd() * 1.6, T: 90 + rnd() * 160, ph: rnd(), out: rnd() < 0.5, steady: rnd() < 0.2, start: fromSurface ? -0.02 : 0 });
  }
  const geoB = new THREE.BufferGeometry(); geoB.setAttribute("position", new THREE.BufferAttribute(bodies, 3));
  const geoF = new THREE.BufferGeometry(); geoF.setAttribute("position", new THREE.BufferAttribute(flares, 3)); geoF.setAttribute("color", new THREE.BufferAttribute(fcol, 3));
  const ptsB = new THREE.Points(geoB, new THREE.PointsMaterial({ size: 1.2, sizeAttenuation: false, color: 0xaab3c2, transparent: true, opacity: 0.85, depthWrite: false }));
  const ptsF = new THREE.Points(geoF, new THREE.PointsMaterial({ size: 2.6, sizeAttenuation: false, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  anchor.add(ptsB, ptsF);
  traffic.push({ ships, bodies, flares, fcol, geoB, geoF });
}
function updateTraffic(t) {
  traffic.forEach((tr) => {
    tr.ships.forEach((s, i) => {
      const u = ((t / s.T) + s.ph) % 1;
      let dist, burn, tail;
      if (s.out) { dist = s.L * u * u; burn = Math.max(0, 1 - u * 2.2); tail = -1; }        // accelerating away
      else { const v = 1 - u; dist = s.L * v * v; burn = Math.max(0, (u - 0.45) * 1.8); tail = 1; } // braking in
      const fadeEnds = Math.min(1, u * 12, (1 - u) * 12);
      const x = s.d.x * dist + s.start, y = s.d.y * dist, z = s.d.z * dist;
      tr.bodies.set([x, y, z], i * 3);
      // The flare sits just behind the ship's direction of travel.
      const k = 0.012 * tail * (s.out ? 1 : -1);
      tr.flares.set([x - s.d.x * k, y - s.d.y * k, z - s.d.z * k], i * 3);
      const b = Math.min(1, (s.steady ? 0.35 : 0) + burn) * fadeEnds;
      tr.fcol.set([1.0 * b, 0.78 * b, 0.55 * b], i * 3);
    });
    tr.geoB.attributes.position.needsUpdate = true; tr.geoF.attributes.position.needsUpdate = true; tr.geoF.attributes.color.needsUpdate = true;
  });
}

// ---------------------------------------------------------------- Unity 5 orbital station (Parliament)
function hullTexture() {
  // u runs round the hull, v along it; sized so lettering keeps its proportions.
  const c = document.createElement("canvas"); c.width = 2048; c.height = 1720;
  const g = c.getContext("2d");
  g.fillStyle = "#9da4ae"; g.fillRect(0, 0, c.width, c.height);
  for (let x = 0; x < c.width; x += 128) for (let y = 0; y < c.height; y += 172) {
    const v = 150 + ((x * 7 + y * 13) % 40); g.fillStyle = `rgb(${v},${v + 4},${v + 10})`; g.fillRect(x + 3, y + 3, 122, 166);
  }
  g.strokeStyle = "rgba(40,45,55,0.85)"; g.lineWidth = 4;
  for (let y = 0; y < c.height; y += 344) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
  // Four copies round the hull, so one always faces the camera; letters read from the drive end aft.
  for (const cx of [256, 768, 1280, 1792]) {
    g.save(); g.translate(cx, 860); g.rotate(Math.PI / 2);
    g.fillStyle = "#123a9e"; g.font = "bold 200px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("UNITY 5", 130, 10);
    g.lineWidth = 16; g.strokeStyle = "#1f56e0"; g.beginPath(); g.arc(-430, 6, 120, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#1f56e0"; g.font = "bold 160px system-ui, sans-serif"; g.fillText("U", -430, 14);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
let HULL_TURN = 0; // turns the hull about its axis so the name faces the arriving camera
function buildUnity5(env) {
  const g = new THREE.Group();
  const hullM = new THREE.MeshStandardMaterial({ map: hullTexture(), metalness: 0.8, roughness: 0.32, envMap: env, envMapIntensity: 1.1 });
  const dark = metal(env, 0x5d636d, 0.45), bright = metal(env, 0xc9ced6, 0.25);
  const blue = glowMat(0x4aa8ff), amber = glowMat(0xffb35a);
  const along = (geo, mat, x) => { const m = new THREE.Mesh(geo, mat); m.rotation.z = Math.PI / 2; m.position.x = x; g.add(m); return m; };
  // Main hull, with the named section facing the camera.
  const hull = along(new THREE.CylinderGeometry(0.18, 0.18, 0.95, 64, 1).rotateY(HULL_TURN), hullM, -0.12);
  // Forward drive section with glowing ring lights and three engines.
  along(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 48), bright, -0.66);
  along(new THREE.CylinderGeometry(0.15, 0.2, 0.1, 48), dark, -0.77);
  for (let k = 0; k < 3; k++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.205, 0.006, 6, 64), k === 1 ? amber : blue);
    ring.rotation.y = Math.PI / 2; ring.position.x = -0.6 - k * 0.05; g.add(ring);
  }
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const nozzle = along(new THREE.CylinderGeometry(0.035, 0.05, 0.08, 16), dark, -0.86);
    nozzle.position.y = Math.cos(a) * 0.07; nozzle.position.z = Math.sin(a) * 0.07;
    const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0x5ab4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.position.set(-0.93, nozzle.position.y, nozzle.position.z); flame.scale.setScalar(0.16); g.add(flame);
  }
  // Panel bands along the hull.
  for (let k = 0; k < 5; k++) along(new THREE.CylinderGeometry(0.185, 0.185, 0.012, 48), dark, -0.55 + k * 0.2);
  // Mid-ship trusses and the great spoked wheel.
  along(new THREE.CylinderGeometry(0.1, 0.1, 0.36, 24), dark, 0.52);
  const wheel = new THREE.Group(); wheel.position.x = 0.52;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.025, 12, 96), bright); rim.rotation.y = Math.PI / 2; wheel.add(rim);
  const rim2 = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.006, 6, 96), blue); rim2.rotation.y = Math.PI / 2; rim2.position.x = 0.03; wheel.add(rim2);
  for (let k = 0; k < 4; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.84, 0.02), dark); sp.rotation.x = (k * Math.PI) / 4; wheel.add(sp); }
  g.add(wheel);
  // Aft modules, solar arrays and the rear glow.
  along(new THREE.CylinderGeometry(0.13, 0.13, 0.22, 32), hullM, 0.82);
  along(new THREE.CylinderGeometry(0.15, 0.13, 0.06, 32), bright, 0.95);
  for (const s of [1, -1]) {
    const arr = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.005, 0.34), metal(env, 0x1c2f63, 0.3)); arr.position.set(0.9, 0.24 * s, 0.05); arr.rotation.x = 0.4 * s; g.add(arr);
    for (let k = 0; k < 4; k++) { const line = new THREE.Mesh(new THREE.BoxGeometry(0.162, 0.006, 0.004), dark); line.position.set(0.9, 0.24 * s, -0.12 + k * 0.08 + 0.05); line.rotation.x = 0.4 * s; g.add(line); }
  }
  const rear = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: 0x58aaff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  rear.position.x = 1.0; rear.scale.setScalar(0.35); g.add(rear);
  // A shuttle docked under the wheel, and small antenna masts.
  const shuttle = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.11, 8), bright); shuttle.rotation.z = Math.PI / 2; shuttle.position.set(0.32, -0.12, 0.17); g.add(shuttle);
  for (const x of [-0.35, 0.05]) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 6), bright); m.position.set(x, 0.24, 0); g.add(m); }
  // Port lights along the hull.
  for (let k = 0; k < 18; k++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 4), k % 3 ? blue : amber); const a = -0.9 + (k % 6) * 0.35; l.position.set(-0.55 + Math.floor(k / 6) * 0.38, Math.cos(a) * 0.185, Math.sin(a) * 0.185); g.add(l); }
  return { group: g, wheel };
}

// ---------------------------------------------------------------- build the close-up scene
let unity = null;
async function buildPlanet(s) {
  if (planetGroup) {
    planetScene.remove(planetGroup);
    planetGroup.traverse((o) => { o.geometry && o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => { m.map && m.map.dispose(); m.dispose(); }); });
  }
  traffic = []; orbiters = []; nightMaterials.length = 0; unity = null;
  planetGroup = new THREE.Group();
  const rnd = seeded("p" + s.system);
  const [tex, env] = await Promise.all([planetTextures(s), getStationEnv()]);
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 128), planetMaterial(tex));
  planet.rotation.z = 0.35 * (rnd() - 0.5);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.008, 128, 96), new THREE.MeshStandardMaterial({ map: tex.clouds, transparent: true, depthWrite: false, roughness: 1 }));
  planetGroup.add(planet, clouds);
  planetGroup.add(atmosphereShell(tex.type.atmo, 1.02, false, 0.9), atmosphereShell(tex.type.atmo, 1.055, true, 0.55));
  if (tex.type.mist) planetGroup.add(atmosphereShell("#dfe7f0", 1.012, false, 0.5));

  // Moons: Moon Weaver has many; others have up to two.
  const moons = s.system === "Moon Weaver" ? 7 : Math.floor(rnd() * 3);
  for (let i = 0; i < moons; i++) {
    const r = 0.05 + rnd() * 0.1, d = 2.2 + i * 0.6 + rnd() * 0.4;
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.08, 0.08, 0.4 + rnd() * 0.25), roughness: 1 }));
    makeOrbit(m, d, (rnd() - 0.5) * 0.3, 0.004 + rnd() * 0.004, rnd() * 6.3);
  }

  // Orbital infrastructure by colony status.
  const grade = s.grade;
  if (s.system === "Parliament") {
    unity = buildUnity5(env);
    unity.group.scale.setScalar(0.42);
    unity.group.position.copy(UNITY_POS);
    unity.group.rotation.set(0.15, -0.6, -0.12);
    planetGroup.add(unity.group);
  } else if (STATION_GRADES.includes(grade)) {
    const st = makeOrbit(miniStation(env, rnd), 1.22, 0.35 * (rnd() - 0.5), 0.012, rnd() * 6.3);
    if (TRAFFIC[grade]) buildTraffic(st.anchor, TRAFFIC[grade], rnd, false);
    if (INFRA_GRADES.includes(grade)) {
      makeOrbit(miniDock(env), 1.32, 0.5 * (rnd() - 0.5), 0.009, rnd() * 6.3);
      makeOrbit(miniCollector(env), 1.5, 0.6 * (rnd() - 0.5), 0.007, rnd() * 6.3);
    }
  } else if (grade === "PC") {
    // A poor colony has no station: its few ships rise from the surface.
    const pad = new THREE.Group(); const o = makeOrbit(pad, 1.0, 0.3 * (rnd() - 0.5), 0.006, rnd() * 6.3);
    buildTraffic(o.anchor, TRAFFIC.PC, rnd, true);
  }

  // The parent star: far away, so it reads as a bright point with a little glow.
  const st = STAR[s.star_type] || STAR.G;
  sunDir.copy(s.system === "Parliament" ? new THREE.Vector3(0.45, 0.55, 0.7).normalize() : SUN_DIR);
  sunLight.position.copy(sunDir.clone().multiplyScalar(50));
  sunLight.color.set(st.colour);
  const sun = new THREE.Group(); sun.position.copy(sunDir.clone().multiplyScalar(3000));
  const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: st.colour, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sunGlow.scale.setScalar(st.size * 210);
  const sunCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: CORE, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  sunCore.scale.setScalar(st.size * 60);
  sun.add(sunGlow, sunCore); planetGroup.add(sun);

  // Skaro sits inside the Bramble Patch Nebula.
  if (NEBULA_HEXES.includes(s.hex)) {
    const r2 = seeded("skaro-neb");
    for (let i = 0; i < 40; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTexture("sk" + i), color: new THREE.Color().setHSL([0.72, 0.62, 0.8][i % 3], 0.75, 0.42), transparent: true, opacity: 0.14 + r2() * 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
      const th = r2() * Math.PI * 2, ph = (r2() - 0.5) * 2, d = 30 + r2() * 120;
      sp.position.set(Math.cos(th) * Math.cos(ph) * d, Math.sin(ph) * d, Math.sin(th) * Math.cos(ph) * d);
      sp.scale.setScalar(d * (0.6 + r2()));
      planetGroup.add(sp);
    }
  }
  planetScene.add(planetGroup);
  planetSpin = { planet, clouds };
}
const UNITY_POS = new THREE.Vector3(0.35, 0.62, 1.25);

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
  panel.hidden = false; app.classList.add("panel-open");
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
      ${row("Enter or leave", `${systemMP(s)} MP (${systemMP(s) * DAYS_PER_MP} days)${systemMP(s) === 5 ? ", Deep Gravity Well" : ""}`)}
    </dl>
    ${forcesHTML(s)}
    ${descriptions[s.system] ? `<h3>Description</h3><p class="map-desc">${esc(descriptions[s.system])}</p>` : ""}
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
let mapCameraBefore = null;

async function select(s) {
  if (!s || busy) return;
  hideSummary();
  busy = true;
  if (selected && selected.label) selected.label.classList.remove("selected");
  selected = s; s.label && s.label.classList.add("selected");
  history.replaceState(null, "", "#" + s.hex);

  const fromCloseup = mode !== "map";
  if (fromCloseup) { await fadeTo(1, 350); leavePlanetScene(); }
  else mapCameraBefore = { pos: camera.position.clone(), target: controls.target.clone() };

  // Start generating the close-up now, so it is ready by the time the camera arrives.
  const building = s.system ? buildPlanet(s) : Promise.resolve();
  // Fly in to the star, keeping roughly the current viewing angle.
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.y < 0.35) { dir.y = 0.35; dir.normalize(); }
  const at = starPoint(s).clone();
  await flyMap(at.clone().add(dir.multiplyScalar(3.2)), at, fromCloseup ? 10 : 1300);
  renderPanel(s);

  if (!s.system) { await fadeTo(0, 300); busy = false; return; }
  if (fromCloseup) fade.style.opacity = 1;
  await Promise.all([fadeTo(1, 420), building]);
  mode = "planet";
  controls.enabled = false;
  framePlanet();
  if (s.system === "Parliament") {
    // Arrive on the Unity 5 station, with the planet below and behind it.
    const goal = UNITY_POS.clone(), from = goal.clone().add(new THREE.Vector3(-2.6, 1.0, 3.6)), to = goal.clone().add(new THREE.Vector3(-0.95, 0.22, 1.35));
    pcontrols.target.copy(goal); pcontrols.minDistance = 0.25;
    pcamera.position.copy(from); pcamera.lookAt(goal);
    await fadeTo(0, 500);
    await tween(3600, (k) => { pcamera.position.lerpVectors(from, to, k); pcamera.lookAt(goal); });
  } else {
    pcontrols.target.set(0, 0, 0); pcontrols.minDistance = 1.6;
    pcamera.position.copy(orbitPoint(0.3, 11, 0.6)); pcamera.lookAt(0, 0, 0);
    await fadeTo(0, 500);
    await tween(3600, (k) => { pcamera.position.copy(orbitPoint(0.3 + k * 1.75, 12 - k * 6.3, 0.6 - k * 0.2)); pcamera.lookAt(0, 0, 0); });
  }
  pcontrols.enabled = true;
  busy = false;
}

function starPoint(s) { return s.group ? s.group.position : s.pos; }
function leavePlanetScene() {
  pcontrols.enabled = false; controls.enabled = true;
  mode = "map";
}

async function backToMap() {
  if (busy) return;
  busy = true;
  if (mode !== "map") { await fadeTo(1, 380); leavePlanetScene(); await fadeTo(0, 380); }
  panel.hidden = true; app.classList.remove("panel-open");
  if (selected && selected.label) selected.label.classList.remove("selected");
  selected = null; history.replaceState(null, "", location.pathname);
  if (mapCameraBefore) await flyMap(mapCameraBefore.pos, mapCameraBefore.target, 1100);
  busy = false;
}
document.getElementById("map-back").addEventListener("click", backToMap);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") backToMap(); });

// ---------------------------------------------------------------- movement rules (Game Guide)
// 20 movement points per 100-day turn. 1 MP = one 5-parsec hex in hyperspace = 5 days.
// Entering or leaving a system costs its MP (usually 2; 5 for a Deep Gravity Well; some 1).
// Messages travel at 2 parsecs a day: 2.5 days per hex.
const MP_PER_TURN = 20, DAYS_PER_MP = 5, MSG_DAYS_PER_HEX = 2.5;
function cube(code) { const { c, r } = parseHex(code); const z = r - (c - (c & 1)) / 2; return { x: c, z, y: -c - z }; }
function hexDistance(a, b) { const p = cube(a), q = cube(b); return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z)); }
function systemMP(s) { const v = parseInt(s.mp, 10); return v === 1 || v === 2 || v === 5 ? v : 2; }
function legCost(a, b) {
  const hexes = hexDistance(a.hex, b.hex), leave = systemMP(a), enter = systemMP(b);
  const mp = leave + hexes + enter;
  return { a, b, hexes, leave, enter, mp, days: mp * DAYS_PER_MP, msg: hexes * MSG_DAYS_PER_HEX, ok: mp <= MP_PER_TURN };
}

// ---------------------------------------------------------------- fleets and squadrons
// Only units marked public, not running silent, based at a system (not in hyperspace, under
// repair or under construction) appear. Each unit shows its latest recorded turn.
const unitRows = (() => {
  const raw = RAW.units || [];
  if (!raw.length) return [];
  const [h, ...rs] = raw;
  return rs.filter((r) => r.length >= h.length - 1).map((r) => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? "").trim()])));
})();
const yes = (v) => /^(y|yes|true|1)$/i.test(v || "");
function resolveSystem(v) {
  if (!v) return null;
  return byHex.get(v.toUpperCase()) || systems.find((s) => s.system.toLowerCase() === v.toLowerCase()) || null;
}
const unitHistory = new Map(); // faction|name -> rows by turn
unitRows.forEach((u) => {
  if (!yes(u.public) || yes(u.silent)) return;
  const key = u.faction + "|" + u.name;
  if (!unitHistory.has(key)) unitHistory.set(key, []);
  unitHistory.get(key).push({ ...u, turnN: parseInt(u.turn, 10) || 0, sys: resolveSystem(u.system) });
});
unitHistory.forEach((rows) => rows.sort((a, b) => a.turnN - b.turnN));
// Only units with a position recorded for the current turn appear; older positions are history.
const currentTurn = Math.max(0, ...unitRows.map((u) => parseInt(u.turn, 10) || 0));
const unitsAt = new Map(); // hex -> visible units there this turn
unitHistory.forEach((rows) => {
  const last = rows[rows.length - 1];
  if (last.turnN === currentTurn && last.status === "based" && last.sys) {
    if (!unitsAt.has(last.sys.hex)) unitsAt.set(last.sys.hex, []);
    unitsAt.get(last.sys.hex).push(last);
  }
});

// Unit icons: arrowhead for a squadron, square counter for a division, disc for a hive fleet.
const iconCache = new Map();
function unitIconURL(category, colour) {
  const key = category + "|" + colour;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = colour || "#cfd6e6"; g.strokeStyle = "rgba(0,0,0,0.85)"; g.lineWidth = 5;
  g.beginPath();
  if (category === "ground") g.rect(14, 14, 36, 36);
  else if (category === "bionid") { g.arc(32, 32, 20, 0, Math.PI * 2); }
  else { g.moveTo(32, 8); g.lineTo(56, 52); g.lineTo(32, 42); g.lineTo(8, 52); g.closePath(); }
  g.stroke(); g.fill();
  if (category === "bionid") { g.fillStyle = "#1a0718"; g.font = "bold 28px system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("☣", 32, 34); }
  const url = c.toDataURL(); iconCache.set(key, url); return url;
}
const factionOrder = Object.keys(factions);
const CATEGORY_ORDER = { squadron: 0, space: 0, humanitarian: 1, ground: 2, bionid: 3 };
function unitSort(a, b) {
  const fa = factionOrder.indexOf(a.faction), fb = factionOrder.indexOf(b.faction);
  return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb) || (CATEGORY_ORDER[a.category] ?? 1) - (CATEGORY_ORDER[b.category] ?? 1) || a.name.localeCompare(b.name);
}
function unitClass(u) { return u.unit_class || (u.category === "ground" ? "Ground force" : u.category === "bionid" ? "Hive fleet" : "Space force"); }
function unitIconHTML(u, cls = "unit-ico") {
  const f = factions[u.faction];
  return `<img class="${cls}" src="${unitIconURL(u.category, f && f.colour)}" alt="" width="16" height="16">`;
}
unitsAt.forEach((units) => units.sort(unitSort));

// A line of unit icons just below each system's name, in faction order. It hangs off the same
// point as the name, so it sits under it in both the sector view and Board view.
const unitRows3D = [];
unitsAt.forEach((units, hex) => {
  const s = byHex.get(hex); if (!s || !s.group) return;
  const el = document.createElement("div"); el.className = "map-unit-row"; s.unitRow = el;
  const inner = document.createElement("span");
  inner.innerHTML = units.map((u) => unitIconHTML(u).replace("<img ", `<img title="${esc(u.name)} · ${esc(unitClass(u))} · ${esc(u.faction)}" `)).join("");
  inner.addEventListener("click", () => onSystemClick(s));
  el.appendChild(inner);
  const st = STAR[s.star_type] || STAR.G;
  const obj = new CSS2DObject(el); obj.position.set(0, st.size * 0.42 + 0.15, 0); s.group.add(obj);
  unitRows3D.push(obj);
});

// ---------------------------------------------------------------- hover summary
// Hovering a system shows a short version of its info panel and an Enter Star System button
// under its name. The button (or a click on the star) opens the full close-up view.
let infoOn = true, summaryFor = null, summaryTimer = null, overSummary = false;
const summaryCard = document.getElementById("map-summary");
const enterEl = document.createElement("div"); enterEl.className = "map-enter";
enterEl.innerHTML = `<button type="button">Enter Star System</button>`;
const enterObj = new CSS2DObject(enterEl); enterObj.visible = false;
function summaryWanted(s) { return infoOn && s && s.system && mode === "map" && !toolMode && !busy; }
function forcesSummaryHTML(s) {
  const units = unitsAt.get(s.hex);
  if (!units || !units.length) return "";
  const groups = new Map(); // faction -> class -> units
  units.forEach((u) => {
    if (!groups.has(u.faction)) groups.set(u.faction, new Map());
    const g = groups.get(u.faction), c = unitClass(u);
    if (!g.has(c)) g.set(c, []); g.get(c).push(u);
  });
  const lines = [];
  groups.forEach((g, fac) => g.forEach((us, c) => {
    const n = us.length, label = n > 1 ? c.replace(/(Squadron|Division|Fleet|Force)$/, "$1s") : c;
    lines.push(`<li>${us.map((u) => unitIconHTML(u)).join("")}<span>${esc(fac)} · ${n} ${esc(label)}</span></li>`);
  }));
  return `<h3>Forces present</h3><ul class="map-forces-sum">${lines.join("")}</ul>`;
}
function showSummary(s) {
  clearTimeout(summaryTimer);
  if (!summaryWanted(s)) return;
  if (summaryFor && summaryFor.unitRow) summaryFor.unitRow.classList.remove("has-enter");
  summaryFor = s;
  const g = grades[s.grade];
  summaryCard.innerHTML = `
    <p class="kicker">Hex ${esc(s.hex)}</p>
    <h2>${esc(s.system)}</h2>
    <dl class="map-facts">
      ${row("Colony world", esc(s.system))}
      ${row("Controlled by", factionHTML(s.control))}
      ${row("Population", formatPop(s.population_m))}
      ${row("Colony status", s.grade ? (g ? `${esc(g)} (${esc(s.grade)})` : esc(s.grade)) : "Not recorded")}
      ${row("Support Value", s.sv !== "" ? esc(s.sv) : "Not recorded")}
      ${row("M25 limit", s.m25_au !== "" ? esc(parseFloat(s.m25_au)) + " AU" : "Not recorded")}
      ${row("Enter or leave", `${systemMP(s)} MP (${systemMP(s) * DAYS_PER_MP} days)`)}
    </dl>
    ${forcesSummaryHTML(s)}`;
  summaryCard.hidden = false;
  s.group.add(enterObj); enterObj.position.set(0, (STAR[s.star_type] || STAR.G).size * 0.42 + 0.15, 0);
  enterObj.visible = true;
  if (s.unitRow) s.unitRow.classList.add("has-enter");
}
function hideSummary() {
  clearTimeout(summaryTimer);
  if (summaryFor && summaryFor.unitRow) summaryFor.unitRow.classList.remove("has-enter");
  summaryFor = null; summaryCard.hidden = true; enterObj.visible = false;
}
// Moving towards the button can cross other hexes, so switching or hiding waits a moment.
function hoverSummary(s) {
  if (!infoOn) return;
  clearTimeout(summaryTimer);
  if (overSummary) return;
  if (s && s.system) {
    if (!summaryFor) showSummary(s);
    else if (s !== summaryFor) summaryTimer = setTimeout(() => showSummary(s), 350);
  } else if (summaryFor) summaryTimer = setTimeout(hideSummary, 900);
}
[enterEl, summaryCard].forEach((el) => {
  el.addEventListener("pointerenter", () => { overSummary = true; clearTimeout(summaryTimer); });
  el.addEventListener("pointerleave", () => { overSummary = false; if (hovered !== summaryFor) summaryTimer = setTimeout(hideSummary, 900); });
});
enterEl.querySelector("button").addEventListener("click", () => { const s = summaryFor; overSummary = false; hideSummary(); if (s) onSystemClick(s); });
const infoBtn = document.getElementById("map-info");
infoBtn.addEventListener("click", () => {
  infoOn = !infoOn; infoBtn.setAttribute("aria-pressed", String(infoOn));
  if (!infoOn) hideSummary(); else if (hovered) showSummary(hovered);
});

function forcesHTML(s) {
  const units = unitsAt.get(s.hex);
  if (!units || !units.length) return "";
  const turn = Math.max(...units.map((u) => u.turnN));
  return `<h3>Forces present</h3><ul class="map-forces">${units.map((u) =>
    `<li>${unitIconHTML(u)}<span><strong>${esc(u.name)}</strong> <span class="muted">${esc(unitClass(u))} · ${esc(u.faction)}</span></span></li>`
  ).join("")}</ul><p class="muted small">As at Turn ${turn}.</p>`;
}

// Movement trails: a curved line for each move between recorded turns. With units picked in the
// Unit movement card, only their trails show, with the turns they spent at each system.
const trailGroup = new THREE.Group(); trailGroup.visible = false; mapScene.add(trailGroup);
let trailPick = null; // null = every unit; otherwise a Set of "faction|name" keys
let turnMarks = [];
function unitStops(rows) { return rows.filter((r) => r.status === "based" && r.sys); }
function turnSpan(a, b) { return a === b ? `T${a}` : `T${a}–${b}`; }
function buildTrails() {
  trailGroup.clear(); turnMarks = [];
  const marks = new Map(); // hex -> lines of "unit: turns"
  unitHistory.forEach((rows, key) => {
    if (trailPick && !trailPick.has(key)) return;
    const stops = unitStops(rows);
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1].sys, b = stops[i].sys; if (a === b) continue;
      const f = factions[stops[i].faction], col = (f && f.colour) || "#cfd6e6";
      const pa = starPoint(a).clone(), pb = starPoint(b).clone();
      const mid = pa.clone().add(pb).multiplyScalar(0.5); mid.y += 0.6 + pa.distanceTo(pb) * 0.12;
      const curve = new THREE.QuadraticBezierCurve3(pa, mid, pb);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(40)),
        new THREE.LineDashedMaterial({ color: col, dashSize: 0.25, gapSize: 0.14, transparent: true, opacity: 0.9 }));
      line.computeLineDistances(); trailGroup.add(line);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 10), new THREE.MeshBasicMaterial({ color: col }));
      head.position.copy(curve.getPoint(0.94)); head.lookAt(curve.getPoint(1)); head.rotateX(Math.PI / 2); trailGroup.add(head);
    }
    if (!trailPick || !stops.length) return;
    // Runs of turns at the same system: "T3–5".
    const runs = [];
    stops.forEach((r) => {
      const last = runs[runs.length - 1];
      if (last && last.sys === r.sys && r.turnN <= last.to + 1) last.to = r.turnN;
      else runs.push({ sys: r.sys, from: r.turnN, to: r.turnN });
    });
    const bySys = new Map();
    runs.forEach((r) => { if (!bySys.has(r.sys)) bySys.set(r.sys, []); bySys.get(r.sys).push(turnSpan(r.from, r.to)); });
    const u = stops[stops.length - 1];
    bySys.forEach((spans, sys) => {
      if (!marks.has(sys)) marks.set(sys, []);
      marks.get(sys).push({ u, text: spans.join(", ") });
    });
  });
  marks.forEach((lines, sys) => {
    const el = document.createElement("div"); el.className = "map-turns";
    el.innerHTML = `<span>${lines.map(({ u, text }) => `<span class="map-turn-line">${unitIconHTML(u, "unit-ico sm")}${esc(u.name)} <b>${text}</b></span>`).join("")}</span>`;
    const obj = new CSS2DObject(el); obj.position.copy(starPoint(sys)); obj.visible = trailGroup.visible;
    trailGroup.add(obj); turnMarks.push(obj);
  });
}
buildTrails();

// Unit movement card: pick units to follow, one or several at a time.
const movesCard = document.getElementById("map-moves");
const unitSearch = document.getElementById("map-unit-search");
const unitList = document.getElementById("map-unit-list");
const pickedList = document.getElementById("map-unit-picked");
const movesStatus = document.getElementById("map-moves-status");
const followable = [...unitHistory.entries()]
  .map(([key, rows]) => ({ key, rows, u: rows[rows.length - 1] }))
  .filter((x) => unitStops(x.rows).length)
  .sort((a, b) => unitSort(a.u, b.u));
const unitLabel = (x) => `${x.u.name} (${x.u.faction})`;
unitList.innerHTML = followable.map((x) => `<option value="${esc(unitLabel(x))}"></option>`).join("");
function renderMoves() {
  const picked = trailPick ? followable.filter((x) => trailPick.has(x.key)) : [];
  pickedList.innerHTML = picked.map((x) =>
    `<li>${unitIconHTML(x.u)}<span>${esc(x.u.name)} <span class="muted">${esc(x.u.faction)}</span></span><button type="button" data-key="${esc(x.key)}" aria-label="Remove ${esc(x.u.name)}">×</button></li>`).join("");
  movesStatus.textContent = !trailPick ? "Showing the movement of every unit. Search to follow particular units."
    : picked.length ? `Following ${picked.length} unit${picked.length > 1 ? "s" : ""}. Labels show the turns spent at each system.`
    : "No units selected. Search to add one, or view all units.";
  buildTrails();
}
function addUnit(text) {
  const q = text.trim().toLowerCase(); if (!q) return;
  const x = followable.find((f) => unitLabel(f).toLowerCase() === q) || followable.find((f) => unitLabel(f).toLowerCase().includes(q));
  if (!x) { movesStatus.textContent = `No unit matches "${text.trim()}".`; return; }
  if (!trailPick) trailPick = new Set();
  trailPick.add(x.key); unitSearch.value = ""; renderMoves();
}
unitSearch.addEventListener("input", () => { if (followable.some((f) => unitLabel(f) === unitSearch.value)) addUnit(unitSearch.value); });
unitSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addUnit(unitSearch.value); } });
pickedList.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-key]"); if (!b || !trailPick) return;
  trailPick.delete(b.dataset.key); renderMoves();
});
document.getElementById("map-moves-clear").addEventListener("click", () => { trailPick = new Set(); renderMoves(); });
document.getElementById("map-moves-all").addEventListener("click", () => { trailPick = null; renderMoves(); });
renderMoves();

const trailsBtn = document.getElementById("map-trails");
function setTrails(on) {
  trailGroup.visible = on; turnMarks.forEach((m) => { m.visible = on; });
  movesCard.hidden = !on;
  trailsBtn.setAttribute("aria-pressed", String(on));
}
trailsBtn.addEventListener("click", () => setTrails(!trailGroup.visible));

// Show or hide units.
const unitsBtn = document.getElementById("map-units");
let unitsShown = true;
unitsBtn.addEventListener("click", () => {
  unitsShown = !unitsShown;
  unitRows3D.forEach((o) => { o.visible = unitsShown; });
  unitsBtn.textContent = unitsShown ? "Hide Units" : "Show Units";
  unitsBtn.setAttribute("aria-pressed", String(!unitsShown));
});

// Stars: show, dimmed (60% darker), or hidden with names and units dropped to the galactic plane.
let starMode = "show";
const starsBtn = document.getElementById("map-stars");
function applyStarMode() {
  const hide = starMode === "hide", dim = starMode === "dim";
  systems.forEach((s) => {
    if (!s.group) return;
    s.glow.visible = s.core.visible = !hide;
    s.glow.material.opacity = s.baseOpacity * (dim ? 0.4 : 1);
    s.core.material.opacity = dim ? 0.4 : 1;
    if (s.stalk) s.stalk.visible = !hide;
    if (s.ring) s.ring.visible = !hide;
    s.group.position.set(s.pos.x, hide ? 0.12 : s.pos.y, s.pos.z);
  });
  const andor = byHex.get("U19");
  if (hazard && andor) hazard.position.copy(starPoint(andor)).add(new THREE.Vector3(0, hide ? 0.9 : 1.25, 0));
  buildTrails();
  starsBtn.textContent = starMode === "show" ? "Dim Stars" : starMode === "dim" ? "Hide Stars" : "Show Stars";
  starsBtn.setAttribute("aria-pressed", String(starMode !== "show"));
}
starsBtn.addEventListener("click", () => { starMode = starMode === "show" ? "dim" : starMode === "dim" ? "hide" : "show"; applyStarMode(); });

// Starfield on or off.
const skyBtn = document.getElementById("map-starfield");
skyBtn.addEventListener("click", () => { skyGroup.visible = !skyGroup.visible; skyBtn.setAttribute("aria-pressed", String(!skyGroup.visible)); });

// Zoom card: +/- change the distance by 20%; the slider runs from zoomed in (top) to zoomed out.
const zoomSlider = document.getElementById("map-zoom-slider");
function activeView() { return mode === "planet" ? { cam: pcamera, ctl: pcontrols } : { cam: camera, ctl: controls }; }
function setDistance(d) {
  const { cam, ctl } = activeView();
  d = Math.min(ctl.maxDistance, Math.max(ctl.minDistance, d));
  const dir = cam.position.clone().sub(ctl.target).normalize();
  cam.position.copy(ctl.target).add(dir.multiplyScalar(d));
}
function currentDistance() { const { cam, ctl } = activeView(); return cam.position.distanceTo(ctl.target); }
function sliderToDistance(v) { const { ctl } = activeView(); return ctl.maxDistance * Math.pow(ctl.minDistance / ctl.maxDistance, v / 100); }
function distanceToSlider(d) { const { ctl } = activeView(); return 100 * Math.log(d / ctl.maxDistance) / Math.log(ctl.minDistance / ctl.maxDistance); }
document.getElementById("map-zoom-in").addEventListener("click", () => setDistance(currentDistance() * 0.8));
document.getElementById("map-zoom-out").addEventListener("click", () => setDistance(currentDistance() / 0.8));
let sliding = false;
zoomSlider.addEventListener("input", () => { sliding = true; setDistance(sliderToDistance(+zoomSlider.value)); });
zoomSlider.addEventListener("change", () => { sliding = false; });

// ---------------------------------------------------------------- distance tools
let toolMode = null; // "measure" | "range" | null
let route = [];
const HQS = RAW.hq || {};
let hqCode = "";
try { hqCode = localStorage.getItem("verse-hq") || ""; } catch (e) {}
function hqSystem() { const n = HQS[hqCode]; return n ? systems.find((s) => s.system === n) : null; }
const tool = document.getElementById("map-tool"), toolBody = document.getElementById("map-tool-body");
const measureBtn = document.getElementById("map-measure"), rangeBtn = document.getElementById("map-range");
const routeGroup = new THREE.Group(); mapScene.add(routeGroup);
let rangePlane = null;

function onSystemClick(s) {
  if (toolMode && s.system) { toolClick(s); return; }
  select(s);
}
function setTool(m) {
  toolMode = toolMode === m ? null : m;
  measureBtn.setAttribute("aria-pressed", String(toolMode === "measure"));
  rangeBtn.setAttribute("aria-pressed", String(toolMode === "range"));
  app.classList.toggle("tooling", !!toolMode);
  if (toolMode) hideSummary();
  if (toolMode !== "range") clearRange();
  if (toolMode !== "measure") { route = []; drawRoute(); }
  tool.hidden = !toolMode;
  renderTool();
}
measureBtn.addEventListener("click", () => setTool("measure"));
rangeBtn.addEventListener("click", () => setTool("range"));
function toolClick(s) {
  if (toolMode === "measure") { if (route[route.length - 1] !== s) route.push(s); drawRoute(); renderTool(); }
  else if (toolMode === "range") { showRange(s); renderTool(s); }
}

function drawRoute() {
  routeGroup.clear();
  route.forEach((s, i) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; const { x, z } = hexXZ(s.hex); ring.position.set(x, 0.03, z); ring.renderOrder = -1; routeGroup.add(ring);
    if (i === 0) return;
    const a = route[i - 1], leg = legCost(a, s);
    const p = hexXZ(a.hex), q = hexXZ(s.hex);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p.x, 0.04, p.z), new THREE.Vector3(q.x, 0.04, q.z)]),
      new THREE.LineDashedMaterial({ color: leg.ok ? 0xffffff : 0xff9a3c, dashSize: 0.35, gapSize: 0.18 }));
    line.computeLineDistances(); routeGroup.add(line);
  });
  const codes = route.map((s) => s.hex).join(",");
  history.replaceState(null, "", route.length ? "#route=" + codes + (hqCode ? "&hq=" + encodeURIComponent(hqCode) : "") : location.pathname);
}

function renderTool(origin) {
  if (!toolMode) return;
  if (toolMode === "measure") {
    const hqOptions = Object.keys(HQS).map((c) => `<option value="${esc(c)}"${c === hqCode ? " selected" : ""}>${esc(c)}, ${esc(HQS[c])}</option>`).join("");
    const hqPicker = `<label class="hq-pick">Orders issued from <select id="route-hq"><option value="">Choose a faction HQ…</option>${hqOptions}</select></label>`;
    const wire = () => { const sel = document.getElementById("route-hq"); if (sel) sel.onchange = () => { hqCode = sel.value; try { localStorage.setItem("verse-hq", hqCode); } catch (e) {} drawRoute(); renderTool(); }; };
    if (!route.length) { toolBody.innerHTML = hqPicker + "<p>Click the unit's current system, then each stop in turn.</p>"; wire(); return; }
    const legs = route.slice(1).map((s, i) => legCost(route[i], s));
    const hq = hqSystem();
    const orderHexes = hq ? hexDistance(hq.hex, route[0].hex) : 0, order = orderHexes * MSG_DAYS_PER_HEX;
    let total = hq ? order : 0;
    const orderLine = hq
      ? `<p class="order-line">Order from <b>${esc(hq.system)}</b> (${esc(hqCode)} HQ) reaches the unit at ${esc(route[0].system)}: ${orderHexes} hex${orderHexes === 1 ? "" : "es"} × 2.5 = <b>${order} days</b></p>`
      : `<p class="muted">Choose the HQ issuing the order to include the time the order takes to reach the unit.</p>`;
    toolBody.innerHTML = hqPicker + `<p class="route-stops">${route.map((s) => esc(s.system)).join(" → ")}</p>` + orderLine +
      (legs.length ? `<ol class="route-legs">${legs.map((l) => { total += l.days; return `<li class="${l.ok ? "" : "over"}">
        <strong>${esc(l.a.system)} → ${esc(l.b.system)}</strong><br>
        leave ${l.leave} MP + ${l.hexes} hex${l.hexes === 1 ? "" : "es"} + enter ${l.enter} MP = <b>${l.mp} MP, ${l.days} days</b>
        ${l.ok ? "" : `<br><span class="warn">Over the 100-day limit for one turn</span>`}</li>`; }).join("")}</ol>
        <p><b>${hq ? "From order to arrival" : "Travel time"}: ${total} days</b> <span class="muted">(${(total / 100).toFixed(2)} turns)</span></p>` : "<p>Now click the next stop.</p>") +
      `<p class="tool-actions"><button type="button" id="route-undo">Undo stop</button> <button type="button" id="route-clear">Clear</button> <button type="button" id="route-copy">Copy link</button></p>`;
    wire();
    document.getElementById("route-undo").onclick = () => { route.pop(); drawRoute(); renderTool(); };
    document.getElementById("route-clear").onclick = () => { route = []; drawRoute(); renderTool(); };
    document.getElementById("route-copy").onclick = (e) => { navigator.clipboard && navigator.clipboard.writeText(location.href); e.target.textContent = "Link copied"; };
  } else {
    toolBody.innerHTML = origin
      ? `<p><b>Reach from ${esc(origin.system)}</b> in one turn (leaving costs ${systemMP(origin)} MP).</p>
         <ul class="range-key"><li><span class="band b1"></span>Within 25 days</li><li><span class="band b2"></span>26 to 50 days</li><li><span class="band b3"></span>51 to 75 days</li><li><span class="band b4"></span>76 to 100 days</li><li><span class="band hyper"></span>Hex reachable, but entering the system takes it past 100 days</li></ul>
         <p class="muted">Empty hexes show time in hyperspace. Systems include the cost of entering and reaching the colony world.</p>`
      : "<p>Click a star to see where a unit based there can reach in one turn.</p>";
  }
}

function clearRange() {
  if (rangePlane) { mapScene.remove(rangePlane); rangePlane.material.map.dispose(); rangePlane = null; }
  gridPlane.material.map = gridTex.fill; gridPlane.material.needsUpdate = true;
}
// One blue hue that steps in lightness, so the bands read the same with red/green colour blindness.
const RANGE_BANDS = [[25, "#a9cdf6"], [50, "#5f9ee8"], [75, "#2f6cc4"], [100, "#1b4a8a"]];
function showRange(origin) {
  clearRange();
  gridPlane.material.map = gridTex.plain; gridPlane.material.needsUpdate = true; // faction colours give way to range colours
  const c = document.createElement("canvas"); c.width = Math.ceil(W * 48); c.height = Math.ceil(H * 48);
  const g = c.getContext("2d"), P = 48;
  const toPx = (x, z) => [(x - minX) * P, (z - minZ) * P];
  const leave = systemMP(origin);
  const band = (days) => { const b = RANGE_BANDS.find(([d]) => days <= d); return b ? b[1] : null; };
  for (let col = 0; col < COLS; col++) for (let row = 1; row <= ROWS; row++) {
    const code = hexCode(col, row), d = hexDistance(origin.hex, code), s = byHex.get(code);
    const { x, z } = hexXZ(code);
    const pts = Array.from({ length: 6 }, (_, k) => toPx(x + 0.94 * Math.cos((Math.PI / 3) * k), z + 0.94 * Math.sin((Math.PI / 3) * k)));
    g.beginPath(); pts.forEach(([px, pz], i) => (i ? g.lineTo(px, pz) : g.moveTo(px, pz))); g.closePath();
    if (s === origin) { g.strokeStyle = "#f0b429"; g.lineWidth = 5; g.stroke(); continue; }
    const hyper = leave + d;                                  // MP to reach this hex in hyperspace
    const arrive = s && s.system ? hyper + systemMP(s) : hyper; // systems include the cost of entering
    if (arrive <= MP_PER_TURN) { g.globalAlpha = 0.78; g.fillStyle = band(arrive * DAYS_PER_MP); g.fill(); g.globalAlpha = 1; }
    else if (hyper <= MP_PER_TURN) { g.strokeStyle = "rgba(255,255,255,0.75)"; g.lineWidth = 3; g.setLineDash([6, 5]); g.stroke(); g.setLineDash([]); }
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  rangePlane = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  rangePlane.rotation.x = -Math.PI / 2; rangePlane.position.set(minX + W / 2, 0.02, minZ + H / 2); rangePlane.renderOrder = -2;
  mapScene.add(rangePlane);
}

// ---------------------------------------------------------------- toolbar and key
const list = document.getElementById("map-system-list");
systems.filter((s) => s.system).sort((a, b) => a.system.localeCompare(b.system)).forEach((s) => {
  const o = document.createElement("option"); o.value = s.system; list.appendChild(o);
});
const search = document.getElementById("map-search");
function searchGo(exactOnly) {
  const q = search.value.trim().toLowerCase();
  const s = systems.find((x) => x.system.toLowerCase() === q) || (!exactOnly && systems.find((x) => x.hex.toLowerCase() === q));
  if (s && s !== selected) { search.blur(); select(s); }
}
// Picking a suggestion fills the box with an exact name, so go straight there.
search.addEventListener("input", (e) => { if (!e.inputType || e.inputType === "insertReplacementText") searchGo(true); });
search.addEventListener("change", () => searchGo(false));
const boardBtn = document.getElementById("map-board");
const BOARD = { pos: new THREE.Vector3(0, 37, 0.001), target: new THREE.Vector3(0, 0, 0) };
async function setBoard(on) {
  if (mode !== "map" || selected) { if (busy) return; await backToMap(); }
  boardOn = on; boardBtn.setAttribute("aria-pressed", String(on));
  boardBtn.textContent = on ? "3D View" : "Board View";
  controls.enableRotate = !on;
  controls.minPolarAngle = 0;
  await flyMap(on ? BOARD.pos : HOME.pos, on ? BOARD.target : HOME.target, 1100);
}
boardBtn.addEventListener("click", () => setBoard(!boardOn));
const labelsBtn = document.getElementById("map-labels-toggle");
labelsBtn.addEventListener("click", () => { labelsOn = !labelsOn; labelsBtn.setAttribute("aria-pressed", String(labelsOn)); });
document.getElementById("map-reset").addEventListener("click", async () => {
  if (mode !== "map" || selected) { await backToMap(); }
  const view = boardOn ? BOARD : HOME;
  if (!busy) { busy = true; await flyMap(view.pos, view.target, 1200); busy = false; }
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
    if (planetSpin) { planetSpin.planet.rotation.y = t * 0.02; planetSpin.clouds.rotation.y = t * 0.027; }
    sunDirView.copy(sunDir).transformDirection(pcamera.matrixWorldInverse);
    orbiters.forEach((o) => { o.arm.rotation.y = t * o.speed; });
    updateTraffic(t);
    if (unity) unity.wheel.rotation.x = t * 0.08;
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
    // Fleet tokens keep a readable size on screen however far out the camera is.
    updateLabels(camera);
    renderer.render(mapScene, camera);
    labelRenderer.domElement.style.visibility = "visible";
    labelRenderer.render(mapScene, camera);
  }
  app.classList.toggle("closeup", mode !== "map");
  if (!sliding) zoomSlider.value = Math.round(distanceToSlider(currentDistance()));
  requestAnimationFrame(frame);
}
resize();
frame();

// Open a system named in the address (/map/#H6) or a shared route (/map/#route=E18,H6,J8).
const startHex = decodeURIComponent(location.hash.slice(1));
if (startHex.startsWith("route=")) {
  const [routePart, hqPart] = startHex.slice(6).split("&hq=");
  if (hqPart && HQS[hqPart]) hqCode = hqPart;
  const stops = routePart.split(",").map((h) => byHex.get(h.trim().toUpperCase())).filter((s) => s && s.system);
  if (stops.length) { setTool("measure"); route = stops; drawRoute(); renderTool(); }
} else if (startHex && byHex.get(startHex)) setTimeout(() => select(byHex.get(startHex)), 400);
