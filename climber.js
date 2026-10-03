// The climber that acts out a problem: hands and feet on the holds of the current move and, when the problem's
// moves have `body` entries, a simple body joining them.
// - Hands lie flat on the hold, fingers pointing the way the hold's edge faces (up for a jug, sideways for a sidepull,
//   down for an undercling), wrist on the other side.
// - Shoes are placed by the move's per-limb style: edge (toe on, foot turned out on its inside edge), smear,
//   drop-knee (outside edge, toes turned in), heel hook, toe hook, toe press. A kneebar knee shows as a small marker.
// - Body: the hips come from the move's `body.hips` (authored, not guessed: the same holds allow many body
//   positions and that choice is the beta), turned by `body.turn`; the chest leans from the hips toward the hands.
//   If a hand or foot can't reach its hold the hips/chest are nudged just enough. Each elbow and knee is then picked
//   from every position its limb allows by an anatomical score (see _elbowCost/_kneeCost): the forearm comes from
//   the side the hand pulls toward, knees point over the toes, hips and shoulders can't bend backwards, nothing goes
//   through the torso or the wall. `body.elbows` / `body.knees` can force a direction for one limb.
// - A limb with no hold flags (feet) or hangs (hands) when there is a body; without one it fades out.
// Next/Prev move each changing limb along an arc off the wall with a fading dotted trail, feet first (hands first on
// a dynamic move); the hips lead and arrive as the last limb lands; the limb that just moved stays highlighted.
import * as THREE from 'three';

