// First-person viewer for hangout_blockout.glb. Served by serve.py, which pushes rebuild events over /events.
// Coordinates: the JSON plan is (x, y) with z up; the glTF is y-up, so plan (x, y, h) -> world (x, h, -y).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Climber } from './climber.js';

const EYE = 1.7, RADIUS = 0.3, WALK = 2.5, RUN = 5.0, LOOK = 0.0022;
const BODY_HEIGHTS = [0.25, 0.9, 1.5, 1.85];  // collision ray heights above the floor
const world = (x, y, h = 0) => new THREE.Vector3(x, h, -y);
const $ = (id) => document.getElementById(id);
// One app for phones and computers: same card, climber and taps; the only difference is the on-screen joysticks,
// shown on touchscreens (an iPad with a trackpad reports a "fine" primary pointer, so check for any touch).
// After that the last kind of input wins: a finger shows the sticks, a mouse hides them.
// ?dev brings back the wall-editing tools: pointer-lock walking, wall info on hover, plan view (P).
const params = new URLSearchParams(location.search);
const DEV = params.has('dev'), FORCE_TOUCH = params.has('touch');
const SHOW_ALL = params.has('all');  // ?all also shows problems marked "hidden" in problems.json
let TOUCH = !DEV && (FORCE_TOUCH || matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 1);
const TOUCH_LOOK = 0.005, STICK_TURN = 2.4;  // drag: radians per pixel; look stick: radians per second at full tilt
document.body.classList.toggle('app', !DEV);
document.body.classList.toggle('touch', TOUCH);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- renderer, cameras, lights ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const labelRenderer = new CSS2DRenderer({ element: $('labels') });
labelRenderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1f24);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.12;

const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 200);
function fitCamera() {  // a portrait phone gets a taller field of view, or it sees a narrow slot
  camera.aspect = innerWidth / innerHeight;
  camera.fov = camera.aspect < 1 ? 90 : 72;
  camera.updateProjectionMatrix();
}
fitCamera();
camera.rotation.order = 'YXZ';
const planCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
planCam.up.set(0, 0, -1);  // plan +y (north) at the top of the screen

// Overhead light + sky/ground hemisphere: down-facing overhang undersides get the darker ground tone
// and the overhead key throws their shadow onto the wall below, so the kinks read clearly.
scene.add(new THREE.HemisphereLight(0xf4f6ff, 0x2a2622, 0.9));
const key = new THREE.DirectionalLight(0xfff4e6, 1.8);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
scene.add(fill, fill.target);

// ---------- state ----------
let layout = null, model = null, overlay = null, playerMarker = null;
let problems = [], houseRules = '', holdGroup = null, markerGroup = null, frames = new Map(), sel = -1, step = 0;
let pickables = [], colliders = [], info = new Map();  // mesh -> {kind, wall, panel, ...}
const player = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
const keys = new Set();
let planMode = false, locked = false, hovered = null, pinned = null;
const mouse = new THREE.Vector2(), ray = new THREE.Raycaster();

// ---------- layout helpers ----------
function wallStats(w) {
  const H = layout.wall_height_m, base = w.base_m || 0;
  const total = w.profile.reduce((s, [r]) => s + r, 0), scale = (H - base) / total;
  let z = base, off = 0;
  const panels = w.profile.map(([rise, ang]) => {
    const r = rise * scale, o = Math.tan(ang * Math.PI / 180) * r;
    const p = { z0: z, z1: z + r, ang, off0: off, off1: off + o };
    z += r; off += o; return p;
  });
  const [ax, ay] = w.from, [bx, by] = w.to, len = Math.hypot(bx - ax, by - ay);
  const d = [(bx - ax) / len, (by - ay) / len], n = [d[1], -d[0]];  // n = climbing side (right of from->to)
  const offs = [0, ...panels.map((p) => p.off1)];
  return { total, base, scale, panels, len, d, n, overhang: off, offMin: Math.min(...offs), offMax: Math.max(...offs) };
}

function classify(name) {
  for (const w of layout.walls) {
    if (!name.startsWith(w.id + '_')) continue;
    const rest = name.slice(w.id.length + 1), m = /^p(\d+)/.exec(rest);
    return { kind: m ? 'panel' : 'cap', wall: w, panel: m ? +m[1] : null };
  }
  if (name.startsWith('volume')) return { kind: 'volume' };
  if (name.startsWith('block_')) return { kind: 'block', block: (layout.blocks || []).find((b) => name === 'block_' + b.id) };
  if (name.startsWith('mezz')) return { kind: 'mezz' };
  if (name.startsWith('marker_')) return { kind: 'opening', opening: (layout.openings || []).find((o) => name.startsWith('marker_' + o.id)) };
  if (name.startsWith('mats')) return { kind: 'floor' };
  return { kind: 'other' };
}

