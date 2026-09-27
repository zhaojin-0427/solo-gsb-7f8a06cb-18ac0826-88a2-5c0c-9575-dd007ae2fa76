'use strict';

const { runSimulation } = require('./simulate');
const { parseSetCookie } = require('./cookies');
const { normalizeStep } = require('./minimize');

/**
 * 策略求解（solve）：针对一条成功写入（新写入 / 覆盖更新）的 Set-Cookie，
 * 枚举 Domain / Path / Secure / SameSite 的候选组合，找出能让各标记步
 * （写入步之后的有效请求，至多 8 个）发送状态全部符合预期的首解。
 *
 * 保持不变：步骤、名称、值、有效期（Max-Age / Expires）与其他属性
 * （HttpOnly 及未知属性按原文保留）。
 *
 * 候选空间：
 *  - Domain：host-only，以及来源主机与其合法父域的 Domain 形式（从窄到宽）；
 *  - Path：/、原路径、各标记请求路径的逐级前缀（/a/b/c → /a、/a/b、/a/b/c）；
 *  - SameSite：Strict / Lax / None；Secure：有 / 无。
 * 每个候选都先通过现有的写入校验（Domain 匹配、公共后缀、
 * SameSite=None 必须 Secure 等），再替换进原响应行重跑完整序列，
 * 按候选的名称、值、域、路径核对各标记步的实际发送状态。
 *
 * 多解时按 host-only → Domain 从窄到宽 → Path 从长到短（同长按字典序）→
 * SameSite Strict/Lax/None → Secure 有/无 的顺序取首解。
 */

const MAX_MARKS = 8;
const SAMESITE_ORDER = ['Strict', 'Lax', 'None'];
const SECURE_ORDER = [true, false]; // 有 / 无

/** 去掉 Domain/Path/Secure/SameSite，保留 名称=值 与其余属性原文。 */
function splitPreserved(raw) {
  const segments = String(raw).split(';');
  const first = (segments.shift() || '').trim();
  const kept = [];
  for (const seg of segments) {
    const idx = seg.indexOf('=');
    const attr = (idx === -1 ? seg : seg.slice(0, idx)).trim().toLowerCase();
    if (attr === 'domain' || attr === 'path' || attr === 'secure' || attr === 'samesite') continue;
    const t = seg.trim();
    if (t) kept.push(t);
  }
  return { first, kept };
}

/** 由保留段与候选四属性拼出完整 Set-Cookie 行。 */
function buildLine(preserved, cand) {
  const parts = [preserved.first, ...preserved.kept];
  if (!cand.hostOnly) parts.push('Domain=' + cand.domain);
  parts.push('Path=' + cand.path);
  if (cand.secure) parts.push('Secure');
  parts.push('SameSite=' + cand.sameSite);
  return parts.join('; ');
}

/** Domain 候选：host-only 优先，其后 Domain 形式按从窄到宽（主机本身 → 逐级父域）。 */
function domainCandidates(host) {
  const out = [{ hostOnly: true, domain: host }];
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    out.push({ hostOnly: false, domain: labels.slice(i).join('.') });
  }
  return out;
}

