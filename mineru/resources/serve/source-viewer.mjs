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

/* The worker, the character maps and the standard fonts all resolve against
   this module rather than the document. A page served at / or under the
   platform's proxy prefix would otherwise look for them relative to the
   document, and a missing cMap or font silently drops text from the render —
   which is how a Chinese PDF comes out blank. */
const moduleUrl = (path) => new URL(path, import.meta.url).href;

const CMAP_URL = moduleUrl(`${PDFJS_BASE}/cmaps/`);
const STANDARD_FONT_URL = moduleUrl(`${PDFJS_BASE}/standard_fonts/`);
const WASM_URL = moduleUrl(`${PDFJS_BASE}/wasm/`);
const WORKER_URL = moduleUrl(`${PDFJS_BASE}/legacy/build/pdf.worker.min.mjs`);

const MIN_RENDER_SCALE = 0.4;
const MAX_RENDER_SCALE = 3;

export class SourceViewer {
  constructor(host, options) {
    this.host = host;
    this.options = options || {};
    this.text = this.options.text || ((name) => name);
    this.pdf = null;
    /* Indexed by page number; index 0 is unused. */
    this.pages = [];
    this.pageCount = 0;
    this.scale = null;
    /* page index -> array of { block, element } in page coordinates. */
    this.overlays = new Map();
    this.selected = null;
    this.hovered = null;
    this.observer = null;
    this.resizeFrame = null;
    this.scrollFrame = null;
    this.onScroll = null;
    this.programmaticScroll = 0;
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
      pdfjs = await import(moduleUrl(`${PDFJS_BASE}/legacy/build/pdf.min.mjs`));
    } catch (error) {
      status.textContent = this.text('pdfLoadFailed');
      return;
    }
    if (this.disposed || token !== this.renderToken) return;

    pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;

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
      /* Indexed by page number so a page is reachable from its own number;
         the array is built once and never re-assigned during rendering, or a
         second pass would clear what the first one drew. */
      this.pages[pageNumber] = { holder, pageNumber, viewport: null, canvas: null };
    }
    this.pageCount = this.pdf.numPages;

    await this.renderPages(token);
    this.fitWidth();
  }

  buildToolbar(name, pageCount) {
    const bar = document.createElement('div');
    bar.className = 'source-toolbar';

    /* Page navigation, the same controls the WebUI offers: previous, a page
       box, the total, next. The file name is not shown — the pane already has
       a heading, and a long name pushed the controls off the bar. */
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

    this.prevButton = makeButton('‹', this.text('pdfPrevious'), () => this.goToPage(this.currentPage - 1));

    this.pageInput = document.createElement('input');
    this.pageInput.type = 'number';
    this.pageInput.min = '1';
    this.pageInput.max = String(pageCount);
    this.pageInput.value = '1';
    this.pageInput.className = 'source-page-input';
    this.pageInput.setAttribute('aria-label', this.text('pdfPage'));
    this.pageInput.addEventListener('change', () => this.goToPage(Number(this.pageInput.value)));
    bar.appendChild(this.pageInput);

    this.pageTotal = document.createElement('span');
    this.pageTotal.className = 'source-page-total';
    this.pageTotal.textContent = `/ ${pageCount}`;
    bar.appendChild(this.pageTotal);

    this.nextButton = makeButton('›', this.text('pdfNext'), () => this.goToPage(this.currentPage + 1));

    const spacer = document.createElement('span');
    spacer.className = 'source-spacer';
    bar.appendChild(spacer);

    makeButton('−', this.text('pdfZoomOut'), () => this.zoom(1 / 1.2));
    this.scaleLabel = document.createElement('span');
    this.scaleLabel.className = 'source-scale';
    bar.appendChild(this.scaleLabel);
    makeButton('+', this.text('pdfZoomIn'), () => this.zoom(1.2));
    makeButton(this.text('pdfFitWidth'), this.text('pdfFitWidth'), () => this.fitWidth());

    this.host.insertBefore(bar, this.host.firstChild);
    this.currentPage = 1;

    /* Keep the page box in step when the user scrolls by hand instead of using
       the arrows. Without this the box keeps showing the last page that was
       jumped to, which reads as a wrong page number. */
    this.onScroll = () => {
      if (this.scrollFrame) return;
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null;
        this.syncPageFromScroll();
      });
    };
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true });
  }

  /* The current page is the one covering the top of the viewport. */
  syncPageFromScroll() {
    if (!this.scroll || !this.pageCount) return;
    /* A smooth scroll is still in flight: recomputing now would report the
       page passing by and fight the destination the user just asked for. */
    if (this.programmaticScroll && Date.now() - this.programmaticScroll < 600) return;
    const top = this.scroll.getBoundingClientRect().top;
    /* Start at the first page, not the previous value: with the container's
       padding the very first page is slightly below the top edge and does not
       qualify, which would otherwise leave a stale page number on screen. */
    let visible = 1;
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const entry = this.pages[pageNumber];
      if (!entry || !entry.holder) continue;
      const box = entry.holder.getBoundingClientRect();
      /* A page still in view but scrolled past has its top above the viewport,
         so the last such page is the one being read. */
      if (box.top - top <= 1) visible = pageNumber;
      else break;
    }
    if (visible !== this.currentPage) {
      this.currentPage = visible;
      this.updatePageControls();
    }
  }

  /* Jump to a page and report it, so the toolbar stays in step with a click
     on a block in the result pane. */
  goToPage(pageNumber) {
    if (!this.pageCount) return;
    const target = Math.min(this.pageCount, Math.max(1, Number(pageNumber) || 1));
    const entry = this.pages[target];
    /* Record the destination before scrolling: the scroll listener would
       otherwise report the pages passing by while a smooth scroll is in
       flight, and the box would settle on the wrong number. */
    this.currentPage = target;
    this.updatePageControls();
    if (entry && entry.holder) {
      this.programmaticScroll = Date.now();
      entry.holder.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  updatePageControls() {
    if (this.pageInput) this.pageInput.value = String(this.currentPage);
    if (this.prevButton) this.prevButton.disabled = this.currentPage <= 1;
    if (this.nextButton) this.nextButton.disabled = this.currentPage >= this.pageCount;
  }

  /* ----------------------------------------------------------- page render */

  async renderPages(token) {
    const available = this.scroll ? this.scroll.clientWidth - 24 : 800;
    const targetScale = this.scale || Math.min(2, Math.max(MIN_RENDER_SCALE, available / 612));

    /* Pages are indexed by their number, so iterate that range rather than the
       array: index 0 is unused and must not be visited. */
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const entry = this.pages[pageNumber];
      if (!entry) continue;
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

      this.drawOverlays(entry);
      this.reportPage(entry);
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
    if (!this.pageCount) return;
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const entry = this.pages[pageNumber];
      if (!entry || !entry.holder || !entry.viewport) continue;
      this.drawOverlays(entry);
    }
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
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const entry = this.pages[pageNumber];
      if (!entry || !entry.holder) continue;
      entry.holder.innerHTML = '';
      entry.layer = null;
    }
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
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    if (this.scroll && this.onScroll) this.scroll.removeEventListener('scroll', this.onScroll);
    this.overlays = new Map();
    this.pages = [];
    this.pageCount = 0;
    this.pdf = null;
    this.selected = null;
    this.hovered = null;
    if (this.host) this.host.innerHTML = '';
  }

  /* Tell the page how far rendering has come. Loading a large PDF is the
     slowest step before the user can compare anything, and without this the
     pane just sits empty with no way to tell "working" from "stuck". */
  reportPage(entry) {
    if (this.options.onProgress) {
      this.options.onProgress({ rendered: entry.pageNumber, total: this.pageCount });
    }
  }
}
