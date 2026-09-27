'use strict';

// 本地 HAR 导入：解析 log.entries，逐条校验可导入性，按开始时间排序生成
// 步骤序列（UMD 模块，前端与 Node 测试共用，纯函数不改动任何编辑内容）。
//
// 口径说明：
//  - 仅接受编辑器支持的方法、带时区的有效 startedDateTime、非负有限 time
//    以及 http(s) 请求 URL；不满足的条目在预览中标出原因且不可勾选；
//  - 步骤顺序按 startedDateTime 升序，同刻保留原行序（稳定排序）；
//  - 经过秒数 = 相邻记录开始时间差（精确到毫秒），首条为 0；
//  - Set-Cookie 取自 response.headers 中全部名为 set-cookie 的头
//    （头名不区分大小写），保持原顺序、每条头一行，不按逗号拆分；
//  - 前一条响应结束（startedDateTime + time）晚于后一条请求开始即视为
//    时间重叠：标出两条记录并阻止载入；
//  - 顶层页面 URL 与顶层导航标记不从 HAR 推断，由预览中逐条确认。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HarImport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 一次最多勾选的记录数（与服务端步骤上限一致）
  const MAX_SELECTION = 100;

  // ISO 8601 且必须带时区（Z 或 ±hh:mm / ±hhmm）；不带时区的一律拒绝
  const STARTED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

  /** startedDateTime → epoch 毫秒；缺失、不带时区或日期无效时返回 null。 */
  function parseStartedDateTime(value) {
    if (typeof value !== 'string' || !STARTED_RE.test(value.trim())) return null;
    const ms = Date.parse(value.trim());
    return Number.isFinite(ms) ? ms : null;
  }

  /** 解析 HAR 文本，返回 { ok:true, entries } 或 { ok:false, error }。 */
  function parseHarText(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: '不是有效的 JSON 文件：' + err.message };
    }
    const entries = doc && doc.log && doc.log.entries;
    if (!Array.isArray(entries)) {
      return { ok: false, error: '文件缺少 log.entries 数组，不是有效的 HAR' };
    }
    return { ok: true, entries };
  }

  /**
   * 取 response.headers 中全部 Set-Cookie 值：头名不区分大小写，
   * 保持原顺序、每条头一行，不按逗号拆分（Expires 日期本身含逗号）。
   */
  function setCookiesOf(entry) {
    const headers = entry && entry.response && Array.isArray(entry.response.headers)
      ? entry.response.headers
      : [];
    const out = [];
    for (const h of headers) {
      if (!h || typeof h.name !== 'string') continue;
      if (h.name.trim().toLowerCase() !== 'set-cookie') continue;
      if (h.value == null) continue;
      out.push(String(h.value));
    }
    return out;
  }

  function isHttpUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return false;
    }
    return u.protocol === 'http:' || u.protocol === 'https:';
  }

  /**
   * 逐条评估 log.entries，标注可导入性与原因。
   * @param {Array} entries log.entries
   * @param {Array<string>} methods 编辑器支持的方法列表
   * @returns {Array} 每行 { index, url, method, startISO, startMs, timeMs, endMs,
   *   setCookies, problems, importable }
   */
  function assessEntries(entries, methods) {
    const allowed = new Set((methods || []).map((m) => String(m).toUpperCase()));
    return (entries || []).map((entry, index) => {
      const e = entry && typeof entry === 'object' ? entry : {};
      const request = e.request && typeof e.request === 'object' ? e.request : {};
      const url = typeof request.url === 'string' ? request.url.trim() : '';
      const method = String(request.method == null ? '' : request.method).trim().toUpperCase();
      const startISO = typeof e.startedDateTime === 'string' ? e.startedDateTime.trim() : '';
      const startMs = parseStartedDateTime(e.startedDateTime);
      const rawTime = e.time;
      const timeOk = typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime >= 0;

      const problems = [];
      if (!isHttpUrl(url)) problems.push('请求 URL 缺失或不是 http(s) 协议');
      if (!allowed.has(method)) {
        problems.push('方法 ' + (method || '(缺失)') + ' 不受支持（仅 ' + [...allowed].join('/') + '）');
      }
      if (startMs === null) problems.push('startedDateTime 缺失、无效或不带时区');
      if (!timeOk) problems.push('time 缺失、为负或不是有限数值');

      const timeMs = timeOk ? rawTime : null;
      return {
        index,
        url,
        method,
        startISO,
        startMs,
        timeMs,
        endMs: startMs !== null && timeMs !== null ? startMs + timeMs : null,
        setCookies: setCookiesOf(e),
        problems,
        importable: problems.length === 0
      };
    });
  }

  /**
   * 由勾选的记录生成导入计划：按开始时间排序（同刻保留原行序），
   * 相邻时间差生成秒数（毫秒精度，首条为 0），并检测相邻时间重叠。
   * @param {Array} rows assessEntries 输出中 importable 且被勾选的行
   * @returns {{count:number, items:Array<{row:object, seconds:number}>,
   *   baseTime:number|null, overlaps:Array<{a:object, b:object}>}}
   *   baseTime 为排序后首条记录的开始时间（epoch 毫秒），作为本次模拟起点。
   */
  function buildPlan(rows) {
    const sorted = (rows || []).slice().sort((a, b) =>
      a.startMs - b.startMs || a.index - b.index);
    const items = [];
    const overlaps = [];
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const seconds = i === 0 ? 0 : (row.startMs - sorted[i - 1].startMs) / 1000;
      // 前一响应结束晚于下一请求开始：标出两行（调用方据此阻止载入）
      if (i > 0 && row.startMs < sorted[i - 1].endMs) {
        overlaps.push({ a: sorted[i - 1], b: row });
      }
      items.push({ row, seconds });
    }
    return {
      count: items.length,
      items,
      baseTime: items.length ? items[0].row.startMs : null,
      overlaps
    };
  }

  return { MAX_SELECTION, parseHarText, assessEntries, buildPlan, setCookiesOf, parseStartedDateTime };
});
