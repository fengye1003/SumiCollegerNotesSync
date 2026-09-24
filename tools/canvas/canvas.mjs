#!/usr/bin/env node
/**
 * canvas.mjs — Obsidian Canvas 解析工具（星澄专用）
 *
 * 目标：让星澄可以直接读取并解析 vault 里的 .canvas 文件（Obsidian 白板）。
 * 纯 Node 标准库实现，无任何外部依赖，支持中文路径。
 *
 * 用法概览：
 *   node canvas.mjs scan                          # 扫描整个 vault 的 canvas 概览
 *   node canvas.mjs info <文件/目录>...            # 单文件/多文件统计
 *   node canvas.mjs dump <文件>...                 # 完整可读渲染（默认命令）
 *   node canvas.mjs text <文件>... [--short]       # 仅提取文本内容（喂上下文用）
 *   node canvas.mjs graph <文件>...                # 连线表
 *   node canvas.mjs files <文件>...                # 文件引用清单 + 存在性检查
 *   node canvas.mjs find <关键词> [目录]           # 全库搜索 canvas 文本
 *   node canvas.mjs parse <文件>... --json         # 输出规范化 JSON（程序化使用）
 *
 * 通用选项：
 *   --json            JSON 输出
 *   --vault <路径>    指定 vault 根（默认自动向上找 .obsidian）
 *   --short           截断长文本（默认 300 字，--max-text 可调）
 *   --max-text <n>    截断长度
 *   --sort            节点按 (y,x) 阅读顺序排序
 *   -n <num>          每类最多显示条数
 *
 * Obsidian canvas 格式要点（vault 实测归纳）：
 *   - 顶层 { nodes: [], edges: [] }；空白板为 {}
 *   - 节点类型：text(文本) / file(文件, vault 相对路径) / group(分组, 纯几何无成员字段)
 *               / link(网页链接)
 *   - 节点通用字段：id, x, y, width, height, color("1"~"6")
 *   - 边：fromNode, toNode, fromSide, toSide, 可选 label / color / fromEnd / toEnd
 *   - 颜色映射：1红 2橙 3黄 4绿 5青 6紫
 */

import fs from 'node:fs';
import path from 'node:path';

const COLORS = {
  '1': { en: 'red', zh: '红' },
  '2': { en: 'orange', zh: '橙' },
  '3': { en: 'yellow', zh: '黄' },
  '4': { en: 'green', zh: '绿' },
  '5': { en: 'cyan', zh: '青' },
  '6': { en: 'purple', zh: '紫' },
};
const TYPE_ZH = { text: '文本', file: '文件', group: '分组', link: '链接' };

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const opts = {
    command: null, paths: [], pattern: null,
    json: false, short: false, sort: false, vault: null,
    maxText: 300, limit: 0, recursive: true,
  };
  const commands = new Set(['scan', 'info', 'dump', 'text', 'graph', 'files', 'find', 'parse']);
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--short') opts.short = true;
    else if (a === '--sort') opts.sort = true;
    else if (a === '--no-recursive') opts.recursive = false;
    else if (a === '--vault') opts.vault = argv[++i];
    else if (a === '--max-text') opts.maxText = parseInt(argv[++i], 10) || 300;
    else if (a === '-n' || a === '--limit') opts.limit = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('-')) console.error(`⚠️ 忽略未知选项: ${a}`);
    else positionals.push(a);
  }
  if (positionals.length && commands.has(positionals[0])) opts.command = positionals.shift();
  if (opts.command === 'find') {
    opts.pattern = positionals.shift() || null;
    if (!opts.pattern) {
      console.error('❌ find 需要关键词，用法: node canvas.mjs find <关键词> [目录]');
      process.exit(1);
    }
  }
  opts.paths = positionals;
  return opts;
}

// ---------------------------------------------------------------- 工具函数

function warn(msg) { console.error(`⚠️ ${msg}`); }

