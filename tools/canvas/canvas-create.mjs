#!/usr/bin/env node
// canvas-create.mjs v2 -- 自己生成 Obsidian Canvas（JSON Canvas 1.0）
//   v2（2026-09-24）：修用户实测发现的两个真问题 —— ① 分组框互相叠；② 尺寸算不够（中文按 15px/字估宽
//                    导致换行撑破、文件卡按 234×140 给而 Obsidian 实际渲染大得多）。
//                    同时新增 **重叠自检**（节点×节点、分组×分组），把"不叠"变成可验证的事。
//
// 规格依据 https://jsoncanvas.org/spec/1.0/（2026-09-24 核对）：
//   · 顶层 { nodes: [], edges: [] }（两个数组都可选；**没有 version 字段**）
//   · 节点通用（全部必填）：id, type, x, y, width, height（整数）；可选 color
//   · text 需 text；file 需 file（可选 subpath）；link 需 url；group 可选 label/background/backgroundStyle
//   · 边：id/fromNode/toNode 必填；fromSide/toSide 可选（top|right|bottom|left）
//        fromEnd 默认 none、toEnd 默认 arrow；可选 color/label
//   · 颜色："1"红 "2"橙 "3"黄 "4"绿 "5"青 "6"紫，或 "#RRGGBB"
//   · nodes 按 z-index 升序 → 分组必须排最前；分组**没有成员字段**，靠几何包含判定
//
// 用法（vault 根）：
//   node canvas-create.mjs mindmap <大纲.md> -o <out.canvas> [--groups --normalize]
//   node canvas-create.mjs from-json <spec.json> -o <out.canvas>
// 大纲：
//   # 根标题
//   - 一级分支 @@颜色=6                 ← 不写就按顺序自动上色（1~6）
//     - 二级 [[笔记名]]                 ← 行内 [[..]] 渲染成可点链接
//     - 挂文件 {file:路径.md}            ← 变 file 卡片（默认 400×280，可 --file-size WxH）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0];
const argOf = (n, d) => { for (const k of ['--' + n, '-' + n]) { const i = argv.indexOf(k); if (i > 0 && argv[i + 1] !== undefined) return argv[i + 1]; } return d; };
const has = (n) => argv.includes('--' + n) || (n.length === 1 && argv.includes('-' + n));
const ROOT = process.cwd();

// ── 尺寸估算（对齐 Obsidian 实际渲染：中文约 19~20px/字、行高 26、内边距 34）────
const CJK = 20, ASCII = 10, PAD_W = 36, LINE_H = 27, PAD_H = 30;
const GROUP_LABEL_H = 40;          // 分组框标签占用的顶部高度

