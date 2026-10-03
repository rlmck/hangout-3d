# Progress: The Hangout 3D model

Project context and conventions are in `CLAUDE.md`. This file covers what has been built, how we got
here, where the model stands now, and what's next.

## What we built
1. **First-person viewer** (`index.html` + `viewer.js`, Three.js): walk the gym with WASD and the mouse at
   1.7 m eye height, with collision, so you can't walk through walls but can walk under the bridge and the
   cave walk-under. Spawn point comes from the JSON.
2. **Wall info on hover or click:** wall id, notes, and every panel's height range and angle, with the
   panel you're looking at highlighted.
3. **Plan view (`P`):** top-down map with every wall labelled. A pink line marks each wall's base and an
   orange fill shows how far its overhang reaches.
4. **Lighting:** overhead key light with shadows, plus sky/ground fill so overhang undersides come out darker.
   Thin outlines mark panel seams.
5. **Live rebuild (`serve.py`):** save `hangout_layout.json` and the model rebuilds and updates in the open
   page without moving you. Build errors show in the corner. One command to start, no npm, no build step.
6. **Builder upgrades (`build_model.py`):** faces that start above the floor (`base_m`), solid blocks,
   end panels and top caps on overhangs, walls whose ends follow a neighbouring slab (`clip_from`/`clip_to`),
   and a fix for materials that rendered as metal.

## How the layout evolved
- **v1:** guessed from a 54-second phone video. The plan and most features turned out to be wrong.
  Kept as `hangout_layout_v1_video_guess.json`.
- **Ruled out:** aerial photos (the walls are indoors). Phone scanning (Scaniverse on a Pixel 9 Pro, which
  has no LiDAR) gave poor results.
- **v2:** built from the owner's hand-drawn `Floor.png`, numbered into `Floor_labelled.png`, then refined
  one wall at a time from their answers.
  - Every wall is 3 panels of 1.2 m (3.6 m), and panels are 2.4 m wide.
  - **Bridge:** a walled-off cuboid hanging at 2.4–3.6 m. You climb its sides and walk underneath it.
  - **Box:** the block below the bridge. Its west face is vertical, its east face (W23) is a slab, and its
    sides taper to follow the slab.
  - **Cave (W15):** 1 vertical panel, then 2 panels at 45° leaning out north.
  - **Cave walk-under:** W22 carries on south from the box to the cave line as a lower walk-under
    (W22b, 2.1 m).
  - **W16 slab:** runs from the top edge of the cave up to the W17 corner. The step at W17 is where the
    slab leans back to line up with W18.
  - **Open area:** from the cave's east end across to line 14 is the seating and exit; there's no wall.
    Line 14 is just the edge of the mats.
  - **Other changes:** the triangle volumes were removed, and doors are ignored for now.

## Current walls (from `hangout_layout.json`)
Lengths are scaled from the drawing, assuming the bridge is exactly 2.4 m wide. "1 vert + 2 @ 20°" means
1 vertical panel, then 2 panels leaning out at 20°.

| Wall | Length | Shape | Status |
|---|---|---|---|
| W1 | 3.6 m | vertical | confirmed |
| W2 | 1.1 m | vertical (angled corner) | confirmed |
| W3 | 0.7 m | vertical | confirmed |
| W4 | 2.4 m | vertical (behind the bridge) | confirmed |
| W5 | 0.6 m | vertical | **unconfirmed** |
| W6 | 1.0 m | vertical (angled corner) | **unconfirmed** |
| W7 | 3.4 m | vertical | confirmed |
| W8 | 1.7 m | overhang: 1 vert + 2 @ 20° | type confirmed, **angle guessed** |
| W9 | 0.8 m | vertical | **unconfirmed** |
| W10 | 3.1 m | overhang: 1 vert + 2 @ 20° | type confirmed, **angle guessed** |
| W11 | 0.8 m | vertical | **unconfirmed** |
| W12 | 2.4 m | vertical | confirmed |
| W13 | 2.0 m | vertical | confirmed |
| W15 | 4.8 m | cave: 1 vert + 2 @ 45° | confirmed by owner |
| W16-cave | 2.4 m | vertical (inside the cave) | **unconfirmed** |
| W16 | 4.1 m | slab, about 8° | type confirmed, **angle derived** |
| W17 | 0.5 m | step, tapers into the slab | derived |
| W18 | 3.1 m | vertical | confirmed |
| W19 / W20 | 4.1 m | bridge sides, vertical, 2.4–3.6 m | confirmed |
| W21 | 2.4 m | box face under the bridge end, vertical | **unconfirmed** |
| W22 | 3.1 m | box west face, vertical | confirmed |
| W22b | 2.0 m | hanging face over the cave walk-under, 2.1–3.6 m | type confirmed, **height guessed** |
| W23 | 3.1 m | box east face, slab @ 15° | type confirmed, **angle guessed** |
| W24 | 2.4 m | box south face, vertical | **unconfirmed** |

