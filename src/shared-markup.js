// Markup shared by both pages (practice blank and cookie cutter): the photo tips, the
// photo card and the outline settings. Each page supplies its own model card and the
// settings specific to what it makes (a <template id="product-fields">).

export const PAGES = [
  { id: 'blank', href: 'index.html', label: 'Practice blank' },
  { id: 'cutter', href: 'cutter.html', label: 'Cookie cutter' },
];

const HELP = `
  <div class="tips">
    <figure class="tip">
      <div class="pair">
        <div class="ex good"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="36" y="16" width="48" height="52" fill="#3a2e28"/></svg><span>Straight down</span></div>
        <div class="ex bad"><svg viewBox="0 0 120 84"><path d="M30 14h60l20 62H10Z" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="34" y="30" width="52" height="40" fill="#3a2e28" preserveAspectRatio="none"/></svg><span>Angled</span></div>
      </div>
      <figcaption><b>Shoot straight down</b>, phone parallel to the table. Angled shots squash and stretch the shape.</figcaption>
    </figure>
    <figure class="tip">
      <div class="pair">
        <div class="ex good"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="36" y="16" width="48" height="52" fill="none" stroke="#c0392b" stroke-width="9"/></svg><span>High contrast</span></div>
        <div class="ex bad"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="url(#speckle)"/><use href="#heart" x="36" y="16" width="48" height="52" fill="none" stroke="#b3aca2" stroke-width="9"/></svg><span>Busy, low contrast</span></div>
      </div>
      <figcaption><b>Plain, high-contrast background.</b> White paper under a dark or colored cutter, or a dark surface under a white cutter.</figcaption>
    </figure>
    <figure class="tip">
      <div class="pair">
        <div class="ex good"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="38" y="18" width="44" height="48" fill="none" stroke="#3a2e28" stroke-width="9"/><g fill="#f4c542"><circle cx="8" cy="42" r="5"/><circle cx="112" cy="42" r="5"/></g></svg><span>Even light</span></div>
        <div class="ex bad"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="46" y="24" width="44" height="48" fill="#6d645c" filter="url(#blurShadow)" opacity=".75"/><use href="#heart" x="38" y="18" width="44" height="48" fill="none" stroke="#3a2e28" stroke-width="9"/><circle cx="10" cy="10" r="5" fill="#f4c542"/></svg><span>Harsh shadow</span></div>
      </div>
      <figcaption><b>Even light, no harsh shadows</b> — they merge with the outline. Diffuse daylight, or two lamps from opposite sides.</figcaption>
    </figure>
    <figure class="tip">
      <div class="pair">
        <div class="ex good"><svg viewBox="0 0 120 84"><rect x="10" y="4" width="100" height="76" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="26" y="10" width="68" height="66" fill="none" stroke="#3a2e28" stroke-width="7"/></svg><span>Fills the frame</span></div>
        <div class="ex bad"><svg viewBox="0 0 120 84"><rect x="10" y="4" width="100" height="76" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="50" y="32" width="22" height="22" fill="none" stroke="#3a2e28" stroke-width="12"/><circle cx="28" cy="62" r="9" fill="#c9b27a"/><path d="M78 14l20 22" stroke="#9aa1a8" stroke-width="5" stroke-linecap="round"/><ellipse cx="102" cy="40" rx="5" ry="7" fill="#9aa1a8"/></svg><span>Tiny, cluttered</span></div>
      </div>
      <figcaption><b>Fill the frame</b> with the cutter, leaving a little margin. Keep everything else out of the shot.</figcaption>
    </figure>
    <figure class="tip">
      <div class="pair">
        <div class="ex neutral"><svg viewBox="0 0 120 84"><rect x="8" y="66" width="104" height="6" rx="2" fill="#e3dccf"/><g fill="#d65f7a"><rect x="22" y="56" width="76" height="10" rx="2"/><rect x="26" y="26" width="5" height="30"/><rect x="89" y="26" width="5" height="30"/></g><path d="M28 18v6M91 18v6" stroke="#d65f7a" stroke-width="3"/><rect x="53" y="2" width="14" height="9" rx="2" fill="#3a2e28"/><circle cx="60" cy="6.5" r="2.4" fill="#fff"/><text x="60" y="48" font-size="10" text-anchor="middle" fill="#3a2e28">edge up</text></svg><span>Mirror <b>on</b></span></div>
        <div class="ex neutral"><svg viewBox="0 0 120 84"><rect x="8" y="66" width="104" height="6" rx="2" fill="#e3dccf"/><g fill="#d65f7a"><rect x="22" y="22" width="76" height="10" rx="2"/><rect x="26" y="32" width="5" height="32"/><rect x="89" y="32" width="5" height="32"/></g><rect x="53" y="2" width="14" height="9" rx="2" fill="#3a2e28"/><circle cx="60" cy="6.5" r="2.4" fill="#fff"/><text x="60" y="52" font-size="10" text-anchor="middle" fill="#3a2e28">edge down</text></svg><span>Mirror <b>off</b></span></div>
      </div>
      <figcaption><b>Cutters: either side up is fine.</b> Sharp cutting edge facing the camera? Turn <b>Mirror</b> on. Photographed the way you'd use it (edge down)? Leave it off.</figcaption>
    </figure>
    <figure class="tip">
      <div class="pair">
        <div class="ex good"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="36" y="16" width="48" height="52" fill="none" stroke="#1f1a17" stroke-width="8"/></svg><span>Thick, closed</span></div>
        <div class="ex bad"><svg viewBox="0 0 120 84"><rect x="18" y="8" width="84" height="68" rx="2" fill="#fff" stroke="#d8d1c6"/><use href="#heart" x="36" y="16" width="48" height="52" fill="none" stroke="#5a504a" stroke-width="2.4" stroke-dasharray="70 10 200"/><path d="M52 36l10 10M56 34l10 10M60 32l10 10M64 33l8 8" stroke="#8b827a" stroke-width="1.5"/><path d="M48 52c6 4 18 4 24 0" stroke="#5a504a" stroke-width="2" fill="none"/></svg><span>Thin, gaps, shading</span></div>
      </div>
      <figcaption><b>Drawings:</b> thick dark marker, a fully closed outline, no shading or interior lines. Draw it roughly the size you want.</figcaption>
    </figure>
  </div>
`;

