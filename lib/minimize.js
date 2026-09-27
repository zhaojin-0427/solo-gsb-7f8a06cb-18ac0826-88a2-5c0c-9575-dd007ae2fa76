'use strict';

const { runSimulation } = require('./simulate');

/**
 * 最小复现（minimize）：给定完整步骤序列与一个目标 Cookie，
 * 生成以目标步为结尾、仍能复现该目标结果的最小步骤序列。
 *
 * 目标标识：名称 + 值 + 域 + 路径 + 发送状态（sent）；
 * 未发送目标还须原因集合完全一致。
 *
 * 只允许两类删减（单项尝试、重跑引擎核对、成功才接受）：
 *  1) 删除目标步之前的整步——被删步的经过秒数并入下一保留步，
 *     使所有保留请求的绝对时刻不变；
 *  2) 删除截至目标步（含目标步）的任意一条 Set-Cookie 行。
 * 目标请求的 URL、方法、顶层页面 URL 与导航标记保持不变。
 *
 * 反复尝试直至任何单项再删都会改变目标结果（1-minimal）。
 */

/** 步骤规范化：与 /api/simulate 的输入归一保持一致，并去掉空 Set-Cookie 行。 */
function normalizeStep(s) {
  return {
    seconds: Math.max(0, Number(s && s.seconds) || 0),
    url: s && s.url != null ? String(s.url) : '',
    method: s && s.method != null ? String(s.method) : 'GET',
    topUrl: s && s.topUrl != null ? String(s.topUrl) : '',
    isNavigation: !!(s && s.isNavigation),
    setCookies: (Array.isArray(s && s.setCookies) ? s.setCookies : [])
      .map((x) => String(x == null ? '' : x).trim())
      .filter((x) => x.length > 0)
  };
}

function countSetCookieLines(steps) {
  return steps.reduce((n, s) => n + s.setCookies.length, 0);
}

function cloneSteps(steps) {
  return steps.map((s) => ({ ...s, setCookies: [...s.setCookies] }));
}

/** Cookie 标识：名称 + 值 + 域 + 路径（域为序列化形式，host-only 不带前导点）。 */
function cookieId(c) {
  return [c.name, c.value, c.domain, c.path].join('\u0001');
}

function sameReasonSet(a, b) {
  const x = [...(a || [])].sort();
  const y = [...(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 某一步的模拟结果中是否能定位到目标。 */
function targetMatches(result, target) {
  if (!result) return false;
  if (target.sent === true) {
    return (result.sent || []).some((c) => cookieId(c) === cookieId(target));
  }
  return (result.unsent || []).some((u) =>
    cookieId(u.cookie) === cookieId(target) &&
    sameReasonSet(u.reasons, target.reasons));
}

/**
 * @param {Array} rawSteps 当前编辑的完整步骤
 * @param {object} target  { stepIndex, name, value, domain, path, sent, reasons? }
 * @param {{baseTime?:number}} [options] 模拟起点（与 /api/simulate 一致；HAR 导入场景沿用抓包起点）
 * @returns {{ok:true, steps:Array, before:object, after:object, keptClock:number} | {ok:false, error:string}}
 */
function minimizeSteps(rawSteps, target, options) {
  const steps = (rawSteps || []).map(normalizeStep);
  const before = { steps: steps.length, setCookieLines: countSetCookieLines(steps) };

  // --- 定位目标 ---
  if (!target || typeof target !== 'object') {
    return { ok: false, error: '缺少目标（target）' };
  }
  const stepIndex = target.stepIndex;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
    return { ok: false, error: `目标步下标无效（${stepIndex}），当前共 ${steps.length} 步` };
  }
  if (typeof target.name !== 'string' || typeof target.value !== 'string' ||
      typeof target.domain !== 'string' || typeof target.path !== 'string' ||
      typeof target.sent !== 'boolean') {
    return { ok: false, error: '目标标识不完整（需要名称、值、域、路径与发送状态）' };
  }
  if (target.sent !== true && !Array.isArray(target.reasons)) {
    return { ok: false, error: '未发送目标缺少原因集合（reasons）' };
  }

  const original = runSimulation(steps, options).results;
  const targetResult = original[stepIndex];
  if (!targetMatches(targetResult, target)) {
    return {
      ok: false,
      error: `在第 ${stepIndex + 1} 步的模拟结果中找不到该目标（${target.sent ? '已发送' : '未发送'} ` +
        `${target.name}=${target.value} @ ${target.domain} ${target.path}）。` +
        '步骤可能已被修改，请重新运行模拟后再选择目标。'
    };
  }
  const targetClock = targetResult.clock;

  // --- 以目标步为结尾截断 ---
  let current = steps.slice(0, stepIndex + 1);

  // 核对：候选序列重跑引擎后，末步（即目标步）仍复现目标
  const holds = (candidate) => {
    const results = runSimulation(candidate, options).results;
    return targetMatches(results[results.length - 1], target);
  };

  // --- 贪心单项删减，直至 1-minimal ---
  let changed = true;
  while (changed) {
    changed = false;

    // 1) 删除目标步之前的整步，经过秒数并入下一保留步
    for (let i = 0; i < current.length - 1; i++) {
      const candidate = cloneSteps(current);
      const removed = candidate.splice(i, 1)[0];
      // 删除后 candidate[i] 即原序列中 i 之后的下一保留步（目标步不会被删）
      candidate[i].seconds += removed.seconds;
      if (holds(candidate)) {
        current = candidate;
        changed = true;
        i--; // 下标前移，重新检查当前位置
      }
    }

    // 2) 删除截至目标步的 Set-Cookie 行
    for (let i = 0; i < current.length; i++) {
      for (let j = 0; j < current[i].setCookies.length; j++) {
        const candidate = cloneSteps(current);
        candidate[i].setCookies.splice(j, 1);
        if (holds(candidate)) {
          current = candidate;
          changed = true;
          j--;
        }
      }
    }
  }

  // 保留请求的绝对时刻不变：末步时钟应与原目标步一致
  const finalResults = runSimulation(current, options).results;
  const keptClock = finalResults[finalResults.length - 1].clock;

  return {
    ok: true,
    steps: current,
    before,
    after: { steps: current.length, setCookieLines: countSetCookieLines(current) },
    targetStep: stepIndex + 1,
    targetClock,
    keptClock
  };
}

module.exports = { minimizeSteps, targetMatches, normalizeStep };