// ---------- loading / hot reload ----------
async function load() {
  const v = Date.now();
  const [json, gltf, probs] = await Promise.all([
    fetch(`hangout_layout.json?v=${v}`).then((r) => r.json()),
    new GLTFLoader().loadAsync(`hangout_blockout.glb?v=${v}`),
    fetchProblems(),
  ]);
  layout = json;
  for (const obj of [model, overlay, playerMarker]) if (obj) { scene.remove(obj); dispose(obj); }
  hovered = pinned = null;
  pickables = []; colliders = []; info = new Map();

  model = gltf.scene;
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 });
  const meshes = [];
  model.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const inf = classify(mesh.name || mesh.parent?.name || '');
    info.set(mesh, inf);
    mesh.material = mesh.material.clone();
    Object.assign(mesh.material, { metalness: 0, side: THREE.DoubleSide });
    mesh.castShadow = mesh.receiveShadow = true;
    if (inf.kind !== 'floor') {
      pickables.push(mesh);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), edgeMat));
    }
    if (!['floor', 'opening', 'mezz'].includes(inf.kind)) colliders.push(mesh);
  }
  scene.add(model);

  const { width_x: W, depth_y: D } = layout.room;
  const c = world(W / 2, D / 2);
  key.target.position.copy(c);
  key.position.copy(c).add(new THREE.Vector3(3, 14, 4));
  const s = Math.max(W, D) * 0.75;
  Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 40 });
  key.shadow.camera.updateProjectionMatrix();
  fill.target.position.copy(c);
  fill.position.copy(c).add(new THREE.Vector3(-6, 5, -5));

  buildOverlay();
  fitPlanCam();
  setProblems(probs);
  setPlanMode(planMode);
}

function dispose(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material ?? [])) { m.map?.dispose(); m.dispose(); }
  });
}

function lookAt(target) {
  const dir = target.clone().sub(player.pos);
  player.yaw = Math.atan2(-dir.x, -dir.z);
  player.pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
}

function spawn() {
  const { position: p, look_at: t } = layout.spawn;  // [plan x, height, plan y]
  player.pos.copy(world(p[0], p[2], EYE));
  lookAt(world(t[0], t[2], t[1]));
}

// ---------- problems: holds + beta from problems.json (drawn here, not baked into the model) ----------
const LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK'];  // hands, feet, knees (kneebars)
const LIMB_COLOUR = { LH: '#ffc04d', RH: '#ff6b9a', LF: '#62e3c8', RF: '#6bb2ff', LK: '#c9a0ff', RK: '#a0b4ff' };
const LIMB_DIR = { LH: [-1, 1], RH: [1, 1], LF: [-1, -1], RF: [1, -1], LK: [-1, 0], RK: [1, 0] };  // marker offset, so limbs sharing a hold don't overlap
// Default hold size [across, up the face, out from the face] in metres; any hold can override with size_m.
const HOLD_SIZE = { jug: [0.18, 0.11, 0.09], crimp: [0.13, 0.03, 0.035], sloper: [0.18, 0.13, 0.055], pinch: [0.06, 0.16, 0.07],
  pocket: [0.09, 0.08, 0.05], foot: [0.06, 0.045, 0.03], volume: [0.5, 0.5, 0.2], arete: [0.05, 0.04, 0.05], spot: [0.05, 0.05, 0.02] };
const FACING = { up: 0, left: Math.PI / 2, down: Math.PI, right: -Math.PI / 2 };  // rotation about the face normal
const holdSize = (h) => h.size_m || HOLD_SIZE[h.type] || HOLD_SIZE.foot;

async function fetchProblems() {
  const r = await fetch(`problems.json?v=${Date.now()}`);
  if (r.status === 404) return { problems: [] };
  return r.json();
}

// Frame on a wall face at (along, height): x = along the wall (the climber's right), y = up the face, z = out of the face.
function wallFrame(w, along, h) {
  const st = wallStats(w), p = st.panels.find((q) => h <= q.z1 + 1e-6) || st.panels.at(-1);
  const a = p.ang * Math.PI / 180, off = p.off0 + (h - p.z0) * Math.tan(a);
  const [dx, dy] = st.d, [nx, ny] = st.n;
  const x = world(dx, dy), z = world(nx * Math.cos(a), ny * Math.cos(a), -Math.sin(a));
  return { pos: world(w.from[0] + dx * along + nx * off, w.from[1] + dy * along + ny * off, h), x, y: new THREE.Vector3().crossVectors(z, x), z };
}

// Body positions in problems.json: [along, height, out] = `out` metres straight out (level) from the wall's face at
// that height.
function wallPoint(id, [along, h, out]) {
  const w = layout.walls.find((q) => q.id === id);
  if (!w) return null;
  const f = wallFrame(w, along, h), n = new THREE.Vector3(f.z.x, 0, f.z.z);
  return n.lengthSq() > 1e-6 ? f.pos.addScaledVector(n.normalize(), out) : f.pos;
}

function holdFrame(h, p) {
  if (h.at) {
    const [nx, ny, nz = 0] = h.normal, z = world(nx, ny, nz).normalize();
    // y = "up" for the hold; on a roof (normal pointing down) that is the direction of travel, h.up in plan
    const y = Math.abs(z.y) > 0.9 ? world(...(h.up || [0, 1])) : new THREE.Vector3(0, 1, 0);
    y.addScaledVector(z, -y.dot(z)).normalize();
    return { pos: world(h.at[0], h.at[1], h.at[2]), x: new THREE.Vector3().crossVectors(y, z), y, z };
  }
  const id = h.wall || p.wall, w = layout.walls.find((q) => q.id === id);
  if (!w) throw new Error(`${p.id} ${h.id}: no wall "${id}"`);
  return wallFrame(w, h.along_m, h.height_m);
}

