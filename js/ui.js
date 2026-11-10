/* ============================================================
 * ui.js — 通用界面组件与格式化工具
 * ============================================================ */
(function (global) {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(self, args), wait);
    };
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function formatTime(seconds) {
    const n = Number(seconds) || 0;
    if (!n) return '—';
    let ms;
    if (n > 1e15) ms = n / 1000;        // 微秒
    else if (n > 1e11) ms = n;          // 毫秒
    else ms = n * 1000;                 // 秒
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '—';
    const year = date.getFullYear();
    if (year < 2000 || year > 2200) return '—';
    return `${year}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function formatPercent(done, total) {
    if (!total) return '';
    return Math.min(100, Math.round((done / total) * 100)) + '%';
  }

  /* ------------------------- Toast ------------------------- */

  const TOAST_ICONS = { success: 'i-check', error: 'i-alert', warn: 'i-alert', info: 'i-info' };

  function toast(message, type, duration) {
    const kind = type || 'info';
    const container = document.getElementById('toasts');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.innerHTML = `<svg class="ico"><use href="#${TOAST_ICONS[kind] || 'i-info'}"></use></svg><div class="toast-text"></div>`;
    el.querySelector('.toast-text').textContent = String(message);

    container.appendChild(el);

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      el.style.transition = 'opacity .16s, transform .16s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 180);
    };

    el.addEventListener('click', remove);
    setTimeout(remove, duration || (kind === 'error' ? 6000 : 3200));
  }

  /* ------------------------- Modal ------------------------- */

  function modal(options) {
    const opts = options || {};
    return new Promise((resolve) => {
      const backdrop = document.getElementById('modalBackdrop');
      const titleEl = document.getElementById('modalTitle');
      const bodyEl = document.getElementById('modalBody');
      const actionsEl = document.getElementById('modalActions');
      const closeBtn = document.getElementById('modalClose');

      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        backdrop.hidden = true;
        document.removeEventListener('keydown', onKey);
        resolve(value === undefined ? null : value);
      };

      const onKey = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close(null);
        }
      };

      titleEl.textContent = opts.title || '提示';
      bodyEl.innerHTML = opts.html || '';
      actionsEl.innerHTML = '';

      const buttons = opts.buttons && opts.buttons.length
        ? opts.buttons
        : [{ label: '知道了', value: 'ok', kind: 'primary' }];

      for (const btn of buttons) {
        const el = document.createElement('button');
        el.className = 'btn ' + (btn.kind || '');
        el.textContent = btn.label;
        el.addEventListener('click', () => close(btn.value));
        actionsEl.appendChild(el);
      }

      closeBtn.onclick = () => close(null);
      backdrop.onclick = (event) => {
        if (event.target === backdrop) close(null);
      };

      document.addEventListener('keydown', onKey);
      backdrop.hidden = false;

      if (opts.onMount) opts.onMount(bodyEl, close);
    });
  }

  function confirmDialog(title, message, options) {
    const opts = options || {};
    return modal({
      title,
      html: `<p>${escapeHtml(message)}</p>`,
      buttons: [
        { label: opts.cancelText || '取消', value: false, kind: 'ghost' },
        { label: opts.confirmText || '确定', value: true, kind: opts.danger ? 'danger' : 'primary' },
      ],
    }).then((value) => value === true);
  }

  function promptDialog(config) {
    const cfg = config || {};
    let input = null;

    const html =
      `<p>${escapeHtml(cfg.label || '')}</p>` +
      `<div class="field"><input type="text" id="uiPromptInput" spellcheck="false" autocomplete="off" ` +
      `value="${escapeHtml(cfg.value || '')}" placeholder="${escapeHtml(cfg.placeholder || '')}"></div>` +
      (cfg.hint ? `<div class="path-hint">${escapeHtml(cfg.hint)}</div>` : '');

    return modal({
      title: cfg.title || '请输入',
      html,
      buttons: [
        { label: '取消', value: null, kind: 'ghost' },
        { label: cfg.confirmText || '确定', value: 'ok', kind: 'primary' },
      ],
      onMount(body, close) {
        input = body.querySelector('#uiPromptInput');
        if (!input) return;
        setTimeout(() => {
          input.focus();
          const dot = input.value.lastIndexOf('.');
          if (dot > 0) input.setSelectionRange(0, dot);
          else input.select();
        }, 30);

        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            close('ok');
          }
        });
      },
    }).then((value) => {
      if (value !== 'ok' || !input) return null;
      return input.value;
    });
  }

  /* ------------------------- Progress ------------------------- */

  const progressState = {
    onCancel: null,
    visible: false,
  };

  function showProgress(label, onCancel) {
    const el = document.getElementById('progress');
    const labelEl = document.getElementById('progressLabel');
    const valueEl = document.getElementById('progressValue');
    const bar = document.getElementById('progressBar');
    const cancelBtn = document.getElementById('btnCancelOp');

    el.hidden = false;
    progressState.visible = true;
    progressState.onCancel = onCancel || null;
    labelEl.textContent = label || '处理中…';
    valueEl.textContent = '';
    bar.style.width = '0%';

    cancelBtn.hidden = !onCancel;
    cancelBtn.onclick = () => {
      if (progressState.onCancel) progressState.onCancel();
    };
  }

  function updateProgress(done, total, label) {
    if (!progressState.visible) return;
    const bar = document.getElementById('progressBar');
    const labelEl = document.getElementById('progressLabel');
    const valueEl = document.getElementById('progressValue');

    if (typeof done === 'string') {
      labelEl.textContent = done;
      return;
    }

    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    bar.style.width = (ratio * 100).toFixed(1) + '%';
    valueEl.textContent = total > 0
      ? `${formatSize(done)} / ${formatSize(total)} · ${formatPercent(done, total)}`
      : formatSize(done);
    if (label) labelEl.textContent = label;
  }

  function hideProgress() {
    const el = document.getElementById('progress');
    el.hidden = true;
    progressState.visible = false;
    progressState.onCancel = null;
  }

  /* ------------------------- 文件下载 ------------------------- */

  function downloadBlob(filename, data, mime) {
    const blob = data instanceof Blob
      ? data
      : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      link.remove();
      URL.revokeObjectURL(url);
    }, 2000);
  }

  /* ------------------------- 文件类型 ------------------------- */

  const PY_EXTS = ['py', 'mpy'];
  const TEXT_EXTS = ['py', 'mpy', 'txt', 'md', 'json', 'csv', 'log', 'ini', 'cfg', 'toml', 'yaml', 'yml',
    'html', 'htm', 'css', 'js', 'xml', 'sh', 'bat', 'c', 'h', 'cpp', 'hpp', 'ini', 'conf', 'env'];
  const BIN_EXTS = ['bin', 'dat', 'img', 'uf2', 'hex', 'elf', 'gz', 'zip', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'wav', 'mp3', 'pcm', 'raw'];

  function getExtension(name) {
    const str = String(name || '');
    const idx = str.lastIndexOf('.');
    if (idx <= 0) return '';
    return str.slice(idx + 1).toLowerCase();
  }

  function fileIconInfo(name, isDir) {
    if (isDir) return { icon: 'i-folder', cls: 'ico-folder' };
    const ext = getExtension(name);
    if (PY_EXTS.includes(ext)) return { icon: 'i-file', cls: 'ico-py' };
    if (ext === 'json') return { icon: 'i-file', cls: 'ico-json' };
    if (BIN_EXTS.includes(ext)) return { icon: 'i-file', cls: 'ico-bin' };
    if (TEXT_EXTS.includes(ext)) return { icon: 'i-file', cls: 'ico-txt' };
    return { icon: 'i-file', cls: 'ico-txt' };
  }

  function isTextExtension(name) {
    return TEXT_EXTS.includes(getExtension(name));
  }

  /** 粗略判断字节内容是否为可编辑文本 */
  function looksLikeText(bytes) {
    if (!bytes || !bytes.length) return true;
    const sample = bytes.subarray(0, Math.min(bytes.length, 800));
    let suspicious = 0;
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i];
      if (b === 0) return false;
      if (b < 7 || (b > 13 && b < 32)) suspicious++;
    }
    return suspicious / sample.length < 0.02;
  }

  global.UI = {
    $,
    $$,
    sleep,
    debounce,
    escapeHtml,
    pad2,
    formatSize,
    formatTime,
    formatPercent,
    toast,
    modal,
    confirm: confirmDialog,
    prompt: promptDialog,
    showProgress,
    updateProgress,
    hideProgress,
    downloadBlob,
    getExtension,
    fileIconInfo,
    isTextExtension,
    looksLikeText,
  };
})(window);
