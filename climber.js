// Hands and feet that act out a problem (no body): each limb sits on its hold for the current move.
// - Hands lie flat on the hold, fingers pointing the way the hold's edge faces (up for a jug, sideways for a sidepull,
//   down for an undercling), wrist on the other side.
// - Shoes are placed by the move's per-limb style: edge (toe on, foot turned out on its inside edge), smear,
//   drop-knee (outside edge, toes turned in), heel hook, toe hook, toe press. A kneebar knee shows as a small marker.
// - A limb with no hold (a flag, or feet cutting loose) fades out, and fades back in when it is placed again.
// Next/Prev move each changing limb along an arc off the wall with a fading dotted trail, feet first (hands first on
// a dynamic move); the limb that just moved stays highlighted.
import * as THREE from 'three';

const V3 = THREE.Vector3, UP = new V3(0, 1, 0), DOWN = new V3(0, -1, 0);
const FOOT = 0.25;  // shoe length, metres
const MOVE_TIME = 0.8, STAGGER = 0.45, TRAIL_TIME = 2.4;  // seconds
const LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK'];
const OFFSET = { LH: -1, RH: 1, LF: -1, RF: 1, LK: 0, RK: 0 };  // two limbs on one hold sit side by side
const side = (l) => (l[0] === 'L' ? -1 : 1);
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const unit = (v, fallback = UP) => (v.lengthSq() > 1e-8 ? v.normalize() : v.copy(fallback));
const perp = (v, n) => v.clone().addScaledVector(n, -v.dot(n));  // v with its n component removed
const avg = (vs) => vs.reduce((t, v) => t.add(v), new V3()).divideScalar(Math.max(1, vs.length));

function handTexture(right, colour) {  // outline of the back of a hand, fingers up, thumb toward the body
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.scale(2, 2); g.lineJoin = g.lineCap = 'round';
  if (right) { g.translate(64, 0); g.scale(-1, 1); }
  const P = (f) => { const p = new Path2D(); f(p); return p; };
  const paths = [
    P((p) => p.roundRect(17, 28, 28, 30, 9)),
    ...[[20.5, 14, 6.5], [27.5, 8, 7.5], [35, 5, 7.5], [42, 9, 7]].map(([x, y, w]) => P((p) => p.roundRect(x - w / 2, y, w, 36 - y, w / 2))),
    P((p) => p.ellipse(50, 40, 4.3, 11, 0.65, 0, Math.PI * 2)),
  ];
  g.strokeStyle = 'rgba(12,12,16,0.85)'; g.lineWidth = 8; paths.forEach((q) => g.stroke(q));
  g.strokeStyle = colour; g.lineWidth = 5; paths.forEach((q) => g.stroke(q));
  g.fillStyle = 'rgba(255,255,255,0.95)'; paths.forEach((q) => g.fill(q));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 13, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}

