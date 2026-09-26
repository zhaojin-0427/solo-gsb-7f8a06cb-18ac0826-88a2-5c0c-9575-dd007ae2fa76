'use strict';

/**
 * 重新拉取完整 Mozilla Public Suffix List（ICANN + PRIVATE DOMAINS），
 * 覆盖 data/public_suffix_list.dat。离线规则随仓库内置，仅在想更新列表时手动执行：
 *
 *   npm run update-psl
 *
 * 需要 Node.js 18+（使用全局 fetch）。
 */

const fs = require('fs');
const path = require('path');

const URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const DEST = path.join(__dirname, '..', 'data', 'public_suffix_list.dat');

async function main() {
  const resp = await fetch(URL);
  if (!resp.ok) {
    throw new Error(`下载失败：HTTP ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  if (!text.includes('===BEGIN ICANN DOMAINS===') ||
      !text.includes('===BEGIN PRIVATE DOMAINS===')) {
    throw new Error('下载内容缺少 ICANN / PRIVATE 段标记，已放弃写入');
  }
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  fs.writeFileSync(DEST, text);
  const version = (text.match(/^\/\/\s*VERSION:\s*(\S+)/m) || [])[1] || 'unknown';
  console.log(`公共后缀列表已更新：${DEST}（VERSION ${version}，${text.length} 字节）`);
}

main().catch((err) => {
  console.error('更新公共后缀列表失败：' + err.message);
  process.exit(1);
});
