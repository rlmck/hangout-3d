# The Hangout: 3D blockout

**What this is:** an approximate, schematic model of the gym, built from a hand-drawn floor plan
(`Floor.png`, numbered in `Floor_labelled.png`) and the owner's description of each wall. It is *not* a scan.
Wall height (3 panels × 1.2 m = 3.6 m) and panel size (2.4 × 1.2 m) are real. Lengths are scaled from the drawing
and several angles are estimates. See `PROGRESS.md` for status and `CLAUDE.md` for conventions.

**Live viewer (works on phones):** https://rlmck.github.io/hangout-3d/

On a phone: pick a problem from the dropdown (or tap any hold to open its problem) and step through it
with Prev / Next. Twin sticks like a mobile shooter: left stick walks, right stick looks (dragging the
screen also looks).

## Files
- `hangout_layout.json`: the source of truth (schema in `CLAUDE.md`). Wall ids W1–W24 match `Floor_labelled.png`.
- `build_model.py`: regenerates the mesh from the JSON (`pip install trimesh numpy`, then `python build_model.py`).
- `hangout_blockout.glb`: the mesh (glTF, y-up, metres), used by the viewer.
- `hangout_blockout.obj` + `material.mtl`: same mesh for other tools.

## Improving accuracy
Edit the JSON and the viewer rebuilds itself. The most valuable input now is how many panels wide each wall is;
after that, the angles marked as guessed in `PROGRESS.md`.

## Viewer
```
pip install trimesh numpy     # once
python serve.py               # opens http://127.0.0.1:8000/  (python serve.py 8080 for another port)
```
`serve.py` (stdlib only) serves `index.html` + `viewer.js`, watches `hangout_layout.json`, reruns
`build_model.py` on save and hot-swaps the model in the open viewer (your position is kept; build errors
show top-right). Three.js 0.170 loads from the jsDelivr CDN, so the first load needs internet.

Controls: click to walk · WASD/arrows · Shift run · mouse look · `P` plan view (hover/click walls) ·
`R` respawn · click pins the info panel · Esc releases the mouse.
In the plan view the thick pink line is each wall's base, the orange fill is how far its overhang reaches.
`spawn.position` / `look_at` are `[plan x, height, plan y]`.
