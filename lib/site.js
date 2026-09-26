'use strict';

const { analyzeDomain, isIpAddress, normalizeHostname } = require('./psl');

/**
 * 解析一个绝对 URL，返回小写化的协议、主机（无端口）、端口与路径。
 * 主机统一为 ASCII（punycode）表示：国际化域名（如 公司.cn）与
 * punycode 写法（xn--55qx5d.cn）得到同一个 host，可注册域与同站
 * 计算均基于该表示。与 Cookie 模型一致：same-site 判断忽略端口。
 * @returns {{scheme:string, host:string, port:string, path:string}|null}
 */
function parseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname || '/';
  return {
    scheme: u.protocol === 'https:' ? 'https' : 'http',
    host: normalizeHostname(u.hostname),
    port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    path: path.length ? path : '/'
  };
}

/**
 * 计算“站”（schemeful site）键。
 *  - https://www.example.com/a  -> https://example.com
 *  - http://a.b.co.uk          -> http://b.co.uk
 *  - http://192.168.0.1:8080   -> http://192.168.0.1（IP 整体作为站，忽略端口）
 *  - http://localhost          -> http://localhost（单标签主机整体作为站）
 * @param {string} rawUrl
 * @returns {string|null}
 */
function siteKey(rawUrl) {
  const p = parseUrl(rawUrl);
  if (!p) return null;
  if (isIpAddress(p.host) || p.host.split('.').length === 1) {
    return `${p.scheme}://${p.host}`;
  }
  const info = analyzeDomain(p.host);
  if (info.registrable) {
    return `${p.scheme}://${info.registrable}`;
  }
  return `${p.scheme}://${p.host}`;
}

/**
 * 判断两个 URL 是否同站（协议相同 + 可注册域相同；IP/单标签则主机完全相同）。
 * 任一 URL 非法时返回 null（无法判断）。
 * @returns {boolean|null}
 */
function isSameSite(urlA, urlB) {
  const a = siteKey(urlA);
  const b = siteKey(urlB);
  if (!a || !b) return null;
  return a === b;
}

module.exports = { parseUrl, siteKey, isSameSite };
