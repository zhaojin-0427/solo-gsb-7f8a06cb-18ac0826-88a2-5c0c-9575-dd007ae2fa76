'use strict';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'];

const REASON_TEXT = {
  DOMAIN: '域不匹配（Host-Only 或子域边界）',
  PATH: '请求路径不在 Cookie 路径边界内',
  EXPIRED: '已超过 Max-Age / Expires',
  NOT_HTTPS: 'Secure Cookie 不能经 HTTP 明文发送',
  SAMESITE_STRICT: 'SameSite=Strict：跨站一律不发送',
  SAMESITE_LAX: 'SameSite=Lax：跨站仅限顶层安全方法（GET/HEAD/OPTIONS/TRACE）导航'
};

const REJECT_TEXT = {
  EMPTY: '空的 Set-Cookie',
  BAD_NAME: '名称或值格式非法',
  DOMAIN_MISMATCH: 'Domain 既不是响应主机，也不是其父域',
  PUBLIC_SUFFIX: 'Domain 是公共后缀（含 PSL 私有后缀，如 com / co.uk / s3.amazonaws.com / github.io），禁止设置 Cookie',
  SAMESITE_NONE_SECURE: 'SameSite=None 必须同时指定 Secure'
};

const STATUS_TEXT = {
  stored: '新写入',
  updated: '更新已有项',
  deleted: '删除',
  rejected: '拒绝写入'
};

let steps = deepClone(window.EXAMPLES.full.steps);
let lastResults = null; // 最近一次模拟结果，供“最小复现”选取目标
// “步骤变更影响”对照的冻结基线：一次模拟完成后快照的步骤；编辑器一旦改动即标记失效
let baselineSteps = null;
let impactReport = null; // 最近一次对照结果
let impactStep = -1; // 当前对照面板选择的步号（0 基）
// 本次模拟起点（epoch 毫秒）；null = 引擎默认基准时钟。
// HAR 导入确认后设为首条记录时间，使 Expires 按抓包绝对时间判定；
// 最小复现、策略求解与影响对照的请求都携带同一起点。
let baseTime = null;
// 与 lib/simulate.js 的 BASE_TIME 保持一致（仅用于展示默认起点）
const DEFAULT_BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
let harState = null; // 当前 HAR 预览：{ fileName, error, rows }
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

// ---------- 编辑器 ----------

function renderSteps() {
  const container = document.getElementById('steps');
  container.innerHTML = '';
  steps.forEach((s, i) => container.appendChild(renderStepCard(s, i)));
}

function renderStepCard(s, i) {
  const card = el('div', 'step-card');
  card.dataset.i = i;

  const head = el('div', 'step-head');
  head.appendChild(el('span', 'step-index', String(i + 1)));
  head.appendChild(el('span', 'clock-hint', '第 ' + (i + 1) + ' 步'));
  const del = el('button', 'del', '删除该步');
  del.type = 'button';
  del.addEventListener('click', () => {
    steps.splice(i, 1);
    renderSteps();
    markImpactStale(); // 原编辑器变更：旧冻结基线随之失效
  });
  head.appendChild(del);
  card.appendChild(head);

  const r1 = el('div', 'row2');
  r1.appendChild(field('经过秒数',
    `<input type="number" min="0" step="any" data-k="seconds" value="${esc(s.seconds)}">`));
  r1.appendChild(field('请求 URL（http / https）',
    `<input type="text" data-k="url" value="${esc(s.url)}" placeholder="https://example.com/path">`));
  card.appendChild(r1);

  const r2 = el('div', 'row2');
  const opts = METHODS.map((m) =>
    `<option value="${m}"${m === (s.method || 'GET').toUpperCase() ? ' selected' : ''}>${m}</option>`).join('');
  r2.appendChild(field('方法', `<select data-k="method">${opts}</select>`));
  r2.appendChild(field('顶层页面 URL（留空 = 一方请求）',
    `<input type="text" data-k="topUrl" value="${esc(s.topUrl || '')}" placeholder="https://shop.example.com/home">`));
  card.appendChild(r2);

  const nav = el('label', 'checkline');
  nav.innerHTML =
    `<input type="checkbox" data-k="isNavigation"${s.isNavigation ? ' checked' : ''}> ` +
    `该请求为顶层导航（地址栏跳转 / 点击外链进入）`;
  card.appendChild(nav);

  card.appendChild(field('Set-Cookie 响应（每行一条，不要写 Set-Cookie: 前缀）',
    `<textarea data-k="setCookies" placeholder="sid=abc; Path=/; Max-Age=3600; Secure; SameSite=None">${
      esc((s.setCookies || []).join('\n'))}</textarea>`));

  return card;
}

function field(labelText, innerHtml) {
  const f = el('div', 'field');
  f.innerHTML = `<label>${labelText}</label>${innerHtml}`;
  return f;
}

// 输入直接写回 state，避免重渲染丢失焦点
document.getElementById('steps').addEventListener('input', (e) => {
  const card = e.target.closest('.step-card');
  if (!card) return;
  const i = Number(card.dataset.i);
  const k = e.target.dataset.k;
  if (k === 'isNavigation') steps[i][k] = e.target.checked;
  else if (k === 'setCookies') steps[i][k] = e.target.value.split('\n');
  else if (k === 'seconds') steps[i][k] = e.target.value;
  else steps[i][k] = e.target.value;
  markImpactStale(); // 原编辑器变更：旧冻结基线随之失效
});

/**
 * 编辑器内容已偏离冻结基线：旧对照失效。
 * 面板仍可查看（标明已失效），但只能在重新运行、形成新基线后发起新对照。
 */
function impactStale() {
  return !!baselineSteps && JSON.stringify(steps) !== JSON.stringify(baselineSteps);
}

function markImpactStale() {
  if (!impactReport && (impactPanel().classList.contains('hidden') || impactStep < 0)) return;
  if (!baselineSteps) return;
  if (!impactStale()) return;
  impactReport = null; // 旧对照失效，不再展示其结果
  if (!impactPanel().classList.contains('hidden')) {
    renderImpactPanel(impactStep);
  }
}

// ---------- 工具栏 ----------

document.getElementById('btn-add').addEventListener('click', () => {
  steps.push({ seconds: 0, url: '', method: 'GET', topUrl: '', isNavigation: false, setCookies: [''] });
  renderSteps();
  markImpactStale(); // 原编辑器变更：旧冻结基线随之失效
  document.getElementById('steps').lastElementChild.scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-clear').addEventListener('click', () => {
  steps = [];
  renderSteps();
  baseTime = null; // 清空：恢复默认模拟起点
  renderBaseTime();
  baselineSteps = null; // 清空：基线不存在，旧对照一并失效
  impactReport = null;
  impactStep = -1;
  hideImpactPanel();
  document.getElementById('results').innerHTML =
    '<p class="placeholder">已清空。点击“＋ 新增步骤”或“载入示例”开始。</p>';
});

const menuBtn = document.getElementById('btn-example');
const menu = document.getElementById('example-menu');
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.classList.toggle('open');
});
document.addEventListener('click', () => menu.classList.remove('open'));
menu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-example]');
  if (!btn) return;
  steps = deepClone(window.EXAMPLES[btn.dataset.example].steps);
  baseTime = null; // 内置示例围绕默认基准时钟设计：恢复默认模拟起点
  renderBaseTime();
  renderSteps();
  menu.classList.remove('open');
  await runSimulation();
});

document.getElementById('btn-run').addEventListener('click', runSimulation);

// ---------- 运行与结果渲染 ----------

async function runSimulation() {
  const out = document.getElementById('results');
  out.innerHTML = '<p class="placeholder">运行中…</p>';
  hideLifePanel(); // 结果将整体重算，旧轨迹面板随之关闭（不影响编辑内容）
  hideSolvePanel(); // 求解面板引用的是旧结果，一并关闭（不影响编辑内容）
  hideImpactPanel(); // 原编辑器变更或重新运行后，旧对照失效（对照不覆盖原步骤）
  let data;
  try {
    const resp = await fetch('/api/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, baseTime })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    out.innerHTML = '';
    out.appendChild(el('div', 'error-box', '模拟失败：' + esc(err.message)));
    return;
  }

  out.innerHTML = '';
  if (!data.results.length) {
    lastResults = null;
    baselineSteps = null; // 没有步骤：基线与对照一并清空
    out.appendChild(el('p', 'placeholder', '没有步骤。'));
    return;
  }
  lastResults = data.results;
  // 一次模拟完成后冻结步骤与结果作为“步骤变更影响”对照的基线
  baselineSteps = deepClone(steps);
  // 服务端同名取值 · 分歧时间线汇总（沿有效请求；每次运行随结果整体刷新，不改编辑内容）
  out.appendChild(renderServerViewSummary(data.results));
  data.results.forEach((r, i) => out.appendChild(renderResult(r, i)));
  // 绑定每个已发送 / 未发送 Cookie 上的“最小复现”按钮
  out.querySelectorAll('.mini-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      minimizeToTarget(Number(btn.dataset.step), btn.dataset.kind, Number(btn.dataset.idx));
    });
  });
  // 绑定已发送 / 未发送 / 成功解析的响应处理项 / 步末 Jar 上的“生命周期”按钮
  out.querySelectorAll('.life-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      openLifePanel(Number(btn.dataset.step), btn.dataset.kind, btn.dataset.resp);
    });
  });
  // 绑定成功写入的 Set-Cookie 上的“策略求解”按钮
  out.querySelectorAll('.solve-target').forEach((btn) => {
    btn.addEventListener('click', () => {
      openSolvePanel(Number(btn.dataset.step), Number(btn.dataset.resp));
    });
  });
  // 绑定每个结果卡片头部的“步骤变更影响”按钮
  out.querySelectorAll('.impact-target').forEach((btn) => {
    btn.addEventListener('click', () => openImpactPanel(Number(btn.dataset.step)));
  });
}

