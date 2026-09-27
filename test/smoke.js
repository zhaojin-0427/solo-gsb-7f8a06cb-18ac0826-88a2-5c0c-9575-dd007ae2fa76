'use strict';

// 冒烟测试：直接跑引擎核心逻辑（node test/smoke.js）
const assert = require('assert');
const { runSimulation } = require('../lib/simulate');
const { minimizeSteps, targetMatches } = require('../lib/minimize');
const { parseSetCookie, CookieJar, selectForRequest, domainMatches, pathMatches } = require('../lib/cookies');
const { siteKey, isSameSite } = require('../lib/site');
const { isPublicSuffix, analyzeDomain, isIpAddress, normalizeHostname, parsePsl } = require('../lib/psl');
const { normalizeStep } = require('../lib/minimize');

let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// --- 基础匹配 ---
ok(domainMatches('a.example.com', 'example.com'));
ok(domainMatches('example.com', 'example.com'));
ok(!domainMatches('notexample.com', 'example.com'));
ok(pathMatches('/app/x', '/app/'));
ok(pathMatches('/app', '/app'));
ok(pathMatches('/appx', '/app') === false);
ok(pathMatches('/app2/x', '/app') === false);

// --- 站判断 ---
assert.strictEqual(siteKey('https://www.example.com/a'), 'https://example.com');
assert.strictEqual(siteKey('http://a.b.co.uk:8080'), 'http://b.co.uk');
assert.strictEqual(siteKey('http://192.168.1.1:9000'), 'http://192.168.1.1');
assert.strictEqual(isSameSite('https://a.example.com', 'https://www.example.com/p'), true);
assert.strictEqual(isSameSite('https://example.com', 'http://example.com'), false); // schemeful
assert.strictEqual(isSameSite('https://example.co.uk', 'https://evil.co.uk'), false);
ok(isPublicSuffix('com'));
ok(isPublicSuffix('co.uk'));
ok(!isPublicSuffix('example.com'));

// --- Set-Cookie 写入校验 ---
const now = Date.parse('2026-01-01T00:00:00Z');
ok(parseSetCookie('a=1; Domain=evil.com', { scheme: 'https', host: 'example.com' }, now).reason === 'DOMAIN_MISMATCH');
ok(parseSetCookie('a=1; Domain=com', { scheme: 'https', host: 'x.com' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('a=1; Domain=co.uk', { scheme: 'https', host: 'x.co.uk' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('a=1; SameSite=None', { scheme: 'https', host: 'example.com' }, now).reason === 'SAMESITE_NONE_SECURE');
const pc = parseSetCookie('sid=abc; Path=/app; Max-Age=60', { scheme: 'https', host: 'shop.example.com' }, now);
ok(pc.ok && pc.cookie.domain === 'shop.example.com' && pc.cookie.hostOnly === true);
ok(pc.cookie.path === '/app' && pc.cookie.expires === now + 60000);
const def = parseSetCookie('sid=abc', { scheme: 'https', host: 'h.example.com' }, now);
ok(def.cookie.path === '/' && def.cookie.sameSite === 'Lax');

// --- 完整示例：完整流程 ---
const stepsA = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'sid=abc123; Domain=example.com; Path=/; Max-Age=3600',
      'cart=2; Path=/cart',
      'track=xyz; Domain=example.com; SameSite=None; Secure; Max-Age=7200'
    ] },
  { seconds: 5, url: 'https://api.shop.example.com/v1/user', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: [] },
  { seconds: 3600, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://ads.net/track', method: 'POST', topUrl: 'https://shop.example.com/home', isNavigation: false,
    setCookies: ['p=1; Path=/'] },
  { seconds: 1, url: 'https://ads.net/landing', method: 'GET', topUrl: 'https://ads.net/', isNavigation: true, setCookies: [] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=; Domain=example.com; Path=/; Max-Age=0'] }
];
const simA = runSimulation(stepsA).results;
ok(simA[0].sent.length === 0 && simA[0].responses.length === 3);
assert.deepStrictEqual(simA[1].sent.map((c) => c.name), ['sid', 'track']);
ok(simA[1].unsent.find((u) => u.cookie.name === 'cart').reasons.includes('PATH'));
ok(simA[1].unsent.find((u) => u.cookie.name === 'cart').reasons.includes('DOMAIN'));
assert.deepStrictEqual(simA[2].sent.map((c) => c.name), ['track'], 'sid 已过期');
ok(simA[2].sent.length === 1);
ok(simA[3].sent.length === 0, '跨站 POST 无 Cookie');
const trackUnsent = simA[3].unsent.find((u) => u.cookie.name === 'track');
ok(trackUnsent && trackUnsent.reasons.includes('DOMAIN') && !trackUnsent.reasons.includes('SAMESITE_LAX'),
  'None 不因跨站拦截（此处仅因域不匹配不发送）');
// ads.net 自己的 p
assert.deepStrictEqual(simA[4].sent.map((c) => c.name), ['p'], 'Lax 跨站顶层 GET 放行');
ok(simA[5].responses[0].status === 'deleted');
ok(simA[5].jarAfter.find((c) => c.name === 'sid') === undefined);
ok(simA[5].jarAfter.find((c) => c.name === 'track'));

// --- 非法 Set-Cookie 示例 ---
const simB = runSimulation([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [
    'a=1; Domain=evil.org',
    'b=2; Domain=com',
    'c=3; SameSite=None',
    'd=4; Path=/ok',
    'e=5; Path=relative',
    'f=6; Domain=.example.com'
  ] }
]).results[0];
assert.deepStrictEqual(simB.responses.map((r) => r.status),
  ['rejected', 'rejected', 'rejected', 'stored', 'stored', 'stored']);
assert.deepStrictEqual(simB.responses.map((r) => r.reason).filter(Boolean),
  ['DOMAIN_MISMATCH', 'PUBLIC_SUFFIX', 'SAMESITE_NONE_SECURE']);
const eCookie = simB.responses.find((r) => r.raw.startsWith('e=')).cookie;
ok(eCookie.path === '/', '非法 path 回退为 /');
ok(simB.responses.find((r) => r.raw.startsWith('f=')).cookie.domain === '.example.com');

// --- Secure 与同站协议 ---
const simC = runSimulation([
  { seconds: 0, url: 'https://example.com/', method: 'GET', setCookies: ['sec=1; Secure; Path=/', 'plain=1; Path=/'] },
  { seconds: 1, url: 'http://example.com/', method: 'GET', setCookies: [] }
]).results;
assert.deepStrictEqual(simC[1].sent.map((c) => c.name), ['plain']);
ok(simC[1].unsent.find((u) => u.cookie.name === 'sec').reasons.includes('NOT_HTTPS'));

// --- 完整离线 PSL：私有后缀 / 通配最长匹配 / 例外优先 / 边界回归 ---

// 漏洞场景：s3.amazonaws.com 是 PSL 私有后缀
ok(isPublicSuffix('s3.amazonaws.com'), 's3.amazonaws.com 是公共后缀（PRIVATE DOMAINS）');
ok(!isPublicSuffix('alice.s3.amazonaws.com'), '桶主机本身不是公共后缀');
ok(analyzeDomain('alice.s3.amazonaws.com').registrable === 'alice.s3.amazonaws.com');
ok(analyzeDomain('bob.s3.amazonaws.com').registrable === 'bob.s3.amazonaws.com');
assert.strictEqual(
  isSameSite('https://alice.s3.amazonaws.com/', 'https://bob.s3.amazonaws.com/'), false,
  '两个 S3 桶跨站'
);
assert.strictEqual(
  isSameSite('https://alice.s3.amazonaws.com/a', 'https://alice.s3.amazonaws.com/b'), true,
  '同一个 S3 桶内部同站'
);
// Domain=s3.amazonaws.com 必须以公共后缀为由拒绝
ok(parseSetCookie('sid=1; Domain=s3.amazonaws.com; Path=/',
  { scheme: 'https', host: 'alice.s3.amazonaws.com' }, now).reason === 'PUBLIC_SUFFIX');
// 可注册域（非后缀）仍可写 Domain
ok(parseSetCookie('sid=1; Domain=amazonaws.com; Path=/',
  { scheme: 'https', host: 'amazonaws.com' }, now).ok === true);

// 其他私有后缀（github.io 精确、*.compute.herokuapp.com / *.platformsh.site 通配）
ok(isPublicSuffix('github.io'));
assert.strictEqual(isSameSite('https://a.github.io/', 'https://b.github.io/'), false);
ok(parseSetCookie('x=1; Domain=github.io',
  { scheme: 'https', host: 'a.github.io' }, now).reason === 'PUBLIC_SUFFIX');
ok(isPublicSuffix('herokuapp.com'));
ok(!isPublicSuffix('foo.herokuapp.com'), 'foo.herokuapp.com 是可注册域而非后缀');
ok(analyzeDomain('foo.herokuapp.com').registrable === 'foo.herokuapp.com');
ok(isPublicSuffix('app.compute.herokuapp.com'));
ok(analyzeDomain('app.compute.herokuapp.com').registrable === null);
ok(analyzeDomain('x.app.compute.herokuapp.com').registrable === 'x.app.compute.herokuapp.com');
ok(isPublicSuffix('tenant.platformsh.site'));
ok(analyzeDomain('a.platformsh.site').registrable === null, '通配命中本身是后缀');
ok(analyzeDomain('x.a.platformsh.site').registrable === 'x.a.platformsh.site');

// 通配规则：*.ck / *.kobe.jp —— 最长匹配
ok(isPublicSuffix('xyz.ck'), '通配 *.ck 使 xyz.ck 成为后缀');
ok(analyzeDomain('a.xyz.ck').registrable === 'a.xyz.ck');
ok(isPublicSuffix('foo.kobe.jp'));
ok(analyzeDomain('x.foo.kobe.jp').registrable === 'x.foo.kobe.jp');
// 例外规则优先：!www.ck、!city.kobe.jp
ok(!isPublicSuffix('www.ck'), '例外规则：www.ck 不是后缀而是可注册域');
ok(analyzeDomain('www.ck').registrable === 'www.ck');
ok(analyzeDomain('sub.www.ck').registrable === 'www.ck');
ok(!isPublicSuffix('city.kobe.jp'), '例外规则：city.kobe.jp 是可注册域');
ok(analyzeDomain('city.kobe.jp').registrable === 'city.kobe.jp');
ok(analyzeDomain('a.city.kobe.jp').registrable === 'city.kobe.jp');
// 多标签主机下，更具体的规则覆盖更短规则（最长匹配）
ok(analyzeDomain('shop.example.co.uk').registrable === 'example.co.uk');

// 漏洞场景端到端：写入被拒 + 跨桶不发送 + 判为跨站
const simS3 = runSimulation([
  { seconds: 0, url: 'https://alice.s3.amazonaws.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=1; Domain=s3.amazonaws.com; Path=/', 'own=1; Path=/'] },
  { seconds: 1, url: 'https://bob.s3.amazonaws.com/', method: 'GET',
    topUrl: 'https://alice.s3.amazonaws.com/home', isNavigation: false, setCookies: [] }
]).results;
assert.strictEqual(simS3[0].responses[0].status, 'rejected');
assert.strictEqual(simS3[0].responses[0].reason, 'PUBLIC_SUFFIX');
assert.strictEqual(simS3[0].responses[1].status, 'stored');
assert.strictEqual(simS3[1].crossSite, true, 'bob 相对 alice 是跨站');
assert.strictEqual(simS3[1].cookieHeader, '', 'alice 的 host-only Cookie 不发给 bob');
ok(simS3[1].unsent.find((u) => u.cookie.name === 'own').reasons.includes('DOMAIN'));

