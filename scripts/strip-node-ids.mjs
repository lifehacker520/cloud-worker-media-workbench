#!/usr/bin/env node
/**
 * strip-node-ids.mjs — 交付前剥离 WorkBuddy artifact 注入的 data-page-node-id 属性。
 *
 * 背景：WorkBuddy 的 artifact 预览面板会为 public/index.html 的节点追加
 * data-page-node-id 标记（用于预览定位），并在文件变化后回写源文件。
 * 该属性不应进入 electron-builder 安装包与 git 历史，本脚本在打包前统一剥离。
 *
 * 用法：node scripts/strip-node-ids.mjs [目录]   # 默认 public/
 * 退出码：0 = 成功；1 = 目录不存在。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2] || join(process.cwd(), 'public');
const EXT = new Set(['.html', '.htm', '.svg']);
const RE = /\s+data-page-node-id="[^"]*"/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (EXT.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

let files = 0, removed = 0;
for (const file of walk(root)) {
  const src = readFileSync(file, 'utf8');
  const hits = src.match(RE);
  if (!hits) continue;
  writeFileSync(file, src.replace(RE, ''));
  files += 1;
  removed += hits.length;
  console.log(`stripped ${hits.length} attribute(s) from ${file}`);
}
console.log(`done: ${removed} attribute(s) removed across ${files} file(s)`);