function findVaultRoot(startDir) {
  let d = path.resolve(startDir);
  for (;;) {
    try {
      if (fs.statSync(path.join(d, '.obsidian')).isDirectory()) return d;
    } catch { /* 继续向上 */ }
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

function defaultVaultRoot() {
  const cwd = process.cwd();
  return findVaultRoot(cwd) || cwd;
}

function collectCanvasFiles(entries, recursive) {
  const out = new Set();
  const SKIP = new Set(['.obsidian', '.git', '.AGENT', '.HELPER_DO_NOT_MODIFY_EXCEPT_DOT_AGENT', 'node_modules', '.trash']);
  function walk(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (recursive) walk(p); }
      else if (name.toLowerCase().endsWith('.canvas')) out.add(p);
    }
  }
  for (const e of entries) {
    const p = path.resolve(e);
    let st;
    try { st = fs.statSync(p); } catch { warn(`未找到路径: ${e}`); continue; }
    if (st.isFile()) {
      if (p.toLowerCase().endsWith('.canvas')) out.add(p);
      else warn(`不是 .canvas 文件，跳过: ${e}`);
    } else if (st.isDirectory()) walk(p);
  }
  return [...out].sort();
}

function colorName(c) {
  const m = COLORS[String(c)];
  return m ? `${m.zh}(${m.en})` : (c || '');
}

function fmtPos(n) {
  return `(${n.x},${n.y},${n.width}×${n.height})`;
}

// ---------------------------------------------------------------- 解析

