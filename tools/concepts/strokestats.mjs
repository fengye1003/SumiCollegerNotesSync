#!/usr/bin/env node
// strokestats.mjs -- 量一个 .concepts 里「笔画的包围盒尺寸」分布，用来推算字高/行距，
// 进而自动决定 OCR 分块大小（tile ≈ 24~30 个字高）。
// 用法: node strokestats.mjs <file.concepts> [--json]
import path from 'node:path';
import { buildScene, applyAffine } from './cpack.mjs';

const file = process.argv[2];
const scene = buildScene(path.resolve(file));
const hs = [], ws = [];
for (const it of (scene.items ?? scene.strokes)) {
  if (it.kind === 'image' || !it.pts || it.pts.length < 2) continue;
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
  for (const p of it.pts) {
    const [x, y] = applyAffine(it.transform, p.x, p.y);
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
  }
  const w = mxx - mnx, h = mxy - mny;
  if (h > 0.5) hs.push(h);
  if (w > 0.5) ws.push(w);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 0; };
const bb = scene.strokes.reduce((a, s) => a, null);
const out = {
  file: path.basename(file),
  strokes: hs.length,
  h_p25: +q(hs, 0.25).toFixed(1), h_p50: +q(hs, 0.5).toFixed(1), h_p75: +q(hs, 0.75).toFixed(1), h_p90: +q(hs, 0.9).toFixed(1),
  w_p50: +q(ws, 0.5).toFixed(1), w_p90: +q(ws, 0.9).toFixed(1),
  // 建议：tile = 26 × p75 字高，夹在 700..2200；overlap = 22% tile
  tile_suggest: Math.round(Math.min(2200, Math.max(700, 26 * q(hs, 0.75)))),
};
out.overlap_suggest = Math.round(out.tile_suggest * 0.22);
if (process.argv.includes('--json')) console.log(JSON.stringify(out));
else console.log(`${out.file.padEnd(28)} strokes=${String(out.strokes).padStart(5)}  h(p50/p75/p90)=${out.h_p50}/${out.h_p75}/${out.h_p90}  w(p50/p90)=${out.w_p50}/${out.w_p90}  -> tile=${out.tile_suggest} overlap=${out.overlap_suggest}`);