function renderResult(r, stepIndex) {
  const card = el('div', 'result-card');
  card.id = 'result-step-' + stepIndex;

  const head = el('div', 'result-head');
  head.appendChild(el('span', 'method', esc(r.method)));
  head.appendChild(el('span', 'mono', esc(r.url || '(未填写)')));
  head.appendChild(el('span', 'clock', '⏱ +' + r.seconds + 's → ' + r.clockISO));
  const impactBtn = el('button', 'impact-target', '🔬 步骤变更影响');
  impactBtn.type = 'button';
  impactBtn.title = '冻结基线：只在副本中修改这一步并重跑对照（不改动原步骤）';
  impactBtn.dataset.step = stepIndex;
  head.appendChild(impactBtn);
  card.appendChild(head);

  const body = el('div', 'result-body');

  (r.warnings || []).forEach((w) => body.appendChild(el('div', 'warning', '⚠ ' + esc(w))));

  // 站信息
  if (r.request) {
    const chips = el('div', 'chips');
    if (r.sameSite === true) chips.appendChild(chip('同站请求', 'ok'));
    else if (r.sameSite === false) chips.appendChild(chip('跨站请求', 'bad'));
    if (r.isNavigation) chips.appendChild(chip('顶层导航', 'nav'));
    if (r.crossSite && r.topLevelSafeNavigation) chips.appendChild(chip('跨站顶层安全方法 → Lax 放行', 'ok'));
    chips.appendChild(chip('请求站：' + (r.requestSite || '?')));
    if (r.topUrl) chips.appendChild(chip('顶层站：' + (r.topSite || '无法解析')));
    body.appendChild(chips);
  }

  // 发送项
  body.appendChild(el('div', 'section-title', '① 判定发送（应用响应之前）'));
  const headerText = r.cookieHeader
    ? 'Cookie: ' + r.cookieHeader
    : '（本请求不发送任何 Cookie）';
  body.appendChild(el('div', 'cookie-header' + (r.cookieHeader ? '' : ' empty'), esc(headerText)));

  if (r.sent.length) {
    body.appendChild(cookieTable(r.sent, (c) => {
      const tags = [attrBadge(c.hostOnly ? 'host-only' : 'Domain=' + stripDot(c.domain)),
        attrBadge('Path=' + c.path)];
      if (c.secure) tags.push(attrBadge('Secure'));
      tags.push(attrBadge('SameSite=' + c.sameSite));
      return tags.join('');
    }, (c, k) => targetButtons(stepIndex, 'sent', k), '操作'));
  }

  if (r.unsent.length) {
    const t = tableWith(['Cookie', '域 / 路径', '未发送原因', '操作'], r.unsent.map((u, k) => [
      esc(u.cookie.name) + '=' + esc(u.cookie.value),
      esc(u.cookie.domain) + ' ' + esc(u.cookie.path),
      '<div class="reasons">' +
        u.reasons.map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
        '</div>',
      targetButtons(stepIndex, 'unsent', k)
    ]));
    body.appendChild(t);
  }

  // 服务端同名取值（仅有效请求；基于本步发送的 Cookie 头 —— 先发送，② 的响应只影响后续请求）
  if (r.request) {
    body.appendChild(el('div', 'section-title', '服务端同名取值（本请求 Cookie 头 · 名称区分大小写）'));
    body.appendChild(renderServerViewRequest(window.ServerView.analyzeRequest(r)));
  }

  // Set-Cookie 应用
  body.appendChild(el('div', 'section-title', '② 应用 Set-Cookie 响应'));
  if (!r.responses || !r.responses.length) {
    body.appendChild(el('p', 'jarline', '本步没有 Set-Cookie。'));
  } else {
    body.appendChild(tableWith(['Set-Cookie 原文', '处理结果', '操作'], r.responses.map((x, k) => {
      const detail = x.cookie
        ? `<div class="jarline">键：<span class="mono">${esc(x.cookie.name)} @ ${esc(x.cookie.domain)} ${esc(x.cookie.path)}</span></div>`
        : '';
      const extra = x.status === 'rejected'
        ? `<div class="jarline">${esc(REJECT_TEXT[x.reason] || x.reason)}</div>`
        : (x.status === 'deleted'
          ? `<div class="jarline">${x.existed ? '命中已有项并删除' : '没有找到同名/域/路径的项（删除为空操作）'}</div>`
          : '');
      const actionCell = x.status === 'rejected'
        ? '<span class="jarline muted">被拒写入不进入轨迹</span>'
        : '<div class="cell-actions">' + lifeButton(stepIndex, 'response', k) +
          (x.status === 'deleted' ? '' : solveButton(stepIndex, k)) + '</div>';
      return [
        '<span class="mono">' + esc(x.raw) + '</span>',
        `<span class="badge ${x.status}">${esc(STATUS_TEXT[x.status] || x.status)}${
          x.action === 'updated' ? '（覆盖）' : ''}</span>` + detail + extra,
        actionCell
      ];
    })));
  }

  // Jar 快照
  body.appendChild(el('div', 'section-title', '本步结束后 Cookie Jar（' + r.jarAfter.length + ' 项）'));
  if (r.jarAfter.length) {
    body.appendChild(cookieTable(r.jarAfter, (c) => {
      const tags = [attrBadge(c.hostOnly ? 'host-only' : 'Domain=' + stripDot(c.domain)),
        attrBadge('Path=' + c.path)];
      if (c.secure) tags.push(attrBadge('Secure'));
      tags.push(attrBadge('SameSite=' + c.sameSite));
      return tags.join('');
    }, (c, k) => {
      const validity = c.session
        ? '<span class="badge attr">会话期</span>'
        : `<span class="badge ${c.remainingSec > 0 ? 'attr' : 'expired'}">剩余 ${esc(c.remainingSec)}s</span>`;
      return '<div class="cell-actions">' + validity + lifeButton(stepIndex, 'jar', k) + '</div>';
    }, '有效期 / 追踪'));
  } else {
    body.appendChild(el('p', 'jarline', 'Jar 为空。'));
  }

  card.appendChild(body);
  return card;
}

function stripDot(domain) {
  return String(domain).replace(/^\./, '');
}

function chip(text, cls) {
  return el('span', 'chip' + (cls ? ' ' + cls : ''), esc(text));
}

function attrBadge(text) {
  return `<span class="badge attr">${esc(text)}</span>`;
}