function parseCanvas(filePath, vaultRoot) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { path: filePath, error: `读取失败: ${e.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { path: filePath, error: `JSON 解析失败: ${e.message}` };
  }
  const rawNodes = Array.isArray(data.nodes) ? data.nodes : [];
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];

  const nodes = rawNodes.map((n, i) => {
    const type = n.type || 'text';
    const node = {
      id: n.id || `node_${i}`,
      type,
      x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0,
      color: n.color ?? null,
      colorName: colorName(n.color),
      title: '',
    };
    if (type === 'text') node.text = n.text ?? '';
    else if (type === 'file') node.file = n.file ?? '';
    else if (type === 'link') node.url = n.url ?? '';
    else if (type === 'group') node.label = n.label ?? '';
    node.title = titleOf(node);
    return node;
  });

  // 分组归属：纯几何包含判定，取面积最小的包含分组（最内层）
  const groups = nodes.filter((n) => n.type === 'group');
  for (const n of nodes) {
    if (n.type === 'group') { n.groupId = null; continue; }
    let best = null, bestArea = Infinity;
    for (const g of groups) {
      if (g.x <= n.x && g.y <= n.y && n.x + n.width <= g.x + g.width && n.y + n.height <= g.y + g.height) {
        const area = g.width * g.height;
        if (area < bestArea) { bestArea = area; best = g; }
      }
    }
    n.groupId = best ? best.id : null;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = rawEdges.map((e, i) => ({
    id: e.id || `edge_${i}`,
    fromNode: e.fromNode, toNode: e.toNode,
    fromSide: e.fromSide ?? null, toSide: e.toSide ?? null,
    label: e.label ?? null,
    color: e.color ?? null,
    colorName: colorName(e.color),
    fromEnd: e.fromEnd ?? null, toEnd: e.toEnd ?? null,
  }));

  // 文件引用解析
  const fileRefs = nodes
    .filter((n) => n.type === 'file' && n.file)
    .map((n) => {
      const rel = n.file.replace(/\//g, path.sep);
      const abs = path.join(vaultRoot, rel);
      return { nodeId: n.id, file: n.file, absPath: abs, exists: fs.existsSync(abs) };
    });

  // 边界框
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
  }
  const bbox = nodes.length ? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY } : null;

  const byType = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] || 0) + 1;

  let mtime = null;
  try { mtime = fs.statSync(filePath).mtime.toISOString(); } catch { /* ignore */ }

  return {
    path: filePath,
    vault: vaultRoot,
    relPath: path.relative(vaultRoot, filePath),
    mtime,
    error: null,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    byType,
    bbox,
    nodes,
    groups,
    edges,
    fileRefs,
    byId,
  };
}

function titleOf(n) {
  switch (n.type) {
    case 'group': return n.label || '未命名分组';
    case 'file': return n.file ? path.basename(n.file) : '未命名文件';
    case 'link': return n.url || '未命名链接';
    default: {
      const t = (n.text || '').replace(/\r/g, '');
      const first = t.split('\n').map((s) => s.trim()).find(Boolean);
      if (!first) return '（空文本）';
      return first.replace(/^#{1,6}\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\[\[|\]\]$/g, '').slice(0, 80);
    }
  }
}

function fullText(n, maxText, short) {
  if (n.type !== 'text') return '';
  let t = (n.text || '').replace(/\r/g, '').trim();
  if (short && t.length > maxText) t = t.slice(0, maxText) + '…';
  return t;
}

function edgeLine(e, byId) {
  const from = byId.get(e.fromNode), to = byId.get(e.toNode);
  const fromT = from ? from.title : e.fromNode;
  const toT = to ? to.title : e.toNode;
  let s = `${fromT} → ${toT}`;
  const parts = [];
  if (e.label) parts.push(`「${e.label}」`);
  if (e.colorName) parts.push(`颜色:${e.colorName}`);
  if (e.fromEnd === 'arrow') parts.push('出发端箭头');
  if (e.toEnd === 'arrow') parts.push('到达端箭头');
  if (parts.length) s += `  [${parts.join(' | ')}]`;
  return s;
}

// ---------------------------------------------------------------- 输出

function sortNodes(nodes, sort) {
  const arr = [...nodes];
  if (sort) arr.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return arr;
}

function outInfo(c, opts) {
  if (c.error) return `❌ ${c.path}\n   ${c.error}`;
  const lines = [];
  const b = c.byType;
  const typeParts = Object.keys(b)
    .map((t) => `${TYPE_ZH[t] || t} ${b[t]}`)
    .join(' · ');
  lines.push(`📐 ${path.basename(c.path)}`);
  lines.push(`  位置: ${c.relPath}${c.mtime ? ` · 更新: ${c.mtime.slice(0, 10)}` : ''}`);
  lines.push(`  节点 ${c.nodeCount}（${typeParts}）· 连线 ${c.edgeCount}`);
  if (c.bbox) lines.push(`  画布尺寸: ${c.bbox.width}×${c.bbox.height}`);
  if (c.groups.length) {
    const gs = c.groups.map((g) => {
      const members = c.nodes.filter((n) => n.groupId === g.id).length;
      return `${g.title}${g.colorName ? `(${g.colorName})` : ''} 成员${members}`;
    });
    lines.push(`  分组: ${gs.join(' · ')}`);
  }
  if (c.fileRefs.length) {
    const missing = c.fileRefs.filter((f) => !f.exists).length;
    lines.push(`  文件引用 ${c.fileRefs.length}${missing ? `（⚠️ ${missing} 个缺失）` : ''}`);
  }
  return lines.join('\n');
}

function outDump(c, opts) {
  if (c.error) return `❌ ${c.path}\n   ${c.error}`;
  const L = [];
  L.push(`# 📐 ${path.basename(c.path)}`);
  L.push(`> 位置: ${c.relPath} · 节点 ${c.nodeCount} · 连线 ${c.edgeCount}`);
  if (c.bbox) L.push(`> 画布尺寸: ${c.bbox.width}×${c.bbox.height}`);

  // 分组
  if (c.groups.length) {
    L.push('');
    L.push(`## 分组 (${c.groups.length})`);
    for (const g of c.groups) {
      const members = c.nodes.filter((n) => n.groupId === g.id);
      L.push(`- [G] ${g.title}${g.colorName ? `（${g.colorName}）` : ''} ${fmtPos(g)} · 含 ${members.length} 个节点`);
    }
  }

  // 节点：先按分组归纳，未分组的单列
  L.push('');
  L.push(`## 节点 (${c.nodeCount})`);
  const sorted = sortNodes(c.nodes, opts.sort);
  const groupKeys = c.groups.map((g) => g.id);
  const byGroup = new Map(groupKeys.map((id) => [id, []]));
  const loose = [];
  for (const n of sorted) {
    if (n.type === 'group') continue;
    if (n.groupId && byGroup.has(n.groupId)) byGroup.get(n.groupId).push(n);
    else loose.push(n);
  }
  let shownNodes = 0, shownEdges = 0;
  const cap = (arr) => {
    const out = [...arr];
    if (opts.limit > 0 && out.length > opts.limit) {
      out.splice(opts.limit);
      out.push(`…（另有 ${arr.length - opts.limit} 条略）`);
    }
    return out;
  };
  for (const g of c.groups) {
    const members = cap(byGroup.get(g.id) || []);
    if (!members.length) continue;
    L.push(`### 🗂 ${g.title}${g.colorName ? `（${g.colorName}）` : ''}`);
    for (const n of members) {
      if (typeof n === 'string') { L.push(n); continue; }
      shownNodes++;
      L.push(nodeLine(n, opts));
    }
  }
  if (loose.length) {
    L.push('### 未分组');
    for (const n of cap(loose)) {
      if (typeof n === 'string') { L.push(n); continue; }
      shownNodes++;
      L.push(nodeLine(n, opts));
    }
  }
  if (!shownNodes) L.push('（空白板）');

  // 连线
  L.push('');
  L.push(`## 连线 (${c.edgeCount})`);
  const edges = cap(c.edges);
  for (const e of edges) {
    if (typeof e === 'string') { L.push(e); continue; }
    shownEdges++;
    L.push(`- ${edgeLine(e, c.byId)}`);
  }
  if (!shownEdges) L.push('（无连线）');
  return L.join('\n');
}

