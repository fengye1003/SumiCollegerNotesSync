// pdfout.mjs — 零依赖 PDF 写出器（矢量笔画 + 原样嵌入 JPEG / Flate 嵌入 PNG）
// 要点：PDF 坐标 y 向上，与 Concepts 世界坐标一致 → 直接平移即可，天然无损。
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { applyAffine } from './cpack.mjs';
import { decodeResource } from './imgsrc.mjs';

const fmt = (n) => (Math.abs(n) < 1e-6 ? '0' : Number(n.toFixed(4)).toString());

function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 3) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), comps: buf[i + 9], bits: buf[i + 4] };
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * @param scene buildScene 结果
 * @param frame {minx,miny,maxx,maxy} 世界坐标窗口
 * @param opts  {margin, scale(pt/unit), layers, out, smooth, radiusMode, bg, images}
 */
export function writePdf(scene, frame, opts) {
  const margin = opts.margin ?? 24;
  const k = opts.scale ?? 1;                       // 1 world unit → k pt
  const layers = opts.layers ?? null;
  const fw = (frame.maxx - frame.minx) * k;
  const fh = (frame.maxy - frame.miny) * k;
  const W = opts.page ? opts.page.w : fw + 2 * margin;
  const H = opts.page ? opts.page.h : fh + 2 * margin;
  const ox = opts.page ? (W - fw) / 2 : margin;    // 指定纸张时内容居中
  const oy = opts.page ? (H - fh) / 2 : margin;
  const X = (wx) => (wx - frame.minx) * k + ox;
  const Y = (wy) => (wy - frame.miny) * k + oy;
  const smooth = opts.smooth ?? 4;

  const ops = [];
  const bg = opts.bg;
  if (bg) ops.push(`${fmt(bg[0] / 255)} ${fmt(bg[1] / 255)} ${fmt(bg[2] / 255)} rg 0 0 ${fmt(W)} ${fmt(H)} re f`);

  const objects = [];       // 1-based
  const addObj = (s) => { objects.push(s); return objects.length; };

  // ── 图片 XObject ──
  const imageList = [];
  const warnings = [];
  if (opts.images !== false) {
    for (const im of scene.images) {
      if (layers && !layers.includes(im.layer)) continue;
      const res = scene.resources.get(im.resourceId);
      if (!res) { warnings.push(`缺资源 ${im.resourceId}`); continue; }
      const info = jpegInfo(res.data);
      let idx, w, h;
      if (info) {                                   // JPEG → 原样嵌入（DCTDecode，零损失）
        const cs = info.comps === 1 ? '/DeviceGray' : '/DeviceRGB';
        const hdr = `<< /Type /XObject /Subtype /Image /Width ${info.w} /Height ${info.h} /ColorSpace ${cs} /BitsPerComponent ${info.bits} /Filter /DCTDecode /Length ${res.data.length} >>\nstream\n`;
        idx = addObj({ hdr, raw: res.data, tail: '\nendstream' });
        w = info.w; h = info.h;
      } else {                                      // PNG 等 → Pillow 解码后 FlateDecode 嵌入
        try {
          const img = decodeResource(res, opts.cacheDir || os.tmpdir(), opts.python || 'python');
          const rgb = Buffer.alloc(img.w * img.h * 3);
          for (let i = 0, j = 0; i < img.w * img.h; i++, j += 4) {
            rgb[i * 3] = img.data[j]; rgb[i * 3 + 1] = img.data[j + 1]; rgb[i * 3 + 2] = img.data[j + 2];
          }
          const z = zlib.deflateSync(rgb);
          const hdr = `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${z.length} >>\nstream\n`;
          idx = addObj({ hdr, raw: z, tail: '\nendstream' });
          w = img.w; h = img.h;
        } catch (e) { warnings.push(`${res.name}: ${e.message}`); continue; }
      }
      imageList.push({ im, idx, res, w, h });
    }
  }

  // ── 笔画 ──
  let nStrokes = 0, nPts = 0;
  const strokeOps = [];
  for (const s of scene.strokes) {
    if (layers && !layers.includes(s.layer)) continue;
    if (!s.pts.length) continue;
    const col = [s.color.r, s.color.g, s.color.b];
    const drawPts = s.pts.map((p) => { const [x, y] = applyAffine(s.transform, p.x, p.y); return [X(x), Y(y)]; });
    strokeOps.push('q');
    strokeOps.push(`${fmt(col[0])} ${fmt(col[1])} ${fmt(col[2])} RG`);
    if ((s.alpha ?? 1) * s.color.a < 1) strokeOps.push(`/GSa gs`);
    strokeOps.push(`${fmt(Math.max(0.05, s.width * k * (opts.radiusMode === 'full' ? 1 : 1)))} w 1 J 1 j`);
    strokeOps.push(`${fmt(drawPts[0][0])} ${fmt(drawPts[0][1])} m`);
    for (let i = 1; i < drawPts.length; i++) strokeOps.push(`${fmt(drawPts[i][0])} ${fmt(drawPts[i][1])} l`);
    if (s.closed) strokeOps.push('h');
    strokeOps.push('S', 'Q');
    nStrokes++; nPts += s.pts.length;
  }
  ops.push(...strokeOps);

  // ── 图片绘制 ──
  let nImages = 0;
  for (const { im, idx } of imageList) {
    const sx = im.size?.x ?? 0, sy = im.size?.y ?? 0;
    const m1 = im.itemTransform;
    // 图片以自身中心为原点；itemTransform 提供缩放/旋转，placement 提供画布平移
    const M = {
      a: (m1?.a ?? 1), b: (m1?.b ?? 0), c: (m1?.c ?? 0), d: (m1?.d ?? 1),
      tx: m1?.tx ?? 0, ty: m1?.ty ?? 0,
    };
    const P = im.transform;
    // 组合：先按 size 缩放（中心对齐），再 M，再 P
    const comb = (x, y) => {
      const [mx, my] = applyAffine(M, x * sx + (M ? 0 : 0), y * sy);
      const [px, py] = applyAffine(P, mx, my);
      return [X(px), Y(py)];
    };
    const o = comb(-0.5, -0.5), px = comb(0.5, -0.5), q = comb(-0.5, 0.5);
    const ex = [px[0] - o[0], px[1] - o[1]], ey = [q[0] - o[0], q[1] - o[1]];
    ops.push('q', `${fmt(ex[0])} ${fmt(ex[1])} ${fmt(ey[0])} ${fmt(ey[1])} ${fmt(o[0])} ${fmt(o[1])} cm`, `/Im${nImages} Do`, 'Q');
    nImages++;
  }

  const content = ops.join('\n');
  const contentZ = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const contentIdx = addObj({ hdr: `<< /Length ${contentZ.length} /Filter /FlateDecode >>\nstream\n`, raw: contentZ, tail: '\nendstream' });

  // ExtGState（透明）—— 固定一个
  const gsIdx = addObj('<< /Type /ExtGState /ca 1 /CA 1 >>');

  // 图片资源字典
  const xobjEntries = [];
  let n = 0;
  for (const { idx } of imageList) xobjEntries.push(`/Im${n++} ${idx} 0 R`);

  // 对象编号：接下来依次是 page / pages / catalog
  const resDict = `<< /XObject << ${xobjEntries.join(' ')} >> /ExtGState << /GSa ${gsIdx} 0 R >> >>`;
  const pageObjIdx = objects.length + 1;
  const pagesIdx = pageObjIdx + 1;

  addObj(`<< /Type /Page /Parent ${pagesIdx} 0 R /MediaBox [0 0 ${fmt(W)} ${fmt(H)}] /Resources ${resDict} /Contents ${contentIdx} 0 R >>`);
  const pagesObjIdx = addObj(`<< /Type /Pages /Kids [${pageObjIdx} 0 R] /Count 1 >>`);
  const catalogIdx = addObj(`<< /Type /Catalog /Pages ${pagesObjIdx} 0 R >>`);

  // 序列化
  const chunks = [];
  const offsets = [];
  chunks.push(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'));
  let pos = chunks[0].length;
  objects.forEach((o, i) => {
    offsets[i] = pos;
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    let buf;
    if (typeof o === 'string') buf = Buffer.concat([head, Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    else buf = Buffer.concat([head, Buffer.from(o.hdr, 'latin1'), o.raw, Buffer.from(o.tail + '\nendobj\n', 'latin1')]);
    chunks.push(buf); pos += buf.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIdx} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  const pdf = Buffer.concat(chunks);
  fs.writeFileSync(opts.out, pdf);
  return { bytes: pdf.length, page: { w: +W.toFixed(1), h: +H.toFixed(1) }, strokes: nStrokes, points: nPts, images: nImages, warnings };
}
