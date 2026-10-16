/* Copyright 2026 Kube AI Hub.
   Source document viewer for the playground.

   Renders the chosen PDF with the same pdf.js bundle the WebUI ships, and
   draws one overlay rectangle per parsed block. That makes the comparison
   two-way: hovering or selecting a block in the parsed result highlights its
   source region here, and clicking a region here highlights the block that
   produced it.

   Overlays are positioned from the normalized bboxes in the parse result's
   middle_json, so no extra server work is needed to place them. */
const PDFJS_BASE = './vendor/pdfjs';
const CMAP_URL = `${PDFJS_BASE}/cmaps/`;
const STANDARD_FONT_URL = `${PDFJS_BASE}/standard_fonts/`;
const WASM_URL = `${PDFJS_BASE}/wasm/`;
const WORKER_URL = `${PDFJS_BASE}/legacy/build/pdf.worker.min.mjs`;

const MIN_RENDER_SCALE = 0.4;
const MAX_RENDER_SCALE = 3;

export class SourceViewer {
  constructor(host, options) {
    this.host = host;
    this.options = options || {};
    this.text = this.options.text || ((name) => name);
    this.pdf = null;
    this.pages = [];
    this.scale = null;
    /* page index -> array of { block, element } in page coordinates. */
    this.overlays = new Map();
    this.selected = null;
    this.hovered = null;
    this.observer = null;
    this.resizeFrame = null;
    this.disposed = false;
    this.renderToken = 0;
  }

  /* ------------------------------------------------------------------ setup */

  async load(blob, name) {
    this.dispose();
    this.disposed = false;
    const token = ++this.renderToken;
    this.host.innerHTML = '';
    this.host.classList.add('source-viewer');

    const status = document.createElement('div');
    status.className = 'source-status';
    status.textContent = this.text('pdfLoading');
    this.host.appendChild(status);

    let pdfjs;
    try {
      pdfjs = await import(`${PDFJS_BASE}/legacy/build/pdf.min.mjs`);
    } catch (error) {
      status.textContent = this.text('pdfLoadFailed');
      return;
    }
    if (this.disposed || token !== this.renderToken) return;

    pdfjs.GlobalWorkerOptions.workerSrc = new URL(WORKER_URL, import.meta.url).href;

    const scroll = document.createElement('div');
    scroll.className = 'source-scroll';
    this.host.appendChild(scroll);
    this.scroll = scroll;

    const buffer = await blob.arrayBuffer();
    try {
      this.pdf = await pdfjs.getDocument({
        data: buffer,
        cMapUrl: CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: STANDARD_FONT_URL,
        wasmUrl: WASM_URL,
      }).promise;
    } catch (error) {
      status.textContent =
        error && error.name === 'PasswordException' ? this.text('pdfPassword') : this.text('pdfInvalid');
      return;
    }
    if (this.disposed || token !== this.renderToken) return;

    status.remove();
    this.buildToolbar(name, this.pdf.numPages);

    for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
      const holder = document.createElement('div');
      holder.className = 'source-page';
      holder.dataset.pageNumber = String(pageNumber);
      scroll.appendChild(holder);
      this.pages.push({ holder, pageNumber, viewport: null, canvas: null });
    }

