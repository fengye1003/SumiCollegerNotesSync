// imgsrc.mjs — 把 .concepts 内嵌资源（jpg/png）解成 RGBA 原始位图（缓存到磁盘）
// 说明：Node 自带无图像解码器，这里调用本机 Python(Pillow) 做一次性解码并落盘缓存。
// 注意：本沙箱禁止管道捕获子进程输出 → 用 stdio:'ignore'，结果只通过文件交换。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECODER = path.join(HERE, 'img2raw.py');

export function decodeResource(res, cacheDir, py = 'python') {
  fs.mkdirSync(cacheDir, { recursive: true });
  const base = path.join(cacheDir, res.name.replace(/[\\/]/g, '_'));
  const rawFile = base + '.rgba';
  const metaFile = rawFile + '.json';
  if (fs.existsSync(rawFile) && fs.existsSync(metaFile)) {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return { w: m.w, h: m.h, data: fs.readFileSync(rawFile) };
  }
  const src = base + path.extname(res.name);
  fs.writeFileSync(src, res.data);
  const r = spawnSync(py, [DECODER, src, rawFile], { stdio: 'ignore' });
  if (r.error) throw new Error('无法调用 ' + py + '（图像解码需要 Pillow）: ' + r.error.message);
  if (!fs.existsSync(metaFile)) throw new Error('图像解码失败: ' + res.name);
  const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  return { w: m.w, h: m.h, data: fs.readFileSync(rawFile) };
}

// 世界坐标 → 设备像素的映射函数
export function makeDeviceMap(frame, scale, margin) {
  return {
    x: (wx) => (wx - frame.minx) * scale + margin,
    y: (wy) => (frame.maxy - wy) * scale + margin,
  };
}

/**
 * 计算图片在设备空间的仿射矩阵（把源像素坐标映射到设备像素）
 * 局部坐标 = ((u-0.5)*sx, (v-0.5)*sy)，u,v ∈ [0,1]；再经 itemTransform → placement → 设备
 */
export function imageMatrix(im, img, dev) {
  const sx = im.size?.x ?? img.w, sy = im.size?.y ?? img.h;
  const T = im.itemTransform ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const P = im.transform ?? { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const mapUnit = (u, v) => {
    const lx = (u - 0.5) * sx, ly = (v - 0.5) * sy;
    const tx = T.a * lx + T.c * ly + T.tx, ty = T.b * lx + T.d * ly + T.ty;
    const px = P.a * tx + P.c * ty + P.tx, py = P.b * tx + P.d * ty + P.ty;
    return [dev.x(px), dev.y(py)];
  };
  const p00 = mapUnit(0, 0), p10 = mapUnit(1, 0), p01 = mapUnit(0, 1);
  // 源像素 (px,py) → 设备：a*px + c*py + tx
  return {
    a: (p10[0] - p00[0]) / img.w, c: (p01[0] - p00[0]) / img.h, tx: p00[0],
    b: (p10[1] - p00[1]) / img.w, d: (p01[1] - p00[1]) / img.h, ty: p00[1],
  };
}
