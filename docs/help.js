/* ============================================================
 * help.js — 使用说明页的“返回应用中心”
 *
 * 说明页通常由应用中心通过 window.open 打开。点击返回时优先
 * 关闭当前说明标签页，直接回到原来的应用中心，避免再打开一个
 * 应用中心页面；如果说明页是直接打开的（浏览器不允许关闭），
 * 则在当前标签页返回。
 * ============================================================ */
(function () {
  'use strict';

  document.addEventListener('click', function (event) {
    const link = event.target && event.target.closest
      ? event.target.closest('[data-back-apps]')
      : null;
    if (!link) return;

    // Ctrl/Cmd/Shift/中键保留用户主动新开标签页的行为
    if (event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();

    const href = link.getAttribute('href') || '../../index.html';
    const fromApp = !!(window.opener && !window.opener.closed);

    // 直接打开说明页：不尝试关闭，在当前标签页返回
    if (!fromApp) {
      window.location.href = href;
      return;
    }

    // 由应用中心打开：聚焦原页面并关闭说明页，避免多出一个应用中心标签页
    try { window.opener.focus(); } catch (err) { /* ignore */ }
    try { window.close(); } catch (err) { /* ignore */ }

    // 浏览器仍拒绝关闭时，在当前页返回
    window.setTimeout(function () {
      window.location.href = href;
    }, 120);
  });
})();
