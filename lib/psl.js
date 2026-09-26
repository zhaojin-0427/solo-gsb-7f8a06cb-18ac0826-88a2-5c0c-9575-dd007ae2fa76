'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { domainToASCII } = require('url');

/**
 * 公共后缀（Public Suffix）判断 —— 完整离线 Mozilla Public Suffix List。
 *
 * 规则数据随仓库内置（data/public_suffix_list.dat，含 ICANN 段与 PRIVATE
 * 段，因此 s3.amazonaws.com、github.io、*.compute.herokuapp.com 等私有后缀
 * 同样生效），运行时不访问网络。可用 `npm run update-psl` 重新拉取。
 *
 * 匹配严格按 https://publicsuffix.org/list/ 算法执行：
 *  1. 例外规则（"!" 开头）优先，命中后公共后缀取例外规则去掉首标签的部分；
 *  2. 否则取“最长匹配”：从最具体的候选（完整主机名）逐级向根方向比较，
 *     精确规则直接命中；通配规则 "*.<rule>" 要求候选比 rule 恰好多一层；
 *  3. 没有任何规则命中时，由隐式 "*" 兜底（单标签本身作为后缀）。
 * 可注册域 = 公共后缀再加其左侧一个标签。
 */

const DATA_FILE = path.join(__dirname, '..', 'data', 'public_suffix_list.dat');

/**
 * 将单条规则体统一为 ASCII（punycode）表示。
 * PSL 中的国际化域名规则以 Unicode 书写（如 公司.cn），而 URL 主机与
 * Cookie Domain 都按 ASCII 处理；加载时把精确、通配、例外三种形式的
 * 规则一并转换，保证两种写法都能命中同一条规则。无法转换时保留原值兜底。
 * @param {string} rule 已小写、已去掉 "!"/"*." 前缀的规则体
 * @returns {string}
 */
function ruleToASCII(rule) {
  if (/[^\x00-\x7f]/.test(rule)) {
    try {
      const ascii = domainToASCII(rule);
      if (ascii) return ascii.toLowerCase();
    } catch {
      // 保留原值，交由后续匹配兜底
    }
  }
  return rule;
}

/**
 * 解析 PSL 数据文件。
 * @param {string} text
 * @returns {{exact:Set<string>, wildcard:Set<string>, exceptions:Set<string>, privateExact:Set<string>, privateWildcard:Set<string>, privateExceptions:Set<string>, version:string|null}}
 *   wildcard 集合保存去掉 "*." 后的规则体（如规则 "*.ck" 存 "ck"）；
 *   exceptions 集合保存去掉 "!" 后的规则体（如 "!www.ck" 存 "www.ck"）。
 *   所有规则体统一为 ASCII（punycode）表示。
 */
function parsePsl(text) {
  const rules = {
    exact: new Set(),
    wildcard: new Set(),
    exceptions: new Set(),
    privateExact: new Set(),
    privateWildcard: new Set(),
    privateExceptions: new Set(),
    version: null
  };
  let section = 'icann';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) {
      if (line.includes('===BEGIN PRIVATE DOMAINS===')) section = 'private';
      else if (line.includes('===BEGIN ICANN DOMAINS===')) section = 'icann';
      const v = line.match(/^\/\/\s*VERSION:\s*(\S+)/);
      if (v) rules.version = v[1];
      continue;
    }
    const rule = line.toLowerCase();
    if (rule.startsWith('!')) {
      (section === 'private' ? rules.privateExceptions : rules.exceptions).add(ruleToASCII(rule.slice(1)));
    } else if (rule.startsWith('*.')) {
      (section === 'private' ? rules.privateWildcard : rules.wildcard).add(ruleToASCII(rule.slice(2)));
    } else {
      (section === 'private' ? rules.privateExact : rules.exact).add(ruleToASCII(rule));
    }
  }
  return rules;
}

const RULES = parsePsl(fs.readFileSync(DATA_FILE, 'utf8'));

// RFC 6761 保留的单标签名：本地开发与特殊用途主机，不按公共后缀处理。
// （localhost 在真实 PSL 中是 ICANN 后缀，这里为本地开发保留既有行为。）
const SPECIAL_USE_SINGLE_LABELS = new Set(['localhost', 'local', 'test', 'example', 'invalid']);

/**
 * 判断主机名是否为 IP 地址（IPv4 / IPv6）。
 * URL 解析出的 IPv6 主机名带方括号（如 "[::1]"），这里一并识别。
 * @param {string} host
 * @returns {boolean}
 */
function isIpAddress(host) {
  if (!host) return false;
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return net.isIP(h) !== 0;
}

/** 主机名规范化：小写、去尾部点、IDN 转 punycode（ASCII）。 */
function normalizeHostname(hostname) {
  let h = String(hostname).trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (/[^\x00-\x7f]/.test(h)) {
    try {
      const ascii = domainToASCII(h);
      if (ascii) h = ascii;
    } catch {
      // 保留原值，交由后续规则失配兜底
    }
  }
  return h;
}