const PHOTO_CARD = `
    <div class="card-head">
      <h2 id="photo-h"><span class="step">1</span> Your photo</h2>
      <span class="status" id="cvStatus">Loading shape finder…</span>
    </div>
    <div class="drop" id="drop" tabindex="0">
      <canvas id="overlay" hidden></canvas>
      <div class="drop-empty" id="dropEmpty">
        <svg viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="14" width="52" height="40" rx="6" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="32" cy="34" r="10" fill="none" stroke="currentColor" stroke-width="3"/><path d="M22 14l4-6h12l4 6" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>
        <p><b>Drop a photo here</b> or</p>
        <div class="btn-row">
          <label class="btn primary">Choose photo<input type="file" id="fileInput" accept="image/*" hidden></label>
          <label class="btn">Take photo<input type="file" id="cameraInput" accept="image/*" capture="environment" hidden></label>
        </div>
      </div>
    </div>
    <div class="photo-foot">
      <div class="load-problem" id="loadProblem" role="alert" hidden>
        <p><b>Automatic shape finding isn’t available.</b> <span id="loadProblemText"></span></p>
        <p>You can still <button class="link" id="loadProblemTrace" type="button">trace the shape by hand</button>.</p>
      </div>
      <p class="hint" id="pickHint" hidden>Found more than one shape. <b>Tap the one you want.</b></p>
      <div class="photo-actions" id="photoActions" hidden>
        <label class="btn small">Replace photo<input type="file" id="fileInput2" accept="image/*" hidden></label>
        <label class="btn small mobile-only">Retake<input type="file" id="cameraInput2" accept="image/*" capture="environment" hidden></label>
        <button class="btn small" id="traceBtn" type="button">Trace by hand</button>
      </div>
      <div class="trace-bar" id="traceBar" hidden>
        <p class="hint" id="traceHint"></p>
        <div class="trace-tools">
          <span class="tool-group">
            <button class="btn small" id="traceUndo" type="button">Undo</button>
            <button class="btn small" id="traceDelete" type="button" disabled>Delete point</button>
            <button class="btn small" id="traceCorner" type="button" disabled>Corner</button>
          </span>
          <span class="tool-group">
            <button class="btn small icon" id="traceZoomOut" type="button" aria-label="Zoom out">−</button>
            <button class="btn small icon" id="traceZoomIn" type="button" aria-label="Zoom in">+</button>
            <button class="btn small" id="traceFit" type="button">Fit</button>
          </span>
          <span class="tool-group">
            <button class="btn small" id="traceClear" type="button">Start over</button>
            <button class="btn small primary" id="traceDone" type="button">Done</button>
          </span>
        </div>
      </div>
      <p class="hint" id="traceUsing" hidden>Using your traced outline. <button class="link" id="traceEdit" type="button">Edit it</button> · <button class="link" id="traceAuto" type="button">Use the automatic outline</button></p>
      <p class="samples">No photo handy? Try a sample:
        <button class="link" data-sample="samples/cutter-ring.png">cutter</button> ·
        <button class="link" data-sample="samples/drawn-star.png">drawn star</button> ·
        <button class="link" data-sample="samples/drawn-figure.png">drawn figure</button> ·
        <button class="link" data-sample="samples/shadow-photo.png">photo with shadow</button> ·
        <button class="link" data-sample="samples/stamp-photo.png">stamp cutter</button>
      </p>
    </div>

    <div class="settings" id="settings">
      <h2><span class="step">2</span> Adjust</h2>

      <div class="field" data-auto-only>
        <span class="label">Shape is a</span>
        <div class="seg" role="radiogroup" aria-label="Mode">
          <label><input type="radio" name="mode" value="auto" checked><span>Auto</span></label>
          <label><input type="radio" name="mode" value="cutter"><span>Cookie cutter</span></label>
          <label><input type="radio" name="mode" value="drawing"><span>Hand drawing</span></label>
        </div>
        <p class="note" id="modeNote"></p>
      </div>

      <div class="field" id="edgeField" hidden>
        <span class="label">Cookie edge</span>
        <div class="seg" role="radiogroup" aria-label="Edge">
          <label><input type="radio" name="edge" value="center" checked><span>Middle of line</span></label>
          <label><input type="radio" name="edge" value="inner"><span>Inside of line</span></label>
        </div>
      </div>

      <div class="field" data-auto-only>
        <div class="label-row"><label class="label" for="threshold">Threshold</label>
          <label class="check"><input type="checkbox" id="thresholdAuto" checked> Auto</label>
          <output id="thresholdOut"></output></div>
        <input type="range" id="threshold" min="1" max="254" value="128" disabled>
        <p class="note">If the outline looks wrong, untick Auto and slide until it hugs the edge.</p>
      </div>

      <div class="field">
        <div class="label-row"><label class="label" for="smooth">Smoothness</label><output id="smoothOut"></output></div>
        <input type="range" id="smooth" min="0" max="10" step="1" value="1">
      </div>

      <div class="field">
        <div class="label-row"><label class="label" for="notches">Fill gaps narrower than</label><output id="notchesOut"></output></div>
        <input type="range" id="notches" min="0.5" max="12" step="0.5" value="1">
        <p class="note">Keeps small details like a gap between an arm and the body. Slide up to fill in notches you don't want to ice around.</p>
      </div>

      <div class="field two">
        <div>
          <label class="label" for="size">Longest side</label>
          <div class="num"><input type="number" id="size" inputmode="decimal"><span class="unit-label"></span></div>
        </div>
        <div>
          <span class="label">Units</span>
          <div class="seg compact" role="radiogroup" aria-label="Units">
            <label><input type="radio" name="units" value="in" checked><span>in</span></label>
            <label><input type="radio" name="units" value="mm"><span>mm</span></label>
          </div>
        </div>
      </div>

      <div id="productFields"></div>

      <div class="field">
        <label class="switch"><input type="checkbox" id="mirror"><span class="track"></span> Mirror</label>
        <p class="note">A cutter photographed <b>cutting edge up</b> shows the shape back-to-front, so turn Mirror on. A cutter photographed the way you use it (edge down), or a drawing, needs no mirroring.</p>
      </div>

      <div class="field">
        <div class="label-row"><label class="label" for="rotation">Rotate</label><output id="rotationOut"></output></div>
        <div class="rotate-row">
          <button class="btn icon" id="rotL" title="Rotate 90° left" aria-label="Rotate 90° left">⟲</button>
          <input type="range" id="rotation" min="-180" max="180" step="1" value="0">
          <button class="btn icon" id="rotR" title="Rotate 90° right" aria-label="Rotate 90° right">⟳</button>
        </div>
      </div>
    </div>
`;

/** Fill the shared slots of the page. Call before looking up any elements. */
export function renderShared(pageId) {
  document.getElementById('help').insertAdjacentHTML('beforeend', HELP);
  const card = document.getElementById('photoCard');
  card.innerHTML = PHOTO_CARD;
  const tpl = document.getElementById('product-fields');
  if (tpl) card.querySelector('#productFields').replaceWith(tpl.content.cloneNode(true));
  const nav = document.getElementById('pageNav');
  if (nav) {
    nav.innerHTML = PAGES.map((p) => `<a href="${p.href}"${p.id === pageId ? ' aria-current="page"' : ''}>${p.label}</a>`).join('');
  }
}
