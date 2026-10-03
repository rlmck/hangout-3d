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
// speed limits, per second (scaled by the frame time so phones at 30 fps look the same as 60 fps)
const BODY_SPEED = 1.3, MID_SLACK = 1.8, TURN_SPEED = 7;  // m/s torso, m/s extra for elbows/knees, rad/s bend turn
let frameDt = 1 / 60;
const LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK'];
const OFFSET = { LH: [-1, 0], RH: [1, 0], LF: [-1, 0], RF: [1, 0], LK: [0, 0], RK: [0, 0] };  // two limbs on one hold sit side by side
const side = (l) => (l[0] === 'L' ? -1 : 1);
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const unit = (v, fallback = UP) => (v.lengthSq() > 1e-8 ? v.normalize() : v.copy(fallback));
const perp = (v, n) => v.clone().addScaledVector(n, -v.dot(n));  // v with its n component removed
const avg = (vs) => vs.reduce((t, v) => t.add(v), new V3()).divideScalar(Math.max(1, vs.length));

// Two-bone IK: the middle joint (elbow/knee) for a limb from root to end, bending toward the pole. The bend direction
// turns from last frame's toward the pole at most TURN_SPEED radians a second, so an elbow or knee can never snap
// through the limb when the pole lines up with it.
function ik(root, end, l1, l2, pole, memo, key, away, minAway = 0) {
  const v = end.clone().sub(root), len = Math.max(v.length(), 1e-3), dir = v.clone().divideScalar(len);
  // soft IK: over the last 8% of reach the limb straightens gradually and the bones stretch slightly to keep the
  // hand/foot attached, so the elbow/knee never whips straight in one frame
  const L = l1 + l2, soft = 0.08 * L;
  const eff = len < L - soft ? len : L - soft + soft * (1 - Math.exp(-(len - (L - soft)) / soft));
  const k = len / eff, s1 = l1 * k, s2 = l2 * k;
  const a = (s1 * s1 - s2 * s2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, s1 * s1 - a * a));
  const want = perp(pole, dir);
  if (away) {  // never bend into the wall: keep at least minAway of the bend pointing out of it
    unit(want, perp(away, dir));
    const a = want.dot(away);
    if (a < minAway) unit(want.addScaledVector(perp(away, dir), minAway - a), want);
  }
  const prev = memo[key] ? perp(memo[key], dir) : null;
  let pd;
  if (!prev || prev.lengthSq() < 1e-6) pd = unit(want, perp(new V3(0, 0, 1), dir));
  else if (want.lengthSq() < 1e-6) pd = prev.normalize();
  else {
    prev.normalize(); want.normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(prev.dot(want), -1, 1));
    const maxTurn = TURN_SPEED * frameDt;
    if (ang <= maxTurn) pd = want;
    else pd = prev.applyAxisAngle(unit(prev.clone().cross(want), dir), maxTurn);  // opposite: turn about the limb
  }
  memo[key] = pd.clone();
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
    this.memo = {};  // last bend direction per elbow/knee
    this.last = {};  // last frame's shoulder/elbow/hand and hip/knee/foot
    this.dot = dotTexture();
    this._buildMeshes();
    this.twist = this.twistTarget = 0;
    this.cur = this._targets(step);
    this.twist = this.twistTarget;
    this.r = this.rTarget.clone();
    this.body = null;
    this._solve(300);  // settle the start position
    this.settled = true;
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
    // weight: after a rockover/high-step the foot that moved takes the weight (hips over it, that leg bent, the
    // other leg trailing) until either foot moves again; otherwise both feet share it
    this.weight = {};
    for (let j = i; j > 0; j--) {
      const mj = this.p.moves[j], pj = this.p.moves[j - 1], moved = ['LF', 'RF'].filter((l) => mj[l] !== pj[l]);
      if (!moved.length) continue;
      const w = moved[0], o = w === 'LF' ? 'RF' : 'LF';
      if (moved.length === 1 && mj[w] && (mj.technique || []).some((t) => /rockover|high-step|high feet/.test(t))
        && m[w] === mj[w] && m[o] === mj[o]) { this.weight[w] = 1.6; this.weight[o] = 0.4; }
      break;
    }
    return poses;
  }

  _pose(l, m, style) {
    const h = m[l] && this.p._holds.get(m[l]), f = h && this.frame(h);
    if (!f) return null;
    const [sw, sh, sd] = this.size(h), n = f.z.clone();
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
      // the toe stands on top of a foothold, against the wall; on a volume or arete it sits where C is
      toe = h.type === 'foot' || h.type === 'crimp' || h.type === 'jug' || h.type === 'pinch' || h.type === 'sloper' || h.type === 'pocket'
        ? f.pos.clone().addScaledVector(f.x, OFFSET[l][0] * Math.min(0.03, sw / 4)).addScaledVector(UP, sh * 0.5).addScaledVector(n, Math.min(sd, 0.05) * 0.5)
        : C.clone();
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
      const knee = (q) => l[1] === 'K' && this.last[l[0] + 'F'] && q && { ...q, C: this.last[l[0] + 'F'].mid.clone(), E: this.last[l[0] + 'F'].mid.clone() };
      const from = this.cur[l] || knee(next[l]) || (l[1] === 'F' && prevBody ? this._flag(l, prevBody) : next[l]);
      const to = next[l] || knee(this.cur[l]) || (l[1] === 'F' && prevBody ? this._flag(l, prevBody) : from);
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
    frameDt = Math.min(Math.max(dt, 1 / 240), 0.1);
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
    this._solve(25);
    this._draw();
  }

  // ---- body ----
  // The torso (pelvis P and spine direction u, chest S = P + u * spine) minimises a smooth energy, so it moves
  // continuously with the hands and feet (no jitter) and settles instead of oscillating:
  //   arms: bend freely, gently prefer near-straight (climbers hang on straight arms), must not over-reach;
  //   legs: prefer bent (~0.62 m hip to ankle), must not over-reach or fold flat; a kneebar pins the thigh length;
  //   hips and chest: a set distance off the wall (close on steep ground, further out on a slab, below a roof);
  //   balance: hips over the feet side to side (between feet and hands on steep ground);
  //   posture: spine leans from the feet toward the hands, upright unless under a roof.
  _setup() {
    const cur = this.cur, have = LIMBS.filter((l) => cur[l]);
    if (!have.length) return null;
    const n = unit(avg(have.map((l) => cur[l].n.clone())), new V3(0, 0, 1));
    const roof = n.y < -0.75, slab = n.y > 0.12, steep = n.y < -0.25;
    const hands = ['LH', 'RH'].filter((l) => cur[l]), feet = ['LF', 'RF'].filter((l) => cur[l]), knees = ['LK', 'RK'].filter((l) => cur[l]);
    const H = hands.length ? avg(hands.map((l) => cur[l].E.clone())) : null;
    const F = feet.length ? avg(feet.map((l) => cur[l].E.clone())) : null;
    const hf = H && F ? unit(H.clone().sub(F)) : null;
    const want = roof ? (hf ? hf.clone() : UP.clone()) : UP.clone().addScaledVector(hf || UP, 0.8);
    unit(want);
    const heavy = feet.find((l) => (this.weight?.[l] || 1) > 1);
    const base = heavy ? cur[heavy].E.clone()  // where the weight goes
      : F && H ? F.clone().lerp(H, steep || roof ? 0.45 : 0.2) : (F || H).clone();
    return {
      n, roof, slab, steep, hands, feet, knees, H, F, want, base,
      O: avg(have.map((l) => cur[l].C.clone())),  // a point on the wall near the climber
      hipOff: roof ? 0.42 : slab ? 0.32 : steep ? 0.24 : 0.22, chestOff: roof ? 0.4 : slab ? 0.3 : 0.26,
      balance: steep || roof ? 1 : heavy ? 6 : 4,
      // temporal anchor: the torso eases toward its best position over a few frames instead of jumping there
      prev: this.body && this.settled ? { P: this.body.P.clone(), u: this.body.u.clone() } : null,
    };
  }

  _energy(c, x) {  // x = [P.x, P.y, P.z, q.x, q.y, q.z]; u = q / |q|
    const P = this._P.set(x[0], x[1], x[2]), ql = Math.hypot(x[3], x[4], x[5]) || 1e-9;
    const u = this._u.set(x[3] / ql, x[4] / ql, x[5] / ql);
    const S = this._S.copy(P).addScaledVector(u, B.spine);
    const r = this._r.copy(this.r).addScaledVector(u, -this.r.dot(u));
    unit(r, this._side).applyAxisAngle(u, this.twist);
    const sq = (v) => v * v, J = this._J, cur = this.cur;
    let e = sq(ql - 1);
    for (const l of c.hands) {  // arms: comfortable from bent to nearly straight, never over-reaching
      const d = J.copy(S).addScaledVector(r, side(l) * B.shoulder).distanceTo(cur[l].E);
      e += 2 * sq(Math.max(0, d - 0.5)) + 1 * sq(Math.max(0, 0.32 - d)) + 300 * sq(Math.max(0, d - ARM + 0.01)) + 80 * sq(Math.max(0, 0.2 - d));
    }
    for (const l of c.feet) {  // legs: a stance leg is bent (~0.6-0.68 m hip to ankle); a trailing leg may straighten
      const w = this.weight?.[l] || 1, d = J.copy(P).addScaledVector(r, side(l) * B.hip).distanceTo(cur[l].E);
      e += w * (1.5 * sq(d - (w > 1 ? 0.6 : 0.68)) + 3 * sq(Math.max(0, 0.45 - d)) + 3 * sq(Math.max(0, d - 0.8)))
        + 300 * sq(Math.max(0, d - LEG + 0.03)) + 150 * sq(Math.max(0, 0.3 - d));
    }
    for (const l of c.knees) {
      const d = J.copy(P).addScaledVector(r, side(l) * B.hip).distanceTo(cur[l].E);
      e += 300 * sq(d - B.thigh);
    }
    const hip = J.copy(P).sub(c.O).dot(c.n), chest = this._J2.copy(S).sub(c.O).dot(c.n);
    e += 4 * sq(hip - c.hipOff) + 200 * sq(Math.max(0, 0.13 - hip));
    e += 3 * sq(chest - c.chestOff) + 200 * sq(Math.max(0, 0.15 - chest));
    e += c.balance * sq(J.copy(P).sub(c.base).dot(r));  // hips over the feet, side to side
    e += 1.5 * u.distanceToSquared(c.want);
    if (c.prev) e += 25 * P.distanceToSquared(c.prev.P) + 6 * u.distanceToSquared(c.prev.u);
    return e;
  }

  _solve(iterations) {
    const c = this._setup();
    if (!c) { this.body = null; return; }
    this._P ??= new V3(); this._u ??= new V3(); this._S ??= new V3(); this._r ??= new V3();
    this._J ??= new V3(); this._J2 ??= new V3(); this._side ??= new V3(1, 0, 0);
    let x;
    if (this.body) x = [...this.body.P.toArray(), ...this.body.u.toArray()];
    else {
      const P0 = c.F ? c.F.clone().addScaledVector(c.roof ? c.want : UP, 0.55) : c.H.clone().addScaledVector(DOWN, 1.0);
      x = [...P0.addScaledVector(c.n, c.hipOff).toArray(), ...c.want.toArray()];
    }
    // gradient descent with central-difference gradients and an adaptive step (allocation-light: ~25 steps a frame)
    let e = this._energy(c, x), step = this._step || 0.01;
    const g = new Array(6), y = new Array(6), h = 1e-4;
    for (let it = 0; it < iterations; it++) {
      let gl = 0;
      for (let k = 0; k < 6; k++) {
        const v = x[k];
        x[k] = v + h; const ep = this._energy(c, x);
        x[k] = v - h; const em = this._energy(c, x);
        x[k] = v; g[k] = (ep - em) / (2 * h); gl += g[k] * g[k];
      }
      if (gl < 1e-12) break;
      gl = Math.sqrt(gl);
      let moved = false;
      for (let tries = 0; tries < 10; tries++) {
        for (let k = 0; k < 6; k++) y[k] = x[k] - (step * g[k]) / gl;
        const ey = this._energy(c, y);
        if (ey < e) { x = y.slice(); e = ey; step = Math.min(step * 1.5, 0.2); moved = true; break; }
        step *= 0.4;
      }
      if (!moved) break;
    }
    this._step = Math.max(step, 0.002);
    const P = new V3(x[0], x[1], x[2]);
    let u = unit(new V3(x[3], x[4], x[5]));
    let S = P.clone().addScaledVector(u, B.spine);
    if (c.prev) {  // never lurch: the pelvis and chest move at most BODY_SPEED
      const prevS = c.prev.P.clone().addScaledVector(c.prev.u, B.spine);
      const max = BODY_SPEED * frameDt, clamp = (X, X0) => { const d = X.clone().sub(X0), l = d.length(); if (l > max) X.copy(X0).addScaledVector(d, max / l); };
      clamp(P, c.prev.P); clamp(S, prevS);
      u = unit(S.clone().sub(P), u);
      S = P.clone().addScaledVector(u, B.spine);
    }
    const r = unit(perp(this.r, u), new V3(1, 0, 0)).applyAxisAngle(u, this.twist);
    const joint = {
      LH: S.clone().addScaledVector(r, -B.shoulder), RH: S.clone().addScaledVector(r, B.shoulder),
      LF: P.clone().addScaledVector(r, -B.hip), RF: P.clone().addScaledVector(r, B.hip),
    };
    for (const l of ['LH', 'RH']) {  // shoulders rise toward the ears on a long reach
      if (!this.cur[l]) continue;
      const reach = this.cur[l].E.clone().sub(joint[l]).dot(u);
      joint[l].addScaledVector(u, THREE.MathUtils.clamp(reach - 0.25, 0, 0.3) * 0.18);
    }
    joint.LK = joint.LF; joint.RK = joint.RF;
    this.body = { S, P, u, r, n: c.n, O: c.O, joint, energy: e };
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

  _steady(l, root, mid, end) {
    const last = this.last[l];
    if (last) {
      const allowed = MID_SLACK * frameDt + 1.5 * Math.max(root.distanceTo(last.root), end.distanceTo(last.end));
      const d = mid.clone().sub(last.mid), len = d.length();
      if (len > allowed) mid = last.mid.clone().addScaledVector(d, allowed / len);
    }
    this.last[l] = { root: root.clone(), mid: mid.clone(), end: end.clone() };
    return mid;
  }

  _draw() {
    const b = this.body, m = this.m, cur = this.cur;
    this.group.visible = !!b;
    if (!b) return;
    const { S, P, u, r, n } = b;
    this.dbg = {};  // joint positions, for tests
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
      // elbows: down, a little out and back for a pull; out for a gaston; under the hand for an undercling;
      // back and up for a palm press
      const pole = q?.mode === 'palm' ? n.clone().addScaledVector(o, 0.6).addScaledVector(UP, 0.3)
        : q?.mode === 'gaston' ? o.clone().addScaledVector(n, 0.3).addScaledVector(DOWN, 0.2)
        : f.dot(UP) < -0.5 || q?.mode === 'undercling' ? DOWN.clone().addScaledVector(n, 0.8).addScaledVector(o, 0.2)
        : DOWN.clone().multiplyScalar(0.8).addScaledVector(o, 0.5).addScaledVector(n, 0.4);
      const El = this._steady(l, J, ik(J, W, B.upper, B.fore, pole, this.memo, l, n, 0.3), W);
      this.dbg[l] = { root: J.clone(), mid: El.clone(), end: W.clone() };
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
      // knees: out to the side and away from the wall (frog); down and in for a drop-knee; up and out for a heel hook
      const pole = q.mode === 'heel' ? o.clone().multiplyScalar(0.6).addScaledVector(UP, 0.6).addScaledVector(n, 0.4)
        : q.mode === 'drop-knee' ? DOWN.clone().multiplyScalar(0.8).addScaledVector(o, -0.25).addScaledVector(n, 0.1)
        : q.mode === 'flag' ? n.clone().multiplyScalar(0.5).addScaledVector(o, 0.2).addScaledVector(UP, 0.2)
        : o.clone().multiplyScalar(0.8).addScaledVector(n, 0.6).addScaledVector(UP, 0.25);
      const Kn = this._steady(l, J, K ? K.E.clone() : ik(J, q.E, B.thigh, B.shin, pole, this.memo, l, n, q.mode === 'drop-knee' ? -0.1 : 0.25), q.E);
      this.dbg[l] = { root: J.clone(), mid: Kn.clone(), end: q.E.clone() };
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