/**
 * 按官方算法在 ICANN + PRIVATE 合并后的规则集合上匹配。
 * 例外规则整轮优先；否则从最具体候选逐级向根，精确规则先于通配规则。
 * 同时记录胜出规则属于哪个段（用于 privateSuffix 标记）。
 * @param {string[]} labels 主机名标签（全小写 ASCII）
 * @returns {{suffix:string|null, registrable:string|null, privateMatch:boolean, matched:boolean}}
 */
function matchRules(labels) {
  const result = { suffix: null, registrable: null, privateMatch: false, matched: false };

  // 1) 例外规则优先（如 !www.ck、!city.kobe.jp）：
  //    命中后公共后缀 = 例外规则去掉最左标签，可注册域 = 例外规则本身那一层
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    const isPrivate = RULES.privateExceptions.has(candidate);
    if (isPrivate || RULES.exceptions.has(candidate)) {
      result.matched = true;
      result.privateMatch = isPrivate;
      result.suffix = labels.slice(i + 1).join('.');
      break;
    }
  }

  // 2) 最长匹配：从最具体候选逐级向根；同层级精确规则先于通配规则
  if (!result.matched) {
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      const parent = labels.slice(i + 1).join('.');

      if (RULES.privateExact.has(candidate) || RULES.exact.has(candidate)) {
        result.matched = true;
        result.privateMatch = RULES.privateExact.has(candidate);
        result.suffix = candidate;
        break;
      }
      // 通配规则 "*.x.y"：候选必须形如 "<label>.x.y"
      if (parent) {
        if (RULES.privateWildcard.has(parent) || RULES.wildcard.has(parent)) {
          result.matched = true;
          result.privateMatch = RULES.privateWildcard.has(parent);
          result.suffix = candidate;
          break;
        }
      }
    }
  }

  if (result.matched) {
    const suffixLabels = result.suffix === '' ? 0 : result.suffix.split('.').length;
    if (labels.length > suffixLabels) {
      result.registrable = labels.slice(labels.length - suffixLabels - 1).join('.');
    }
  }
  return result;
}

/**
 * 返回域名的后缀信息。
 * @param {string} hostname 小写、无端口的主机名
 * @returns {{ip:boolean, labels:string[], suffix:string|null, registrable:string|null, privateSuffix:boolean}}
 *   suffix         公共后缀（小写），无匹配时为 null
 *   registrable    可注册域（eTLD+1）；IP、公共后缀本身或无法确定时为 null
 *   privateSuffix  命中的是否为 PRIVATE DOMAINS 段（私有后缀）
 */
function analyzeDomain(hostname) {
  const result = { ip: false, labels: [], suffix: null, registrable: null, privateSuffix: false };
  if (!hostname) return result;

  if (isIpAddress(hostname)) {
    result.ip = true;
    result.labels = [hostname.toLowerCase()];
    return result;
  }

  const host = normalizeHostname(hostname);
  const labels = host.split('.').filter((l) => l.length > 0);
  result.labels = labels;
  if (labels.length === 0) return result;

  // 单标签主机名：保留既有教学行为 —— localhost 等特殊用途名及未知内网名
  // （如 intranet）不视为公共后缀；PSL 中实际列出的 TLD（如 com、cn、onion）
  // 仍是公共后缀。
  if (labels.length === 1) {
    const label = labels[0];
    if (!SPECIAL_USE_SINGLE_LABELS.has(label) &&
        (RULES.exact.has(label) || RULES.privateExact.has(label))) {
      result.suffix = label;
    }
    return result;
  }

  // 在 ICANN + PRIVATE 合并规则上按官方优先级匹配（例外优先、最长匹配、
  // 私有后缀命中时打标记）。
  const m = matchRules(labels);
  if (m.matched) {
    result.suffix = m.suffix;
    result.registrable = m.registrable;
    result.privateSuffix = m.privateMatch;
    return result;
  }

  // 隐式 "*" 兜底：任何规则都未命中时，最后一个标签作为公共后缀。
  // （多标签主机此时 eTLD+1 为末两标签；单标签已在前面处理。）
  result.suffix = labels[labels.length - 1];
  if (labels.length > 1) {
    result.registrable = labels.slice(-2).join('.');
  }
  return result;
}

/** 是否为公共后缀（精确本身，如 com、co.uk、s3.amazonaws.com）。 */
function isPublicSuffix(hostname) {
  if (!hostname) return false;
  if (isIpAddress(hostname)) return false;
  const host = normalizeHostname(hostname);
  const info = analyzeDomain(host);
  return info.suffix === host;
}

module.exports = {
  analyzeDomain,
  isPublicSuffix,
  isIpAddress,
  normalizeHostname,
  parsePsl,
  PSL_VERSION: RULES.version
};
