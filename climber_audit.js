// Dev check for the climber animation. In the browser console on the viewer page:
//   const a = await import('./climber_audit.js'); a.posture(); a.jitter();
// posture(): the settled pose of every move of every problem (arm/leg reach, how far hips and chest sit off the wall,
//   spine lean, whether knees and elbows bend away from the wall).
// jitter(): steps through every move at 60 fps and flags frames where the torso lurches or an elbow/knee moves much
//   faster than the shoulder/hip and hand/foot either side of it (thresholds are per frame at `fps`).
const LIMBS = ['LH', 'RH', 'LF', 'RF'];

function run(onFrame, onMove, fps = 60) {
  const v = window.viewer, probs = v.problems();
  for (let pi = 0; pi < probs.length; pi++) {
    v.selectProblem(pi);
    const c = v.climber();
    for (let s = 0; s < probs[pi].moves.length; s++) {
      if (s) v.setStep(s);
      for (let f = 0; f < 2.5 * fps; f++) { v.animateClimber(1 / fps); onFrame?.(c, probs[pi], s, f); }
      onMove?.(c, probs[pi], s);
    }
  }
}

export function posture() {
  const rows = [];
  run(null, (c, p, s) => {
    const b = c.body, d = c.dbg, off = (X) => X.clone().sub(b.O).dot(b.n).toFixed(2);
    const len = (l) => (d[l] ? d[l].root.distanceTo(d[l].end).toFixed(2) : ' -  ');
    const out = (l) => (d[l] ? d[l].mid.clone().sub(d[l].root.clone().lerp(d[l].end, 0.5)).dot(b.n).toFixed(2) : ' -  ');
    rows.push(`${p.id.padEnd(11)} ${String(s).padStart(2)}  arms ${len('LH')} ${len('RH')}  legs ${len('LF')} ${len('RF')}  ` +
      `hip ${off(b.P)} chest ${off(b.S)} spineUp ${b.u.y.toFixed(2)}  knees out ${out('LF')} ${out('RF')}  elbows out ${out('LH')} ${out('RH')}`);
  });
  return rows.join('\n');
}

export function jitter({ body = 0.03, mid = 0.02, fps = 60 } = {}) {
  const out = [];
  let worstBody = 0, worstMid = 0, prev = null;
  run((c, p, s, f) => {
    const d = c.dbg, snap = { P: c.body.P.clone(), S: c.body.S.clone() };
    for (const l of LIMBS) if (d[l]) for (const k of ['root', 'mid', 'end']) snap[l + k] = d[l][k].clone();
    if (prev && f > 0) {
      for (const k of ['P', 'S']) {
        const j = snap[k].distanceTo(prev[k]);
        worstBody = Math.max(worstBody, j);
        if (j > body) out.push(`${p.id} move ${s} frame ${f}: ${k === 'P' ? 'hips' : 'chest'} moved ${j.toFixed(3)} m`);
      }
      for (const l of LIMBS) {
        if (!snap[l + 'mid'] || !prev[l + 'mid']) continue;
        const jm = snap[l + 'mid'].distanceTo(prev[l + 'mid']);
        const je = Math.max(snap[l + 'root'].distanceTo(prev[l + 'root']), snap[l + 'end'].distanceTo(prev[l + 'end']));
        worstMid = Math.max(worstMid, jm - 1.5 * je);
        if (jm - 1.5 * je > mid) out.push(`${p.id} move ${s} frame ${f}: ${l} ${l[1] === 'H' ? 'elbow' : 'knee'} ${jm.toFixed(3)} m vs ends ${je.toFixed(3)} m`);
      }
    }
    prev = snap;
  }, null, fps);
  return `worst torso step ${worstBody.toFixed(3)} m/frame, worst elbow/knee excess ${worstMid.toFixed(3)} m/frame, ${out.length} flagged\n` + out.slice(0, 30).join('\n');
}

// Settle problem `pi` at move `step` and look at it from plan point `pos` = [x, height, y] toward `look`.
export function show(pi, step, pos, look) {
  const v = window.viewer;
  v.selectProblem(pi);
  v.goToProblem();
  for (let s = 1; s <= step; s++) { v.setStep(s); for (let i = 0; i < 150; i++) v.animateClimber(1 / 60); }
  if (pos) {
    v.player.pos.set(pos[0], pos[1], -pos[2]);
    const d = new v.player.pos.constructor(look[0], look[1], -look[2]).sub(v.player.pos);
    v.player.yaw = Math.atan2(-d.x, -d.z);
    v.player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }
}