function volumeGeometry() {  // triangle on the face, point down, apex out from the face; unit size
  const v = [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0, -0.5, 0], [0, 1 / 6, 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]].flat().flatMap((i) => v[i]), 3));
  g.computeVertexNormals();
  return g;
}

function holdMesh(h, colour, f) {
  const tape = h.type === 'arete' && h.role;  // arête/spot are body positions; only a start/finish arête gets a tape mark
  if ((h.type === 'arete' || h.type === 'spot') && !tape) return null;
  let geo;
  if (h.type === 'volume') geo = volumeGeometry();
  else if (tape) geo = new THREE.BoxGeometry(1, 1, 1);
  else if (h.type === 'crimp' || h.type === 'pinch') geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
  else geo = new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2).scale(1, 1, 2);
  geo.scale(...holdSize(h));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.55, metalness: 0, flatShading: h.type === 'volume' }));
  mesh.position.copy(f.pos).addScaledVector(f.z, 0.004);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f.x, f.y, f.z));
  mesh.rotateZ(FACING[h.facing] || 0);
  mesh.castShadow = true;
  return mesh;
}

function textSprite(text, bg, size, opacity = 1) {
  const c = document.createElement('canvas'), g = c.getContext('2d'), font = '700 38px ui-monospace, Consolas, monospace';
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 22, H = 52;
  c.width = w; c.height = H;
  g.font = font; g.fillStyle = bg;
  g.beginPath(); g.roundRect(0, 0, w, H, 12); g.fill();
  g.fillStyle = '#15161a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, H / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, toneMapped: false, transparent: true, opacity }));
  s.scale.set(size * w / H, size, 1);
  return s;
}

function setProblems(data) {
  const id = problems[sel]?.id;
  problems = (data.problems || []).filter((p) => SHOW_ALL || !p.hidden);
  houseRules = data.house_rules || '';
  sel = problems.findIndex((p) => p.id === id);
  if (holdGroup) { scene.remove(holdGroup); dispose(holdGroup); }
  for (const [mesh, inf] of info) if (inf.kind === 'hold') info.delete(mesh);
  pickables = pickables.filter((m) => info.has(m));
  holdGroup = new THREE.Group();
  frames = new Map();
  const errors = [];
  for (const p of problems) {
    p._group = new THREE.Group();
    p._holds = new Map(p.holds.map((h) => [h.id, h]));
    for (const h of p.holds) {
      try { frames.set(h, holdFrame(h, p)); } catch (e) { errors.push(e.message); continue; }
      const mesh = holdMesh(h, p.colour, frames.get(h));
      if (!mesh) continue;
      info.set(mesh, { kind: 'hold', hold: h, problem: p });
      pickables.push(mesh);
      p._group.add(mesh);
    }
    p.moves.forEach((m, i) => LIMBS.forEach((l) => { if (m[l] && !p._holds.has(m[l])) errors.push(`${p.id} move ${i}: ${l} uses unknown hold "${m[l]}"`); }));
    holdGroup.add(p._group);
  }
  scene.add(holdGroup);
  if (errors.length) toast('problems.json: ' + errors[0], true, 0);
  step = Math.min(step, (problems[sel]?.moves.length || 1) - 1);
  applySelection();
}

function selectProblem(i) { sel = i; step = 0; applySelection(); }
function setStep(i) {
  const p = problems[sel];
  if (!p) return;
  step = THREE.MathUtils.clamp(i, 0, p.moves.length - 1);
  climbTo(step);
  updateProblemUI();
}

// Dim the other problems; mark start/finish holds and put the climber on the selected one's start.
function applySelection() {
  problems.forEach((p, i) => p._group.traverse((o) => {
    if (!o.isMesh) return;
    const on = sel < 0 || sel === i;
    Object.assign(o.material, { transparent: !on, opacity: on ? 1 : 0.18, depthWrite: on });
  }));
  if (markerGroup) { scene.remove(markerGroup); dispose(markerGroup); }
  markerGroup = new THREE.Group();
  scene.add(markerGroup);
  const p = problems[sel];
  for (const h of p?.holds || []) {
    const f = frames.get(h);
    if (!h.role || !f) continue;
    const [, sh, sd] = holdSize(h), up = h.role === 'start' ? -1 : 1;
    const t = textSprite(h.role === 'start' ? 'S' : 'TOP', p.colour, 0.07 * (DEV ? 1 : 1.6));
    t.position.copy(f.pos).addScaledVector(f.y, up * (Math.max(0.08, sh / 2) + 0.06)).addScaledVector(f.z, sd + 0.05);
    markerGroup.add(t);
  }
  buildClimber(p);
  updateProblemUI();
}

