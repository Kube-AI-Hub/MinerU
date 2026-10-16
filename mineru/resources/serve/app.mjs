/* Copyright 2026 Kube AI Hub.
   Playground behaviour. Everything goes through the engine's own /v1 API on the
   same origin and port, so the page works identically whether it is opened
   directly or embedded in the platform's endpoint overview.

   Parsing is done once per file: the request asks for the zip response, which
   carries the Markdown, the structured JSON and the extracted images together.
   Previewing and downloading then work from that single result instead of
   re-parsing for every format.

   The source pane and the result pane highlight each other. Both sides key
   their elements by page index and block index, taken from the parse result,
   so no extra mapping is needed to point one at the other. */
import { SourceViewer } from './source-viewer.mjs';

window.MinerUSourceViewer = SourceViewer;

(function () {
  var i18n = window.MinerUPlaygroundI18n;
  var t = i18n.t;

  var TIERS = ['flash', 'basic', 'standard', 'advanced'];

  /* Formats the API can return, plus the ones the server renders for the page
     from the result it already holds. `render` marks the latter: the parse API
     refuses them without an API key, so the page asks the engine to render them
     from the archive instead of downloading them from the job, which keeps them
     available without a token, exactly like the WebUI. */
  var FORMATS = [
    { id: 'markdown', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
    { id: 'middle_json', label: 'JSON', ext: 'json', mime: 'application/json' },
    { id: 'structured_content', label: 'Structured JSON', ext: 'json', mime: 'application/json' },
    { id: 'html', label: 'HTML', ext: 'html', mime: 'text/html', render: true },
    { id: 'latex', label: 'LaTeX', ext: 'zip', mime: 'application/zip', render: true },
    { id: 'docx', label: 'DOCX', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', render: true },
    { id: 'epub', label: 'EPUB', ext: 'epub', mime: 'application/epub+zip', render: true },
    { id: 'pdf', label: 'PDF', ext: 'pdf', mime: 'application/pdf', render: true },
    { id: 'zip', label: 'ZIP', ext: 'zip', mime: 'application/zip' }
  ];

  var IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
  var TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|xml|html?|tex|log|ya?ml)$/i;

  var state = {
    /* Files extracted from the parse response, keyed by name. */
    artifacts: {},
    /* Object URLs created for the preview and for downloaded images. */
    objectUrls: [],
    markdown: '',
    filename: '',
    demo: null,
    view: 'markdown',
    selectedTier: 'standard',
    /* Parse geometry: page -> blocks, and the keys the renderer kept. */
    blockMap: new Map(),
    renderedKeys: new Set(),
    /* Which block the user picked, as "page:index". */
    selectedBlock: null,
    viewer: null
  };

  function token() {
    var checkbox = document.getElementById('use-token');
    if (!checkbox || !checkbox.checked) return '';
    return new URLSearchParams(window.location.search).get('token') || '';
  }

  /* A token in the URL is the platform telling this page to use it, so the
     checkbox starts on. Leaving it off meant the token was silently ignored and
     every gated action looked like it had no credential at all. */
  function initTokenToggle() {
    var checkbox = document.getElementById('use-token');
    if (!checkbox) return;
    if (new URLSearchParams(window.location.search).has('token')) {
      checkbox.checked = true;
    }
  }

  function authHeaders() {
    var value = token();
    return value ? { Authorization: 'Bearer ' + value } : {};
  }

  function setStatus(message, kind) {
    var node = document.getElementById('status');
    node.textContent = message || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  function releaseObjectUrls() {
    state.objectUrls.forEach(function (url) {
      URL.revokeObjectURL(url);
    });
    state.objectUrls = [];
  }

  function trackObjectUrl(url) {
    state.objectUrls.push(url);
    return url;
  }

  /* ---------------------------------------------------------------- tiers */

  function tierLabel(tier) {
    var names = { flash: 'flash', basic: 'basic', standard: 'standard', advanced: 'advanced' };
    return names[tier] || tier;
  }

  function renderTier() {
    var index = Number(document.getElementById('tier').value);
    var tier = TIERS[index] || 'standard';
    state.selectedTier = tier;

    document.getElementById('tier-name').textContent = t('tierName_' + tier);
    document.getElementById('tier-notice').textContent = t('tierSpeed_' + tier);
    document.getElementById('tier-desc').textContent = t('tierDesc_' + tier);

    document.querySelectorAll('.tier-tick').forEach(function (tick, i) {
      tick.classList.toggle('active', i === index);
    });
  }

  function buildTierTicks() {
    var host = document.getElementById('tier-ticks');
    host.innerHTML = '';
    TIERS.forEach(function (tier, index) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'tier-tick';
      button.textContent = tier;
      button.addEventListener('click', function () {
        document.getElementById('tier').value = String(index);
        renderTier();
      });
      host.appendChild(button);
    });
  }

  /* -------------------------------------------------------------- progress */

  /* The stages the panel walks through. `queued` and `parsing` come from the
     engine's own task document, so a stall is visible where it happens rather
     than as one long "parsing…" line. */
  var STAGES = ['prepare', 'submit', 'queued', 'parsing', 'download', 'collect', 'done'];

  var progress = { started: 0, timer: null, current: null };

  function buildProgressSteps() {
    var list = document.getElementById('progress-steps');
    list.innerHTML = '';
    STAGES.forEach(function (stage) {
      var item = document.createElement('li');
      item.className = 'progress-step';
      item.dataset.stage = stage;
      var dot = document.createElement('span');
      dot.className = 'progress-dot';
      item.appendChild(dot);
      var label = document.createElement('span');
      label.textContent = t('stage_' + stage);
      item.appendChild(label);
      list.appendChild(item);
    });
  }

  /* Mark a stage and everything before it as done. A later stage replaces the
     current one, which is how a poll loop reports forward progress. */
  function setStage(stage, kind) {
    var index = STAGES.indexOf(stage);
    if (index < 0) return;
    progress.current = stage;
    document.querySelectorAll('.progress-step').forEach(function (item) {
      var itemIndex = STAGES.indexOf(item.dataset.stage);
      var isCurrent = itemIndex === index;
      /* A stage is exactly one of done / active / failed. Marking the failed
         stage as both active and failed left it looking in-progress with an
         error colour, which is contradictory. */
      item.classList.toggle('is-done', itemIndex < index || (isCurrent && kind === 'done'));
      item.classList.toggle('is-active', isCurrent && kind !== 'done' && kind !== 'failed');
      item.classList.toggle('is-failed', isCurrent && kind === 'failed');
    });
    updateElapsed();
  }

  function updateElapsed() {
    if (!progress.started) return;
    var seconds = ((Date.now() - progress.started) / 1000).toFixed(2);
    var node = document.getElementById('progress-elapsed');
    var failed = document.querySelector('.progress-step.is-failed');
    if (failed) {
      node.textContent = t('stageFailed', { seconds: seconds });
      node.className = 'progress-elapsed is-failed';
    } else if (progress.current === 'done') {
      node.textContent = t('stageDone', { seconds: seconds });
      node.className = 'progress-elapsed is-done';
    } else {
      node.textContent = t('stageRunning', {
        stage: t('stage_' + (progress.current || 'prepare')),
        seconds: seconds
      });
      node.className = 'progress-elapsed';
    }
  }

  function startProgress() {
    progress.started = Date.now();
    document.getElementById('progress').hidden = false;
    buildProgressSteps();
    setStage('prepare');
    if (progress.timer) clearInterval(progress.timer);
    progress.timer = setInterval(updateElapsed, 100);
  }

  function stopProgress() {
    if (progress.timer) clearInterval(progress.timer);
    progress.timer = null;
    updateElapsed();
  }

  /* ------------------------------------------------------------------- page */

  /* Page range as two sliders, the same shape the WebUI uses. They stay
     disabled until a PDF's page count is known, so an empty range cannot be
     submitted as a real one. */
  function initPageRange() {
    var start = document.getElementById('page-start');
    var end = document.getElementById('page-end');
    var startOut = document.getElementById('page-start-value');
    var endOut = document.getElementById('page-end-value');

    function sync(changed) {
      var total = Number(start.max) || 1;
      var a = Number(start.value);
      var b = Number(end.value);
      if (changed === 'start' && a > b) {
        end.value = String(a);
        b = a;
      }
      if (changed === 'end' && b < a) {
        start.value = String(b);
        a = b;
      }
      startOut.textContent = String(a);
      endOut.textContent = String(b);
      var selected = b - a + 1;
      document.getElementById('page-summary').textContent = t('pageSelected', {
        from: a,
        to: b,
        count: selected,
        total: total
      });
    }

    start.addEventListener('input', function () {
      sync('start');
    });
    end.addEventListener('input', function () {
      sync('end');
    });
    sync();
  }

  function setPageCount(count) {
    var start = document.getElementById('page-start');
    var end = document.getElementById('page-end');
    if (!count || count < 1) {
      start.max = '1';
      end.max = '1';
      start.disabled = true;
      end.disabled = true;
      document.getElementById('page-summary').textContent = t('pageUnknown');
      return;
    }
    start.max = String(count);
    end.max = String(count);
    start.value = '1';
    end.value = String(count);
    start.disabled = false;
    end.disabled = false;
    document.getElementById('page-summary').textContent = t('pageSelected', {
      from: 1,
      to: count,
      count: count,
      total: count
    });
  }

  function pageRangeValue() {
    var start = document.getElementById('page-start');
    var end = document.getElementById('page-end');
    if (start.disabled || !start.max || Number(start.max) <= 1) return '';
    var a = Number(start.value);
    var b = Number(end.value);
    if (a === 1 && b === Number(start.max)) return '';
    return a === b ? String(a) : a + '-' + b;
  }

  function forceOcr() {
    var box = document.getElementById('force-ocr');
    return !!(box && box.checked);
  }

  /* Clear the preview and the result, including any object URLs the preview
     created, so a new file never inherits the previous one's blobs. */
  function resetViews() {
    releaseObjectUrls();
    state.artifacts = {};
    state.markdown = '';
    state.blockMap = new Map();
    state.renderedKeys = new Set();
    state.selectedBlock = null;
    if (state.viewer) {
      state.viewer.dispose();
      state.viewer = null;
    }
    document.getElementById('source-meta').textContent = '';
    var source = document.getElementById('source-body');
    source.classList.remove('source-viewer');
    source.innerHTML = '';
    var empty = document.createElement('p');
    empty.className = 'muted placeholder';
    empty.textContent = t('sourceEmpty');
    source.appendChild(empty);

    var result = document.getElementById('result');
    result.innerHTML = '';
    var resultEmpty = document.createElement('p');
    resultEmpty.className = 'muted placeholder';
    resultEmpty.textContent = t('resultEmpty');
    result.appendChild(resultEmpty);

    buildDownloadMenu();
    setStatus('');
  }

  /* Preview the chosen file locally. The browser already knows how to draw an
     image, so that needs no server round trip; a PDF goes through the viewer
     because the comparison needs per-block overlays on top of the page. */
  function renderSourcePreview(blob, name) {
    var host = document.getElementById('source-body');
    host.innerHTML = '';
    host.classList.remove('source-viewer');

    if (/\.pdf$/i.test(name)) {
      startViewer(host, blob, name);
      return;
    }

    if (IMAGE_EXTENSIONS.test(name)) {
      var image = document.createElement('img');
      image.className = 'source-image';
      image.alt = name;
      image.src = trackObjectUrl(URL.createObjectURL(blob));
      host.appendChild(image);
      return;
    }

    if (TEXT_EXTENSIONS.test(name)) {
      blob.text().then(function (text) {
        var pre = document.createElement('pre');
        pre.className = 'source-text';
        pre.textContent = text.slice(0, 200000);
        host.appendChild(pre);
      });
      return;
    }

    /* Office formats and anything else the browser cannot draw: say so rather
       than showing a blank pane, and note that parsing still works. */
    var note = document.createElement('p');
    note.className = 'muted placeholder';
    note.textContent = t('sourceUnsupported');
    host.appendChild(note);
  }

  /* The viewer draws the page and the block overlays, and reports clicks back
     so the result pane can highlight the matching element. */
  function startViewer(host, blob, name) {
    if (state.viewer) state.viewer.dispose();
    state.viewer = new window.MinerUSourceViewer(host, {
      text: t,
      autoScroll: true,
      onSelect: function (block) {
        selectBlock(block ? blockKey(block) : null);
      },
      onHover: function (block) {
        highlightResult(block ? blockKey(block) : null, 'hover');
      },
      onProgress: function (info) {
        /* The page count is only known once pdf.js has parsed the document,
           which is also when the range sliders can be enabled. */
        if (info.total && Number(document.getElementById('page-start').max) !== info.total) {
          setPageCount(info.total);
        }
        if (info.rendered === info.total && state.filename) {
          document.getElementById('source-meta').textContent = state.filename;
        }
      }
    });
    state.viewer.setBlocks(state.blockMap, state.renderedKeys);
    state.viewer.load(blob, name).catch(function () {
      /* The viewer reports its own failures in place. */
    });
  }

  function blockKey(block) {
    return block.pageIdx + ':' + block.index;
  }

  /* ------------------------------------------------------------ result view */

  /* The rendered blocks carry the same page/index keys as the parse geometry,
     so the two panes can point at each other without a second lookup table. */
  function resultBlocks() {
    var host = document.getElementById('result');
    return host ? host.querySelectorAll('.markdown-body .docvortex-block') : [];
  }

  function highlightResult(key, kind) {
    resultBlocks().forEach(function (element) {
      var elementKey = element.getAttribute('data-page-idx') + ':' + element.getAttribute('data-block-index');
      element.classList.toggle(
        kind === 'select' ? 'is-source-selected' : 'is-source-hover',
        key ? elementKey === key : false
      );
      if (kind === 'select' && key && elementKey === key) {
        element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  /* Selecting in one pane selects in the other: the highlight is a single
     piece of state, so a click either side clears the previous pick. */
  function selectBlock(key) {
    state.selectedBlock = key;
    if (state.viewer) state.viewer.highlight(key, 'select');
    highlightResult(key, 'select');
  }

  function bindResultHighlighting() {
    resultBlocks().forEach(function (element) {
      var key = element.getAttribute('data-page-idx') + ':' + element.getAttribute('data-block-index');
      element.addEventListener('mouseenter', function () {
        if (state.viewer) state.viewer.highlight(key, 'hover');
      });
      element.addEventListener('mouseleave', function () {
        if (state.viewer) state.viewer.highlight(null, 'hover');
      });
      element.addEventListener('click', function () {
        selectBlock(state.selectedBlock === key ? null : key);
      });
    });
  }

  function setResultMarkdown(html) {
    var host = document.getElementById('result');
    host.innerHTML = '';
    var body = document.createElement('div');
    body.className = 'markdown-body';
    /* The HTML is rendered by the engine from its own Markdown, so it is as
       trusted as the API response itself. */
    body.innerHTML = html;
    host.appendChild(body);
    /* Images inside the Markdown point at the archive's relative paths; swap
       them for the blobs extracted from the same response. */
    host.querySelectorAll('img').forEach(function (image) {
      var src = image.getAttribute('src') || '';
      var key = src.replace(/^\.\//, '');
      if (state.artifacts[key]) {
        image.src = state.artifacts[key].url;
      } else if (/^images\//.test(key)) {
        image.removeAttribute('src');
        image.alt = t('imageMissing');
      }
    });
    bindResultHighlighting();
    /* Keep the pick visible across a re-render, e.g. after a zoom or a tab
       switch. */
    if (state.selectedBlock) highlightResult(state.selectedBlock, 'select');
  }

  function setResultJson(value) {
    var host = document.getElementById('result');
    host.innerHTML = '';
    var pre = document.createElement('pre');
    pre.className = 'json-view';
    pre.innerHTML = highlightJson(JSON.stringify(value, null, 2));
    host.appendChild(pre);
  }

  /* Minimal JSON colouring: escapes first, then wraps tokens. Doing this with
     string replacement avoids pulling in a highlighter for one pane. */
  function highlightJson(text) {
    var escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = 'json-number';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'json-key' : 'json-string';
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  function renderResult() {
    if (!state.markdown) return;
    if (state.view === 'json') {
      var structured = state.artifacts['middle_json.json'];
      if (!structured) {
        setResultJson({ note: t('jsonUnavailable') });
        return;
      }
      structured.blob.text().then(function (text) {
        try {
          setResultJson(JSON.parse(text));
        } catch (error) {
          setResultJson({ note: t('jsonUnavailable') });
        }
      });
      return;
    }
    var structured = state.artifacts['middle_json.json'];
    if (!structured) {
      setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
      return;
    }
    /* Render through the engine so the preview matches the WebUI, which uses
       the same renderer for its Markdown tab. The same response carries the
       block geometry the source viewer overlays. */
    structured.blob.text().then(function (text) {
      var middle;
      try {
        middle = JSON.parse(text);
      } catch (error) {
        setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
        return;
      }
      return fetch('./render', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
        body: JSON.stringify({ middle_json: middle })
      })
        .then(function (response) {
          return response.ok ? response.json() : null;
        })
        .then(function (payload) {
          if (payload && typeof payload.html === 'string') {
            applyGeometry(payload);
            setResultMarkdown(payload.html);
          } else {
            setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
          }
        })
        .catch(function (error) {
          /* Falling back to the raw Markdown keeps the page usable, but a
             silent fallback hides the reason the rendered preview is missing,
             so leave a trail for whoever has to diagnose it. */
          console.error('MinerU: rendered preview failed, showing raw Markdown', error);
          setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
        });
    });
  }

  /* Hand the source viewer the geometry, and remember which blocks the
     renderer kept so an unmatched region is not presented as clickable. */
  function applyGeometry(payload) {
    var map = new Map();
    (payload.blocks || []).forEach(function (block) {
      var list = map.get(block.page);
      if (!list) {
        list = [];
        map.set(block.page, list);
      }
      list.push(block);
    });
    state.blockMap = map;
    state.renderedKeys = new Set(payload.rendered_blocks || []);
    if (state.viewer) state.viewer.setBlocks(state.blockMap, state.renderedKeys);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.rtab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-view') === view);
    });
    renderResult();
  }

  /* -------------------------------------------------------------- downloads */

  function buildDownloadMenu() {
    var menu = document.getElementById('download-menu');
    menu.innerHTML = '';
    FORMATS.forEach(function (format) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'download-item';
      item.dataset.format = format.id;

      var label = document.createElement('span');
      label.textContent = format.label;
      item.appendChild(label);

      var hint = document.createElement('span');
      hint.className = 'hint';
      item.appendChild(hint);

      item.addEventListener('click', function () {
        download(format);
      });
      menu.appendChild(item);
    });
    refreshDownloadMenu();
  }

  function artifactFor(format) {
    if (format.id === 'markdown') return state.artifacts['markdown.md'];
    if (format.id === 'middle_json') return state.artifacts['middle_json.json'];
    if (format.id === 'structured_content') return state.artifacts['structured_content.json'];
    if (format.id === 'zip') return state.artifacts['__zip'];
    return state.artifacts[format.id + '.' + format.ext];
  }

  /* Formats the engine renders on request have no artifact in the archive, so
     they are available whenever a parse result is: the server produces them
     from the same result the preview came from. */
  function formatAvailable(format) {
    if (format.render) return !!state.artifacts['__zip'];
    return !!artifactFor(format);
  }

  function refreshDownloadMenu() {
    var hasResult = !!state.markdown;
    document.querySelectorAll('.download-item').forEach(function (item) {
      var format = FORMATS.filter(function (f) {
        return f.id === item.dataset.format;
      })[0];
      var hint = item.querySelector('.hint');

      if (!hasResult) {
        item.disabled = true;
        hint.textContent = '';
      } else if (!formatAvailable(format)) {
        item.disabled = true;
        hint.textContent = t('notProduced');
      } else {
        item.disabled = false;
        hint.textContent = '';
      }
    });
  }

  function download(format) {
    if (format.render) {
      downloadRendered(format);
      return;
    }
    var artifact = artifactFor(format);
    if (!artifact) return;
    saveBlob(artifact.blob, baseName() + '.' + format.ext);
  }

  /* The archive is posted back so the server can render the format with the
     same renderer the WebUI uses; a failure is reported in place rather than
     silently doing nothing. */
  function downloadRendered(format) {
    var archive = state.artifacts['__zip'];
    if (!archive) return;
    var item = document.querySelector('.download-item[data-format="' + format.id + '"]');
    if (item) item.disabled = true;
    setStatus(t('renderingFormat', { format: format.label }), '');
    fetch('./download?format=' + encodeURIComponent(format.id) + '&name=' + encodeURIComponent(baseName()), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/zip' }, authHeaders()),
      body: archive.blob
    })
      .then(function (response) {
        if (!response.ok) {
          return response.json().then(
            function (payload) {
              throw new Error((payload && payload.error) || 'HTTP ' + response.status);
            },
            function () {
              throw new Error('HTTP ' + response.status);
            }
          );
        }
        /* The server names the file the way the WebUI does (a LaTeX bundle,
           a rendered PDF), so use its name instead of rebuilding one. */
        var named = filenameFrom(response.headers.get('Content-Disposition'));
        return response.blob().then(function (blob) {
          return { blob: blob, filename: named || baseName() + '.' + format.ext };
        });
      })
      .then(function (result) {
        saveBlob(result.blob, result.filename);
      })
      .catch(function (error) {
        setStatus(t('failed', { message: error.message }), 'error');
      })
      .finally(function () {
        if (item) item.disabled = false;
        refreshDownloadMenu();
      });
  }

  function filenameFrom(disposition) {
    if (!disposition) return '';
    var match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (!match) return '';
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return match[1];
    }
  }

  function baseName() {
    return (state.filename || 'result').replace(/\.[^.]+$/, '');
  }

  function saveBlob(blob, filename) {
    var link = document.createElement('a');
    link.href = trackObjectUrl(URL.createObjectURL(blob));
    link.download = filename;
    link.click();
    setStatus(t('downloaded', { name: filename }), 'ok');
  }
  /* --------------------------------------------------------------- parsing */

  function demoButton(name) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'demo-chip';
    chip.textContent = name;
    chip.addEventListener('click', function () {
      document.querySelectorAll('.demo-chip').forEach(function (other) {
        other.classList.toggle('selected', other === chip);
      });
      state.demo = name;
      document.getElementById('file').value = '';
      setStatus('');
      fetch('./demo/' + name, { headers: authHeaders() })
        .then(function (response) {
          if (!response.ok) throw new Error('cannot load the bundled example');
          return response.blob();
        })
        .then(function (blob) {
          resetViews();
          state.demo = name;
          state.filename = name;
          document.getElementById('source-meta').textContent = name;
          renderSourcePreview(blob, name);
        })
        .catch(function (error) {
          setStatus(t('failed', { message: error.message }), 'error');
        });
    });
    return chip;
  }

  function loadDemos() {
    fetch('./config', { headers: authHeaders() })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (config) {
        if (!config) return;
        document.getElementById('version').textContent = 'MinerU ' + config.version;
        var names = config.demo_documents || [];
        if (!names.length) return;
        var list = document.getElementById('demos-list');
        names.forEach(function (name) {
          list.appendChild(demoButton(name));
        });
        document.getElementById('demos').hidden = false;
      })
      .catch(function () {
        /* The examples are a convenience; parsing still works without them. */
      });
  }

  function selectedFile() {
    var input = document.getElementById('file');
    if (input.files && input.files.length) return input.files[0];
    return null;
  }

  function buildRequest() {
    var file = selectedFile();
    if (!file && !state.demo) {
      setStatus(t('needFile'), 'error');
      return null;
    }
    var query = new URLSearchParams();
    query.set('tier', state.selectedTier);
    /* The checkbox is the only OCR control, matching the original WebUI: it
       means "ignore the text layer", which is exactly the `ocr` mode. */
    query.set('ocr_mode', forceOcr() ? 'ocr' : 'auto');
    var range = pageRangeValue();
    if (range) query.set('page_range', range);
    /* Ask for `zip` alongside the formats the preview needs: the result
       endpoint only serves an archive when zip was requested up front, and one
       archive is what carries the Markdown, the JSON and the images together.
       `response_format` itself is not a submit parameter — it is chosen when
       the result is fetched. */
    ['markdown', 'middle_json', 'structured_content', 'zip'].forEach(function (format) {
      query.append('output_formats', format);
    });

    var source = file
      ? Promise.resolve({ blob: file, name: file.name })
      : fetch('./demo/' + state.demo, { headers: authHeaders() }).then(function (response) {
          if (!response.ok) throw new Error('cannot load the bundled example');
          return response.blob().then(function (blob) {
            return { blob: blob, name: state.demo };
          });
        });

    return source.then(function (loaded) {
      var form = new FormData();
      form.append('files', loaded.blob, loaded.name);
      return { form: form, query: query, name: loaded.name, blob: loaded.blob };
    });
  }

  function extractError(payload) {
    if (!payload) return '';
    if (typeof payload.msg === 'string') return payload.msg;
    if (typeof payload.detail === 'string') return payload.detail;
    if (typeof payload.message === 'string') return payload.message;
    var files = payload.files || [];
    for (var i = 0; i < files.length; i += 1) {
      var error = files[i] && files[i].error;
      if (error && typeof error.message === 'string') return error.message;
    }
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
    return '';
  }

  /* The Markdown the engine renders for the UI lives in the archive as
     result.html; the plain Markdown is markdown.md. Both are optional: a
     response without the rendered HTML still shows the raw Markdown. */
  function unpackZip(zipBlob) {
    if (typeof window.DecompressionStream !== 'function') {
      return Promise.reject(new Error(t('zipUnsupported')));
    }
    return zipBlob.arrayBuffer().then(function (buffer) {
      var view = new DataView(buffer);
      var files = [];
      var offset = 0;

      /* Minimal ZIP reader: the engine writes a plain archive, and pulling in a
         zip library would be a large dependency for one directory of files. */
      function u16(at) {
        return view.getUint16(at, true);
      }
      function u32(at) {
        return view.getUint32(at, true);
      }

      while (offset + 30 <= buffer.byteLength) {
        if (u32(offset) !== 0x04034b50) break;
        var method = u16(offset + 8);
        var compressedSize = u32(offset + 18);
        var nameLength = u16(offset + 26);
        var extraLength = u16(offset + 28);
        var nameStart = offset + 30;
        var name = new TextDecoder().decode(new Uint8Array(buffer, nameStart, nameLength));
        var dataStart = nameStart + nameLength + extraLength;
        var dataEnd = dataStart + compressedSize;
        files.push({ name: name, method: method, start: dataStart, end: dataEnd });
        offset = dataEnd;
      }

      return Promise.all(
        files.map(function (entry) {
          var slice = buffer.slice(entry.start, entry.end);
          if (entry.method === 0) {
            return Promise.resolve({ name: entry.name, blob: new Blob([slice]) });
          }
          if (entry.method !== 8) {
            return Promise.resolve(null);
          }
          var stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Response(stream)
            .blob()
            .then(function (blob) {
              return { name: entry.name, blob: blob };
            });
        })
      ).then(function (entries) {
        return entries.filter(Boolean);
      });
    });
  }

  function storeArtifacts(entries, zipBlob) {
    entries.forEach(function (entry) {
      state.artifacts[entry.name] = entry;
    });
    state.artifacts['__zip'] = { name: 'result.zip', blob: zipBlob };

    /* Markdown with images inlined as data URLs. The plain markdown.md refers to
       images/... which only resolve inside the archive, and the platform's
       Markdown tab shows a single string, so inline them for that view. */
    return entries.reduce(function (chain, entry) {
      return chain.then(function () {
        if (entry.name === 'markdown.md') {
          return entry.blob.text().then(function (text) {
            state.markdown = text;
          });
        }
        if (/^images\//.test(entry.name)) {
          entry.url = trackObjectUrl(URL.createObjectURL(entry.blob));
        }
        return null;
      });
    }, Promise.resolve());
  }

  /* Submit as an async task and poll it, rather than blocking on the
     synchronous call. The task document reports the engine's own status
     (`queued` then `running`), so the progress panel shows which stage the
     request actually reached instead of one opaque wait. */
  function submit() {
    var pending = buildRequest();
    if (!pending) return;
    var button = document.getElementById('submit');
    button.disabled = true;
    setStatus('');
    startProgress();
    var started = Date.now();

    pending
      .then(function (request) {
        resetViews();
        state.filename = request.name;
        document.getElementById('source-meta').textContent = request.name;
        renderSourcePreview(request.blob, request.name);
        setStage('submit');
        return fetch('./v1/tasks?' + request.query.toString(), {
          method: 'POST',
          headers: authHeaders(),
          body: request.form
        }).then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok) {
              throw new Error(extractError(payload) || 'HTTP ' + response.status);
            }
            return payload.task_id;
          });
        });
      })
      .then(function (taskId) {
        setStage('queued');
        return pollTask(taskId);
      })
      .then(function () {
        setStage('download');
        return fetch('./v1/tasks/' + currentTaskId + '/result?response_format=zip', {
          headers: authHeaders()
        }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.blob();
        });
      })
      .then(function (zipBlob) {
        setStage('collect');
        return unpackZip(zipBlob).then(function (entries) {
          return storeArtifacts(entries, zipBlob);
        });
      })
      .then(function () {
        if (!state.markdown) {
          throw new Error(t('noMarkdown'));
        }
        var seconds = ((Date.now() - started) / 1000).toFixed(1);
        renderResult();
        refreshDownloadMenu();
        setStage('done', 'done');
        stopProgress();
        setStatus(t('done', { seconds: seconds }), 'ok');
      })
      .catch(function (error) {
        /* Mark where it stopped rather than the whole panel, so the stage that
           failed is the one the user looks at. */
        setStage(progress.current || 'prepare', 'failed');
        stopProgress();
        setStatus(t('failed', { message: error.message }), 'error');
      })
      .finally(function () {
        button.disabled = false;
      });
  }

  /* Poll the task document until it reaches a terminal state. Each poll also
     carries the failure reason, so a rejected document explains itself instead
     of timing out silently. */
  var currentTaskId = null;

  function pollTask(taskId) {
    currentTaskId = taskId;
    var deadline = Date.now() + 60 * 60 * 1000;
    return new Promise(function (resolve, reject) {
      var tick = function () {
        if (Date.now() > deadline) {
          reject(new Error(t('taskTimeout')));
          return;
        }
        fetch('./v1/tasks/' + taskId, { headers: authHeaders() })
          .then(function (response) {
            return response.json();
          })
          .then(function (payload) {
            var status = payload && payload.status;
            if (status === 'completed') {
              setStage('parsing', 'done');
              resolve(payload);
              return;
            }
            if (status === 'failed' || status === 'cancelled') {
              reject(new Error(extractError(payload) || status));
              return;
            }
            /* `running` means the engine picked the job up and is parsing;
               anything else is still queued. */
            setStage(status === 'running' ? 'parsing' : 'queued');
            setTimeout(tick, 700);
          })
          .catch(function (error) {
            reject(error);
          });
      };
      tick();
    });
  }

  /* ------------------------------------------------------------------- API */

  /* Create the RapiDoc element. It is built on first use, never up front: its
     connectedCallback writes `width: 100vw; height: 100vh` onto the parent
     whenever the parent measures zero, and a hidden section always measures
     zero. Mounting it late means it only ever measures the visible section. */
  function ensureRapidoc() {
    var section = document.getElementById('section-api');
    var doc = document.getElementById('rapidoc');
    if (doc) return doc;

    doc = document.createElement('rapi-doc');
    doc.id = 'rapidoc';
    /* Attributes are set before insertion so the element's first render already
       has them; RapiDoc reads several of these only during connectedCallback. */
    var attributes = {
      'render-style': 'read',
      theme: 'dark',
      'bg-color': '#14215a',
      'text-color': '#deebf6',
      'header-color': '#1f2c6a',
      'primary-color': '#a981f8',
      'load-fonts': 'false',
      'regular-font': 'Inter, PingFang SC, Microsoft YaHei, system-ui, sans-serif',
      'mono-font': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      'show-header': 'false',
      layout: 'row',
      'show-info': 'true',
      'allow-try': 'true',
      'allow-authentication': 'true',
      'allow-spec-url-load': 'false',
      'allow-spec-file-load': 'false',
      'allow-server-selection': 'false',
      'allow-api-list-style-selection': 'false',
      'heading-text': 'MinerU API'
    };
    Object.keys(attributes).forEach(function (name) {
      doc.setAttribute(name, attributes[name]);
    });
    /* RapiDoc resolves relative URLs against the page, which behind the
       platform's proxy is the engine itself. Hand it both the spec and the
       documented server explicitly so "Try" calls the engine rather than the
       platform, and so it works whether the page is at / or under a prefix. */
    var base = window.location.pathname.replace(/\/$/, '');
    doc.setAttribute('spec-url', './openapi.json');
    doc.setAttribute('server-url', base || '/');
    section.appendChild(doc);
    /* RapiDoc writes sizing onto its parent in connectedCallback. Drop it: the
       stylesheet already sizes both, and a leftover 100vw/100vh is what made
       the API tab a full viewport tall while the Parse tab was not. */
    section.style.removeProperty('width');
    section.style.removeProperty('height');
    applyApiToken();
    return doc;
  }

  /* RapiDoc reads `api-key-value` and attaches it to every "Try" request; the
     value is only meaningful when the user opted in, matching the Parse tab. */
  function applyApiToken() {
    var doc = document.getElementById('rapidoc');
    if (!doc) return;
    var value = token();
    if (value) {
      doc.setAttribute('api-key-name', 'Authorization');
      doc.setAttribute('api-key-location', 'header');
      doc.setAttribute('api-key-value', 'Bearer ' + value);
    } else {
      doc.removeAttribute('api-key-name');
      doc.removeAttribute('api-key-location');
      doc.removeAttribute('api-key-value');
    }
  }

  function switchTab(target) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-target') === target);
    });
    document.getElementById('section-test').classList.toggle('active', target === 'test');
    document.getElementById('section-api').classList.toggle('active', target === 'api');
    /* Mount RapiDoc only after its section is visible: it measures the parent
       as it connects, and a `display: none` parent measures zero, which makes it
       stamp `width: 100vw; height: 100vh` onto the section. */
    if (target === 'api') {
      ensureRapidoc();
      syncApiHeight();
    }
  }

  /* Give the API panel the same height as the Parse panel so switching tabs
     does not resize the page. Measured from the Parse tab rather than
     hard-coded, because the controls wrap differently at each breakpoint. */
  function syncApiHeight() {
    var doc = document.getElementById('rapidoc');
    var section = document.getElementById('section-api');
    var test = document.getElementById('section-test');
    if (!doc || !test || !section) return;
    /* The Parse section is the one that is normally visible; measuring it while
       it is hidden would read zero. */
    var wasApi = section.classList.contains('active');
    if (wasApi) {
      section.classList.remove('active');
      test.classList.add('active');
    }
    var target = test.getBoundingClientRect().height;
    if (wasApi) {
      test.classList.remove('active');
      section.classList.add('active');
    }
    /* The section adds its own padding around the element, and both sections
       carry the same padding, so subtract it to make the totals equal. */
    var styles = getComputedStyle(section);
    var padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    var height = Math.round(target - padding);
    if (height > 0) doc.style.height = height + 'px';
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildTierTicks();
    renderTier();
    buildDownloadMenu();
    initPageRange();
    initTokenToggle();

    document.getElementById('tier').addEventListener('input', renderTier);
    document.getElementById('submit').addEventListener('click', submit);
    document.getElementById('clear').addEventListener('click', function () {
      document.getElementById('file').value = '';
      state.demo = null;
      document.querySelectorAll('.demo-chip').forEach(function (chip) {
        chip.classList.remove('selected');
      });
      setPageCount(0);
      document.getElementById('progress').hidden = true;
      stopProgress();
      resetViews();
    });
    document.getElementById('download-toggle').addEventListener('click', function (event) {
      event.stopPropagation();
      var menu = document.getElementById('download-menu');
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', function () {
      document.getElementById('download-menu').hidden = true;
    });
    document.getElementById('use-token').addEventListener('change', function () {
      refreshDownloadMenu();
      /* The API tab sends the same credential, so it has to follow the toggle
         rather than keeping whatever it was initialised with. */
      applyApiToken();
    });

    document.getElementById('file').addEventListener('change', function () {
      var file = selectedFile();
      if (!file) return;
      state.demo = null;
      document.querySelectorAll('.demo-chip').forEach(function (chip) {
        chip.classList.remove('selected');
      });
      resetViews();
      state.filename = file.name;
      document.getElementById('source-meta').textContent = file.name;
      renderSourcePreview(file, file.name);
    });

    document.querySelectorAll('.rtab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchView(tab.getAttribute('data-view'));
      });
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.getAttribute('data-target'));
      });
    });

    loadDemos();
    /* RapiDoc is mounted lazily by switchTab; a deep link straight to #post-/v1/...
       opens the API tab, so honour it here. */
    if (document.querySelector('.tab[data-target="api"]').classList.contains('active')) {
      ensureRapidoc();
      syncApiHeight();
    }
    /* The Parse tab's height changes when the controls wrap or the progress card
       appears, so keep the API panel in step rather than syncing once. */
    window.addEventListener('resize', function () {
      if (document.getElementById('rapidoc')) syncApiHeight();
    });
  });
})();