function nodeLine(n, opts) {
  const tag = { text: '[T]', file: '[F]', link: '[L]' }[n.type] || '[?]';
  const parts = [`- ${tag} ${n.title}`];
  if (n.colorName) parts.push(`（${n.colorName}）`);
  parts.push(fmtPos(n));
  if (n.type === 'file') {
    parts.push(`\`${n.file}\``);
    const ref = opts.fileRefsByNode && opts.fileRefsByNode.get(n.id);
    if (ref) parts.push(ref.exists ? '✅' : '❌缺失');
  }
  let line = parts.join(' ');
  const t = fullText(n, opts.maxText, opts.short);
  if (t) line += `\n    ${t.replace(/\n/g, '\n    ')}`;
  return line;
}

function outText(c, opts) {
  if (c.error) return `❌ ${c.path}\n   ${c.error}`;
  const L = [`## 📐 ${path.basename(c.path)}`];
  for (const n of c.nodes) {
    if (n.type === 'group') continue;
    if (n.type === 'text') {
      const t = fullText(n, opts.maxText, opts.short);
      if (t) L.push(t);
    } else if (n.type === 'file') {
      L.push(`[[${n.file}]]`);
    } else if (n.type === 'link') {
      L.push(`[${n.url}](${n.url})`);
    }
  }
  return L.join('\n\n');
}

function outGraph(c, opts) {
  if (c.error) return `❌ ${c.path}\n   ${c.error}`;
  const L = [`## 📐 ${path.basename(c.path)} — 连线表 (${c.edgeCount})`];
  const edges = opts.limit > 0 ? c.edges.slice(0, opts.limit) : c.edges;
  for (const e of edges) {
    const from = c.byId.get(e.fromNode), to = c.byId.get(e.toNode);
    const dir = from && to ? `(${e.fromSide || '?'}→${e.toSide || '?'})` : '';
    const meta = [e.label ? `「${e.label}」` : '', e.colorName ? `颜色:${e.colorName}` : '',
      e.fromEnd === 'arrow' ? '出发箭头' : '', e.toEnd === 'arrow' ? '到达箭头' : ''].filter(Boolean).join(' ');
    L.push(`- ${from ? from.title : e.fromNode} ${dir} → ${to ? to.title : e.toNode}${meta ? `  [${meta}]` : ''}`);
  }
  return L.join('\n');
}

function outFiles(c, opts) {
  if (c.error) return `❌ ${c.path}\n   ${c.error}`;
  if (!c.fileRefs.length) return `## 📐 ${path.basename(c.path)} — 无文件引用`;
  const L = [`## 📐 ${path.basename(c.path)} — 文件引用 (${c.fileRefs.length})`];
  for (const f of c.fileRefs) {
    L.push(`- ${f.exists ? '✅' : '❌'} \`${f.file}\``);
  }
  return L.join('\n');
}

