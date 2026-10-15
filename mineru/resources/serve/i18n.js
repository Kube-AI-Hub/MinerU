/* Copyright 2026 Kube AI Hub.
   Playground copy. The platform appends ?lang= to the iframe URL, so the page
   follows the platform's locale instead of the engine image's. */
(function () {
  var MESSAGES = {
    zh: {
      title: 'MinerU 文档解析',
      subtitle: '把 PDF、Office 文档与图片转成带格式的 Markdown，并在浏览器里直接预览结果。',
      tabTest: '解析',
      tabApi: 'API',
      useToken: '使用我的访问令牌',
      file: '文档',
      demoLabel: '或直接用内置示例：',
      tier: '解析档位',
      tierFlash: 'flash · 快速预览',
      tierBasic: 'basic · 基础 OCR',
      tierStandard: 'standard · 复杂版面',
      tierAdvanced: 'advanced · 更高质量',
      ocrMode: 'OCR 模式',
      pageRange: '页码范围',
      pageRangeHint: '留空或 all 表示全部页面。',
      parse: '开始解析',
      result: '解析结果',
      resultEmpty: '解析完成后，Markdown 会显示在这里。',
      copy: '复制',
      download: '下载 Markdown',
      needFile: '请先选择文档，或点选一个内置示例。',
      parsing: '正在解析…（首次运行会加载模型，请稍候）',
      done: '解析完成，用时 {seconds} 秒。',
      failed: '解析失败：{message}',
      copied: '已复制到剪贴板。',
      copyFailed: '复制失败，请手动选择文本。',
      pageCount: '共 {pages} 页'
    },
    en: {
      title: 'MinerU Document Parsing',
      subtitle:
        'Turn PDFs, Office documents and images into formatted Markdown, and preview the result right here.',
      tabTest: 'Parse',
      tabApi: 'API',
      useToken: 'Use my access token',
      file: 'Document',
      demoLabel: 'Or start from a bundled example:',
      tier: 'Tier',
      tierFlash: 'flash · quick preview',
      tierBasic: 'basic · OCR only',
      tierStandard: 'standard · complex layout',
      tierAdvanced: 'advanced · highest quality',
      ocrMode: 'OCR mode',
      pageRange: 'Page range',
      pageRangeHint: 'Leave empty or "all" to parse every page.',
      parse: 'Parse',
      result: 'Result',
      resultEmpty: 'The Markdown appears here once parsing finishes.',
      copy: 'Copy',
      download: 'Download Markdown',
      needFile: 'Choose a document, or pick one of the bundled examples.',
      parsing: 'Parsing… (the first run loads the model, this can take a while)',
      done: 'Parsed in {seconds}s.',
      failed: 'Parsing failed: {message}',
      copied: 'Copied to the clipboard.',
      copyFailed: 'Copy failed; select the text manually.',
      pageCount: '{pages} pages'
    }
  };

  function resolveLanguage() {
    var fromQuery = new URLSearchParams(window.location.search).get('lang');
    if (fromQuery) {
      var lowered = fromQuery.toLowerCase();
      if (lowered.indexOf('zh') === 0) return lowered.indexOf('tw') > -1 || lowered.indexOf('hant') > -1 ? 'zh' : 'zh';
      return 'en';
    }
    return (navigator.language || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  var language = resolveLanguage();

  function t(key, params) {
    var table = MESSAGES[language] || MESSAGES.zh;
    var text = table[key] !== undefined ? table[key] : MESSAGES.zh[key] || key;
    if (params) {
      Object.keys(params).forEach(function (name) {
        text = text.replace(new RegExp('\\{' + name + '\\}', 'g'), params[name]);
      });
    }
    return text;
  }

  function apply() {
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
  }

  window.MinerUPlaygroundI18n = { t: t, language: language, apply: apply };
  document.addEventListener('DOMContentLoaded', apply);
})();
