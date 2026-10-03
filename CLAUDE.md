# The Hangout: 3D model of a bouldering gym

A schematic, walkable 3D model of The Hangout bouldering gym, built from the owner's hand-drawn floor plan
and answers about each wall. It is a blockout, not a scan: good enough to walk around and reason about
wall shapes, but lengths are scaled from a drawing and most angles are estimates.

See `PROGRESS.md` for what has been built so far, the decisions behind it and the open questions.

## Run it
```
pip install trimesh numpy     # once
python serve.py               # http://127.0.0.1:8000/   (python serve.py 8080 for another port)
```
`serve.py` (stdlib only) serves the viewer, watches `hangout_layout.json`, reruns `build_model.py` on save
and hot-reloads the model in the open page. Saving `problems.json` redraws the holds (no rebuild). Editing `index.html`/`viewer.js` reloads the page (pose kept).
- Use the `127.0.0.1` URL, not `localhost`: another unrelated `python -m http.server` sometimes runs on this machine.
- A server started from a Claude Code background task stops after 2 hours.

## Published copy
GitHub repo `rlmck/hangout-3d` (public) with GitHub Pages serving the repo root: https://rlmck.github.io/hangout-3d/
Pushing to `main` redeploys it in about a minute. The page is static there: no `/events` (live reload only connects
on 127.0.0.1/localhost), so rebuild the `.glb` locally and commit it along with the JSON.

## Files
| File | Role |
|---|---|
| `hangout_layout.json` | **Source of truth.** Edit this, never the mesh. |
| `problems.json` | Boulder problems (holds + move-by-move beta). Drawn by the viewer, not baked into the GLB. |
| `check_problems.py` | Checks problems.json: hold placement and reach per move. |
| `build_model.py` | JSON -> `hangout_blockout.glb` (+ `.obj`/`.mtl`). trimesh + numpy. |
| `index.html`, `viewer.js`, `climber.js` | Three.js 0.170 first-person viewer (climber.js = the animated climber) (loaded from jsDelivr via an importmap; no build step). |
| `serve.py` | Dev server + file watcher + Server-Sent Events (`/events`) for live reload. |
| `Floor.png` | The owner's hand-drawn plan (north = up). |
| `Floor_labelled.png` | Same plan with line numbers 1-24. **Wall ids W1..W24 match these numbers.** |
| `Floor_understanding.png` | Early interpretation sketch, now out of date (ignore). |
| `hangout_layout_v1_video_guess.json` | First layout, guessed from a phone video. Superseded. |

## Coordinates and JSON schema
- Plan coords: metres, `x` east, `y` north, `z` up. glTF/Three.js is y-up: plan `(x, y, z)` -> world `(x, z, -y)`.
- Wall: `{id, from, to, profile, notes, base_m?, clip_from?, clip_to?}`.
  - The climbing face is on the **right** of `from -> to` (outer walls run clockwise, the box runs anticlockwise).
  - `profile`: stacked panels `[rise_m, angle_deg]` from the bottom up. Angle is past vertical:
    **positive = overhang** (leans toward the climber), **negative = slab**. Rises are scaled to fill
    `wall_height_m - base_m`.
  - `base_m`: the face starts above the floor (bridge sides at 2.4 m, the low walk-under W22b at 2.1 m).
  - `clip_from` / `clip_to: "<wall id>"`: slide that end along the wall so it follows another wall's sloping
    face at every height (used where box sides meet the W23 slab, and W17 / W16-end meet the W16 slab).
- `blocks`: solid boxes `{id, x:[..], y:[..], z:[..], notes}` (the bridge body, the cave-arch, the box top).
- `spawn.position` / `look_at` are `[plan x, height, plan y]`.
- `volumes.count` is 0: random placeholder volumes are switched off on purpose.
- Gym constants from the owner: panels are **2.4 m wide x 1.2 m tall** (landscape); every wall is
  **3 panels = 3.6 m**; overhangs are 1 vertical panel then 2 overhanging panels.

## Build details worth knowing
- Each wall panel is split into separate meshes at colour-band heights (black < 1.1 m, pink < 2.1 m, white)
  and at panel joints. Mesh names are `<wallId>_p<panelIndex>_<z>`, `<wallId>_cap`, `<wallId>_end0/1`,
  `block_<id>`. The viewer maps meshes back to JSON by these prefixes, so **wall ids must not contain `_`**.
- Overhangs (positive offset) get a top cap and triangular end panels closing the solid wedge behind the face.
  Slabs get neither, because the wedge in front of a slab is open air.
- Materials are exported with `metallicFactor=0` (glTF defaults to fully metallic otherwise).

