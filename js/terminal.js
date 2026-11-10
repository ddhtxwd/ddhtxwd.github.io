/* ============================================================
 * terminal.js — 设备串口终端
 *
 * 直接把串口数据渲染到页面，并把键盘输入转发给设备，
 * 支持 MicroPython REPL 的光标控制与命令编辑。
 * ============================================================ */
(function (global) {
  'use strict';

  const MAX_LINES = 3000;
  const MAX_LINE_LENGTH = 4000;

  /** 终端光标模型：维护历史行 + 当前行 */
  class TerminalView {
    constructor(el) {
      this.el = el;
      this.lines = [];
      this.line = '';
      this.col = 0;
      this._dirty = false;
      this._frame = null;
      this._atBottom = true;
    }

    clear() {
      this.lines = [];
      this.line = '';
      this.col = 0;
      this.el.textContent = '';
    }

    write(text) {
      const str = String(text || '');
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];

        if (ch === '\x1b') {
          if (str[i + 1] === '[') {
            let j = i + 2;
            while (j < str.length && !/[A-Za-z]/.test(str[j])) j++;
            if (j >= str.length) break;
            this._csi(str.slice(i + 2, j), str[j]);
            i = j;
          } else {
            i++;
          }
          continue;
        }

        if (ch === '\r') {
          this.col = 0;
          continue;
        }
        if (ch === '\n') {
          this._newline();
          continue;
        }
        if (ch === '\b') {
          if (this.col > 0) this.col--;
          continue;
        }
        if (ch === '\x07') continue;

        this._put(ch);
      }
      this._schedule();
    }

    _put(ch) {
      if (this.line.length > MAX_LINE_LENGTH) return;
      if (this.col < this.line.length) {
        this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + 1);
      } else {
        this.line += ch;
      }
      this.col++;
    }

    _newline() {
      this.lines.push(this.line);
      this.line = '';
      this.col = 0;
      if (this.lines.length > MAX_LINES) {
        this.lines.splice(0, this.lines.length - MAX_LINES);
      }
    }

    _csi(params, cmd) {
      switch (cmd) {
        case 'K': {
          const mode = params === '' ? 0 : Number(params);
          if (mode === 0) this.line = this.line.slice(0, this.col);
          else if (mode === 1) this.line = ' '.repeat(this.col) + this.line.slice(this.col);
          else if (mode === 2) this.line = '';
          break;
        }
        case 'J': {
          const mode = params === '' ? 0 : Number(params);
          if (mode === 2 || mode === 3) {
            this.lines = [];
            this.line = '';
            this.col = 0;
          } else if (mode === 0) {
            this.line = this.line.slice(0, this.col);
          }
          break;
        }
        case 'D': {
          const n = Number(params) || 1;
          this.col = Math.max(0, this.col - n);
          break;
        }
        case 'C': {
          const n = Number(params) || 1;
          this.col = Math.min(this.line.length, this.col + n);
          break;
        }
        case 'G': {
          this.col = Math.max(0, (Number(params) || 1) - 1);
          break;
        }
        default:
          break;
      }
    }

    _schedule() {
      if (this._frame) return;
      this._frame = requestAnimationFrame(() => {
        this._frame = null;
        this.render();
      });
    }

    render() {
      const el = this.el;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
      el.textContent = this.lines.join('\n') + (this.lines.length ? '\n' : '') + this.line;
      if (nearBottom || this._atBottom) {
        el.scrollTop = el.scrollHeight;
        this._atBottom = true;
      }
      const onScroll = () => {
        this._atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      };
      if (!this._scrollBound) {
        this._scrollBound = true;
        el.addEventListener('scroll', onScroll);
      }
    }
  }

  class DeviceTerminal {
    constructor(options) {
      this.transport = options.transport;
      this.repl = options.repl;
      this.view = new TerminalView(options.bodyEl);
      this.isOpen = false;
      this._onData = null;
      this._onKeyDown = null;
      this._onPaste = null;
    }

    _bind() {
      if (this._onData) return;

      this._onData = (event) => {
        const chunk = event.detail;
        this.view.write(new TextDecoder().decode(chunk));
      };
      this.transport.addEventListener('data', this._onData);

      this._onKeyDown = (event) => this._handleKey(event);
      this._onPaste = (event) => {
        const text = event.clipboardData && event.clipboardData.getData('text');
        if (text) {
          event.preventDefault();
          this._send(text);
        }
      };

      this.view.el.addEventListener('keydown', this._onKeyDown);
      this.view.el.addEventListener('paste', this._onPaste);
      this.view.el.addEventListener('click', () => this.view.el.focus());
    }

    _unbind() {
      if (this._onData) {
        this.transport.removeEventListener('data', this._onData);
        this._onData = null;
      }
      if (this._onKeyDown) {
        this.view.el.removeEventListener('keydown', this._onKeyDown);
        this._onKeyDown = null;
      }
      if (this._onPaste) {
        this.view.el.removeEventListener('paste', this._onPaste);
        this._onPaste = null;
      }
    }

    _send(data) {
      if (!this.transport.isOpen) return;
      this.transport.write(data).catch(() => {});
    }

    _handleKey(event) {
      if (!this.transport.isOpen) return;

      const key = event.key;
      const ctrl = event.ctrlKey || event.metaKey;
      const selection = window.getSelection();

      // 有选中文本时让浏览器处理复制
      if (ctrl && key.toLowerCase() === 'c' && selection && String(selection).length) {
        return;
      }

      if (ctrl) {
        const lower = key.toLowerCase();
        if (lower === 'v') return; // 交给 paste 事件

        event.preventDefault();

        if (lower === 'c') {
          this._send('\x03');
          return;
        }
        if (lower === 'd') {
          this._send('\x04');
          return;
        }
        if (lower === 'l') {
          this.view.clear();
          this._send('\x0c');
          return;
        }
        if (key.length === 1) {
          const code = key.toUpperCase().charCodeAt(0) - 64;
          if (code >= 0 && code < 32) this._send(String.fromCharCode(code));
        }
        return;
      }

      const map = {
        Enter: '\r',
        Backspace: '\x7f',
        Tab: '\t',
        Escape: '\x1b',
        ArrowUp: '\x1b[A',
        ArrowDown: '\x1b[B',
        ArrowRight: '\x1b[C',
        ArrowLeft: '\x1b[D',
        Home: '\x1b[H',
        End: '\x1b[F',
        Delete: '\x1b[3~',
        PageUp: '\x1b[5~',
        PageDown: '\x1b[6~',
      };

      if (map[key] !== undefined) {
        event.preventDefault();
        this._send(map[key]);
        return;
      }

      if (key.length === 1) {
        event.preventDefault();
        this._send(key);
      }
    }

    async open() {
      if (this.isOpen) return;

      this.transport.terminalMode = true;
      this._bind();
      this.view.clear();

      try {
        await this.repl.exitRaw();
        await this.transport.write('\r\x03');
      } catch (err) {
        /* ignore */
      }

      this.isOpen = true;
      setTimeout(() => this.view.el.focus(), 60);
    }

    async close() {
      if (!this.isOpen) return;
      this.isOpen = false;

      this._unbind();
      this.transport.terminalMode = false;
      this.transport.clear();

      try {
        await this.repl.hardInterrupt();
      } catch (err) {
        /* ignore */
      }
    }

    writeLine(text, kind) {
      const prefix = kind === 'error' ? '!' : '>';
      this.view.write(`${prefix} ${text}\n`);
    }
  }

  global.DeviceTerminal = DeviceTerminal;
  global.TerminalView = TerminalView;
})(window);
