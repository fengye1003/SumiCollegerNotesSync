// raster.mjs — 抗锯齿光栅器（覆盖率法）+ PNG 输出
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export class Raster {
  constructor(w, h, bg = [255, 255, 255]) {
    this.w = w; this.h = h;
    this.buf = Buffer.alloc(w * h * 4);
    this.fill(bg);
    this.cov = null;
  }
  fill([r, g, b], a = 255) {
    for (let i = 0; i < this.w * this.h; i++) { this.buf[i * 4] = r; this.buf[i * 4 + 1] = g; this.buf[i * 4 + 2] = b; this.buf[i * 4 + 3] = a; }
  }
  ensureCov() { if (!this.cov) this.cov = new Float32Array(this.w * this.h); return this.cov; }
  clearCov(x0, y0, x1, y1) {
    const c = this.cov; if (!c) return;
    for (let y = y0; y <= y1; y++) { const o = y * this.w; for (let x = x0; x <= x1; x++) c[o + x] = 0; }
  }

  /**
   * 覆盖率法画折线：先累计 coverage（取 max，避免关节加深），再一次性合成
   * @param pts [[x,y]...] 设备像素坐标（可含小数）
   * @param radii number|number[] 每点半宽（设备像素）
   * @param color [r,g,b]
   * @param alpha 0..1
   */
  polyline(pts, radii, color, alpha = 1) {
    if (!pts.length) return;
    const cov = this.ensureCov();
    const W = this.w, H = this.h;
    const R = (i) => (Array.isArray(radii) ? radii[i] : radii);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;

    const put = (x, y, v) => { const o = y * W + x; if (v > cov[o]) cov[o] = v; };

    if (pts.length === 1) {
      const r = R(0), cx = pts[0][0], cy = pts[0][1];
      for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(H - 1, Math.ceil(cy + r + 1)); y++)
        for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(W - 1, Math.ceil(cx + r + 1)); x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          const v = Math.min(1, Math.max(0, r + 0.5 - d));
          if (v > 0) put(x, y, v);
        }
      bx0 = Math.max(0, Math.floor(cx - r - 1)); bx1 = Math.min(W - 1, Math.ceil(cx + r + 1));
      by0 = Math.max(0, Math.floor(cy - r - 1)); by1 = Math.min(H - 1, Math.ceil(cy + r + 1));
    } else {
      for (let i = 0; i + 1 < pts.length; i++) {
        const x0 = pts[i][0], y0 = pts[i][1], x1 = pts[i + 1][0], y1 = pts[i + 1][1];
        const r0 = R(i), r1 = R(i + 1), rmax = Math.max(r0, r1);
        const dx = x1 - x0, dy = y1 - y0;
        const len2 = dx * dx + dy * dy;
        const lx0 = Math.max(0, Math.floor(Math.min(x0, x1) - rmax - 1));
        const lx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + rmax + 1));
        const ly0 = Math.max(0, Math.floor(Math.min(y0, y1) - rmax - 1));
        const ly1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + rmax + 1));
        if (lx0 > lx1 || ly0 > ly1) continue;
        for (let y = ly0; y <= ly1; y++) {
          const py = y + 0.5 - y0;
          for (let x = lx0; x <= lx1; x++) {
            const px = x + 0.5 - x0;
            let t = len2 > 1e-12 ? (px * dx + py * dy) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const ddx = px - dx * t, ddy = py - dy * t;
            const r = r0 + (r1 - r0) * t;
            const v = r + 0.5 - Math.sqrt(ddx * ddx + ddy * ddy);
            if (v > 0) put(x, y, v > 1 ? 1 : v);
          }
        }
        if (lx0 < bx0) bx0 = lx0; if (ly0 < by0) by0 = ly0;
        if (lx1 > bx1) bx1 = lx1; if (ly1 > by1) by1 = ly1;
      }
    }

    // 合成
    const [cr, cg, cb] = color;
    const A = Math.max(0, Math.min(1, alpha));
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const c = cov[y * W + x];
        if (c <= 0) continue;
        const sa = c * A;
        const i = (y * W + x) * 4;
        const da = this.buf[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) continue;
        this.buf[i] = Math.round((cr * sa + this.buf[i] * da * (1 - sa)) / oa);
        this.buf[i + 1] = Math.round((cg * sa + this.buf[i + 1] * da * (1 - sa)) / oa);
        this.buf[i + 2] = Math.round((cb * sa + this.buf[i + 2] * da * (1 - sa)) / oa);
        this.buf[i + 3] = Math.round(oa * 255);
      }
    }
    this.clearCov(bx0, by0, bx1, by1);
  }

  // 把一张 RGBA 位图按仿射铺进画布（最近邻足够了：通常放大）
  drawImageRGBA(img, m) {
    const { w, h, data } = img;
    // 目标包围盒
    const cs = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty]);
    const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[0]))));
    const x1 = Math.min(this.w - 1, Math.ceil(Math.max(...cs.map((c) => c[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[1]))));
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(...cs.map((c) => c[1]))));
    const det = m.a * m.d - m.b * m.c;
    if (!det) return;
    const ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - m.tx, py = y + 0.5 - m.ty;
        const sx = Math.floor(ia * px + ic * py);
        const sy = Math.floor(ib * px + id * py);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const si = (sy * w + sx) * 4;
        const sa = data[si + 3] / 255;
        if (sa <= 0) continue;
        const i = (y * this.w + x) * 4;
        const da = this.buf[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        this.buf[i] = Math.round((data[si] * sa + this.buf[i] * da * (1 - sa)) / oa);
        this.buf[i + 1] = Math.round((data[si + 1] * sa + this.buf[i + 1] * da * (1 - sa)) / oa);
        this.buf[i + 2] = Math.round((data[si + 2] * sa + this.buf[i + 2] * da * (1 - sa)) / oa);
        this.buf[i + 3] = Math.round(oa * 255);
      }
    }
  }

  // 自身墨迹包围盒（与 ImgProbe 同口径：与背景色的曼哈顿距离 > th）
  inkBBox(th = 60) {
    const { w, h } = this;
    let br = 0, bg2 = 0, bb = 0;
    { const i = 0; br = this.buf[i]; bg2 = this.buf[i + 1]; bb = this.buf[i + 2]; }
    let x0 = w, y0 = h, x1 = -1, y1 = -1, ink = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(this.buf[i] - br) + Math.abs(this.buf[i + 1] - bg2) + Math.abs(this.buf[i + 2] - bb) > th) {
        ink++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? { empty: true, ink: 0 } : { empty: false, ink, x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  savePng(file) {
    const { w, h } = this;
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 4 + 1)] = 0;
      this.buf.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return png.length;
  }
}

// Catmull-Rom 细分（插值型，过所有原点）
export function smoothPolyline(pts, sub = 4) {
  if (sub <= 1 || pts.length < 3) return pts;
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    for (let k = 0; k < sub; k++) {
      const t = k / sub, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