## Problems (`problems.json`)
- Problem: `{id, name, grade, colour, wall, style[], rules, notes, holds[], moves[]}`.
- Hold: `{id, along_m, height_m, type, role?, facing?, grip?, size_m?, notes, wall?}`. `along_m` runs from the wall's
  `from` end (the climber's left), `height_m` is height above the floor; the viewer puts it on the sloping face.
  Off-wall holds (e.g. the bridge end) use `at: [plan x, plan y, height]` + `normal: [nx, ny]` instead.
- Types: jug, crimp, sloper, pinch, pocket, foot, volume (`size_m [w, h, depth]`, triangle point down),
  `arete` and `spot` (body positions with no hold; an arete with a `role` gets a tape mark).
  `facing` = the way the gripping edge points.
- Move: `{text, technique[], LH, RH, LF, RF, LK?, RK?, dynamic?}` = the body position **after** the move (hold id,
  or null when flagging; LK/RK = knee for a kneebar). Move 0 is the start. Hold ids only need to be unique within a problem.
- Body beta (optional, per move): `body: {hips: [along, height, out], turn?, lean?, chest?, wall?, elbows?, knees?}`.
  `hips` is on the problem's wall (or `wall`): `out` = metres straight out (level) from the face at that height.
  `turn` (deg) > 0 brings the right hip in to the wall (drop-knees, laybacks); `lean` (deg) tips the chest back;
  `elbows` / `knees` force a direction for one limb: `{"RF": "in"}` with out / in / up / down / back / wall.
  A problem gets a body only if at least one move has `body`; others show hands and feet only.
- Off-wall holds: `normal` may be 3D `[nx, ny, nz]`; on a roof (normal down) `up: [ux, uy]` is the direction of travel.
  Optional problem fields: `where` (shown instead of `wall`), `view: {position, look_at}` for `G` (like `spawn`).
- **Run `python check_problems.py` after editing problems.** It checks hold ids, holds inside blocks or off a
  wall, and reach for a 1.75 m climber: one limb moving at most 1.5 m (hands) or 1.3 m (feet), x1.25 if `dynamic`;
  spans of at most 1.7 m between hands, 2.1 m hand to foot and 1.5 m between feet; knee 0.3-0.6 m from the same foot.
- House rules (`house_rules` in the JSON): arêtes, side walls and volumes are always in. W23 panels are plain
  plywood (no smearing on the wall). Assume a full range of holds.
- Low roofs (the bridge underside is 2.4 m up): feet must stay in the roof, because hanging straight down puts them on the mat.

## Viewer behaviour
- **Phones and computers get the same app** (`body.app`): problem card centred at the top, the climber, drag to look
  (inverted on purpose), tap/click a hold to open its problem, no wall info, no plan view. Computers also walk with
  WASD/arrows and have `[` `]` `N` `G` `R`. The only difference is the joysticks (`body.touch`), shown on any
  touchscreen (`any-pointer: coarse` or `maxTouchPoints > 1`) and then following the last input (finger shows them,
  mouse hides them). `?touch` forces the sticks on a desktop for testing.
- **`?dev`** restores the old desktop tools for editing walls: "Click to walk" pointer lock, mouse look, hover/click
  wall info, plan view (`P`), the help bar and the full move list.
- Touch mode: twin sticks like a mobile
  shooter (left walks, right looks, squared response). The look stick is normal (push right turns right, push up
  looks up); dragging the screen is **inverted on purpose** (owner's choice: drag the scene, finger right looks left).
  The problem card folds down (▴/▾) to the dropdown plus ◀ Move n ▶; the fold is remembered in localStorage,
  and on phones the card doesn't repeat the problem list (the dropdown has it).
  No wall info, no plan view. Tapping a hold opens its problem (camera goes there, beta from the start); tapping a
  hold of the open problem jumps to the move that first uses it. The problem card sits at the top with a dropdown
  and Prev/Next. Portrait screens get a 90° vertical FOV. A hidden tab runs no frames: test sticks with
  `viewer.aim` / `viewer.turn(dt)` and `viewer.joy` / `viewer.move(dt)`.
- WASD/arrows + Shift, mouse-look with pointer lock, eye height 1.7 m, `R` respawn, `P` top-down plan view
  (wall labels, pink = base line, orange = overhang footprint), click pins the info panel.
- Problems: `N` cycles problems (then none), `[` / `]` step through the moves, `G` stands you in front of the
  problem. The selected problem shows `S`/`TOP` and LH/RH/LF/RF markers (bigger = the limb that just moved);
  other problems dim. Hovering a hold shows its type, position and which moves use it.
- The selected problem is acted out by `climber.js`. Hands are outlines lying on the hold with fingers along the
  hold's `facing`; shoes are small outlined 3D shoes placed by the move's per-limb `style` (edge / smear / drop-knee /
  heel / toe-hook / toe-press); a kneebar knee is a small marker. With `body` data a mannequin joins them: hips from
  `body.hips` (authored on purpose: the old solver guessed the hips and the owner found its arms and legs unnatural,
  especially elbows and knees), nudged only if a limb can't reach (or is folded tighter than 0.36 m hip to ankle);
  each elbow/knee is the best of 48 bend directions by an anatomical score (forearm from the side the hand pulls
  toward, kneecap over the toes, no hip/shoulder hyperextension, not through the torso or wall); a free foot flags.
  Without a body a limb with no hold fades out. Next/Prev animate changed limbs along arcs with fading trails, feet
  first (hands first on `dynamic` moves); the hips lead. Test in a hidden tab: `viewer.setStep(i)` then
  `viewer.animateClimber(0.05)` in a loop; `viewer.climber().dbg` has the joints, `.body` / `.bodyTarget` the hips.
- Hover info shows the wall id, notes, and a panel table (height range, angle, slab/vertical/overhang).
- Collision: radial raycasts (radius 0.3 m) at heights 0.25, 0.9, 1.5 and 1.85 m. Anything hanging higher than
  ~1.9 m can be walked under, which is why the bridge (2.4 m) and the cave walk-under (2.1 m) work.
- `window.viewer` exposes `player`, `move`, `collides`, `pickFirstPerson`, `setPlanMode`, `spawn`, `selectProblem`, `setStep`, `goToProblem`, … for
  testing from devtools or browser automation (a hidden tab does not run `requestAnimationFrame`, so call
  `move(dt)` directly).

## Working with the owner
- **Commit and push straight to `main` after every change** so they can test on their phone (GitHub Pages).
- They are at or near the gym and answer questions about walls by line number; ask rather than guess.
- When something is assumed, put `UNCONFIRMED` in that wall's `notes` so it shows on hover.
- After a change, rebuild and look at it in the viewer before reporting back.
