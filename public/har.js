'use strict';

// 本地 HAR 导入：解析、过滤、排序与时间线计算（前端与 Node 测试共用的 UMD 模块）。
//
// 口径说明：
//  - 只读取 log.entries；每条可导入记录必须同时满足：
//      1) request.url 是可解析的 http(s) URL；
//      2) request.method 是编辑器支持的方法（GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS/TRACE）；
//      3) startedDateTime 是【带时区】的有效 ISO 8601 时间（Z 或 ±HH:MM 等偏移）；
//      4) time 是非负有限数（毫秒）。
//    不满足的条目记入 skipped（带原因），不参与勾选；
//  - Set-Cookie 取自 response.headers：按数组原顺序收集全部同名头值，
//    头名不区分大小写，【不按逗号拆分】（Expires 中含逗号，拆分会产生非法行）；
//  - 勾选序列按开始时间升序排列，同刻保留原 HAR 行序（稳定排序）；
//  - 经过秒数 = 相邻两条【被勾选】记录的开始时间差（精确到毫秒），首条为 0；
//  - 重叠：前一条响应结束（开始 + time）晚于下一条请求开始，标出两行并阻止载入；
//  - 顶层页面 URL 与顶层导航标记不从 HAR 推断，由预览中逐条确认（默认空 / 非导航）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HarImport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  // 与编辑器一致的方法集合
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];
  const MAX_IMPORT = 100;

  // 带时区的 ISO 8601：日期 + T + 时:分（秒与毫秒可选）+ Z 或 ±HH[:MM] 偏移
  const ISO_WITH_TZ =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

  /**
   * 解析 startedDateTime：必须是带时区的有效 ISO 时间。
   * @returns {number|null} epoch 毫秒；不带时区或无法解析时返回 null
   */
  function parseStartedDateTime(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!ISO_WITH_TZ.test(text)) return null; // 不带时区（或格式不符）一律拒绝
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }

  /** request.url 是否为可解析的 http(s) URL。 */
  function isHttpUrl(raw) {
    if (typeof raw !== 'string') return false;
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return false;
    }
    return u.protocol === 'http:' || u.protocol === 'https:';
  }

  /**
   * 按 response.headers 原顺序取全部 Set-Cookie 值：
   * 头名不区分大小写，值原样保留（不按逗号拆分）。
   */
  function extractSetCookies(response) {
    const headers = response && Array.isArray(response.headers) ? response.headers : [];
    const out = [];
    for (const h of headers) {
      if (!h || typeof h.name !== 'string') continue;
      if (h.name.trim().toLowerCase() !== 'set-cookie') continue;
      if (typeof h.value !== 'string') continue;
      const line = h.value.trim();
      if (line) out.push(line);
    }
    return out;
  }

  /**
   * 分析单条 log.entries 记录。
   * @returns {{ok:true, entry:object} | {ok:false, reason:string}}
   */
  function analyzeEntry(raw, index) {
    const e = raw && typeof raw === 'object' ? raw : {};
    const request = e.request && typeof e.request === 'object' ? e.request : {};

    if (!isHttpUrl(request.url)) {
      return { ok: false, reason: '请求 URL 缺失、无法解析或不是 http(s)' };
    }
    const method = String(request.method || '').toUpperCase();
    if (!METHODS.includes(method)) {
      return { ok: false, reason: '方法不受支持（' + (request.method || '缺失') + '）' };
    }
    const startMs = parseStartedDateTime(e.startedDateTime);
    if (startMs === null) {
      return { ok: false, reason: 'startedDateTime 缺失、无效或不带时区' };
    }
    const timeMs = e.time;
    if (typeof timeMs !== 'number' || !Number.isFinite(timeMs) || timeMs < 0) {
      return { ok: false, reason: 'time 缺失、非有限数或为负数' };
    }

    return {
      ok: true,
      entry: {
        id: index, // 原 log.entries 下标（同刻排序时保留原行序，也作预览行标识）
        method,
        url: String(request.url).trim(),
        startMs,
        timeMs,
        endMs: startMs + timeMs, // 响应结束时刻（重叠检测用）
        setCookies: extractSetCookies(e.response)
      }
    };
  }

  /**
   * 解析 HAR 文本（或已解析的对象），返回可导入条目与被跳过条目。
   * @returns {{ok:true, entries:Array, skipped:Array} | {ok:false, error:string}}
   */
  function parseHar(input) {
    let har = input;
    if (typeof input === 'string') {
      try {
        har = JSON.parse(input);
      } catch {
        return { ok: false, error: '文件不是有效的 JSON' };
      }
    }
    const entries = har && har.log && har.log.entries;
    if (!Array.isArray(entries)) {
      return { ok: false, error: '文件缺少 log.entries 数组，不是有效的 HAR' };
    }
    const accepted = [];
    const skipped = [];
    entries.forEach((raw, i) => {
      const r = analyzeEntry(raw, i);
      if (r.ok) accepted.push(r.entry);
      else skipped.push({ index: i, reason: r.reason });
    });
    return { ok: true, entries: accepted, skipped };
  }

  /** 按开始时间升序；同刻保留原 HAR 行序（显式按下标兜底，保证稳定）。 */
  function sortByStart(entries) {
    return entries.slice().sort((a, b) => (a.startMs - b.startMs) || (a.id - b.id));
  }

  /**
   * 计算勾选序列（须已按开始时间排序）的经过秒数与重叠对。
   * 秒数 = 相邻勾选记录的开始时间差（毫秒精度），首条为 0；
   * 重叠 = 前一条响应结束晚于后一条请求开始。
   * @returns {{seconds:Array<number>, overlaps:Array<{first:number, second:number}>}}
   *   overlaps 的 first / second 为勾选序列中的相邻下标
   */
  function computeTimeline(sortedSelected) {
    const seconds = [];
    const overlaps = [];
    for (let i = 0; i < sortedSelected.length; i++) {
      if (i === 0) {
        seconds.push(0);
        continue;
      }
      const prev = sortedSelected[i - 1];
      const cur = sortedSelected[i];
      // 毫秒整数差换算成秒：精确到毫秒
      seconds.push((cur.startMs - prev.startMs) / 1000);
      if (prev.endMs > cur.startMs) overlaps.push({ first: i - 1, second: i });
    }
    return { seconds, overlaps };
  }

  return {
    METHODS,
    MAX_IMPORT,
    parseHar,
    analyzeEntry,
    extractSetCookies,
    parseStartedDateTime,
    isHttpUrl,
    sortByStart,
    computeTimeline
  };
});
