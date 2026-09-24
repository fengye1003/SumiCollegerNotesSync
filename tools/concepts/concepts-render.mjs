#!/usr/bin/env node
// concepts-render.mjs — 本地把 .concepts 重渲染成位图 / 矢量，并导出 PNG / PDF
// 用法（工作目录 = vault 根）:
//   node tools/concepts/render/concepts-render.mjs scene <f.concepts>
//   node ....mjs png <f.concepts> -o out.png [--scale 2] [--width 2000] [--margin 32]
//                                [--layers 1,2] [--frame x0,y0,x1,y1] [--bg auto|#fff|none]
//                                [--smooth 4] [--radius half|full] [--no-images]
//   node ....mjs pdf <f.concepts> -o out.pdf [...]
//   node ....mjs batch <png|pdf> --outdir <dir> [--glob 课程] [--max 2600] [--dir <扫描根>]
//   node ....mjs scan --dir <扫描根> [--glob 课程] [--md report.md] [--json report.json]
//   node ....mjs tiles <f.concepts> --outdir <dir> [--tile 1100x1100] [--overlap 80] [--scale 2]
//                                  [--layers 1,2] [--prefix 名字]   # 切可读小块供 OCR/判读
//   （--dir 缺省 = `canvas-source`（原 vault 根 Concepts/，2026-09-24 搬入 .AGENT）；
//     batch 的输出名 = 相对 --dir 去掉第一层后的路径，用 __ 连接）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScene, sceneBBox, applyAffine } from './cpack.mjs';
import { Raster, smoothPolyline } from './raster.mjs';
import { writePdf } from './pdfout.mjs';
import { decodeResource, makeDeviceMap, imageMatrix } from './imgsrc.mjs';

const ROOT = process.cwd();
const DEFAULT_SCAN_DIR = path.join(ROOT, 'canvas-source');   // 2026-09-24 从 vault 根 Concepts/ 搬入（避免无意义同步）

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i > 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  if (name.length === 1) {
    const j = process.argv.indexOf('-' + name);
    if (j > 0 && process.argv[j + 1] !== undefined) return process.argv[j + 1];
  }
  return def;
}
const has = (n) => process.argv.includes('--' + n);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, acc);
    else if (d.name.toLowerCase().endsWith('.concepts')) acc.push(p);
  }
  return acc;
}

function transformOf(s) { return s.transform; }

function renderToRaster(scene, frame, opts) {
  const { scale, margin, bg, smooth, radiusMode, layers } = opts;
  const w = Math.max(1, Math.round((frame.maxx - frame.minx) * scale + margin * 2));
  const h = Math.max(1, Math.round((frame.maxy - frame.miny) * scale + margin * 2));
  const r = new Raster(w, h, bg);
  const dx = (x) => (x - frame.minx) * scale + margin;
  const dy = (y) => (frame.maxy - y) * scale + margin;
  // 笔宽来源：display（strokeData[3]）或 brush（brushData[1][1][3]），再用 --wscale 微调
  const effWidth = (it) => {
    const base = (opts.widthSource === 'brush' && typeof it.brushWidth === 'number') ? it.brushWidth : it.width;
    return base * (opts.wscale ?? 1);
  };

  let nStrokes = 0, nPts = 0, nImages = 0;
  const warnings = [];
  const dev = makeDeviceMap(frame, scale, margin);
  const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'concepts-imgcache');
  const withImages = !has('no-images');

  for (const it of (scene.items ?? scene.strokes)) {
    if (layers && !layers.includes(it.layer)) continue;
    if (it.kind === 'image') {
      if (!withImages) continue;
      const res = scene.resources.get(it.resourceId);
      if (!res) { warnings.push('缂鸿祫婧?' + it.resourceId); continue; }
      try {
        const img = decodeResource(res, cacheDir, opts.python);
        const m = imageMatrix(it, img, dev);
        r.drawImageRGBA(img, m);
        nImages++;
      } catch (e) { warnings.push(it.resourceId + ': ' + e.message); }
      continue;
    }
    if (!it.pts.length) continue;
    const col = [Math.round(it.color.r * 255), Math.round(it.color.g * 255), Math.round(it.color.b * 255)];
    const alpha = (it.alpha ?? 1) * (it.color.a ?? 1);
    if (alpha <= 0.002) continue;                    // 全透明笔画（被擦除的残留）直接跳过
    let pts = it.pts.map((p) => { const [x, y] = applyAffine(transformOf(it), p.x, p.y); return [dev.x(x), dev.y(y)]; });
    if (it.closed && pts.length > 2) pts = [...pts, pts[0]];
    const rad = (effWidth(it) * scale) / (radiusMode === 'full' ? 1 : 2);
    if (smooth > 1) pts = smoothPolyline(pts, smooth);
    r.polyline(pts, Math.max(0.5, rad), col, alpha);
    nStrokes++; nPts += it.pts.length;
  }
  const bytes = r.savePng(opts.out);
  return { w, h, bytes, nStrokes, nPts, nImages, warnings, raster: r };
}