## Open questions (to improve accuracy)
1. **Panels wide per wall:** the most valuable remaining input. It would replace the scale assumption with
   real lengths.
2. Shape of the unconfirmed walls: W5, W6, W9, W11, W16-cave, W21, W24.
3. Angles of W8 and W10 (guessed 20°), the W23 slab (guessed 15°) and the W16 slab (derived about 8°).
4. Real clearance of the cave walk-under (guessed 2.1 m; it must be above about 1.9 m to walk under in the viewer).
5. Doors, seating and the exit are not modelled yet.

## Boulder problems (started)
- Chose option (a): Claude suggests its own holds. They live in `problems.json` (schema in `CLAUDE.md`), drawn
  by the viewer with a move-by-move step-through.
- Owner answers: arêtes are in; the W23 slab is plain plywood (no texture, so no smearing on the wall);
  assume a full range of hold types and styles.
- **W23 problems** (suggested positions, not real holds):
  - **Letting Go (V3):** left arête layback and heel-toe, a hand-foot match on the start pinch, then the crux:
    step off the arête onto a volume with a palm press and one crimp. The finish is 1.5 m right of the arête,
    so you can't climb the arête all the way.
  - **Bridge End (V2):** right arête layback, a sidepull on the bridge's outside corner, a rockover into the
    corner, then bridging with a palm press on the bridge end.
- **W15 cave problems** (suggested positions, not real holds):
  - **Arch Enemy (V5), left side:** sit start, squeeze between the roof's left arête (a real arête from
    1.2 to 2.1 m) and a pinch, heel-hook the arête, toe-press the W22b side wall, then a long reach to the lip jug.
    It falls into the cave walk-under path.
  - **Black Hole (V8), right side:** sit start, drop-knee onto a sloper pinch, a two-finger pocket, a stem onto
    the W16-cave side wall, then the crux: a deadpoint where your feet cut loose. A side-wall toe hook stops
    the swing, a heel on the old pocket follows, then the lip. It depends on W16-cave being vertical (unconfirmed).
  - On the 45° panels, 0.5 m of height is about 0.7 m along the wall, so reach checks use distance along the face.
- **Bridge problem:** **The Plank (V6)**, an outdoor-style roof. Sit start on W4 (the back wall), climb out
  along a diagonal flake line on the bridge's underside, take a no-hands kneebar rest on a roof volume,
  bicycle with both feet on the first roof jug, then turn the east lip onto W20 with a heel hook and a mantle.
  No dabs, because the roof is only 2.4 m up. UNCONFIRMED: does the bridge underside take holds?
- House rules from the owner: side walls and volumes are always in, as well as arêtes.
- `check_problems.py` found over-long moves in both cave problems. Fixed: Arch Enemy got a roof foothold, a
  drop-knee and a heel walked up the arête; Black Hole moved 0.45 m closer to the side wall, with lower crux
  and finish holds.
- Setting rules applied: on a slab the feet are the problem; one crux in the middle third so a fall is a slide;
  the arête is security you have to give up; moves about 0.5-1 m for an average climber (1.75 m, 2.2 m reach);
  problems don't cross.
- Next: get the owner's verdict on these two, then more walls (overhangs W8/W10, bridge sides).
  Real hold capture (option b) is still possible later.

## Body beta (Oct 2026)
- Three procedural-body attempts (solved torso, energy torso, gravity) were dropped: the owner found the arms and
  legs unnatural, especially elbows and knees. Cause: the solver had to guess the hips from four holds.
- New approach: the hips are written into each move (`body`), and elbows/knees are chosen by anatomical scoring.
  Letting Go has hips for all 8 moves (drafted by Claude, waiting for the owner's sanity check). Move 4 (left foot
  onto H1) is tight: the right foot on F3 is at full stretch while the left knee is folded, so the hips get nudged.
- Next: owner checks Letting Go; then bodies for Bridge End, Arch Enemy, Black Hole, The Plank (roof moves will need
  hips given as plan coordinates); then a rigged mesh instead of the blob mannequin, and a `?dev` pose editor.
