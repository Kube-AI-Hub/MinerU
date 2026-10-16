/* Copyright 2026 Kube AI Hub.
   Playground copy. The platform appends ?lang= to the iframe URL, so the page
   follows the platform's locale instead of the engine image's. */
(function () {
  var MESSAGES = {
    zh: {
      title: 'MinerU 文档解析',
      subtitle: '把 PDF、Office 文档与图片转成带格式的 Markdown，源文件与解析结果可以左右对照、双向高亮。',
      tabTest: '解析',
      tabApi: 'API',
      useToken: '使用我的访问令牌',
      file: '文档',
      demoLabel: '或直接用内置示例：',
      tier: '解析档位',
      tierName_flash: 'flash · 极速',
      tierName_basic: 'basic · 中',
      tierName_standard: 'standard · 高',
      tierName_advanced: 'advanced · 极高',
      tierSpeed_flash: '最快，适合先看效果',
      tierSpeed_basic: '含基础 OCR',
      tierSpeed_standard: '复杂版面更准',
      tierSpeed_advanced: '最高质量，最慢',
      tierDesc_flash: '走轻量流程，不加载版面与公式模型，适合快速预览与纯文本 PDF。',
      tierDesc_basic: '在 flash 基础上启用 OCR，适合扫描件与图片。',
      tierDesc_standard: '启用版面、公式、表格模型，适合排版复杂的文档。',
      tierDesc_advanced: '在 standard 基础上进一步提质量，耗时最长。',
      ocrMode: 'OCR 模式',
      pageRange: '页码范围',
      pageRangeHint: '留空或 all 表示全部页面。',
      parse: '开始解析',
      clear: '清除',
      sourcePreview: '源文档预览',
      sourceHint: '移动鼠标到任一侧的标题、表格或段落，另一侧会同时高亮；点击可固定选中。',
      sourceEmpty: '选择文件后，这里显示源文档。',
      sourceUnsupported: '该格式无法在浏览器里预览，解析仍可正常进行。',
      pdfLoading: '正在加载 PDF…',
      pdfInvalid: 'PDF 已损坏或格式无效。',
      pdfPassword: '此 PDF 需要密码，暂时无法预览。',
      pdfLoadFailed: 'PDF 预览加载失败，请重新选择文件。',
      pdfZoomIn: '放大',
      pdfZoomOut: '缩小',
      pdfFitWidth: '适应宽度',
      resultEmpty: '解析完成后，结果会显示在这里。',
      viewMarkdown: 'Markdown',
      viewJson: 'JSON',
      download: '下载',
      jsonUnavailable: '本次解析没有返回结构化 JSON。',
      imageMissing: '图片未能从解析结果中取到',
      needsToken: '需访问令牌',
      notProduced: '本次未产出',
      downloaded: '已下载 {name}',
      needFile: '请先选择文档，或点选一个内置示例。',
      parsing: '正在解析…（首次运行会加载模型，请稍候）',
      done: '解析完成，用时 {seconds} 秒。',
      failed: '解析失败：{message}',
      noMarkdown: '解析结果里没有 Markdown 内容。',
      zipUnsupported: '当前浏览器不支持解压解析结果，请改用 API 页签调用接口。'
    },
    en: {
      title: 'MinerU Document Parsing',
      subtitle:
        'Turn PDFs, Office documents and images into formatted Markdown, with the source and the result side by side and cross-highlighted.',
      tabTest: 'Parse',
      tabApi: 'API',
      useToken: 'Use my access token',
      file: 'Document',
      demoLabel: 'Or start from a bundled example:',
      tier: 'Parsing tier',
      tierName_flash: 'flash · fastest',
      tierName_basic: 'basic · medium',
      tierName_standard: 'standard · high',
      tierName_advanced: 'advanced · xhigh',
      tierSpeed_flash: 'Fastest, for a first look',
      tierSpeed_basic: 'Adds basic OCR',
      tierSpeed_standard: 'Better on complex layouts',
      tierSpeed_advanced: 'Highest quality, slowest',
      tierDesc_flash: 'Lightweight path without layout or formula models; good for a quick look and text-only PDFs.',
      tierDesc_basic: 'Adds OCR on top of flash; use it for scans and images.',
      tierDesc_standard: 'Loads the layout, formula and table models; use it for dense documents.',
      tierDesc_advanced: 'Highest quality on top of standard, and the slowest.',
      ocrMode: 'OCR mode',
      pageRange: 'Page range',
      pageRangeHint: 'Leave empty or "all" to parse every page.',
      parse: 'Parse',
      clear: 'Clear',
      sourcePreview: 'Source document',
      sourceHint:
        'Hover a heading, table or paragraph on either side and the other side highlights the match; click to pin the selection.',
      sourceEmpty: 'Choose a document to see it here.',
      sourceUnsupported: 'This format cannot be previewed in the browser; parsing still works.',
      pdfLoading: 'Loading PDF…',
      pdfInvalid: 'This PDF is damaged or invalid.',
      pdfPassword: 'This PDF requires a password and cannot be previewed.',
      pdfLoadFailed: 'Could not load the PDF preview. Please choose the file again.',
      pdfZoomIn: 'Zoom in',
      pdfZoomOut: 'Zoom out',
      pdfFitWidth: 'Fit width',
      resultEmpty: 'The result appears here once parsing finishes.',
      viewMarkdown: 'Markdown',
      viewJson: 'JSON',
      download: 'Download',
      jsonUnavailable: 'This parse returned no structured JSON.',
      imageMissing: 'Image not available in the parse result',
      needsToken: 'needs a token',
      notProduced: 'not produced',
      downloaded: 'Downloaded {name}',
      needFile: 'Choose a document, or pick one of the bundled examples.',
      parsing: 'Parsing… (the first run loads the model, this can take a while)',
      done: 'Parsed in {seconds}s.',
      failed: 'Parsing failed: {message}',
      noMarkdown: 'The parse result carried no Markdown.',
      zipUnsupported: 'This browser cannot unpack the parse result; use the API tab instead.'
    }
  };

  function resolveLanguage() {
    var fromQuery = new URLSearchParams(window.location.search).get('lang');
    if (fromQuery) {
      var lowered = fromQuery.toLowerCase();
      if (lowered.indexOf('zh') === 0) return 'zh';
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
