/* ============================================================
 * editor.js — 代码编辑器封装
 *
 * 优先使用 CodeMirror（CDN 加载成功时），
 * 否则自动降级为原生 textarea，保证离线也可用。
 * ============================================================ */
(function (global) {
  'use strict';

  const MONO_SELECT = 'textarea.editor-fallback';

  class CodeEditor {
    constructor(options) {
      const opts = options || {};
      this.textarea = opts.textarea;
      this.onChange = opts.onChange || function () {};
      this.onSave = opts.onSave || function () {};

      this.cm = null;
      this.fallback = false;
      this.initialized = false;
      this.cleanValue = '';
    }

    /** 首次显示编辑器时调用，避免在隐藏容器中初始化 CodeMirror */
    init() {
      if (this.initialized) {
        this.refresh();
        return;
      }
      this.initialized = true;

      if (global.CodeMirror) {
        try {
          this.cm = global.CodeMirror.fromTextArea(this.textarea, {
            lineNumbers: true,
            mode: { name: 'python', version: 3 },
            theme: 'material-darker',
            indentUnit: 4,
            tabSize: 4,
            indentWithTabs: false,
            lineWrapping: false,
            autoCloseBrackets: true,
            matchBrackets: true,
            styleActiveLine: true,
            viewportMargin: 40,
            extraKeys: {
              'Ctrl-S': () => this.onSave(),
              'Cmd-S': () => this.onSave(),
              Tab: (cm) => {
                if (cm.somethingSelected()) {
                  cm.indentSelection('add');
                } else {
                  cm.replaceSelection('    ', 'end');
                }
              },
            },
          });

          this.cm.on('change', () => this.onChange(this.getValue()));
          return;
        } catch (err) {
          this.cm = null;
        }
      }

      // 降级：原生 textarea
      this.fallback = true;
      this.textarea.classList.add('editor-fallback');
      if (!document.querySelector('style[data-editor-fallback]')) {
        const style = document.createElement('style');
        style.setAttribute('data-editor-fallback', '1');
        style.textContent = `${MONO_SELECT} { display:block; }`;
        document.head.appendChild(style);
      }

      this.textarea.addEventListener('input', () => this.onChange(this.getValue()));
      this.textarea.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          this._insertAtCursor('    ');
          return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          this.onSave();
        }
      });
    }

    _insertAtCursor(text) {
      const el = this.textarea;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    getValue() {
      return this.cm ? this.cm.getValue() : this.textarea.value;
    }

    setValue(text, path) {
      const value = text == null ? '' : String(text);
      if (path) this.setMode(path);

      // 先更新基线，避免 setValue 触发的 change 回调把内容误判为已修改
      this.cleanValue = value;

      if (this.cm) {
        this.cm.setValue(value);
        this.cm.clearHistory();
        this.cm.setCursor(0, 0);
        this.cm.scrollTo(0, 0);
      } else {
        this.textarea.value = value;
        this.textarea.scrollTop = 0;
      }

      this.cleanValue = this.getValue();
      this.refresh();
    }

    markClean() {
      this.cleanValue = this.getValue();
    }

    isDirty() {
      if (!this.initialized) return false;
      return this.getValue() !== this.cleanValue;
    }

    setMode(path) {
      if (!this.cm) return;
      const ext = UI.getExtension(path);
      const isPython = ext === 'py' || ext === 'mpy';
      this.cm.setOption('mode', isPython ? { name: 'python', version: 3 } : 'text/plain');
    }

    focus() {
      setTimeout(() => {
        if (this.cm) {
          this.cm.focus();
          return;
        }
        try {
          this.textarea.focus();
        } catch (err) {
          /* ignore */
        }
      }, 40);
    }

    refresh() {
      if (!this.cm) return;
      setTimeout(() => {
        try {
          this.cm.refresh();
        } catch (err) {
          /* ignore */
        }
      }, 40);
    }

    /** 在光标处插入文本（用于终端/代码片段扩展） */
    insert(text) {
      if (this.cm) {
        this.cm.replaceSelection(String(text));
        return;
      }
      this._insertAtCursor(String(text));
    }
  }

  global.CodeEditor = CodeEditor;
})(window);
