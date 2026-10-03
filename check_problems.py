"""Sanity-check problems.json against the layout: hold ids, holds inside solids, and reach for every move.

    python check_problems.py

Reach limits are for an average climber (1.75 m tall, ~1.75 m span). Distances are straight lines in 3D, so on
overhangs they follow the face rather than the height difference. Prints a per-move table and exits 1 on errors.
"""
import json, math, sys

L = json.load(open('hangout_layout.json', encoding='utf-8'))
P = json.load(open('problems.json', encoding='utf-8'))
H = L['wall_height_m']
WALLS = {w['id']: w for w in L['walls']}
LIMBS = ['LH', 'RH', 'LF', 'RF', 'LK', 'RK']
MAX_MOVE = {'H': 1.5, 'F': 1.3, 'K': 1.2}  # one limb moving between holds (x1.25 for a move marked dynamic)
MAX_HANDS, MAX_HAND_FOOT, MAX_FEET = 1.7, 2.1, 1.5  # spans held at the same time
SHIN = (0.3, 0.6)  # knee to same-side foot, for kneebars
STYLES_F = {'edge', 'smear', 'drop-knee', 'heel', 'toe-hook', 'toe-press'}
STYLES_H = {'grip', 'palm', 'undercling', 'gaston'}
BODY_WORDS = {'out', 'in', 'up', 'down', 'back', 'wall'}  # body.elbows / body.knees directions


def wall_point(w, along, h):
    """Plan point (x, y, z) on a wall face, plus the outward normal."""
    base = w.get('base_m', 0.0)
    scale = (H - base) / sum(r for r, _ in w['profile'])
    z, off, ang = base, 0.0, 0.0
    for rise, ang in w['profile']:
        r = rise * scale
        if h <= z + r + 1e-6:
            break
        z += r; off += math.tan(math.radians(ang)) * r
    a = math.radians(ang)
    off += (h - z) * math.tan(a)
    (ax, ay), (bx, by) = w['from'], w['to']
    ln = math.hypot(bx - ax, by - ay); d = ((bx - ax) / ln, (by - ay) / ln); n = (d[1], -d[0])
    p = (ax + d[0] * along + n[0] * off, ay + d[1] * along + n[1] * off, h)
    return p, (n[0] * math.cos(a), n[1] * math.cos(a), -math.sin(a)), ln, base


def inside_block(p):
    return next((b['id'] for b in L.get('blocks', []) if all(lo < v < hi for v, (lo, hi) in zip(p, (b['x'], b['y'], b['z'])))), None)


errors = []
for pr in P['problems']:
    print(f"\n== {pr['name']} ({pr['grade']}) ==")
    pos, ids = {}, set()
    for h in pr['holds']:
        if h['id'] in ids: errors.append(f"{pr['id']}: duplicate hold {h['id']}")
        ids.add(h['id'])
        if 'at' in h:
            p = tuple(h['at']); n = list(h['normal']) + [0] * (3 - len(h['normal']))
            k = math.sqrt(sum(c * c for c in n)); n = tuple(c / k for c in n)
        else:
            w = WALLS.get(h.get('wall', pr['wall']))
            if not w: errors.append(f"{pr['id']} {h['id']}: unknown wall"); continue
            p, n, ln, base = wall_point(w, h['along_m'], h['height_m'])
            if not (-1e-6 <= h['along_m'] <= ln + 1e-6 and base - 1e-6 <= h['height_m'] <= H + 1e-6):
                errors.append(f"{pr['id']} {h['id']}: off the edge of {w['id']} (length {ln:.2f}, {base}-{H} m)")
        pos[h['id']] = p
        probe = tuple(c + 0.03 * nc for c, nc in zip(p, n))  # just in front of the hold
        if (b := inside_block(probe)):
            errors.append(f"{pr['id']} {h['id']}: inside block {b}")
    dist = lambda a, b: math.dist(pos[a], pos[b])
    prev = {}
    for i, m in enumerate(pr['moves']):
        bad = [f"{l}={m[l]}" for l in LIMBS if m.get(l) and m[l] not in pos]
        if bad: errors.append(f"{pr['id']} move {i}: unknown hold {bad}"); continue
        at = {l: m[l] for l in LIMBS if m.get(l)}
        for l, v in (m.get('style') or {}).items():
            ok = {'H': STYLES_H, 'F': STYLES_F}.get(l[1:2], set())
            if l not in at or v not in ok: errors.append(f"{pr['id']} move {i}: bad style {l}={v}")
        b = m.get('body')
        if b is not None:
            for k, v in b.items():
                ok = (k in ('hips', 'chest') and isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) for x in v))                     or (k in ('turn', 'lean') and isinstance(v, (int, float))) or (k == 'wall' and v in WALLS)                     or (k in ('elbows', 'knees') and isinstance(v, dict) and all(
                        lk in ({'LH', 'RH'} if k == 'elbows' else {'LF', 'RF'}) and w in BODY_WORDS for lk, w in v.items()))
                if not ok: errors.append(f"{pr['id']} move {i}: bad body.{k} = {v}")
        notes = []
        for l, hid in at.items():
            if i and prev.get(l) and prev[l] != hid:
                d = dist(prev[l], hid)
                notes.append(f"{l} {prev[l]}->{hid} {d:.2f}")
                if d > MAX_MOVE[l[1]] * (1.25 if m.get('dynamic') else 1): errors.append(f"{pr['id']} move {i}: {l} moves {d:.2f} m")
        hands = [at[l] for l in ('LH', 'RH') if l in at]; feet = [at[l] for l in ('LF', 'RF') if l in at]
        span = lambda xs, ys: max((dist(a, b) for a in xs for b in ys), default=0)
        hh, hf, ff = span(hands, hands), span(hands, feet), span(feet, feet)
        for v, lim, what in ((hh, MAX_HANDS, 'hands'), (hf, MAX_HAND_FOOT, 'hand-foot'), (ff, MAX_FEET, 'feet')):
            if v > lim: errors.append(f"{pr['id']} move {i}: {what} span {v:.2f} m > {lim}")
        for side in 'LR':
            if side + 'K' in at:
                foot = at.get(side + 'F')
                s = dist(at[side + 'K'], foot) if foot else None
                if s is None or not SHIN[0] <= s <= SHIN[1]:
                    errors.append(f"{pr['id']} move {i}: {side} knee needs the {side} foot {SHIN[0]}-{SHIN[1]} m away (got {s})")
        print(f"{i:2d}  hands {hh:4.2f}  hand-foot {hf:4.2f}  feet {ff:4.2f}   " + '; '.join(notes))
        prev = at

print('\n' + ('\n'.join('ERROR ' + e for e in errors) if errors else 'OK: no problems found'))
sys.exit(1 if errors else 0)
