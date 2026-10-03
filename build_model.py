"""Build hangout_blockout.glb (+ .obj) from hangout_layout.json. Coordinates: plan x/y, z up -> exported glTF y-up."""
import json, numpy as np, trimesh
from trimesh.visual.material import PBRMaterial
L = json.load(open('hangout_layout.json'))
H = L['wall_height_m']
BANDS = [(0.0, [20, 20, 22]), (1.1, [214, 22, 120]), (2.1, [235, 235, 230])]  # black, pink, white
def mat(rgb, name): return PBRMaterial(name=name, baseColorFactor=rgb + [255], doubleSided=True, roughnessFactor=0.9, metallicFactor=0.0)
def color_at(z): return [c for h, c in BANDS if z >= h - 1e-6][-1]

scene = trimesh.Scene()
def add(mesh, name, rgb):
    mesh.visual = trimesh.visual.TextureVisuals(material=mat(rgb, name)); scene.add_geometry(mesh, geom_name=name)

def geom(w):
    a, b = np.array(w['from'], float), np.array(w['to'], float)
    d = (b - a) / np.linalg.norm(b - a); n = np.array([d[1], -d[0]])  # climbing side = right of from->to
    base = w.get('base_m', 0.0)  # >0 for faces that start above the floor (e.g. the sides of the hanging bridge)
    scale = (H - base) / sum(r for r, _ in w['profile'])
    outline = [(0.0, base)]  # (offset toward the climber, z) at each panel joint
    for rise, ang in w['profile']:
        o, z = outline[-1]; outline.append((o + np.tan(np.radians(ang)) * rise * scale, z + rise * scale))
    return a, b, d, n, outline
G = {w['id']: geom(w) for w in L['walls']}
def off_at(outline, z):
    return float(np.interp(z, [zz for _, zz in outline], [o for o, _ in outline]))
def end_shift(w, key, end, d, z):
    """clip_from / clip_to: slide this wall's end along its line so it meets another wall's (sloping) face."""
    if key not in w: return 0.0
    a2, _, _, n2, out2 = G[w[key]]
    return (off_at(out2, z) - np.dot(end - a2, n2)) / np.dot(d, n2)

wall_quads = []  # for volume placement: (corners, normal)
for w in L['walls']:
    a, b, d, n, outline = G[w['id']]
    A = lambda z: a + d * end_shift(w, 'clip_from', a, d, z)
    B = lambda z: b + d * end_shift(w, 'clip_to', b, d, z)
    knots = {zz for _, zz in outline} | {zz for k in ('clip_from', 'clip_to') if k in w for _, zz in G[w[k]][4]}
    for i, ((o0_, z0_), (o1_, z1_)) in enumerate(zip(outline[:-1], outline[1:])):
        # split panel at colour band boundaries (and at the joints of any wall this one is clipped to)
        cuts = sorted({z0_, z1_} | {h for h, _ in BANDS if z0_ < h < z1_} | {k for k in knots if z0_ < k < z1_})
        for z0, z1 in zip(cuts[:-1], cuts[1:]):
            o0, o1 = off_at(outline, z0), off_at(outline, z1)
            P = [np.r_[A(z0) + n * o0, z0], np.r_[B(z0) + n * o0, z0], np.r_[B(z1) + n * o1, z1], np.r_[A(z1) + n * o1, z1]]
            add(trimesh.Trimesh(vertices=P, faces=[[0, 1, 2], [0, 2, 3]]), f"{w['id']}_p{i}_{z0:.2f}", color_at((z0 + z1) / 2))
            wall_quads.append((P, n))
    # Overhangs only (a slab's wedge is open air): top cap and side panels closing the solid wedge behind the face,
    # the side panels nudged 5 mm in from each end
    off = outline[-1][0]
    if off > 1e-3:
        top = [np.r_[A(H), H], np.r_[B(H), H], np.r_[B(H) + n * off, H], np.r_[A(H) + n * off, H]]
        add(trimesh.Trimesh(vertices=top, faces=[[0, 1, 2], [0, 2, 3]]), f"{w['id']}_cap", [90, 90, 95])
        for k, e in enumerate([a + d * 0.005, b - d * 0.005]):
            V = [np.r_[e, H]] + [np.r_[e + n * o, zz] for o, zz in outline]
            F = [[0, j, j + 1] for j in range(1, len(V) - 1)]
            add(trimesh.Trimesh(vertices=V, faces=F, process=False), f"{w['id']}_end{k}", [90, 90, 95])

R = L['room']
floor = trimesh.creation.box(extents=[R['width_x'], R['depth_y'], 0.3]); floor.apply_translation([R['width_x']/2, R['depth_y']/2, -0.15])
add(floor, 'mats', [110, 112, 118])
if 'mezzanine' in L:
    mz = L['mezzanine']; x0, x1 = mz['x']; y0, y1 = mz['y']; fh = mz['floor_height_m']
    slab = trimesh.creation.box(extents=[x1-x0, y1-y0, 0.2]); slab.apply_translation([(x0+x1)/2, (y0+y1)/2, fh]); add(slab, 'mezzanine', [200, 200, 205])
    rail = trimesh.creation.box(extents=[x1-x0, 0.05, mz['railing_height_m']]); rail.apply_translation([(x0+x1)/2, y0, fh + 0.1 + mz['railing_height_m']/2]); add(rail, 'mezz_rail', [170, 175, 180])
for bl in L.get('blocks', []):  # solid boxes, e.g. the bridge body and the top of the box
    (x0, x1), (y0, y1), (z0, z1) = bl['x'], bl['y'], bl['z']
    bx = trimesh.creation.box(extents=[x1-x0, y1-y0, z1-z0]); bx.apply_translation([(x0+x1)/2, (y0+y1)/2, (z0+z1)/2])
    add(bx, f"block_{bl['id']}", [150, 152, 158])
for o in L.get('openings', []):
    mk = trimesh.creation.cylinder(radius=0.25, height=0.05); mk.apply_translation(o['at'] + [0.03]); add(mk, f"marker_{o['id']}", [40, 160, 220])

rng = np.random.default_rng(L['volumes']['seed'])
for k in range(L['volumes']['count']):
    P, n = wall_quads[rng.integers(len(wall_quads))]
    u, v = rng.uniform(0.15, 0.85, 2); c = P[0] + u*(P[1]-P[0]) + v*(P[3]-P[0])
    if c[2] < 0.4: continue
    s = rng.uniform(0.35, 0.8); t = P[1]-P[0]; t /= np.linalg.norm(t); up = np.array([0, 0, 1.])
    nn = np.r_[n, 0]
    tri = trimesh.Trimesh(vertices=[c + t*s/2 - up*s/3, c - t*s/2 - up*s/3, c + up*s*0.6, c + nn*s*0.45],
                          faces=[[0, 1, 3], [1, 2, 3], [2, 0, 3], [0, 2, 1]])
    add(tri, f'volume_{k:02d}', [120, 122, 126])

Zup2Yup = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]])
scene.apply_transform(Zup2Yup)
scene.export('hangout_blockout.glb'); scene.export('hangout_blockout.obj')
print('geoms', len(scene.geometry), 'bounds', scene.bounds.round(2).tolist())