    await this.renderPages(token);
    this.fitWidth();
  }

  buildToolbar(name, pageCount) {
    const bar = document.createElement('div');
    bar.className = 'source-toolbar';

    const label = document.createElement('span');
    label.className = 'source-name';
    label.textContent = name;
    bar.appendChild(label);

    const spacer = document.createElement('span');
    spacer.className = 'source-spacer';
    bar.appendChild(spacer);

    const makeButton = (text, title, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'source-btn';
      button.textContent = text;
      button.title = title;
      button.addEventListener('click', onClick);
      bar.appendChild(button);
      return button;
    };

    makeButton('−', this.text('pdfZoomOut'), () => this.zoom(1 / 1.2));
    this.scaleLabel = document.createElement('span');
    this.scaleLabel.className = 'source-scale';
    bar.appendChild(this.scaleLabel);
    makeButton('+', this.text('pdfZoomIn'), () => this.zoom(1.2));
    makeButton(this.text('pdfFitWidth'), this.text('pdfFitWidth'), () => this.fitWidth());

    this.host.insertBefore(bar, this.host.firstChild);
  }

  /* ----------------------------------------------------------- page render */

  async renderPages(token) {
    const available = this.scroll ? this.scroll.clientWidth - 24 : 800;
    const targetScale = this.scale || Math.min(2, Math.max(MIN_RENDER_SCALE, available / 612));

    for (const entry of this.pages) {
      if (this.disposed || token !== this.renderToken) return;
      const page = await this.pdf.getPage(entry.pageNumber);
      if (this.disposed || token !== this.renderToken) return;

      const viewport = page.getViewport({ scale: targetScale });
      entry.viewport = viewport;

      entry.holder.style.width = `${Math.floor(viewport.width)}px`;
      entry.holder.style.height = `${Math.floor(viewport.height)}px`;

      const canvas = document.createElement('canvas');
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      entry.canvas = canvas;
      entry.holder.appendChild(canvas);

      const context = canvas.getContext('2d');
      await page.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      }).promise;
      if (this.disposed || token !== this.renderToken) return;

      this.pages[entry.pageNumber] = entry;
      this.drawOverlays(entry);
    }

    this.scale = targetScale;
    this.updateScaleLabel();
    this.applyHighlight();
  }

  /* --------------------------------------------------------------- overlays */

  /* One rectangle per parsed block. Clicking toggles the selection, which the
     page mirrors in the result pane.

     Pages render progressively, so this is called again after each page's
     canvas is ready; a page without a viewport yet has nothing to place
     rectangles on and is skipped. */
  drawOverlays(entry) {
    if (!entry || !entry.holder || !entry.viewport) return;

    if (entry.layer) entry.layer.remove();
    const layer = document.createElement('div');
    layer.className = 'source-overlay-layer';
    entry.holder.appendChild(layer);
    entry.layer = layer;

    const blocks = (this.blockMap && this.blockMap.get(entry.pageNumber - 1)) || [];
    const viewport = entry.viewport;
    const list = [];

    blocks.forEach((block) => {
      const box = document.createElement('button');
      box.type = 'button';
      box.className = `source-box source-box--${block.type}`;
      box.dataset.pageIdx = String(entry.pageNumber - 1);
      box.dataset.blockIndex = String(block.index);
      const [x0, y0, x1, y1] = block.bbox;
      box.style.left = `${x0 * viewport.width}px`;
      box.style.top = `${y0 * viewport.height}px`;
      box.style.width = `${Math.max(2, (x1 - x0) * viewport.width)}px`;
      box.style.height = `${Math.max(2, (y1 - y0) * viewport.height)}px`;
      box.title = block.type;
      box.addEventListener('click', (event) => {
        event.preventDefault();
        this.options.onSelect && this.options.onSelect({ pageIdx: entry.pageNumber - 1, index: block.index });
      });
      box.addEventListener('mouseenter', () => {
        this.options.onHover && this.options.onHover({ pageIdx: entry.pageNumber - 1, index: block.index });
      });
      box.addEventListener('mouseleave', () => {
        this.options.onHover && this.options.onHover(null);
      });
      layer.appendChild(box);
      list.push({ key: `${entry.pageNumber - 1}:${block.index}`, element: box });
    });

    this.overlays.set(entry.pageNumber - 1, list);
  }

  /* Give the viewer the parsed blocks and the pages that carry a rendered
     block; a block the renderer dropped has nothing to highlight. */
  setBlocks(blockMap, renderedKeys) {
    this.blockMap = blockMap;
    this.renderedKeys = renderedKeys || new Set();
    if (!this.pages.length) return;
    this.pages.forEach((entry) => {
      if (!entry || !entry.holder || !entry.viewport) return;
      this.drawOverlays(entry);
    });
    this.applyHighlight();
  }

  highlight(key, kind) {
    if (kind === 'select') {
      this.selected = key;
    } else {
      this.hovered = key;
    }
    this.applyHighlight();
  }

  applyHighlight() {
    const active = this.hovered || this.selected;
    this.overlays.forEach((list) => {
      list.forEach(({ key, element }) => {
        element.classList.toggle('is-selected', key === this.selected);
        element.classList.toggle('is-hovered', key === this.hovered);
        /* A block with no counterpart in the result has nothing to compare
           against, so keep it quiet rather than inviting a click that does
           nothing. */
        element.classList.toggle('is-muted', !!this.renderedKeys && !this.renderedKeys.has(key));
        element.classList.toggle('is-active', key === active);
      });
    });
    if (active) this.scrollToActive(active);
  }

  /* Bring the highlighted region into view, but only when the highlight came
     from the other pane: scrolling under the user's own cursor would fight
     them. */
  scrollToActive(key) {
    if (!key || !this.options.autoScroll) return;
    let target = null;
    this.overlays.forEach((list) => {
      list.forEach((entry) => {
        if (entry.key === key) target = entry.element;
      });
    });
    if (!target) return;
    const box = target.getBoundingClientRect();
    const hostBox = this.host.getBoundingClientRect();
    if (box.top < hostBox.top + 8 || box.bottom > hostBox.bottom - 8) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  /* ---------------------------------------------------------------- zooming */

  zoom(factor) {
    if (!this.pdf) return;
    const next = Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, (this.scale || 1) * factor));
    if (Math.abs(next - this.scale) < 0.01) return;
    this.scale = next;
    this.rerender();
  }

  fitWidth() {
    if (!this.pdf || !this.scroll) return;
    const available = this.scroll.clientWidth - 24;
    const first = this.pages[1];
    if (!first || !first.viewport) return;
    const unscaled = first.viewport.width / this.scale;
    this.scale = Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, available / unscaled));
    this.rerender();
  }

  /* Re-render at the new scale. Overlays are rebuilt from the same block map,
     so the highlight survives a zoom. */
  async rerender() {
    if (!this.pdf) return;
    const token = ++this.renderToken;
    this.overlays = new Map();
    this.pages.forEach((entry) => {
      if (!entry || !entry.holder) return;
      entry.holder.innerHTML = '';
      entry.layer = null;
    });
    await this.renderPages(token);
  }

  updateScaleLabel() {
    if (this.scaleLabel) {
      this.scaleLabel.textContent = `${Math.round((this.scale || 1) * 100)}%`;
    }
  }

  /* --------------------------------------------------------------- teardown */

  dispose() {
    this.disposed = true;
    this.renderToken += 1;
    if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
    this.overlays = new Map();
    this.pages = [];
    this.pdf = null;
    this.selected = null;
    this.hovered = null;
    if (this.host) this.host.innerHTML = '';
  }
}