function parseLayers() {
  const v = argOf('layers', null);
  if (!v) return null;
  if (v === 'all') return null;
  return v.split(',').map(Number);
}

function frameFrom(scene, opts, layers) {
  const f = argOf('frame', null);
  if (f) {
    const [x0, y0, x1, y1] = f.split(',').map(Number);
    return { minx: x0, miny: y0, maxx: x1, maxy: y1 };
  }
  const bb = sceneBBox(scene, { layers, includeImages: !has('no-images') });
  return bb;
}

function resolveBg(scene, opts) {
  const b = argOf('bg', 'auto');
  if (b === 'auto') return scene.bg;
  if (b === 'none') return scene.bg;
  const m = /^#?([0-9a-f]{6})$/i.exec(b);
  if (!m) return scene.bg;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function planFit(scene, opts, layers) {
  const frame = frameFrom(scene, opts, layers);
  const margin = Number(argOf('margin', 32));
  const scaleArg = argOf('scale', null);
  const widthArg = argOf('width', null);
  const maxArg = argOf('max', null);
  const paper = argOf('paper', null);
  const fw = frame.maxx - frame.minx, fh = frame.maxy - frame.miny;
  let scale, page = null;
  if (paper && PAPERS[paper.toLowerCase()]) {
    let [pw, ph] = PAPERS[paper.toLowerCase()];
    if (fw > fh) { const t = pw; pw = ph; ph = t; }          // 横向内容 → 横向纸
    page = { w: pw, h: ph };
    scale = Math.min((pw - margin * 2) / fw, (ph - margin * 2) / fh);
  } else if (scaleArg) scale = Number(scaleArg);
  else if (widthArg) scale = (Number(widthArg) - margin * 2) / fw;
  else if (maxArg) scale = (Number(maxArg) - margin * 2) / Math.max(fw, fh);
  else scale = 1;
  return { frame, margin, scale, page };
}

const cmd = process.argv[2];
const file = process.argv[3];

const PAPERS = { a4: [595.28, 841.89], a3: [841.89, 1190.55], letter: [612, 792], a5: [419.53, 595.28] };

function summaryOf(f, base = ROOT) {
  const scene = buildScene(path.resolve(f));
  const bb = sceneBBox(scene, {});
  return {
    file: path.relative(base, path.resolve(f)).replace(/\\/g, '/'),
    bytes: fs.statSync(path.resolve(f)).size,
    version: scene.version,
    meta: scene.meta,
    bg: scene.bg,
    layers: scene.layers.length,
    layerIds: scene.layers.map((l, i) => (Array.isArray(l) && Array.isArray(l[2]) ? l[2].length : null)),
    strokes: scene.strokes.length,
    points: scene.strokes.reduce((a, s) => a + s.pts.length, 0),
    images: scene.images.map((i) => ({ layer: i.layer, resourceId: i.resourceId, size: i.size, hasFile: scene.resources.has(i.resourceId) })),
    bbox: bb,
    widths: [...new Set(scene.strokes.map((s) => s.width))].sort((a, b) => a - b).slice(0, 12),
    colors: [...new Set(scene.strokes.map((s) => `${s.color.r.toFixed(2)},${s.color.g.toFixed(2)},${s.color.b.toFixed(2)},${s.alpha}`))].slice(0, 12),
  };
}

if (cmd === 'scene') {
  console.log(JSON.stringify(summaryOf(file), null, 2));
} else if (cmd === 'scan') {
  // scan --dir <dir> [--glob 课程] [--md report.md] [--json report.json]
  const dir = path.resolve(argOf('dir', DEFAULT_SCAN_DIR));
  const glob = argOf('glob', null);
  const files = walk(dir).sort().filter((f) => !glob || f.includes(glob));
  const rows = files.map((f) => {
    try { return summaryOf(f, dir); } catch (e) { return { file: path.relative(dir, f).replace(/\\/g, '/'), error: e.message }; }
  });
  const nImg = rows.reduce((a, r) => a + ((r.images && r.images.length) || 0), 0);
  const md = [
    '| 文件 | 体积 | 图层 | 笔画 | 点 | 内嵌图 | 内容包围盒（宽×高） | 笔宽 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      if (r.error) return `| ${r.file} | — | — | — | — | — | **解析失败: ${r.error}** | — |`;
      const w = Math.round(r.bbox.maxx - r.bbox.minx), h = Math.round(r.bbox.maxy - r.bbox.miny);
      return `| ${r.file.replace(/\.concepts$/, '')} | ${(r.bytes / 1024).toFixed(0)} KB | ${r.layers} | ${r.strokes} | ${r.points} | ${r.images.length} | ${w}×${h} | ${r.widths.join(', ')} |`;
    }),
  ].join('\n');
  const json = argOf('json', null);
  if (json) fs.writeFileSync(path.resolve(json), JSON.stringify(rows, null, 2));
  const mdOut = argOf('md', null);
  if (mdOut) fs.writeFileSync(path.resolve(mdOut), md + '\n');
  console.log(md);
  console.log(`\nscan ${rows.length} files (${nImg} embedded images) under ${dir}`);
} else if (cmd === 'png' || cmd === 'pdf') {
  const scene = buildScene(path.resolve(file));
  const layers = parseLayers();
  const opts = {
    margin: Number(argOf('margin', 32)),
    smooth: Number(argOf('smooth', 4)),
    radiusMode: argOf('radius', 'half'),
    widthSource: argOf('width-source', 'brush'),
    wscale: Number(argOf('wscale', 1)),
    python: argOf('python', 'python'),
    layers,
    out: path.resolve(argOf('o', cmd === 'png' ? 'out.png' : 'out.pdf')),
  };
  const fit = planFit(scene, opts, layers);
  opts.scale = fit.scale;
  opts.page = fit.page;
  opts.bg = resolveBg(scene, opts);
  if (cmd === 'png') {
    const res = renderToRaster(scene, fit.frame, opts);
    delete res.raster;
    console.log(JSON.stringify({ out: opts.out, frame: fit.frame, scale: opts.scale, ...res }, null, 2));
  } else {
    const res = writePdf(scene, fit.frame, opts);
    console.log(JSON.stringify({ out: opts.out, frame: fit.frame, ...res }, null, 2));
  }
} else if (cmd === 'tiles') {
  // tiles <file.concepts> --outdir <dir> [--tile 1100x1100] [--overlap 80] [--scale 2]
  //                       [--layers 1,2] [--prefix name] [--margin 8]
  // 把内容包围盒切成带重叠的小块（默认 1100x1100 世界单位 @2x ≈ 一张 A4 的可读片段），
  // 行序从上到下、列序从左到右，同时产出 _tiles.json（每块的 frame/笔画数/点数）供后续判读与排序。
  const scene = buildScene(path.resolve(file));
  const layers = parseLayers();
  const bb = sceneBBox(scene, { layers, includeImages: !has('no-images') });
  const [tw, th] = String(argOf('tile', '1100x1100')).toLowerCase().split('x').map(Number);
  const overlap = Number(argOf('overlap', 80));
  const scale = Number(argOf('scale', 2));
  const margin = Number(argOf('margin', 8));
  const outdir = path.resolve(argOf('outdir', path.join(ROOT, 'tools/concepts/_out/tiles')));
  const prefix = argOf('prefix', path.basename(file).replace(/\.concepts$/i, ''));
  fs.mkdirSync(outdir, { recursive: true });

  // 先把每条笔画/图片的包围盒摊到网格上，空块直接跳过（省渲染 + 省判读）
  const stepX = Math.max(1, tw - overlap), stepY = Math.max(1, th - overlap);
  const cols = Math.max(1, Math.ceil((bb.maxx - bb.minx - overlap) / stepX));
  const rows = Math.max(1, Math.ceil((bb.maxy - bb.miny - overlap) / stepY));
  const frames = [];
  for (let r0 = 0; r0 < rows; r0++) {
    for (let c0 = 0; c0 < cols; c0++) {
      let maxy = bb.maxy - r0 * stepY, miny = maxy - th;
      let minx = bb.minx + c0 * stepX, maxx = minx + tw;
      if (miny < bb.miny) miny = bb.miny;
      if (maxx > bb.maxx) maxx = bb.maxx;
      frames.push({ row: r0 + 1, col: c0 + 1, minx, miny, maxx, maxy, strokes: 0, points: 0, images: 0 });
    }
  }
  const hit = (minx, miny, maxx, maxy, f) => !(maxx < f.minx || minx > f.maxx || maxy < f.miny || miny > f.maxy);
  for (const it of (scene.items ?? scene.strokes)) {
    if (layers && !layers.includes(it.layer)) continue;
    if (it.kind === 'image') {
      // 图片包围盒 = 四个角经 itemTransform → transform（与 imgsrc.imageMatrix 同一套变换）。
      // 早期版本只用了 it.transform 作用于原点，漏掉 itemTransform → 位置算错（2026-09-24 由子代理发现）。
      const sx = it.size ? it.size.x : 0, sy = it.size ? it.size.y : 0;
      let imnx = Infinity, imny = Infinity, imxx = -Infinity, imxy = -Infinity;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const lx = (u - 0.5) * sx, ly = (v - 0.5) * sy;
        const [ax, ay] = applyAffine(it.itemTransform, lx, ly);
        const [wx, wy] = applyAffine(it.transform, ax, ay);
        if (wx < imnx) imnx = wx; if (wx > imxx) imxx = wx;
        if (wy < imny) imny = wy; if (wy > imxy) imxy = wy;
      }
      for (const f of frames) if (hit(imnx, imny, imxx, imxy, f)) f.images++;
      continue;
    }
    if (!it.pts.length) continue;
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    for (const p of it.pts) {
      const [x, y] = applyAffine(transformOf(it), p.x, p.y);
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
    }
    for (const f of frames) if (hit(mnx, mny, mxx, mxy, f)) { f.strokes++; f.points += it.pts.length; }
  }

  const opts = {
    margin, smooth: Number(argOf('smooth', 4)), radiusMode: argOf('radius', 'half'),
    widthSource: argOf('width-source', 'brush'), wscale: Number(argOf('wscale', 1)),
    python: argOf('python', 'python'), layers, scale,
    bg: resolveBg(scene, { }),
    cacheDir: path.join(os.tmpdir(), 'concepts-imgcache'),
  };
  const manifest = [];
  for (const f of frames) {
    if (!f.strokes && !f.images) { manifest.push({ ...f, file: null, skipped: 'empty' }); continue; }
    const name = `${prefix}_r${String(f.row).padStart(2, '0')}c${String(f.col).padStart(2, '0')}.png`;
    opts.out = path.join(outdir, name);
    const r = renderToRaster(scene, { minx: f.minx, miny: f.miny, maxx: f.maxx, maxy: f.maxy }, opts);
    manifest.push({ ...f, file: path.relative(ROOT, opts.out).replace(/\\/g, '/'), w: r.w, h: r.h, kb: Math.round(r.bytes / 1024) });
  }
  fs.writeFileSync(path.join(outdir, '_tiles.json'), JSON.stringify({
    source: path.relative(ROOT, path.resolve(file)).replace(/\\/g, '/'),
    bbox: bb, tile: { w: tw, h: th, overlap, scale, margin }, rows, cols, tiles: manifest,
  }, null, 2));
  const used = manifest.filter((m) => m.file);
  console.log(`tiles: ${used.length} rendered / ${manifest.length} grid (rows=${rows} cols=${cols}) -> ${outdir}`);
  for (const m of used) console.log(`  r${String(m.row).padStart(2, '0')}c${String(m.col).padStart(2, '0')}  ${m.w}x${m.h}  strokes=${m.strokes} pts=${m.points}  ${path.basename(m.file)}`);
} else if (cmd === 'batch') {
  const fmt = file;                                  // png | pdf
  const SCAN_DIR = path.resolve(argOf('dir', DEFAULT_SCAN_DIR));   // --dir overrides
  const outdir = path.resolve(argOf('outdir', path.join(ROOT, 'tools/concepts/_out')));
  const glob = argOf('glob', null);
  fs.mkdirSync(outdir, { recursive: true });
  const files = walk(SCAN_DIR).sort().filter((f) => !glob || f.includes(glob));
  const results = [];
  for (const f of files) {
    const scene = buildScene(f);
    const layers = parseLayers();
    const opts = {
      margin: Number(argOf('margin', 32)),
      smooth: Number(argOf('smooth', 4)),
      radiusMode: argOf('radius', 'half'),
      widthSource: argOf('width-source', 'brush'),
      wscale: Number(argOf('wscale', 1)),
      python: argOf('python', 'python'),
      layers,
    };
    const fit = planFit(scene, opts, layers);
    opts.scale = fit.scale; opts.bg = resolveBg(scene, opts);
    opts.page = fit.page;
    opts.cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'concepts-imgcache');
    const rel = path.relative(SCAN_DIR, f).replace(/\.concepts$/, '').split(path.sep).slice(1).join('__');
    const out = path.join(outdir, rel + (fmt === 'png' ? '.png' : '.pdf'));
    opts.out = out;
    try {
      if (fmt === 'png') {
        const r = renderToRaster(scene, fit.frame, opts);
        results.push({ file: rel, out, w: r.w, h: r.h, kb: Math.round(r.bytes / 1024), strokes: r.nStrokes, points: r.nPts });
      } else {
        const r = writePdf(scene, fit.frame, opts);
        results.push({ file: rel, out, ...r });
      }
      console.log(`鉁?${rel}`);
    } catch (e) {
      console.log(`鉁?${rel} : ${e.message}`);
      results.push({ file: rel, error: e.message });
    }
  }
  fs.writeFileSync(path.join(outdir, '_batch.json'), JSON.stringify(results, null, 2));
  console.log(`\n鍏?${results.length} 涓?鈫?${outdir}`);
} else {
  console.error('鐢ㄦ硶: concepts-render.mjs <scene|png|pdf|batch> <file.concepts> [options]');
  process.exit(2);
}