// ---------- the climber (climber.js) acts out the selected problem ----------
let climber = null;
function buildClimber(p) {
  if (climber) { scene.remove(climber.group); climber.dispose(); climber = null; }
  if (!p) return;
  climber = new Climber({ problem: p, step, frame: (h) => frames.get(h), size: holdSize, colours: LIMB_COLOUR,
    place: (v, wall) => wallPoint(wall || p.wall, v),
    scale: DEV ? 1 : 1.25, dotSize: DEV ? 7 : 9 });
  scene.add(climber.group);
}
const climbTo = (i) => climber?.goTo(i);
const animateClimber = (dt) => climber?.update(dt);

let listOpen = DEV;  // "Rules and all moves": collapsed, except in the ?dev tools
let cardMin = false;  // card folded down to the dropdown and prev/next (remembered per browser)
try { cardMin = localStorage.getItem('hangout.cardMin') === '1'; } catch {}
function setCardMin(on) {
  cardMin = on;
  try { localStorage.setItem('hangout.cardMin', on ? '1' : '0'); } catch {}
  updateProblemUI();
}
function updateProblemUI() {
  const el = $('problem'), p = problems[sel];
  el.style.display = problems.length ? 'block' : 'none';
  const sw = (c) => `<span class="sw" style="background:${esc(c)}"></span>`;
  const tags = (m) => m.technique?.length
    ? `<div class="tags">${(m.dynamic ? ['dynamic', ...m.technique] : m.technique).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';
  const pick = '<div class="pbar"><select data-act="pick" aria-label="Problem"><option value="-1">Choose a problem…</option>' +
    problems.map((q, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(q.name)} · ${esc(q.grade)} · ${esc(q.wall)}</option>`).join('') +
    '</select>' + (p ? '<button class="btn" data-act="go">View</button>' : '') +
    `<button class="btn fold" data-act="fold" aria-label="${cardMin ? 'Show details' : 'Hide details'}">${cardMin ? '▾' : '▴'}</button></div>`;
  const last = p ? p.moves.length - 1 : 0, mnum = step ? `Move ${step} of ${last}` : 'Start';
  const nav = (short) => `<div class="nav"><button class="btn" data-act="prev"${step ? '' : ' disabled'}>${short ? '◀' : '◀ Prev'}</button>` +
    (short ? `<span class="mnum">${mnum}</span>` : '') + `<button class="btn" data-act="next"${step < last ? '' : ' disabled'}>${short ? '▶' : 'Next ▶'}</button></div>`;
  if (cardMin) { el.innerHTML = pick + (p ? nav(true) : ''); return; }
  if (!p) {
    el.innerHTML = pick + (!DEV ? '' : problems.map((q, i) =>
      `<div class="prow" data-problem="${i}">${sw(q.colour)}${esc(q.name)} <b>${esc(q.grade)}</b> <span class="dim">${esc(q.where || q.wall)}</span></div>`).join('')) +
      (houseRules ? `<div class="foot">${esc(houseRules)}</div>` : '') + (!DEV ? '' : '<div class="foot"><kbd>N</kbd> pick a problem</div>');
    return;
  }
  const m = p.moves[step];
  el.innerHTML = pick + `<h2>${sw(p.colour)}${esc(p.name)} <span class="grade">${esc(p.grade)}</span></h2>` +
    `<div class="dim">${esc(p.where || p.wall)} · ${esc((p.style || []).join(', '))}</div>` +
    `<div class="cur"><div class="mnum">${mnum}</div>${esc(m.text)}${tags(m)}</div>` + nav(false) +
    `<details class="more"${listOpen ? ' open' : ''}><summary>Rules and all moves</summary>` +
    `<div class="rules">${esc(p.rules)}${houseRules ? ` <span class="dim">${esc(houseRules)}</span>` : ''}</div>` +
    (p.notes ? `<details><summary>Setter's notes</summary>${esc(p.notes)}</details>` : '') +
    '<ol start="0">' + p.moves.map((q, i) => `<li data-step="${i}" class="${i === step ? 'on' : ''}">${esc(q.text)}${tags(q)}</li>`).join('') + '</ol></details>' +
    (!DEV ? '' : '<div class="foot"><kbd>[</kbd> <kbd>]</kbd> step moves · <kbd>G</kbd> go there · <kbd>N</kbd> next problem</div>');
  el.querySelector('details.more').addEventListener('toggle', (e) => { listOpen = e.target.open; });
  if (listOpen) el.querySelector('li.on')?.scrollIntoView({ block: 'nearest' });
}