const rid = () => Array.from({ length: 16 }, () => '0<PASSWORD>789abcdef'[Math.floor(Math.random() * 16)]).join('');
const display = (s) => String(s)
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  .replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/[*_`>#]/g, '').trim();
const textW = (s) => [...s].reduce((a, c) => a + (/[\u2E80-\uFFFD]/.test(c) ? CJK : ASCII), 0);

function textNodeSize(text, wmax) {
  const raw = String(text).split('\n').map(display);
  const need = Math.max(120, ...raw.map(textW));
  const width = Math.round(Math.min(wmax, need + PAD_W));
  const avail = width - PAD_W;
  let lines = 0;
  for (const l of raw) lines += Math.max(1, Math.ceil(textW(l) / Math.max(40, avail)));
  return { width, height: Math.round(lines * LINE_H + PAD_H) };
}

function parseOutline(md) {
  const root = { text: '根', children: [], depth: 0, file: null, color: null };
  const stack = [{ node: root, indent: -1 }];
  let title = null;
  for (const raw of md.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^#\s+/.test(raw) && title === null && !/^\s/.test(raw)) { title = raw.replace(/^#\s+/, '').trim(); continue; }
    const m = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '    ').length;
    let text = m[2].trim();
    let color = null, file = null;
    const cm = /@@颜色\s*=\s*([1-6]|#[0-9a-fA-F]{6})/.exec(text);
    if (cm) { color = cm[1]; text = text.replace(cm[0], '').trim(); }
    const fm = /\{file:([^}]+)\}/.exec(text);
    if (fm) { file = fm[1].trim(); text = text.replace(fm[0], '').trim(); }
    const node = { text, color, file, children: [], depth: 0 };
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    node.depth = parent.depth + 1;
    parent.children.push(node);
    stack.push({ node, indent });
  }
  if (title) root.text = title;
  if (root.children.length === 1 && !title) return root.children[0];
  return root;
}

// ── 布局 ────────────────────────────────────────────────────────────────────
function sizeAll(n, opt) {
  if (n.file) { n.width = opt.fileW; n.height = opt.fileH; }
  else Object.assign(n, textNodeSize(n.text, opt.wmax));
  n.children.forEach((c) => sizeAll(c, opt));
}
// 自底向上：算出每棵子树高度，子块在子树内居中排布（相对偏移存进 _relY）
function place(n, opt) {
  if (!n.children.length) { n.subH = n.height; return n.subH; }
  let total = 0;
  for (const c of n.children) total += place(c, opt) + opt.gapY;
  total -= opt.gapY;
  n.subH = Math.max(n.height, total);
  let y = (n.subH - total) / 2;
  for (const c of n.children) { c._relY = y; y += c.subH + opt.gapY; }
  return n.subH;
}
// 自顶向下：topY = 该子树盒子的顶边；父节点在自己子树里垂直居中。dir=+1 向右长、-1 向左长
function placeAt(n, x, topY, opt, dir = 1) {
  n.x = x;
  n.y = topY + (n.subH - n.height) / 2;
  n._dir = dir;
  for (const c of n.children) {
    const cx = dir > 0 ? x + n.width + opt.gapX : x - opt.gapX - c.width;
    placeAt(c, cx, topY + c._relY, opt, dir);
  }
}
// 带分组：每个一级分支独占一个"槽"；--split（默认开）把分支左右分栏，图更矮更像个思维导图
function layoutWithGroups(root, opt) {
  Object.assign(root, textNodeSize(root.text, opt.wmax));
  let curR = 0, curL = 0;
  root.children.forEach((b, i) => {
    place(b, opt);
    b._groupH = b.subH + opt.pad * 2 + GROUP_LABEL_H;
    const dir = (opt.split && i % 2 === 1) ? -1 : 1;
    b._dir = dir;
    if (dir > 0) { b._groupTop = curR; curR += b._groupH + opt.branchGap; }
    else { b._groupTop = curL; curL += b._groupH + opt.branchGap; }
  });
  const colH = Math.max(curR - opt.branchGap, curL - opt.branchGap, root.height);
  root.subH = colH;
  root.x = 0;
  root.y = (colH - root.height) / 2;
  for (const b of root.children) {
    const top = b._groupTop + GROUP_LABEL_H + opt.pad;
    const x = b._dir > 0 ? root.x + root.width + opt.gapX : root.x - opt.gapX - b.width;
    placeAt(b, x, top, opt, b._dir);
  }
}
function layoutPlain(root, opt) { place(root, opt); placeAt(root, 0, 0, opt, 1); }

// ── 构建 ────────────────────────────────────────────────────────────────────
function build(root, opt) {
  const nodes = [], edges = [];
  const flats = [];
  const collect = (n, branch) => { flats.push({ n, branch }); n.children.forEach((c) => collect(c, branch)); };
  root.children.forEach((b) => collect(b, b.text));
  if (opt.groups && root.children.length) {
    for (const b of root.children) {
      const members = flats.filter((f) => f.branch === b.text).map((f) => f.n);
      const x0 = Math.min(b.x, ...members.map((n) => n.x)) - opt.pad;
      const x1 = Math.max(...members.map((n) => n.x + n.width)) + opt.pad;
      const g = { id: rid(), type: 'group', x: Math.round(x0), y: Math.round(b._groupTop), width: Math.round(x1 - x0), height: Math.round(b._groupH), label: display(b.text) };
      if (b.color && !b.file) g.color = b.color;      // 文件引用分支不上色（不是科目，留默认灰）
      nodes.push(g);
    }
  }
  for (const { n } of [{ n: root }, ...flats]) {
    const base = { id: n.id, x: Math.round(n.x), y: Math.round(n.y), width: Math.round(n.width), height: Math.round(n.height) };
    if (n.file) { nodes.push({ ...base, type: 'file', file: n.file }); continue; }
    const node = { ...base, type: 'text', text: n.text };
    if (n.color) node.color = n.color;
    nodes.push(node);
  }
  const link = (p) => p.children.forEach((c) => {
    const left = (c._dir ?? 1) < 0;
    edges.push({ id: rid(), fromNode: p.id, fromSide: left ? 'left' : 'right', toNode: c.id, toSide: left ? 'right' : 'left' });
    link(c);
  });
  link(root);
  return { nodes, edges };
}

function serialize(canvas) {
  const one = (o) => JSON.stringify(o);
  return '{\n\t"nodes":[\n' + canvas.nodes.map((n, i) => '\t\t' + one(n) + (i < canvas.nodes.length - 1 ? ',' : '')).join('\n') +
    '\n\t],\n\t"edges":[\n' + canvas.edges.map((e, i) => '\t\t' + one(e) + (i < canvas.edges.length - 1 ? ',' : '')).join('\n') + '\n\t]\n}\n';
}
const assignIds = (root) => { const w = (n) => { n.id = rid(); n.children.forEach(w); }; w(root); };
// 自动上色：只给"主题分支"（非文件引用）按顺序发色，文件引用分支留默认灰
const autoColor = (root) => { let i = 0; for (const b of root.children) { if (b.file) continue; if (!b.color) b.color = ['1', '2', '3', '4', '5', '6'][i % 6]; i++; } };
function normalize(nodes) {
  const ng = nodes.filter((n) => n.type !== 'group');
  const cx = Math.min(...ng.map((n) => n.x)), cy = Math.min(...ng.map((n) => n.y));
  if (!isFinite(cx) || !isFinite(cy)) return;
  for (const n of nodes) { n.x -= cx; n.y -= cy; }
}

// ── 自检：字段合法性 + 重叠检测 ──────────────────────────────────────────────
const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function selfCheck(canvas) {
  const errs = [];
  const ids = new Set();
  for (const n of canvas.nodes) {
    if (!n.id || !n.type || ![n.x, n.y, n.width, n.height].every(Number.isInteger)) errs.push(`字段不合法（坐标需整数）: ${JSON.stringify(n).slice(0, 90)}`);
    if (ids.has(n.id)) errs.push(`重复 id: ${n.id}`);
    ids.add(n.id);
    if (n.type === 'text' && typeof n.text !== 'string') errs.push(`text 节点缺 text: ${n.id}`);
    if (n.type === 'file' && typeof n.file !== 'string') errs.push(`file 节点缺 file: ${n.id}`);
  }
  for (const e of canvas.edges) {
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) errs.push(`边指向不存在的节点: ${e.id}`);
    for (const s of [e.fromSide, e.toSide]) if (s && !['top', 'right', 'bottom', 'left'].includes(s)) errs.push(`非法 side: ${s}`);
    for (const v of [e.fromEnd, e.toEnd]) if (v && !['none', 'arrow'].includes(v)) errs.push(`非法 end: ${v}`);
  }
  const groups = canvas.nodes.filter((n) => n.type === 'group');
  const content = canvas.nodes.filter((n) => n.type !== 'group');
  const nm = (n) => display(n.text || n.file || n.label || '') .slice(0, 24);
  for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) if (hit(content[i], content[j])) errs.push(`节点互相重叠: 「${nm(content[i])}」×「${nm(content[j])}」`);
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) if (hit(groups[i], groups[j])) errs.push(`分组框互相重叠: 「${groups[i].label}」×「${groups[j].label}」`);
  return errs;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const [fw, fh] = String(argOf('file-size', '400x280')).split('x').map(Number);
const opt = {
  gapX: +argOf('gap-x', 120), gapY: +argOf('gap-y', 40), branchGap: +argOf('branch-gap', 70),
  pad: +argOf('pad', 30), wmax: +argOf('width-max', 560),
  fileW: fw || 400, fileH: fh || 280,
  groups: has('groups'), noColors: has('no-colors'), split: !has('no-split'),
};
const out = argOf('o', null);
if (!cmd || !out) { console.log('用法: canvas-create.mjs mindmap <大纲.md> -o <out.canvas> [--groups --normalize --gap-x 120 --gap-y 40 --branch-gap 70 --file-size 400x280]'); process.exit(2); }

let canvas;
if (cmd === 'mindmap') {
  const src = argv[1];
  const md = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
  const root = parseOutline(md);
  assignIds(root);
  sizeAll(root, opt);
  if (!opt.noColors) autoColor(root);
  if (opt.groups) layoutWithGroups(root, opt); else layoutPlain(root, opt);
  canvas = build(root, opt);
  if (has('normalize')) normalize(canvas.nodes);
} else if (cmd === 'from-json') {
  canvas = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'));
  canvas.nodes = canvas.nodes || []; canvas.edges = canvas.edges || [];
  for (const n of canvas.nodes) if (!n.id) n.id = rid();
} else { console.log('未知命令: ' + cmd); process.exit(2); }

const errs = selfCheck(canvas);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(path.resolve(out), serialize(canvas), 'utf8');
const minX = Math.min(...canvas.nodes.map((n) => n.x)), minY = Math.min(...canvas.nodes.map((n) => n.y));
const box = { w: Math.round(Math.max(...canvas.nodes.map((n) => n.x + n.width)) - minX), h: Math.round(Math.max(...canvas.nodes.map((n) => n.y + n.height)) - minY) };
console.log(`${path.relative(ROOT, path.resolve(out))} 已生成：节点 ${canvas.nodes.length}（text ${canvas.nodes.filter((n) => n.type === 'text').length} / file ${canvas.nodes.filter((n) => n.type === 'file').length} / group ${canvas.nodes.filter((n) => n.type === 'group').length}）· 连线 ${canvas.edges.length} · 画布 ${box.w}×${box.h}`);
console.log(errs.length ? '❌ 自检不通过:\n  ' + errs.join('\n  ') : '✅ 自检通过（字段合法 · id 唯一 · 边引用有效 · 无节点重叠 · 无分组重叠）');
process.exit(errs.length ? 1 : 0);
