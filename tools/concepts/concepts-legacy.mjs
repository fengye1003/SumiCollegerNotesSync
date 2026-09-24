#!/usr/bin/env node
// concepts.mjs — Concepts App (.concepts) 画布笔记工具
//
// Concepts 的 .concepts 是一个 zip 包，内含：
//   metadata.json   背景色 / 创建时间 / 修改时间 / formatVersion / identifier
//   workspace.pack  界面状态（调色板、工具、缩放）——明文 JSON，非内容
//   resource.pack   资源（此处为空）
//   tree.pack       笔画几何数据（专有二进制，未逆向）
//   thumb.jpg       整幅缩略图 —— 目前唯一可读的内容载体
//
// 用法（工作目录 = vault 根）：
//   node tools/concepts/concepts.mjs list [--json]
//   node tools/concepts/concepts.mjs info <file.concepts>
//   node tools/concepts/concepts.mjs unpack <file.concepts> [outDir]
//   node tools/concepts/concepts.mjs thumb <file.concepts> [outDir]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = process.cwd();
const SCAN_DIR = path.join(ROOT, 'canvas-source');   // 2026-09-24 从 vault 根 Concepts/ 搬入 .AGENT
const REL_PREFIX = path.relative(ROOT, SCAN_DIR).replace(/\\/g, '/') + '/';

// ---- 最小 zip 读取器（本地文件，仅需 stored/deflate）----
function readZip(file) {
  const buf = fs.readFileSync(file);
  // 定位 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效 zip: ' + file);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    entries.push({ name, method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  for (const e of entries) {
    const nlen = buf.readUInt16LE(e.lho + 26);
    const elen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + elen;
    const raw = buf.subarray(start, start + e.csize);
    e.data = e.method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return entries;
}

function entry(entries, name) {
  const e = entries.find((x) => x.name === name);
  if (!e) throw new Error('缺 entry: ' + name);
  return e;
}

function jpegSize(b) {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function walk(dir, acc = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, acc);
    else if (d.name.toLowerCase().endsWith('.concepts')) acc.push(p);
  }
  return acc;
}

// workspace.pack = [5 字节头][JSON][后续二进制]；JSON 长度不固定，需括号配平截取
function readWorkspace(buf) {
  const start = buf.indexOf(0x7b);
  if (start < 0) return null;
  const s = buf.subarray(start).toString('utf8');
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(s.slice(0, end)); } catch { return null; }
}

function parseMeta(file) {
  const entries = readZip(file);
  const meta = JSON.parse(entry(entries, 'metadata.json').data.toString('utf8'));
  const thumb = entry(entries, 'thumb.jpg').data;
  const size = jpegSize(thumb);
  const tree = entry(entries, 'tree.pack').data.length;
  const res = entry(entries, 'resource.pack').data.length;
  const assets = entries
    .filter((e) => e.name.startsWith('resources/'))
    .map((e) => ({ name: e.name, bytes: e.data.length, w: jpegSize(e.data)?.w, h: jpegSize(e.data)?.h }));
  const ws = readWorkspace(entry(entries, 'workspace.pack').data);
  return {
    file, meta, thumbBytes: thumb.length, thumbW: size?.w, thumbH: size?.h,
    treeBytes: tree, resourceBytes: res, assets, palette: ws?.color_palette ?? null,
    zoom: ws?.tool_wheel?.zoom_level ?? null,
    layersMargin: ws?.layers?.margin ?? null,
    rel: path.relative(ROOT, file).replace(/\\/g, '/'),
  };
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const cmd = process.argv[2] || 'list';
const args = process.argv.slice(3);

if (cmd === 'list') {
  const files = walk(SCAN_DIR).sort();
  const out = files.map(parseMeta);
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  if (args.includes('--md')) {
    console.log('| 课程/文件 | 体积 | 创建 | 修改 | 缩略图 | 笔画 | 内嵌图 |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of out) {
      const seg = r.rel.replace(REL_PREFIX, '').replace(/\.concepts$/, '').split('/');
      const name = seg.slice(2).join('/') || seg.join('/');
      const assetStr = r.assets.length
        ? `${r.assets.length} 张（${(r.assets.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(1)} MB）`
        : '—';
      console.log(`| ${seg[1] || ''} / ${name} | ${(fs.statSync(r.file).size / 1024).toFixed(0)} KB | ${fmtDate(r.meta.creationTime)} | ${fmtDate(r.meta.modificationTime)} | ${r.thumbW}×${r.thumbH} | ${(r.treeBytes / 1024).toFixed(0)} KB | ${assetStr} |`);
    }
    process.exit(0);
  }
  console.log(['课程/文件', 'KB', '创建', '修改', '缩略图', '笔画KB', '内嵌图', 'zoom', '层偏移'].join('\t'));
  for (const r of out) {
    const seg = r.rel.replace(REL_PREFIX, '').replace(/\.concepts$/, '').split('/');
    const name = seg.slice(2).join('/') || seg.join('/');
    const assetStr = r.assets.length
      ? `${r.assets.length}张 ${(r.assets.reduce((a, b) => a + b.bytes, 0) / 1048576).toFixed(1)}MB`
      : '-';
    console.log([
      `${seg[1] || ''}/${name}`,
      (fs.statSync(r.file).size / 1024).toFixed(0),
      fmtDate(r.meta.creationTime),
      fmtDate(r.meta.modificationTime),
      `${r.thumbW}x${r.thumbH}`,
      (r.treeBytes / 1024).toFixed(0),
      assetStr,
      r.zoom ?? '-',
      r.layersMargin ? `(${r.layersMargin.x},${r.layersMargin.y})` : '-',
    ].join('\t'));
  }
} else if (cmd === 'unpackall') {
  const base = path.resolve(args[0] || path.join(ROOT, 'tools/concepts/_work'));
  fs.rmSync(base, { recursive: true, force: true });
  const files = walk(SCAN_DIR).sort();
  for (const f of files) {
    const key = path.relative(SCAN_DIR, f).replace(/\.concepts$/, '').split(path.sep).slice(1).join('__');
    const outDir = path.join(base, key);
    fs.mkdirSync(outDir, { recursive: true });
    for (const e of readZip(f)) {
      const dest = path.join(outDir, e.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
    }
    console.log('✓ ' + key);
  }
  console.log('共 ' + files.length + ' 个');
} else if (cmd === 'assets') {
  const file = path.resolve(args[0]);
  const info = parseMeta(file);
  const outDir = path.resolve(args[1] || path.join(ROOT, 'tools/concepts/_assets', path.basename(file, '.concepts')));
  fs.mkdirSync(outDir, { recursive: true });
  const entries = readZip(file).filter((e) => e.name.startsWith('resources/'));
  for (const e of entries) fs.writeFileSync(path.join(outDir, path.basename(e.name)), e.data);
  console.log(JSON.stringify(info.assets.map((a) => ({ ...a, out: path.join(outDir, path.basename(a.name)) })), null, 2));
} else if (cmd === 'info') {
  console.log(JSON.stringify(parseMeta(path.resolve(args[0])), null, 2));
} else if (cmd === 'unpack' || cmd === 'thumb') {
  const file = path.resolve(args[0]);
  const outDir = path.resolve(args[1] || path.join(ROOT, 'tools/concepts/_work', path.basename(file, '.concepts')));
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of readZip(file)) {
    if (cmd === 'thumb' && e.name !== 'thumb.jpg') continue;
    fs.writeFileSync(path.join(outDir, e.name), e.data);
  }
  console.log('✓ ' + outDir);
} else {
  console.error('未知命令: ' + cmd);
  process.exit(2);
}
