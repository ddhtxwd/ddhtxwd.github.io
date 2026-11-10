/* ============================================================
 * zip.js — 轻量 ZIP 打包（store 模式，无外部依赖）
 *
 * 仅存储不压缩，兼容所有解压工具，支持 UTF-8 文件名。
 * ============================================================ */
(function (global) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const d = date || new Date();
    const year = Math.max(1980, d.getFullYear());
    return {
      time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
      date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
    };
  }

  /**
   * 生成 ZIP 文件。
   * @param {Array<{name: string, data: Uint8Array}>} entries
   * @returns {Uint8Array}
   */
  function createZip(entries, options) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length > 0xffff) throw new Error('文件数量超过 ZIP 上限（65535）');

    const encoder = new TextEncoder();
    const stamp = dosDateTime(options && options.date);
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const entry of list) {
      const name = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!name) continue;

      const nameBytes = encoder.encode(name);
      const data = entry.data instanceof Uint8Array
        ? entry.data
        : new Uint8Array(entry.data || []);
      const crc = crc32(data);

      // ---- 本地文件头 ----
      const header = new Uint8Array(30 + nameBytes.length);
      const hv = new DataView(header.buffer);
      hv.setUint32(0, 0x04034b50, true);
      hv.setUint16(4, 20, true);      // 解压所需版本
      hv.setUint16(6, 0x0800, true);  // 文件名使用 UTF-8
      hv.setUint16(8, 0, true);       // 存储模式
      hv.setUint16(10, stamp.time, true);
      hv.setUint16(12, stamp.date, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, data.length, true);
      hv.setUint32(22, data.length, true);
      hv.setUint16(26, nameBytes.length, true);
      hv.setUint16(28, 0, true);
      header.set(nameBytes, 30);

      localChunks.push(header, data);
      const localOffset = offset;
      offset += header.length + data.length;

      // ---- 中央目录项 ----
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);   // extra
      cv.setUint16(32, 0, true);   // comment
      cv.setUint16(34, 0, true);   // disk
      cv.setUint16(36, 0, true);   // internal attrs
      cv.setUint32(38, 0x20, true); // external attrs: archive
      cv.setUint32(42, localOffset, true);
      cd.set(nameBytes, 46);
      centralChunks.push(cd);
    }

    const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centralChunks.length, true);
    ev.setUint16(10, centralChunks.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of localChunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    for (const chunk of centralChunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    out.set(eocd, pos);
    return out;
  }

  global.createZip = createZip;
  global.crc32 = crc32;
})(window);
