'use strict';

const { parseUrl, siteKey, isSameSite } = require('./site');
const {
  CookieJar,
  parseSetCookie,
  selectForRequest
} = require('./cookies');

// 固定基准时钟，保证演示结果确定、可读
const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

/**
 * 顺序执行全部步骤。
 * @param {Array} steps 用户编辑的步骤
 * @param {{baseTime?:number}} [options] 可选：模拟起点（epoch 毫秒）。
 *   缺省用固定基准 BASE_TIME；HAR 导入时传入首条记录时间，
 *   使 Expires 按抓包绝对时间判定（最小复现 / 求解 / 影响对照沿用同一起点）。
 * @returns {{results:Array, finalJar:Array}}
 */
function runSimulation(steps, options) {
  const jar = new CookieJar();
  const results = [];
  const baseTime = options && Number.isFinite(options.baseTime) ? options.baseTime : BASE_TIME;
  let clock = baseTime;

  for (const step of steps || []) {
    const seconds = Math.max(0, Number(step.seconds) || 0);
    // 秒数精确到毫秒：取整累加，避免小数秒（如 1.15s）带来的浮点漂移
    clock += Math.round(seconds * 1000);

    const method = (step.method || 'GET').toUpperCase();
    const request = parseUrl(step.url);
    const topRaw = (step.topUrl || '').trim();
    const top = topRaw ? parseUrl(topRaw) : null;
    const navigation = step.isNavigation === true;

    const result = {
      seconds,
      clock,
      clockISO: new Date(clock).toISOString(),
      method,
      url: (step.url || '').trim(),
      topUrl: topRaw,
      isNavigation: navigation,
      warnings: []
    };

    if (!request) {
      result.warnings.push('请求 URL 非法或非 http(s) 协议，本步骤跳过（不发送请求、不应用 Set-Cookie）');
      result.request = null;
      result.requestSite = null;
      result.topSite = top ? siteKey(topRaw) : null;
      result.sameSite = null;
      result.crossSite = null;
      result.sent = [];
      result.unsent = [];
      result.cookieHeader = '';
      result.responses = [];
      result.events = [];
      result.jarAfter = jar.snapshot(clock);
      results.push(result);
      continue;
    }

    // 同站判断（协议 + 可注册域）；顶层 URL 缺省时按一方请求处理
    let sameSite = true;
    let crossSite = false;
    if (topRaw) {
      if (!top) {
        result.warnings.push('顶层页面 URL 非法，无法判定同站，已按跨站处理');
        sameSite = false;
      } else {
        const s = isSameSite(step.url, topRaw);
        sameSite = s;
      }
      crossSite = sameSite === false;
    }

    const reqInfo = { scheme: request.scheme, host: request.host, port: request.port, path: request.path };
    result.request = reqInfo;
    result.requestSite = siteKey(step.url);
    result.topSite = topRaw ? siteKey(topRaw) : result.requestSite;
    result.sameSite = sameSite;
    result.crossSite = crossSite;
    result.topLevelSafeNavigation = navigation && ['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method);

    // 1) 先判定本步要发送的 Cookie
    const decision = selectForRequest(
      jar,
      { scheme: request.scheme, host: request.host, path: request.path, method },
      { crossSite, sameSite, navigation },
      clock
    );
    result.sent = decision.sent;
    result.unsent = decision.unsent;
    result.cookieHeader = decision.cookieHeader;

    // 生命周期事件（严格按执行顺序）：先记录发送阶段发生的过期淘汰，
    // 再逐条记录 Set-Cookie 的写入 / 覆盖 / 删除。轨迹与现有结果共用同一引擎。
    // 每个事件都携带键标识（name/domain/path，domain 为带前导点的序列化形式），
    // 这样即使是空操作删除（无 before/after）也能归到正确轨迹。
    const identity = (c) => {
      const d = describeCookie(c);
      return { name: d.name, domain: d.domain, path: d.path };
    };
    const events = (decision.evicted || []).map((x) => ({
      type: 'evicted',
      step: results.length,
      clock,
      clockISO: new Date(clock).toISOString(),
      ...identity(x.cookie),
      raw: null,
      before: describeCookie(x.cookie),
      after: null,
      reasons: x.reasons.slice()
    }));

    // 2) 再应用响应中的 Set-Cookie 列表（逐条解析，顺序应用）
    const responses = [];
    for (const raw of step.setCookies || []) {
      const line = (typeof raw === 'string' ? raw : '').trim();
      if (!line) continue;
      const parsed = parseSetCookie(line, { scheme: request.scheme, host: request.host }, clock);
      const entry = { raw: line };

      if (!parsed.ok) {
        entry.status = 'rejected';
        entry.reason = parsed.reason;
        // 被拒写入不改变轨迹：不产生生命周期事件
      } else if (parsed.isDelete) {
        const previous = jar.remove(parsed.cookie.name, parsed.cookie.domain, parsed.cookie.path);
        entry.status = 'deleted';
        entry.existed = previous !== null;
        entry.cookie = describeCookie(parsed.cookie);
        // 未命中的删除显示为空操作：仍然产生一条删除事件，before 为空
        events.push({
          type: 'deleted',
          step: results.length,
          clock,
          clockISO: new Date(clock).toISOString(),
          ...identity(parsed.cookie),
          raw: line,
          before: previous ? describeCookie(previous) : null,
          after: null
        });
      } else {
        const putResult = jar.put(parsed.cookie); // { action, previous }
        entry.status = 'stored';
        entry.action = putResult.action; // stored | updated
        entry.cookie = describeCookie(parsed.cookie);
        // 覆盖沿用同一键并重算到期时间：after 中携带新的 expires
        events.push({
          type: putResult.action === 'updated' ? 'updated' : 'stored',
          step: results.length,
          clock,
          clockISO: new Date(clock).toISOString(),
          ...identity(parsed.cookie),
          raw: line,
          before: putResult.previous ? describeCookie(putResult.previous) : null,
          after: describeCookie(parsed.cookie)
        });
      }
      responses.push(entry);
    }
    result.responses = responses;
    result.events = events;
    result.jarAfter = jar.snapshot(clock);
    results.push(result);
  }

  return { results, finalJar: jar.snapshot(clock) };
}

function describeCookie(c) {
  return {
    name: c.name,
    value: c.value,
    domain: c.hostOnly ? c.domain : '.' + c.domain,
    hostOnly: c.hostOnly,
    path: c.path,
    secure: c.secure,
    sameSite: c.sameSite,
    persistent: c.persistent,
    expiresISO: c.expires ? new Date(c.expires).toISOString() : null
  };
}

module.exports = { runSimulation, BASE_TIME, METHODS };