// Stand a couple of metres back from the selected problem, looking at it (or use the problem's own view).
function goToProblem() {
  const p = problems[sel], w = p && layout.walls.find((q) => q.id === p.wall);
  if (p?.view) {
    const { position: a, look_at: t } = p.view;  // [plan x, height, plan y], like spawn
    player.pos.copy(world(a[0], a[2], EYE));
    lookAt(world(t[0], t[2], t[1]));
    if (!DEV) player.pitch += 0.12;  // the problem card covers the top of the screen: put the climb lower
    return;
  }
  const pts = w ? p.holds.filter((h) => !h.at && (h.wall || p.wall) === p.wall && frames.has(h)).map((h) => frames.get(h).pos) : [];
  if (!pts.length) return;
  const c = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(pts.length);
  const st = wallStats(w), right = world(...st.d), out = world(...st.n), base = world(...w.from);
  const reach = Math.max(...pts.map((q) => q.clone().sub(base).dot(out)));  // furthest hold out from the base (roofs)
  player.pos.set(c.x, EYE, c.z).addScaledVector(out, reach - c.clone().sub(base).dot(out) + 2.4);
  // on desktop aim a little right: the problem panel covers the right of the screen
  lookAt(new THREE.Vector3(c.x, Math.max(1.9, c.y), c.z).addScaledVector(right, DEV ? 0.8 : 0));
  if (!DEV) player.pitch += 0.12;
}

// ---------- plan view overlay ----------
function label(text, cls, pos) {
  const el = document.createElement('div');
  el.className = 'label ' + cls; el.textContent = text;
  const o = new CSS2DObject(el); o.position.copy(pos); return o;
}

// Flat quad between plan points (lines are 1 px in WebGL, so the plan uses ribbons/fills instead).
function quad(pts, Y, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y]) => world(x, y, Y)));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false, side: THREE.DoubleSide, toneMapped: false }));
  m.renderOrder = 10; return m;
}
function ribbon([ax, ay], [bx, by], width, Y, color, opacity = 1) {
  const l = Math.hypot(bx - ax, by - ay), px = -(by - ay) / l * width / 2, py = (bx - ax) / l * width / 2;
  return quad([[ax + px, ay + py], [bx + px, by + py], [bx - px, by - py], [ax - px, ay - py]], Y, color, opacity);
}

function buildOverlay() {
  overlay = new THREE.Group();
  const Y = 6, BASE = 0xd81b74, TOP = 0xffb000;
  for (const w of layout.walls) {
    const st = wallStats(w), [ax, ay] = w.from, [bx, by] = w.to, [nx, ny] = st.n, o = st.overhang;
    const ta = [ax + nx * o, ay + ny * o], tb = [bx + nx * o, by + ny * o];
    overlay.add(quad([w.from, w.to, tb, ta], Y, TOP, 0.28));         // footprint of the overhang
    overlay.add(ribbon(ta, tb, 0.05, Y, TOP));                          // top edge
    overlay.add(ribbon(w.from, w.to, 0.12, Y, BASE));                   // base line on the floor
    const mx = (ax + bx) / 2, my = (ay + by) / 2, k = Math.max(o, 0) + 0.45;
    overlay.add(label(w.id, 'wall', world(mx + nx * k, my + ny * k, Y)));
  }
  for (const b of layout.blocks || []) {
    const [x0, x1] = b.x, [y0, y1] = b.y;
    overlay.add(quad([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], Y - 0.1, 0x8a8d96, 0.35));
    overlay.add(label(b.id, 'mezz', world((x0 + x1) / 2, (y0 + y1) / 2, Y)));
  }
  for (const op of layout.openings || []) overlay.add(label(op.id, 'opening', world(op.at[0], op.at[1], Y)));
  const mz = layout.mezzanine;
  if (mz) {
    const [x0, x1] = mz.x, [y0, y1] = mz.y;
    for (const [p, q] of [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]]) overlay.add(ribbon(p, q, 0.04, Y, 0x5a5d66));
    overlay.add(label('mezzanine', 'mezz', world((x0 + x1) / 2, (y0 + y1) / 2 - 0.35, Y)));
  }
  scene.add(overlay);

  const tri = new THREE.Shape([new THREE.Vector2(0, 0.45), new THREE.Vector2(-0.25, -0.25), new THREE.Vector2(0.25, -0.25)]);
  playerMarker = new THREE.Mesh(new THREE.ShapeGeometry(tri), new THREE.MeshBasicMaterial({ color: 0x4cc3ff, depthTest: false }));
  playerMarker.renderOrder = 11;
  scene.add(playerMarker);
}

function fitPlanCam() {
  if (!layout) return;
  const { width_x: W, depth_y: D } = layout.room, m = 1.5, a = innerWidth / innerHeight;
  let hw = W / 2 + m, hh = D / 2 + m;
  if (hw / hh > a) hh = hw / a; else hw = hh * a;
  Object.assign(planCam, { left: -hw, right: hw, top: hh, bottom: -hh });
  planCam.updateProjectionMatrix();
  planCam.position.copy(world(W / 2, D / 2, 50));
  planCam.lookAt(world(W / 2, D / 2, 0));
}

function setPlanMode(on) {
  planMode = on;
  document.body.classList.toggle('plan', on);
  if (overlay) overlay.visible = playerMarker.visible = on;
  $('labels').style.display = on ? '' : 'none';
  for (const [mesh, inf] of info) if (inf.kind === 'mezz' || inf.kind === 'block') {  // let the plan see underneath
    mesh.material.transparent = on; mesh.material.opacity = on ? 0.25 : 1; mesh.material.depthWrite = !on;
  }
  hovered = null;
  updateOverlayUI();
  updateLockUI();
}

