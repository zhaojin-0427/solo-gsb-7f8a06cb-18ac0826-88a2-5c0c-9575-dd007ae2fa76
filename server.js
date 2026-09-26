'use strict';

const path = require('path');
const express = require('express');
const { runSimulation } = require('./lib/simulate');
const { minimizeSteps } = require('./lib/minimize');
const { solveStrategy } = require('./lib/solve');
const { compareSteps } = require('./lib/impact');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// 模拟执行：{ steps: [...] }
app.post('/api/simulate', (req, res) => {
  const steps = Array.isArray(req.body && req.body.steps) ? req.body.steps : null;
  if (!steps) {
    return res.status(400).json({ error: '请求体需要包含 steps 数组' });
  }
  if (steps.length > 100) {
    return res.status(400).json({ error: '一次最多 100 个步骤' });
  }
  try {
    const normalized = steps.map((s) => ({
      seconds: s && s.seconds,
      url: s && s.url,
      method: s && s.method,
      topUrl: s && s.topUrl,
      isNavigation: s && s.isNavigation,
      setCookies: Array.isArray(s && s.setCookies) ? s.setCookies : []
    }));
    res.json(runSimulation(normalized));
  } catch (err) {
    res.status(500).json({ error: '模拟执行失败：' + err.message });
  }
});

// 最小复现：{ steps: [...], target: { stepIndex, name, value, domain, path, sent, reasons? } }
app.post('/api/minimize', (req, res) => {
  const steps = Array.isArray(req.body && req.body.steps) ? req.body.steps : null;
  const target = req.body && req.body.target;
  if (!steps) {
    return res.status(400).json({ error: '请求体需要包含 steps 数组' });
  }
  if (steps.length > 100) {
    return res.status(400).json({ error: '一次最多 100 个步骤' });
  }
  if (!target || typeof target !== 'object') {
    return res.status(400).json({ error: '请求体需要包含 target 对象' });
  }
  try {
    const out = minimizeSteps(steps, target);
    if (!out.ok) {
      // 无法定位目标：提示调用方，不改动任何编辑内容
      return res.status(404).json({ error: out.error });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: '最小复现失败：' + err.message });
  }
});

// 策略求解：{ steps: [...], target: { stepIndex, respIndex, raw?, marks: [{stepIndex, sent}] } }
app.post('/api/solve', (req, res) => {
  const steps = Array.isArray(req.body && req.body.steps) ? req.body.steps : null;
  const target = req.body && req.body.target;
  if (!steps) {
    return res.status(400).json({ error: '请求体需要包含 steps 数组' });
  }
  if (steps.length > 100) {
    return res.status(400).json({ error: '一次最多 100 个步骤' });
  }
  if (!target || typeof target !== 'object') {
    return res.status(400).json({ error: '请求体需要包含 target 对象' });
  }
  try {
    const out = solveStrategy(steps, target);
    if (!out.ok && out.invalid) {
      // 目标 / 标记无效（含步骤已被修改）：提示调用方，不改动任何编辑内容
      return res.status(404).json({ error: out.error });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: '策略求解失败：' + err.message });
  }
});

// 步骤变更影响：{ steps: [...], change: { stepIndex, url?, method?, topUrl?, isNavigation?, setCookies? } }
app.post('/api/impact', (req, res) => {
  const steps = Array.isArray(req.body && req.body.steps) ? req.body.steps : null;
  const change = req.body && req.body.change;
  if (!steps) {
    return res.status(400).json({ error: '请求体需要包含 steps 数组' });
  }
  if (steps.length > 100) {
    return res.status(400).json({ error: '一次最多 100 个步骤' });
  }
  if (!change || typeof change !== 'object') {
    return res.status(400).json({ error: '请求体需要包含 change 对象' });
  }
  try {
    const out = compareSteps(steps, change);
    if (!out.ok && out.invalid) {
      // 变更参数无效（含步下标越界）：提示调用方，不改动任何编辑内容
      return res.status(404).json({ error: out.error });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: '步骤变更影响对照失败：' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cookie 决策实验室已启动: http://localhost:${PORT}`);
});
