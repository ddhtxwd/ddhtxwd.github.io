/* ============================================================
 * devicefs.js — 通过 REPL 操作 MicroPython 设备文件系统
 *
 * 所有操作都在设备端用一段自包含的 Python 代码完成，
 * 文件内容以 base64 分块传输，避免二进制破坏协议。
 * ============================================================ */
(function (global) {
  'use strict';

  const READ_CHUNK = 1024;   // 单次读取字节数
  const WRITE_CHUNK = 512;   // 单次写入字节数（兼顾速度与稳定性）

  /* ------------------------- 工具函数 ------------------------- */

  /** 生成安全的 Python 字符串字面量 */
  function pyStr(value) {
    return JSON.stringify(String(value));
  }

  function abortError() {
    const err = new Error('操作已取消');
    err.name = 'AbortError';
    return err;
  }

  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const clean = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!clean) return new Uint8Array(0);
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function joinPath(dir, name) {
    const base = String(dir || '/').replace(/\/+$/, '');
    return (base === '' ? '' : base) + '/' + name;
  }

  function normalizePath(path) {
    const parts = String(path || '/').replace(/\\/g, '/').split('/').filter(Boolean);
    return '/' + parts.join('/');
  }

  function parentPath(path) {
    const norm = normalizePath(path);
    if (norm === '/') return '/';
    const idx = norm.lastIndexOf('/');
    return idx <= 0 ? '/' : norm.slice(0, idx);
  }

  function baseName(path) {
    const norm = normalizePath(path);
    if (norm === '/') return '';
    return norm.slice(norm.lastIndexOf('/') + 1);
  }

  function extName(name) {
    const i = String(name).lastIndexOf('.');
    return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
  }

  function validateName(name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('名称不能为空');
    if (n === '.' || n === '..') throw new Error('名称不合法');
    if (/[\/\\]/.test(n)) throw new Error('名称不能包含 "/" 或 "\\"');
    if (n.length > 128) throw new Error('名称过长（最多 128 个字符）');
    return n;
  }

  /** 合并多个 Uint8Array */
  function concatBytes(parts, total) {
    if (parts.length === 1) return parts[0];
    const size = total != null ? total : parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }

  /* ------------------------- 设备文件系统 ------------------------- */

  class DeviceFS {
    constructor(repl) {
      this.repl = repl;
    }

    /* ---------- 设备信息 ---------- */

    async info() {
      const code = `
import sys, gc, os
try:
    import json as _json
except ImportError:
    import ujson as _json
_d = {}
try:
    _d["version"] = sys.version
except Exception:
    pass
try:
    _d["platform"] = sys.platform
except Exception:
    pass
try:
    _d["mem_free"] = gc.mem_free()
    _d["mem_alloc"] = gc.mem_alloc()
except Exception:
    pass
try:
    _u = os.uname()
    _d["sysname"] = _u.sysname
    _d["node"] = _u.node
    _d["release"] = _u.release
    _d["machine"] = _u.machine
except Exception:
    pass
print(_json.dumps(_d))
`;
      return this.repl.execJSON(code, { timeout: 10000 });
    }

    async space() {
      const code = `
import os
try:
    import json as _json
except ImportError:
    import ujson as _json
_d = {}
try:
    _s = os.statvfs("/")
    _bs = _s[0] or 4096
    _d["total"] = _bs * _s[2]
    _d["free"] = _bs * _s[3]
except Exception:
    pass
print(_json.dumps(_d))
`;
      return this.repl.execJSON(code, { timeout: 8000 });
    }

    /* ---------- 目录 ---------- */

    async ls(path) {
      const target = normalizePath(path);
      const code = `
import os
try:
    import json as _json
except ImportError:
    import ujson as _json
_p = ${pyStr(target)}
_r = []
try:
    _it = os.ilistdir(_p)
except Exception:
    _it = []
    try:
        for _n in os.listdir(_p):
            _it.append((_n, 0, 0))
    except Exception:
        _it = []
for _e in _it:
    _n = _e[0]
    if _n == "." or _n == "..":
        continue
    _p2 = _p + ("/" if not _p.endswith("/") else "") + _n
    _is_dir = (_e[1] & 0x4000) != 0
    _size = 0
    _mtime = 0
    try:
        _st = os.stat(_p2)
        _is_dir = (_st[0] & 0x4000) != 0
        _size = _st[6]
        if len(_st) > 8:
            _mtime = _st[8]
    except Exception:
        pass
    _r.append([_n, 1 if _is_dir else 0, _size, _mtime])
print(_json.dumps(_r))
`;
      const rows = await this.repl.execJSON(code, { timeout: 25000 });
      if (!Array.isArray(rows)) throw new Error('目录数据格式异常');
      return rows
        .map((row) => ({
          name: String(row[0]),
          dir: !!row[1],
          size: Number(row[2]) || 0,
          mtime: Number(row[3]) || 0,
        }))
        .sort((a, b) => {
          if (a.dir !== b.dir) return a.dir ? -1 : 1;
          return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
        });
    }

    /**
     * 扫描已安装的应用。
     * 约定：根目录下包含 app.json 的文件夹即为一个应用，
     * app.json 形如 {"app_name":"...","app_version":"0.1","app_dir":"web"}。
     * 整次扫描只占用一次 REPL 往返。
     */
    async scanApps() {
      const code = `
import os
try:
    import json as _json
except ImportError:
    import ujson as _json
try:
    import ubinascii as _b
except ImportError:
    import binascii as _b

def _slurp(_path, _limit):
    try:
        _f = open(_path, "rb")
        _data = _f.read(_limit)
        _f.close()
        return _data
    except Exception:
        return b""

try:
    _it = list(os.ilistdir("/"))
except Exception:
    _it = []
    try:
        for _x in os.listdir("/"):
            _it.append((_x, 0, 0))
    except Exception:
        _it = []

_r = []
for _e in _it:
    _n = _e[0]
    if _n == "." or _n == ".." or _n.startswith("."):
        continue
    _base = "/" + _n
    _is_dir = len(_e) > 1 and (_e[1] & 0x4000) != 0
    if not _is_dir:
        try:
            _is_dir = (os.stat(_base)[0] & 0x4000) != 0
        except Exception:
            _is_dir = False
    if not _is_dir:
        continue
    _raw = _slurp(_base + "/app.json", 16384)
    if not _raw:
        continue
    _name = ""
    _ver = ""
    _ad = ""
    _ic = ""
    _hp = ""
    _ok = 0
    try:
        try:
            _meta = _json.loads(_raw)
        except Exception:
            _meta = _json.loads(_raw.decode("utf-8"))
        if isinstance(_meta, dict):
            _ok = 1
            _name = str(_meta.get("app_name") or "")
            _ver = str(_meta.get("app_version") or "")
            _ad = str(_meta.get("app_dir") or "").strip("/")
            if _ad == "." or _ad == "./":
                _ad = ""
            _ic = str(_meta.get("app_icon") or "").lstrip("/")
            _hp = str(_meta.get("app_help") or "").strip()
    except Exception:
        _ok = 0
    _has = 0
    if _ad:
        try:
            if (os.stat(_base + "/" + _ad)[0] & 0x4000) != 0:
                _has = 1
        except Exception:
            _has = 0
    _icon = ""
    if _ic:
        try:
            if 0 < os.stat(_base + "/" + _ic)[6] <= 12288:
                _icon = _b.b2a_base64(_slurp(_base + "/" + _ic, 12288)).decode().strip()
        except Exception:
            _icon = ""
    _r.append([_n, _name, _ver, _ad, _has, _ic, _icon, _ok, _hp])

print(_json.dumps(_r))
`;
      const rows = await this.repl.execJSON(code, { timeout: 30000 });
      if (!Array.isArray(rows)) throw new Error('应用列表格式异常');

      return rows
        .map((row) => {
          const dir = String(row[0] || '').replace(/^\/+/, '');
          let appDir = String(row[3] || '').replace(/^\/+|\/+$/g, '');
          if (appDir === '.' || appDir === './') appDir = '';
          const item = {
            dir,
            path: '/' + dir,
            name: String(row[1] || '').trim() || dir,
            version: String(row[2] || '').trim(),
            appDir,
            hasAppDir: !!row[4],
            iconName: String(row[5] || ''),
            iconB64: String(row[6] || ''),
            valid: !!row[7],
            help: String(row[8] || '').trim(),
          };
          item.entryPath = item.hasAppDir ? '/' + dir + '/' + appDir : item.path;
          return item;
        })
        .filter((item) => item.dir && item.dir !== '.' && item.dir !== '..');
    }

    async stat(path) {
      const target = normalizePath(path);
      const code = `
import os
try:
    import json as _json
except ImportError:
    import ujson as _json
_p = ${pyStr(target)}
_d = {"exists": False, "dir": False, "size": 0, "mtime": 0}
try:
    _st = os.stat(_p)
    _d["exists"] = True
    _d["dir"] = (_st[0] & 0x4000) != 0
    _d["size"] = _st[6]
    if len(_st) > 8:
        _d["mtime"] = _st[8]
except Exception:
    pass
print(_json.dumps(_d))
`;
      return this.repl.execJSON(code, { timeout: 10000 });
    }

    async exists(path) {
      try {
        const st = await this.stat(path);
        return !!st.exists;
      } catch (err) {
        return false;
      }
    }

    async mkdir(path) {
      const target = normalizePath(path);
      const code = `
import os
os.mkdir(${pyStr(target)})
print("ok")
`;
      await this.repl.exec(code, { timeout: 10000 });
      return target;
    }

    async rmdir(path) {
      const target = normalizePath(path);
      const code = `
import os
os.rmdir(${pyStr(target)})
print("ok")
`;
      await this.repl.exec(code, { timeout: 10000 });
      return target;
    }

    async unlink(path) {
      const target = normalizePath(path);
      const code = `
import os
os.remove(${pyStr(target)})
print("ok")
`;
      await this.repl.exec(code, { timeout: 15000 });
      return target;
    }

    async rename(from, to) {
      const code = `
import os
os.rename(${pyStr(normalizePath(from))}, ${pyStr(normalizePath(to))})
print("ok")
`;
      await this.repl.exec(code, { timeout: 15000 });
      return normalizePath(to);
    }

    /** 递归删除文件或目录 */
    async removeRecursive(path, options) {
      const opts = options || {};
      const target = normalizePath(path);
      if (target === '/') throw new Error('不能删除根目录');

      throwIfAborted(opts.signal);

      const st = await this.stat(target);
      if (!st.exists) return false;

      if (st.dir) {
        const entries = await this.ls(target);
        for (const entry of entries) {
          throwIfAborted(opts.signal);
          if (opts.onProgress) opts.onProgress(entry.name);
          await this.removeRecursive(joinPath(target, entry.name), opts);
        }
        await this.rmdir(target);
      } else {
        await this.unlink(target);
      }
      return true;
    }

    /** 递归列出目录下所有文件 */
    async walkFiles(path, basePath, out) {
      const target = normalizePath(path);
      const base = basePath === undefined ? target : basePath;
      const result = out || [];
      const st = await this.stat(target);

      if (!st.exists) return result;

      if (st.dir) {
        const entries = await this.ls(target);
        for (const entry of entries) {
          await this.walkFiles(joinPath(target, entry.name), base, result);
        }
      } else {
        result.push({
          path: target,
          relative: target === base ? baseName(target) : target.slice(base.length + 1),
          size: st.size,
        });
      }
      return result;
    }

    /* ---------- 文件读写 ---------- */

    /** 创建一个空文件（覆盖已存在的） */
    async createFile(path) {
      const target = normalizePath(path);
      const code = `
open(${pyStr(target)}, "wb").close()
print("ok")
`;
      await this.repl.exec(code, { timeout: 10000 });
      return target;
    }

    /** 读取一个分块，返回 base64 文本 */
    async readChunk(path, offset, size) {
      const target = normalizePath(path);
      const code = `
try:
    import ubinascii as _b
except ImportError:
    import binascii as _b
_f = open(${pyStr(target)}, "rb")
_f.seek(${offset})
_d = _f.read(${size})
_f.close()
print(_b.b2a_base64(_d).decode().strip() if _d else "")
`;
      const res = await this.repl.exec(code, { timeout: 20000 });
      return res.out.trim();
    }

    /** 写入一个分块（base64 文本） */
    async writeChunk(path, base64, mode) {
      const target = normalizePath(path);
      const code = `
try:
    import ubinascii as _b
except ImportError:
    import binascii as _b
_f = open(${pyStr(target)}, "${mode === 'wb' ? 'wb' : 'ab'}")
_f.write(_b.a2b_base64("${base64}"))
_f.close()
print("ok")
`;
      await this.repl.exec(code, { timeout: 25000 });
      return true;
    }

    /** 读取完整文件 */
    async readFile(path, options) {
      const opts = options || {};
      const chunkSize = opts.chunkSize || READ_CHUNK;
      const st = await this.stat(path);
      if (!st.exists) throw new Error('文件不存在：' + normalizePath(path));
      if (st.dir) throw new Error('这是一个文件夹，无法作为文件读取');

      const total = st.size || 0;
      const parts = [];
      let offset = 0;
      let guard = 0;

      while (guard++ < 65536) {
        throwIfAborted(opts.signal);
        if (total > 0 && offset >= total) break;

        const want = total > 0 ? Math.min(chunkSize, total - offset) : chunkSize;
        const b64 = await this.readChunk(path, offset, want);
        const bytes = base64ToBytes(b64);
        if (!bytes.length) break;

        parts.push(bytes);
        offset += bytes.length;
        if (opts.onProgress) opts.onProgress(offset, total);
      }

      return concatBytes(parts, total > 0 ? Math.min(offset, total) : offset);
    }

    /** 写入完整文件：先截断，再分块追加 */
    async writeFile(path, data, options) {
      const opts = options || {};
      const chunkSize = opts.chunkSize || WRITE_CHUNK;
      const target = normalizePath(path);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const total = bytes.length;

      throwIfAborted(opts.signal);

      // 先创建/清空文件
      await this.createFile(target);

      if (total === 0) {
        if (opts.onProgress) opts.onProgress(0, 0);
        return target;
      }

      let offset = 0;
      while (offset < total) {
        if (opts.signal && opts.signal.aborted) {
          await this.unlink(target).catch(() => {});
          throw abortError();
        }

        const size = Math.min(chunkSize, total - offset);
        const base64 = bytesToBase64(bytes.subarray(offset, offset + size));
        await this.writeChunk(target, base64, 'ab');
        offset += size;

        if (opts.onProgress) opts.onProgress(offset, total);
      }

      return target;
    }

    /** 重命名后校验 */
    async move(from, to) {
      return this.rename(from, to);
    }
  }

  global.DeviceFS = DeviceFS;
  global.fsUtil = {
    pyStr,
    joinPath,
    normalizePath,
    parentPath,
    baseName,
    extName,
    validateName,
    concatBytes,
    bytesToBase64,
    base64ToBytes,
  };
})(window);
