#!/usr/bin/env node
// cpack.mjs — .concepts 包读取 + 场景构建（笔画几何 / 图片对象 / 背景）
import fs from 'node:fs';
import zlib from 'node:zlib';
import { decode } from './mp.mjs';

export function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: ' + file);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    entries.push({ name, method, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  for (const e of entries) {
    const nlen = buf.readUInt16LE(e.lho + 26);
    const elen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + elen;
    const raw = buf.subarray(start, start + e.csize);
    e.data = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
  }
  return entries;
}

const MAT4_ID = (b) => {
  const f = [0, 5, 10, 15, 12, 13].map((k) => b.readFloatLE(k * 4));
  return f[0] === 1 && f[1] === 1 && f[2] === 1 && f[3] === 1 && f[4] === 0 && f[5] === 0;
};
// 4x4 列主序 → 2D 仿射 {a,b,c,d,tx,ty}
export function affineFromMat4(b) {
  return {
    a: b.readFloatLE(0), b: b.readFloatLE(4),
    c: b.readFloatLE(16), d: b.readFloatLE(20),
    tx: b.readFloatLE(48), ty: b.readFloatLE(52),
  };
}
export function isIdentity(m) { return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0; }

export function hexToRgb(s) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 从笔画 item 中抽颜色/笔宽/变换
function brushOf(sd) {
  let color = { r: 0, g: 0, b: 0, a: 1 }, alpha = 1, brushWidth = null, transform = null, brushType = null, brushKind = null;
  const bd = sd[1];
  try {
    if (Array.isArray(bd)) {
      const z = bd[1]?.[1]?.[1];           // [brushKind, [0, brushType], colorExt, alpha]
      if (Array.isArray(z)) {
        if (z[1] && Array.isArray(z[1])) brushType = z[1][1];
        const ce = z[2];
        if (ce && ce.__ext !== undefined && ce.bytes === 16) {
          color = { r: ce.data.readFloatLE(0), g: ce.data.readFloatLE(4), b: ce.data.readFloatLE(8), a: ce.data.readFloatLE(12) };
        }
        if (typeof z[3] === 'number') alpha = z[3];
        if (typeof z[0] === 'number') brushKind = z[0];
      }
      if (typeof bd[1]?.[1]?.[3] === 'number') brushWidth = bd[1][1][3];
      const mt = bd[7];
      if (mt && mt.__ext !== undefined && mt.bytes === 64 && !MAT4_ID(mt.data)) transform = affineFromMat4(mt.data);
    }
  } catch { /* 容错 */ }
  return { color, alpha, brushWidth, transform, brushType, brushKind };
}

/**
 * 解析 .concepts → 场景
 * @returns {{meta:object, bg:[r,g,b], layers:Array, strokes:Array, images:Array}}
 */
export function buildScene(file) {
  const entries = readZip(file);
  const get = (n) => entries.find((e) => e.name === n);
  const meta = JSON.parse(get('metadata.json').data.toString('utf8'));
  const root = decode(get('tree.pack').data, 0).v;
  const version = root[0];
  const D = root[1];
  const layerArr = D[4] || [];

  const strokes = [];
  const images = [];
  const layers = [];
  const drawOrder = [];              // 全局绘制顺序（层序 → 条目序）

  layerArr.forEach((layer, li) => {
    const info = layer[1];
    const layerUuid = info?.[1]?.hex ?? null;
    const items = Array.isArray(layer[2]) ? layer[2] : [];
    const rec = { index: li, type: layer[0], uuid: layerUuid, items: items.length, strokes: 0, images: 0, other: 0 };
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      if (!Array.isArray(it)) continue;
      const sd = Array.isArray(it[1]) ? it[1][1] : null;
      if (!Array.isArray(sd)) { rec.other++; continue; }

      if (sd[0] === 6) {                       // ── 笔画
        const bin = sd.find((x) => Buffer.isBuffer(x) && x.length > 8);
        if (!bin) { rec.other++; continue; }
        const n = Math.floor(bin.length / 16);
        const pts = new Array(n);
        for (let k = 0; k < n; k++) {
          pts[k] = {
            x: bin.readFloatLE(k * 16), y: bin.readFloatLE(k * 16 + 4),
            pressure: bin.readUInt16LE(k * 16 + 8) / 65535,
            b: bin.readUInt16LE(k * 16 + 10) / 65535,
            flags: bin.readUInt32LE(k * 16 + 12),
          };
        }
        const br = brushOf(sd);
        const tail = sd.filter((x) => Buffer.isBuffer(x) && x.length <= 8).pop();
        const st = {
          layer: li, index: ii, kind: 'stroke', itemType: it[0],
          pts, width: typeof sd[3] === 'number' ? sd[3] : 1,
          color: br.color, alpha: br.alpha, brushWidth: br.brushWidth,
          transform: br.transform, brushKind: br.brushKind, brushType: br.brushType,
          closed: sd[5] === true, tail: tail ? tail.toString('hex') : null,
        };
        strokes.push(st); drawOrder.push(st);
        rec.strokes++;
      } else if (it[0] === 7) {                // ── 图片对象
        const content = it[1];
        const resId = content[2]?.hex ? content[2].hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : null;
        const size = content[3];
        const mat = content[5];
        const im = {
          layer: li, index: ii, kind: 'image', resourceId: resId,
          size: size && size.bytes === 8 ? { x: size.data.readFloatLE(0), y: size.data.readFloatLE(4) } : null,
          transform: mat && mat.bytes === 64 ? affineFromMat4(mat.data) : null,
          itemTransform: content[1]?.[7] && content[1][7].bytes === 64 ? affineFromMat4(content[1][7].data) : null,
          color: content[4] && content[4].bytes === 16 ? [0, 4, 8, 12].map((o) => content[4].data.readFloatLE(o)) : null,
        };
        images.push(im); drawOrder.push(im);
        rec.images++;
      } else { rec.other++; }
    }
    layers.push(rec);
  });

  const resources = new Map();
  for (const e of entries) {
    if (e.name.startsWith('resources/')) {
      const id = e.name.slice('resources/'.length).replace(/\.[^.]+$/, '');
      resources.set(id, { name: e.name, data: e.data });
    }
  }

  return { file, version, meta, bg: hexToRgb(meta.backgroundSolidColor), layers, strokes, images, items: drawOrder, resources, entries };
}

export function applyAffine(m, x, y) {
  if (!m) return [x, y];
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
}

export function sceneBBox(scene, opts = {}) {
  const { layers = null, includeImages = true } = opts;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const add = (x, y) => { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; };
  for (const s of scene.strokes) {
    if (layers && !layers.includes(s.layer)) continue;
    const r = s.width / 2;
    for (const p of s.pts) { const [x, y] = applyAffine(s.transform, p.x, p.y); add(x - r, y - r); add(x + r, y + r); }
  }
  if (includeImages) {
    for (const im of scene.images) {
      if (layers && !layers.includes(im.layer)) continue;
      const w = im.size?.x ?? 0, h = im.size?.y ?? 0;
      for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) {
        const [ax, ay] = applyAffine(im.itemTransform, cx, cy);
        const [bx, by] = applyAffine(im.transform, ax, ay);
        add(bx, by);
      }
    }
  }
  return { minx, miny, maxx, maxy, w: maxx - minx, h: maxy - miny };
}
