'use strict';

// 步骤变更影响（impact）：一次模拟完成后，冻结步骤与结果作为基线；
// 在副本中只修改指定一步的 请求 URL / 方法 / 顶层页面 URL / 顶层导航标记 /
// Set-Cookie 行，其余步骤、顺序与秒数保持不变，重跑副本后按步号逐项对照。
//
// 对照严格按执行顺序（发送 → 响应 → 步末）：
//  - 发送阶段：先核对请求是否被跳过；已发送项按 Cookie 头顺序逐项比较
//    名称（区分大小写）、值与 Jar 键；未发送项按 Jar 键对齐（名称忽略大小写、
//    域、路径），比较值、属性与原因集合；
//  - 响应阶段：按非空 Set-Cookie 行序号比较处理状态、拒写原因与解析出的 Cookie
//    （被跳过的步骤不处理 Set-Cookie：每行记为“已跳过”）；
//  - 步末：按同一 Jar 键比较存活项的值与属性（不含创建次序）。
//
// 同一步先发送后应用响应：本步响应只能影响后续请求，因此变更步之前的差异
// 必为空，首个差异最早出现在变更步的发送阶段。
//
// 本模块只读输入做演算，不改动任何步骤；前端渲染与 Node 测试共用。

const { runSimulation } = require('./simulate');
const { CookieJar } = require('./cookies');
const { normalizeStep } = require('./minimize');

const CHANGE_FIELDS = ['url', 'method', 'topUrl', 'isNavigation', 'setCookies'];

// 存活 Cookie 的值与属性比较字段（creationOrder 是引擎内部创建次序，不参与对照）
const COOKIE_FIELDS = [
  'value', 'hostOnly', 'domain', 'path',
  'secure', 'sameSite', 'persistent', 'expiresISO'
];

function cloneSteps(steps) {
  return steps.map((s) => ({ ...s, setCookies: [...s.setCookies] }));
}

/** Jar 键：与 CookieJar.keyOf 同构（名称小写；序列化域去掉前导点）。 */
function jarKeyOf(name, serializedDomain, path) {
  return CookieJar.keyOf(name, String(serializedDomain).replace(/^\./, ''), path);
}

function keyOfCookie(c) {
  return c ? jarKeyOf(c.name, c.domain, c.path) : null;
}