// --- 国际化域名（IDN）：Unicode 规则 / 主机 / Cookie Domain 统一为 ASCII ---

// 规则加载归一化：精确、通配、例外三种形式中的 Unicode 域名都转 punycode
const idnRules = parsePsl([
  '// ===BEGIN ICANN DOMAINS===',
  '公司.cn',
  '*.公司.hk',
  '!www.公司.hk',
  'xn--fiqs8s'
].join('\n'));
ok(idnRules.exact.has('xn--55qx5d.cn'), '精确规则中的 Unicode 域名转为 punycode');
ok(idnRules.wildcard.has('xn--55qx5d.hk'), '通配规则中的 Unicode 域名转为 punycode');
ok(idnRules.exceptions.has('www.xn--55qx5d.hk'), '例外规则中的 Unicode 域名转为 punycode');
ok(idnRules.exact.has('xn--fiqs8s'), '已是 punycode 的规则保持不变');

// 主机归一化：Unicode 与 punycode 得到同一表示
assert.strictEqual(normalizeHostname('Alice.公司.cn.'), 'alice.xn--55qx5d.cn');
assert.strictEqual(normalizeHostname('alice.xn--55qx5d.cn'), 'alice.xn--55qx5d.cn');

// 公共后缀判断：公司.cn（PSL 中以 Unicode 书写）两种写法都命中
ok(isPublicSuffix('xn--55qx5d.cn'), '公司.cn 的 punycode 形式是公共后缀');
ok(isPublicSuffix('公司.cn'), '公司.cn 的 Unicode 形式是公共后缀');
ok(!isPublicSuffix('alice.xn--55qx5d.cn'), '可注册域本身不是公共后缀');
ok(isPublicSuffix('公司') && isPublicSuffix('xn--55qx5d'), '单标签 IDN TLD 两种形式都是公共后缀');
ok(analyzeDomain('alice.公司.cn').registrable === 'alice.xn--55qx5d.cn');
ok(analyzeDomain('bob.xn--55qx5d.cn').registrable === 'bob.xn--55qx5d.cn');

// 可注册域与同站计算使用同一 ASCII 表示
assert.strictEqual(siteKey('https://alice.公司.cn/'), 'https://alice.xn--55qx5d.cn');
assert.strictEqual(siteKey('https://bob.xn--55qx5d.cn/'), 'https://bob.xn--55qx5d.cn');
assert.strictEqual(
  isSameSite('https://alice.公司.cn/', 'https://bob.公司.cn/'), false,
  '两个 公司.cn 站点跨站'
);
assert.strictEqual(
  isSameSite('https://alice.公司.cn/', 'https://www.alice.xn--55qx5d.cn/'), true,
  'Unicode 与 punycode 混写仍同站'
);