export class Climber {
  // problem: with _holds; frame(h) -> {pos, x, y, z}; size(h) -> [w, h, depth]; colours: {LH: '#..', ...}
  constructor({ problem, step, frame, size, colours, scale = 1, dotSize = 7 }) {
    Object.assign(this, { p: problem, frame, size, colours, scale, dotSize });
    this.t = 0; this.anims = []; this.trails = []; this.moved = new Set(LIMBS);
    this.group = new THREE.Group();
    this.dot = dotTexture();
    this._buildMeshes();
    this.cur = this._targets(step);
    this.alpha = Object.fromEntries(LIMBS.map((l) => [l, this.cur[l] ? 1 : 0]));
    this._draw();
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose(); m.dispose(); }
    });
  }

  // ---- where each limb goes ----
  _styleFor(i) {  // per-limb technique for move i; carried forward while a limb stays on the same hold
    const moves = this.p.moves, out = {};
    for (const l of LIMBS) {
      for (let j = i; j >= 0; j--) {
        if (moves[j].style?.[l]) { out[l] = moves[j].style[l]; break; }
        if (j > 0 && moves[j - 1][l] !== moves[j][l]) break;
      }
    }
    return out;
  }

  _targets(i) {
    const m = this.p.moves[i], styles = this._styleFor(i), poses = {};
    const frames = LIMBS.map((l) => m[l] && this.p._holds.get(m[l])).filter(Boolean).map((h) => this.frame(h)).filter(Boolean);
    const n = unit(avg(frames.map((f) => f.z.clone())), new V3(0, 0, 1));
    this.right = unit(perp(avg(frames.map((f) => f.x.clone())), n), new V3(1, 0, 0));  // the climber's right, along the wall
    this.centre = avg(frames.map((f) => f.pos.clone()));  // roughly where the climber's body is
    for (const l of LIMBS) poses[l] = this._pose(l, m, styles[l]);
    return poses;
  }

  _pose(l, m, style) {
    const h = m[l] && this.p._holds.get(m[l]), f = h && this.frame(h);
    if (!f) return null;
    const [sw, sh, sd] = this.size(h), n = f.z.clone();
    const out = this.right.clone().multiplyScalar(side(l));  // away from the body's midline
    const C = f.pos.clone().addScaledVector(f.x, OFFSET[l] * Math.min(0.06, sw / 2 + 0.02))
      .addScaledVector(n, h.type === 'volume' ? sd * 0.55 : h.type === 'arete' || h.type === 'spot' ? 0.01 : sd * 0.7 + 0.01);
    if (l[1] === 'K') return { kind: 'K', C, n, mode: 'knee' };
    if (l[1] === 'H') {
      const mode = style || (h.grip === 'palm' ? 'palm' : 'grip');
      const dirs = { up: f.y, down: f.y.clone().negate(), left: f.x.clone().negate(), right: f.x };
      let fd = h.facing ? dirs[h.facing].clone() : h.type === 'arete' ? out.clone() : f.y.clone();
      if (mode === 'undercling') fd = f.y.clone().negate();
      if (mode === 'gaston') fd = out.clone().negate();
      return { kind: 'H', C, n, f: unit(perp(fd, n), f.y), mode };
    }
    // feet
    const into = n.clone().negate(), roof = Math.abs(n.y) > 0.7;
    const level = roof ? f.y.clone() : unit(new V3(into.x, 0, into.z));  // "into the wall", kept level
    const mode = style || 'edge';
    let d, s, toe, heel;
    if (mode === 'heel') {  // heel on the hold, toes pointing out to the side
      d = unit(perp(out.clone().multiplyScalar(0.8).addScaledVector(UP, 0.35), into).addScaledVector(n, 0.3));
      s = unit(perp(UP.clone().addScaledVector(into, 0.4), d), n);
      heel = C.clone(); toe = C.clone().addScaledVector(d, FOOT);
    } else if (mode === 'toe-hook') {  // top of the toes hooked behind the hold, foot along the surface, away from the body
      d = unit(perp(C.clone().sub(this.centre), n), f.y);
      s = into.clone();
      toe = C.clone().addScaledVector(d, 0.04); heel = toe.clone().addScaledVector(d, -FOOT).addScaledVector(n, 0.06);
    } else if (mode === 'toe-press') {  // toes pushing straight into the hold
      d = unit(into.clone().addScaledVector(level, roof ? 0.6 : 0.2));
      s = unit(perp(roof ? n.clone().negate() : UP.clone(), d), n);
      toe = C.clone(); heel = toe.clone().addScaledVector(d, -FOOT);
    } else {
      // edge: toe on top of the hold against the wall, foot turned out so the inside edge bites; drop-knee: outside
      // edge, toes turned in; smear: straight in with the heel dropped
      const turn = mode === 'drop-knee' ? -0.75 : mode === 'smear' ? 0.15 : 0.5;
      d = unit(level.clone().addScaledVector(out, turn));
      s = unit(perp(UP.clone(), d), n);
      toe = ['foot', 'crimp', 'jug', 'pinch', 'sloper', 'pocket'].includes(h.type)
        ? f.pos.clone().addScaledVector(f.x, OFFSET[l] * Math.min(0.03, sw / 4)).addScaledVector(UP, sh * 0.5).addScaledVector(n, Math.min(sd, 0.05) * 0.5)
        : C.clone();
      heel = toe.clone().addScaledVector(d, -FOOT).addScaledVector(DOWN, mode === 'smear' ? 0.07 : 0.015);
    }
    return { kind: 'F', C, n, d, s, toe, heel, mode };
  }

  // ---- moving between moves ----
  goTo(i) {
    for (const a of this.anims) if (!a.done && a.live) this.cur[a.l] = a.live;  // carry on from mid-flight
    for (const tr of this.trails.filter((q) => q.start > this.t)) this._dropTrail(tr);
    this.trails = this.trails.filter((q) => q.start <= this.t);
    const m = this.p.moves[i], next = this._targets(i), hand = (l) => (l[1] === 'H' ? 1 : 0), order = m.dynamic ? -1 : 1;
    const same = (a, b) => (!a && !b) || (a && b && a.C.distanceTo(b.C) < 1e-3 && a.mode === b.mode);
    const changes = LIMBS.filter((l) => !same(this.cur[l], next[l])).sort((a, b) => (hand(a) - hand(b)) * order);
    this.anims = changes.map((l, k) => {
      const from = this.cur[l] || next[l], to = next[l] || this.cur[l];  // appearing/disappearing limbs fade in place
      const fade = !this.cur[l] ? 'in' : !next[l] ? 'out' : null;
      const dur = m.dynamic && hand(l) ? 0.5 : MOVE_TIME, start = this.t + k * STAGGER * (m.dynamic ? 0.6 : 1);
      const lift = fade ? 0 : Math.min(0.25, 0.08 + from.C.distanceTo(to.C) * 0.12);
      const arcN = unit(from.n.clone().add(to.n), from.n);
      const pt = (a, b, e) => a.clone().lerp(b, e).addScaledVector(arcN, Math.sin(Math.PI * e) * lift);
      if (!fade) {
        const trail = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 16 }, (_, j) => pt(from.C, to.C, j / 15))),
          new THREE.PointsMaterial({ map: this.dot, color: this.colours[l], size: this.dotSize, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
        this.group.add(trail);
        this.trails.push({ obj: trail, start, end: start + dur });
      }
      return { l, from, to, final: next[l], fade, pt, start, dur, done: false, live: null };
    });
    this.moved = new Set(changes);
  }

  _dropTrail(tr) { this.group.remove(tr.obj); tr.obj.geometry.dispose(); tr.obj.material.dispose(); }

  _lerpPose(a, b, e, pt) {
    const q = { kind: a.kind, mode: e < 0.5 ? a.mode : b.mode };
    for (const k of ['C', 'toe', 'heel']) if (a[k] && b[k]) q[k] = pt(a[k], b[k], e);
    for (const k of ['n', 'f', 'd', 's']) if (a[k] && b[k]) q[k] = unit(a[k].clone().lerp(b[k], e), b[k]);
    return q;
  }

  update(dt) {
    this.t += dt;
    for (const a of this.anims) {
      if (a.done || this.t < a.start) continue;
      const u = Math.min(1, (this.t - a.start) / a.dur), e = ease(u);
      a.live = this._lerpPose(a.from, a.to, e, a.pt);
      this.cur[a.l] = a.live;
      this.alpha[a.l] = a.fade === 'in' ? e : a.fade === 'out' ? 1 - e : 1;
      if (u >= 1) { a.done = true; this.cur[a.l] = a.final; this.alpha[a.l] = a.final ? 1 : 0; }
    }
    for (const a of this.anims) if (a.fade === 'in' && this.t < a.start) this.alpha[a.l] = 0;  // not placed yet
    for (const tr of this.trails) {  // fade in while the limb travels, then fade away
      const o = this.t < tr.start ? 0 : this.t < tr.end ? 0.9 * (this.t - tr.start) / (tr.end - tr.start) : 0.9 * (1 - (this.t - tr.end) / TRAIL_TIME);
      tr.obj.material.opacity = Math.max(0, o);
    }
    for (const tr of this.trails.filter((q) => this.t > q.end + TRAIL_TIME)) this._dropTrail(tr);
    this.trails = this.trails.filter((q) => this.t <= q.end + TRAIL_TIME);
    this._draw();
  }

  // ---- meshes ----
  _buildMeshes() {
    this.m = { hands: {}, shoes: {}, knees: {} };
    for (const l of ['LH', 'RH']) {  // hand outline lying on the hold
      const mat = new THREE.MeshBasicMaterial({ map: handTexture(l === 'RH', this.colours[l]), transparent: true, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2 * this.scale, 0.2 * this.scale), mat);  // hand ~0.18 m long
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.m.hands[l] = mesh;
    }
    const outlined = (geo, colour) => {  // coloured solid with a dark outline shell
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, emissive: colour, emissiveIntensity: 0.15, transparent: true }));
      const line = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: 0x111116, side: THREE.BackSide, transparent: true }));
      line.scale.setScalar(1.14);
      mesh.add(line);
      this.group.add(mesh);
      return mesh;
    };
    for (const l of ['LF', 'RF']) this.m.shoes[l] = outlined(new THREE.SphereGeometry(1, 20, 12), this.colours[l]);
    for (const l of ['LK', 'RK']) this.m.knees[l] = outlined(new THREE.SphereGeometry(0.05 * this.scale, 16, 12), this.colours[l]);
  }

  _draw() {
    const cur = this.cur, m = this.m;
    const fadeTo = (mesh, a) => { mesh.traverse((o) => { if (o.material) o.material.opacity = a; }); mesh.visible = a > 0.01; };
    for (const l of ['LH', 'RH']) {  // flat on the hold, fingers along f, back of the hand facing out
      const q = cur[l], hm = m.hands[l];
      hm.visible = !!q && this.alpha[l] > 0.01;
      if (!q) continue;
      hm.position.copy(q.C).addScaledVector(q.f, -0.06 * this.scale).addScaledVector(q.n, 0.012);  // fingertips just past the hold
      hm.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(q.f.clone().cross(q.n), q.f, q.n));
      hm.material.opacity = this.alpha[l] * (this.moved.has(l) ? 1 : 0.7);
    }
    for (const l of ['LF', 'RF']) {  // ellipsoid from heel to toe, top of the foot along s
      const q = cur[l], shoe = m.shoes[l];
      if (!q) { shoe.visible = false; continue; }
      shoe.position.copy(q.heel).lerp(q.toe, 0.5).addScaledVector(q.s, 0.03);
      shoe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(q.s.clone().cross(q.d), q.s, q.d));
      shoe.scale.set(0.045 * this.scale, 0.04 * this.scale, (FOOT / 2) * this.scale);
      shoe.material.emissiveIntensity = this.moved.has(l) ? 0.45 : 0.1;
      fadeTo(shoe, this.alpha[l]);
    }
    for (const l of ['LK', 'RK']) {
      const q = cur[l], knee = m.knees[l];
      if (!q) { knee.visible = false; continue; }
      knee.position.copy(q.C);
      fadeTo(knee, this.alpha[l]);
    }
  }
}
