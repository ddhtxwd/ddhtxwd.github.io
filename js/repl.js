/* ============================================================
 * repl.js — MicroPython REPL 协议
 *
 * 支持两种执行模式：
 *   1. raw REPL：Ctrl-A 进入，发送代码 + Ctrl-D 执行
 *   2. raw-paste：Ctrl-E "A" Ctrl-A 进入，带窗口流控，适合传输大段代码
 *
 * 返回结构：{ out, err }，其中 err 为设备端 traceback。
 *
 * 注意：所有公开方法都会进入串行队列；内部实现统一使用下划线前缀
 * 的方法，避免在队列任务里再次排队造成死锁。
 * ============================================================ */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const RAW_PROMPT = 'raw REPL; CTRL-B to exit';
  const EOT = 0x04;
  const ENQ = 0x05;

  const REPL_HINT =
    '无法让设备进入 REPL，请确认：\n' +
    '1. 设备已烧录 MicroPython 固件\n' +
    '2. 波特率正确（USB 直连一般用 115200）\n' +
    '3. 设备没有处于休眠状态，必要时按一下板上的 RESET 键';

  const USB_RESET_HINT =
    '设备在复位过程中断开了串口。\n' +
    '若设备使用原生 USB CDC（如 ESP32-S2/S3/C3、RP2040 USB），复位会导致串口重新枚举，\n' +
    '请重新连接并取消勾选「连接时复位」。';

  /** 构造一个可被 _exec 识别并降级的错误 */
  function pasteUnsupported() {
    const err = new Error('设备不支持 raw-paste 模式');
    err.name = 'PasteUnsupported';
    return err;
  }

  class DeviceError extends Error {
    constructor(message, traceback) {
      super(message);
      this.name = 'DeviceError';
      this.traceback = traceback || '';
    }
  }

  /** 从设备 traceback 中取出最有价值的一行 */
  function describeTraceback(traceback) {
    const lines = String(traceback || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return '设备执行失败';
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/^(Traceback|File ")/.test(line)) continue;
      return line;
    }
    return lines[lines.length - 1];
  }

  class MicroPythonREPL {
    constructor(transport) {
      if (!transport) throw new Error('MicroPythonREPL 需要串口连接');
      this.t = transport;
      this.raw = false;
      this.pasteSupported = true;
      this._chain = Promise.resolve();
    }

    /** 把所有设备操作串行化，避免协议交叠 */
    _queue(fn) {
      const next = this._chain.then(() => fn());
      this._chain = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    }

    get connected() {
      return this.t && this.t.isOpen;
    }

    /* ========================= 公开 API ========================= */

    /**
     * 连接后初始化：让设备回到可用的 REPL，再进入 raw REPL。
     * 设备可能正在运行 boot.py / main.py，直接发 Ctrl-A 不会得到响应，必须先中断或复位。
     *
     * @param {object} options
     *   reset: 'auto'（默认，中断无效才软复位）| 'always'（总是软复位）| 'never'（只中断）
     *   allowHardReset: 软复位无效时是否尝试 DTR/RTS 硬复位（默认 true）
     *   onStatus: (text) => void，用于更新界面提示
     * @returns {Promise<string>} 恢复方式：'interrupt' | 'soft' | 'hard'
     */
    init(options) {
      const opts = options || {};
      return this._queue(async () => {
        const how = await this._recover(opts);
        this.recoveredBy = how;

        await this._enterRaw();

        const probe = await this._exec('print(1)', 8000);
        if (probe.err) {
          throw new DeviceError('设备 REPL 异常：' + describeTraceback(probe.err), probe.err);
        }
        if (probe.out.trim() !== '1') {
          throw new DeviceError('设备返回了意外数据：' + JSON.stringify(probe.out.slice(0, 80)));
        }
        return how;
      });
    }

    /** 执行一段 Python 代码，返回 { out, err }；err 非空时抛 DeviceError */
    exec(code, options) {
      const opts = options || {};
      return this._queue(async () => {
        const result = await this._exec(code, opts.timeout || 20000);
        if (result.err && !opts.allowError) {
          throw new DeviceError(describeTraceback(result.err), result.err);
        }
        return result;
      });
    }

    /** 执行并解析 JSON 输出 */
    execJSON(code, options) {
      return this.exec(code, options).then((res) => {
        const text = res.out.trim();
        if (!text) throw new DeviceError('设备没有返回数据');
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new DeviceError('无法解析设备返回的数据：' + JSON.stringify(text.slice(0, 120)));
        }
      });
    }

    /** 强制中断（排他） */
    interrupt() {
      return this._queue(() => this._hardInterrupt());
    }

    /** 软复位（排他） */
    softReset() {
      return this._queue(() => this._softReset());
    }

    /** 进入 raw REPL（排他） */
    enterRaw() {
      return this._queue(() => this._enterRaw());
    }

    /** 退出 raw REPL，回到普通交互提示符（排他） */
    exitRaw() {
      return this._queue(() => this._exitRaw());
    }

    /** 强制中断（排他） */
    hardInterrupt() {
      return this._queue(() => this._hardInterrupt());
    }

    /* ========================= 内部实现 ========================= */

    /* ---------- 让设备回到 REPL ---------- */

    /**
     * 设备可能正在运行用户程序，导致 REPL 无响应。
     * 依次尝试：Ctrl-C 中断 → Ctrl-D 软复位 → DTR/RTS 硬复位。
     */
    async _recover(opts) {
      if (!this.t.isOpen) throw new Error('串口未连接');

      const reset = opts.reset || 'auto';
      const status = opts.onStatus || function () {};
      const allowHard = opts.allowHardReset !== false;

      if (reset === 'always') {
        status('正在复位设备…');
        if (await this._softResetAndGrab()) return 'soft';
        if (allowHard && (await this._hardResetAndGrab())) return 'hard';
        throw new Error(REPL_HINT);
      }

      status('正在中断设备上运行的程序…');
      if (await this._interruptAndGrab()) return 'interrupt';

      if (reset === 'never') throw new Error(REPL_HINT);

      status('设备无响应，正在软复位…');
      if (await this._softResetAndGrab()) return 'soft';

      if (allowHard) {
        status('软复位无效，正在硬复位设备…');
        if (await this._hardResetAndGrab()) return 'hard';
      }

      throw new Error(REPL_HINT);
    }

    /** 仅用 Ctrl-C 打断当前程序，不重启设备 */
    async _interruptAndGrab() {
      for (let round = 0; round < 2; round++) {
        if (!this.t.isOpen) throw new Error(USB_RESET_HINT);

        this.t.clear();
        await this.t.write('\x02\r'); // 若处于 raw REPL 先退出
        await sleep(40);
        await this.t.write('\x03\x03'); // 连续中断
        await sleep(60);
        await this.t.write('\r'); // 触发提示符回显

        if (await this._awaitPrompt(700)) return true;
      }
      return false;
    }

    /** Ctrl-D 软复位，并在启动阶段连续 Ctrl-C 抢占 REPL */
    async _softResetAndGrab() {
      if (!this.t.isOpen) throw new Error(USB_RESET_HINT);

      this.t.clear();
      await this.t.write('\x02'); // 退出 raw REPL
      await sleep(50);
      await this.t.write('\x03'); // 打断当前程序
      await sleep(50);
      this.t.clear();
      await this.t.write('\x04'); // 软复位

      return this._grabPrompt(5000);
    }

    /** 通过 DTR/RTS 脉冲硬复位 */
    async _hardResetAndGrab() {
      if (!this.t.isOpen) throw new Error(USB_RESET_HINT);
      if (typeof this.t.pulseReset !== 'function') return false;

      try {
        await this.t.pulseReset();
      } catch (err) {
        return false;
      }

      await sleep(200);
      return this._grabPrompt(5000);
    }

    /** 复位后反复发 Ctrl-C / 回车，直到出现 >>> 提示符 */
    async _grabPrompt(timeout) {
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        if (!this.t.isOpen) throw new Error(USB_RESET_HINT);

        await sleep(150);
        try {
          await this.t.write('\x03\r');
        } catch (err) {
          throw new Error(USB_RESET_HINT);
        }

        if (await this._awaitPrompt(250)) return true;
      }
      return false;
    }

    /** 在超时时间内轮询 >>> 提示符 */
    async _awaitPrompt(timeout) {
      const deadline = Date.now() + timeout;

      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) return false;
        if (!this.t.isOpen) return false;

        try {
          await this.t.readUntil('>>>', Math.min(250, remain));
          return true;
        } catch (err) {
          if (err && err.name !== 'SerialTimeoutError') return false;
        }
      }
    }

    async _softReset() {
      this.raw = false;
      this.t.clear();
      await this.t.write('\x02\r');
      await sleep(60);
      await this.t.write('\x03');
      await sleep(60);
      this.t.clear();
      await this.t.write('\x04');
      await sleep(1400);
      this.t.clear();
      this.raw = false;
      return true;
    }

    async _enterRaw() {
      if (!this.t.isOpen) throw new Error('串口未连接');
      if (this.raw) return true;

      this.t.clear();
      await this.t.write('\x01'); // Ctrl-A

      let sawPrompt = false;
      try {
        await this.t.readUntil(RAW_PROMPT, 2000);
        sawPrompt = true;
      } catch (err) {
        // 某些固件提示文本不同，继续尝试等待提示符
      }

      try {
        await this.t.readUntil('>', sawPrompt ? 1000 : 2000);
      } catch (err) {
        this.raw = false;
        throw new Error(REPL_HINT);
      }

      this.raw = true;
      return true;
    }

    async _exitRaw() {
      if (!this.t.isOpen) {
        this.raw = false;
        return false;
      }
      this.t.clear();
      await this.t.write('\x02'); // Ctrl-B
      await sleep(60);
      this.t.clear();
      this.raw = false;
      return true;
    }

    async _hardInterrupt() {
      if (!this.t.isOpen) throw new Error('串口未连接');
      this.t.clear();
      await this.t.write('\x02\r'); // 若在 raw REPL 中则退出
      await sleep(50);
      await this.t.write('\x03\x03\r\x03'); // 连续中断
      await sleep(220);
      this.t.clear();
      this.raw = false;
      return true;
    }

    async _exec(code, timeout) {
      if (!this.t.isOpen) throw new Error('串口未连接');

      await this._enterRaw();

      const payload = enc.encode(String(code).replace(/\r\n/g, '\n'));
      this.t.clear();

      try {
        if (this.pasteSupported && payload.length > 24) {
          try {
            return await this._execPaste(payload, timeout);
          } catch (err) {
            // 无论是不支持还是传输失败，本会话都不再尝试 paste，避免同类操作反复失败
            this.pasteSupported = false;
            if (err && err.name === 'PasteUnsupported') {
              this.raw = false;
              await this._hardInterrupt();
              await this._enterRaw();
              return await this._execPlain(payload, timeout);
            }
            throw err;
          }
        }
        return await this._execPlain(payload, timeout);
      } catch (err) {
        if (err && (err.name === 'SerialTimeoutError' || /超时/.test(err.message || ''))) {
          this.raw = false;
          this.t.clear();
        }
        throw err;
      }
    }

    /** 直接发送代码（降级路径，带小分块避免 UART 缓冲溢出） */
    async _execPlain(payload, timeout) {
      const chunkSize = 48;
      for (let i = 0; i < payload.length; i += chunkSize) {
        await this.t.write(payload.subarray(i, i + chunkSize));
        if (i + chunkSize < payload.length) await sleep(4);
      }
      await this.t.write(new Uint8Array([EOT]));

      try {
        await this.t.readUntil('OK', 4000);
      } catch (err) {
        this.raw = false;
        throw new Error('设备没有响应 REPL 命令，请重新连接或复位设备');
      }

      const rest = await this.t.readUntil('\x04>', timeout);
      return this._parseResult(rest);
    }

    /**
     * raw-paste：带窗口流控的高速执行。
     * 协议对齐固件 shared/runtime/pyexec.c 与 pyboard.py 的 raw_paste_write：
     *   主机: Ctrl-E 'A' Ctrl-A
     *   设备: 'R' 0x01（支持）| 'R' 0x00（理解命令但不支持）
     *         + 窗口大小(2 字节小端) + 0x01（额外空闲窗口）
     *   传输: 每收满一个窗口，设备回 0x01 放行下一窗口
     *   结束: 主机发 Ctrl-D，设备回 0x04 表示源码收全（没有 'OK'）
     *   随后与 raw REPL 相同：<stdout> \x04 <stderr> \x04 >
     */
    async _execPaste(payload, timeout) {
      await this.t.write(new Uint8Array([ENQ, 0x41, 0x01])); // Ctrl-E 'A' Ctrl-A

      let header;
      try {
        header = await this.t.readExact(2, 2000);
      } catch (err) {
        throw pasteUnsupported();
      }
      if (header[0] !== 0x52 || header[1] !== 0x01) throw pasteUnsupported();

      let sizeBytes;
      try {
        sizeBytes = await this.t.readExact(2, 2000);
      } catch (err) {
        throw pasteUnsupported();
      }
      let windowSize = sizeBytes[0] | (sizeBytes[1] << 8);
      if (!windowSize || windowSize > 8192) windowSize = 128;

      // 设备随窗口大小还会补一个 0x01，因此初始可用 2 个窗口
      const maxCredit = windowSize * 2;
      let credit = windowSize;
      let offset = 0;

      while (offset < payload.length) {
        // 先把已到达的 ACK 收掉，每个 0x01 释放一个窗口
        while (this.t.bufferedLength > 0 && credit < maxCredit) {
          const byte = (await this.t.readExact(1, 500))[0];
          if (byte === 0x01) {
            credit += windowSize;
          } else if (byte === 0x04) {
            await this._abortPaste();
            throw new Error('设备中止了代码传输，请重试');
          } else {
            await this._abortPaste();
            throw new Error('raw-paste 传输出现异常数据，请重试');
          }
        }

        if (credit <= 0) {
          // 窗口用尽，必须等设备确认后才能继续
          let byte;
          try {
            byte = (await this.t.readExact(1, Math.min(Math.max(timeout, 2000), 8000)))[0];
          } catch (err) {
            await this._abortPaste();
            throw new Error('raw-paste 传输超时：设备没有确认接收窗口');
          }
          if (byte === 0x01) {
            credit += windowSize;
            continue;
          }
          await this._abortPaste();
          throw byte === 0x04
            ? new Error('设备中止了代码传输，请重试')
            : new Error('raw-paste 传输出现异常数据，请重试');
        }

        const size = Math.min(credit, payload.length - offset);
        await this.t.write(payload.subarray(offset, offset + size));
        offset += size;
        credit -= size;
      }

      // Ctrl-D 结束输入，设备读完会回 0x04
      await this.t.write(new Uint8Array([EOT]));

      try {
        await this.t.readUntil('\x04', 4000);
      } catch (err) {
        await this._abortPaste();
        throw new Error('设备没有确认代码接收完成，请重试');
      }

      const rest = await this.t.readUntil('\x04>', timeout);
      return this._parseResult(rest);
    }

    /** 传输异常后把设备从 paste 读取状态拉回 REPL */
    async _abortPaste() {
      this.raw = false;
      try {
        if (!this.t.isOpen) return;
        await this.t.write(new Uint8Array([0x03])); // Ctrl-C 中止 reader
        await sleep(150);
        this.t.clear();
      } catch (err) {
        // 串口可能已经断开，交给上层处理
      }
    }

    /** raw REPL 输出格式：<stdout> \x04 <stderr> */
    _parseResult(bytes) {
      const text = dec.decode(bytes);
      const idx = text.indexOf('\x04');
      let out = idx >= 0 ? text.slice(0, idx) : text;
      const err = idx >= 0 ? text.slice(idx + 1) : '';

      if (out.startsWith('OK')) out = out.slice(2);

      return {
        out: out.replace(/\r\n/g, '\n'),
        err: err.replace(/\r\n/g, '\n').trim(),
      };
    }
  }

  global.MicroPythonREPL = MicroPythonREPL;
  global.DeviceError = DeviceError;
  global.describeTraceback = describeTraceback;
})(window);