function tableWith(headers, rows) {
  const t = el('table', 'cookies');
  t.innerHTML = '<thead><tr>' + headers.map((h) => `<th>${esc(h)}</th>`).join('') + '</tr></thead>';
  const tb = el('tbody');
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((c) => {
      const td = el('td');
      td.innerHTML = c;
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  return t;
}

function cookieTable(cookies, attrFn, extraFn, extraHeader) {
  const headers = extraFn ? ['名称=值', '属性', extraHeader || ''] : ['名称=值', '属性'];
  return tableWith(headers,
    cookies.map((c, k) => {
      const cells = [
        '<span class="mono">' + esc(c.name) + '=' + esc(c.value) + '</span>',
        attrFn(c)
      ];
      if (extraFn) cells.push(extraFn(c, k));
      return cells;
    }));
}

// ---------- 最小复现 ----------

function targetButton(stepIndex, kind, idx) {
  return `<button type="button" class="mini-target" data-step="${stepIndex}" data-kind="${kind}" data-idx="${idx}">🎯 最小复现</button>`;
}

// ---------- 生命周期 ----------

function lifeButton(stepIndex, kind, idx) {
  return `<button type="button" class="life-target" data-step="${stepIndex}" data-kind="${kind}" data-resp="${idx}">🕰 生命周期</button>`;
}

/** 已发送 / 未发送行：“最小复现” + “生命周期”两个操作。 */
function targetButtons(stepIndex, kind, idx) {
  return '<div class="cell-actions">' + targetButton(stepIndex, kind, idx) + lifeButton(stepIndex, kind, idx) + '</div>';
}

function lifePanel() {
  return document.getElementById('life-panel');
}

function hideLifePanel() {
  const panel = lifePanel();
  if (!panel) return;
  panel.className = 'hidden';
  panel.innerHTML = '';
}

/**
 * 把按钮位置解析为轨迹目标。
 * 同名（不区分大小写）、规范化域（去前导点）、路径相同才是同一条轨迹。
 */
function resolveLifeTarget(stepIndex, kind, respIdx) {
  const r = lastResults && lastResults[stepIndex];
  if (!r) return null;
  if (kind === 'sent') {
    const c = r.sent[respIdx];
    return c ? { name: c.name, domain: c.domain, path: c.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步已发送项' } : null;
  }
  if (kind === 'unsent') {
    const u = r.unsent[respIdx];
    return u ? { name: u.cookie.name, domain: u.cookie.domain, path: u.cookie.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步未发送项' } : null;
  }
  if (kind === 'response') {
    const x = r.responses[respIdx];
    if (!x || !x.cookie) return null;
    const label = x.status === 'deleted'
      ? '第 ' + (stepIndex + 1) + ' 步 Set-Cookie 删除项'
      : '第 ' + (stepIndex + 1) + ' 步 Set-Cookie ' + (x.action === 'updated' ? '覆盖项' : '写入项');
    return { name: x.cookie.name, domain: x.cookie.domain, path: x.cookie.path, sourceLabel: label };
  }
  // kind === 'jar'
  const c = r.jarAfter[respIdx];
  return c ? { name: c.name, domain: c.domain, path: c.path, sourceLabel: '第 ' + (stepIndex + 1) + ' 步步末 Jar' } : null;
}

function openLifePanel(stepIndex, kind, respIdxRaw) {
  const panel = lifePanel();
  const respIdx = respIdxRaw === undefined || respIdxRaw === '' ? -1 : Number(respIdxRaw);
  const target = resolveLifeTarget(stepIndex, kind, respIdx);
  if (!target) return;
  const trace = window.Lifecycle.traceOf(lastResults, target, stepIndex);
  renderLifePanel(panel, target, stepIndex, trace);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const EVENT_TEXT = {
  stored: '写入',
  updated: '覆盖',
  deleted: '删除',
  evicted: '过期淘汰'
};

function cookieMini(c) {
  if (!c) return '<span class="na">—（无此项）</span>';
  const pieces = [
    `<span class="mono">${esc(c.name)}=${esc(c.value)}</span>`,
    c.hostOnly ? '<span class="badge attr">host-only</span>'
      : `<span class="badge attr">Domain=${esc(stripDot(c.domain))}</span>`,
    `<span class="badge attr">Path=${esc(c.path)}</span>`
  ];
  if (c.secure) pieces.push('<span class="badge attr">Secure</span>');
  pieces.push(`<span class="badge attr">SameSite=${esc(c.sameSite)}</span>`);
  if (c.persistent) {
    pieces.push(c.expiresISO
      ? `<span class="badge attr">到期 ${esc(c.expiresISO)}</span>`
      : '<span class="badge attr">持久</span>');
  } else {
    pieces.push('<span class="badge attr">会话期</span>');
  }
  return pieces.join(' ');
}

function aliveLine(ev) {
  if (ev.type === 'stored' || ev.type === 'updated') {
    const c = ev.after;
    if (!c.persistent) return '<span class="badge alive">存活（会话期，无到期时间）</span>';
    return `<span class="badge alive">存活至 ${esc(c.expiresISO)}</span>`;
  }
  if (ev.type === 'deleted') {
    return ev.before
      ? '<span class="badge dead">已删除（不再存活）</span>'
      : '<span class="badge miss">空操作：未命中任何项，轨迹不变</span>';
  }
  // evicted：仍经历了本次未发送判定，随后才淘汰
  return '<span class="badge dead">已过期淘汰（本次请求先进入未发送判定，随后移除）</span>';
}

function renderLifePanel(panel, target, targetStep, trace) {
  panel.innerHTML = '';
  panel.className = 'life-panel';

  const head = el('div', 'life-head');
  head.appendChild(el('div', 'section-title', '🕰 生命周期轨迹（截至第 ' + (targetStep + 1) + ' 步）'));
  const close = el('button', 'panel-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideLifePanel);
  head.appendChild(close);
  panel.appendChild(head);

  const keyDesc = `<span class="mono">${esc(target.name)}</span> @ ` +
    `<span class="mono">${esc(stripDot(target.domain))} ${esc(target.path)}</span>`;
  panel.appendChild(el('p', 'life-stats',
    '目标键（名称不区分大小写；同名但域或路径不同者分开追踪）：' + keyDesc));
  panel.appendChild(el('p', 'life-stats', '选择自：' + esc(target.sourceLabel) +
    '。覆盖沿用同一键并重算到期时间；过期 Cookie 在首次到期后的有效请求中仍进入未发送判定，随后才淘汰。'));

  if (!trace.length) {
    panel.appendChild(el('p', 'placeholder', '截至该步没有命中该键的写入 / 覆盖 / 删除 / 过期淘汰事件。'));
  } else {
    const list = el('div', 'life-trace');
    trace.forEach((ev) => {
      const item = el('div', 'life-event ' + ev.type);

      const top = el('div', 'life-event-top');
      const jump = el('button', 'life-jump', '↩ 第 ' + (ev.step + 1) + ' 步');
      jump.type = 'button';
      jump.title = '跳回该事件所在的原步骤';
      jump.addEventListener('click', () => jumpToStep(ev.step));
      top.appendChild(jump);
      top.appendChild(el('span', 'life-clock', '⏱ ' + ev.clockISO));
      top.appendChild(el('span', 'badge ' + ev.type, EVENT_TEXT[ev.type] || ev.type));
      item.appendChild(top);

      const raw = el('div', 'life-row');
      raw.appendChild(el('span', 'life-k', 'Set-Cookie 原文'));
      raw.appendChild(el('span', 'life-v mono', ev.raw ? ev.raw : '（引擎内部事件，无对应 Set-Cookie）'));
      raw.querySelector('.life-v').classList.toggle('na', !ev.raw);
      item.appendChild(raw);

      if (ev.type === 'updated') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '覆盖前'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
        const after = el('div', 'life-row');
        after.appendChild(el('span', 'life-k', '覆盖后（重算到期）'));
        after.appendChild(el('span', 'life-v', cookieMini(ev.after)));
        item.appendChild(after);
      } else if (ev.type === 'stored') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '写入前'));
        before.appendChild(el('span', 'life-v', cookieMini(null)));
        item.appendChild(before);
        const after = el('div', 'life-row');
        after.appendChild(el('span', 'life-k', '写入值'));
        after.appendChild(el('span', 'life-v', cookieMini(ev.after)));
        item.appendChild(after);
      } else if (ev.type === 'deleted') {
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '删除前'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
      } else {
        // evicted：记录被淘汰时的状态，以及该次未发送判定命中的全部原因
        const before = el('div', 'life-row');
        before.appendChild(el('span', 'life-k', '淘汰前状态'));
        before.appendChild(el('span', 'life-v', cookieMini(ev.before)));
        item.appendChild(before);
        const reasons = el('div', 'life-row');
        reasons.appendChild(el('span', 'life-k', '本次未发送原因'));
        reasons.appendChild(el('span', 'life-v',
          '<span class="reasons">' + (ev.reasons || [])
            .map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
          '</span>'));
        item.appendChild(reasons);
      }

      const alive = el('div', 'life-row');
      alive.appendChild(el('span', 'life-k', '事件后存活状态'));
      const aliveV = el('span', 'life-v');
      aliveV.innerHTML = aliveLine(ev);
      alive.appendChild(aliveV);
      item.appendChild(alive);

      list.appendChild(item);
    });
    panel.appendChild(list);
  }
}

/** 从轨迹跳回原步骤：滚动到对应结果卡片并短暂高亮（不改动任何编辑内容）。 */
function jumpToStep(stepIndex) {
  const node = document.getElementById('result-step-' + stepIndex);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  node.classList.remove('flash');
  // 强制重排以重新触发动画
  void node.offsetWidth;
  node.classList.add('flash');
}

// ---------- 服务端同名取值 ----------

const SV_VANISH_TEXT = {
  absent: '该名称不再出现在 Cookie 头中',
  single: '同名并列消失，仅剩 1 项',
  'multi-agree': '同名项仍并列，但首末取值转为一致'
};

function svValue(v) {
  return v === '' || v == null ? '(空值)' : String(v);
}

/** 逐请求分析：按实际头顺序、名称区分大小写，给出取首项 / 取末项两种口径的读值。 */
function renderServerViewRequest(a) {
  const wrap = el('div', 'sv-request');
  if (a.empty) {
    wrap.appendChild(el('p', 'jarline', 'Cookie 头为空：服务端读不到任何 Cookie，无同名取值问题。'));
    return wrap;
  }
  const rows = a.groups.map((g) => {
    const lastCell = '<span class="mono">' + esc(svValue(g.last)) + '</span>' +
      (g.multi
        ? (g.divergent ? ' <span class="badge deleted">分歧</span>' : ' <span class="badge attr">首末一致</span>')
        : '');
    const detail = g.items.map((it, k) =>
      '<div class="jarline">#' + (k + 1) + ' <span class="mono">' + esc(svValue(it.value)) + '</span> ' +
      '<span class="badge attr">' + (it.hostOnly ? 'host-only' : 'Domain=' + esc(stripDot(it.domain))) + '</span>' +
      '<span class="badge attr">Path=' + esc(it.path) + '</span>' +
      '<span class="badge attr">创建次序 #' + esc(it.creationOrder == null ? '?' : it.creationOrder) + '</span></div>'
    ).join('');
    return [
      '<span class="mono">' + esc(g.name) + '</span>' +
        (g.multi ? '<div class="jarline">同名 ' + g.items.length + ' 项</div>' : ''),
      '<span class="mono">' + esc(svValue(g.first)) + '</span>',
      lastCell,
      detail
    ];
  });
  wrap.appendChild(tableWith(
    ['名称（区分大小写）', '取首项读到', '取末项读到', '同名组明细（头中顺序 · 值 / 域 / 路径 / 创建次序）'], rows));
  if (a.divergentNames.length) {
    wrap.appendChild(el('p', 'jarline sv-note',
      '⚠ ' + a.divergentNames.map((n) => '<span class="mono">' + esc(n) + '</span>').join('、') +
      ' 的“取首项”与“取末项”读到的值不同：服务端框架解析口径不同会得到不同结果。'));
  } else {
    wrap.appendChild(el('p', 'jarline sv-note', '本请求无同名取值分歧（各名称取首项与取末项一致）。'));
  }
  return wrap;
}

/** 关联事件的一行简介（写入 / 覆盖 / 删除 / 过期淘汰，含键与值变化）。 */
function svEventBrief(ev) {
  const key = '<span class="mono">' + esc(ev.name) + ' @ ' + esc(stripDot(ev.domain)) + ' ' + esc(ev.path) + '</span>';
  switch (ev.type) {
    case 'stored':
      return '<span class="badge stored">写入</span> ' + key +
        ' 值 <span class="mono">' + esc(svValue(ev.after && ev.after.value)) + '</span>';
    case 'updated':
      return '<span class="badge updated">覆盖</span> ' + key +
        ' 值 <span class="mono">' + esc(svValue(ev.before && ev.before.value)) +
        ' → ' + esc(svValue(ev.after && ev.after.value)) + '</span>';
    case 'deleted':
      return '<span class="badge deleted">删除</span> ' + key +
        (ev.before
          ? '（命中，原值 <span class="mono">' + esc(svValue(ev.before.value)) + '</span>）'
          : '（空操作，未命中任何项）');
    case 'evicted':
      return '<span class="badge evicted">过期淘汰</span> ' + key +
        (ev.before ? '（原值 <span class="mono">' + esc(svValue(ev.before.value)) + '</span>）' : '');
    default:
      return esc(ev.type) + ' ' + key;
  }
}

function renderSvTransition(t) {
  const item = el('div', 'sv-transition ' + t.type);

  const top = el('div', 'sv-transition-top');
  const jump = el('button', 'life-jump', '↩ 第 ' + (t.step + 1) + ' 步');
  jump.type = 'button';
  jump.title = '跳转到该有效请求所在步骤';
  jump.addEventListener('click', () => jumpToStep(t.step));
  top.appendChild(jump);
  top.appendChild(el('span', 'life-clock', '⏱ ' + t.clockISO));
  top.appendChild(el('span', 'badge ' + (t.type === 'arise' ? 'deleted' : 'alive'),
    t.type === 'arise' ? '分歧产生' : '分歧消失'));
  item.appendChild(top);

  const row = el('div', 'life-row');
  if (t.type === 'arise') {
    row.appendChild(el('span', 'life-k', '两种取值'));
    row.appendChild(el('span', 'life-v',
      '取首项 = <span class="mono">' + esc(svValue(t.first)) + '</span>；' +
      '取末项 = <span class="mono">' + esc(svValue(t.last)) + '</span>'));
  } else {
    row.appendChild(el('span', 'life-k', '消失原因'));
    row.appendChild(el('span', 'life-v', esc(SV_VANISH_TEXT[t.state] || t.state)));
  }
  item.appendChild(row);

  const evRow = el('div', 'life-row');
  evRow.appendChild(el('span', 'life-k', '关联事件'));
  evRow.appendChild(el('span', 'life-v', t.events.length
    ? t.events.map((ev) => '<div class="jarline">第 ' + (ev.step + 1) + ' 步 · ' + svEventBrief(ev) + '</div>').join('')
    : '<span class="na">（相邻步骤无该名称的写入 / 覆盖 / 删除 / 过期淘汰事件）</span>'));
  item.appendChild(evRow);

  return item;
}

/** 时间线汇总：每个名称的分歧何时产生、何时消失，以及相邻步骤的关联 Jar 事件。 */
function renderServerViewSummary(results) {
  const tl = window.ServerView.analyzeTimeline(results);
  const card = el('div', 'result-card serverview-card');
  const body = el('div', 'result-body');
  body.appendChild(el('div', 'section-title', '🔀 服务端同名取值 · 分歧时间线（沿有效请求）'));

  if (!tl.validCount) {
    body.appendChild(el('p', 'placeholder', '没有有效请求（所有步骤均被跳过）：无服务端取值可分析。'));
    card.appendChild(body);
    return card;
  }

  const diverging = tl.names.filter((n) => n.everDivergent);
  const multiOnly = tl.names.filter((n) => !n.everDivergent && n.everMulti);
  const singleOnly = tl.names.filter((n) => !n.everDivergent && !n.everMulti);
  const emptyCount = tl.validSteps.filter((s) => tl.perStep.get(s).empty).length;

  const stats = ['有效请求 ' + tl.validCount + ' 个'];
  if (emptyCount === tl.validCount) stats.push('全部请求的 Cookie 头为空，服务端读不到任何 Cookie');
  else if (emptyCount > 0) stats.push(emptyCount + ' 个请求的 Cookie 头为空');
  stats.push(diverging.length
    ? '出现过“取首项 ≠ 取末项”分歧的名称 ' + diverging.length + ' 个：' + diverging.map((n) => n.name).join('、')
    : '未出现同名取值分歧');
  body.appendChild(el('p', 'sv-stats', esc(stats.join('；') + '。')));
  body.appendChild(el('p', 'sv-stats',
    '分组与取值按头中原文（名称区分大小写）；关联事件按 Jar 键名称（不区分大小写）匹配相邻步骤的' +
    '写入 / 覆盖 / 删除 / 过期淘汰。同一步先发送后处理响应：本步响应只影响后续请求，不计入本步取值的关联事件。'));

  diverging.forEach((rec) => {
    const block = el('div', 'sv-name');
    block.appendChild(el('div', 'sv-name-head',
      '<span class="mono">' + esc(rec.name) + '</span>' +
      (rec.divergentNow
        ? ' <span class="badge deleted">截至最后一个有效请求仍分歧</span>'
        : ' <span class="badge alive">当前无分歧</span>')));
    const list = el('div', 'sv-transitions');
    rec.transitions.forEach((t) => list.appendChild(renderSvTransition(t)));
    block.appendChild(list);
    body.appendChild(block);
  });

  multiOnly.forEach((rec) => {
    body.appendChild(el('p', 'jarline',
      '名称 <span class="mono">' + esc(rec.name) + '</span>：同名并列出现过，但首末取值始终一致，无分歧。'));
  });
  if (singleOnly.length) {
    body.appendChild(el('p', 'jarline',
      '以下名称从未出现同名并列（取首项与取末项始终一致）：' +
      singleOnly.map((n) => '<span class="mono">' + esc(n.name) + '</span>').join('、')));
  }

  card.appendChild(body);
  return card;
}

// ---------- 最小复现（续） ----------

function minimizePanel() {
  return document.getElementById('minimize-panel');
}

function hideMinimizePanel() {
  const panel = minimizePanel();
  panel.className = 'hidden';
  panel.innerHTML = '';
}

async function minimizeToTarget(stepIndex, kind, idx) {
  const panel = minimizePanel();
  const r = lastResults && lastResults[stepIndex];
  if (!r) return;

  // 目标标识：名称 + 值 + 域 + 路径 + 发送状态；未发送时带上原因集合
  let target;
  if (kind === 'sent') {
    const c = r.sent[idx];
    if (!c) return;
    target = { stepIndex, name: c.name, value: c.value, domain: c.domain, path: c.path, sent: true };
  } else {
    const u = r.unsent[idx];
    if (!u) return;
    target = { stepIndex, name: u.cookie.name, value: u.cookie.value,
      domain: u.cookie.domain, path: u.cookie.path, sent: false, reasons: u.reasons.slice() };
  }

  panel.className = 'minimize-panel';
  panel.innerHTML = '<p class="placeholder">正在最小化：逐项尝试删减并重跑模拟核对目标…</p>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let data;
  try {
    const resp = await fetch('/api/minimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, target, baseTime })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    // 无法定位目标等情况：只提示，不改当前编辑内容
    panel.innerHTML = '';
    const box = el('div', 'error-box', '无法生成最小复现：' + esc(err.message) + '（当前编辑内容未改动）');
    panel.appendChild(box);
    const dismiss = el('button', 'panel-close', '关闭');
    dismiss.type = 'button';
    dismiss.addEventListener('click', hideMinimizePanel);
    panel.appendChild(dismiss);
    return;
  }

  renderMinimizePanel(panel, data, target);
}

function renderMinimizePanel(panel, data, target) {
  panel.innerHTML = '';

  panel.appendChild(el('div', 'section-title', '🎯 最小复现（以第 ' + esc(data.targetStep) + ' 步为结尾）'));
  const targetDesc = (target.sent ? '已发送 ' : '未发送 ') +
    target.name + '=' + target.value + ' @ ' + target.domain + ' ' + target.path +
    (target.sent ? '' : '（原因：' + target.reasons.map((x) => REASON_TEXT[x] || x).join('；') + '）');
  panel.appendChild(el('p', 'minimize-stats',
    '目标：' + esc(targetDesc)));
  panel.appendChild(el('p', 'minimize-stats',
    `缩减前：${data.before.steps} 步 / ${data.before.setCookieLines} 行 Set-Cookie → ` +
    `缩减后：${data.after.steps} 步 / ${data.after.setCookieLines} 行 Set-Cookie。` +
    '目标请求的 URL、方法、顶层页面与导航标记保持不变；被删整步的经过秒数已并入下一保留步，保留请求的绝对时刻不变。'));

  // 预览（载入前不改动编辑器）
  panel.appendChild(el('div', 'section-title', '预览（载入前不会改动当前编辑内容）'));
  const rows = data.steps.map((s, i) => [
    String(i + 1),
    '+' + esc(s.seconds) + 's',
    esc((s.method || 'GET').toUpperCase()) + (s.isNavigation ? ' 🧭' : ''),
    '<span class="mono">' + esc(s.url) + '</span>' +
      (s.topUrl ? `<div class="jarline">顶层：${esc(s.topUrl)}</div>` : ''),
    s.setCookies.length
      ? '<span class="mono">' + s.setCookies.map((line) => esc(line)).join('<br>') + '</span>'
      : '<span class="jarline">（无）</span>'
  ]);
  panel.appendChild(tableWith(['#', '经过秒数', '方法', '请求 URL', 'Set-Cookie'], rows));

  const actions = el('div', 'minimize-actions');
  const load = el('button', 'primary', '✔ 载入到编辑器（替换当前步骤）');
  load.type = 'button';
  load.addEventListener('click', () => {
    steps = deepClone(data.steps);
    renderSteps();
    hideMinimizePanel();
    runSimulation();
  });
  actions.appendChild(load);
  const close = el('button', '', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideMinimizePanel);
  actions.appendChild(close);
  panel.appendChild(actions);
}

// ---------- 策略求解 ----------

function solvePanel() {
  return document.getElementById('solve-panel');
}

function hideSolvePanel() {
  const panel = solvePanel();
  if (!panel) return;
  panel.className = 'hidden';
  panel.innerHTML = '';
}

function solveButton(stepIndex, idx) {
  return `<button type="button" class="solve-target" data-step="${stepIndex}" data-resp="${idx}">🧭 策略求解</button>`;
}

/**
 * 打开求解面板：目标是第 stepIndex 步响应中第 respIdx 条成功写入的 Set-Cookie。
 * 面板列出其后的全部有效请求，允许任选至多 8 步标记应发送 / 不应发送。
 */
function openSolvePanel(stepIndex, respIdx) {
  const panel = solvePanel();
  const r = lastResults && lastResults[stepIndex];
  const resp = r && Array.isArray(r.responses) ? r.responses[respIdx] : null;
  if (!resp || !resp.cookie || (resp.status !== 'stored' && resp.status !== 'updated')) return;

  panel.className = 'solve-panel';
  panel.innerHTML = '';

  const head = el('div', 'solve-head');
  head.appendChild(el('div', 'section-title',
    '🧭 策略求解（目标：第 ' + (stepIndex + 1) + ' 步写入的 ' + esc(resp.cookie.name) + '）'));
  const close = el('button', 'panel-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideSolvePanel);
  head.appendChild(close);
  panel.appendChild(head);

  panel.appendChild(el('p', 'solve-stats',
    '目标 Set-Cookie：<span class="mono">' + esc(resp.raw) + '</span>'));
  panel.appendChild(el('p', 'solve-stats',
    '保持步骤、名称、值、有效期与其他属性不变，只枚举 Domain（host-only / 来源主机及合法父域）、' +
    'Path（/、原路径、标记请求路径的逐级前缀）、SameSite（Strict/Lax/None）与 Secure（有/无）；' +
    '候选须通过现有写入校验，再替换进原响应重跑完整序列核对。多解时按 host-only → Domain 窄到宽 → ' +
    'Path 长到短（同长字典序）→ SameSite Strict/Lax/None → Secure 有/无 取首解。'));

  // 其后的有效请求（URL 非法被跳过的步骤不可标记）
  const markable = [];
  for (let i = stepIndex + 1; i < lastResults.length; i++) {
    if (lastResults[i].request) markable.push(i);
  }
  if (!markable.length) {
    panel.appendChild(el('p', 'placeholder', '该步之后没有有效请求，无法标记发送状态。'));
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  panel.appendChild(el('div', 'section-title',
    '在其后的有效请求上标记该项应发送 / 不应发送（最多 8 个）'));
  const rows = markable.map((i) => {
    const s = lastResults[i];
    const sub = s.topUrl
      ? `<div class="jarline">顶层：${esc(s.topUrl)}${s.isNavigation ? ' · 顶层导航' : ''}</div>`
      : (s.isNavigation ? '<div class="jarline">顶层导航</div>' : '');
    return [
      '第 ' + (i + 1) + ' 步',
      '<span class="mono">' + esc(s.method) + ' ' + esc(s.url) + '</span>' + sub,
      `<select class="solve-mark" data-step="${i}">` +
        '<option value="">不标记</option>' +
        '<option value="send">应发送</option>' +
        '<option value="nosend">不应发送</option>' +
      '</select>'
    ];
  });
  panel.appendChild(tableWith(['步骤', '请求', '标记'], rows));

  const hint = el('p', 'solve-stats', '已标记 0 / 8 个请求。');
  panel.appendChild(hint);

  const actions = el('div', 'solve-actions');
  const go = el('button', 'primary', '🔍 开始求解');
  go.type = 'button';
  actions.appendChild(go);
  const cancel = el('button', '', '关闭');
  cancel.type = 'button';
  cancel.addEventListener('click', hideSolvePanel);
  actions.appendChild(cancel);
  panel.appendChild(actions);

  const resultBox = el('div', 'solve-result');
  panel.appendChild(resultBox);

  const markedSelects = () => [...panel.querySelectorAll('.solve-mark')].filter((x) => x.value !== '');
  panel.querySelectorAll('.solve-mark').forEach((sel) => {
    sel.addEventListener('change', () => {
      const marked = markedSelects();
      if (marked.length > 8) {
        sel.value = '';
        hint.textContent = '最多标记 8 个请求（已超出，本次选择未生效）。';
      } else {
        hint.textContent = '已标记 ' + marked.length + ' / 8 个请求。';
      }
      resultBox.innerHTML = ''; // 标记变化后旧解失效
    });
  });

  go.addEventListener('click', () => {
    const marks = markedSelects().map((x) => ({
      stepIndex: Number(x.dataset.step),
      sent: x.value === 'send'
    }));
    if (!marks.length) {
      hint.textContent = '请至少标记 1 个请求。';
      return;
    }
    runSolve(resultBox, { stepIndex, respIndex: respIdx, raw: resp.raw, marks });
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runSolve(box, target) {
  box.innerHTML = '<p class="placeholder">求解中：枚举候选并重跑完整序列核对…</p>';
  let data;
  try {
    const resp = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, target, baseTime })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    // 目标失效（步骤被改过）等情况：只提示，不改当前编辑内容
    box.innerHTML = '';
    box.appendChild(el('div', 'error-box', '无法求解：' + esc(err.message) + '（当前编辑内容未改动）'));
    return;
  }
  if (!data.ok) {
    // 无解：只提示，不改当前编辑内容
    box.innerHTML = '';
    box.appendChild(el('div', 'error-box', '无解：' + esc(data.error) + '（当前编辑内容未改动）'));
    return;
  }
  renderSolveResult(box, data);
}

function renderSolveResult(box, data) {
  box.innerHTML = '';
  box.appendChild(el('div', 'section-title',
    '✔ 找到首解（共重跑核对 ' + esc(data.attempts) + ' 个通过写入校验的候选）'));

  // 可复制的 Set-Cookie
  const lineWrap = el('div', 'solve-line-wrap');
  lineWrap.appendChild(el('code', 'solve-line', esc(data.setCookie)));
  const copy = el('button', 'solve-copy', '📋 复制');
  copy.type = 'button';
  copy.addEventListener('click', () => copyText(data.setCookie, copy));
  lineWrap.appendChild(copy);
  box.appendChild(lineWrap);

  const a = data.attributes;
  const tags = [a.hostOnly ? 'host-only' : 'Domain=' + stripDot(a.domain), 'Path=' + a.path];
  if (a.secure) tags.push('Secure');
  tags.push('SameSite=' + a.sameSite);
  box.appendChild(el('p', 'solve-stats',
    '属性：' + tags.map((t) => `<span class="badge attr">${esc(t)}</span>`).join('') +
    '（名称、值、有效期与其他属性保持原样）'));

  // 逐步核对结果
  box.appendChild(el('div', 'section-title', '逐步核对（候选替换原响应后重跑完整序列）'));
  const rows = data.checks.map((c) => [
    '第 ' + (c.stepIndex + 1) + ' 步',
    '<span class="mono">' + esc(c.method) + ' ' + esc(c.url) + '</span>',
    c.expected ? '应发送' : '不应发送',
    c.actual
      ? '<span class="badge stored">已发送</span>'
      : '<span class="badge rejected">未发送</span>' +
        (c.reasons && c.reasons.length
          ? '<div class="reasons">' +
            c.reasons.map((x) => `<span class="reason">${esc(REASON_TEXT[x] || x)}</span>`).join('') +
            '</div>'
          : ''),
    c.ok ? '<span class="badge alive">✓ 符合</span>' : '<span class="badge dead">✗ 不符</span>'
  ]);
  box.appendChild(tableWith(['步骤', '请求', '期望', '实际（候选运行）', '核对'], rows));
  box.appendChild(el('p', 'solve-stats',
    '求解只读取当前步骤做演算，不会改动编辑内容；需要时可复制上面的 Set-Cookie，' +
    '手动替换第 ' + (data.writeStep + 1) + ' 步响应中的原行。'));
}

function copyText(text, btn) {
  const done = () => {
    btn.textContent = '✔ 已复制';
    setTimeout(() => { btn.textContent = '📋 复制'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* 忽略 */ }
  document.body.removeChild(ta);
  done();
}

// ---------- 步骤变更影响 ----------

const IMPACT_FIELD_TEXT = {
  url: '请求 URL',
  method: '方法',
  topUrl: '顶层页面 URL',
  isNavigation: '顶层导航标记',
  setCookies: 'Set-Cookie 行'
};

const IMPACT_DIFF_TEXT = {
  name: '名称',
  value: '值',
  key: 'Jar 键',
  reasons: '未发送原因集合',
  status: '处理状态',
  reason: '拒写原因',
  existed: '删除是否命中',
  cookie: '解析出的 Cookie',
  skipped: '请求是否跳过',
  'cookie.name': 'Cookie 名称',
  'cookie.value': 'Cookie 值',
  'cookie.hostOnly': 'host-only / Domain',
  'cookie.domain': '域',
  'cookie.path': '路径',
  'cookie.secure': 'Secure',
  'cookie.sameSite': 'SameSite',
  'cookie.persistent': '是否持久',
  'cookie.expiresISO': '到期时间'
};

const IMPACT_OUTCOME_STATUS_TEXT = {
  stored: '新写入',
  updated: '覆盖更新',
  deleted: '删除',
  rejected: '拒绝写入',
  skipped: '步骤跳过（不处理 Set-Cookie）'
};

function impactPanel() {
  return document.getElementById('impact-panel');
}

function hideImpactPanel() {
  const panel = impactPanel();
  panel.className = 'hidden';
  panel.innerHTML = '';
  impactStep = -1;
  impactReport = null;
}

/**
 * 打开对照面板：基线是最近一次模拟完成时冻结的步骤快照。
 * 面板内修改的只是副本草稿，不会写回编辑器、不会覆盖原步骤。
 */
function openImpactPanel(stepIndex) {
  if (!baselineSteps || !lastResults) return;
  if (stepIndex < 0 || stepIndex >= baselineSteps.length) return;
  impactStep = stepIndex;
  impactReport = null;
  renderImpactPanel(stepIndex);
  impactPanel().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function impactEffectiveStatus(o) {
  if (!o) return null;
  return o.status === 'stored' ? (o.action || 'stored') : o.status;
}

function impactStatusBadge(o) {
  const st = impactEffectiveStatus(o);
  if (!st) return '<span class="na">—（无此行）</span>';
  const cls = st === 'skipped' ? 'attr' : st;
  const extra = st === 'deleted' && o
    ? (o.existed
      ? '<div class="jarline">命中已有项并删除</div>'
      : '<div class="jarline">未命中（删除为空操作）</div>')
    : '';
  const reject = st === 'rejected' && o
    ? '<div class="jarline">' + esc(REJECT_TEXT[o.reason] || o.reason) + '</div>'
    : '';
  return '<span class="badge ' + cls + '">' + esc(IMPACT_OUTCOME_STATUS_TEXT[st] || st) + '</span>' + extra + reject;
}

function renderImpactPanel(stepIndex) {
  const panel = impactPanel();
  panel.innerHTML = '';
  panel.className = 'impact-panel';

  const step = baselineSteps[stepIndex];
  const stale = impactStale();

  const head = el('div', 'life-head');
  head.appendChild(el('div', 'section-title',
    '🔬 步骤变更影响对照（修改第 ' + (stepIndex + 1) + ' 步的副本后重跑）'));
  const close = el('button', 'panel-close', '关闭');
  close.type = 'button';
  close.addEventListener('click', hideImpactPanel);
  head.appendChild(close);
  panel.appendChild(head);

  if (stale) {
    panel.appendChild(el('div', 'warning',
      '⚠ 冻结基线之后编辑器内容已被修改：当前对照已失效。请先点击“▶ 运行模拟”形成新基线，' +
      '再从结果卡片发起对照（对照不覆盖原步骤，下面的副本草稿不会改动编辑内容）。'));
  }

  panel.appendChild(el('p', 'life-stats',
    '基线为最近一次模拟完成时冻结的步骤与结果；仅可修改这一步的' +
    '<strong>请求 URL、方法、顶层页面 URL、顶层导航标记、Set-Cookie 行</strong>，' +
    '其余步骤、顺序与经过秒数保持不变。重跑副本后按步号对照：发送阶段先核对请求是否跳过，' +
    '再按 Cookie 头顺序比较名称、值与 Jar 键；未发送项按名称（忽略大小写）、域、路径对齐，' +
    '比较值、属性与原因集合；响应阶段按非空行序号比较处理状态、拒写原因与解析出的 Cookie；' +
    '步末按同一 Jar 键比较存活项的值与属性。同一步先发送后处理响应：本步响应只能影响后续请求。'));

  // —— 副本修改表单（秒数只读展示：秒数不允许修改）——
  const form = el('div', 'impact-form');
  form.appendChild(el('div', 'section-title', '副本中第 ' + (stepIndex + 1) + ' 步的修改（仅影响副本）'));

  const secondsRow = el('div', 'impact-readonly');
  secondsRow.innerHTML = '<span class="impact-k">经过秒数（保持不变）</span>' +
    '<span class="mono">+' + esc(step.seconds == null ? 0 : step.seconds) + 's</span>';
  form.appendChild(secondsRow);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.value = step.url || '';
  urlInput.placeholder = 'https://example.com/path';
  form.appendChild(impactField('请求 URL（http / https）', urlInput));

  const methodSel = document.createElement('select');
  methodSel.innerHTML = METHODS.map((m) =>
    '<option value="' + m + '"' +
      (m === (step.method || 'GET').toUpperCase() ? ' selected' : '') +
      '>' + m + '</option>').join('');
  methodSel.value = (step.method || 'GET').toUpperCase();
  form.appendChild(impactField('方法', methodSel));

  const topInput = document.createElement('input');
  topInput.type = 'text';
  topInput.value = step.topUrl || '';
  topInput.placeholder = '留空 = 一方请求';
  form.appendChild(impactField('顶层页面 URL', topInput));

  const navLabel = el('label', 'checkline');
  const navInput = document.createElement('input');
  navInput.type = 'checkbox';
  navInput.checked = !!step.isNavigation;
  navLabel.appendChild(navInput);
  navLabel.appendChild(document.createTextNode(' 该请求为顶层导航'));
  form.appendChild(navLabel);

  const scInput = document.createElement('textarea');
  scInput.value = (step.setCookies || []).join('\n');
  scInput.placeholder = '每行一条 Set-Cookie（不要写 Set-Cookie: 前缀）';
  form.appendChild(impactField('Set-Cookie 响应（每行一条；空行将被忽略）', scInput));

  const actions = el('div', 'minimize-actions');
  const run = el('button', 'primary', '🔁 重跑副本并对照');
  run.type = 'button';
  run.disabled = stale;
  run.title = stale ? '基线已失效：请先重新运行模拟' : '冻结其他步骤，只把这一步的修改应用到副本并重跑';
  actions.appendChild(run);
  const cancel = el('button', '', '关闭');
  cancel.type = 'button';
  cancel.addEventListener('click', hideImpactPanel);
  actions.appendChild(cancel);
  form.appendChild(actions);
  panel.appendChild(form);

  const resultBox = el('div', 'impact-result');
  panel.appendChild(resultBox);
  if (impactReport) renderImpactReport(resultBox, impactReport);

  run.addEventListener('click', () => {
    if (impactStale()) return; // 双保险：基线失效时不发起对照
    const change = {
      stepIndex,
      url: urlInput.value,
      method: methodSel.value,
      topUrl: topInput.value,
      isNavigation: navInput.checked,
      setCookies: scInput.value.split('\n')
    };
    runImpactCompare(resultBox, change);
  });
}

function impactField(labelText, inputNode) {
  const f = el('div', 'field');
  const lab = el('label');
  lab.textContent = labelText;
  f.appendChild(lab);
  f.appendChild(inputNode);
  return f;
}

async function runImpactCompare(box, change) {
  box.innerHTML = '<p class="placeholder">对照中：冻结基线，在副本中修改该步并重跑…</p>';
  let data;
  try {
    const resp = await fetch('/api/impact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: baselineSteps, change, baseTime })
    });
    data = await resp.json();
    if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
  } catch (err) {
    // 参数无效等情况：只提示，不改当前编辑内容
    box.innerHTML = '';
    box.appendChild(el('div', 'error-box', '无法对照：' + esc(err.message) + '（当前编辑内容未改动）'));
    return;
  }
  impactReport = data;
  renderImpactReport(box, data);
}

/** 两侧内容并排展示：基线（冻结）/ 副本（修改后）。 */
function impactSideBySide(baselineHtml, copyHtml) {
  const grid = el('div', 'impact-sides');
  const b = el('div', 'impact-side baseline');
  b.appendChild(el('div', 'impact-side-k', '基线（冻结）'));
  const bv = el('div', 'impact-side-v');
  bv.innerHTML = baselineHtml;
  b.appendChild(bv);
  const c = el('div', 'impact-side copy');
  c.appendChild(el('div', 'impact-side-k', '副本（修改后）'));
  const cv = el('div', 'impact-side-v');
  cv.innerHTML = copyHtml;
  c.appendChild(cv);
  grid.appendChild(b);
  grid.appendChild(c);
  return grid;
}

function impactCookieHtml(cookie) {
  if (!cookie) return '<span class="na">—（无此项）</span>';
  return cookieMini(cookie);
}

function impactUnsentHtml(u) {
  if (!u) return '<span class="na">—（无此项）</span>';
  return '<div>' + cookieMini(u.cookie) + '</div>' +
    '<div class="reasons">' + (u.reasons || [])
      .map((x) => '<span class="reason">' + esc(REASON_TEXT[x] || x) + '</span>').join('') +
    '</div>';
}

function impactSentHtml(cookie) {
  if (!cookie) return '<span class="na">—（该位置无发送项）</span>';
  return '<span class="mono">' + esc(cookie.name) + '=' + esc(cookie.value) + '</span>' +
    '<div class="jarline">Jar 键：<span class="mono">' +
    esc(String(cookie.name).toLowerCase()) + ' @ ' + esc(cookie.domain.replace(/^\./, '')) + ' ' +
    esc(cookie.path) + '</span></div>';
}

function impactResponseHtml(o) {
  if (!o) return '<span class="na">—（该序号无 Set-Cookie 行）</span>';
  const raw = '<div class="jarline">原文：<span class="mono">' + esc(o.raw) + '</span></div>';
  const parsed = o.cookie ? '<div class="jarline">' + cookieMini(o.cookie) + '</div>' : '';
  return raw + impactStatusBadge(o) + parsed;
}

function impactSkipHtml(side) {
  return '<span class="badge ' + (side.skipped ? 'rejected' : 'stored') + '">' +
    (side.skipped ? '请求跳过（URL 非法）' : '请求有效（已发送）') + '</span>';
}

function diffFieldText(fields) {
  return (fields || []).map((f) => IMPACT_DIFF_TEXT[f] || f).join('、');
}

/** 渲染单条差异：标题（差异字段）+ 两侧内容。 */
function renderImpactDiff(d) {
  const item = el('div', 'impact-diff ' + d.phase + '-' + d.kind);
  const top = el('div', 'impact-diff-top');
  let title = '';
  if (d.kind === 'skip') title = '请求是否跳过';
  else if (d.kind === 'sent') title = '发送项 #' + (d.ordinal + 1);
  else if (d.kind === 'unsent') title = '未发送项 · Jar 键 <span class="mono">' + esc(d.key) + '</span>';
  else if (d.kind === 'response') title = 'Set-Cookie 第 ' + (d.ordinal + 1) + ' 行（非空行序号）';
  else title = '步末 Jar 项 · <span class="mono">' + esc(d.key) + '</span>';
  top.appendChild(el('span', 'impact-diff-title', title));
  const changed = d.differences && d.differences.length
    ? '<span class="badge rejected">差异：' + esc(diffFieldText(d.differences)) + '</span>'
    : '<span class="badge rejected">仅一侧存在</span>';
  top.appendChild(el('span', 'impact-diff-fields', changed));
  item.appendChild(top);

  let html;
  if (d.kind === 'skip') {
    html = impactSideBySide(impactSkipHtml(d.baseline), impactSkipHtml(d.copy));
  } else if (d.kind === 'sent') {
    html = impactSideBySide(impactSentHtml(d.baseline), impactSentHtml(d.copy));
  } else if (d.kind === 'unsent') {
    html = impactSideBySide(impactUnsentHtml(d.baseline), impactUnsentHtml(d.copy));
  } else if (d.kind === 'response') {
    html = impactSideBySide(impactResponseHtml(d.baseline), impactResponseHtml(d.copy));
  } else {
    html = impactSideBySide(impactCookieHtml(d.baseline), impactCookieHtml(d.copy));
  }
  item.appendChild(html);
  return item;
}

const PHASE_TITLE = {
  send: '发送阶段（① 判定发送）',
  response: '响应阶段（② 应用 Set-Cookie）',
  jar: '步末（Cookie Jar 快照）'
};

function renderImpactStepBlock(sd) {
  const block = el('div', 'impact-step');
  const head = el('div', 'impact-step-head');
  head.appendChild(el('span', 'life-jump impact-step-jump', '↩ 第 ' + (sd.step + 1) + ' 步'));
  head.appendChild(el('span', 'jarline',
    '<span class="mono">' + esc(sd.baselineRequest.method) + ' ' + esc(sd.baselineRequest.url || '(未填写)') + '</span>' +
    (sd.baselineRequest.skipped ? ' · 基线跳过' : '') +
    ' → ' +
    '<span class="mono">' + esc(sd.copyRequest.method) + ' ' + esc(sd.copyRequest.url || '(未填写)') + '</span>' +
    (sd.copyRequest.skipped ? ' · 副本跳过' : '')));
  block.appendChild(head);

  for (const phase of ['send', 'response', 'jar']) {
    const list = sd.diffs.filter((d) => d.phase === phase);
    if (!list.length) continue;
    block.appendChild(el('div', 'section-title', PHASE_TITLE[phase] + '（' + list.length + ' 处差异）'));
    list.forEach((d) => block.appendChild(renderImpactDiff(d)));
  }
  return block;
}

function renderImpactReport(box, data) {
  box.innerHTML = '';

  const changeLine = el('p', 'life-stats',
    '实际修改字段：' + (data.changedFields.length
      ? data.changedFields.map((f) => '<span class="badge attr">' + esc(IMPACT_FIELD_TEXT[f] || f) + '</span>').join(' ')
      : '<span class="jarline muted">无（副本与基线该步完全相同）</span>') +
    '；其余步骤、顺序与经过秒数保持不变。');
  box.appendChild(changeLine);

  if (data.identical) {
    const okBox = el('div', 'impact-identical');
    okBox.appendChild(el('div', 'section-title', '✔ 无差异'));
    okBox.appendChild(el('p', 'jarline',
      '副本重跑后，各步的发送项 / 未发送项（含原因集合）/ Set-Cookie 处理结果 / 步末 Jar ' +
      '与冻结基线完全一致：这次修改没有影响任何步骤的模拟结果。'));
    box.appendChild(okBox);
    return;
  }

  // 首个差异（严格按 发送 → 响应 → 步末 的执行顺序）
  const fd = data.firstDiff;
  const firstBox = el('div', 'impact-first');
  firstBox.appendChild(el('div', 'section-title',
    '首个差异：第 ' + (fd.step + 1) + ' 步 · ' + esc(PHASE_TITLE[fd.phase]) +
    ' · ' + (fd.kind === 'skip' ? '请求是否跳过'
      : fd.kind === 'sent' ? '发送项 #' + (fd.ordinal + 1)
      : fd.kind === 'response' ? 'Set-Cookie 第 ' + (fd.ordinal + 1) + ' 行'
      : (fd.kind === 'unsent' ? '未发送项' : '步末 Jar 项'))));
  firstBox.appendChild(renderImpactDiff(fd));
  box.appendChild(firstBox);

  // 后续受影响步骤
  const laterSteps = data.affectedSteps.filter((s) => s !== fd.step);
  box.appendChild(el('p', 'life-stats',
    '受影响步骤共 ' + data.affectedSteps.length + ' 个（按步号）：' +
    data.affectedSteps.map((s) => '<button type="button" class="impact-chip" data-step="' + s + '">第 ' + (s + 1) + ' 步</button>').join(' ') +
    (laterSteps.length ? '；其中首个差异之后的受影响步骤：' + laterSteps.map((s) => '第 ' + (s + 1) + ' 步').join('、') + '。' : '；无后续受影响步骤。') +
    '本步响应只能影响后续请求，变更步之前不可能出现差异。'));

  const detail = el('div', 'impact-detail');
  detail.appendChild(el('div', 'section-title', '逐差异对照（基线 / 副本两侧内容）'));
  data.stepDiffs.forEach((sd) => {
    const block = renderImpactStepBlock(sd);
    block.id = 'impact-step-' + sd.step;
    detail.appendChild(block);
  });
  box.appendChild(detail);

  // ↩ 跳转与受影响步骤小芯片：滚动到对照区对应步块
  box.querySelectorAll('.impact-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const node = box.querySelector('#impact-step-' + Number(chip.dataset.step));
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  box.querySelectorAll('.impact-step-jump').forEach((btn) => {
    btn.addEventListener('click', () => {
      const block = btn.closest('.impact-step');
      if (!block) return;
      const s = Number(block.id.replace('impact-step-', ''));
      jumpToStep(s); // 复用生命周期面板的滚动 + 高亮（不改动任何编辑内容）
    });
  });
}

// ---------- 本地 HAR 导入 ----------

/** 模拟起点指示：默认基准时钟，或 HAR 首条记录时间（Expires 按抓包绝对时间判定）。 */
function renderBaseTime() {
  const bar = document.getElementById('base-time');
  bar.innerHTML = '';
  const ms = baseTime === null ? DEFAULT_BASE_TIME : baseTime;
  bar.appendChild(el('span', 'base-time-label',
    '模拟起点 <code>' + esc(new Date(ms).toISOString()) + '</code>' +
    (baseTime === null ? '（默认）' : '（来自 HAR 导入，Expires 按抓包绝对时间判定）')));
  if (baseTime !== null) {
    const reset = el('button', 'base-time-reset', '恢复默认起点');
    reset.type = 'button';
    reset.title = '放弃 HAR 起点，恢复默认基准时钟并重新运行模拟';
    reset.addEventListener('click', () => {
      baseTime = null;
      renderBaseTime();
      runSimulation();
    });
    bar.appendChild(reset);
  }
}

function harPanel() {
  return document.getElementById('har-panel');
}

/** 关闭预览（取消）：不改动任何编辑内容。 */
function hideHarPanel() {
  const panel = harPanel();
  panel.className = 'hidden';
  panel.innerHTML = '';
  harState = null;
}

document.getElementById('btn-har').addEventListener('click', () => {
  document.getElementById('har-file').click();
});

document.getElementById('har-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 允许再次选择同一文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => openHarPreview(String(reader.result == null ? '' : reader.result),
    file.name || 'HAR 文件');
  reader.onerror = () => {
    harState = { fileName: file.name || 'HAR 文件', error: '文件读取失败', rows: [] };
    renderHarPanel();
  };
  reader.readAsText(file);
});

/** 解析并评估所选文件，打开预览；文件无效时只提示，不改动编辑内容。 */
function openHarPreview(text, fileName) {
  const parsed = window.HarImport.parseHarText(text);
  if (!parsed.ok) {
    harState = { fileName, error: parsed.error, rows: [] };
  } else {
    const rows = window.HarImport.assessEntries(parsed.entries, METHODS);
    // 默认勾选前 100 条可导入记录；顶层页面 URL 与导航标记不从 HAR 推断，留待逐条确认
    let n = 0;
    rows.forEach((r) => {
      r.checked = r.importable && n < window.HarImport.MAX_SELECTION;
      if (r.checked) n++;
      r.topUrl = '';
      r.isNavigation = false;
    });
    harState = { fileName, error: null, rows };
  }
  renderHarPanel();
}

function renderHarPanel() {
  const panel = harPanel();
  panel.innerHTML = '';
  panel.className = 'har-overlay';

  const dialog = el('div', 'har-dialog');
  const head = el('div', 'har-head');
  head.appendChild(el('div', 'section-title', '📥 导入 HAR：' + esc(harState.fileName)));
  const close = el('button', 'panel-close', '取消');
  close.type = 'button';
  close.addEventListener('click', hideHarPanel);
  head.appendChild(close);
  dialog.appendChild(head);

  if (harState.error) {
    dialog.appendChild(el('div', 'error-box',
      '文件无效：' + esc(harState.error) + '（当前编辑内容未改动）'));
    panel.appendChild(dialog);
    return;
  }

  const rows = harState.rows;
  if (!rows.length) {
    dialog.appendChild(el('p', 'placeholder',
      'log.entries 为空，没有可导入的记录。（当前编辑内容未改动）'));
    panel.appendChild(dialog);
    return;
  }

  dialog.appendChild(el('p', 'har-live-stats')); // 选中统计（refreshHarPlan 填充）
  dialog.appendChild(el('p', 'har-stats',
    '仅可勾选 http(s) 且方法受支持、startedDateTime 带时区、time 非负有限的记录（最多 ' +
    window.HarImport.MAX_SELECTION + ' 条）；按开始时间排序（同刻保留原行序），' +
    '相邻时间差生成经过秒数（毫秒精度，首条为 0）。Set-Cookie 按 response.headers 原顺序逐条取值' +
    '（头名不区分大小写，不按逗号拆分）。顶层页面 URL 与顶层导航标记不从 HAR 推断，请逐条确认。'));

  // 预览表格：可导入的按开始时间排序在前，不可导入的按原行序附后（不可勾选）
  const displayRows = rows.slice().sort((a, b) => {
    if (a.importable !== b.importable) return a.importable ? -1 : 1;
    if (a.importable) return a.startMs - b.startMs || a.index - b.index;
    return a.index - b.index;
  });
  const table = el('table', 'har-table');
  table.innerHTML = '<thead><tr>' +
    ['', '#', '方法', '请求 URL', '开始时间', '耗时', '经过秒数', 'Set-Cookie',
      '顶层页面 URL（可留空 = 一方请求）', '顶层导航']
      .map((h) => '<th>' + esc(h) + '</th>').join('') +
    '</tr></thead>';
  const tbody = el('tbody');
  displayRows.forEach((row) => tbody.appendChild(renderHarRow(row)));
  table.appendChild(tbody);
  dialog.appendChild(table);

  dialog.appendChild(el('div', 'har-overlap-warn'));

  const actions = el('div', 'har-actions');
  const confirm = el('button', 'primary har-confirm', '✔ 确认导入（替换当前步骤）');
  confirm.type = 'button';
  confirm.addEventListener('click', confirmHarImport);
  actions.appendChild(confirm);
  const cancel = el('button', '', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', hideHarPanel);
  actions.appendChild(cancel);
  dialog.appendChild(actions);

  panel.appendChild(dialog);
  refreshHarPlan();
}

function harTd(text, cls) {
  const c = el('td', cls);
  c.textContent = text;
  return c;
}

function renderHarRow(row) {
  const tr = el('tr');
  tr.dataset.index = row.index;
  if (!row.importable) tr.classList.add('har-disabled');

  const tdCheck = el('td');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'har-check';
  check.checked = !!row.checked;
  check.disabled = !row.importable;
  check.addEventListener('change', () => {
    if (check.checked) {
      const selected = harState.rows.filter((r) => r.checked && r.importable).length;
      if (selected >= window.HarImport.MAX_SELECTION) {
        check.checked = false; // 至多 100 条：本次勾选不生效
        refreshHarPlan('最多勾选 ' + window.HarImport.MAX_SELECTION + ' 条记录（本次勾选未生效）。');
        return;
      }
    }
    row.checked = check.checked;
    refreshHarPlan();
  });
  tdCheck.appendChild(check);
  tr.appendChild(tdCheck);

  tr.appendChild(harTd(String(row.index + 1)));
  tr.appendChild(harTd(row.method || '—', 'mono'));

  const tdUrl = el('td', 'har-url');
  tdUrl.appendChild(el('span', 'mono', esc(row.url || '(缺失)')));
  row.problems.forEach((p) => tdUrl.appendChild(el('div', 'har-problem', '⚠ ' + esc(p))));
  tr.appendChild(tdUrl);

  tr.appendChild(harTd(row.startISO || '—', 'mono'));
  tr.appendChild(harTd(row.timeMs === null ? '—' : row.timeMs + ' ms', 'mono'));
  tr.appendChild(harTd('—', 'mono har-seconds'));

  const tdSc = el('td');
  if (row.setCookies.length) {
    tdSc.textContent = row.setCookies.length + ' 条';
    tdSc.title = row.setCookies.join('\n');
  } else {
    tdSc.textContent = '—';
  }
  tr.appendChild(tdSc);

  const tdTop = el('td');
  const topInput = document.createElement('input');
  topInput.type = 'text';
  topInput.className = 'har-top';
  topInput.placeholder = '留空 = 一方请求';
  topInput.value = row.topUrl || '';
  topInput.disabled = !row.importable;
  topInput.addEventListener('input', () => { row.topUrl = topInput.value; });
  tdTop.appendChild(topInput);
  tr.appendChild(tdTop);

  const tdNav = el('td');
  const nav = document.createElement('input');
  nav.type = 'checkbox';
  nav.className = 'har-nav';
  nav.checked = !!row.isNavigation;
  nav.disabled = !row.importable;
  nav.addEventListener('change', () => { row.isNavigation = nav.checked; });
  tdNav.appendChild(nav);
  tr.appendChild(tdNav);

  return tr;
}

/** 按当前勾选重算排序、经过秒数与重叠标记；重叠或空选择时禁用确认。 */
function refreshHarPlan(hint) {
  if (!harState || harState.error) return;
  const panel = harPanel();
  const rows = harState.rows;
  const plan = window.HarImport.buildPlan(rows.filter((r) => r.checked && r.importable));

  const secByIndex = new Map();
  plan.items.forEach((it) => secByIndex.set(it.row.index, it.seconds));
  const overlapIdx = new Set();
  plan.overlaps.forEach((p) => { overlapIdx.add(p.a.index); overlapIdx.add(p.b.index); });

  panel.querySelectorAll('tr[data-index]').forEach((tr) => {
    const idx = Number(tr.dataset.index);
    const cell = tr.querySelector('.har-seconds');
    if (cell) cell.textContent = secByIndex.has(idx) ? '+' + secByIndex.get(idx) + 's' : '—';
    tr.classList.toggle('har-overlap', overlapIdx.has(idx));
  });

  const importableCount = rows.filter((r) => r.importable).length;
  let text = '共 ' + rows.length + ' 条记录：可导入 ' + importableCount + ' 条，不可导入 ' +
    (rows.length - importableCount) + ' 条；已勾选 ' + plan.count + ' / ' +
    window.HarImport.MAX_SELECTION + '。';
  if (plan.baseTime !== null) {
    text += '确认后以首条记录时间 ' + new Date(plan.baseTime).toISOString() +
      ' 为本次模拟起点，最小复现、策略求解与影响对照沿用该起点。';
  }
  if (hint) text += hint;
  panel.querySelector('.har-live-stats').textContent = text;

  const warn = panel.querySelector('.har-overlap-warn');
  warn.innerHTML = '';
  if (plan.overlaps.length) {
    const lines = plan.overlaps.map((p) =>
      '第 ' + (p.a.index + 1) + ' 条（响应结束 ' + new Date(p.a.endMs).toISOString() +
      '）× 第 ' + (p.b.index + 1) + ' 条（请求开始 ' + new Date(p.b.startMs).toISOString() + '）');
    warn.appendChild(el('div', 'error-box',
      '⚠ 时间重叠：前一响应结束晚于下一请求开始，已标出 ' + plan.overlaps.length +
      ' 处并阻止载入：<br>' + lines.map(esc).join('<br>')));
  }

  const confirm = panel.querySelector('.har-confirm');
  confirm.disabled = !plan.count || plan.overlaps.length > 0;
  confirm.title = !plan.count ? '请至少勾选 1 条可导入记录'
    : plan.overlaps.length ? '存在时间重叠，无法载入'
    : '';
}

/** 确认导入：替换编辑步骤，以首条记录时间为本次模拟起点。 */
function confirmHarImport() {
  if (!harState || harState.error) return;
  const plan = window.HarImport.buildPlan(
    harState.rows.filter((r) => r.checked && r.importable));
  if (!plan.count || plan.overlaps.length) return; // 空选择或时间重叠：阻止载入
  steps = plan.items.map((it) => ({
    seconds: it.seconds,
    url: it.row.url,
    method: it.row.method,
    topUrl: (it.row.topUrl || '').trim(),
    isNavigation: !!it.row.isNavigation,
    setCookies: it.row.setCookies.slice()
  }));
  baseTime = plan.baseTime;
  hideHarPanel();
  renderSteps();
  renderBaseTime();
  runSimulation();
}

// 启动时自动载入并运行示例 1
renderBaseTime();
renderSteps();
runSimulation();
