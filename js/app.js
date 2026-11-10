/* ============================================================
 * app.js — 主界面逻辑
 * ============================================================ */
(function () {
  'use strict';

  const UI = window.UI;
  const { $, escapeHtml, toast, formatSize, formatTime } = UI;
  const fsUtil = window.fsUtil;

  const MAX_EDIT_SIZE = 512 * 1024; // 超过此大小不建议在线编辑

  const state = {
    connected: false,
    connecting: false,
    cwd: '/',
    entries: [],
    selection: new Set(),
    lastSelected: null,
    filter: '',
    editorPath: null,
    editorDirty: false,
    busy: false,
    abort: null,
    info: null,
    terminalOpen: false,
    recoveredBy: null,
    view: 'apps',
    apps: [],
    appsLoading: false,
    appsLoaded: false,
    appsFilter: '',
    appsError: '',
    deviceConfig: null,
    defaultApp: '',
  };

  let transport = null;
  let repl = null;
  let deviceFs = null;
  let terminal = null;
  let editor = null;
  let cleaning = false;
  let appsScanId = 0;

  // 编辑器元信息（行数/字节数）开销随文件增大而增长，输入时做防抖
  const refreshEditorMeta = UI.debounce(() => updateEditorMeta(), 160);

  const dom = {};

  /* ============================ 初始化 ============================ */

  function cacheDom() {
    const ids = [
      'statusDot', 'statusText', 'baudRate', 'btnConnect', 'btnDisconnect', 'optReset',
      'crumbs', 'btnUp', 'btnRefresh', 'btnUpload', 'btnUploadFolder', 'btnNewFile',
      'btnMkdir', 'btnDownload', 'btnTerminal', 'btnSoftReset', 'filterInput',
      'fileBody', 'emptyState', 'emptyText', 'filesPanel', 'dropOverlay',
      'panelLoading', 'panelLoadingText', 'main', 'editorPanel', 'editorName',
      'dirtyDot', 'editorMeta', 'btnSave', 'btnCloseEditor', 'editorBody',
      'editorArea', 'terminal', 'terminalBody', 'btnClearTerminal',
      'btnCloseTerminal', 'progress', 'progressBar', 'progressLabel',
      'btnCancelOp', 'contextMenu', 'filePicker', 'folderPicker', 'statDevice',
      'statSpace', 'statSelection',
      'viewTabs', 'fileToolbar', 'appsPanel', 'appsGrid', 'appsEmpty',
      'appsEmptyText', 'appsEmptyHint', 'appsSample', 'appsSummary',
      'appFilterInput', 'btnRefreshApps', 'appsLoading',
    ];
    for (const id of ids) dom[id] = document.getElementById(id);
  }

  function init() {
    cacheDom();

    editor = new CodeEditor({
      textarea: dom.editorArea,
      onChange: onEditorChange,
      onSave: () => saveFile(),
    });

    bindEvents();
    // 默认进入应用中心（与 index.html 的静态标记保持一致）
    applyView();
    renderApps();
    renderFiles();
    updateButtons();

    if (!SerialTransport.supported) {
      dom.statusText.textContent = '浏览器不支持';
      dom.btnConnect.disabled = true;
      dom.btnConnect.title = '请使用 Chrome / Edge 88+ 桌面版打开本页面';
      toast('当前浏览器不支持 Web Serial，请使用 Chrome / Edge 88+ 桌面版', 'error', 9000);
    } else if (window.Tour) {
      // 首次打开自动展示操作指引，状态栏的「指引」按钮可随时重看
      window.Tour.maybeShow();
    }

    window.addEventListener('beforeunload', (event) => {
      if (state.editorDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  /* ============================ 事件绑定 ============================ */

  function bindEvents() {
    dom.btnConnect.addEventListener('click', connect);
    dom.btnDisconnect.addEventListener('click', disconnect);

    dom.btnUp.addEventListener('click', () => navigate(fsUtil.parentPath(state.cwd)));
    dom.btnRefresh.addEventListener('click', () => navigate(state.cwd));
    dom.btnUpload.addEventListener('click', () => dom.filePicker.click());
    dom.btnUploadFolder.addEventListener('click', () => dom.folderPicker.click());
    dom.btnNewFile.addEventListener('click', createNewFile);
    dom.btnMkdir.addEventListener('click', createNewFolder);
    dom.btnDownload.addEventListener('click', downloadSelection);
    dom.btnTerminal.addEventListener('click', toggleTerminal);
    dom.btnSoftReset.addEventListener('click', softResetDevice);

    dom.btnSave.addEventListener('click', () => saveFile());
    dom.btnCloseEditor.addEventListener('click', closeEditor);

    dom.btnClearTerminal.addEventListener('click', () => {
      if (terminal) terminal.view.clear();
    });
    dom.btnCloseTerminal.addEventListener('click', toggleTerminal);

    dom.filePicker.addEventListener('change', onFilePicked);
    dom.folderPicker.addEventListener('change', onFolderPicked);

    dom.filterInput.addEventListener('input', UI.debounce(() => {
      state.filter = dom.filterInput.value.trim();
      renderFiles();
    }, 120));

    dom.viewTabs.addEventListener('click', (event) => {
      const tab = event.target.closest('.view-tab');
      if (tab && tab.dataset.view) switchView(tab.dataset.view);
    });

    dom.btnRefreshApps.addEventListener('click', () => loadApps(true));

    dom.appFilterInput.addEventListener('input', UI.debounce(() => {
      state.appsFilter = dom.appFilterInput.value.trim();
      renderApps();
    }, 120));

    dom.appsGrid.addEventListener('click', (event) => {
      const helpBtn = event.target.closest('[data-help]');
      if (helpBtn) {
        openAppHelp(helpBtn.dataset.help);
        return;
      }

      const defaultBtn = event.target.closest('[data-default]');
      if (defaultBtn) {
        if (defaultBtn.disabled) return;
        setDefaultApp(defaultBtn.dataset.default);
        return;
      }

      const removeBtn = event.target.closest('[data-remove]');
      if (removeBtn) {
        removeApp(removeBtn.dataset.remove);
        return;
      }

      const installBtn = event.target.closest('[data-install]');
      if (installBtn) {
        if (installBtn.disabled) return;
        installApp(installBtn.dataset.install);
        return;
      }

      const card = event.target.closest('.app-card');
      if (card && card.dataset.dir) openApp(card.dataset.dir);
    });

    // 卡片用 div + role=button 实现（内部含安装按钮，不能嵌套 button）
    dom.appsGrid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const main = event.target.closest('.app-main');
      if (!main) return;

      const card = main.closest('.app-card');
      if (!card || !card.dataset.dir) return;

      event.preventDefault();
      openApp(card.dataset.dir);
    });

    dom.crumbs.addEventListener('click', (event) => {
      const btn = event.target.closest('.crumb');
      if (btn && btn.dataset.path) navigate(btn.dataset.path);
    });

    bindFileListEvents();
    bindDragAndDrop();

    document.addEventListener('click', (event) => {
      if (!dom.contextMenu.hidden && !dom.contextMenu.contains(event.target)) {
        hideContextMenu();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hideContextMenu();
        return;
      }

      // 已被编辑器/其它组件处理的按键（如 CodeMirror 的 Ctrl-S）不再重复响应
      if (event.defaultPrevented) return;

      const target = event.target;
      const typing = !!(target && target.closest &&
        target.closest('input, textarea, select, [contenteditable="true"], .CodeMirror'));

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        if (state.connected && state.editorPath) {
          event.preventDefault();
          saveFile();
        }
        return;
      }

      if (!state.connected) return;

      if (event.key === 'F5') {
        event.preventDefault();
        if (state.busy || state.terminalOpen) return;
        if (state.view === 'apps') loadApps(true);
        else navigate(state.cwd);
        return;
      }

      if (typing || state.busy || state.terminalOpen) return;

      if (event.key === 'Delete') {
        const names = getSelectedNames();
        if (!names.length) return;
        event.preventDefault();
        deleteEntries(names);
        return;
      }

      if (event.key === 'F2') {
        const names = getSelectedNames();
        if (names.length !== 1) return;
        event.preventDefault();
        const entry = entryByName(names[0]);
        renameEntry(names[0], !!(entry && entry.dir));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        if (!target || !dom.filesPanel.contains(target)) return;
        const list = visibleEntries();
        if (!list.length) return;
        event.preventDefault();
        state.selection = new Set(list.map((entry) => entry.name));
        state.lastSelected = list[0].name;
        paintSelection();
      }
    });
    window.addEventListener('resize', hideContextMenu);
    dom.filesPanel.addEventListener('scroll', hideContextMenu, true);
  }

  function bindFileListEvents() {
    dom.fileBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-name]');
      if (!row) return;

      const actionBtn = event.target.closest('[data-act]');
      if (actionBtn) {
        event.stopPropagation();
        handleRowAction(actionBtn.dataset.act, row.dataset.name, row.dataset.dir === '1');
        return;
      }

      const name = row.dataset.name;
      if (event.ctrlKey || event.metaKey) {
        if (state.selection.has(name)) state.selection.delete(name);
        else state.selection.add(name);
        state.lastSelected = name;
      } else if (event.shiftKey && state.lastSelected) {
        selectRange(state.lastSelected, name);
      } else {
        state.selection.clear();
        state.selection.add(name);
        state.lastSelected = name;
      }
      paintSelection();
    });

    dom.fileBody.addEventListener('dblclick', (event) => {
      if (state.busy) return;

      const row = event.target.closest('tr[data-name]');
      if (!row) return;
      if (event.target.closest('[data-act]')) return;
      openEntry(row.dataset.name, row.dataset.dir === '1');
    });

    dom.fileBody.addEventListener('contextmenu', (event) => {
      const row = event.target.closest('tr[data-name]');
      event.preventDefault();
      if (!row) {
        hideContextMenu();
        return;
      }
      const name = row.dataset.name;
      if (!state.selection.has(name)) {
        state.selection.clear();
        state.selection.add(name);
        state.lastSelected = name;
        paintSelection();
      }
      showContextMenu(event.clientX, event.clientY, name, row.dataset.dir === '1');
    });
  }

  function bindDragAndDrop() {
    let dragDepth = 0;

    const show = () => dom.dropOverlay.classList.add('active');
    const hide = () => {
      dragDepth = 0;
      dom.dropOverlay.classList.remove('active');
    };

    dom.filesPanel.addEventListener('dragenter', (event) => {
      if (!state.connected || state.busy) return;
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth++;
      show();
    });

    dom.filesPanel.addEventListener('dragover', (event) => {
      if (!state.connected || state.busy) return;
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    dom.filesPanel.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) hide();
    });

    dom.filesPanel.addEventListener('drop', async (event) => {
      if (!state.connected) return;
      event.preventDefault();
      hide();
      if (state.busy) return;

      const items = event.dataTransfer.items;
      if (items && items.length && items[0].webkitGetAsEntry) {
        const entries = [];
        for (const item of items) {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
        if (entries.length) {
          await uploadEntries(entries);
          return;
        }
      }

      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) await uploadFileList(files);
    });
  }

  function hasFiles(event) {
    const dt = event.dataTransfer;
    if (!dt) return false;
    const types = dt.types;
    if (!types) return false;
    for (const type of types) {
      if (type === 'Files') return true;
    }
    return false;
  }

  /* ============================ 连接管理 ============================ */

  async function connect() {
    if (state.connected || state.connecting) return;

    if (!SerialTransport.supported) {
      toast('当前浏览器不支持 Web Serial，请使用 Chrome / Edge 88+ 桌面版', 'error', 8000);
      return;
    }

    let port;
    try {
      port = await SerialTransport.requestPort();
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        toast('已取消选择串口', 'info', 2200);
      } else {
        toast('无法打开串口选择框：' + ((err && err.message) || err), 'error');
      }
      return;
    }

    await connectPort(port);
  }

  async function connectPort(port) {
    state.connecting = true;
    updateButtons();
    if (dom.optReset) dom.optReset.disabled = true;
    dom.statusText.textContent = '正在连接…';
    dom.statusDot.classList.add('busy');

    try {
      transport = new SerialTransport();
      await transport.connect(port, dom.baudRate.value);
      transport.addEventListener('close', onTransportClosed);

      repl = new MicroPythonREPL(transport);
      deviceFs = new DeviceFS(repl);
      terminal = new DeviceTerminal({
        transport,
        repl,
        bodyEl: dom.terminalBody,
      });

      dom.statusText.textContent = '正在进入 REPL…';
      const how = await repl.init({
        // 勾选后每次都软复位，确保设备上正在运行的程序不会阻碍 REPL
        reset: dom.optReset && dom.optReset.checked ? 'always' : 'auto',
        onStatus: (text) => {
          dom.statusText.textContent = text;
        },
      });
      state.recoveredBy = how;

      dom.statusText.textContent = '正在读取设备信息…';
      state.info = await deviceFs.info().catch(() => ({}));

      state.connected = true;
      state.connecting = false;
      state.cwd = '/';
      state.selection.clear();
      resetApps();

      updateConnectionUI();
      renderDeviceInfo();
      await navigate('/');
      refreshSpace();

      // 若连接时停留在应用视图，立即扫描一次，否则会一直停在空状态
      if (state.view === 'apps') loadApps().catch(() => {});

      toast('设备已连接' + (how === 'soft' ? '（已软复位）' : how === 'hard' ? '（已硬复位）' : ''), 'success');
    } catch (err) {
      await cleanupConnection();
      toast(err && err.message ? err.message : '连接失败', 'error', 9000);
    } finally {
      state.connecting = false;
      updateConnectionUI();
    }
  }

  async function disconnect() {
    if (!state.connected) return;

    if (state.editorDirty) {
      const ok = await UI.confirm(
        '有未保存的修改',
        '编辑器中的文件尚未保存，确定要断开连接吗？',
        { danger: true, confirmText: '仍然断开' }
      );
      if (!ok) return;
    }

    await cleanupConnection();
    toast('已断开连接', 'info');
  }

  async function cleanupConnection() {
    // 重入保护：串口关闭事件与主动断开可能同时触发清理
    if (cleaning) return;
    if (!state.connected && !state.connecting && !transport) return;

    cleaning = true;

    // 先落状态，避免 transport 的 close 事件再次触发清理
    state.connected = false;
    state.connecting = false;

    const prevTerminal = terminal;
    const prevTransport = transport;

    transport = null;
    repl = null;
    deviceFs = null;
    terminal = null;

    try {
      try {
        // 终端占用串口时先退出终端模式，把控制权交还给设备
        if (prevTerminal && prevTerminal.isOpen) await prevTerminal.close();
      } catch (err) {
        /* ignore */
      }

      try {
        if (prevTransport) await prevTransport.disconnect();
      } catch (err) {
        /* ignore */
      }

      state.info = null;
      state.entries = [];
      state.selection.clear();
      state.cwd = '/';
      state.terminalOpen = false;

      dom.terminal.hidden = true;
      closeEditor(true);
      renderFiles();
      renderCrumbs();
      resetApps();
      updateSelectionStatus();
      updateConnectionUI();
      dom.statSpace.textContent = '';
    } finally {
      cleaning = false;
    }
  }

  function onTransportClosed() {
    if (!state.connected && !state.connecting) return;
    cleanupConnection().catch(() => {});
    toast('串口连接已断开', 'warn');
  }

  function updateConnectionUI() {
    const on = state.connected;

    dom.statusDot.classList.toggle('on', on);
    if (!state.connecting) dom.statusDot.classList.remove('busy');

    dom.statusText.textContent = state.connecting ? '正在连接…' : (on ? '已连接' : '未连接');

    dom.btnConnect.hidden = on;
    dom.btnDisconnect.hidden = !on;
    dom.baudRate.disabled = on;
    if (dom.optReset) dom.optReset.disabled = on || state.connecting;

    if (!on) {
      dom.statDevice.textContent = state.connecting ? '正在连接设备…' : '设备未连接';
    }

    updateButtons();
  }

  function renderDeviceInfo() {
    const info = state.info || {};
    const parts = [];

    const machine = info.machine || info.sysname || info.platform;
    if (machine) parts.push(String(machine));

    if (info.version) {
      const match = String(info.version).match(/MicroPython[^;]*/i);
      parts.push(match ? match[0].trim() : String(info.version).slice(0, 40));
    }

    if (info.mem_free != null && info.mem_free >= 0) {
      parts.push('内存 ' + formatSize(info.mem_free) + ' 可用');
    }

    dom.statDevice.textContent = parts.join(' · ') || '设备已连接';
  }

  function updateButtons() {
    const locked = !state.connected || state.busy || state.terminalOpen;

    const buttons = [
      dom.btnUp, dom.btnRefresh, dom.btnUpload, dom.btnUploadFolder,
      dom.btnNewFile, dom.btnMkdir, dom.btnDownload, dom.btnSoftReset,
    ];
    for (const btn of buttons) {
      if (btn) btn.disabled = locked;
    }

    // 终端按钮在终端打开时保持可点击（用于关闭终端）
    if (dom.btnTerminal) {
      dom.btnTerminal.disabled = !state.connected || state.busy;
    }

    if (dom.btnSave) {
      dom.btnSave.disabled = locked || !state.editorPath;
    }
    if (dom.btnRefreshApps) {
      dom.btnRefreshApps.disabled = locked || state.appsLoading;
    }
    if (dom.statSelection) updateSelectionStatus();
  }

  /* ============================ 目录导航 ============================ */

  async function navigate(path, options) {
    if (!state.connected || !deviceFs) return;
    const opts = options || {};
    const target = fsUtil.normalizePath(path);

    // 默认情况下忙碌时不再响应导航，但操作内部主动刷新目录时传 force
    if (state.busy && !opts.force) return;

    setPanelLoading(true, '正在读取目录…');

    try {
      const entries = await deviceFs.ls(target);
      state.cwd = target;
      state.entries = entries;
      state.selection.clear();
      state.lastSelected = null;

      if (!opts.keepFilter) {
        state.filter = '';
        dom.filterInput.value = '';
      }

      renderCrumbs();
      renderFiles();
      updateSelectionStatus();
      refreshSpace();
    } catch (err) {
      toast('打开目录失败：' + (err.message || err), 'error');
      if (target !== '/') {
        await navigate('/', { keepFilter: true });
      }
    } finally {
      setPanelLoading(false);
    }
  }

  function setPanelLoading(show, text) {
    dom.panelLoading.hidden = !show;
    if (text) dom.panelLoadingText.textContent = text;
  }

  function renderCrumbs() {
    const parts = String(state.cwd).split('/').filter(Boolean);
    const items = [{ name: '根目录', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      items.push({ name: part, path: acc });
    }

    dom.crumbs.innerHTML = items
      .map((item, index) => {
        const isLast = index === items.length - 1;
        const icon = index === 0 ? '<svg class="ico"><use href="#i-home"></use></svg>' : '';
        return `<button class="crumb${isLast ? ' current' : ''}" data-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}">${icon}<span>${escapeHtml(item.name)}</span></button>`;
      })
      .join('<span class="crumb-sep">/</span>');
  }

  /** 应用搜索过滤后的当前目录项 */
  function visibleEntries() {
    const keyword = state.filter.toLowerCase();
    if (!keyword) return state.entries;
    return state.entries.filter((entry) => entry.name.toLowerCase().includes(keyword));
  }

  function renderFiles() {
    clearContextMenu();

    if (!state.connected) {
      dom.fileBody.innerHTML = '';
      dom.emptyState.hidden = true;
      return;
    }

    const list = visibleEntries();

    if (!list.length) {
      dom.fileBody.innerHTML = '';
      dom.emptyState.hidden = false;
      dom.emptyText.textContent = state.filter ? '没有匹配的项目' : '当前目录为空';
      return;
    }

    dom.emptyState.hidden = true;
    dom.fileBody.innerHTML = list.map(rowHtml).join('');
  }

  function rowHtml(entry) {
    const icon = UI.fileIconInfo(entry.name, entry.dir);
    const selected = state.selection.has(entry.name);

    return (
      `<tr class="file-row${entry.dir ? ' is-dir' : ''}${selected ? ' selected' : ''}" ` +
      `data-name="${escapeHtml(entry.name)}" data-dir="${entry.dir ? 1 : 0}">` +
      `<td class="col-name"><div class="name-cell">` +
      `<svg class="ico ${icon.cls}"><use href="#${icon.icon}"></use></svg>` +
      `<span class="fname" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>` +
      `</div></td>` +
      `<td class="col-size">${entry.dir ? '—' : formatSize(entry.size)}</td>` +
      `<td class="col-time">${formatTime(entry.mtime)}</td>` +
      `<td class="col-act"><div class="row-actions">` +
      (entry.dir
        ? ''
        : `<button class="mini-btn" data-act="edit" title="编辑"><svg class="ico"><use href="#i-edit"></use></svg></button>`) +
      `<button class="mini-btn" data-act="download" title="下载"><svg class="ico"><use href="#i-download"></use></svg></button>` +
      `<button class="mini-btn" data-act="rename" title="重命名"><svg class="ico"><use href="#i-corner"></use></svg></button>` +
      `<button class="mini-btn danger" data-act="delete" title="删除"><svg class="ico"><use href="#i-trash"></use></svg></button>` +
      `</div></td></tr>`
    );
  }

  function paintSelection() {
    const rows = dom.fileBody.querySelectorAll('tr[data-name]');
    for (const row of rows) {
      row.classList.toggle('selected', state.selection.has(row.dataset.name));
    }
    updateSelectionStatus();
  }

  function selectRange(fromName, toName) {
    const names = visibleEntries().map((entry) => entry.name);

    const start = names.indexOf(fromName);
    const end = names.indexOf(toName);
    if (start < 0 || end < 0) return;

    const [lo, hi] = start <= end ? [start, end] : [end, start];
    for (let i = lo; i <= hi; i++) state.selection.add(names[i]);
  }

  function updateSelectionStatus() {
    const count = state.selection.size;
    dom.statSelection.textContent = count ? `已选择 ${count} 项` : '';
  }

  function getSelectedNames() {
    return Array.from(state.selection);
  }

  function entryByName(name) {
    return state.entries.find((entry) => entry.name === name) || null;
  }

  /* ============================ 通用忙状态 ============================ */

  async function withBusy(label, fn) {
    if (state.busy) {
      toast('正在处理其它操作，请稍候', 'warn');
      return undefined;
    }

    state.busy = true;
    const controller = new AbortController();
    state.abort = controller;
    updateButtons();

    if (label) {
      UI.showProgress(label, () => {
        UI.updateProgress('正在取消…');
        controller.abort();
      });
    }

    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        toast('操作已取消', 'warn');
      } else {
        toast((err && err.message) || String(err), 'error', 7000);
      }
      return undefined;
    } finally {
      state.busy = false;
      state.abort = null;
      // 文件发生变动后，应用列表（依赖根目录结构）可能已过期
      state.appsLoaded = false;
      UI.hideProgress();
      updateButtons();
    }
  }

  /* ============================ 行操作分发 ============================ */

  function handleRowAction(action, name, isDir) {
    if (state.busy) return;

    const fullPath = fsUtil.joinPath(state.cwd, name);
    switch (action) {
      case 'edit':
        openFile(fullPath);
        break;
      case 'download':
        downloadEntries([{ name, dir: isDir, path: fullPath }]);
        break;
      case 'rename':
        renameEntry(name, isDir);
        break;
      case 'delete':
        deleteEntries([name]);
        break;
      default:
        break;
    }
  }

  function openEntry(name, isDir) {
    const fullPath = fsUtil.joinPath(state.cwd, name);
    if (isDir) navigate(fullPath);
    else openFile(fullPath);
  }

  /* ============================ 应用管理 ============================ */

  /** 把当前视图同步到 tab 高亮与面板显隐 */
  function applyView() {
    const isApps = state.view === 'apps';

    for (const tab of dom.viewTabs.querySelectorAll('.view-tab')) {
      const active = tab.dataset.view === state.view;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    dom.filesPanel.hidden = isApps;
    dom.fileToolbar.hidden = isApps;
    dom.appsPanel.hidden = !isApps;
  }

  /** 切换主区域视图（文件 / 应用） */
  function switchView(view) {
    const target = view === 'apps' ? 'apps' : 'files';
    if (state.view === target) return;

    state.view = target;
    hideContextMenu();
    applyView();

    if (target === 'apps') {
      renderApps();
      loadApps().catch(() => {});
    }
  }

  function resetApps() {
    // 递增序号可废弃仍在进行中的扫描，避免旧会话的结果/错误回写到新连接
    appsScanId++;
    state.apps = [];
    state.appsLoading = false;
    state.appsLoaded = false;
    state.appsError = '';
    state.deviceConfig = null;
    state.defaultApp = '';
    renderApps();
  }

  /** 扫描设备上的应用；结果在会话内缓存，文件变动后自动失效 */
  async function loadApps(force) {
    if (!state.connected || !deviceFs || state.appsLoading) return;
    if (state.appsLoaded && !force) return;

    const scanId = ++appsScanId;
    state.appsLoading = true;
    state.appsError = '';
    renderApps();
    updateButtons();

    try {
      const list = await deviceFs.scanApps();
      const config = await readDeviceConfig();
      if (scanId !== appsScanId) return;
      state.apps = list;
      state.deviceConfig = config;
      state.defaultApp = defaultAppFromConfig(config);
      state.appsLoaded = true;
    } catch (err) {
      if (scanId !== appsScanId) return;
      state.apps = [];
      state.deviceConfig = null;
      state.defaultApp = '';
      state.appsError = (err && err.message) || String(err);
      toast('读取应用列表失败：' + state.appsError, 'error', 7000);
    } finally {
      if (scanId === appsScanId) {
        state.appsLoading = false;
        renderApps();
        updateButtons();
      }
    }
  }

  /** 读取设备根目录的 device.json（保存默认应用等设备配置） */
  async function readDeviceConfig() {
    try {
      const bytes = await deviceFs.readFile('/device.json');
      const text = new TextDecoder().decode(bytes).trim();
      if (!text) return null;
      const data = JSON.parse(text);
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (err) {
      // 文件不存在或内容损坏时不阻断应用列表
      return null;
    }
  }

  function defaultAppFromConfig(config) {
    const value = config && config['默认应用'];
    return typeof value === 'string' ? value.trim().replace(/^\/+|\/+$/g, '') : '';
  }

  function visibleApps(all) {
    const list = all || mergedApps();
    const keyword = state.appsFilter.toLowerCase();
    if (!keyword) return list;
    return list.filter((app) =>
      (app.name + ' ' + app.version + ' ' + app.installedVersion + ' ' + app.dir + ' ' + app.appDir)
        .toLowerCase()
        .includes(keyword)
    );
  }

  /** 网页内置的应用包（由 _gen_builtin.js 生成） */
  function builtinApps() {
    return Array.isArray(window.BUILTIN_APPS) ? window.BUILTIN_APPS : [];
  }

  function builtinAppSize(app) {
    const files = (Array.isArray(app.files) ? app.files : [])
      .concat(Array.isArray(app.rootFiles) ? app.rootFiles : []);
    return files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  }

  /**
   * 内置应用与设备扫描结果按目录名合并。
   * 内置在前（未安装也展示，便于一键安装），设备上独有的应用排在后面。
   */
  function mergedApps() {
    const installed = state.apps || [];
    const used = new Set();
    const list = [];

    for (const app of builtinApps()) {
      if (!app || !app.dir) continue;
      const hit = installed.find((item) => item.dir === app.dir) || null;
      if (hit) used.add(hit.dir);

      list.push({
        dir: app.dir,
        builtin: true,
        help: (hit && hit.help) || app.help || '',
        installRoot: !!app.installRoot,
        // 随应用下发到设备根目录的引导文件（app/ 根层文件）
        rootFiles: Array.isArray(app.rootFiles) ? app.rootFiles : [],
        files: Array.isArray(app.files) ? app.files : [],
        size: builtinAppSize(app),
        name: app.name || app.dir,
        appDir: app.appDir || '',
        version: app.version || '',
        installed: !!hit,
        installedVersion: hit ? hit.version : '',
        hasUpdate: !!hit && versionLess(hit.version, app.version),
        // 已安装时以设备上的扫描结果为准（用户可能改过 app.json）
        valid: hit ? hit.valid : false,
        hasAppDir: hit ? hit.hasAppDir : false,
        iconB64: hit ? hit.iconB64 : '',
        iconName: hit ? hit.iconName : '',
        entryPath: hit ? hit.entryPath : '/' + app.dir,
        path: hit ? hit.path : '/' + app.dir,
      });
    }

    for (const hit of installed) {
      if (used.has(hit.dir)) continue;
      list.push(Object.assign({
        builtin: false,
        installed: true,
        installedVersion: hit.version,
        hasUpdate: false,
        files: [],
        size: 0,
      }, hit));
    }

    return list;
  }

  /** 比较版本号：返回 -1 / 0 / 1，无法解析的片段退化为字符串比较 */
  function compareVersion(a, b) {
    const parse = (value) => String(value || '').trim().replace(/^v/i, '').split(/[.\-+_]/);
    const left = parse(a);
    const right = parse(b);
    const count = Math.max(left.length, right.length);

    for (let i = 0; i < count; i++) {
      const l = left[i];
      const r = right[i];
      if (l === undefined || r === undefined) {
        return l === r ? 0 : (l === undefined ? -1 : 1);
      }

      const ln = /^\d+$/.test(l) ? parseInt(l, 10) : NaN;
      const rn = /^\d+$/.test(r) ? parseInt(r, 10) : NaN;
      if (!isNaN(ln) && !isNaN(rn)) {
        if (ln !== rn) return ln < rn ? -1 : 1;
      } else if (l !== r) {
        return l < r ? -1 : 1;
      }
    }

    return 0;
  }

  function versionLess(a, b) {
    return compareVersion(a, b) < 0;
  }

  function renderApps() {
    if (!dom.appsGrid) return;

    const all = mergedApps();
    const list = visibleApps(all);
    const installedCount = all.filter((app) => app.installed).length;

    dom.appsGrid.innerHTML = list.map(appCardHtml).join('');
    dom.appsGrid.hidden = list.length === 0;
    dom.appsLoading.hidden = !state.appsLoading;

    let emptyText = '';
    let hint = '';
    let showSample = false;

    if (!all.length) {
      if (!state.connected) {
        emptyText = '设备未连接';
        hint = '连接设备后即可读取已安装的应用';
      } else if (state.appsError) {
        emptyText = '读取应用失败';
        hint = state.appsError;
      } else {
        emptyText = '还没有发现应用';
        hint = '在设备根目录创建文件夹，并在其中放入 app.json';
        showSample = true;
      }
    } else if (!list.length) {
      emptyText = '没有匹配的应用';
      hint = '试试其它关键词';
    }

    const showEmpty = !state.appsLoading && !!emptyText;
    dom.appsEmpty.hidden = !showEmpty;
    if (showEmpty) {
      dom.appsEmptyText.textContent = emptyText;
      dom.appsEmptyHint.textContent = hint;
      dom.appsSample.hidden = !showSample;
    }

    if (state.appsLoading) {
      dom.appsSummary.textContent = '扫描中…';
    } else if (!all.length) {
      dom.appsSummary.textContent = '';
    } else {
      const matched = list.length === all.length ? '' : `（匹配 ${list.length} 个）`;
      const stateText = !state.connected
        ? ' · 设备未连接'
        : state.appsError ? ' · 设备读取失败' : ` · 已安装 ${installedCount} 个`;
      dom.appsSummary.textContent = `共 ${all.length} 个应用${stateText}${matched}`;
    }
  }

  /** 由名称生成稳定色相，让图标颜色每次都一致 */
  function hashHue(text) {
    const str = String(text || '');
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) % 360;
    }
    return hash;
  }

  function firstGlyph(text) {
    const chars = Array.from(String(text || '').trim());
    return chars.length ? chars[0].toUpperCase() : '?';
  }

  function iconMime(name) {
    switch (fsUtil.extName(name)) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'svg':
        return 'image/svg+xml';
      case 'gif':
        return 'image/gif';
      default:
        return 'image/png';
    }
  }

  /** 只接受 http(s)、协议相对地址和站内相对路径，避免 app_help 指向其它协议 */
  function normalizeHelpUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(https?:)?\/\//i.test(value)) return value;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
    return value;
  }

  /** 使用说明地址：优先 app.json 的 app_help，内置应用回退到 docs/apps/<目录>.html */
  function appHelpUrl(app) {
    const configured = normalizeHelpUrl(app.help);
    if (configured) return configured;
    if (app.builtin) return 'docs/apps/' + encodeURIComponent(app.dir) + '.html';
    return '';
  }

  function appCardHtml(app) {
    // app_dir 指向目录自身时（如 web 应用的 app_dir=web），没有同名子目录是正常的
    const missingDir = !!app.appDir && !app.hasAppDir && app.appDir !== app.dir;
    const broken = app.installed && (!app.valid || missingDir);
    const missing = app.builtin && !app.installed;
    const hue = hashHue(app.dir || app.name);
    const icon = app.iconB64
      ? `<img src="data:${iconMime(app.iconName)};base64,${app.iconB64}" alt="">`
      : escapeHtml(firstGlyph(app.name));

    const shownVersion = app.installed ? app.installedVersion : app.version;
    const version = shownVersion
      ? (/^v/i.test(shownVersion) ? shownVersion : 'v' + shownVersion)
      : '未知版本';
    const rootFiles = Array.isArray(app.rootFiles) ? app.rootFiles : [];
    const dirLabel = app.installRoot
      ? app.dir + '/ + 根目录'
      : (app.appDir ? app.appDir + '/' : app.dir + '/');
    const fileCount = app.files.length + rootFiles.length;

    let tip;
    if (!app.installed) {
      tip = app.installRoot
        ? `安装到 /${app.dir} 与设备根目录（${fileCount} 个文件，${formatSize(app.size)}）`
        : `安装到 /${app.dir}（${app.files.length} 个文件，${formatSize(app.size)}）`;
    } else if (broken) {
      tip = `打开 ${app.path}（app.json 配置异常）`;
    } else {
      tip = `打开 ${app.entryPath}`;
    }

    const isDefault = app.installed && !!state.defaultApp && state.defaultApp === app.dir;
    const classes = 'app-card' + (broken ? ' is-broken' : '') + (missing ? ' is-missing' : '') +
      (isDefault ? ' is-default' : '') + (app.installed ? ' has-remove' : '');
    const targetPath = app.path || '/' + app.dir;
    const helpUrl = appHelpUrl(app);
    const helpBtn = helpUrl
      ? `<button type="button" class="app-help" data-help="${escapeHtml(app.dir)}" ` +
        `title="查看 ${escapeHtml(app.name)} 的使用说明" ` +
        `aria-label="查看 ${escapeHtml(app.name)} 的使用说明"><svg class="ico"><use href="#i-help"/></svg></button>`
      : '';
    const removeHint = app.installRoot
      ? `删除应用（移除 ${targetPath} 目录与根目录中的引导文件）`
      : `删除应用（含 ${targetPath} 目录下全部文件）`;
    const removeBtn = app.installed
      ? `<button type="button" class="app-remove" data-remove="${escapeHtml(app.dir)}" ` +
        `title="${escapeHtml(removeHint)}" ` +
        `aria-label="删除 ${escapeHtml(app.name)}"><svg class="ico"><use href="#i-trash"/></svg></button>`
      : '';

    return (
      `<div class="${classes}" data-dir="${escapeHtml(app.dir)}">` +
      `<div class="app-main" role="button" tabindex="0" title="${escapeHtml(tip)}">` +
      `<span class="app-icon${broken ? ' is-invalid' : ''}" style="--hue:${hue}">${icon}</span>` +
      `<span class="app-text">` +
      `<span class="app-name">${escapeHtml(app.name)}</span>` +
      `<span class="app-meta-line">` +
      `<span class="app-ver">${escapeHtml(version)}</span>` +
      `<span class="app-dir">${escapeHtml(dirLabel)}</span>` +
      `</span></span></div>` +
      appFootHtml(app) +
      helpBtn +
      removeBtn +
      `</div>`
    );
  }

  /** 卡片底部：安装 / 更新 / 重装 / 设为默认按钮与状态标注 */
  function appFootHtml(app) {
    const disabled = state.connected ? '' : ' disabled';
    const dir = escapeHtml(app.dir);
    const rootCount = Array.isArray(app.rootFiles) ? app.rootFiles.length : 0;
    const sizeLabel = `${app.files.length + rootCount} 个文件 · ${formatSize(app.size)}`;

    if (!app.installed) {
      if (!app.builtin) return '';
      const installTo = app.installRoot ? `/${app.dir} 与设备根目录` : '/' + app.dir;
      return '<div class="app-foot">' +
        '<span class="app-badge">未安装</span>' +
        `<button type="button" class="app-install" data-install="${dir}" title="安装到 ${escapeHtml(installTo)}（${escapeHtml(sizeLabel)}）"${disabled}>安装</button>` +
        '</div>';
    }

    const isDefault = !!state.defaultApp && state.defaultApp === app.dir;
    const badge = isDefault
      ? '<span class="app-badge default" title="设备启动时默认运行的应用">默认应用</span>'
      : app.hasUpdate
        ? `<span class="app-badge update">已装 v${escapeHtml(String(app.installedVersion || '?').replace(/^v/i, ''))}</span>`
        : '<span class="app-badge ok">已安装</span>';

    const star = `<button type="button" class="app-star${isDefault ? ' is-on' : ''}" data-default="${dir}" ` +
      `title="${isDefault ? '当前默认应用' : '设为默认应用（写入 /device.json）'}" ` +
      `aria-label="${isDefault ? '当前默认应用' : '设为默认应用'}" aria-pressed="${isDefault ? 'true' : 'false'}"${isDefault || !state.connected ? ' disabled' : ''}>` +
      '<svg class="ico"><use href="#i-star"/></svg></button>';

    let action = '';
    if (app.builtin) {
      action = app.hasUpdate
        ? `<button type="button" class="app-install" data-install="${dir}" title="更新到 v${escapeHtml(app.version)}（${escapeHtml(sizeLabel)}）"${disabled}>更新</button>`
        : `<button type="button" class="app-reinstall" data-install="${dir}" title="重新写入 ${escapeHtml(sizeLabel)}"${disabled}>重装</button>`;
    }

    return '<div class="app-foot">' + badge + star + action + '</div>';
  }

  function builtinFileBytes(file) {
    if (file.encoding === 'base64') return fsUtil.base64ToBytes(file.text);
    return new TextEncoder().encode(String(file.text || ''));
  }

  /** 把内置应用的全部文件写入设备；app.json 最后写，避免中断后留下半安装应用 */
  async function installApp(dir) {
    if (state.busy) return;

    const app = mergedApps().find((item) => item.dir === dir);
    if (!app || !app.builtin) {
      toast('这个应用没有可安装的内置文件', 'warn');
      return;
    }
    if (!state.connected || !deviceFs) {
      toast('请先连接设备再安装应用', 'warn');
      return;
    }

    const updating = app.installed;
    const appFiles = app.files.map((file) => ({
      file,
      bytes: builtinFileBytes(file),
      target: fsUtil.joinPath('/' + app.dir, file.path),
      label: app.dir + '/' + file.path,
    }));
    // 应用自身的文件写入 /<dir>；根层引导文件（app.py、boot.py、device.json、main.py）写入根目录
    const bootFiles = (Array.isArray(app.rootFiles) ? app.rootFiles : []).map((file) => ({
      file,
      bytes: builtinFileBytes(file),
      target: '/' + file.path,
      label: file.path,
    }));
    const entries = appFiles.concat(bootFiles);
    // app.json 是应用能否被识别的唯一标记，放到最后单独处理
    const meta = appFiles.find((entry) => entry.file.path === 'app.json') || null;
    // 引导文件先于 app.json 写入：中途中断时设备也不会启动到半安装状态
    const items = appFiles.filter((entry) => entry !== meta).concat(bootFiles);
    const totalBytes = entries.reduce((sum, item) => sum + item.bytes.length, 0);

    const location = app.installRoot
      ? `设备 /${app.dir} 目录，并把 ${bootFiles.map((entry) => entry.label).join('、')} 写入设备根目录`
      : `设备 /${app.dir} 目录`;

    const ok = await UI.confirm(
      (updating ? '更新 ' : '安装 ') + app.name,
      `将 ${entries.length} 个文件（${formatSize(totalBytes)}）写入${location}，同名文件会被覆盖。`,
      { confirmText: updating ? '开始更新' : '开始安装' }
    );
    if (!ok) return;

    const written = await withBusy(`${updating ? '正在更新' : '正在安装'} ${app.name}…`, async (signal) => {
      const space = await deviceFs.space().catch(() => null);
      if (space && typeof space.free === 'number' && space.free > 0 && totalBytes > space.free) {
        throw new Error(`设备空间不足：需要 ${formatSize(totalBytes)}，可用 ${formatSize(space.free)}`);
      }

      const ensured = new Set(['/']);
      await ensureDirectory('/' + app.dir, ensured);

      let doneBytes = 0;
      let step = 0;
      const total = entries.length;
      const writeEntry = async (entry) => {
        if (signal.aborted) throw abortError();

        await ensureDirectory(fsUtil.parentPath(entry.target), ensured);
        step++;
        await deviceFs.writeFile(entry.target, entry.bytes, {
          signal,
          onProgress: (done) => UI.updateProgress(
            doneBytes + done,
            totalBytes,
            `正在写入 ${entry.label}（${step}/${total}）`
          ),
        });

        doneBytes += entry.bytes.length;
      };

      for (const entry of items) {
        await writeEntry(entry);
      }

      if (meta) {
        // 先写临时文件再改名：即使中途取消，也不会破坏设备上已安装应用的元数据
        const finalPath = meta.target;
        const tmpPath = finalPath + '.tmp';

        if (signal.aborted) throw abortError();
        step++;
        await deviceFs.writeFile(tmpPath, meta.bytes, {
          signal,
          onProgress: (done) => UI.updateProgress(
            doneBytes + done,
            totalBytes,
            `正在写入 ${meta.label}（${step}/${total}）`
          ),
        });

        await deviceFs.unlink(finalPath).catch(() => {});
        await deviceFs.move(tmpPath, finalPath);
        doneBytes += meta.bytes.length;
      }

      UI.updateProgress(totalBytes, totalBytes, '正在校验安装结果…');
      state.appsLoaded = false;
      await loadApps(true);

      return entries.length;
    });

    if (written === undefined) return;
    toast(`已${updating ? '更新' : '安装'} ${app.name}（${written} 个文件），重启设备后生效`, 'success', 7000);
  }

  /** 删除应用目录；带根目录标记的应用连同根层引导文件一起移除 */
  async function removeApp(dir) {
    if (state.busy) return;
    if (!state.connected || !deviceFs) {
      toast('请先连接设备再删除应用', 'warn');
      return;
    }

    const app = mergedApps().find((item) => item.dir === dir);
    if (!app || !app.installed) return;

    const target = app.path || '/' + app.dir;
    // 安装时写到根目录的引导文件（app.py、boot.py、device.json、main.py）
    const bootPaths = (Array.isArray(app.rootFiles) ? app.rootFiles : [])
      .map((file) => '/' + file.path);
    const inside = (path) => {
      if (!path) return false;
      if (path === target || path.startsWith(target + '/')) return true;
      return bootPaths.indexOf(path) >= 0;
    };
    const editorInside = inside(state.editorPath);
    const note = editorInside && state.editorDirty
      ? '编辑器里该应用的文件有未保存的修改，删除后会一并丢失。'
      : '';

    const bootNote = bootPaths.length
      ? `，并移除根目录中的 ${bootPaths.map((path) => path.slice(1)).join('、')}`
      : '';
    const message = `将删除设备上的 ${target} 目录及其中全部文件${bootNote}，此操作无法撤销。${note}`;

    const ok = await UI.confirm(
      '删除 ' + app.name,
      message,
      { danger: true, confirmText: '删除应用' }
    );
    if (!ok) return;

    const removed = await withBusy(`正在删除 ${app.name}…`, async (signal) => {
      await deviceFs.removeRecursive(target, {
        signal,
        onProgress: (name) => UI.updateProgress(`正在删除 ${target}/${name}…`),
      });

      for (let i = 0; i < bootPaths.length; i++) {
        if (signal.aborted) throw abortError();
        UI.updateProgress(`正在删除 ${bootPaths[i]}（${i + 1}/${bootPaths.length}）…`);
        await deviceFs.unlink(bootPaths[i]).catch(() => {});
      }

      // 当前目录或正在编辑的文件可能在被删目录内，先退回根目录
      if (inside(state.cwd)) await navigate('/', { force: true });
      if (editorInside) closeEditor(true);

      state.appsLoaded = false;
      await loadApps(true);
      return true;
    });

    if (removed) toast(`已删除 ${app.name}`, 'success');
  }

  /** 把应用设为设备默认应用（写入根目录 device.json） */
  async function setDefaultApp(dir) {
    if (state.busy) return;
    if (!state.connected || !deviceFs) {
      toast('请先连接设备再设置默认应用', 'warn');
      return;
    }

    const app = mergedApps().find((item) => item.dir === dir);
    if (!app || !app.installed) return;
    if (state.defaultApp === dir) return;

    const saved = await withBusy(`正在把 ${app.name} 设为默认应用…`, async (signal) => {
      // 保留 device.json 里可能存在的其它字段，只更新默认应用
      const config = Object.assign({}, state.deviceConfig || {});
      config['默认应用'] = dir;

      const target = '/device.json';
      const tmp = '/device.json.tmp';
      const bytes = new TextEncoder().encode(JSON.stringify(config));

      // 先写临时文件再改名，避免写入中断时破坏设备配置
      await deviceFs.writeFile(tmp, bytes, { signal });
      await deviceFs.unlink(target).catch(() => {});
      await deviceFs.move(tmp, target);

      state.deviceConfig = config;
      state.defaultApp = dir;
      renderApps();
      return true;
    });

    if (saved) toast(`已将 ${app.name} 设为默认应用，重启设备后生效`, 'success', 6000);
  }

  async function openApp(dir) {
    if (state.busy) return;

    const app = mergedApps().find((item) => item.dir === dir);
    if (!app) return;

    // 未安装的内置应用：点击卡片直接进入安装流程
    if (!app.installed) {
      await installApp(dir);
      return;
    }

    switchView('files');
    await navigate(app.entryPath || '/' + dir);
  }

  /** 在新标签页打开应用的使用说明 */
  function openAppHelp(dir) {
    const app = mergedApps().find((item) => item.dir === dir);
    if (!app) return;

    const url = appHelpUrl(app);
    if (!url) {
      toast(app.name + ' 还没有配置使用说明', 'info');
      return;
    }

    // 本地说明页保留 opener，返回时可直接关闭标签页回到应用中心；
    // 外部说明链接仍使用 noopener/noreferrer，避免外部页面操作本页。
    if (/^(https?:)?\/\//i.test(url)) {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      window.open(url, '_blank');
    }
  }

  /* ============================ 文件编辑 ============================ */

  async function openFile(path) {
    if (!state.connected || !deviceFs) return;
    const target = fsUtil.normalizePath(path);

    if (state.editorDirty && state.editorPath !== target) {
      const ok = await UI.confirm(
        '有未保存的修改',
        '当前编辑器的内容尚未保存，切换文件会丢失修改，继续吗？',
        { danger: true, confirmText: '继续' }
      );
      if (!ok) return;
    }

    await withBusy('正在读取 ' + fsUtil.baseName(target) + '…', async (signal) => {
      const st = await deviceFs.stat(target);
      if (!st.exists) throw new Error('文件不存在：' + target);
      if (st.dir) throw new Error('这是一个文件夹，无法用编辑器打开');

      if (st.size > MAX_EDIT_SIZE) {
        const ok = await UI.confirm(
          '文件较大',
          `该文件大小为 ${formatSize(st.size)}，在线编辑会比较慢，仍然打开吗？`,
          { confirmText: '仍然打开' }
        );
        if (!ok) return;
      }

      UI.updateProgress('正在读取文件…');
      const data = await deviceFs.readFile(target, {
        signal,
        onProgress: (done, total) => UI.updateProgress(done, total, '正在读取文件…'),
      });

      if (!UI.looksLikeText(data) && !UI.isTextExtension(target)) {
        const ok = await UI.confirm(
          '可能是二进制文件',
          '该文件看起来不是文本内容，用编辑器打开可能显示乱码。仍然打开吗？',
          { confirmText: '仍然打开' }
        );
        if (!ok) return;
      }

      const text = new TextDecoder('utf-8', { fatal: false }).decode(data);

      state.editorPath = target;
      showEditorPanel(true);
      editor.setValue(text, target);

      state.editorDirty = false;
      dom.dirtyDot.hidden = true;
      dom.editorName.textContent = fsUtil.baseName(target);
      dom.editorMeta.textContent = `${formatSize(data.length)}`;
      updateEditorMeta();
      editor.focus();
      updateButtons();
    });
  }

  function onEditorChange() {
    if (!state.editorPath) return;
    const dirty = editor.isDirty();
    if (dirty !== state.editorDirty) {
      state.editorDirty = dirty;
      dom.dirtyDot.hidden = !dirty;
    }
    refreshEditorMeta();
  }

  function updateEditorMeta() {
    if (!state.editorPath) {
      dom.editorMeta.textContent = '';
      return;
    }
    const value = editor.getValue();
    const lines = value.length ? value.split('\n').length : 1;
    const bytes = new TextEncoder().encode(value).length;
    const dirtyText = state.editorDirty ? ' · 未保存' : '';
    dom.editorMeta.textContent = `${lines} 行 · ${formatSize(bytes)}${dirtyText}`;
  }

  async function saveFile() {
    if (!state.connected || !deviceFs) return;
    if (!state.editorPath) {
      toast('没有打开的文件', 'warn');
      return;
    }

    const path = state.editorPath;
    const name = fsUtil.baseName(path);
    const bytes = new TextEncoder().encode(editor.getValue());

    await withBusy('正在保存 ' + name + '…', async (signal) => {
      await deviceFs.writeFile(path, bytes, {
        signal,
        onProgress: (done, total) => UI.updateProgress(done, total, '正在写入设备…'),
      });

      editor.markClean();
      state.editorDirty = false;
      dom.dirtyDot.hidden = true;
      updateEditorMeta();

      const entry = entryByName(name);
      if (entry && fsUtil.parentPath(path) === state.cwd) {
        entry.size = bytes.length;
        entry.mtime = Math.floor(Date.now() / 1000);
        renderFiles();
      }

      toast('已保存 ' + name, 'success');
      refreshSpace();
    });
  }

  function closeEditor(force) {
    if (!state.editorPath) return;

    if (!force && state.editorDirty) {
      UI.confirm('未保存的修改', '编辑器中的内容尚未保存，确定要关闭吗？', {
        danger: true,
        confirmText: '放弃修改',
      }).then((ok) => {
        if (ok) closeEditor(true);
      });
      return;
    }

    state.editorPath = null;
    state.editorDirty = false;
    dom.dirtyDot.hidden = true;
    dom.editorName.textContent = '未命名';
    dom.editorMeta.textContent = '';
    showEditorPanel(false);
    updateButtons();
  }

  function showEditorPanel(show) {
    dom.editorPanel.hidden = !show;
    dom.main.classList.toggle('with-editor', !!show);
    if (show) {
      editor.init();
      editor.refresh();
    }
  }

  /* ============================ 新建 / 重命名 / 删除 ============================ */

  async function createNewFile() {
    const name = await UI.prompt({
      title: '新建文件',
      label: '请输入文件名：',
      placeholder: '例如 main.py',
      hint: '创建位置：' + state.cwd,
      confirmText: '创建',
    });
    if (name == null) return;

    let valid;
    try {
      valid = fsUtil.validateName(name);
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }

    const target = fsUtil.joinPath(state.cwd, valid);
    let created = false;

    await withBusy('正在创建文件…', async () => {
      if (await deviceFs.exists(target)) throw new Error('同名文件或文件夹已存在');
      await deviceFs.createFile(target);
      await navigate(state.cwd, { keepFilter: true, force: true });
      created = true;
    });

    if (created) {
      toast('已创建 ' + valid, 'success');
      await openFile(target);
    }
  }

  async function createNewFolder() {
    const name = await UI.prompt({
      title: '新建文件夹',
      label: '请输入文件夹名称：',
      placeholder: '例如 lib',
      hint: '创建位置：' + state.cwd,
      confirmText: '创建',
    });
    if (name == null) return;

    let valid;
    try {
      valid = fsUtil.validateName(name);
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }

    const target = fsUtil.joinPath(state.cwd, valid);

    await withBusy('正在创建文件夹…', async () => {
      if (await deviceFs.exists(target)) throw new Error('同名文件或文件夹已存在');
      await deviceFs.mkdir(target);
      await navigate(state.cwd, { keepFilter: true, force: true });
      toast('已创建文件夹 ' + valid, 'success');
    });
  }

  async function renameEntry(name, isDir) {
    const from = fsUtil.joinPath(state.cwd, name);
    const input = await UI.prompt({
      title: '重命名',
      label: isDir ? '请输入新的文件夹名称：' : '请输入新的文件名：',
      value: name,
      hint: '当前路径：' + from,
      confirmText: '重命名',
    });
    if (input == null) return;
    if (input.trim() === name) return;

    let valid;
    try {
      valid = fsUtil.validateName(input);
    } catch (err) {
      toast(err.message, 'warn');
      return;
    }

    const to = fsUtil.joinPath(state.cwd, valid);

    await withBusy('正在重命名…', async () => {
      if (await deviceFs.exists(to)) throw new Error('目标名称已存在');
      await deviceFs.rename(from, to);

      if (state.editorPath === from) {
        state.editorPath = to;
        dom.editorName.textContent = valid;
        editor.setMode(to);
      }

      await navigate(state.cwd, { keepFilter: true, force: true });
      toast('已重命名为 ' + valid, 'success');
    });
  }

  async function deleteEntries(names) {
    if (!names || !names.length) return;

    const label = names.length === 1 ? `“${names[0]}”` : `这 ${names.length} 个项目`;
    const ok = await UI.confirm(
      '删除确认',
      `确定要从设备中永久删除 ${label} 吗？文件夹会被递归删除，此操作不可撤销。`,
      { danger: true, confirmText: '永久删除' }
    );
    if (!ok) return;

    await withBusy('正在删除…', async (signal) => {
      for (let i = 0; i < names.length; i++) {
        const path = fsUtil.joinPath(state.cwd, names[i]);
        UI.updateProgress(`正在删除 ${names[i]}（${i + 1}/${names.length}）`);

        await deviceFs.removeRecursive(path, {
          signal,
          onProgress: (child) => UI.updateProgress(`正在删除 ${names[i]}/${child}`),
        });

        const current = state.editorPath || '';
        if (current === path || current.startsWith(path + '/')) closeEditor(true);
      }

      await navigate(state.cwd, { keepFilter: true, force: true });
      toast('已删除 ' + label, 'success');
    });
  }

  /** 逐级创建目录（已存在的跳过）；cache 用于避免重复查询 */
  async function ensureDirectory(path, cache) {
    const norm = fsUtil.normalizePath(path);
    if (norm === '/') return;

    const parts = norm.split('/').filter(Boolean);
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      if (cache && cache.has(acc)) continue;

      const st = await deviceFs.stat(acc);
      if (!st.exists) await deviceFs.mkdir(acc);
      else if (!st.dir) throw new Error('路径中存在同名文件：' + acc);

      if (cache) cache.add(acc);
    }
  }

  /* ============================ 上传 ============================ */

  async function onFilePicked(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    await uploadFileList(files, false);
  }

  async function onFolderPicked(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    await uploadFileList(files, true);
  }

  async function uploadFileList(files, useRelativePath) {
    if (!state.connected) return;

    const items = files.map((file) => {
      let relative = file.name;
      if (useRelativePath && file.webkitRelativePath) relative = file.webkitRelativePath;
      const segments = relative.split('/').filter(Boolean);
      const filename = segments.pop() || file.name;
      return { file, segments, filename };
    });

    await withBusy(`正在上传 ${items.length} 个文件…`, async (signal) => {
      let index = 0;
      const ensuredDirs = new Set(['/']);

      for (const item of items) {
        if (signal.aborted) throw abortError();

        let dirPath = state.cwd;
        for (const segment of item.segments) {
          dirPath = fsUtil.joinPath(dirPath, segment);
        }
        await ensureDirectory(dirPath, ensuredDirs);

        const buffer = new Uint8Array(await item.file.arrayBuffer());
        const target = fsUtil.joinPath(dirPath, item.filename);
        const label = item.segments.concat(item.filename).join('/');

        await deviceFs.writeFile(target, buffer, {
          signal,
          onProgress: (done, total) => UI.updateProgress(
            done,
            total,
            `正在上传 ${label}（${index + 1}/${items.length}）`
          ),
        });

        index++;
      }

      await navigate(state.cwd, { keepFilter: true, force: true });
      toast(`已上传 ${items.length} 个文件`, 'success');
    });
  }

  async function uploadEntries(entries) {
    await withBusy('正在上传…', async (signal) => {
      let count = 0;
      const ensuredDirs = new Set(['/']);

      const walk = async (entry, parentPath) => {
        if (signal.aborted) throw abortError();

        if (entry.isFile) {
          const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
          const buffer = new Uint8Array(await file.arrayBuffer());
          const target = fsUtil.joinPath(parentPath, entry.name);

          await deviceFs.writeFile(target, buffer, {
            signal,
            onProgress: (done, total) => UI.updateProgress(
              done,
              total,
              '正在上传 ' + (entry.fullPath || entry.name)
            ),
          });

          count++;
          return;
        }

        if (entry.isDirectory) {
          const dirPath = fsUtil.joinPath(parentPath, entry.name);
          await ensureDirectory(dirPath, ensuredDirs);

          const children = await readAllDirectoryEntries(entry.createReader());
          for (const child of children) {
            await walk(child, dirPath);
          }
        }
      };

      for (const entry of entries) await walk(entry, state.cwd);

      await navigate(state.cwd, { keepFilter: true, force: true });
      toast(`已上传 ${count} 个文件`, 'success');
    });
  }

  function readAllDirectoryEntries(reader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const next = () => {
        reader.readEntries((batch) => {
          if (!batch.length) {
            resolve(all);
            return;
          }
          all.push(...batch);
          next();
        }, reject);
      };
      next();
    });
  }

  function abortError() {
    const err = new Error('操作已取消');
    err.name = 'AbortError';
    return err;
  }

  /* ============================ 下载 ============================ */

  async function downloadSelection() {
    if (!state.connected) return;

    const names = getSelectedNames();
    if (!names.length) {
      const ok = await UI.confirm(
        '下载整个目录',
        `当前没有选中任何项目，是否把 “${state.cwd}” 打包成 ZIP 下载？`,
        { confirmText: '打包下载' }
      );
      if (!ok) return;

      await downloadEntries([{
        name: fsUtil.baseName(state.cwd) || 'micropython-root',
        dir: true,
        path: state.cwd,
      }]);
      return;
    }

    const entries = names.map((name) => {
      const entry = entryByName(name);
      return {
        name,
        dir: entry ? entry.dir : false,
        path: fsUtil.joinPath(state.cwd, name),
      };
    });

    await downloadEntries(entries);
  }

  async function downloadEntries(entries) {
    if (!entries || !entries.length) return;

    if (entries.length === 1 && !entries[0].dir) {
      await downloadSingleFile(entries[0].path);
      return;
    }

    await withBusy('正在准备下载…', async (signal) => {
      const collected = [];

      for (const entry of entries) {
        const st = await deviceFs.stat(entry.path);
        if (!st.exists) continue;

        if (st.dir) {
          const files = await deviceFs.walkFiles(entry.path, entry.path);
          for (const file of files) {
            collected.push({
              path: file.path,
              zipName: entry.name + '/' + file.relative,
              size: file.size,
            });
          }
        } else {
          collected.push({ path: entry.path, zipName: entry.name, size: st.size });
        }
      }

      if (!collected.length) throw new Error('没有可下载的文件');

      const totalBytes = collected.reduce((sum, file) => sum + (file.size || 0), 0);
      const zipEntries = [];
      let doneBytes = 0;

      for (const file of collected) {
        if (signal.aborted) throw abortError();

        UI.updateProgress(doneBytes, totalBytes, '正在读取 ' + file.zipName);
        const data = await deviceFs.readFile(file.path, {
          signal,
          onProgress: (done) => UI.updateProgress(
            doneBytes + done,
            totalBytes,
            '正在读取 ' + file.zipName
          ),
        });

        zipEntries.push({ name: file.zipName, data });
        doneBytes += data.length;
      }

      UI.updateProgress(totalBytes, totalBytes, '正在生成 ZIP…');
      const zip = window.createZip(zipEntries);
      const baseName = entries.length === 1 ? entries[0].name : (fsUtil.baseName(state.cwd) || 'micropython');
      UI.downloadBlob(baseName + '.zip', zip, 'application/zip');
      toast(`打包完成，共 ${zipEntries.length} 个文件`, 'success');
    });
  }

  async function downloadSingleFile(path) {
    const name = fsUtil.baseName(path);
    await withBusy('正在下载 ' + name + '…', async (signal) => {
      const data = await deviceFs.readFile(path, {
        signal,
        onProgress: (done, total) => UI.updateProgress(done, total, '正在读取 ' + name),
      });
      UI.downloadBlob(name, data);
      toast('已下载 ' + name, 'success');
    });
  }

  /* ============================ 终端与复位 ============================ */

  async function toggleTerminal() {
    if (!state.connected || !terminal) return;

    if (state.terminalOpen) {
      await terminal.close();
      state.terminalOpen = false;
      dom.terminal.hidden = true;
      updateButtons();
      return;
    }

    if (state.editorDirty) {
      const ok = await UI.confirm(
        '有未保存的修改',
        '终端会切换设备的 REPL 状态，建议先保存编辑器内容。仍然打开终端吗？',
        { confirmText: '仍然打开' }
      );
      if (!ok) return;
    }

    state.terminalOpen = true;
    dom.terminal.hidden = false;
    updateButtons();

    try {
      await terminal.open();
    } catch (err) {
      state.terminalOpen = false;
      dom.terminal.hidden = true;
      updateButtons();
      toast('打开终端失败：' + ((err && err.message) || err), 'error');
    }
  }

  async function softResetDevice() {
    if (!state.connected || !repl) return;

    if (state.editorDirty) {
      const ok = await UI.confirm(
        '有未保存的修改',
        '软复位前建议先保存文件，继续操作会丢失编辑器中的修改。确定继续吗？',
        { danger: true, confirmText: '继续' }
      );
      if (!ok) return;
    }

    const ok = await UI.confirm(
      '软复位设备',
      '设备将重新启动并再次运行 boot.py / main.py，当前 REPL 会话会中断。确定继续吗？',
      { confirmText: '软复位' }
    );
    if (!ok) return;

    if (terminal && terminal.isOpen) {
      await terminal.close();
      state.terminalOpen = false;
      dom.terminal.hidden = true;
    }

    closeEditor(true);

    await withBusy('正在软复位设备…', async () => {
      // 复位后设备会重新执行 boot.py / main.py，init 内部用 Ctrl-C 抢占 REPL
      await repl.init({ reset: 'always', allowHardReset: false });
      state.info = await deviceFs.info().catch(() => ({}));
      renderDeviceInfo();
      await navigate('/', { force: true });
      refreshSpace();
      toast('设备已软复位', 'success');
    });
  }

  /* ============================ 右键菜单 ============================ */

  function showContextMenu(x, y, name, isDir) {
    if (state.busy) return;

    const menu = dom.contextMenu;
    const fullPath = fsUtil.joinPath(state.cwd, name);

    const items = [
      {
        label: isDir ? '打开文件夹' : '编辑文件',
        icon: isDir ? 'i-folder' : 'i-edit',
        run: () => openEntry(name, isDir),
      },
      {
        label: '下载',
        icon: 'i-download',
        run: () => handleRowAction('download', name, isDir),
      },
      { sep: true },
      {
        label: '重命名',
        icon: 'i-corner',
        run: () => renameEntry(name, isDir),
      },
      {
        label: '复制路径',
        icon: 'i-copy',
        run: () => copyText(fullPath),
      },
      { sep: true },
      {
        label: '删除',
        icon: 'i-trash',
        danger: true,
        run: () => deleteEntries([name]),
      },
    ];

    menu.innerHTML =
      `<div class="menu-title">${escapeHtml(name)}</div>` +
      items
        .map((item, index) => {
          if (item.sep) return '<div class="menu-sep"></div>';
          const danger = item.danger ? ' danger' : '';
          return (
            `<button class="menu-item${danger}" data-index="${index}">` +
            `<svg class="ico"><use href="#${item.icon}"></use></svg>` +
            `<span>${escapeHtml(item.label)}</span></button>`
          );
        })
        .join('');

    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';

    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    menu.onclick = (event) => {
      const btn = event.target.closest('.menu-item');
      if (!btn) return;
      event.stopPropagation();
      hideContextMenu();
      const item = items[Number(btn.dataset.index)];
      if (item && item.run) item.run();
    };
  }

  function hideContextMenu() {
    if (!dom.contextMenu) return;
    dom.contextMenu.hidden = true;
  }

  function clearContextMenu() {
    if (!dom.contextMenu) return;
    dom.contextMenu.innerHTML = '';
    dom.contextMenu.hidden = true;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('已复制：' + text, 'success');
    } catch (err) {
      toast('复制失败：' + (err.message || err), 'error');
    }
  }

  /* ============================ 存储空间 ============================ */

  async function refreshSpace() {
    if (!state.connected || !deviceFs) {
      dom.statSpace.textContent = '';
      return;
    }

    try {
      const space = await deviceFs.space();
      if (space && space.total) {
        dom.statSpace.textContent = `存储 ${formatSize(space.free)} 可用 / ${formatSize(space.total)}`;
      } else {
        dom.statSpace.textContent = '';
      }
    } catch (err) {
      dom.statSpace.textContent = '';
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