/** Path 候选：/、原路径与各标记请求路径的逐级前缀；从长到短，同长按字典序。 */
function pathCandidates(originalPath, requestPaths) {
  const set = new Set(['/', originalPath]);
  for (const p of requestPaths) {
    let cur = '';
    for (const seg of String(p).split('/')) {
      if (!seg) continue;
      cur += '/' + seg;
      set.add(cur);
    }
  }
  return [...set].sort((a, b) =>
    b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** 候选在模拟结果中的标识：名称 + 值 + 序列化域（Domain 形式带前导点）+ 路径。 */
function identityOf(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? cookie.domain : '.' + cookie.domain,
    path: cookie.path
  };
}

function sameIdentity(c, id) {
  return c.name === id.name && c.value === id.value &&
    c.domain === id.domain && c.path === id.path;
}

/** 某一步在候选运行中的实际发送状态（未发送时带上命中的全部原因，若有）。 */
function observe(result, id) {
  const hit = (result.sent || []).some((c) => sameIdentity(c, id));
  if (hit) return { sent: true, reasons: [] };
  const miss = (result.unsent || []).find((u) => u.cookie && sameIdentity(u.cookie, id));
  return { sent: false, reasons: miss ? miss.reasons.slice() : [] };
}

/**
 * @param {Array} rawSteps 当前编辑的完整步骤
 * @param {object} target { stepIndex, respIndex, raw?, marks: [{stepIndex, sent}] }
 * @param {{baseTime?: number}} [options] 模拟起点（与 /api/simulate 保持同一时钟基准）
 * @returns 首解（含可复制的 Set-Cookie 与逐步核对）或失败原因；
 *   返回 { ok:false, invalid:true } 表示目标/标记本身无效（类比最小复现的无法定位），
 *   返回 { ok:false } 表示候选空间内确实无解。
 */
function solveStrategy(rawSteps, target, options) {
  const fail = (error) => ({ ok: false, invalid: true, error });
  if (!target || typeof target !== 'object') return fail('缺少目标（target）');

  const steps = (rawSteps || []).map(normalizeStep);
  const stepIndex = target.stepIndex;
  const respIndex = target.respIndex;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
    return fail(`目标步下标无效（${stepIndex}），当前共 ${steps.length} 步`);
  }
  if (!Number.isInteger(respIndex) || respIndex < 0) {
    return fail(`目标 Set-Cookie 下标无效（${respIndex}）`);
  }

  // --- 定位目标：必须是成功写入（新写入 / 覆盖更新）的 Set-Cookie ---
  const original = runSimulation(steps, options).results;
  const writeResult = original[stepIndex];
  const resp = writeResult && writeResult.responses && writeResult.responses[respIndex];
  if (!resp) {
    return fail(`在第 ${stepIndex + 1} 步的响应中找不到第 ${respIndex + 1} 条 Set-Cookie。` +
      '步骤可能已被修改，请重新运行模拟后再选择目标。');
  }
  if (resp.status !== 'stored' && resp.status !== 'updated') {
    return fail('只能对成功写入（新写入 / 覆盖更新）的 Set-Cookie 求解；' +
      '删除项与被拒写入的条目不可作为目标。');
  }
  if (typeof target.raw === 'string' && target.raw.trim() !== resp.raw) {
    return fail('目标 Set-Cookie 与当前步骤不一致，步骤可能已被修改，请重新运行模拟后再选择目标。');
  }
  if (!writeResult.request) {
    return fail('目标步不是有效请求，无法求解。');
  }

  // --- 标记校验：写入步之后的有效请求，至多 8 个，不可重复 ---
  const marks = Array.isArray(target.marks) ? target.marks : null;
  if (!marks || marks.length === 0) return fail('至少需要 1 个标记（应发送 / 不应发送）');
  if (marks.length > MAX_MARKS) return fail(`最多标记 ${MAX_MARKS} 个请求`);
  const seen = new Set();
  const normMarks = [];
  for (const m of marks) {
    if (!m || typeof m !== 'object' || !Number.isInteger(m.stepIndex) || typeof m.sent !== 'boolean') {
      return fail('标记格式不正确（每项需要 stepIndex 与 sent）');
    }
    if (m.stepIndex <= stepIndex) {
      return fail(`只能标记写入步之后的请求（第 ${m.stepIndex + 1} 步不晚于第 ${stepIndex + 1} 步）`);
    }
    if (m.stepIndex >= steps.length) {
      return fail(`标记步下标越界（${m.stepIndex}），当前共 ${steps.length} 步`);
    }
    if (seen.has(m.stepIndex)) return fail(`第 ${m.stepIndex + 1} 步被重复标记`);
    seen.add(m.stepIndex);
    if (!original[m.stepIndex].request) {
      return fail(`第 ${m.stepIndex + 1} 步不是有效请求（URL 非法被跳过），无法标记`);
    }
    normMarks.push({ stepIndex: m.stepIndex, sent: m.sent });
  }
  normMarks.sort((a, b) => a.stepIndex - b.stepIndex);

  // --- 候选空间 ---
  const context = { scheme: writeResult.request.scheme, host: writeResult.request.host };
  const now = writeResult.clock;
  const preserved = splitPreserved(resp.raw);
  const domains = domainCandidates(context.host);
  const paths = pathCandidates(resp.cookie.path,
    normMarks.map((m) => original[m.stepIndex].request.path));

  // --- 枚举：Domain → Path → SameSite → Secure，首个全部满足的候选即首解 ---
  let attempts = 0;
  for (const d of domains) {
    for (const p of paths) {
      for (const sameSite of SAMESITE_ORDER) {
        for (const secure of SECURE_ORDER) {
          const cand = { hostOnly: d.hostOnly, domain: d.domain, path: p, sameSite, secure };
          const line = buildLine(preserved, cand);
          // 候选须通过现有写入校验（公共后缀、None 必须 Secure 等在此排除）
          const parsed = parseSetCookie(line, context, now);
          if (!parsed.ok) continue;
          attempts++;

          // 替换到原响应并重跑完整序列
          const modified = steps.map((s, i) => (i !== stepIndex ? s : {
            ...s,
            setCookies: s.setCookies.map((l, j) => (j === respIndex ? line : l))
          }));
          const results = runSimulation(modified, options).results;
          const id = identityOf(parsed.cookie);
          const checks = normMarks.map((m) => {
            const r = results[m.stepIndex];
            const obs = observe(r, id);
            return {
              stepIndex: m.stepIndex,
              method: r.method,
              url: r.url,
              clockISO: r.clockISO,
              expected: m.sent,
              actual: obs.sent,
              reasons: obs.reasons,
              ok: obs.sent === m.sent
            };
          });
          if (checks.every((c) => c.ok)) {
            return {
              ok: true,
              setCookie: line,
              original: resp.raw,
              writeStep: stepIndex,
              name: parsed.cookie.name,
              value: parsed.cookie.value,
              attributes: {
                hostOnly: parsed.cookie.hostOnly,
                domain: id.domain,
                path: parsed.cookie.path,
                secure: parsed.cookie.secure,
                sameSite: parsed.cookie.sameSite
              },
              marks: normMarks,
              checks,
              attempts
            };
          }
        }
      }
    }
  }

  return {
    ok: false,
    error: `在全部候选组合中没有找到满足 ${normMarks.length} 个标记的属性组合` +
      `（共重跑核对 ${attempts} 个通过写入校验的候选）`,
    attempts
  };
}

module.exports = { solveStrategy, MAX_MARKS };
