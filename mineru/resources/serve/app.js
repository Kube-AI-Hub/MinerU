/* Copyright 2026 Kube AI Hub.
   Playground behaviour. Everything goes through the engine's own /v1 API on the
   same origin and port, so the page works identically whether it is opened
   directly or embedded in the platform's endpoint overview. */
(function () {
  var i18n = window.MinerUPlaygroundI18n;
  var t = i18n.t;

  var state = {
    markdown: '',
    filename: '',
    demo: null
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

  function setResult(markdown, meta) {
    var node = document.getElementById('result');
    state.markdown = markdown || '';
    node.innerHTML = '';
    if (!state.markdown) {
      var empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = t('resultEmpty');
      node.appendChild(empty);
    } else {
      var pre = document.createElement('pre');
      pre.textContent = state.markdown;
      node.appendChild(pre);
    }
    document.getElementById('copy').disabled = !state.markdown;
    document.getElementById('download').disabled = !state.markdown;
    if (meta) document.getElementById('version').textContent = meta;
  }

  /* The parse API returns the Markdown among the task artifacts. Output shapes
     differ per response format, so read the documented fields rather than
     assuming one layout. */
  function extractMarkdown(payload) {
    if (!payload) return '';
    if (typeof payload.markdown === 'string') return payload.markdown;
    var files = payload.files || payload.results || [];
    for (var i = 0; i < files.length; i += 1) {
      var entry = files[i];
      if (entry && typeof entry.markdown === 'string') return entry.markdown;
      if (entry && typeof entry.content === 'string') return entry.content;
    }
    if (payload.data) return extractMarkdown(payload.data);
    return '';
  }

  /* A failed parse still answers with a task document rather than a plain error
     object, and the reason lives per file, so read it from there. Reporting the
     generic HTTP status would hide why the document was rejected. */
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

  function isFailure(payload) {
    return !!payload && (payload.status === 'failed' || payload.status === 'error');
  }

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
    query.set('tier', document.getElementById('tier').value);
    query.set('ocr_mode', document.getElementById('ocr-mode').value);
    var range = document.getElementById('page-range').value.trim();
    if (range) query.set('page_range', range);

    /* The parse API takes the document as a multipart "files" field and rejects
       unknown query parameters, so a bundled example is fetched first and sent
       as an ordinary upload rather than referenced by URL. */
    var source = file
      ? Promise.resolve({ blob: file, name: file.name })
      : fetch('./demo/' + state.demo, { headers: authHeaders() })
          .then(function (response) {
            if (!response.ok) throw new Error('cannot load the bundled example');
            return response.blob();
          })
          .then(function (blob) {
            return { blob: blob, name: state.demo };
          });

    return source.then(function (loaded) {
      var form = new FormData();
      form.append('files', loaded.blob, loaded.name);
      state.filename = loaded.name;
      return { form: form, query: query };
    });
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
        /* Relative so the call follows whatever prefix the platform proxies
           this engine under, instead of escaping to the platform's own host. */
        return fetch('./v1/file_parse?' + request.query.toString(), {
          method: 'POST',
          headers: authHeaders(),
          body: request.form
        }).then(function (response) {
          return response.json().then(function (payload) {
            return { ok: response.ok, status: response.status, payload: payload };
          });
        });
      })
      .then(function (result) {
        var markdown = extractMarkdown(result.payload);
        if (!result.ok || isFailure(result.payload) || !markdown) {
          var detail = extractError(result.payload);
          setStatus(t('failed', { message: detail || 'HTTP ' + result.status }), 'error');
          return;
        }
        var seconds = ((Date.now() - started) / 1000).toFixed(1);
        setResult(markdown, 'MinerU · ' + state.filename);
        setStatus(t('done', { seconds: seconds }), 'ok');
      })
      .catch(function (error) {
        setStatus(t('failed', { message: error.message }), 'error');
      })
      .finally(function () {
        button.disabled = false;
      });
  }

  function copyResult() {
    if (!state.markdown) return;
    var done = function () {
      setStatus(t('copied'), 'ok');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.markdown).then(done).catch(function () {
        setStatus(t('copyFailed'), 'error');
      });
    } else {
      setStatus(t('copyFailed'), 'error');
    }
  }

  function downloadResult() {
    if (!state.markdown) return;
    var base = (state.filename || 'result').replace(/\.[^.]+$/, '');
    var blob = new Blob([state.markdown], { type: 'text/markdown;charset=utf-8' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = base + '.md';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function switchTab(target) {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.getAttribute('data-target') === target);
    });
    document.getElementById('section-test').classList.toggle('active', target === 'test');
    document.getElementById('section-api').classList.toggle('active', target === 'api');
    if (target === 'api') mountSwagger();
  }

  /* Swagger UI is served by the engine itself at /docs, which already renders
     the offline bundle. Embedding it keeps one source of truth for the API
     surface instead of describing the endpoints twice. The path is relative so
     it stays inside whatever prefix the platform proxies this engine under. */
  function mountSwagger() {
    var host = document.getElementById('swagger');
    if (host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';
    var frame = document.createElement('iframe');
    frame.src = './docs';
    frame.title = 'MinerU API';
    frame.className = 'swagger-frame';
    host.appendChild(frame);
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('submit').addEventListener('click', submit);
    document.getElementById('copy').addEventListener('click', copyResult);
    document.getElementById('download').addEventListener('click', downloadResult);
    document.getElementById('file').addEventListener('change', function () {
      if (selectedFile()) {
        state.demo = null;
        document.querySelectorAll('.demo-chip').forEach(function (chip) {
          chip.classList.remove('selected');
        });
        setStatus('');
      }
    });
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.getAttribute('data-target'));
      });
    });
    /* The token checkbox only gates the Authorization header, which the page
       reads at request time, so nothing has to be reloaded when it changes. */
    setResult('');
    loadDemos();
  });
})();
