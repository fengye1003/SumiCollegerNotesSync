#!/usr/bin/env node
// check-links.mjs —— 校验 Markdown 里的 [[wikilink]] 是否都能在本库找到目标（按 basename 建索引）
// 用途：批量生成/改写笔记后，确认没有"死链"（知识库里断链 = 图谱里的孤立点）
// 用法: node tools/obsidian/check-links.mjs <库根目录> [子目录...]
//   例: node tools/obsidian/check-links.mjs . notes projects
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const only = process.argv.slice(3);
const index = new Map();      // basename -> [相对路径]
const IGNORE = new Set(['.git', '.obsidian', 'node_modules']);

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) {
      const b = e.name.replace(/\.md$/, '');
      if (!index.has(b)) index.set(b, []);
      index.get(b).push(path.relative(root, p));
    }
  }
}
walk(root);

let files = 0, links = 0, dead = 0, ambiguous = 0;
const targets = only.length ? only.map((d) => path.join(root, d)) : [root];
for (const t of targets) {
  if (!fs.existsSync(t)) continue;
  const list = fs.statSync(t).isDirectory()
    ? (function collect(d, acc = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) collect(p, acc); else if (e.name.endsWith('.md')) acc.push(p); } return acc; })(t)
    : [t];
  for (const f of list) {
    files++;
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      const target = m[1].trim();
      links++;
      const hits = index.get(target) || index.get(target.replace(/^.*\//, ''));
      if (!hits) { console.log(`DEAD      ${path.relative(root, f)}  ->  [[${target}]]`); dead++; }
      else if (hits.length > 1) { console.log(`AMBIGUOUS ${path.relative(root, f)}  ->  [[${target}]]  (${hits.length} 个同名: ${hits.slice(0, 3).join(' / ')})`); ambiguous++; }
    }
  }
}
console.log(`\n检查 ${files} 篇、链接 ${links} 条：断链 ${dead}，歧义 ${ambiguous}`);
process.exit(dead || ambiguous ? 1 : 0);