// ---------- movement + collision ----------
const rayDirs = Array.from({ length: 8 }, (_, k) => new THREE.Vector3(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)));
const origin = new THREE.Vector3();
function collides(x, z) {
  ray.far = RADIUS;
  for (const h of BODY_HEIGHTS) for (const d of rayDirs) {
    ray.set(origin.set(x, h, z), d);
    if (ray.intersectObjects(colliders, false).length) return true;
  }
  return false;
}

const joy = { x: 0, y: 0 }, aim = { x: 0, y: 0 };  // on-screen sticks, -1..1 (y down): walk, look
function move(dt) {
  let f = -joy.y, r = joy.x;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  const len = Math.hypot(f, r);
  if (len < 0.05) return;
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK) * dt * Math.min(1, len) / len;
  const s = Math.sin(player.yaw), c = Math.cos(player.yaw);
  const dx = (-s * f + c * r) * speed, dz = (-c * f - s * r) * speed;
  const { x, z } = player.pos, { width_x: W, depth_y: D } = layout.room;
  const clampX = (v) => THREE.MathUtils.clamp(v, RADIUS, W - RADIUS), clampZ = (v) => THREE.MathUtils.clamp(v, -D + RADIUS, -RADIUS);
  if (collides(x, z)) { player.pos.x = clampX(x + dx); player.pos.z = clampZ(z + dz); return; }  // stuck: let them walk out
  for (const [tx, tz] of [[x + dx, z + dz], [x + dx, z], [x, z + dz]]) {  // full move, then slide along each axis
    const nx = clampX(tx), nz = clampZ(tz);
    if (!collides(nx, nz)) { player.pos.x = nx; player.pos.z = nz; return; }
  }
}

// ---------- picking + info panel ----------
function pickFirstPerson(ndcX = 0, ndcY = 0) {  // screen centre by default; a tap passes its own point
  ray.far = 40;
  ray.setFromCamera(mouse.set(ndcX, ndcY), camera);
  const hit = ray.intersectObjects(pickables, false)[0];
  return hit ? info.get(hit.object) : null;
}

function pickPlan(clientX, clientY) {
  mouse.set(clientX / innerWidth * 2 - 1, -clientY / innerHeight * 2 + 1);
  const p = new THREE.Vector3(mouse.x, mouse.y, 0).unproject(planCam), px = p.x, py = -p.z;
  let best = null, bestD = 0.4;
  for (const w of layout.walls) {
    const st = wallStats(w), qx = px - w.from[0], qy = py - w.from[1];
    const s = qx * st.d[0] + qy * st.d[1], t = qx * st.n[0] + qy * st.n[1];
    const ds = Math.max(0, -s, s - st.len), dt = Math.max(0, st.offMin - t, t - st.offMax);
    const dist = Math.hypot(ds, dt);
    if (dist < bestD) { bestD = dist; best = { kind: 'wall', wall: w, panel: null }; }
  }
  return best;
}

const sameTarget = (a, b) => a === b || (a?.wall && b?.wall && a.wall === b.wall && a.kind === b.kind && a.panel === b.panel);

function setHovered(inf) {
  if (sameTarget(inf, hovered)) return;
  hovered = inf;
  updateOverlayUI();
}

function updateOverlayUI() {
  const target = hovered || pinned;
  // highlight: the whole wall faintly, the targeted panel strongly
  for (const [mesh, inf] of info) {
    let e = 0;
    if (target?.wall && inf.wall === target.wall) e = (target.panel != null && inf.panel === target.panel) ? 0.32 : 0.1;
    else if (target && !target.wall && (inf === target || (target.kind === 'mezz' && inf.kind === 'mezz'))) e = 0.25;
    mesh.material.emissive.setRGB(e, e * 0.75, e * 0.3);
  }
  $('info').style.display = target ? 'block' : 'none';
  if (target) $('info').innerHTML = (target === pinned && !hovered ? '<span class="pin">pinned · click empty space to clear</span>' : '') + infoHTML(target);
}

