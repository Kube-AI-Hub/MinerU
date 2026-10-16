/* Copyright 2026 Kube AI Hub.
   Playground behaviour. Everything goes through the engine's own /v1 API on the
   same origin and port, so the page works identically whether it is opened
   directly or embedded in the platform's endpoint overview.

   Parsing is done once per file: the request asks for the zip response, which
   carries the Markdown, the structured JSON and the extracted images together.
   Previewing and downloading then work from that single result instead of
   re-parsing for every format. */
(function () {
  var i18n = window.MinerUPlaygroundI18n;
  var t = i18n.t;

  var TIERS = ['flash', 'basic', 'standard', 'advanced'];

  /* Formats the API can return. `needsKey` marks the ones the engine refuses
     without an API key (see OutputFormatReqToken), so the menu can disable them
     with a reason rather than failing on click. */
  var FORMATS = [
    { id: 'markdown', label: 'Markdown', ext: 'md', mime: 'text/markdown' },
    { id: 'middle_json', label: 'JSON', ext: 'json', mime: 'application/json' },
    { id: 'structured_content', label: 'Structured JSON', ext: 'json', mime: 'application/json' },
    { id: 'html', label: 'HTML', ext: 'html', mime: 'text/html', needsKey: true },
    { id: 'latex', label: 'LaTeX', ext: 'tex', mime: 'application/x-tex', needsKey: true },
    { id: 'docx', label: 'DOCX', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', needsKey: true },
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
    selectedTier: 'standard'
  };

  function token() {
    var checkbox = document.getElementById('use-token');
    if (!checkbox || !checkbox.checked) return '';
    return new URLSearchParams(window.location.search).get('token') || '';
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

  /* --------------------------------------------------------- source preview */

  /* Clear the preview and the result, including any object URLs the preview
     created, so a new file never inherits the previous one's blobs. */
  function resetViews() {
    releaseObjectUrls();
    state.artifacts = {};
    state.markdown = '';
    document.getElementById('source-meta').textContent = '';
    var source = document.getElementById('source-body');
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

  /* Preview the chosen file locally. The browser already knows how to draw a
     PDF or an image, so this needs no server round trip and works for the
     bundled examples too. */
  function renderSourcePreview(blob, name) {
    var host = document.getElementById('source-body');
    host.innerHTML = '';
    var url = trackObjectUrl(URL.createObjectURL(blob));

    if (/\.pdf$/i.test(name)) {
      var frame = document.createElement('iframe');
      frame.className = 'source-frame';
      frame.title = t('sourcePreview');
      frame.src = url;
      host.appendChild(frame);
      return;
    }

    if (IMAGE_EXTENSIONS.test(name)) {
      var image = document.createElement('img');
      image.className = 'source-image';
      image.alt = name;
      image.src = url;
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

  /* ------------------------------------------------------------ result view */

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
       the same renderer for its Markdown tab. */
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
            setResultMarkdown(payload.html);
          } else {
            setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
          }
        })
        .catch(function () {
          setResultMarkdown('<pre>' + escapeHtml(state.markdown) + '</pre>');
        });
    });
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

  function refreshDownloadMenu() {
    var hasResult = !!state.markdown;
    var hasToken = !!token();
    document.querySelectorAll('.download-item').forEach(function (item) {
      var format = FORMATS.filter(function (f) {
        return f.id === item.dataset.format;
      })[0];
      var artifact = artifactFor(format);
      var hint = item.querySelector('.hint');

      if (!hasResult) {
        item.disabled = true;
        hint.textContent = '';
      } else if (format.needsKey && !hasToken) {
        item.disabled = true;
        hint.textContent = t('needsToken');
      } else if (!artifact) {
        item.disabled = true;
        hint.textContent = t('notProduced');
      } else {
        item.disabled = false;
        hint.textContent = '';
      }
    });
  }

  function download(format) {
    var artifact = artifactFor(format);
    if (!artifact) return;
    var base = (state.filename || 'result').replace(/\.[^.]+$/, '');
    var link = document.createElement('a');
    link.href = trackObjectUrl(URL.createObjectURL(artifact.blob));
    link.download = base + '.' + format.ext;
    link.click();
    setStatus(t('downloaded', { name: base + '.' + format.ext }), 'ok');
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
    query.set('ocr_mode', document.getElementById('ocr-mode').value);
    var range = document.getElementById('page-range').value.trim();
    if (range) query.set('page_range', range);
    /* One request carries every format the engine can produce without an API
       key, so preview and download both work from this single result. */
    query.set('response_format', 'zip');
    ['markdown', 'middle_json', 'structured_content'].forEach(function (format) {
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

  function submit() {
    var pending = buildRequest();
    if (!pending) return;
    var button = document.getElementById('submit');
    button.disabled = true;
    setStatus(t('parsing'));
    var started = Date.now();

    pending
      .then(function (request) {
        resetViews();
        state.filename = request.name;
        document.getElementById('source-meta').textContent = request.name;
        renderSourcePreview(request.blob, request.name);
        return fetch('./v1/file_parse?' + request.query.toString(), {
          method: 'POST',
          headers: authHeaders(),
          body: request.form
        }).then(function (response) {
          if (!response.ok) {
            return response.json().then(
              function (payload) {
                throw new Error(extractError(payload) || 'HTTP ' + response.status);
              },
              function () {
                throw new Error('HTTP ' + response.status);
              }
            );
          }
          return response.blob();
        });
      })
      .then(function (zipBlob) {
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
        setStatus(t('done', { seconds: seconds }), 'ok');
      })
      .catch(function (error) {
        setStatus(t('failed', { message: error.message }), 'error');
      })
      .finally(function () {
        button.disabled = false;
      });
  }

  /* ------------------------------------------------------------------- API */

  function initApi() {
    var doc = document.getElementById('rapidoc');
    if (!doc) return;
    /* RapiDoc resolves relative URLs against the page, which behind the
       platform's proxy is the engine itself. Hand it both the spec and the
       documented server explicitly so "Try" calls the engine rather than the
       platform, and so it works whether the page is at / or under a prefix. */
    var base = window.location.pathname.replace(/\/$/, '');
    doc.setAttribute('spec-url', './openapi.json');
    doc.setAttribute('server-url', base || '/');
  }

  function switchTab(target) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-target') === target);
    });
    document.getElementById('section-test').classList.toggle('active', target === 'test');
    document.getElementById('section-api').classList.toggle('active', target === 'api');
  }

  document.addEventListener('DOMContentLoaded', function () {
    buildTierTicks();
    renderTier();
    buildDownloadMenu();

    document.getElementById('tier').addEventListener('input', renderTier);
    document.getElementById('submit').addEventListener('click', submit);
    document.getElementById('clear').addEventListener('click', function () {
      document.getElementById('file').value = '';
      state.demo = null;
      document.querySelectorAll('.demo-chip').forEach(function (chip) {
        chip.classList.remove('selected');
      });
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
    document.getElementById('use-token').addEventListener('change', refreshDownloadMenu);

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
    initApi();
  });
})();