function outFind(c, pattern, opts) {
  const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const L = [];
  for (const n of c.nodes) {
    if (n.type !== 'text') continue;
    const t = (n.text || '').replace(/\r/g, '');
    if (!re.test(t)) continue;
    const idx = t.toLowerCase().indexOf(pattern.toLowerCase());
    const start = Math.max(0, idx - 40);
    const end = Math.min(t.length, idx + pattern.length + 60);
    const snippet = (start > 0 ? '…' : '') + t.slice(start, end).replace(/\n/g, ' ') + (end < t.length ? '…' : '');
    L.push(`- ${n.title}\n    ${snippet}`);
  }
  if (!L.length) return null;
  return `## 📐 ${path.basename(c.path)}\n${L.join('\n')}`;
}

function toJSON(c) {
  return {
    path: c.path, relPath: c.relPath, vault: c.vault, mtime: c.mtime,
    error: c.error,
    nodeCount: c.nodeCount, edgeCount: c.edgeCount, byType: c.byType, bbox: c.bbox,
    groups: c.groups.map((g) => ({ id: g.id, label: g.label, x: g.x, y: g.y, width: g.width, height: g.height, color: g.color, colorName: g.colorName })),
    nodes: c.nodes.map((n) => {
      const o = { id: n.id, type: n.type, title: n.title, x: n.x, y: n.y, width: n.width, height: n.height, color: n.color, colorName: n.colorName, groupId: n.groupId };
      if (n.text !== undefined) o.text = n.text;
      if (n.file !== undefined) o.file = n.file;
      if (n.url !== undefined) o.url = n.url;
      if (n.label !== undefined) o.label = n.label;
      return o;
    }),
    edges: c.edges,
    fileRefs: c.fileRefs,
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const vaultRoot = opts.vault ? path.resolve(opts.vault) : defaultVaultRoot();

  let files;
  if (opts.paths.length) {
    files = collectCanvasFiles(opts.paths, opts.recursive);
  } else {
    files = collectCanvasFiles([vaultRoot], opts.recursive);
  }
  if (!files.length) {
    console.error('❌ 没有找到任何 .canvas 文件（可传入文件/目录路径）');
    process.exit(1);
  }

  const canvases = files.map((f) => parseCanvas(f, findVaultRoot(path.dirname(f)) || vaultRoot));
  for (const c of canvases) {
    if (!c.error && c.fileRefs.length) {
      c.fileRefsByNode = new Map(c.fileRefs.map((f) => [f.nodeId, f]));
    }
  }

  const cmd = opts.command || 'dump';

  if (opts.json) {
    if (cmd === 'scan') {
      const res = canvases.map((c) => { const o = toJSON(c); delete o.nodes; delete o.edges; return o; });
      console.log(JSON.stringify(res, null, 2));
    } else if (cmd === 'find') {
      const res = [];
      for (const c of canvases) {
        const re = new RegExp(opts.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        for (const n of c.nodes) {
          if (n.type === 'text' && re.test(n.text || '')) res.push({ canvas: c.relPath, nodeId: n.id, title: n.title, text: n.text });
        }
      }
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(JSON.stringify(canvases.map(toJSON), null, 2));
    }
    return;
  }

  const blocks = [];
  for (const c of canvases) {
    switch (cmd) {
      case 'scan': blocks.push(outInfo(c, opts)); break;
      case 'info': blocks.push(outInfo(c, opts)); break;
      case 'dump': blocks.push(outDump(c, opts)); break;
      case 'text': blocks.push(outText(c, opts)); break;
      case 'graph': blocks.push(outGraph(c, opts)); break;
      case 'files': blocks.push(outFiles(c, opts)); break;
      case 'find': {
        const r = outFind(c, opts.pattern, opts);
        if (r) blocks.push(r);
        break;
      }
      default:
        console.error(`❌ 未知命令: ${cmd}`);
        process.exit(1);
    }
  }
  if (cmd === 'find' && !blocks.length) console.log('未找到匹配内容');
  else console.log(blocks.join('\n\n'));
}

main();
