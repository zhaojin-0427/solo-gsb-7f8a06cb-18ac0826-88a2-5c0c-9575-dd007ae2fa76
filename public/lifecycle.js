'use strict';

// 生命周期轨迹工具：键归一与轨迹过滤（前端与 Node 测试共用的 UMD 模块）。
//
// 轨迹键 = 名称（小写） + 规范化域（去掉序列化时的前导点） + 路径。
// 与 Jar 内部键（lib/cookies.js 的 CookieJar.keyOf）采用完全相同的拼接公式，
// 仅在域上去掉前导点（序列化描述里 Domain Cookie 带点，内部存储不带点）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Lifecycle = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function normalizeDomain(domain) {
    return String(domain == null ? '' : domain).replace(/^\./, '');
  }

  // 与 CookieJar.keyOf 同构：`${name.toLowerCase()} ${domain} ${path}`
  function keyOf(name, domain, path) {
    return String(name).toLowerCase() + ' ' + normalizeDomain(domain) + ' ' + String(path);
  }

  function eventKey(ev) {
    // 键标识直接挂在事件上（空操作删除没有 before/after）；兜底再取描述对象
    if (ev && ev.name != null) return keyOf(ev.name, ev.domain, ev.path);
    const c = ev.after || ev.before;
    return keyOf(c.name, c.domain, c.path);
  }

  /**
   * 从逐步结果中截取截至 targetStep（含）同键的生命周期事件，保持执行顺序。
   * @param {Array} results runSimulation 返回的 results
   * @param {{name:string, domain:string, path:string}} target 任一可选项的描述
   * @param {number} targetStep 选中项所在步（0 基）
   * @returns {Array} 事件数组（每项附带 step/clock/clockISO）
   */
  function traceOf(results, target, targetStep) {
    const key = keyOf(target.name, target.domain, target.path);
    const out = [];
    for (let i = 0; i <= targetStep; i++) {
      const r = results[i];
      if (!r || !Array.isArray(r.events)) continue;
      for (const ev of r.events) {
        if (eventKey(ev) === key) out.push(ev);
      }
    }
    return out;
  }

  /** 某事件是否为“删除未命中”的空操作。 */
  function isDeleteMiss(ev) {
    return ev.type === 'deleted' && !ev.before;
  }

  /** 事件之后该键是否在 Jar 中存活。 */
  function isAliveAfter(ev) {
    return (ev.type === 'stored' || ev.type === 'updated');
  }

  return { keyOf, eventKey, traceOf, isDeleteMiss, isAliveAfter };
});