function infoHTML(t) {
  if (t.wall) {
    const w = t.wall, st = wallStats(w);
    const kind = (a) => a === 0 ? 'vertical' : a > 0 ? 'overhang' : 'slab';
    const rows = st.panels.map((p, i) => `<tr class="${i === t.panel ? 'on' : ''}"><td>Panel ${i + 1}</td>` +
      `<td class="num">${p.z0.toFixed(2)}–${p.z1.toFixed(2)} m</td><td class="num">${p.ang}°</td><td>${kind(p.ang)}</td></tr>`).join('');
    const span = layout.wall_height_m - st.base;
    const scaled = Math.abs(st.total - span) > 0.01
      ? `<br>Profile rises sum to ${st.total.toFixed(2)} m; scaled to fit ${span.toFixed(2)} m.` : '';
    const where = t.kind === 'cap' ? ' · top cap' : t.panel != null ? ` · panel ${t.panel + 1}` : '';
    return `<h2>${esc(w.id)}<span style="font-weight:400;color:var(--dim);font-size:13px">${where}</span></h2>` +
      `<div class="notes">${esc(w.notes) || '<i>no notes</i>'}</div><table>${rows}</table>` +
      `<div class="foot">Length ${st.len.toFixed(2)} m · top sits ${st.overhang.toFixed(2)} m ${st.overhang >= 0 ? 'out over' : 'back from'} the base${scaled}</div>`;
  }
  if (t.kind === 'hold') {
    const { hold: h, problem: p } = t;
    const used = p.moves.flatMap((m, i) => LIMBS.filter((l) => m[l] === h.id && p.moves[i - 1]?.[l] !== h.id).map((l) => `${i ? 'move ' + i : 'start'} ${l}`));
    const where = h.at ? `plan (${h.at[0]}, ${h.at[1]}), ${h.at[2]} m up` : `${esc(h.wall || p.wall)} · ${h.along_m} m along, ${h.height_m} m up`;
    const row = (k, v) => v ? `<tr><td>${k}</td><td>${v}</td></tr>` : '';
    return `<h2>${esc(h.id)}<span style="font-weight:400;color:var(--dim);font-size:13px"> · ${esc(p.name)} (${esc(p.grade)})</span></h2>` +
      `<div class="notes">${esc(h.notes)}</div><table>${row('Type', esc([h.type, h.grip].filter(Boolean).join(', ')))}` +
      `${row('Edge faces', esc(h.facing))}${row('Role', esc(h.role))}${row('Position', where)}${row('Used', esc(used.join(' · ')))}</table>`;
  }
  if (t.kind === 'block' && t.block) return `<h2>${esc(t.block.id)}</h2><div class="notes">${esc(t.block.notes)}</div>`;
  if (t.kind === 'volume') return `<h2>Volume</h2><div class="notes">${esc(layout.volumes?.notes)}</div>`;
  if (t.kind === 'mezz') { const m = layout.mezzanine; return `<h2>Mezzanine</h2><div class="notes">Floor at ${m.floor_height_m} m, railing ${m.railing_height_m} m</div>`; }
  if (t.kind === 'opening' && t.opening) return `<h2>${esc(t.opening.id)}</h2><div class="notes">${esc(t.opening.notes)}</div>`;
  return `<h2>${esc(t.kind)}</h2>`;
}

// ---------- input ----------
function requestLock() {
  if (!DEV) return;
  const p = renderer.domElement.requestPointerLock();
  p?.catch?.(() => {});  // Chrome refuses for ~1 s after Esc; the overlay stays up and a click retries
}
$('overlay').addEventListener('click', requestLock);
function setTouch(on) {  // show the joysticks for fingers, hide them for a mouse
  if (DEV || on === TOUCH || (FORCE_TOUCH && !on)) return;
  TOUCH = on;
  document.body.classList.toggle('touch', on);
  joy.x = joy.y = aim.x = aim.y = 0;
  if (on) toast(HINT_TOUCH, false, 5000);
}
const HINT_TOUCH = 'Left stick walks · right stick looks · tap a hold to open its problem';
const HINT_MOUSE = 'Drag to look · WASD or arrows to walk · click a hold to open its problem';
addEventListener('pointerdown', (e) => setTouch(e.pointerType !== 'mouse'), true);
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === renderer.domElement;
  updateLockUI();
});
function updateLockUI() { $('overlay').style.display = locked || planMode || !layout || !DEV ? 'none' : 'flex'; }

renderer.domElement.addEventListener('click', (e) => {  // ?dev tools only
  if (!DEV) return;
  if (planMode) { pinned = pickPlan(e.clientX, e.clientY); updateOverlayUI(); }
  else if (locked) { pinned = pickFirstPerson(); updateOverlayUI(); }
});
addEventListener('mousemove', (e) => {
  if (locked) {
    player.yaw -= e.movementX * LOOK;
    player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * LOOK, -1.5, 1.5);
  } else if (planMode && layout) setHovered(pickPlan(e.clientX, e.clientY));
});
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && layout && DEV) {
    setPlanMode(!planMode);
    if (planMode) document.exitPointerLock(); else requestLock();
  } else if (e.code === 'KeyR' && layout) spawn();
  else if (e.code === 'KeyN' && layout) selectProblem(sel + 1 >= problems.length ? -1 : sel + 1);
  else if (e.code === 'BracketRight') setStep(step + 1);
  else if (e.code === 'BracketLeft') setStep(step - 1);
  else if (e.code === 'KeyG' && layout) goToProblem();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
$('problem').addEventListener('click', (e) => {  // touch, or the mouse in plan view
  const act = e.target.closest('[data-act]')?.dataset.act, s = e.target.closest('[data-step]'), q = e.target.closest('[data-problem]');
  if (act === 'prev') setStep(step - 1);
  else if (act === 'next') setStep(step + 1);
  else if (act === 'go') goToProblem();
  else if (act === 'fold') setCardMin(!cardMin);
  else if (s) setStep(+s.dataset.step);
  else if (q) { selectProblem(+q.dataset.problem); goToProblem(); }
});
$('problem').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'pick') return;
  selectProblem(+e.target.value); goToProblem();
  e.target.blur();  // so the keyboard shortcuts don't change the dropdown
});