/** 原因集合对照：与顺序无关。 */
function sameReasonSet(a, b) {
  const x = [...(a || [])].sort();
  const y = [...(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 比较两个序列化 Cookie 描述的值与属性，返回命中的差异字段。 */
function cookieDiffs(b, c, fields) {
  const out = [];
  for (const f of fields) {
    if ((b ? b[f] : undefined) !== (c ? c[f] : undefined)) out.push(f);
  }
  return out;
}

// ---------- 发送阶段 ----------

/** 已发送项：按 Cookie 头顺序（数组下标）逐项比较名称、值与 Jar 键。 */
function diffSent(baselineSent, copySent) {
  const diffs = [];
  const n = Math.max(baselineSent.length, copySent.length);
  for (let i = 0; i < n; i++) {
    const b = baselineSent[i] || null;
    const c = copySent[i] || null;
    if (b && c) {
      const fields = [];
      if (b.name !== c.name) fields.push('name');
      if (b.value !== c.value) fields.push('value');
      if (keyOfCookie(b) !== keyOfCookie(c)) fields.push('key');
      if (!fields.length) continue;
      diffs.push({
        phase: 'send', kind: 'sent', ordinal: i,
        key: keyOfCookie(b), name: b.name, domain: b.domain, path: b.path,
        baseline: b, copy: c, differences: fields
      });
    } else {
      const side = b || c;
      diffs.push({
        phase: 'send', kind: 'sent', ordinal: i,
        key: keyOfCookie(side), name: side.name, domain: side.domain, path: side.path,
        baseline: b, copy: c, differences: []
      });
    }
  }
  return diffs;
}

/** 未发送项：按 Jar 键（名称忽略大小写、域、路径）对齐，比较值、属性与原因集合。 */
function diffUnsent(baselineUnsent, copyUnsent) {
  const diffs = [];
  const bMap = new Map();
  const cMap = new Map();
  for (const u of baselineUnsent) bMap.set(keyOfCookie(u.cookie), u);
  for (const u of copyUnsent) cMap.set(keyOfCookie(u.cookie), u);

  const keys = new Set([...bMap.keys(), ...cMap.keys()]);
  const sortedKeys = [...keys].filter((k) => {
    const b = bMap.get(k);
    const c = cMap.get(k);
    if (!b || !c) return true;
    const fields = cookieDiffs(b.cookie, c.cookie, COOKIE_FIELDS);
    if (!sameReasonSet(b.reasons, c.reasons)) fields.push('reasons');
    return fields.length > 0;
  }).sort();

  for (const key of sortedKeys) {
    const b = bMap.get(key) || null;
    const c = cMap.get(key) || null;
    const side = b || c;
    const fields = (!b || !c)
      ? []
      : cookieDiffs(b.cookie, c.cookie, COOKIE_FIELDS)
        .concat(sameReasonSet(b.reasons, c.reasons) ? [] : ['reasons']);
    diffs.push({
      phase: 'send', kind: 'unsent',
      key, name: side.cookie.name, domain: side.cookie.domain, path: side.cookie.path,
      baseline: b, copy: c, differences: fields
    });
  }
  return diffs;
}

// ---------- 响应阶段 ----------

/**
 * 非空 Set-Cookie 行的处理结果序列：有效请求直接取引擎输出；
 * 被跳过的步骤不处理任何 Set-Cookie，每行记为 { status:'skipped' }。
 * 行序与引擎逐条应用顺序一致（空行在归一化时已剔除）。
 */
function responseOutcomes(step, result) {
  if (result.request) return (result.responses || []).map((o) => ({ ...o }));
  return (step.setCookies || []).map((raw) => ({ raw, status: 'skipped' }));
}

/** stored 的处理状态带上覆盖口径（stored / updated），其余用原状态。 */
function effectiveStatus(o) {
  if (!o) return null;
  return o.status === 'stored' ? (o.action || 'stored') : o.status;
}

const PARSED_COOKIE_FIELDS = ['name'].concat(COOKIE_FIELDS);

/** 响应行：按非空行序号比较处理状态、拒写原因与解析出的 Cookie。 */
function diffResponses(baselineOutcomes, copyOutcomes) {
  const diffs = [];
  const n = Math.max(baselineOutcomes.length, copyOutcomes.length);
  for (let i = 0; i < n; i++) {
    const b = baselineOutcomes[i] || null;
    const c = copyOutcomes[i] || null;
    if (b && c) {
      const fields = [];
      if (effectiveStatus(b) !== effectiveStatus(c)) fields.push('status');
      if (b.status === 'rejected' && c.status === 'rejected' &&
          (b.reason || null) !== (c.reason || null)) {
        fields.push('reason');
      }
      if (b.status === 'deleted' && c.status === 'deleted' &&
          !!b.existed !== !!c.existed) {
        fields.push('existed');
      }
      // 解析出的 Cookie：stored / updated / deleted 三类有 cookie；
      // rejected / skipped 没有解析结果
      const bHas = !!b.cookie;
      const cHas = !!c.cookie;
      if (bHas && cHas) {
        for (const f of cookieDiffs(b.cookie, c.cookie, PARSED_COOKIE_FIELDS)) {
          fields.push('cookie.' + f);
        }
      } else if (bHas !== cHas) {
        fields.push('cookie');
      }
      if (!fields.length) continue;
      diffs.push({
        phase: 'response', kind: 'response', ordinal: i,
        rawBaseline: b.raw, rawCopy: c.raw,
        baseline: b, copy: c, differences: fields
      });
    } else {
      diffs.push({
        phase: 'response', kind: 'response', ordinal: i,
        rawBaseline: b ? b.raw : null, rawCopy: c ? c.raw : null,
        baseline: b, copy: c, differences: []
      });
    }
  }
  return diffs;
}

// ---------- 步末 ----------

/** 步末 Jar：按同一 Jar 键比较存活项的值与属性。 */
function diffJar(baselineJar, copyJar) {
  const diffs = [];
  const bMap = new Map();
  const cMap = new Map();
  for (const c of baselineJar) bMap.set(keyOfCookie(c), c);
  for (const c of copyJar) cMap.set(keyOfCookie(c), c);

  const keys = new Set([...bMap.keys(), ...cMap.keys()]);
  const sortedKeys = [...keys].filter((k) => {
    const b = bMap.get(k);
    const c = cMap.get(k);
    return !b || !c || cookieDiffs(b, c, COOKIE_FIELDS).length > 0;
  }).sort();

  for (const key of sortedKeys) {
    const b = bMap.get(key) || null;
    const c = cMap.get(key) || null;
    const side = b || c;
    diffs.push({
      phase: 'jar', kind: 'jar',
      key, name: side.name, domain: side.domain, path: side.path,
      baseline: b, copy: c,
      differences: (!b || !c) ? [] : cookieDiffs(b, c, COOKIE_FIELDS)
    });
  }
  return diffs;
}

/**
 * 两次模拟结果按步号对照，严格按 发送 → 响应 → 步末 的执行顺序产出差异。
 * @returns {Array<{step:number, baselineRequest:object, copyRequest:object, diffs:Array}>}
 *   仅包含存在差异的步骤（保持步序）
 */
function diffResults(baselineResults, copyResults, baselineSteps, copySteps) {
  const out = [];
  const n = Math.max(baselineResults.length, copyResults.length);
  for (let i = 0; i < n; i++) {
    const br = baselineResults[i];
    const cr = copyResults[i];
    const requestMeta = (r) => ({
      skipped: !r.request,
      valid: !!r.request,
      method: r.method,
      url: r.url
    });
    const diffs = [];

    // 发送阶段：先核对请求是否跳过，再按头顺序核对发送项，最后按 Jar 键核对未发送项
    if (!!br.request !== !!cr.request) {
      diffs.push({
        phase: 'send', kind: 'skip',
        baseline: { skipped: !br.request }, copy: { skipped: !cr.request },
        differences: ['skipped']
      });
    }
    diffs.push(...diffSent(br.sent || [], cr.sent || []));
    diffs.push(...diffUnsent(br.unsent || [], cr.unsent || []));

    // 响应阶段：按非空行序号
    const bOutcomes = responseOutcomes(baselineSteps[i] || { setCookies: [] }, br);
    const cOutcomes = responseOutcomes(copySteps[i] || { setCookies: [] }, cr);
    diffs.push(...diffResponses(bOutcomes, cOutcomes));

    // 步末：按同一 Jar 键
    diffs.push(...diffJar(br.jarAfter || [], cr.jarAfter || []));

    if (diffs.length) {
      out.push({
        step: i,
        baselineRequest: requestMeta(br),
        copyRequest: requestMeta(cr),
        diffs
      });
    }
  }
  return out;
}

/**
 * 在副本中修改一步并重跑对照。
 * @param {Array} rawSteps 当前编辑的完整步骤（冻结基线）
 * @param {object} change { stepIndex, url?, method?, topUrl?, isNavigation?, setCookies? }
 * @param {{baseTime?: number}} [options] 模拟起点（与 /api/simulate 保持同一时钟基准）
 * @returns 成功时 { ok:true, ... }；{ ok:false, invalid:true } 表示参数无效
 */
function compareSteps(rawSteps, change, options) {
  const fail = (error) => ({ ok: false, invalid: true, error });
  if (!change || typeof change !== 'object') return fail('缺少变更描述（change）');

  const steps = (rawSteps || []).map(normalizeStep);
  const stepIndex = change.stepIndex;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
    return fail(`变更步下标无效（${stepIndex}），当前共 ${steps.length} 步`);
  }

  const provided = CHANGE_FIELDS.filter((f) => change[f] !== undefined);
  if (!provided.length) return fail('至少需要提供一个要修改的字段');

  // 类型校验：仅允许修改请求 URL、方法、顶层页面 URL、导航标记与 Set-Cookie 行
  if (['url', 'method', 'topUrl'].some((f) => change[f] !== undefined &&
      typeof change[f] !== 'string')) {
    return fail('url / method / topUrl 必须是字符串');
  }
  if (change.isNavigation !== undefined && typeof change.isNavigation !== 'boolean') {
    return fail('isNavigation 必须是布尔值');
  }
  if (change.setCookies !== undefined &&
      (!Array.isArray(change.setCookies) || change.setCookies.some((x) => typeof x !== 'string'))) {
    return fail('setCookies 必须是字符串数组（每行一条）');
  }

  const before = steps[stepIndex];
  const patch = {};
  if (change.url !== undefined) patch.url = String(change.url).trim();
  if (change.method !== undefined) patch.method = String(change.method || 'GET').toUpperCase();
  if (change.topUrl !== undefined) patch.topUrl = String(change.topUrl).trim();
  if (change.isNavigation !== undefined) patch.isNavigation = !!change.isNavigation;
  if (change.setCookies !== undefined) {
    patch.setCookies = change.setCookies
      .map((x) => String(x).trim())
      .filter((x) => x.length > 0);
  }

  const modified = cloneSteps(steps);
  modified[stepIndex] = { ...before, ...patch };

  // 实际发生变化的字段（秒数与其他步骤不在可改范围内）
  const changedFields = CHANGE_FIELDS.filter((f) => {
    if (!(f in patch)) return false;
    if (f === 'method') return patch.method !== (before.method || 'GET').toUpperCase();
    if (f === 'isNavigation') return patch.isNavigation !== !!before.isNavigation;
    if (f === 'setCookies') return JSON.stringify(patch.setCookies) !== JSON.stringify(before.setCookies);
    return patch[f] !== before[f];
  });

  // 基线与副本各自重跑：两侧结果都由同一引擎产出，不做二次推算
  const baselineRun = runSimulation(steps, options);
  const copyRun = runSimulation(modified, options);
  const stepDiffs = diffResults(
    baselineRun.results, copyRun.results, steps, modified
  );
  const affectedSteps = stepDiffs.map((d) => d.step);
  const firstStepDiff = stepDiffs[0] || null;
  const firstDiff = firstStepDiff
    ? { step: firstStepDiff.step, ...firstStepDiff.diffs[0] }
    : null;

  return {
    ok: true,
    stepIndex,
    changedFields,
    baselineStep: before,
    modifiedStep: modified[stepIndex],
    stepDiffs,
    affectedSteps,
    firstDiff,
    identical: firstDiff === null
  };
}

module.exports = {
  compareSteps,
  diffResults,
  responseOutcomes,
  effectiveStatus,
  jarKeyOf,
  CHANGE_FIELDS,
  COOKIE_FIELDS
};
