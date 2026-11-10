/* ============================================================
 * transport.js — Web Serial 传输层
 *
 * 提供带缓冲的串口读写能力：
 *   - 后台持续读取，把数据追加到内部缓冲区
 *   - readUntil / readExact 在数据到达时自动唤醒
 *   - 所有读写异常统一抛出，方便上层重试
 * ============================================================ */
(function (global) {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** 把多种输入统一成 Uint8Array */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return encoder.encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(data);
  }

  function indexOfSequence(haystack, needle, fromIndex) {
    const n = needle.length;
    if (n === 0) return fromIndex || 0;
    const last = haystack.length - n;
    outer:
    for (let i = Math.max(0, fromIndex || 0); i <= last; i++) {
      for (let j = 0; j < n; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  class SerialTimeoutError extends Error {
    constructor(message) {
      super(message || '等待设备响应超时');
      this.name = 'SerialTimeoutError';
    }
  }

  class SerialTransport extends EventTarget {
    constructor() {
      super();
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.reading = false;
      this.closed = true;
      this.terminalMode = false; // 终端模式下不再累积缓冲区
      this._buf = new Uint8Array(0);
      this._waiters = [];
      this._closing = false;
    }

    static get supported() {
      return typeof navigator !== 'undefined' && !!navigator.serial;
    }

    /** 已获得过授权的串口列表 */
    static async authorizedPorts() {
      if (!SerialTransport.supported) return [];
      try {
        return await navigator.serial.getPorts();
      } catch (err) {
        return [];
      }
    }

    get isOpen() {
      return !!this.port && !this.closed;
    }

    /** 弹出系统串口选择框 */
    static async requestPort(filters) {
      if (!SerialTransport.supported) {
        throw new Error('当前浏览器不支持 Web Serial，请使用 Chrome / Edge 88+ 桌面版');
      }
      return navigator.serial.requestPort(filters ? { filters } : {});
    }

    async connect(port, baudRate) {
      if (this.port) await this.disconnect();

      this._closing = false;
      this._buf = new Uint8Array(0);

      try {
        await port.open({
          baudRate: Number(baudRate) || 115200,
          bufferSize: 16384,
        });
      } catch (err) {
        const msg = (err && err.message) || String(err);
        if (/access denied|in use|busy/i.test(msg)) {
          throw new Error('串口被占用：请关闭其它串口工具（如 Thonny、串口助手）后重试');
        }
        throw new Error('无法打开串口：' + msg);
      }

      this.port = port;

      // ESP32 等带自动下载电路的板子：保持 DTR/RTS 为低，避免意外进入下载模式
      try {
        await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      } catch (err) {
        /* 部分串口不支持 setSignals，忽略 */
      }

      try {
        this.writer = port.writable.getWriter();
      } catch (err) {
        await this._safeClosePort();
        throw new Error('无法获取串口写入通道：' + ((err && err.message) || err));
      }

      try {
        this.reader = port.readable.getReader();
      } catch (err) {
        this.writer.releaseLock();
        this.writer = null;
        await this._safeClosePort();
        throw new Error('无法获取串口读取通道：' + ((err && err.message) || err));
      }

      this.closed = false;
      this._pump();
      this.dispatchEvent(new CustomEvent('open'));
      return this;
    }

    async _safeClosePort() {
      try {
        if (this.port) await this.port.close();
      } catch (err) {
        /* ignore */
      }
      this.port = null;
    }

    async _pump() {
      this.reading = true;
      const reader = this.reader;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) this._push(value);
        }
      } catch (err) {
        if (!this._closing) {
          this.dispatchEvent(new CustomEvent('error', { detail: err }));
        }
      } finally {
        this.reading = false;
        try {
          reader.releaseLock();
        } catch (err) {
          /* ignore */
        }
        if (!this._closing) {
          this.closed = true;
          this.port = null;
          this._failWaiters(new Error('串口连接已断开'));
          this.dispatchEvent(new CustomEvent('close'));
        }
      }
    }

    _push(chunk) {
      if (!this.terminalMode) {
        const merged = new Uint8Array(this._buf.length + chunk.length);
        merged.set(this._buf, 0);
        merged.set(chunk, this._buf.length);
        this._buf = merged;
      }
      this.dispatchEvent(new CustomEvent('data', { detail: chunk }));
      if (!this.terminalMode) this._checkWaiters();
    }

    async disconnect() {
      if (!this.port) return;
      this._closing = true;
      this.terminalMode = false;

      const reader = this.reader;
      if (reader) {
        try {
          await reader.cancel();
        } catch (err) {
          /* ignore */
        }
        try {
          await reader.closed;
        } catch (err) {
          /* ignore */
        }
      }

      try {
        if (this.writer) this.writer.releaseLock();
      } catch (err) {
        /* ignore */
      }
      this.writer = null;
      this.reader = null;

      await this._safeClosePort();

      this.closed = true;
      this.reading = false;
      this._buf = new Uint8Array(0);
      this._writeChain = null;
      this._failWaiters(new Error('串口已关闭'));
      this.dispatchEvent(new CustomEvent('close'));
    }

    /** 写入数据；内部自动串行化，避免并发写冲突 */
    async write(data) {
      if (!this.writer) throw new Error('串口未打开');
      const buf = toBytes(data);
      if (!buf.length) return;

      const writer = this.writer;
      if (!this._writeChain) this._writeChain = Promise.resolve();

      const task = this._writeChain.then(() => writer.write(buf));
      this._writeChain = task.catch(() => {});
      return task;
    }

    clear() {
      this._buf = new Uint8Array(0);
    }

    get bufferedLength() {
      return this._buf.length;
    }

    /** 清空缓冲，并丢弃接下来 duration 毫秒内到达的数据 */
    async discard(duration) {
      this._buf = new Uint8Array(0);
      if (duration > 0) {
        await new Promise((resolve) => setTimeout(resolve, duration));
        this._buf = new Uint8Array(0);
      }
    }

    /**
     * 通过 DTR/RTS 脉冲触发硬件复位（适用于 ESP32/ESP8266 等带自动复位电路的板子）。
     * DTR 始终保持 false，避免拉低 IO0 把设备带入下载模式。
     */
    async pulseReset(holdMs) {
      if (!this.port) throw new Error('串口未打开');
      if (typeof this.port.setSignals !== 'function') throw new Error('当前串口不支持信号控制');

      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise((resolve) => setTimeout(resolve, holdMs || 120));
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      return true;
    }

    /**
     * 等待缓冲区中出现指定字节序列。
     * @returns {Promise<Uint8Array>} pattern 之前的所有字节（pattern 本身已被消费）
     */
    readUntil(pattern, timeout) {
      const needle = toBytes(pattern);
      return this._waitFor((buf) => {
        const idx = indexOfSequence(buf, needle, 0);
        if (idx < 0) return null;
        const end = idx + needle.length;
        return { consume: end, value: buf.slice(0, idx) };
      }, timeout);
    }

    /** 读取恰好 n 字节 */
    readExact(n, timeout) {
      return this._waitFor((buf) => {
        if (buf.length < n) return null;
        return { consume: n, value: buf.slice(0, n) };
      }, timeout);
    }

    /** 读取当前已缓冲的全部数据（不等待） */
    readAvailable() {
      const out = this._buf;
      this._buf = new Uint8Array(0);
      return out;
    }

    _waitFor(predicate, timeout) {
      const limit = timeout === undefined ? 5000 : timeout;
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          timer: null,
          settle: (ok, value) => {
            if (waiter.done) return;
            waiter.done = true;
            if (waiter.timer) clearTimeout(waiter.timer);
            const i = this._waiters.indexOf(waiter);
            if (i >= 0) this._waiters.splice(i, 1);
            if (ok) resolve(value);
            else reject(value);
          },
        };

        if (limit > 0) {
          waiter.timer = setTimeout(() => {
            const preview = decoder.decode(this._buf.slice(-120));
            waiter.settle(false, new SerialTimeoutError(
              '等待设备响应超时' + (preview ? '，最近收到：' + JSON.stringify(preview) : '')
            ));
          }, limit);
        }

        this._waiters.push(waiter);
        this._checkWaiters();
      });
    }

    _checkWaiters() {
      if (!this._waiters.length) return;
      for (const waiter of this._waiters.slice()) {
        let result;
        try {
          result = waiter.predicate(this._buf);
        } catch (err) {
          waiter.settle(false, err);
          continue;
        }
        if (!result) continue;
        if (result.consume != null) {
          this._buf = this._buf.slice(result.consume);
        }
        waiter.settle(true, result.value);
      }
    }

    _failWaiters(err) {
      for (const waiter of this._waiters.slice()) {
        waiter.settle(false, err);
      }
      this._waiters.length = 0;
    }
  }

  global.SerialTransport = SerialTransport;
  global.SerialTimeoutError = SerialTimeoutError;
  global.toBytes = toBytes;
  global.decodeBytes = (b) => decoder.decode(b);
})(window);