// ---------- sticks (touch), drag to look and tap/click a hold to open its problem (finger or mouse) ----------
function stick(el, out) {
  const knob = el.firstElementChild;
  let id = null;
  const set = (e) => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    out.x = dx; out.y = dy;
    knob.style.transform = `translate(${dx * R * 0.55}px, ${dy * R * 0.55}px)`;
  };
  el.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    try { el.setPointerCapture(id); } catch {}  // keep tracking if the finger slides off the stick
    set(e);
  });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
  for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, (e) => {
    if (e.pointerId !== id) return;
    id = null; out.x = out.y = 0; knob.style.transform = '';
  });
}
stick($('joy'), joy);
stick($('aim'), aim);
function turn(dt) {  // look stick: squared response so small tilts aim finely
  const k = STICK_TURN * dt, c = (v) => Math.sign(v) * v * v;
  player.yaw -= c(aim.x) * k;  // push right turns right, push up looks up
  player.pitch = THREE.MathUtils.clamp(player.pitch - c(aim.y) * k * 0.7, -1.5, 1.5);
}

let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (DEV || drag || e.button > 0) return;
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
});
addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  // inverted on purpose (owner's choice): drag the scene, so dragging right looks left and dragging up looks down
  player.yaw += (e.clientX - drag.x) * TOUCH_LOOK;
  player.pitch = THREE.MathUtils.clamp(player.pitch + (e.clientY - drag.y) * TOUCH_LOOK, -1.5, 1.5);
  drag.x = e.clientX; drag.y = e.clientY;
});
for (const t of ['pointerup', 'pointercancel']) addEventListener(t, (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const tap = e.type === 'pointerup' && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 10 && performance.now() - drag.t < 400;
  drag = null;
  if (!tap || !layout) return;
  const hit = pickFirstPerson(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1);
  if (hit?.kind === 'hold') openHold(hit);  // walls and everything else ignore taps and clicks
});

// A tapped hold opens its problem at the move that first uses it; another problem's hold also takes you there.
function openHold({ hold, problem }) {
  const i = problems.indexOf(problem);
  if (i !== sel) { selectProblem(i); goToProblem(); return; }
  const first = problem.moves.findIndex((m) => LIMBS.some((l) => m[l] === hold.id));
  if (first >= 0) setStep(first);
}
addEventListener('blur', () => keys.clear());
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight);
  fitCamera(); fitPlanCam();
});

// ---------- live reload from serve.py ----------
let toastTimer;
function toast(msg, err = false, ms = 2500) {
  const t = $('toast'); clearTimeout(toastTimer);
  t.textContent = msg; t.className = 'hud' + (err ? ' err' : ''); t.style.display = 'block';
  if (ms) toastTimer = setTimeout(() => (t.style.display = 'none'), ms);
}
// only from serve.py on this machine; a static host (GitHub Pages) has no /events
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
if (LOCAL) new EventSource('/events').onmessage = async (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'building') toast('Layout changed, rebuilding…', false, 0);
  else if (msg.type === 'error') toast('Build failed: ' + msg.message, true, 0);
  else if (msg.type === 'model') {
    try { await load(); toast('Model reloaded'); } catch (err) { toast('Reload failed: ' + err.message, true, 0); }
  } else if (msg.type === 'problems' && layout) {
    try { setProblems(await fetchProblems()); toast('Problems reloaded'); } catch (err) { toast('problems.json: ' + err.message, true, 0); }
  } else if (msg.type === 'page') {
    sessionStorage.setItem('pose', JSON.stringify({ ...player, pos: player.pos.toArray(), planMode }));
    location.reload();
  }
};

// ---------- main loop ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!layout) return;
  if (TOUCH) turn(dt);
  animateClimber(dt);
  if (locked || planMode || !DEV) move(dt);
  camera.position.copy(player.pos);
  camera.rotation.set(player.pitch, player.yaw, 0);
  if (planMode) {
    playerMarker.position.set(player.pos.x, 6, player.pos.z);
    playerMarker.rotation.set(-Math.PI / 2, 0, player.yaw);
    renderer.render(scene, planCam);
    labelRenderer.render(scene, planCam);
  } else {
    if (locked) setHovered(pickFirstPerson());
    renderer.render(scene, camera);
  }
});

try {
  await load();
  const saved = JSON.parse(sessionStorage.getItem('pose') || 'null');
  sessionStorage.removeItem('pose');
  if (saved) {
    player.pos.fromArray(saved.pos); player.yaw = saved.yaw; player.pitch = saved.pitch;
    setPlanMode(saved.planMode);
  } else spawn();
  updateLockUI();
  if (!DEV) toast(TOUCH ? HINT_TOUCH : HINT_MOUSE, false, 6000);
} catch (err) {
  toast(location.protocol === 'file:' ? 'Open this through the server: python serve.py' : 'Failed to load model: ' + err.message, true, 0);
}
window.viewer = { player, scene, camera, keys, move, collides, pickFirstPerson, setPlanMode, spawn, info: () => info,
  problems: () => problems, selectProblem, setStep, goToProblem, joy, aim, turn, animateClimber, climber: () => climber };  // handy from the devtools console
