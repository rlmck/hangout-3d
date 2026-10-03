// The climber that acts out a problem: a simple mannequin whose hands and feet sit on the holds of the current move.
// - Hands lie flat on the hold, fingers pointing the way the hold's edge faces (up for a jug, sideways for a sidepull,
//   down for an undercling), wrist on the other side.
// - Shoes are placed by technique: edging (toe on, foot turned out on its inside edge), smearing, drop-knee (outside
//   edge, toes turned in), heel hook, toe hook, toe press; a missing foot flags out to the side.
// - The torso is solved each frame so the arms and legs can reach: shoulders and hips are kept a hand's width off the
//   wall, shoulders above hips unless on a roof, hips turned for drop-knees and laybacks, shoulders shrugged on long
//   reaches. Elbows and knees come from two-bone IK with a pole set by the grip (elbows down for a pull, out for a
//   gaston, up for a palm press; knees out like a frog, down and in for a drop-knee, sideways for a heel hook).
// Next/Prev move each changing limb along an arc off the wall with a fading dotted trail; the body follows.
import * as THREE from 'three';

const V3 = THREE.Vector3, UP = new V3(0, 1, 0), DOWN = new V3(0, -1, 0);
// a 1.75 m climber (metres)
const B = { upper: 0.29, fore: 0.27, thigh: 0.44, shin: 0.43, shoulder: 0.19, hip: 0.095, spine: 0.47, foot: 0.25 };
const ARM = B.upper + B.fore, LEG = B.thigh + B.shin;
const MOVE_TIME = 0.8, STAGGER = 0.45, TRAIL_TIME = 2.4;  // seconds
const LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK'];
const OFFSET = { LH: [-1, 0], RH: [1, 0], LF: [-1, 0], RF: [1, 0], LK: [0, 0], RK: [0, 0] };  // two limbs on one hold sit side by side
const side = (l) => (l[0] === 'L' ? -1 : 1);
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const unit = (v, fallback = UP) => (v.lengthSq() > 1e-8 ? v.normalize() : v.copy(fallback));
const perp = (v, n) => v.clone().addScaledVector(n, -v.dot(n));  // v with its n component removed
const avg = (vs) => vs.reduce((t, v) => t.add(v), new V3()).divideScalar(Math.max(1, vs.length));

