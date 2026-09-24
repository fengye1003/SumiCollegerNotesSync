#!/usr/bin/env node
// tag-frontmatter.mjs —— 按一份映射表给 Markdown 批量打 frontmatter 标签 + 文末「相关笔记」双链
// 设计思路（可套用到自己的知识库）：
//   · 标签写在 frontmatter（结构化、可被插件消费）**并且**在正文放一行可见标签（手机端也看得到）
//   · 双链一律用 basename（改目录不影响解析）
//   · 首行可插入「继承自[[<入口点>]]」之类的归属行（很多知识库用它把散篇挂到总入口上）
// 用法:
//   node tools/obsidian/tag-frontmatter.mjs <映射.json> [--write] [--dry]
// 映射.json 形如:
//   { "notes/a.md": { "tags": ["领域/子主题","概念"], "links": ["b","c"], "inherit": "笔记入口点", "aliases": ["A"] } }
import fs from 'node:fs';
import path from 'node:path';

const mapFile = process.argv[2];
const WRITE = process.argv.includes('--write');
if (!mapFile) { console.log('用法: node tools/obsidian/tag-frontmatter.mjs <映射.json> [--write]'); process.exit(2); }
const MAP = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

const splitFm = (t) => (t.startsWith('---\n') ? { body: t.slice(t.indexOf('\n---', 4) + 4).replace(/^\n+/, '') } : { body: t });
function fm(title, tags, aliases) {
  const L = ['---', `title: ${title}`, 'tags:'];
  for (const t of tags) L.push(`  - ${t}`);
  if (aliases?.length) { L.push('aliases:'); for (const a of aliases) L.push(`  - ${a}`); }
  return L.join('\n') + '\n---\n\n';
}
const tagline = (body, tags) => {
  const line = `> 🏷 ${tags.map((t) => '#' + t).join(' ')}`;
  if (/^> 🏷 /m.test(body)) return body.replace(/^> 🏷 .*$/m, line);
  const m = /^#\s+.*$/m.exec(body);
  return m ? body.slice(0, m.index + m[0].length) + '\n\n' + line + body.slice(m.index + m[0].length) : line + '\n\n' + body;
};
const withLinks = (body, links) => (!links?.length ? body
  : body.replace(/\s*## 相关笔记[\s\S]*$/, '').replace(/\s*$/, '\n') + ['', '## 相关笔记', '', ...links.map((l) => `- [[${l}]]`), ''].join('\n'));

let n = 0;
for (const [rel, spec] of Object.entries(MAP)) {
  if (!fs.existsSync(rel)) { console.log(`MISSING  ${rel}`); continue; }
  let body = splitFm(fs.readFileSync(rel, 'utf8')).body;
  if (spec.inherit && !body.includes(`[[${spec.inherit}]]`)) body = `继承自[[${spec.inherit}]]。\n\n` + body;
  body = tagline(body, spec.tags || []);
  body = withLinks(body, spec.links);
  const out = fm(spec.title || path.basename(rel, '.md'), spec.tags || [], spec.aliases);
  if (WRITE) fs.writeFileSync(rel, out + body, 'utf8');
  console.log(`${WRITE ? 'OK  ' : 'DRY '} ${rel}  tags=${(spec.tags || []).length} links=${(spec.links || []).length}`);
  n++;
}
console.log(`\n${n} 篇${WRITE ? '已写入' : '（试运行，加 --write 才真写）'}`);
