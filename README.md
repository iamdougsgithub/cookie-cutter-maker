# Cookie Cutter and Practice Blank Maker

Turns a photo of a cookie cutter (or a drawn outline) into 3D-printable STLs, entirely in
the browser (nothing is uploaded):

- `index.html`: a royal-icing **practice blank**
- `cutter.html`: a matching **cookie cutter**, whose blade's inside edge is exactly the
  blank's outline

Both pages share the photo pipeline and settings; the photo and settings carry over
between them in the same browser tab (sessionStorage).

## Run

ES modules need to be served over HTTP (opening `index.html` from disk won't work):

    npm run serve      # http://localhost:5173 (no-cache static server)

Libraries load from jsDelivr at pinned versions: OpenCV.js 4.10.0, three.js 0.170.0,
earcut 3.0.1, clipper-lib 6.4.2, opentype.js 1.3.4. The side-text font, Nunito ExtraBold,
is in `fonts/` under the SIL Open Font License (`fonts/OFL.txt`).

## Deploy (free static hosting)

There's no build step and no server code: host the files as they are. `.nojekyll` tells
GitHub Pages to serve them untouched.

- **GitHub Pages:** push this repository to GitHub, then go to Settings → Pages, set
  "Deploy from a branch", pick `main` and `/ (root)`. The site appears at
  `https://<you>.github.io/<repo>/` within a minute or two.
- **Cloudflare Pages / Netlify:** connect the repository (or drag the folder in) with no
  build command and the repository root as the output directory.

Only `index.html`, `cutter.html`, `src/`, `fonts/` and `samples/` are needed at runtime. Hosts serve
over HTTPS, which phones prefer for camera capture.

## Test

    npm install
    npm test

## Layout

- `src/geometry.js`: pure pipeline: outline → smoothed/rounded outline (mm) → mesh → validation → STL
- `src/contours.js`: pure: picks the cookie edge from an OpenCV-style contour tree, centerline, auto-mode guess
- `src/vision.js`: OpenCV.js: threshold (brightness, or chroma for colored cutters), morphology, contours
- `src/cutter.js`: pure: outline → cookie-cutter mesh (tapered blade + rim), validated like the blank
- `src/text.js`: pure: font outlines → raised text solids wrapped onto the cutter's outside wall
- `src/colorpick.js`: pure: select by colour (sampling, CIE Lab ΔE distance, colour mask)
- `src/lettering.js`: pure: ink outlines → a "bubble" cookie outline round hand lettering
- `src/trace.js`: pure: hand-traced points → smooth closed outline (centripetal Catmull-Rom, corner points), and a detected outline → editable points
- `src/trace-editor.js`: the point editor on the photo (add, drag, insert, delete, corners, undo, zoom and pan)
- `src/app-core.js`: shared page logic (photo, overlay, settings, three.js preview, download)
- `src/app.js`, `src/cutter-app.js`: the two pages' configs (what to build, filename, extra settings)
- `src/shared-markup.js`: help panel, photo card and outline settings, used by both pages
- `test/*.test.js`: unit tests (node:test) for the geometry, cutter, tracing, lettering and colour modules
- `tools/make-test-images.mjs`: regenerates `samples/*.png`

## Select by colour

**Select by color** (next to "Trace by hand" under the photo) works like a magic wand:

- **Pick:** tap the photo on the colour of the shape you want.
- **Shape:** the connected area of that colour around where you tapped becomes the cookie,
  with any holes filled. It's tinted on the photo.
- **Tolerance:** **Color tolerance** moves the edges in or out. The match is measured as
  CIE Lab ΔE, after a light blur so grain doesn't speckle it.
- **Lettering:** in Lettering mode, picking the ink colour selects all the ink instead.
- **Clear** returns to automatic detection.

## Lettering cookies

Choose **Lettering** under "Shape is a" and upload hand-drawn words (dark ink on light
paper, or light on dark). The cookie becomes a soft "bubble" that follows the lettering, so
you can pipe the words on top.

1. **Find the ink:** every blob of ink is found (letters, dots, flourishes), ignoring specks
   and anything touching the frame edge.
2. **Grow and merge:** each blob grows outward by the **Border** (a % of the lettering's
   longest side, shown in mm too), and the grown blobs merge with holes filled.
3. **Bridge:** pieces that still don't touch are joined by progressively bigger closing.
4. **Round off:** a final closing rounds the narrow dips between letters.

The result goes through the same pipeline as any other outline, so Smoothness, Fill gaps,
size, Mirror, Rotate and Trace by hand all still apply, on both the blank and the cutter.

## Tracing by hand

When the automatic outline isn't right, "Trace by hand" lets you place points round the
shape instead. It starts from the detected outline, turned into about 28 editable points
with corners where it bends sharply, or from nothing if detection found nothing.

- **Place:** tap to add points, then tap the first (green) point to close the outline.
- **Adjust:** drag a point to move it; tap or drag the line to insert a point.
- **Corners:** double-tap a point (or use Corner) to make it sharp. Two corners in a row
  give a straight edge.
- **Remove and undo:** Delete point removes the selected point; Undo (or Cmd/Ctrl+Z) steps
  back.
- **Zoom:** pinch, scroll, or the − / + / Fit buttons; drag empty space to pan.

The curve passes through every point without overshooting. The traced outline replaces
detection for both the blank and the cutter, and it's remembered when you switch pages.

## Blank geometry

Defaults: 3.5 in longest side, 12.7 mm thick, flat top and bottom, a 2.0 mm top round-over
(16 segments), and a 0.4 mm bottom chamfer.

The outline follows the photo: nothing is removed for being thin. For each outline point
the mesh builder measures the local clearance (largest inscribed disc touching that point,
the "shrinking ball" method). Where a part is too thin or too tightly curved for the full
profile, as with a drawn figure's hands, the round-over and chamfer narrow there, blended
over about 1 mm. The walls are stacked rings offset along per-point normals, and each ring
is checked to be a simple polygon, with a more conservative scale tried if one isn't. The
caps are earcut triangulations; any collinear vertices earcut drops are re-inserted as fans
so there are no T-junctions.

"Fill gaps narrower than" (default 1 mm) closes small notches with a Clipper offset-out /
offset-in. Setting `convexRadiusMM: 3, notchWidthMM: 6` in `makeBlank` gives the original
strict mode, which rounds every corner to at least 3 mm but drops parts thinner than 6 mm.

## Cutter geometry

Modelled as printed: lip on the bed, blade up, and mirrored so that, flipped over, it cuts
the shape the right way round. Defaults: 18 mm tall overall, a 1.6 mm blade that bevels
(about 26°) over its top 2.5 mm to a 0.4 mm cutting edge, on a 3 mm thick lip that extends
6 mm beyond the blade. The lip has a 1.5 mm round-over on its outer top edge (the edge you
press on) and a 0.6 mm chamfer at the bed. The inside face is vertical and is exactly the
cookie outline.

Optional raised side text (default "Dispose of after use") sits on the outside face just
above the lip. The letters are 0.6 mm proud, wrap round gentle curves, and go on the
straightest stretch of wall with no bend tighter than 8 mm radius. They start at 4 mm cap
height and shrink to 2.5 mm if needed; if nothing fits, the text is left off with a note.
Each letter is its own closed solid sunk 0.4 mm into the wall, and slicers merge them.

Every outside ring is an exact Clipper offset of the outline, so the edge is 0.4 mm
everywhere, including tight inside corners, and walls that meet across a narrow gap merge.
The bevel is built from offset rings 0.2 mm apart. Each band between neighbouring rings is
a strip whose every triangle touches both rings. If the shorter-diagonal walk would fold,
the code tries nearest-point pairing; failing that, it uses an earcut triangulation with
diagonals flipped so it doesn't leave flat terraces. Tests check the edge width on heart,
star and figure, and that no bevel triangle folds.