// Cookie Domain 无论 Unicode 还是 Punycode，都按同一 ASCII 表示校验、保存
ok(parseSetCookie('sid=1; Domain=xn--55qx5d.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'PUBLIC_SUFFIX');
ok(parseSetCookie('sid=1; Domain=公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'PUBLIC_SUFFIX',
  'Unicode Domain 同样以公共后缀拒绝');
ok(parseSetCookie('sid=1; Domain=xn--55qx5d.cn; Path=/',
  { scheme: 'https', host: 'alice.公司.cn' }, now).reason === 'PUBLIC_SUFFIX',
  'Unicode 响应主机同样命中公共后缀校验');
const idnCookie = parseSetCookie('sid=1; Domain=alice.公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now);
ok(idnCookie.ok && idnCookie.cookie.domain === 'alice.xn--55qx5d.cn',
  'Unicode Domain 归一化为 punycode 保存');
ok(parseSetCookie('sid=1; Domain=bob.公司.cn; Path=/',
  { scheme: 'https', host: 'alice.xn--55qx5d.cn' }, now).reason === 'DOMAIN_MISMATCH',
  'IDN 下 Domain 不匹配校验仍然生效');

// 漏洞场景端到端：公司.cn 写入被拒、两站跨站、bob 收不到 Cookie
const simIDN = runSimulation([
  { seconds: 0, url: 'https://alice.公司.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=1; Domain=xn--55qx5d.cn; Path=/', 'own=1; Domain=alice.公司.cn; Path=/'] },
  { seconds: 1, url: 'https://bob.公司.cn/', method: 'GET',
    topUrl: 'https://alice.公司.cn/', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://www.alice.公司.cn/', method: 'GET',
    topUrl: 'https://alice.公司.cn/', isNavigation: false, setCookies: [] }
]).results;
assert.strictEqual(simIDN[0].responses[0].status, 'rejected');
assert.strictEqual(simIDN[0].responses[0].reason, 'PUBLIC_SUFFIX');
assert.strictEqual(simIDN[0].responses[1].status, 'stored');
assert.strictEqual(simIDN[0].responses[1].cookie.domain, '.alice.xn--55qx5d.cn');
assert.strictEqual(simIDN[1].crossSite, true, 'bob 相对 alice 是跨站');
assert.strictEqual(simIDN[1].cookieHeader, '', 'bob 不收到 alice 的 Cookie');
assert.strictEqual(simIDN[2].sameSite, true, '子域与 alice 同站');
assert.strictEqual(simIDN[2].cookieHeader, 'own=1', 'ASCII 存储的 Cookie 能匹配 Unicode URL 主机');

// Unicode 与 punycode 两种 Domain 写法命中同一 Cookie 键（覆盖更新而非共存）
const simIDN2 = runSimulation([
  { seconds: 0, url: 'https://alice.公司.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Domain=alice.公司.cn; Path=/'] },
  { seconds: 1, url: 'https://alice.xn--55qx5d.cn/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=2; Domain=alice.xn--55qx5d.cn; Path=/'] }
]).results;
assert.strictEqual(simIDN2[1].responses[0].action, 'updated', '两种写法命中同一 Cookie 键');
assert.strictEqual(simIDN2[1].jarAfter.filter((c) => c.name === 'k').length, 1);
assert.strictEqual(simIDN2[1].jarAfter[0].value, '2');

// --- 边界：IP 地址（IPv4 / IPv6，含 URL 中的方括号）---
ok(isIpAddress('192.168.1.1'));
ok(isIpAddress('[::1]'));
ok(isIpAddress('[2001:db8::1]'));
ok(!isIpAddress('example.com'));
assert.strictEqual(siteKey('http://192.168.1.1:9000/'), 'http://192.168.1.1');
assert.strictEqual(siteKey('http://[2001:db8::1]:8080/'), 'http://[2001:db8::1]');
assert.strictEqual(isSameSite('http://[::1]:3000/', 'http://[::1]:8080/'), true);
assert.strictEqual(isSameSite('http://192.168.1.1/', 'http://192.168.1.2/'), false);
assert.strictEqual(isSameSite('http://[2001:db8::1]/', 'http://[2001:db8::2]/'), false);
// IP 不做公共后缀判断；host-only Cookie 写入保持既有行为
ok(!isPublicSuffix('192.168.1.1'));
ok(parseSetCookie('a=1; Domain=10.0.0.99',
  { scheme: 'http', host: '192.168.1.1' }, now).reason === 'DOMAIN_MISMATCH');
ok(parseSetCookie('a=1; Path=/',
  { scheme: 'http', host: '192.168.1.1' }, now).ok === true);

// --- 边界：localhost 与普通单标签内网名保留既有行为 ---
assert.strictEqual(siteKey('http://localhost:3000/x'), 'http://localhost');
assert.strictEqual(isSameSite('http://localhost:3000/', 'http://localhost:8080/'), true);
ok(!isPublicSuffix('localhost'));
ok(parseSetCookie('sid=1; Domain=localhost; Path=/',
  { scheme: 'http', host: 'localhost' }, now).ok === true, 'Domain=localhost 仍允许写入');
ok(!isPublicSuffix('intranet'), '未知单标签内网名不视为公共后缀');
assert.strictEqual(siteKey('http://intranet/app'), 'http://intranet');

// --- 边界：普通域名行为不变 ---
assert.strictEqual(siteKey('https://www.example.com/a'), 'https://example.com');
assert.strictEqual(siteKey('http://a.b.co.uk:8080'), 'http://b.co.uk');
assert.strictEqual(isSameSite('https://a.example.com', 'https://www.example.com/p'), true);
assert.strictEqual(isSameSite('https://example.com', 'http://example.com'), false);
ok(isPublicSuffix('com') && isPublicSuffix('co.uk') && !isPublicSuffix('example.com'));

// --- 最小复现（minimize）---

// 场景：已发送目标，含无关整步与无关 Set-Cookie 行，目标步之后还有多余步骤
const stepsMin = [
  { seconds: 0, url: 'https://a.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] }, // 与目标无关的整步，可删
  { seconds: 3, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/; Max-Age=3600', 'noise=1; Path=/'] }, // noise 行可删
  { seconds: 2, url: 'https://other.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['y=2; Path=/'] }, // 与目标无关的整步，可删
  { seconds: 4, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // 目标步：发送 sid
  { seconds: 7, url: 'https://tail.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['z=3; Path=/'] } // 目标步之后，截断
];
const fullMin = runSimulation(stepsMin).results;
const sidSent = fullMin[3].sent.find((c) => c.name === 'sid');
ok(sidSent, '目标步应发送 sid');
const targetSid = { stepIndex: 3, name: sidSent.name, value: sidSent.value,
  domain: sidSent.domain, path: sidSent.path, sent: true };
const minA = minimizeSteps(stepsMin, targetSid);
ok(minA.ok === true, '已发送目标应能最小化');
assert.strictEqual(minA.before.steps, 5);
assert.strictEqual(minA.before.setCookieLines, 5);
assert.strictEqual(minA.after.steps, 2, '无关整步与目标步之后的步骤都被去掉');
assert.strictEqual(minA.after.setCookieLines, 1, '无关 Set-Cookie 行被去掉');
// 保留步：原第 2 步（写入 sid）与目标步
assert.strictEqual(minA.steps[0].url, 'https://shop.example.com/');
assert.deepStrictEqual(minA.steps[0].setCookies, ['sid=abc; Path=/; Max-Age=3600']);
// 秒数并入：删第 1 步（0s）并入第 2 步；删原第 3 步（2s）并入目标步
assert.strictEqual(minA.steps[0].seconds, 3);
assert.strictEqual(minA.steps[1].seconds, 6);
// 目标请求的 URL / 方法 / 顶层页面 / 导航标记不变
assert.strictEqual(minA.steps[1].url, 'https://shop.example.com/');
assert.strictEqual(minA.steps[1].method, 'GET');
assert.strictEqual(minA.steps[1].topUrl, '');
assert.strictEqual(minA.steps[1].isNavigation, false);
// 绝对时刻不变：末步时钟 = 原目标步时钟
const minAResults = runSimulation(minA.steps).results;
assert.strictEqual(minAResults[minAResults.length - 1].clock, fullMin[3].clock);
assert.strictEqual(minA.keptClock, minA.targetClock);
// 末步仍复现目标
ok(targetMatches(minAResults[minAResults.length - 1], targetSid), '最小化后末步仍发送 sid');
// 1-minimal：任何单项再删都会改变目标结果
{
  const cur = minA.steps;
  // 删任意整步（除目标步）
  for (let i = 0; i < cur.length - 1; i++) {
    const cand = cur.map((s) => ({ ...s, setCookies: [...s.setCookies] }));
    const rm = cand.splice(i, 1)[0];
    cand[i].seconds += rm.seconds;
    const rr = runSimulation(cand).results;
    ok(!targetMatches(rr[rr.length - 1], targetSid), `再删第 ${i + 1} 步应改变目标结果`);
  }
  // 删任意 Set-Cookie 行
  cur.forEach((s, i) => s.setCookies.forEach((line, j) => {
    const cand = cur.map((t) => ({ ...t, setCookies: [...t.setCookies] }));
    cand[i].setCookies.splice(j, 1);
    const rr = runSimulation(cand).results;
    ok(!targetMatches(rr[rr.length - 1], targetSid), `再删第 ${i + 1} 步第 ${j + 1} 行应改变目标结果`);
  }));
}

// 场景：未发送目标，原因集合必须保留
const stepsUnsent = [
  { seconds: 0, url: 'https://bank.example/login', method: 'POST', topUrl: '', isNavigation: false,
    setCookies: ['s1=1; SameSite=Strict; Path=/', 'l1=1; SameSite=Lax; Path=/', 'junk=9; Path=/'] },
  { seconds: 5, url: 'https://bank.example/transfer', method: 'POST',
    topUrl: 'https://evil.example/', isNavigation: false, setCookies: [] }
];
const fullUnsent = runSimulation(stepsUnsent).results;
const s1Unsent = fullUnsent[1].unsent.find((u) => u.cookie.name === 's1');
ok(s1Unsent && s1Unsent.reasons.includes('SAMESITE_STRICT'), 's1 应因 Strict 未发送');
const targetS1 = { stepIndex: 1, name: 's1', value: '1',
  domain: s1Unsent.cookie.domain, path: '/', sent: false, reasons: s1Unsent.reasons.slice() };
const minB = minimizeSteps(stepsUnsent, targetS1);
ok(minB.ok === true, '未发送目标应能最小化');
assert.strictEqual(minB.after.steps, 2);
assert.strictEqual(minB.after.setCookieLines, 1, 'l1 与 junk 行均可删');
assert.deepStrictEqual(minB.steps[0].setCookies, ['s1=1; SameSite=Strict; Path=/']);
assert.strictEqual(minB.steps[0].seconds, 0);
assert.strictEqual(minB.steps[1].seconds, 5);
const minBResults = runSimulation(minB.steps).results;
ok(targetMatches(minBResults[minBResults.length - 1], targetS1), '最小化后末步仍复现未发送目标及原因集合');
// 原因集合不一致不算复现
ok(!targetMatches(minBResults[minBResults.length - 1],
  { ...targetS1, reasons: ['SAMESITE_LAX'] }), '原因集合不同不匹配');
ok(!targetMatches(minBResults[minBResults.length - 1],
  { ...targetS1, sent: true }), '发送状态不同不匹配');

// 场景：目标就是第一步（之前没有可删的整步）
const minC = minimizeSteps(
  [{ seconds: 0, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false,
     setCookies: ['a=1; Path=/', 'b=2; Path=/'] }],
  { stepIndex: 0, name: 'a', value: '1', domain: 'x.example', path: '/', sent: false,
    reasons: ['PATH'] }
);
// 第一步执行时 Jar 为空，a 尚未写入，未发送列表里不存在 a → 定位失败
ok(minC.ok === false, '无法定位目标时返回错误');

// 场景：无法定位（名称不存在 / 下标越界）
const minD = minimizeSteps(stepsUnsent,
  { stepIndex: 1, name: 'nope', value: '1', domain: 'bank.example', path: '/', sent: true });
ok(minD.ok === false && /找不到/.test(minD.error), '不存在的目标应报错');
const minE = minimizeSteps(stepsUnsent,
  { stepIndex: 9, name: 's1', value: '1', domain: 'bank.example', path: '/', sent: true });
ok(minE.ok === false, '下标越界应报错');

// 场景：过期目标依赖时钟，秒数并入保证绝对时刻不变
const stepsClock = [
  { seconds: 10, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['tmp=1; Path=/; Max-Age=100', 'pad=1; Path=/'] },
  { seconds: 50, url: 'https://pad.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // 无关步，可删，但 50s 必须并入目标步
  { seconds: 40, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] } // 目标步：tmp 仍存活（10+50+40=100 边界上不发送？<= now 过期 → 恰好 100s 过期）
];
const fullClock = runSimulation(stepsClock).results;
// 时钟 10+50+40=100s，tmp 的 expires = 10s+100s=110s > 100s，仍发送
const tmpSent = fullClock[2].sent.find((c) => c.name === 'tmp');
ok(tmpSent, '目标步 tmp 仍在有效期内');
const minF = minimizeSteps(stepsClock,
  { stepIndex: 2, name: 'tmp', value: '1', domain: tmpSent.domain, path: '/', sent: true });
ok(minF.ok === true, '时钟敏感目标应能最小化');
assert.strictEqual(minF.after.steps, 2, '无关整步被删');
assert.strictEqual(minF.steps[1].seconds, 90, '被删步的 50s 并入目标步');
const minFResults = runSimulation(minF.steps).results;
assert.strictEqual(minFResults[minFResults.length - 1].clock, fullClock[2].clock, '绝对时刻不变');
ok(targetMatches(minFResults[minFResults.length - 1],
  { stepIndex: 1, name: 'tmp', value: '1', domain: tmpSent.domain, path: '/', sent: true }),
  '时钟不变所以 tmp 仍发送');

// --- 策略求解（solve）---

const { solveStrategy } = require('../lib/solve');

// 场景 1：host-only 优先；SameSite Strict 先于 Lax；Secure 有先于无；有效期保留
const stepsSol1 = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/; Max-Age=3600'] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol1 = solveStrategy(stepsSol1, {
  stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 1, sent: true }]
});
ok(sol1.ok === true, '简单场景应有解');
assert.strictEqual(sol1.setCookie, 'sid=abc; Max-Age=3600; Path=/; Secure; SameSite=Strict',
  '名称、值、有效期保留，四属性按候选替换');
assert.strictEqual(sol1.attempts, 1, '首候选即解');
ok(sol1.attributes.hostOnly === true, 'host-only 优先于 Domain 形式');
ok(sol1.attributes.secure === true && sol1.attributes.sameSite === 'Strict',
  'SameSite Strict 先于 Lax/None，Secure 有先于无');
assert.strictEqual(sol1.checks.length, 1);
ok(sol1.checks[0].ok && sol1.checks[0].actual === true && sol1.checks[0].expected === true);

// 场景 2：子域请求需要 Domain 形式；Path 从长到短逐个淘汰
const stepsSol2 = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/'] },
  { seconds: 1, url: 'https://api.shop.example.com/v1/user', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol2 = solveStrategy(stepsSol2, {
  stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: true }]
});
ok(sol2.ok === true, '子域场景应有解');
assert.strictEqual(sol2.setCookie, 'sid=abc; Domain=shop.example.com; Path=/; Secure; SameSite=Strict');
assert.strictEqual(sol2.attributes.domain, '.shop.example.com', '最窄的可用 Domain 优先');
ok(sol2.checks.every((c) => c.ok && c.actual === true));

// 场景 3：不应发送标记 → 用更长的 Path 排除；同长字典序取先
const sol3 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/app/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: false }]
});
ok(sol3.ok === true, '路径排除场景应有解');
assert.strictEqual(sol3.setCookie, 'k=1; Path=/app/x; Secure; SameSite=Strict',
  '最长的可用路径（标记请求路径本身）优先');
