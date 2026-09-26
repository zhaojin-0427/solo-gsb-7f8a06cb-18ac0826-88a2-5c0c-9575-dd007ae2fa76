'use strict';

// 服务端同名取值分析：从模拟结果（runSimulation 的 results）纯推导，UMD 模块，
// 前端渲染与 Node 测试共用，不改动模拟引擎与编辑内容。
//
// 口径说明：
//  - 分组与取值按 Cookie 头原文：名称【区分大小写】，组内顺序 = 实际头中顺序
//    （result.sent 即 RFC 6265 排序后的发送顺序）；
//  - “取首项 / 取末项”模拟服务端框架对同名 Cookie 的两种常见解析口径，
//    两者读到的值不同时记为“分歧”；
//  - 事件关联按 Jar 键口径：名称【不区分大小写】（与 CookieJar.keyOf 一致），
//    事件的域 / 路径仍逐项展示，便于定位是哪一条键发生了变化；
//  - 因果窗口：同一步先发送后处理响应 —— 第 N 步响应中的写入 / 覆盖 / 删除
//    只影响第 N 步之后的请求；过期淘汰发生在第 N 步发送判定中，
//    影响第 N 步（含）之后的请求。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ServerView = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /** 事件对应的键名（空操作删除没有 before/after，键标识直接挂在事件上）。 */
  function eventName(ev) {
    if (ev && ev.name != null) return ev.name;
    const c = ev && (ev.after || ev.before);
    return c ? c.name : null;
  }

  /**
   * 单个有效请求的同名取值分析。
   * @param {object} result runSimulation 某步结果（应为有效请求：result.request 非空）
   * @returns {{empty:boolean, groups:Array, divergentNames:Array<string>}}
   *   groups 按名称在头中首次出现的顺序排列；每组：
   *   { name, items:[{value,domain,path,hostOnly,creationOrder}], first, last, multi, divergent }
   */
  function analyzeRequest(result) {
    const sent = (result && Array.isArray(result.sent)) ? result.sent : [];
    const groups = [];
    const byName = new Map(); // 名称区分大小写：直接以头中原文名称为键
    for (const c of sent) {
      let g = byName.get(c.name);
      if (!g) {
        g = { name: c.name, items: [] };
        byName.set(c.name, g);
        groups.push(g);
      }
      g.items.push({
        value: c.value,
        domain: c.domain,
        path: c.path,
        hostOnly: c.hostOnly === true,
        creationOrder: c.creationOrder
      });
    }
    for (const g of groups) {
      g.first = g.items[0].value;
      g.last = g.items[g.items.length - 1].value;
      g.multi = g.items.length > 1;
      g.divergent = g.multi && g.first !== g.last;
    }
    return {
      empty: sent.length === 0,
      groups,
      divergentNames: groups.filter((g) => g.divergent).map((g) => g.name)
    };
  }

  /**
   * 关联相邻步骤的 Jar 事件：名称按 Jar 键口径（不区分大小写），且落在因果窗口内——
   * 上一有效请求（prevStep，无则 -1）发送完成之后、本请求（currStep）发送完成之前：
   *  - 写入 / 覆盖 / 删除发生在响应阶段：步下标 s 满足 prevStep <= s < currStep；
   *  - 过期淘汰发生在发送判定中：步下标 s 满足 prevStep < s <= currStep。
   */
  function correlateEvents(results, name, prevStep, currStep) {
    const lower = String(name).toLowerCase();
    const out = [];
    for (let s = 0; s < results.length; s++) {
      const r = results[s];
      if (!r || !Array.isArray(r.events)) continue;
      for (const ev of r.events) {
        const n = eventName(ev);
        if (n === null || String(n).toLowerCase() !== lower) continue;
        const causal = ev.type === 'evicted'
          ? (s > prevStep && s <= currStep)
          : (s >= prevStep && s < currStep);
        if (causal) out.push(ev);
      }
    }
    return out;
  }

  /**
   * 沿有效请求时间线的分歧分析（URL 非法被跳过的步骤不算有效请求）。
   * @param {Array} results runSimulation 的 results
   * @returns {{
   *   validCount:number, validSteps:Array<number>, perStep:Map<number,object>,
   *   names:Array<{name:string, everDivergent:boolean, everMulti:boolean,
   *     divergentNow:boolean, transitions:Array}>
   * }}
   *   transition: { type:'arise'|'vanish', step, clockISO,
   *                 first?, last?,                 // arise：两种取值
   *                 state?:'absent'|'single'|'multi-agree', // vanish：消失后的状态
   *                 events:Array }                 // 相邻步骤中该名称（Jar 键口径）的关联事件
   */
  function analyzeTimeline(results) {
    const list = Array.isArray(results) ? results : [];
    const validSteps = [];
    list.forEach((r, i) => { if (r && r.request) validSteps.push(i); });

    const perStep = new Map();
    for (const i of validSteps) perStep.set(i, analyzeRequest(list[i]));

    const names = new Map();
    const order = [];
    const recOf = (name) => {
      let rec = names.get(name);
      if (!rec) {
        rec = { name, everDivergent: false, everMulti: false, divergentNow: false, transitions: [] };
        names.set(name, rec);
        order.push(name);
      }
      return rec;
    };

    let prevStep = -1;
    for (const curr of validSteps) {
      const a = perStep.get(curr);
      const present = new Set();
      for (const g of a.groups) {
        present.add(g.name);
        const rec = recOf(g.name);
        if (g.multi) rec.everMulti = true;
        if (g.divergent && !rec.divergentNow) {
          rec.everDivergent = true;
          rec.transitions.push({
            type: 'arise', step: curr, clockISO: list[curr].clockISO,
            first: g.first, last: g.last,
            events: correlateEvents(list, g.name, prevStep, curr)
          });
          rec.divergentNow = true;
        } else if (!g.divergent && rec.divergentNow) {
          rec.transitions.push({
            type: 'vanish', step: curr, clockISO: list[curr].clockISO,
            state: g.multi ? 'multi-agree' : 'single',
            events: correlateEvents(list, g.name, prevStep, curr)
          });
          rec.divergentNow = false;
        }
      }
      // 本请求中不再发送的名称：若此前处于分歧状态，分歧在此消失
      for (const rec of names.values()) {
        if (rec.divergentNow && !present.has(rec.name)) {
          rec.transitions.push({
            type: 'vanish', step: curr, clockISO: list[curr].clockISO,
            state: 'absent',
            events: correlateEvents(list, rec.name, prevStep, curr)
          });
          rec.divergentNow = false;
        }
      }
      prevStep = curr;
    }

    return {
      validCount: validSteps.length,
      validSteps,
      perStep,
      names: order.map((n) => names.get(n))
    };
  }

  return { analyzeRequest, analyzeTimeline, correlateEvents, eventName };
});
