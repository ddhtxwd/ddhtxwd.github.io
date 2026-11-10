/* ============================================================
 * tour.js — 首次打开时的操作指引
 *
 * 首次访问自动弹出，也可以点状态栏的「指引」随时重看。
 * 指引会聚光关键区域并给出简短说明，支持跳过、上一步和键盘操作。
 * ============================================================ */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'web-micropython.tour.v1';
  const AUTO_SHOW_DELAY = 600;
  const GAP = 14;
  const MARGIN = 14;

  const STEPS = [
    {
      title: '欢迎使用',
      text: '这是一个通过浏览器直接管理 MicroPython 墨水屏设备的工具。接下来用几步快速了解如何连接设备、安装应用和管理文件。',
      nextLabel: '开始了解',
    },
    {
      title: '连接设备',
      text: '点击 <strong>连接设备</strong>，在浏览器弹窗中选择设备串口。波特率通常保持 115200 即可；勾选 <strong>连接时复位</strong> 可以避免设备上正在运行的程序阻止进入文件系统。',
      target: '.conn',
      placement: 'bottom',
    },
    {
      title: '文件与应用两个视图',
      text: '顶部可以切换 <strong>文件</strong> 和 <strong>应用</strong>。文件视图用来浏览、编辑、上传设备文件；应用视图用来安装、更新和打开应用。',
      target: '.view-tabs',
      placement: 'bottom',
    },
    {
      title: '应用中心',
      text: '应用中心会自动扫描设备上带 <code>app.json</code> 的应用目录。可以按名称搜索应用，也可以点右侧按钮重新扫描。',
      target: '.apps-head',
      placement: 'bottom',
      before: () => ensureView('apps'),
    },
    {
      title: '应用卡片',
      text: '点击卡片可以安装或打开应用。右上角的 <strong>?</strong> 打开使用说明，<strong>星标</strong> 把应用设为开机默认，已安装的应用还会出现删除按钮。',
      target: () => document.querySelector('#appsGrid .app-card'),
      placement: 'bottom',
    },
    {
      title: '管理设备文件',
      text: '文件视图可以上传文件、新建文件或文件夹、下载、刷新和筛选。点击文件名可以编辑，右键菜单支持重命名、复制路径和删除。',
      target: '#fileToolbar',
      placement: 'bottom',
      before: () => ensureView('files'),
    },
    {
      title: '终端与软复位',
      text: '连接设备后，底部可以打开 <strong>设备终端</strong>，直接执行 Python 代码；<strong>软复位</strong> 会让设备重新运行程序。',
      target: '.statusbar',
      placement: 'top',
    },
    {
      title: '可以开始使用了',
      text: '点击「连接设备」开始使用。之后想再看这份指引，随时点击底部状态栏的「指引」按钮。',
      nextLabel: '完成',
      before: () => ensureView(startView),
    },
  ];

  let root = null;
  let spot = null;
  let card = null;
  let stepLabel = null;
  let titleEl = null;
  let textEl = null;
  let barEl = null;
  let prevBtn = null;
  let nextBtn = null;

  let active = false;
  let index = 0;
  let startView = 'apps';
  let lastFocus = null;
  let autoTimer = 0;
  let layoutFrame = 0;

  /* ---------------------------- 存储 ---------------------------- */

  function hasSeen() {
    try {
      if (global.localStorage.getItem(STORAGE_KEY) === '1') return true;
    } catch (err) { /* 隐私模式或 file:// 限制，继续尝试 sessionStorage */ }
    try {
      return global.sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      return false;
    }
  }

  function markSeen() {
    try { global.localStorage.setItem(STORAGE_KEY, '1'); } catch (err) { /* ignore */ }
    try { global.sessionStorage.setItem(STORAGE_KEY, '1'); } catch (err) { /* ignore */ }
  }

  /* ---------------------------- 视图 ---------------------------- */

  function currentView() {
    const tab = document.querySelector('.view-tab.is-active');
    return tab && tab.dataset.view === 'files' ? 'files' : 'apps';
  }

  function setView(view) {
    const tab = document.querySelector('.view-tab[data-view="' + view + '"]');
    if (tab && !tab.classList.contains('is-active')) tab.click();
  }

  function ensureView(view) {
    if (currentView() !== view) setView(view);
  }

  /** 终端固定在底部，会挡住状态栏；打开指引前先收起 */
  function closeTerminal() {
    const terminal = document.getElementById('terminal');
    if (!terminal || terminal.hidden) return;
    const btn = document.getElementById('btnCloseTerminal');
    if (btn) btn.click();
  }

  /* ---------------------------- DOM ---------------------------- */

  function build() {
    if (root) return;

    root = document.createElement('div');
    root.id = 'tour';
    root.className = 'tour';
    root.hidden = true;
    root.innerHTML =
      '<div class="tour-mask"></div>' +
      '<div class="tour-spot" id="tourSpot" hidden></div>' +
      '<div class="tour-card" id="tourCard" role="dialog" aria-modal="true" aria-labelledby="tourTitle" aria-describedby="tourText">' +
        '<div class="tour-bar" id="tourBar"><span></span></div>' +
        '<div class="tour-head">' +
          '<span class="tour-step" id="tourStep"></span>' +
          '<button type="button" class="tour-skip" id="tourSkip">跳过</button>' +
        '</div>' +
        '<h3 id="tourTitle"></h3>' +
        '<p class="tour-text" id="tourText"></p>' +
        '<div class="tour-foot">' +
          '<span class="tour-hint">← → 切换，Esc 跳过</span>' +
          '<div class="tour-btns">' +
            '<button type="button" class="btn small ghost" id="tourPrev">上一步</button>' +
            '<button type="button" class="btn small primary" id="tourNext">下一步</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    spot = root.querySelector('#tourSpot');
    card = root.querySelector('#tourCard');
    stepLabel = root.querySelector('#tourStep');
    titleEl = root.querySelector('#tourTitle');
    textEl = root.querySelector('#tourText');
    barEl = root.querySelector('#tourBar span');
    prevBtn = root.querySelector('#tourPrev');
    nextBtn = root.querySelector('#tourNext');

    root.querySelector('#tourSkip').addEventListener('click', close);
    prevBtn.addEventListener('click', () => go(index - 1));
    nextBtn.addEventListener('click', () => {
      if (index >= STEPS.length - 1) close();
      else go(index + 1);
    });
  }

  /* ---------------------------- 渲染 ---------------------------- */

  function render() {
    const step = STEPS[index];

    if (step.before) {
      try { step.before(); } catch (err) { /* 步骤准备失败时仍显示说明 */ }
    }

    stepLabel.textContent = (index + 1) + ' / ' + STEPS.length;
    titleEl.textContent = step.title;
    textEl.innerHTML = step.text;
    prevBtn.hidden = index === 0;
    nextBtn.textContent = index === STEPS.length - 1 ? '完成' : (step.nextLabel || '下一步');
    barEl.style.width = (((index + 1) / STEPS.length) * 100) + '%';
    card.classList.remove('is-centered');
    card.style.left = '';
    card.style.top = '';

    try { nextBtn.focus({ preventScroll: true }); } catch (err) { /* ignore */ }

    // 先同步定位避免卡片闪到左上角，视图切换后再校准两次
    layout();
    requestAnimationFrame(() => requestAnimationFrame(layout));
  }

  function go(next) {
    index = Math.max(0, Math.min(STEPS.length - 1, next));
    render();
  }

  /* ---------------------------- 定位 ---------------------------- */

  function resolveTarget(selector) {
    if (!selector) return null;

    let target = null;
    try {
      target = typeof selector === 'function' ? selector() : document.querySelector(selector);
    } catch (err) {
      return null;
    }
    if (!target) return null;

    const rect = target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;

    const style = global.getComputedStyle(target);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return null;
    }
    return target;
  }

  function clampRect(rect) {
    const pad = 5;
    const left = Math.max(6, Math.min(global.innerWidth - 6, rect.left - pad));
    const top = Math.max(6, Math.min(global.innerHeight - 6, rect.top - pad));
    const right = Math.max(left, Math.min(global.innerWidth - 6, rect.right + pad));
    const bottom = Math.max(top, Math.min(global.innerHeight - 6, rect.bottom + pad));
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  function placeCard(rect, placement) {
    const cardRect = card.getBoundingClientRect();
    const vw = global.innerWidth;
    const vh = global.innerHeight;

    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    left = Math.max(MARGIN, Math.min(vw - cardRect.width - MARGIN, left));

    const spaceBelow = vh - rect.top - rect.height;
    const spaceAbove = rect.top;
    let top;

    if (placement === 'top' && spaceAbove >= cardRect.height + GAP) {
      top = rect.top - cardRect.height - GAP;
    } else if (placement !== 'top' && spaceBelow >= cardRect.height + GAP) {
      top = rect.top + rect.height + GAP;
    } else if (spaceAbove >= cardRect.height + GAP) {
      top = rect.top - cardRect.height - GAP;
    } else if (spaceBelow >= cardRect.height + GAP) {
      top = rect.top + rect.height + GAP;
    } else {
      top = vh - cardRect.height - MARGIN;
    }

    top = Math.max(MARGIN, Math.min(vh - cardRect.height - MARGIN, top));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function layout() {
    if (!active || !card) return;

    const step = STEPS[index];
    const target = resolveTarget(step.target);

    if (!target) {
      root.classList.remove('has-spot');
      spot.hidden = true;
      card.classList.add('is-centered');
      card.style.left = '';
      card.style.top = '';
      return;
    }

    try {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (err) { /* 老浏览器忽略 */ }

    const rect = clampRect(target.getBoundingClientRect());
    root.classList.add('has-spot');
    spot.hidden = false;
    card.classList.remove('is-centered');
    spot.style.left = Math.round(rect.left) + 'px';
    spot.style.top = Math.round(rect.top) + 'px';
    spot.style.width = Math.round(rect.width) + 'px';
    spot.style.height = Math.round(rect.height) + 'px';

    placeCard(rect, step.placement);
  }

  function scheduleLayout() {
    if (!active || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layout();
    });
  }

  /* ---------------------------- 键盘 ---------------------------- */

  function trapFocus(event) {
    const focusables = Array.prototype.slice.call(
      card.querySelectorAll('button:not([hidden]):not(:disabled)')
    );
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onKeyDown(event) {
    if (!active) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (index < STEPS.length - 1) go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (index > 0) go(index - 1);
    } else if (event.key === 'Tab') {
      trapFocus(event);
    }
  }

  /* ---------------------------- 开关 ---------------------------- */

  function start() {
    if (active) return;

    lastFocus = document.activeElement;
    closeTerminal();
    startView = currentView();
    build();

    active = true;
    index = 0;
    root.hidden = false;

    global.addEventListener('resize', scheduleLayout);
    global.addEventListener('scroll', scheduleLayout, true);
    document.addEventListener('keydown', onKeyDown);

    render();
    setTimeout(scheduleLayout, 220);
  }

  function close() {
    if (!active) return;

    active = false;
    markSeen();

    global.removeEventListener('resize', scheduleLayout);
    global.removeEventListener('scroll', scheduleLayout, true);
    document.removeEventListener('keydown', onKeyDown);

    if (root) {
      root.hidden = true;
      root.classList.remove('has-spot');
    }
    if (spot) spot.hidden = true;
    ensureView(startView);

    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    }
    lastFocus = null;
  }

  function maybeShow() {
    if (autoTimer || active || global.__NO_TOUR__ || hasSeen()) return;

    autoTimer = setTimeout(() => {
      autoTimer = 0;
      if (active || hasSeen()) return;

      // 用户已经打开弹窗在操作时，不打断
      const modal = document.getElementById('modalBackdrop');
      if (modal && !modal.hidden) return;

      start();
    }, AUTO_SHOW_DELAY);
  }

  /* ---------------------------- 入口 ---------------------------- */

  function bindLauncher() {
    const btn = document.getElementById('btnTour');
    if (!btn || btn.dataset.tourBound === '1') return;
    btn.dataset.tourBound = '1';
    btn.addEventListener('click', () => start());
  }

  global.Tour = {
    start: start,
    maybeShow: maybeShow,
    close: close,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindLauncher);
  } else {
    bindLauncher();
  }
})(window);