const sol3c2 = sol3.checks.find((c) => c.stepIndex === 2);
ok(sol3c2 && sol3c2.actual === false && sol3c2.reasons.includes('PATH'),
  '未发送的标记步带 PATH 原因供展示');

// 场景 4：逐级前缀中的中间层成为解（完整路径与 / 都被淘汰）
const sol4 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/app/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/app/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://example.com/other', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 2, sent: true }, { stepIndex: 3, sent: false }]
});
ok(sol4.ok === true, '中间前缀场景应有解');
assert.strictEqual(sol4.setCookie, 'k=1; Path=/app; Secure; SameSite=Strict',
  '两个标记请求的公共逐级前缀 /app 成为解');

// 场景 5：跨站 POST 要发送 → SameSite=None 且必须 Secure
const sol5 = solveStrategy([
  { seconds: 0, url: 'https://bank.example/', method: 'POST', topUrl: '', isNavigation: false,
    setCookies: ['s=1; Path=/'] },
  { seconds: 1, url: 'https://bank.example/transfer', method: 'POST',
    topUrl: 'https://evil.example/', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 's=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol5.ok === true, '跨站 POST 场景应有解');
assert.strictEqual(sol5.setCookie, 's=1; Path=/transfer; Secure; SameSite=None');
ok(sol5.attributes.sameSite === 'None' && sol5.attributes.secure === true);

// 场景 6：跨站顶层 GET 导航要发送 → Strict 不行，Lax 放行
const sol6 = solveStrategy([
  { seconds: 0, url: 'https://bank.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['l=1; Path=/'] },
  { seconds: 1, url: 'https://bank.example/landing', method: 'GET',
    topUrl: 'https://other.example/', isNavigation: true, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'l=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol6.ok === true, '跨站顶层导航场景应有解');
assert.strictEqual(sol6.setCookie, 'l=1; Path=/landing; Secure; SameSite=Lax');

// 场景 7：需要更宽的父域（host-only 与主机 Domain 都不行）
const sol7 = solveStrategy([
  { seconds: 0, url: 'https://a.b.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://b.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol7.ok === true, '父域场景应有解');
assert.strictEqual(sol7.setCookie, 'x=1; Domain=b.example.com; Path=/; Secure; SameSite=Strict',
  'Domain 从窄到宽，取第一个能覆盖标记主机的父域');

// 场景 8：覆盖更新项同样可作为目标
const sol8 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=2; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 1, respIndex: 0, raw: 'k=2; Path=/', marks: [{ stepIndex: 2, sent: true }] });
ok(sol8.ok === true, '覆盖更新项可作为目标');
assert.strictEqual(sol8.setCookie, 'k=2; Path=/; Secure; SameSite=Strict');

// 场景 9：无解（请求主机与来源主机无任何合法 Domain 关系）
const sol9 = solveStrategy([
  { seconds: 0, url: 'https://a.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://other.net/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol9.ok === false && sol9.invalid !== true, '确实无解而不是目标无效');
ok(sol9.attempts > 0, '无解前实际重跑过候选');

// 场景 10：候选不得包含公共后缀（Domain=com 不可作为解）
const sol10 = solveStrategy([
  { seconds: 0, url: 'https://a.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['x=1; Path=/'] },
  { seconds: 1, url: 'https://b.example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'x=1; Path=/', marks: [{ stepIndex: 1, sent: true }] });
ok(sol10.ok === true);
assert.strictEqual(sol10.setCookie, 'x=1; Domain=example.com; Path=/; Secure; SameSite=Strict');
ok(!sol10.setCookie.includes('Domain=com;'), '公共后缀不会成为候选');

// 场景 11：求解不修改输入步骤
const sol11Steps = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=abc; Path=/'] },
  { seconds: 1, url: 'https://api.shop.example.com/v1', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const sol11Frozen = JSON.stringify(sol11Steps);
solveStrategy(sol11Steps, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/',
  marks: [{ stepIndex: 1, sent: true }] });
assert.strictEqual(JSON.stringify(sol11Steps), sol11Frozen, '求解不得修改输入步骤');

// 场景 12：非法目标 / 非法标记一律拒绝
const badTarget1 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['bad=1; Domain=evil.org'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'bad=1; Domain=evil.org', marks: [{ stepIndex: 1, sent: true }] });
ok(badTarget1.ok === false && badTarget1.invalid === true, '被拒写入不可作为目标');

const badTarget2 = solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=; Path=/; Max-Age=0'] },
  { seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 1, respIndex: 0, raw: 'k=; Path=/; Max-Age=0', marks: [{ stepIndex: 2, sent: false }] });
ok(badTarget2.ok === false && badTarget2.invalid === true, '删除项不可作为目标');

ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 0, sent: true }] }).invalid === true, '标记不晚于写入步被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [] }).invalid === true, '空标记被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=abc; Path=/; Max-Age=3600',
  marks: [{ stepIndex: 1, sent: true }, { stepIndex: 1, sent: false }] }).invalid === true,
  '重复标记被拒绝');
ok(solveStrategy(stepsSol1, { stepIndex: 0, respIndex: 0, raw: 'sid=CHANGED; Path=/',
  marks: [{ stepIndex: 1, sent: true }] }).invalid === true, 'raw 不一致判定目标失效');
ok(solveStrategy([
  { seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['a=1; Path=/'] },
  { seconds: 1, url: 'not-a-url', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { stepIndex: 0, respIndex: 0, raw: 'a=1; Path=/', marks: [{ stepIndex: 1, sent: true }] })
  .invalid === true, '无效请求步不可标记');
const nineSteps = [{ seconds: 0, url: 'https://example.com/', method: 'GET', topUrl: '',
  isNavigation: false, setCookies: ['a=1; Path=/'] }];
for (let i = 0; i < 9; i++) {
  nineSteps.push({ seconds: 1, url: 'https://example.com/', method: 'GET', topUrl: '',
    isNavigation: false, setCookies: [] });
}
ok(solveStrategy(nineSteps, { stepIndex: 0, respIndex: 0, raw: 'a=1; Path=/',
  marks: Array.from({ length: 9 }, (_, i) => ({ stepIndex: i + 1, sent: true })) }).invalid === true,
  '超过 8 个标记被拒绝');

// --- 生命周期事件（写入 / 覆盖 / 删除含空操作 / 过期淘汰）---

const { runSimulation: runSimLC } = require('../lib/simulate');
const Lifecycle = require('../public/lifecycle');

const stepsLC = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'sid=v1; Path=/; Max-Age=100',
      'SID=other; Domain=example.com; Path=/admin', // 同名称（忽略大小写）但域/路径不同 → 另一条轨迹
      'bad=1; SameSite=None'                        // 被拒写入，不产生事件
    ] },
  { seconds: 20, url: 'https://shop.example.com/admin/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=v2; Path=/; Max-Age=300'] }, // 覆盖同键并重算到期
  { seconds: 60, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sid=; Path=/; Max-Age=0', 'ghost=1; Path=/x; Max-Age=0'] }, // 命中删除 + 空操作删除
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['temp=1; Path=/; Max-Age=10; Secure'] },
  { seconds: 5, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] }, // temp 仍存活（clock 85 < 到期 90）
  { seconds: 6, url: 'http://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] } // clock 91：temp 在首次到期后的有效请求仍进入未发送判定，随后才淘汰
];
const lc = runSimLC(stepsLC).results;

// 第 1 步：两条 stored（sid 与另一条同名不同域/路径的 SID），被拒写入不上轨迹
const e0 = lc[0].events;
assert.strictEqual(e0.length, 2);
assert.strictEqual(e0[0].type, 'stored');
assert.strictEqual(e0[0].raw, 'sid=v1; Path=/; Max-Age=100');
ok(e0[0].before === null && e0[0].after.name === 'sid' && e0[0].after.value === 'v1');
assert.strictEqual(e0[0].after.expiresISO, new Date(lc[0].clock + 100000).toISOString());

// 第 2 步：覆盖同键，before/after 值与新到期时间正确
const e1 = lc[1].events;
assert.strictEqual(e1.length, 1);
assert.strictEqual(e1[0].type, 'updated');
assert.strictEqual(e1[0].before.value, 'v1');
assert.strictEqual(e1[0].after.value, 'v2');
assert.strictEqual(Date.parse(e1[0].after.expiresISO), lc[1].clock + 300000, '覆盖重算到期时间');
assert.strictEqual(e1[0].before.domain, e1[0].after.domain, '覆盖沿用同一键（域不变）');

// 第 3 步：命中删除（有 before）+ 未命中删除（空操作，before 为空）
const e2 = lc[2].events;
assert.strictEqual(e2.length, 2);
assert.strictEqual(e2[0].type, 'deleted');
ok(e2[0].before && e2[0].before.value === 'v2');
assert.strictEqual(e2[1].type, 'deleted');
ok(e2[1].before === null, '未命中的删除是空操作');
assert.ok(e2[1].raw.includes('ghost='));

// 第 4 步：temp 写入
assert.strictEqual(lc[3].events.length, 1);
assert.strictEqual(lc[3].events[0].type, 'stored');

// 第 5 步：temp 仍存活（写入时刻 80 + 10s 到期 90，此刻 85）
assert.strictEqual(lc[4].events.length, 0);
ok(lc[4].sent.some((c) => c.name === 'temp'));

// 第 6 步：clock=91 > 到期 90，temp 进入未发送判定（EXPIRED 等），随后淘汰
const e5 = lc[5].events;
assert.strictEqual(e5.length, 1);
assert.strictEqual(e5[0].type, 'evicted');
assert.strictEqual(e5[0].raw, null, '淘汰事件无 Set-Cookie 原文');
assert.strictEqual(e5[0].before.name, 'temp');
ok(e5[0].after === null);
ok(e5[0].reasons.includes('EXPIRED'), '淘汰前进入了未发送判定');
ok(e5[0].reasons.includes('NOT_HTTPS'), '该次判定的全部原因都被记录');
// 与现有结果一致：未发送列表中同一时刻仍能看到 temp
ok(lc[5].unsent.some((u) => u.cookie.name === 'temp' && u.reasons.includes('EXPIRED')),
  '轨迹与现有未发送结果一致：先判定、后淘汰');
ok(!lc[5].jarAfter.some((c) => c.name === 'temp'), '淘汰后步末 Jar 中不存在 temp');

// 键归一：名称忽略大小写；域去前导点；同名不同域/路径分开
assert.strictEqual(
  Lifecycle.keyOf('SID', '.example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/'),
  '名称大小写不敏感、域前导点归一'
);
assert.notStrictEqual(
  Lifecycle.keyOf('sid', 'shop.example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/'),
  '域不同必须分开'
);
assert.notStrictEqual(
  Lifecycle.keyOf('sid', 'example.com', '/'),
  Lifecycle.keyOf('sid', 'example.com', '/admin'),
  '路径不同必须分开'
);

// traceOf：从第 6 步的未发送 temp 回溯，只能看到它自己的写入与淘汰
const tempUnsent = lc[5].unsent.find((u) => u.cookie.name === 'temp');
const traceTemp = Lifecycle.traceOf(lc, tempUnsent.cookie, 5);
assert.deepStrictEqual(traceTemp.map((x) => x.type), ['stored', 'evicted']);
assert.deepStrictEqual(traceTemp.map((x) => x.step), [3, 5]);

// 从被覆盖后的步末 Jar 选 sid（host-only），轨迹含写入与覆盖，不含 admin 路径的 SID
const sidJar = lc[1].jarAfter.find((c) => c.name === 'sid' && c.hostOnly);
ok(sidJar);
const traceSid = Lifecycle.traceOf(lc, sidJar, 1);
assert.deepStrictEqual(traceSid.map((x) => x.type), ['stored', 'updated']);
ok(traceSid.every((x) => x.step <= 1));

// admin 路径的 Domain Cookie 是另一条轨迹（即使同名）
const sidAdmin = lc[1].jarAfter.find((c) => c.name === 'SID' && c.path === '/admin');
ok(sidAdmin);
const traceAdmin = Lifecycle.traceOf(lc, sidAdmin, 1);
assert.strictEqual(traceAdmin.length, 1);
assert.strictEqual(traceAdmin[0].after.path, '/admin');

// 截至目标步：从第 2 步选 sid 看不到第 3 步的删除
assert.strictEqual(Lifecycle.traceOf(lc, sidJar, 1)
  .every((x) => x.type !== 'deleted'), true);

// 空操作删除项本身也可作为选择项，其轨迹截至该步 = 写入 → 覆盖 → 删除（空操作）
const ghostResp = { name: 'ghost', domain: 'shop.example.com', path: '/x' };
const traceGhost = Lifecycle.traceOf(lc, ghostResp, 2);
assert.strictEqual(traceGhost.length, 1);
assert.strictEqual(traceGhost[0].type, 'deleted');
ok(Lifecycle.isDeleteMiss(traceGhost[0]));

// 非法 URL 跳过步不产生事件，时钟仍推进
const lcSkip = runSimLC([
  { seconds: 30, url: 'not-a-url', method: 'GET', setCookies: ['x=1'] },
  { seconds: 1, url: 'https://shop.example.com/', method: 'GET', setCookies: [] }
]).results;
assert.deepStrictEqual(lcSkip[0].events, []);
assert.strictEqual(lcSkip[1].clock, lcSkip[0].clock + 1000);

// --- 服务端同名取值分析（ServerView）---

const ServerView = require('../public/serverview');

// 场景：同名不同路径并列 → 取首项 ≠ 取末项；删除后分歧消失；同一步响应只影响后续请求
const stepsSV = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'k=root; Path=/',
      'k=api; Path=/api; Max-Age=10',
      'SID=upper; Path=/',
      'sid=lower; Path=/api'
    ] },
  { seconds: 1, url: 'https://shop.example.com/api/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://shop.example.com/api/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=; Path=/api; Max-Age=0'] }, // 删除在本步发送之后处理，只影响后续请求
  { seconds: 1, url: 'https://shop.example.com/api/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=again; Path=/api'] }, // 本步发送时 k 仍单项；响应写入使后续请求再次分歧
  { seconds: 1, url: 'https://shop.example.com/api/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const svRes = runSimulation(stepsSV).results;

// 逐请求分析：空头给出明确状态
const sv0 = ServerView.analyzeRequest(svRes[0]);
ok(sv0.empty === true && sv0.groups.length === 0 && sv0.divergentNames.length === 0, '空头状态明确');

// 第 2 步：头顺序 = 路径更长者优先、其次创建更早者优先
assert.strictEqual(svRes[1].cookieHeader, 'k=api; sid=lower; k=root; SID=upper');
const sv1 = ServerView.analyzeRequest(svRes[1]);
assert.strictEqual(sv1.empty, false);
// 名称区分大小写：sid 与 SID 各自成组
assert.deepStrictEqual(sv1.groups.map((g) => g.name), ['k', 'sid', 'SID']);
const gK = sv1.groups[0];
assert.strictEqual(gK.multi, true);
assert.strictEqual(gK.first, 'api', '取首项 = 头中第一项的值');
assert.strictEqual(gK.last, 'root', '取末项 = 头中末项的值');
ok(gK.divergent, '两种取值不同 → 标出分歧');
// 同名组逐项：头中顺序 + 域 / 路径 / 创建次序
assert.deepStrictEqual(gK.items.map((x) => x.value), ['api', 'root']);
assert.strictEqual(gK.items[0].path, '/api');
assert.strictEqual(gK.items[1].path, '/');
assert.strictEqual(gK.items[0].creationOrder, 1);
assert.strictEqual(gK.items[1].creationOrder, 0);
ok(gK.items.every((x) => x.hostOnly && x.domain === 'shop.example.com'), '每项携带域信息');
// 单一项名称：首末一致、不标分歧
const gSid = sv1.groups.find((g) => g.name === 'sid');
ok(gSid && !gSid.multi && !gSid.divergent && gSid.first === 'lower' && gSid.last === 'lower');
assert.deepStrictEqual(sv1.divergentNames, ['k']);

// 时间线：分歧产生 / 消失 / 再产生，事件按 Jar 键名称关联
const svTl = ServerView.analyzeTimeline(svRes);
assert.strictEqual(svTl.validCount, 5);
const recK = svTl.names.find((n) => n.name === 'k');
assert.deepStrictEqual(recK.transitions.map((t) => t.type + '@' + t.step),
  ['arise@1', 'vanish@3', 'arise@4'], '分歧何时产生、何时消失沿有效请求标出');
// 产生：关联相邻步骤（第 1 步响应）的两条 k 写入
const arise1 = recK.transitions[0];
assert.strictEqual(arise1.first, 'api');
assert.strictEqual(arise1.last, 'root');
assert.deepStrictEqual(arise1.events.map((e) => e.type + '@' + e.step), ['stored@0', 'stored@0']);
// 消失：仅剩一项；关联上一步响应的删除；本步（index 3）响应的写入不计入本步
const vanish3 = recK.transitions[1];
assert.strictEqual(vanish3.state, 'single');
assert.deepStrictEqual(vanish3.events.map((e) => e.type + '@' + e.step), ['deleted@2'],
  '同一步先发送后处理响应：本步响应事件不影响本步取值');
// 再产生：关联上一步响应的写入
const arise4 = recK.transitions[2];
assert.strictEqual(arise4.first, 'again');
assert.strictEqual(arise4.last, 'root');
assert.deepStrictEqual(arise4.events.map((e) => e.type + '@' + e.step), ['stored@3']);
ok(recK.everDivergent && recK.divergentNow, '截至末步仍分歧');
// SID / sid 全程单项：无分歧、无同名并列
for (const nm of ['SID', 'sid']) {
  const rec = svTl.names.find((n) => n.name === nm);
  ok(rec && !rec.everDivergent && !rec.everMulti && rec.transitions.length === 0,
    nm + ' 全程单项发送');
}

// 过期淘汰关联：同名两项之一过期 → 分歧在到期后的首个有效请求消失，关联淘汰事件
const sv2 = runSimulation([
  { seconds: 0, url: 'https://e.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['d=long; Path=/', 'd=short; Path=/p; Max-Age=5'] },
  { seconds: 1, url: 'https://e.example/p/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 5, url: 'https://e.example/p/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
]).results;
const tl2 = ServerView.analyzeTimeline(sv2);
const recD = tl2.names.find((n) => n.name === 'd');
assert.deepStrictEqual(recD.transitions.map((t) => t.type + '@' + t.step), ['arise@1', 'vanish@2']);
const vanD = recD.transitions[1];
assert.strictEqual(vanD.state, 'single');
assert.deepStrictEqual(vanD.events.map((e) => e.type + '@' + e.step), ['evicted@2'],
  '过期淘汰发生在发送判定中，关联到分歧消失');

// 同名同值：首末一致，不标分歧（但记为同名并列出现过）
const sv3 = runSimulation([
  { seconds: 0, url: 'https://m.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['s=1; Path=/', 's=1; Path=/p'] },
  { seconds: 1, url: 'https://m.example/p', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
]).results;
const gS = ServerView.analyzeRequest(sv3[1]).groups.find((g) => g.name === 's');
ok(gS.multi && !gS.divergent && gS.first === '1' && gS.last === '1', '同名同值：首末一致');
const recS = ServerView.analyzeTimeline(sv3).names.find((n) => n.name === 's');
ok(recS.everMulti && !recS.everDivergent && recS.transitions.length === 0, '同名同值不产生分歧事件');

// 分歧后该名称完全不再发送 → 分歧消失（absent），且相邻步骤可无关联事件
const sv5 = runSimulation([
  { seconds: 0, url: 'https://a.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['z=1; Path=/', 'z=2; Path=/p'] },
  { seconds: 1, url: 'https://a.example/p', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://other.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
]).results;
const recZ = ServerView.analyzeTimeline(sv5).names.find((n) => n.name === 'z');
assert.deepStrictEqual(recZ.transitions.map((t) => t.type + '@' + t.step), ['arise@1', 'vanish@2']);
assert.strictEqual(recZ.transitions[1].state, 'absent', '名称不再发送 → 分歧消失');
assert.deepStrictEqual(recZ.transitions[1].events, [], '相邻步骤无该名称事件时关联为空');

// 事件关联按 Jar 键口径（名称不区分大小写）：小写删除事件关联到大写名称的时间线
const sv8 = runSimulation([
  { seconds: 0, url: 'https://c.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['K=one; Path=/', 'K=two; Path=/p'] },
  { seconds: 1, url: 'https://c.example/p', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://c.example/p', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=; Path=/p; Max-Age=0'] }, // Jar 键名称不区分大小写：删除命中 K@/p
  { seconds: 1, url: 'https://c.example/p', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
]).results;
const recK8 = ServerView.analyzeTimeline(sv8).names.find((n) => n.name === 'K');
assert.deepStrictEqual(recK8.transitions.map((t) => t.type + '@' + t.step), ['arise@1', 'vanish@3']);
assert.deepStrictEqual(recK8.transitions[1].events.map((e) => e.type + '@' + e.step), ['deleted@2'],
  '删除事件名称为小写 k，仍按 Jar 键口径关联到大写 K 的时间线');

// 非法 URL 步骤不算有效请求；没有有效请求时时间线为空
const tl6 = ServerView.analyzeTimeline(runSimulation([
  { seconds: 3, url: 'not-a-url', method: 'GET', topUrl: '', isNavigation: false, setCookies: ['x=1'] }
]).results);
assert.strictEqual(tl6.validCount, 0, '非法 URL 步骤不算有效请求');
assert.strictEqual(tl6.names.length, 0);

// ---------- 步骤变更影响（impact） ----------
const {
  compareSteps, diffResults, responseOutcomes, jarKeyOf
} = require('../lib/impact');

const impactSteps = [
  { seconds: 0, url: 'https://shop.example.com/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [
      'sid=abc; Domain=example.com; Path=/; Max-Age=3600',
      'cart=2; Path=/cart'
    ] },
  { seconds: 5, url: 'https://api.shop.example.com/v1/user', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: [] },
  { seconds: 1, url: 'https://ads.net/track', method: 'POST',
    topUrl: 'https://shop.example.com/home', isNavigation: false, setCookies: ['p=1; Path=/'] },
  { seconds: 1, url: 'https://ads.net/landing', method: 'GET',
    topUrl: 'https://shop.example.com/home', isNavigation: true, setCookies: [] }
];

// 参数无效：步下标越界 / 无可改字段
ok(compareSteps(impactSteps, { stepIndex: 9, url: 'x' }).invalid === true, '步下标越界判为无效');
ok(compareSteps(impactSteps, { stepIndex: 0 }).invalid === true, '没有可改字段判为无效');
ok(compareSteps(impactSteps, { stepIndex: 0, isNavigation: 'x' }).invalid === true, '导航标记类型校验');
ok(compareSteps(impactSteps, { stepIndex: 0, setCookies: [1] }).invalid === true, 'Set-Cookie 行类型校验');

// 无实际变更（值相同）→ identical
const impSame = compareSteps(impactSteps, { stepIndex: 1, url: 'https://api.shop.example.com/v1/user' });
ok(impSame.ok && impSame.identical && impSame.changedFields.length === 0 &&
  impSame.affectedSteps.length === 0 && impSame.firstDiff === null, '无实际变更：无差异');

// 改 Set-Cookie 值：变更步之前无差异；首个差异在变更步“响应阶段”（本步响应只影响后续）；
// 后续步的发送项 / 步末 Jar 值跟着变
const impVal = compareSteps(impactSteps, {
  stepIndex: 0,
  setCookies: ['sid=xyz; Domain=example.com; Path=/; Max-Age=3600', 'cart=2; Path=/cart']
});
ok(impVal.ok && !impVal.identical);
assert.deepStrictEqual(impVal.changedFields, ['setCookies']);
// sid 值变化进入 Jar：即使跨站不发送，步末 Jar 中 sid 的值仍不同，故每一步都受影响
assert.deepStrictEqual(impVal.affectedSteps, [0, 1, 2, 3]);
assert.strictEqual(impVal.firstDiff.step, 0);
assert.strictEqual(impVal.firstDiff.phase, 'response', '首个差异在响应阶段');
assert.strictEqual(impVal.firstDiff.kind, 'response');
ok(impVal.firstDiff.differences.includes('cookie.value'));
assert.strictEqual(impVal.firstDiff.baseline.cookie.value, 'abc');
assert.strictEqual(impVal.firstDiff.copy.cookie.value, 'xyz');
// 第 2 步（index 1）发送的 sid 值变化（按头顺序比较名称、值、Jar 键）
const step1Diffs = impVal.stepDiffs.find((d) => d.step === 1);
const sentDiff = step1Diffs.diffs.find((d) => d.phase === 'send' && d.kind === 'sent');
ok(sentDiff && sentDiff.differences.includes('value') &&
  sentDiff.baseline.value === 'abc' && sentDiff.copy.value === 'xyz');
ok(step1Diffs.diffs.some((d) => d.phase === 'jar' && d.name === 'sid'));
// 变更步（0）的发送阶段必须无差异：响应不影响本步发送
ok(!impVal.stepDiffs.find((d) => d.step === 0).diffs.some((d) => d.phase === 'send'),
  '本步响应不影响本步发送：变更步发送阶段无差异');

// 改方法：跨站顶层 GET 导航（Lax 放行）→ POST（Lax 拦截）
// 首个差异在变更步“发送阶段”，原发送项消失并出现带 SAMESITE_LAX 原因的未发送项
const impMethod = compareSteps(impactSteps, { stepIndex: 3, method: 'POST' });
assert.strictEqual(impMethod.firstDiff.step, 3);
assert.strictEqual(impMethod.firstDiff.phase, 'send');
assert.strictEqual(impMethod.firstDiff.kind, 'sent');
assert.strictEqual(impMethod.firstDiff.baseline.name, 'p');
ok(impMethod.firstDiff.copy === null, '副本该头位置无发送项');
const m3 = impMethod.stepDiffs.find((d) => d.step === 3).diffs;
const unsentP = m3.find((d) => d.kind === 'unsent' && d.name === 'p');
ok(unsentP && unsentP.baseline === null &&
  unsentP.copy.reasons.includes('SAMESITE_LAX'), '发送 → 未发送：按 Jar 键对齐，仅副本侧存在并带 SAMESITE_LAX');
// 两侧都未发送的项（cart、sid）：按 Jar 键对齐，差异体现在原因集合
for (const name of ['cart', 'sid']) {
  const u = m3.find((d) => d.kind === 'unsent' && d.name === name);
  ok(u && u.baseline && u.copy && u.differences.includes('reasons'),
    name + ' 两侧均未发送：比较原因集合');
}

// 改导航标记：导航 GET → 普通 GET，同样落入 Lax 拦截
const impNav = compareSteps(impactSteps, { stepIndex: 3, isNavigation: false });
assert.strictEqual(impNav.firstDiff.phase, 'send');
ok(impNav.affectedSteps.includes(3));

// 改顶层页面 URL：一方 POST 同站发送 → 跨站 POST 被 Lax 拦截
const impTop = [
  { seconds: 0, url: 'https://a.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/'] },
  { seconds: 1, url: 'https://a.example/x', method: 'POST', topUrl: '', isNavigation: false, setCookies: [] }
];
const impTopRes = compareSteps(impTop, { stepIndex: 1, topUrl: 'https://other.example/' });
assert.strictEqual(impTopRes.firstDiff.step, 1);
assert.strictEqual(impTopRes.firstDiff.phase, 'send');
assert.strictEqual(impTopRes.firstDiff.kind, 'sent');
assert.strictEqual(impTopRes.firstDiff.baseline.name, 'k');

// 改请求 URL 为非法：发送阶段首差异是“请求是否跳过”；响应阶段每行 Set-Cookie 记为跳过；
// 步末 Jar 不含该步写入
const impSkip = compareSteps([
  { seconds: 0, url: 'https://e.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['a=1; Path=/'] },
  { seconds: 1, url: 'https://e.example/x', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['b=2; Path=/'] }
], { stepIndex: 1, url: 'bad-url' });
assert.strictEqual(impSkip.firstDiff.phase, 'send');
assert.strictEqual(impSkip.firstDiff.kind, 'skip');
assert.strictEqual(impSkip.firstDiff.baseline.skipped, false);
assert.strictEqual(impSkip.firstDiff.copy.skipped, true);
const skipDiffs = impSkip.stepDiffs[0].diffs;
const respSkip = skipDiffs.find((d) => d.phase === 'response');
ok(respSkip && respSkip.differences.includes('status') &&
  respSkip.copy.status === 'skipped', '跳过步骤的 Set-Cookie 行按跳过处理');
ok(skipDiffs.some((d) => d.phase === 'jar' && d.name === 'b' && !d.copy),
  '跳过的写入不在副本步末 Jar 中');

// 被跳过步骤的响应行合成：每条非空 Set-Cookie 行合成一条 skipped（空行已在归一化时剔除）
const synthStep = normalizeStep({ seconds: 0, url: 'bad', setCookies: ['x=1', '  ', 'y=2'] });
const synth = responseOutcomes(synthStep, runSimulation([synthStep]).results[0]);
assert.deepStrictEqual(synth.map((o) => o.status), ['skipped', 'skipped'],
  '非空 Set-Cookie 行各合成一条 skipped');

// 未发送项对齐：名称忽略大小写、域、路径（Jar 键）
assert.strictEqual(jarKeyOf('SID', '.example.com', '/'), jarKeyOf('sid', 'example.com', '/'));

// 原因集合比较与顺序无关：同一次结果自比（两侧未发送原因集合相同）不算差异
const selfSteps = [
  normalizeStep({ seconds: 0, url: 'http://e.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['sec=1; Secure; Path=/'] }),
  normalizeStep({ seconds: 0, url: 'http://e.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: [] })
];
const selfResults = runSimulation(selfSteps).results;
const direct = diffResults(selfResults, selfResults, selfSteps, selfSteps);
assert.strictEqual(direct.length, 0, '同一次结果自比无差异（含原因集合按集合比较）');

// 秒数与其他步骤不被修改：副本保持同一步数与顺序，时钟不因对照改变
assert.strictEqual(impVal.modifiedStep.seconds, impactSteps[0].seconds, '秒数保持不变');
assert.strictEqual(impVal.baselineStep.url, impactSteps[0].url, '基线对象保留原 URL');

// ---------- HAR 导入（public/har.js）----------
const HarImport = require('../public/har');
const { BASE_TIME } = require('../lib/simulate');

function harEntry(over) {
  return {
    startedDateTime: '2026-03-01T10:00:00.000Z',
    time: 100,
    request: { method: 'GET', url: 'https://x.example/' },
    response: { headers: [] },
    ...over
  };
}

// 无效文件：非 JSON / 缺 log.entries
ok(HarImport.parseHar('not json').ok === false, '非 JSON 拒绝');
ok(HarImport.parseHar('{}').ok === false, '缺 log 拒绝');
ok(HarImport.parseHar(JSON.stringify({ log: {} })).ok === false, '缺 log.entries 拒绝');
ok(HarImport.parseHar(JSON.stringify({ log: { entries: 'x' } })).ok === false, 'entries 非数组拒绝');

// 条目过滤：仅接受编辑器支持的方法、带时区的有效 startedDateTime、非负有限 time
const mixed = HarImport.parseHar(JSON.stringify({ log: { entries: [
  harEntry({}), // OK
  harEntry({ request: { method: 'GET', url: 'ws://x.example/' } }), // 非 http(s)
  harEntry({ request: { method: 'GET', url: 'not a url' } }), // 无法解析
  harEntry({ request: { method: 'CONNECT', url: 'https://x.example/' } }), // 方法不支持
  harEntry({ startedDateTime: '2026-03-01T10:00:00.000' }), // 不带时区
  harEntry({ startedDateTime: '2026-03-01 10:00:00' }), // 非 ISO 且无偏移
  harEntry({ startedDateTime: 'not-a-date' }), // 无效时间
  (() => { const e = harEntry({}); delete e.startedDateTime; return e; })(), // 缺 startedDateTime
  harEntry({ startedDateTime: '2026-03-01T10:00:00.000Z', time: -1 }), // time 为负
  harEntry({ startedDateTime: '2026-03-01T10:00:00.000Z', time: 'abc' }), // time 非数值
  (() => { const e = harEntry({}); delete e.time; return e; })(), // 缺 time
  harEntry({ startedDateTime: '2026-03-01T10:00:00.500+08:00',
    request: { method: 'POST', url: 'http://x.example/api' } }) // OK（带偏移时区 + http + POST）
] } }));
ok(mixed.ok === true, '混合 HAR 可解析');
assert.strictEqual(mixed.entries.length, 2, '仅 2 条满足全部接受条件');
assert.strictEqual(mixed.skipped.length, 10, '其余 10 条各带原因跳过');
assert.strictEqual(mixed.entries[1].method, 'POST');
assert.strictEqual(mixed.entries[1].startMs, Date.parse('2026-03-01T10:00:00.500+08:00'));
assert.strictEqual(mixed.entries[1].startMs, Date.parse('2026-03-01T02:00:00.500Z'),
  '偏移时区换算为绝对时刻');
ok(mixed.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0), '跳过均带原因');
ok(mixed.skipped.some((s) => /时区/.test(s.reason)), '不带时区被单独标出');
ok(mixed.skipped.some((s) => /方法/.test(s.reason)), '方法不支持被标出');
assert.strictEqual(HarImport.MAX_IMPORT, 100, '导入上限 100 条');

// Set-Cookie 提取：按 response.headers 原顺序取全部同名头（不区分大小写），不按逗号拆分
const scLines = HarImport.extractSetCookies({ headers: [
  { name: 'Content-Type', value: 'text/html' },
  { name: 'Set-Cookie', value: 'a=1; Path=/; Expires=Wed, 01 Apr 2026 00:00:00 GMT' },
  { name: 'set-cookie', value: 'b=2; Path=/' },
  { name: 'SET-COOKIE', value: 'c=3' },
  { name: 'set-cookie2', value: 'nope=1' },
  { name: 'X-Other', value: 'set-cookie: x=1' }
] });
assert.deepStrictEqual(scLines,
  ['a=1; Path=/; Expires=Wed, 01 Apr 2026 00:00:00 GMT', 'b=2; Path=/', 'c=3'],
  '原顺序取全部 Set-Cookie，头名不区分大小写');
ok(scLines[0].includes(','), 'Expires 中的逗号保留，不按逗号拆分');
assert.deepStrictEqual(HarImport.extractSetCookies({}), [], '缺 headers 时为空');
assert.deepStrictEqual(HarImport.extractSetCookies(null), []);

// 排序：按开始时间升序，同刻保留原行序（time 取 0，避免同刻记录因耗时重叠）
const sameStart = HarImport.parseHar(JSON.stringify({ log: { entries: [
  harEntry({ startedDateTime: '2026-03-01T10:00:01.000Z', time: 0, request: { method: 'GET', url: 'https://x.example/b' } }),
  harEntry({ startedDateTime: '2026-03-01T10:00:00.000Z', time: 0, request: { method: 'GET', url: 'https://x.example/a' } }),
  harEntry({ startedDateTime: '2026-03-01T10:00:01.000Z', time: 0, request: { method: 'GET', url: 'https://x.example/c' } })
] } }));
const sortedSame = HarImport.sortByStart(sameStart.entries);
assert.deepStrictEqual(sortedSame.map((e) => e.url),
  ['https://x.example/a', 'https://x.example/b', 'https://x.example/c'],
  '升序且同刻保留原行序');
assert.deepStrictEqual(sortedSame.map((e) => e.id), [1, 0, 2], '原 HAR 行序按下标保留');

// 时间线：相邻时间差生成秒数（精确到毫秒），首步为 0；重叠标出两行
const tlOk = HarImport.computeTimeline(sortedSame);
assert.deepStrictEqual(tlOk.seconds, [0, 1, 0], '相邻开始时间差生成秒数');
assert.deepStrictEqual(tlOk.overlaps, [], '无重叠');

const overlapSeq = [
  { id: 0, startMs: 10000, timeMs: 2000, endMs: 12000 }, // 结束 12s
  { id: 1, startMs: 11500, timeMs: 100, endMs: 11600 },  // 开始 11.5s < 12s → 重叠
  { id: 2, startMs: 13000, timeMs: 0, endMs: 13000 }
];
const tlOv = HarImport.computeTimeline(overlapSeq);
assert.deepStrictEqual(tlOv.seconds, [0, 1.5, 1.5], '秒数精确到毫秒');
assert.deepStrictEqual(tlOv.overlaps, [{ first: 0, second: 1 }], '重叠标出相邻两行');
// 边界：前一响应结束 == 下一请求开始，不算重叠（须“晚于”）
const touchSeq = [
  { id: 0, startMs: 10000, timeMs: 2000, endMs: 12000 },
  { id: 1, startMs: 12000, timeMs: 0, endMs: 12000 }
];
assert.deepStrictEqual(HarImport.computeTimeline(touchSeq).overlaps, [], '首尾相接不算重叠');

// ---------- 模拟起点（baseTime）：Expires 按抓包绝对时间判定 ----------
const T0 = Date.parse('2026-03-01T00:00:00.000Z');

// 起点与毫秒精度
const simT0 = runSimulation([
  { seconds: 0, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 1.5, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { baseTime: T0 }).results;
assert.strictEqual(simT0[0].clock, T0, '首步时钟 = 模拟起点');
assert.strictEqual(simT0[0].clockISO, '2026-03-01T00:00:00.000Z');
assert.strictEqual(simT0[1].clock, T0 + 1500, '小数秒精确到毫秒');
assert.strictEqual(simT0[1].clockISO, '2026-03-01T00:00:01.500Z');
// 缺省回归：不传 baseTime 仍用固定基准
const simDef = runSimulation([
  { seconds: 0, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
]).results;
assert.strictEqual(simDef[0].clock, BASE_TIME, '缺省起点保持固定基准');

// Expires 绝对时间：T0+60s 过期，59s 时发送、61s 时过期淘汰
const simAbs = runSimulation([
  { seconds: 0, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['e=1; Path=/; Expires=Sun, 01 Mar 2026 00:01:00 GMT'] },
  { seconds: 59, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 2, url: 'https://x.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
], { baseTime: T0 }).results;
ok(simAbs[1].sent.some((c) => c.name === 'e'), 'T0+59s：未过期，发送');
const eUnsent = simAbs[2].unsent.find((u) => u.cookie.name === 'e');
ok(eUnsent && eUnsent.reasons.includes('EXPIRED'), 'T0+61s：按抓包绝对时间过期');
ok(!simAbs[2].jarAfter.some((c) => c.name === 'e'), '过期后从 Jar 淘汰');

// HAR 端到端：解析 → 排序 → 秒数 → 以首条记录时间为起点模拟
const harDoc = { log: { entries: [
  { startedDateTime: '2026-03-01T10:00:00.000Z', time: 120,
    request: { method: 'GET', url: 'https://shop.example.com/' },
    response: { headers: [
      { name: 'Content-Type', value: 'text/html' },
      { name: 'Set-Cookie', value: 'sid=a1; Path=/; Expires=Sun, 01 Mar 2026 10:01:00 GMT' },
      { name: 'set-cookie', value: 'cart=2; Path=/cart' }
    ] } },
  { startedDateTime: '2026-03-01T10:00:30.500Z', time: 80,
    request: { method: 'GET', url: 'https://shop.example.com/cart' },
    response: { headers: [] } },
  { startedDateTime: '2026-03-01T10:01:30.000Z', time: 50,
    request: { method: 'GET', url: 'https://shop.example.com/cart' },
    response: { headers: [] } }
] } };
const harParsed = HarImport.parseHar(JSON.stringify(harDoc));
ok(harParsed.ok && harParsed.entries.length === 3 && harParsed.skipped.length === 0);
const harSorted = HarImport.sortByStart(harParsed.entries);
const harTl = HarImport.computeTimeline(harSorted);
assert.deepStrictEqual(harTl.seconds, [0, 30.5, 59.5], '相邻时间差生成秒数（毫秒精度）');
assert.deepStrictEqual(harTl.overlaps, []);
assert.deepStrictEqual(harSorted[0].setCookies,
  ['sid=a1; Path=/; Expires=Sun, 01 Mar 2026 10:01:00 GMT', 'cart=2; Path=/cart'],
  'Set-Cookie 按头原顺序全部保留');
const harSteps = harSorted.map((e, i) => ({
  seconds: harTl.seconds[i], url: e.url, method: e.method,
  topUrl: '', isNavigation: false, setCookies: e.setCookies
}));
const harSim = runSimulation(harSteps, { baseTime: harSorted[0].startMs }).results;
assert.strictEqual(harSim[0].clock, Date.parse('2026-03-01T10:00:00.000Z'), '首条记录时间 = 模拟起点');
assert.strictEqual(harSim[1].clock, Date.parse('2026-03-01T10:00:30.500Z'), '毫秒级时钟推进');
assert.deepStrictEqual(harSim[1].sent.map((c) => c.name), ['cart', 'sid'],
  '10:00:30.500 两条 Cookie 均发送（路径更长者优先）');
assert.deepStrictEqual(harSim[2].sent.map((c) => c.name), ['cart'],
  '10:01:30 sid 已按抓包绝对时间过期，会话期 cart 仍发送');
ok(harSim[2].unsent.find((u) => u.cookie.name === 'sid').reasons.includes('EXPIRED'));

// 最小复现沿用该起点：过期目标只有在 baseTime 下才能定位
const stepsExpMin = [
  { seconds: 0, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['tmp=1; Path=/; Expires=Sun, 01 Mar 2026 00:01:40 GMT'] }, // T0+100s 过期
  { seconds: 50, url: 'https://pad.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] },
  { seconds: 60, url: 'https://t.example/', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const resExpMin = runSimulation(stepsExpMin, { baseTime: T0 }).results;
const tmpU = resExpMin[2].unsent.find((u) => u.cookie.name === 'tmp');
ok(tmpU && tmpU.reasons.includes('EXPIRED'), 'T0+110s 时 tmp 已过期');
const minExp = minimizeSteps(stepsExpMin,
  { stepIndex: 2, name: 'tmp', value: '1', domain: tmpU.cookie.domain, path: '/',
    sent: false, reasons: tmpU.reasons.slice() },
  { baseTime: T0 });
ok(minExp.ok === true, '带模拟起点的最小复现可定位过期目标');
assert.strictEqual(minExp.after.steps, 2, '无关整步被删');
assert.strictEqual(minExp.steps[1].seconds, 110, '被删步的 50s 并入目标步');
const minExpRes = runSimulation(minExp.steps, { baseTime: T0 }).results;
assert.strictEqual(minExpRes[minExpRes.length - 1].clock, T0 + 110000, '保留请求的绝对时刻沿用同一起点');
ok(targetMatches(minExpRes[minExpRes.length - 1],
  { name: 'tmp', value: '1', domain: tmpU.cookie.domain, path: '/', sent: false, reasons: tmpU.reasons }),
  '最小化后末步仍复现过期未发送目标');
const minNoBase = minimizeSteps(stepsExpMin,
  { stepIndex: 2, name: 'tmp', value: '1', domain: tmpU.cookie.domain, path: '/',
    sent: false, reasons: tmpU.reasons.slice() });
ok(minNoBase.ok === false, '缺少起点时同一目标无法定位（默认基准下未过期）');

// 策略求解沿用该起点：过期使“不应发送”在候选空间内可达
const solBaseSteps = [
  { seconds: 0, url: 'https://s.example/', method: 'GET', topUrl: '', isNavigation: false,
    setCookies: ['k=1; Path=/; Expires=Sun, 01 Mar 2026 00:00:10 GMT'] }, // T0+10s 过期
  { seconds: 20, url: 'https://s.example/x', method: 'GET', topUrl: '', isNavigation: false, setCookies: [] }
];
const solBase = solveStrategy(solBaseSteps, {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/; Expires=Sun, 01 Mar 2026 00:00:10 GMT',
  marks: [{ stepIndex: 1, sent: false }]
}, { baseTime: T0 });
ok(solBase.ok === true, '带模拟起点：T0+20s 已过期，任何候选都满足不应发送');
ok(solBase.checks[0].actual === false && solBase.checks[0].reasons.includes('EXPIRED'));
const solNoBase = solveStrategy(solBaseSteps, {
  stepIndex: 0, respIndex: 0, raw: 'k=1; Path=/; Expires=Sun, 01 Mar 2026 00:00:10 GMT',
  marks: [{ stepIndex: 1, sent: false }]
});
ok(solNoBase.ok === false && solNoBase.invalid !== true,
  '默认起点下 Cookie 存活且同站必发送，同一标记无解');

// 步骤变更影响沿用该起点：基线 / 副本两侧按同一抓包起点对照
const impBase = compareSteps(stepsExpMin, {
  stepIndex: 0,
  setCookies: ['tmp=1; Path=/; Expires=Sun, 01 Mar 2026 00:03:00 GMT'] // 延长到 T0+180s
}, { baseTime: T0 });
ok(impBase.ok && !impBase.identical, '带起点：延长 Expires 改变后续过期判定');
const impStep2 = impBase.stepDiffs.find((d) => d.step === 2);
const impSendDiff = impStep2 && impStep2.diffs.find((d) => d.phase === 'send' && d.kind === 'sent');
ok(impSendDiff && impSendDiff.baseline === null && impSendDiff.copy && impSendDiff.copy.name === 'tmp',
  '第 3 步：基线已过期未发送，副本存活发送');
const impNoBase = compareSteps(stepsExpMin, {
  stepIndex: 0,
  setCookies: ['tmp=1; Path=/; Expires=Sun, 01 Mar 2026 00:03:00 GMT']
});
ok(impNoBase.ok && !impNoBase.identical, '默认起点下两侧 Expires 属性仍不同');
const impNoBaseStep2 = impNoBase.stepDiffs.find((d) => d.step === 2);
ok(!impNoBaseStep2 || !impNoBaseStep2.diffs.some((d) => d.phase === 'send'),
  '默认起点下第 3 步两侧都发送（差异仅 expiresISO 属性），对照确实沿用了传入的起点');

console.log(`全部 ${passed} 条断言通过，另含若干深度比较断言。`);