// Two-bone IK: the middle joint (elbow/knee) for a limb from root to end, bending toward the pole.
function ik(root, end, l1, l2, pole) {
  const v = end.clone().sub(root), len = v.length(), dir = v.clone().divideScalar(len || 1);
  const d = Math.min(Math.max(len, 1e-3), l1 + l2 - 1e-3);
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pd = unit(perp(pole, dir), new V3(0, 0, 1));
  return root.clone().addScaledVector(dir, a).addScaledVector(pd, h);
}

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
    this.twist = this.twistTarget = 0;
    this.cur = this._targets(step);
    this.twist = this.twistTarget;
    this.r = this.rTarget.clone();
    this.body = null;
    for (let k = 0; k < 4; k++) this._solve(40);  // settle the start position
    this._draw();
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material ?? [])) { m.map?.dispose(); m.dispose(); }
    });
  }

  // ---- targets ----
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
    // the climber's right: along the wall (holds' x); eased toward in update() so the body turns smoothly between walls
    this.rTarget = unit(perp(avg(frames.map((f) => f.x.clone())), n), new V3(1, 0, 0));
    for (const l of LIMBS) poses[l] = this._pose(l, m, styles[l]);
    const techs = m.technique || [];
    let tw = 0;
    if (styles.RF === 'drop-knee' && m.RF) tw += 0.8;
    if (styles.LF === 'drop-knee' && m.LF) tw -= 0.8;
    if (techs.includes('layback')) {  // turn the chest toward the hands' side
      const H = avg(['LH', 'RH'].filter((l) => poses[l]).map((l) => poses[l].E.clone()));
      const F = avg(['LF', 'RF'].filter((l) => poses[l]).map((l) => poses[l].E.clone()));
      tw += H.sub(F).dot(this.r) < 0 ? 0.5 : -0.5;
    }
    this.twistTarget = tw;
    return poses;
  }

  _pose(l, m, style) {
    const h = m[l] && this.p._holds.get(m[l]), f = h && this.frame(h);
    if (!f) return null;
    const [sw, , sd] = this.size(h), n = f.z.clone();
    const out = this.rTarget.clone().multiplyScalar(side(l));  // away from the body's midline
    const C = f.pos.clone().addScaledVector(f.x, OFFSET[l][0] * Math.min(0.06, sw / 2 + 0.02))
      .addScaledVector(n, h.type === 'volume' ? sd * 0.55 : h.type === 'arete' || h.type === 'spot' ? 0.01 : sd * 0.7 + 0.01);
    if (l[1] === 'K') return { kind: 'K', C, E: C.clone(), n, mode: 'knee' };
    if (l[1] === 'H') {
      const mode = style || (h.grip === 'palm' ? 'palm' : 'grip');
      const dirs = { up: f.y, down: f.y.clone().negate(), left: f.x.clone().negate(), right: f.x };
      let fd = h.facing ? dirs[h.facing].clone() : h.type === 'arete' ? out.clone() : f.y.clone();
      if (mode === 'undercling') fd = f.y.clone().negate();
      if (mode === 'gaston') fd = out.clone().negate();
      fd = unit(perp(fd, n), f.y);
      return { kind: 'H', C, n, f: fd, mode, E: C.clone().addScaledVector(fd, -0.14).addScaledVector(n, 0.03) };  // wrist
    }
    // feet
    const into = n.clone().negate(), roof = Math.abs(n.y) > 0.7;
    const level = roof ? f.y.clone() : unit(new V3(into.x, 0, into.z));  // "into the wall", kept level
    const mode = style || 'edge';
    let d, s, toe, heel;
    if (mode === 'heel') {  // heel on the hold, toes pointing out to the side
      d = unit(perp(out.clone().multiplyScalar(0.8).addScaledVector(UP, 0.35), into).addScaledVector(n, 0.3));
      s = unit(perp(UP.clone().addScaledVector(into, 0.4), d), n);
      heel = C.clone(); toe = C.clone().addScaledVector(d, B.foot);
    } else if (mode === 'toe-hook') {  // top of the toes hooked behind the hold, foot along the surface
      const away = this.body ? C.clone().sub(this.body.P) : DOWN.clone().negate();
      d = unit(perp(away, n), f.y);
      s = into.clone();
      toe = C.clone().addScaledVector(d, 0.04); heel = toe.clone().addScaledVector(d, -B.foot).addScaledVector(n, 0.06);
    } else if (mode === 'toe-press') {  // toes pushing straight into the hold
      d = unit(into.clone().addScaledVector(level, roof ? 0.6 : 0.2));
      s = unit(perp(roof ? n.clone().negate() : UP.clone(), d), n);
      toe = C.clone(); heel = toe.clone().addScaledVector(d, -B.foot);
    } else {
      // edge: toe on the hold, foot turned out so the inside edge bites; drop-knee: outside edge, toes turned in;
      // smear: straight in with the heel dropped
      const turn = mode === 'drop-knee' ? -0.75 : mode === 'smear' ? 0.15 : 0.5;
      d = unit(level.clone().addScaledVector(out, turn));
      s = unit(perp(UP.clone(), d), n);
      toe = C.clone().addScaledVector(d, 0.03);
      heel = toe.clone().addScaledVector(d, -B.foot).addScaledVector(DOWN, mode === 'smear' ? 0.07 : 0.015);
    }
    const E = mode === 'heel' ? heel.clone().addScaledVector(d, 0.05).addScaledVector(s, 0.07)
      : heel.clone().lerp(toe, 0.25).addScaledVector(s, 0.07);
    return { kind: 'F', C, n, d, s, toe, heel, E, mode };
  }

  _flag(l, body) {  // a foot with no hold: hang (both off) or flag out to the side against the wall
    const J = body.joint[l], n = body.n, out = body.r.clone().multiplyScalar(side(l));
    const both = !this.cur.LF && !this.cur.RF;
    const E = J.clone().addScaledVector(DOWN, both ? 0.8 : 0.66).addScaledVector(out, both ? 0.05 : 0.42);
    if (!both) E.addScaledVector(n, 0.12 - E.clone().sub(body.O).dot(n));
    const d = unit(DOWN.clone().multiplyScalar(both ? 0.8 : 0.3).addScaledVector(out, both ? 0.1 : 0.6).addScaledVector(n, -0.2));
    const s = unit(perp(n.clone(), d), UP);
    return { kind: 'F', C: E.clone(), n: n.clone(), d, s, heel: E.clone().addScaledVector(d, -0.06).addScaledVector(s, -0.07),
      toe: E.clone().addScaledVector(d, 0.19).addScaledVector(s, -0.07), E, mode: 'flag' };
  }

  // ---- moving between moves ----
  goTo(i) {
    const prevBody = this.body;
    for (const a of this.anims) if (!a.done && a.live) this.cur[a.l] = a.live;  // carry on from mid-flight
    for (const tr of this.trails.filter((q) => q.start > this.t)) { this.group.remove(tr.obj); tr.obj.geometry.dispose(); tr.obj.material.dispose(); }
    this.trails = this.trails.filter((q) => q.start <= this.t);
    const m = this.p.moves[i], next = this._targets(i), hand = (l) => (l[1] === 'H' ? 1 : 0), order = m.dynamic ? -1 : 1;
    const same = (a, b) => (!a && !b) || (a && b && a.E.distanceTo(b.E) < 1e-3 && a.mode === b.mode);
    const changes = LIMBS.filter((l) => !same(this.cur[l], next[l])).sort((a, b) => (hand(a) - hand(b)) * order);
    this.anims = changes.map((l, k) => {
      const from = this.cur[l] || (l[1] === 'F' && prevBody ? this._flag(l, prevBody) : next[l]);
      const to = next[l] || (l[1] === 'F' && prevBody ? this._flag(l, prevBody) : from);
      const fast = m.dynamic && hand(l), dur = fast ? 0.5 : MOVE_TIME;
      const start = this.t + k * STAGGER * (m.dynamic ? 0.6 : 1);
      const lift = l[1] === 'K' ? 0.04 : Math.min(0.25, 0.08 + from.E.distanceTo(to.E) * 0.12);
      const arcN = unit(from.n.clone().add(to.n), from.n);
      const pt = (a, b, e) => a.clone().lerp(b, e).addScaledVector(arcN, Math.sin(Math.PI * e) * lift);
      const trail = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 16 }, (_, j) => pt(from.C, to.C, j / 15))),
        new THREE.PointsMaterial({ map: this.dot, color: this.colours[l], size: this.dotSize, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
      this.group.add(trail);
      this.trails.push({ obj: trail, start, end: start + dur });
      return { l, from, to, final: next[l], pt, start, dur, done: false, live: null };
    });
    this.moved = new Set(changes);
  }

  _lerpPose(a, b, e, pt) {
    const q = { kind: a.kind, mode: e < 0.5 ? a.mode : b.mode };
    for (const k of ['C', 'E', 'toe', 'heel']) if (a[k] && b[k]) q[k] = pt(a[k], b[k], e);
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
      if (u >= 1) { a.done = true; this.cur[a.l] = a.final; }
    }
    for (const tr of this.trails) {  // fade in while the limb travels, then fade away
      const o = this.t < tr.start ? 0 : this.t < tr.end ? 0.9 * (this.t - tr.start) / (tr.end - tr.start) : 0.9 * (1 - (this.t - tr.end) / TRAIL_TIME);
      tr.obj.material.opacity = Math.max(0, o);
    }
    for (const tr of this.trails.filter((q) => this.t > q.end + TRAIL_TIME)) { this.group.remove(tr.obj); tr.obj.geometry.dispose(); tr.obj.material.dispose(); }
    this.trails = this.trails.filter((q) => this.t <= q.end + TRAIL_TIME);
    const k = Math.min(1, dt * 4);
    this.twist += (this.twistTarget - this.twist) * k;
    this.r = unit(this.r.lerp(this.rTarget, k), this.rTarget);
    this._solve(12);
    this._draw();
  }

  // ---- body ----
  _solve(iterations) {
    const cur = this.cur, have = LIMBS.filter((l) => cur[l]);
    if (!have.length) { this.body = null; return; }
    const n = unit(avg(have.map((l) => cur[l].n.clone())), new V3(0, 0, 1));
    const O = avg(have.map((l) => cur[l].C.clone()));  // a point on the wall near the climber
    const off = (X) => X.clone().sub(O).dot(n);
    const hands = ['LH', 'RH'].filter((l) => cur[l]), feet = ['LF', 'RF'].filter((l) => cur[l]), knees = ['LK', 'RK'].filter((l) => cur[l]);
    const roof = n.y < -0.75, slab = n.y > 0.15;
    const chestOff = roof ? 0.3 : 0.27, hipOff = roof ? 0.3 : slab ? 0.36 : 0.25;
    let S, P;
    if (this.body) { S = this.body.S.clone(); P = this.body.P.clone(); }
    else {
      const H = hands.length ? avg(hands.map((l) => cur[l].E.clone())) : null, F = feet.length ? avg(feet.map((l) => cur[l].E.clone())) : null;
      S = H && F ? H.clone().lerp(F, 0.35) : H ? H.clone().addScaledVector(DOWN, 0.45) : F.clone().addScaledVector(UP, 1.1);
      S.addScaledVector(n, chestOff);
      P = F && H ? F.clone().lerp(H, 0.35).addScaledVector(n, hipOff) : S.clone().addScaledVector(DOWN, B.spine);
    }
    const r0 = this.r.clone();
    let u = new V3(), r = new V3();
    const frame = () => {
      u = unit(S.clone().sub(P));
      r = unit(perp(r0, u), new V3(1, 0, 0)).applyAxisAngle(u, this.twist);
    };
    for (let it = 0; it < iterations; it++) {
      frame();
      const dS = new V3(), dP = new V3();
      const pull = (acc, J, E, max, min, k) => {
        const v = E.clone().sub(J), L = v.length() || 1e-6;
        const ex = L > max ? L - max : L < min ? L - min : 0;
        acc.addScaledVector(v, (ex / L) * k);
      };
      for (const l of hands) pull(dS, S.clone().addScaledVector(r, side(l) * B.shoulder), cur[l].E, ARM * 0.97, 0.22, 0.5);
      for (const l of feet) pull(dP, P.clone().addScaledVector(r, side(l) * B.hip), cur[l].E, LEG * 0.96, 0.3, 0.5);
      for (const l of knees) pull(dP, P.clone().addScaledVector(r, side(l) * B.hip), cur[l].E, B.thigh, B.thigh, 0.5);
      S.add(dS).addScaledVector(dP, 0.4);
      P.add(dP).addScaledVector(dS, 0.4);
      const mid = S.clone().add(P).multiplyScalar(0.5), dir = unit(S.clone().sub(P));
      S.copy(mid).addScaledVector(dir, B.spine / 2);
      P.copy(mid).addScaledVector(dir, -B.spine / 2);
      for (const [X, want] of [[S, chestOff], [P, hipOff]]) {  // keep chest and hips a little off the wall
        const d = off(X);
        if (d < want) X.addScaledVector(n, (want - d) * 0.5);
        else if (d > want + 0.12) X.addScaledVector(n, (want + 0.12 - d) * 0.3);
      }
      if (!roof && S.y < P.y + 0.2) { S.y += 0.015; P.y -= 0.015; }  // shoulders above hips
    }
    frame();
    const joint = {
      LH: S.clone().addScaledVector(r, -B.shoulder), RH: S.clone().addScaledVector(r, B.shoulder),
      LF: P.clone().addScaledVector(r, -B.hip), RF: P.clone().addScaledVector(r, B.hip),
    };
    for (const l of ['LH', 'RH']) {  // shoulders rise toward the ears on a long reach
      if (!cur[l]) continue;
      const reach = cur[l].E.clone().sub(joint[l]).dot(u);
      joint[l].addScaledVector(u, THREE.MathUtils.clamp(reach - 0.25, 0, 0.3) * 0.18);
    }
    joint.LK = joint.LF; joint.RK = joint.RF;
    this.body = { S, P, u, r, n, O, joint };
  }

  // ---- meshes ----
  _buildMeshes() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9d3c9, roughness: 0.88, transparent: true, opacity: 0.92 });
    this.skin = skin;
    const part = (geo) => { const m = new THREE.Mesh(geo, skin); this.group.add(m); return m; };
    const cyl = () => part(new THREE.CylinderGeometry(1, 1, 1, 12));
    const ball = () => part(new THREE.SphereGeometry(1, 16, 12));
    this.m = {
      chest: ball(), belly: ball(), pelvis: ball(), head: ball(), neck: cyl(),
      arm: { LH: [cyl(), cyl()], RH: [cyl(), cyl()] }, leg: { LF: [cyl(), cyl()], RF: [cyl(), cyl()] },
      joints: Array.from({ length: 12 }, ball),
      hands: {}, shoes: {},
    };
    for (const l of ['LH', 'RH']) {
      const mat = new THREE.MeshBasicMaterial({ map: handTexture(l === 'RH', this.colours[l]), transparent: true, side: THREE.DoubleSide,
        depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2 * this.scale, 0.2 * this.scale), mat);  // hand ~0.18 m long
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.m.hands[l] = mesh;
    }
    for (const l of ['LF', 'RF']) {  // shoe: coloured ellipsoid with a dark outline shell
      const geo = new THREE.SphereGeometry(1, 20, 12);
      const shoe = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.colours[l], roughness: 0.6, emissive: this.colours[l], emissiveIntensity: 0.15 }));
      const line = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: 0x111116, side: THREE.BackSide }));
      line.scale.setScalar(1.14);
      shoe.add(line);
      this.group.add(shoe);
      this.m.shoes[l] = shoe;
    }
  }

  _draw() {
    const b = this.body, m = this.m, cur = this.cur;
    this.group.visible = !!b;
    if (!b) return;
    const { S, P, u, r, n } = b;
    const out = r.clone().cross(u);  // the climber's back, away from the wall
    const basis = new THREE.Matrix4().makeBasis(r, u, out);
    const blob = (mesh, c, rx, ry, rz) => { mesh.position.copy(c); mesh.quaternion.setFromRotationMatrix(basis); mesh.scale.set(rx, ry, rz); };
    blob(m.chest, S.clone().addScaledVector(u, -0.13), 0.17, 0.19, 0.1);
    blob(m.belly, S.clone().lerp(P, 0.62), 0.13, 0.15, 0.09);
    blob(m.pelvis, P.clone().addScaledVector(u, 0.02), 0.155, 0.1, 0.1);
    blob(m.head, S.clone().addScaledVector(u, 0.24).addScaledVector(out, 0.02), 0.085, 0.11, 0.095);
    const bone = (mesh, a, c, rad) => {
      const d = c.clone().sub(a), len = d.length();
      mesh.position.copy(a).addScaledVector(d, 0.5);
      mesh.scale.set(rad, Math.max(len, 1e-3), rad);
      if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    };
    bone(m.neck, S, S.clone().addScaledVector(u, 0.14), 0.045);
    let j = 0;
    const joint = (c, rad) => { const s = m.joints[j++]; s.visible = true; s.position.copy(c); s.scale.setScalar(rad); };
    for (const l of ['LH', 'RH']) {
      const J = b.joint[l], q = cur[l], o = r.clone().multiplyScalar(side(l));
      const W = q ? q.E : J.clone().addScaledVector(DOWN, 0.5).addScaledVector(n, 0.1);
      const f = q?.f ?? UP;
      const pole = q?.mode === 'palm' ? f.clone().multiplyScalar(-0.3).addScaledVector(n, 0.8).addScaledVector(o, 0.5).addScaledVector(UP, 0.3)
        : q?.mode === 'gaston' ? o.clone().addScaledVector(DOWN, 0.3).addScaledVector(n, 0.3)
        : f.dot(UP) < -0.5 || q?.mode === 'undercling' ? DOWN.clone().addScaledVector(n, 0.6).addScaledVector(o, 0.3)
        : f.clone().negate().addScaledVector(DOWN, 0.7).addScaledVector(n, 0.5).addScaledVector(o, 0.35);
      const El = ik(J, W, B.upper, B.fore, pole);
      bone(m.arm[l][0], J, El, 0.043); bone(m.arm[l][1], El, W, 0.034);
      joint(J, 0.055); joint(El, 0.038);
      const hm = m.hands[l];
      hm.visible = !!q;
      if (q) {  // flat on the hold, fingers along f, back of the hand facing out
        hm.position.copy(q.C).addScaledVector(q.f, -0.06 * this.scale).addScaledVector(q.n, 0.012);  // fingertips just past the hold
        const side2 = q.f.clone().cross(q.n);
        hm.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side2, q.f, q.n));
        hm.material.opacity = this.moved.has(l) ? 1 : 0.7;
      }
    }
    for (const l of ['LF', 'RF']) {
      const J = b.joint[l], o = r.clone().multiplyScalar(side(l));
      const q = cur[l] || this._flag(l, b), K = cur[l === 'LF' ? 'LK' : 'RK'];
      const pole = q.mode === 'heel' ? o.clone().multiplyScalar(0.7).addScaledVector(UP, 0.5).addScaledVector(n, 0.3)
        : q.mode === 'drop-knee' ? DOWN.clone().multiplyScalar(0.8).addScaledVector(o, -0.3).addScaledVector(n, 0.25)
        : q.mode === 'flag' ? n.clone().multiplyScalar(0.4).addScaledVector(o, 0.2).addScaledVector(UP, 0.1)
        : n.clone().multiplyScalar(0.75).addScaledVector(o, 0.55).addScaledVector(UP, 0.15);
      const Kn = K ? K.E : ik(J, q.E, B.thigh, B.shin, pole);
      bone(m.leg[l][0], J, Kn, 0.062); bone(m.leg[l][1], Kn, q.E, 0.045);
      joint(J, 0.064); joint(Kn, 0.05); joint(q.E, 0.038);
      const shoe = m.shoes[l];  // ellipsoid from heel to toe, top of the foot along s
      shoe.position.copy(q.heel).lerp(q.toe, 0.5).addScaledVector(q.s, 0.03);
      const sideAxis = q.s.clone().cross(q.d);
      shoe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(sideAxis, q.s, q.d));
      shoe.scale.set(0.045, 0.04, B.foot / 2);
      shoe.material.emissiveIntensity = this.moved.has(l) ? 0.45 : 0.1;
    }
    for (; j < m.joints.length; j++) m.joints[j].visible = false;
  }
}