const V3 = THREE.Vector3, UP = new V3(0, 1, 0), DOWN = new V3(0, -1, 0);
const FOOT = 0.25;  // shoe length, metres
// a 1.75 m climber (metres)
const B = { upper: 0.29, fore: 0.27, thigh: 0.44, shin: 0.43, shoulder: 0.19, hip: 0.095, spine: 0.47 };
const ARM = B.upper + B.fore, LEG = B.thigh + B.shin;
const MOVE_TIME = 0.8, STAGGER = 0.45, TRAIL_TIME = 2.4;  // seconds
const TURN_SPEED = 4;  // rad/s: how fast an elbow or knee may swing round its limb (stops flips between moves)
const BODY_SPEED = 1.2;  // m/s: fastest the hips/chest move
const LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK'];
const OFFSET = { LH: -1, RH: 1, LF: -1, RF: 1, LK: 0, RK: 0 };  // two limbs on one hold sit side by side
const side = (l) => (l[0] === 'L' ? -1 : 1);
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
const unit = (v, fallback = UP) => (v.lengthSq() > 1e-8 ? v.normalize() : v.copy(fallback));
const perp = (v, n) => v.clone().addScaledVector(n, -v.dot(n));  // v with its n component removed
const avg = (vs) => vs.reduce((t, v) => t.add(v), new V3()).divideScalar(Math.max(1, vs.length));
const segDist = (X, A, C) => {  // distance from X to the segment A-C
  const d = C.clone().sub(A), t = THREE.MathUtils.clamp(X.clone().sub(A).dot(d) / Math.max(d.lengthSq(), 1e-9), 0, 1);
  return X.distanceTo(A.clone().addScaledVector(d, t));
};

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
  // problem: with _holds; frame(h) -> {pos, x, y, z}; size(h) -> [w, h, depth]; colours: {LH: '#..', ...};
  // place([along, height, out], wallId?) -> world point for body positions (null: hands and feet only)
  constructor({ problem, step, frame, size, colours, place, scale = 1, dotSize = 7 }) {
    Object.assign(this, { p: problem, frame, size, colours, place, scale, dotSize });
    this.hasBody = !!place && problem.moves.some((m) => m.body);
    this.t = 0; this.dt = 1e9; this.anims = []; this.trails = []; this.moved = new Set(LIMBS);
    this.memo = {};  // last bend direction of each elbow/knee
    this.group = new THREE.Group();
    this.dot = dotTexture();
    this._buildMeshes();
    this.cur = this._targets(step);
    this.alpha = Object.fromEntries(LIMBS.map((l) => [l, this.cur[l] ? 1 : 0]));
    this.bodyAnim = null;
    if (this.hasBody) this._updateBody();
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
    if (this.hasBody) {
      this.bodyTarget = this._bodyTarget(m, poses, n);
      const fr = this._axes(this.bodyTarget);
      for (const l of ['LH', 'RH', 'LF', 'RF']) if (!poses[l]) poses[l] = this._free(l, this.bodyTarget, fr, poses);
    }
    return poses;
  }

  _pose(l, m, style) {
    const h = m[l] && this.p._holds.get(m[l]), f = h && this.frame(h);
    if (!f) return null;
    const [sw, sh, sd] = this.size(h), n = f.z.clone();
    const out = this.right.clone().multiplyScalar(side(l));  // away from the body's midline
    const C = f.pos.clone().addScaledVector(f.x, OFFSET[l] * Math.min(0.06, sw / 2 + 0.02))
      .addScaledVector(n, h.type === 'volume' ? sd * 0.55 : h.type === 'arete' || h.type === 'spot' ? 0.01 : sd * 0.7 + 0.01);
    if (h.type === 'volume') C.addScaledVector(f.y, sh * (l[1] === 'H' ? 0.3 : -0.2));  // hands on its top, feet on its lower facets
    if (l[1] === 'K') return { kind: 'K', C, n, mode: 'knee' };
    if (l[1] === 'H') {
      const mode = style || (h.grip === 'palm' ? 'palm' : 'grip');
      const dirs = { up: f.y, down: f.y.clone().negate(), left: f.x.clone().negate(), right: f.x };
      let fd = h.facing ? dirs[h.facing].clone() : h.type === 'arete' ? out.clone() : f.y.clone();
      if (mode === 'undercling') fd = f.y.clone().negate();
      if (mode === 'gaston') fd = out.clone().negate();
      fd = unit(perp(fd, n), f.y);
      const W = C.clone().addScaledVector(fd, -0.15 * this.scale).addScaledVector(n, 0.025);  // wrist
      return { kind: 'H', C, n, f: fd, W, mode };
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
    const E = mode === 'heel' ? heel.clone().addScaledVector(d, 0.05).addScaledVector(s, 0.07)  // ankle
      : heel.clone().lerp(toe, 0.25).addScaledVector(s, 0.07);
    return { kind: 'F', C, n, d, s, toe, heel, E, mode };
  }

  // ---- the body ----
  _bodyTarget(m, poses, n) {
    const b = m.body || {}, hands = ['LH', 'RH'].filter((l) => poses[l]), feet = ['LF', 'RF'].filter((l) => poses[l]);
    const H = hands.length ? avg(hands.map((l) => poses[l].W.clone())) : null;
    const F = feet.length ? avg(feet.map((l) => poses[l].E.clone())) : null;
    let P = b.hips && this.place(b.hips, b.wall);
    if (!P) {  // no body for this move: hips above the feet (or below the hands), out from the wall
      P = F ? F.clone().addScaledVector(UP, 0.6) : H.clone().addScaledVector(DOWN, 1.0);
      P.addScaledVector(n, 0.3);
    }
    const back = unit(perp(n.clone(), UP), n);
    let S = b.chest && this.place(b.chest, b.wall);
    if (!S) {  // the spine leans from the hips toward the hands; `lean` (degrees) tips the chest back off the wall
      const u = UP.clone();
      if (H) u.addScaledVector(unit(H.clone().sub(P)), 0.6);
      unit(u).addScaledVector(back, Math.tan(THREE.MathUtils.degToRad(b.lean || 0)));
      S = P.clone().addScaledVector(unit(u), B.spine);
    }
    S = P.clone().addScaledVector(unit(S.sub(P)), B.spine);
    return { P, S, n: n.clone(), turn: THREE.MathUtils.degToRad(b.turn || 0), elbows: b.elbows || {}, knees: b.knees || {} };
  }

  // body axes: u up the spine; for the pelvis and the chest, r = the climber's right and back = away from the wall.
  // turn > 0 brings the right hip in to the wall (the chest turns about half as far).
  _axes({ P, S, n, turn }) {
    const u = unit(S.clone().sub(P));
    const back = unit(perp(n.clone(), u), perp(this.right.clone().cross(u), u));
    const right = u.clone().cross(back);
    const rot = (t) => {
      const r = right.clone().multiplyScalar(Math.cos(t)).addScaledVector(back, -Math.sin(t));
      return { r, back: r.clone().cross(u) };
    };
    return { u, pelvis: rot(turn), chest: rot(turn * 0.45) };
  }

  _joint(l, P, S, fr) {  // shoulder or hip socket
    return l[1] === 'H' ? S.clone().addScaledVector(fr.chest.r, side(l) * B.shoulder) : P.clone().addScaledVector(fr.pelvis.r, side(l) * B.hip);
  }

  _free(l, body, fr, poses) {  // a hand with no hold hangs; a foot with no hold flags out (or dangles on steep ground)
    const J = this._joint(l, body.P, body.S, fr), n = body.n, o = fr.chest.r.clone().multiplyScalar(side(l));
    if (l[1] === 'H') {
      const W = J.clone().addScaledVector(DOWN, 0.5).addScaledVector(o, 0.1).addScaledVector(fr.chest.back, 0.1);
      return { kind: 'H', C: W.clone(), W, n: n.clone(), f: UP.clone(), mode: 'free', free: true };
    }
    const both = !poses.LF && !poses.RF, dangle = both || n.y < -0.25;
    const E = dangle ? J.clone().addScaledVector(DOWN, both ? 0.8 : 0.62).addScaledVector(o, 0.08).addScaledVector(n, both ? 0 : 0.12)
      : J.clone().addScaledVector(DOWN, 0.62).addScaledVector(o, 0.42);
    for (const q of Object.values(poses)) {  // keep the foot in front of every surface the climber is on
      if (!q || q.free) continue;
      const d = E.clone().sub(q.C).dot(q.n);
      if (d < 0.08) E.addScaledVector(q.n, 0.08 - d);
    }
    E.y = Math.max(E.y, 0.08);
    const d = unit(DOWN.clone().multiplyScalar(dangle ? 0.8 : 0.3).addScaledVector(o, dangle ? 0.1 : 0.6).addScaledVector(n, -0.2));
    const s = unit(perp(n.clone(), d), UP);
    return { kind: 'F', C: E.clone(), E, n: n.clone(), d, s, heel: E.clone().addScaledVector(d, -0.06).addScaledVector(s, -0.07),
      toe: E.clone().addScaledVector(d, 0.19).addScaledVector(s, -0.07), mode: 'flag', free: true };
  }

  // The body this frame: the hips/chest eased between moves, then nudged so every placed hand and foot is in reach
  // and the torso stays in front of the surfaces being climbed.
  _updateBody() {
    const a = this.bodyAnim, T = this.bodyTarget;
    let P, S, n, turn;
    if (a) {
      const e = ease(THREE.MathUtils.clamp((this.t - a.start) / a.dur, 0, 1));
      P = a.from.P.clone().lerp(T.P, e); S = a.from.S.clone().lerp(T.S, e);
      n = unit(a.from.n.clone().lerp(T.n, e), T.n); turn = a.from.turn + (T.turn - a.from.turn) * e;
    } else ({ P, S, n, turn } = { P: T.P.clone(), S: T.S.clone(), n: T.n.clone(), turn: T.turn });
    const cur = this.cur, planes = LIMBS.filter((l) => cur[l] && !cur[l].free).map((l) => [cur[l].C, cur[l].n]);
    let fr;
    for (let it = 0; it < 10; it++) {
      S = P.clone().addScaledVector(unit(S.clone().sub(P)), B.spine);
      fr = this._axes({ P, S, n, turn });
      let moved = false;
      for (const l of ['LH', 'RH', 'LF', 'RF', 'LK', 'RK']) {
        const q = cur[l];
        if (!q || q.free || q.flying) continue;  // a limb in the air doesn't hold the body
        const end = l[1] === 'H' ? q.W : l[1] === 'F' ? q.E : q.C, J = this._joint(l[1] === 'K' ? l[0] + 'F' : l, P, S, fr);
        const max = l[1] === 'H' ? ARM * 0.985 : l[1] === 'F' ? LEG * 0.98 : B.thigh, min = l[1] === 'H' ? 0.18 : l[1] === 'F' ? 0.36 : 0;
        const d = end.clone().sub(J), len = d.length(), over = len > max ? len - max : len < min ? len - min : 0;  // < 0: too folded
        if (Math.abs(over) <= 1e-4) continue;
        d.normalize(); moved = true;
        if (l[1] === 'H') { S.addScaledVector(d, over); P.addScaledVector(d, over * 0.3); }
        else { P.addScaledVector(d, over * 0.9); S.addScaledVector(d, over * 0.5); }
      }
      for (const X of [P, S]) for (const [C, nn] of planes) {  // in front of the wall
        const dd = X.clone().sub(C).dot(nn);
        if (dd < 0.12 && X.distanceTo(C) < 1.2) { X.addScaledVector(nn, 0.12 - dd); moved = true; }
      }
      if (!moved) break;
    }
    if (this.body) {  // never lurch: when a limb lands and pulls the body into reach, it eases there
      const max = BODY_SPEED * this.dt;
      for (const [X, X0] of [[P, this.body.P], [S, this.body.S]]) {
        const d = X.clone().sub(X0), len = d.length();
        if (len > max) X.copy(X0).addScaledVector(d, max / len);
      }
    }
    S = P.clone().addScaledVector(unit(S.clone().sub(P)), B.spine);
    fr = this._axes({ P, S, n, turn });
    this.body = { P, S, n, turn, fr, planes };
  }

  _wallCost(X, planes) {
    let e = 25 * Math.max(0, 0.06 - X.y);  // the mat
    for (const [C, n] of planes) if (X.distanceTo(C) < 1.0) e += 15 * Math.max(0, 0.05 - X.clone().sub(C).dot(n));
    return e;
  }

  // Elbow score for a candidate bend direction b (elbow at E): lower is better.
  _elbowCost(l, q, J, W) {
    const { P, S, fr, planes } = this.body, o = fr.chest.r.clone().multiplyScalar(side(l)), back = fr.chest.back;
    const mode = q.mode, pref = this._pref(this.bodyTarget.elbows[l], o, back, fr.u);
    // the forearm runs from the wrist toward the side the hand pulls to: opposite the fingers for a pull, down for an
    // undercling, out to the side for a gaston, up and back (elbow raised) for a palm press
    const want = mode === 'palm' ? unit(UP.clone().multiplyScalar(0.5).addScaledVector(back, 0.8).addScaledVector(o, 0.4))
      : mode === 'undercling' ? unit(DOWN.clone().addScaledVector(back, 0.5).addScaledVector(o, 0.3))
      : mode === 'gaston' ? unit(o.clone().addScaledVector(DOWN, 0.3).addScaledVector(back, 0.2))
      : mode === 'free' ? unit(DOWN.clone().addScaledVector(back, 0.3))
      : unit(q.f.clone().negate().addScaledVector(back, 0.3).addScaledVector(o, 0.2));
    const latMin = Math.min(0.08, W.clone().sub(S).dot(o) - 0.05);  // a hand reaching across lets its elbow follow
    const hang = mode === 'gaston' || mode === 'palm' ? 0 : 0.3;
    return (b, E) => {
      let e = 1.2 * (1 - unit(E.clone().sub(W)).dot(want)) + hang * b.y;
      e += 4 * Math.max(0, unit(E.clone().sub(J)).dot(back) - (mode === 'palm' ? 0.95 : 0.5));  // shoulder can't swing the elbow far back
      e += 3 * Math.max(0, latMin - E.clone().sub(S).dot(o));  // elbows stay on their own side
      e += 6 * Math.max(0, 0.13 - segDist(E, P, S));  // not through the torso
      e += this._wallCost(E, planes);
      if (pref) e += 2 * (1 - b.dot(pref));
      return e;
    };
  }

  // Knee score: the kneecap points over the toes; the hip can't extend backwards or cross far over the midline.
  _kneeCost(l, q, J) {
    const { P, S, fr, planes } = this.body, o = fr.pelvis.r.clone().multiplyScalar(side(l)), back = fr.pelvis.back;
    const into = back.clone().negate(), mode = q.mode, pref = this._pref(this.bodyTarget.knees[l], o, back, fr.u);
    const want = mode === 'heel' ? unit(UP.clone().multiplyScalar(0.7).addScaledVector(o, 0.4).addScaledVector(back, 0.3))
      : mode === 'drop-knee' ? unit(DOWN.clone().addScaledVector(o, -0.6).addScaledVector(into, 0.2))
      : mode === 'toe-hook' ? q.s.clone()
      : mode === 'flag' ? unit(into.clone().multiplyScalar(0.5).addScaledVector(DOWN, 0.3).addScaledVector(o, 0.3))
      : unit(q.d.clone().addScaledVector(o, 0.3));
    const cross = mode === 'drop-knee' ? 0.55 : 0.3;
    return (b, K) => {
      const th = unit(K.clone().sub(J));
      let e = 1.5 * (1 - b.dot(want));
      e += 5 * Math.max(0, th.dot(back) - 0.3) + 4 * Math.max(0, -th.dot(o) - cross);
      e += 3 * Math.max(0, b.dot(back) - 0.5);  // a kneecap can't face away from the wall
      e += 6 * Math.max(0, 0.12 - segDist(K, P, S));
      e += this._wallCost(K, planes);
      if (pref) e += 2 * (1 - b.dot(pref));
      return e;
    };
  }

  _pref(word, o, back, u) {  // `body.elbows` / `body.knees` words -> direction
    return { out: o, in: o.clone().negate(), up: u, down: u.clone().negate(), back, wall: back.clone().negate() }[word] || null;
  }

  // Middle joint (elbow/knee) of a two-bone limb: try every bend direction round the root-end line, keep the best
  // by `cost` (plus a little for staying where it was), and swing there at most TURN_SPEED. Past full reach the bones
  // stretch slightly so the hand/foot stays on its hold.
  _mid(key, root, end, l1, l2, cost) {
    const v = end.clone().sub(root), len = Math.max(v.length(), 1e-4), dir = v.clone().divideScalar(len);
    const k = Math.max(1, len / ((l1 + l2) * 0.999)), s1 = l1 * k, s2 = l2 * k;
    const a = (s1 * s1 - s2 * s2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, s1 * s1 - a * a));
    const c = root.clone().addScaledVector(dir, a);
    const e1 = unit(perp(Math.abs(dir.y) < 0.9 ? UP.clone() : new V3(1, 0, 0), dir)), e2 = dir.clone().cross(e1);
    const prev = this.memo[key] && perp(this.memo[key], dir).lengthSq() > 1e-4 ? unit(perp(this.memo[key], dir)) : null;
    const at = (th) => e1.clone().multiplyScalar(Math.cos(th)).addScaledVector(e2, Math.sin(th));
    const hh = Math.max(h, 0.08), N = 48;
    const f = (th) => { const b = at(th); return cost(b, c.clone().addScaledVector(b, hh)) + (prev ? 0.4 * (1 - b.dot(prev)) : 0); };
    const costs = Array.from({ length: N }, (_, i) => f((i * 2 * Math.PI) / N));
    let best = 0;
    for (let i = 1; i < N; i++) if (costs[i] < costs[best]) best = i;
    const y0 = costs[(best + N - 1) % N], y1 = costs[best], y2 = costs[(best + 1) % N], den = y0 - 2 * y1 + y2;
    const off = den > 1e-9 ? THREE.MathUtils.clamp((0.5 * (y0 - y2)) / den, -0.5, 0.5) : 0;
    let pd = at(((best + off) * 2 * Math.PI) / N);
    if (prev) {
      const ang = Math.acos(THREE.MathUtils.clamp(prev.dot(pd), -1, 1)), max = TURN_SPEED * this.dt;
      if (ang > max) pd = prev.clone().applyAxisAngle(unit(prev.clone().cross(pd), dir), max);
    }
    this.memo[key] = pd.clone();
    return c.addScaledVector(pd, h);
  }

  // ---- moving between moves ----
  goTo(i) {
    for (const a of this.anims) if (!a.done && a.live) this.cur[a.l] = a.live;  // carry on from mid-flight
    for (const tr of this.trails.filter((q) => q.start > this.t)) this._dropTrail(tr);
    this.trails = this.trails.filter((q) => q.start <= this.t);
    const from = this.body && { P: this.body.P.clone(), S: this.body.S.clone(), n: this.body.n.clone(), turn: this.body.turn };
    const m = this.p.moves[i], next = this._targets(i), hand = (l) => (l[1] === 'H' ? 1 : 0), order = m.dynamic ? -1 : 1;
    const key = (q) => (q.free ? 'free' : q.mode);
    const same = (a, b) => (!a && !b) || (a && b && a.C.distanceTo(b.C) < 1e-3 && key(a) === key(b));
    const changes = LIMBS.filter((l) => !same(this.cur[l], next[l])).sort((a, b) => (hand(a) - hand(b)) * order);
    this.anims = changes.map((l, k) => {
      const from = this.cur[l] || next[l], to = next[l] || this.cur[l];  // appearing/disappearing limbs fade in place
      const fade = !this.cur[l] ? 'in' : !next[l] ? 'out' : null;
      const dur = m.dynamic && hand(l) ? 0.5 : MOVE_TIME, start = this.t + k * STAGGER * (m.dynamic ? 0.6 : 1);
      const lift = fade ? 0 : Math.min(0.25, 0.08 + from.C.distanceTo(to.C) * 0.12);
      const arcN = unit(from.n.clone().add(to.n), from.n);
      const pt = (a, b, e) => a.clone().lerp(b, e).addScaledVector(arcN, Math.sin(Math.PI * e) * lift);
      if (!fade && !from.free && !to.free) {
        const trail = new THREE.Points(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 16 }, (_, j) => pt(from.C, to.C, j / 15))),
          new THREE.PointsMaterial({ map: this.dot, color: this.colours[l], size: this.dotSize, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false }));
        this.group.add(trail);
        this.trails.push({ obj: trail, start, end: start + dur });
      }
      return { l, from, to, final: next[l], fade, pt, start, dur, done: false, live: null };
    });
    this.moved = new Set(changes);
    if (from) {  // the hips lead: they get there as the last limb lands (with the hands on a dynamic move)
      const end = Math.max(MOVE_TIME, ...this.anims.map((a) => a.start + a.dur - this.t));
      this.bodyAnim = { from, start: this.t, dur: m.dynamic ? end : Math.max(0.5, end - 0.3) };
    }
  }

  _dropTrail(tr) { this.group.remove(tr.obj); tr.obj.geometry.dispose(); tr.obj.material.dispose(); }

  _lerpPose(a, b, e, pt) {
    const q = { kind: a.kind, mode: e < 0.5 ? a.mode : b.mode, free: e < 0.5 ? a.free : b.free };
    for (const k of ['C', 'W', 'E', 'toe', 'heel']) if (a[k] && b[k]) q[k] = pt(a[k], b[k], e);
    for (const k of ['n', 'f', 'd', 's']) if (a[k] && b[k]) q[k] = unit(a[k].clone().lerp(b[k], e), b[k]);
    return q;
  }

  update(dt) {
    this.t += dt;
    this.dt = Math.min(Math.max(dt, 1 / 240), 0.1);
    for (const a of this.anims) {
      if (a.done || this.t < a.start) continue;
      const u = Math.min(1, (this.t - a.start) / a.dur), e = ease(u);
      a.live = this._lerpPose(a.from, a.to, e, a.pt);
      a.live.flying = u < 1;
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
    if (this.hasBody) this._updateBody();
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
    if (!this.hasBody) return;
    // mannequin: torso blobs, limbs as cylinders with round joints; elbows and knees in the limb's colour
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9d3c9, roughness: 0.85 });
    const part = (geo, mat = skin) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; this.group.add(m); return m; };
    const cyl = () => part(new THREE.CylinderGeometry(1, 1, 1, 14));
    const ball = (mat) => part(new THREE.SphereGeometry(1, 18, 12), mat);
    const jointMat = (l) => new THREE.MeshStandardMaterial({ color: this.colours[l], roughness: 0.6, emissive: this.colours[l], emissiveIntensity: 0.2 });
    this.m.body = {
      chest: ball(), belly: ball(), pelvis: ball(), head: ball(), neck: cyl(),
      bones: Object.fromEntries(['LH', 'RH', 'LF', 'RF'].map((l) => [l, [cyl(), cyl()]])),
      roots: Object.fromEntries(['LH', 'RH', 'LF', 'RF'].map((l) => [l, ball()])),
      mids: Object.fromEntries(['LH', 'RH', 'LF', 'RF'].map((l) => [l, ball(jointMat(l))])),
      ends: Object.fromEntries(['LH', 'RH', 'LF', 'RF'].map((l) => [l, ball()])),
    };
  }

  _draw() {
    const cur = this.cur, m = this.m, body = this.hasBody;
    const fadeTo = (mesh, a) => { mesh.traverse((o) => { if (o.material) o.material.opacity = a; }); mesh.visible = a > 0.01; };
    for (const l of ['LH', 'RH']) {  // flat on the hold, fingers along f, back of the hand facing out
      const q = cur[l], hm = m.hands[l];
      hm.visible = !!q && !q.free && this.alpha[l] > 0.01;
      if (!hm.visible) continue;
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
      fadeTo(shoe, body ? (q.free ? 0.55 : 1) : this.alpha[l]);
    }
    for (const l of ['LK', 'RK']) {
      const q = cur[l], knee = m.knees[l];
      if (!q) { knee.visible = false; continue; }
      knee.position.copy(q.C);
      fadeTo(knee, this.alpha[l]);
    }
    if (body) this._drawBody();
  }

  _drawBody() {
    const { P, S, fr } = this.body, mb = this.m.body, cur = this.cur;
    this.dbg = {};  // joint positions, for tests
    const blob = (mesh, c, ax, rx, ry, rz) => {
      mesh.position.copy(c);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(ax.r, fr.u, ax.back));
      mesh.scale.set(rx, ry, rz);
    };
    const u = fr.u;
    blob(mb.chest, S.clone().addScaledVector(u, -0.13), fr.chest, 0.17, 0.19, 0.1);
    blob(mb.belly, S.clone().lerp(P, 0.62), fr.pelvis, 0.13, 0.15, 0.09);
    blob(mb.pelvis, P.clone().addScaledVector(u, 0.02), fr.pelvis, 0.155, 0.1, 0.1);
    blob(mb.head, S.clone().addScaledVector(u, 0.24).addScaledVector(fr.chest.back, 0.02), fr.chest, 0.085, 0.11, 0.095);
    const bone = (mesh, a, c, rad) => {
      const d = c.clone().sub(a), len = d.length();
      mesh.position.copy(a).addScaledVector(d, 0.5);
      mesh.scale.set(rad, Math.max(len, 1e-3), rad);
      if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, d.divideScalar(len));
    };
    const ball = (mesh, c, r) => { mesh.position.copy(c); mesh.scale.setScalar(r); };
    bone(mb.neck, S, S.clone().addScaledVector(u, 0.14), 0.045);
    for (const l of ['LH', 'RH']) {
      const q = cur[l];
      if (!q) continue;
      const J = this._joint(l, P, S, fr);
      const reach = q.W.clone().sub(J).dot(u);  // shoulders rise toward the ears on a long reach
      J.addScaledVector(u, THREE.MathUtils.clamp(reach - 0.25, 0, 0.3) * 0.18);
      const E = this._mid(l, J, q.W, B.upper, B.fore, this._elbowCost(l, q, J, q.W));
      this.dbg[l] = { root: J.clone(), mid: E.clone(), end: q.W.clone() };
      bone(mb.bones[l][0], J, E, 0.043); bone(mb.bones[l][1], E, q.W, 0.034);
      ball(mb.roots[l], J, 0.055); ball(mb.mids[l], E, 0.042); ball(mb.ends[l], q.W, 0.032);
    }
    for (const l of ['LF', 'RF']) {
      const q = cur[l];
      if (!q) continue;
      const J = this._joint(l, P, S, fr), kb = cur[l[0] + 'K'];
      const K = kb && !kb.free ? kb.C.clone() : this._mid(l, J, q.E, B.thigh, B.shin, this._kneeCost(l, q, J));
      this.dbg[l] = { root: J.clone(), mid: K.clone(), end: q.E.clone() };
      bone(mb.bones[l][0], J, K, 0.062); bone(mb.bones[l][1], K, q.E, 0.045);
      ball(mb.roots[l], J, 0.064); ball(mb.mids[l], K, 0.052); ball(mb.ends[l], q.E, 0.038);
    }
  }
}
