#!/usr/bin/env node
// mp.mjs — 支持 ext 的 MessagePack 解码器 + .concepts *.pack 结构转储
// 用法: node mp.mjs <pack 文件> [--depth N] [--json out.json]
//
// 关键发现：Concepts 的 pack 是 MessagePack，但用了标准扩展类型：
//   0xd4-0xd8 fixext1/2/4/8/16, 0xc7-0xc9 ext8/16/32
// 旧的 probe-pack.mjs 没实现 ext → 直接抛错，故误判为「非 msgpack」。
import fs from 'node:fs';

export function decode(buf, o = 0) {
  const dv = buf;
  const need = (n, at) => { if (at + n > buf.length) throw new Error(`eof @${at} need ${n}`); };
  let i = o;
  const b = dv[i++];
  // positive fixint
  if (b <= 0x7f) return { v: b, n: i - o, t: 'int' };
  // negative fixint
  if (b >= 0xe0) return { v: b - 256, n: i - o, t: 'int' };
  // fixstr
  if (b >= 0xa0 && b <= 0xbf) { const L = b & 0x1f; need(L, i); return { v: dv.subarray(i, i + L).toString('utf8'), n: i - o + L, t: 'str' }; }
  // fixarray
  if (b >= 0x90 && b <= 0x9f) { const L = b & 0x0f; const a = []; for (let k = 0; k < L; k++) { const r = decode(buf, i); a.push(r.v); i += r.n; } return { v: a, n: i - o, t: 'array' }; }
  // fixmap
  if (b >= 0x80 && b <= 0x8f) { const L = b & 0x0f; const m = {}; for (let k = 0; k < L; k++) { const kk = decode(buf, i); i += kk.n; const vv = decode(buf, i); i += vv.n; m[kk.v] = vv.v; } return { v: m, n: i - o, t: 'map' }; }

  const be = (n) => { need(n, i); let x = 0n; for (let k = 0; k < n; k++) x = (x << 8n) | BigInt(dv[i + k]); i += n; return Number(x); };
  const bin = (n) => { need(n, i); const s = dv.subarray(i, i + n); i += n; return s; };
  const ext = (n) => { need(n + 1, i); const ty = dv[i++]; const d = Buffer.from(bin(n)); return { __ext: ty, hex: d.toString('hex'), bytes: n, data: d }; };

  switch (b) {
    case 0xc0: return { v: null, n: i - o, t: 'nil' };
    case 0xc1: throw new Error(`0xc1(reserved) @${i - 1}`);
    case 0xc2: return { v: false, n: i - o, t: 'bool' };
    case 0xc3: return { v: true, n: i - o, t: 'bool' };
    case 0xc4: return { v: bin(be(1)), n: i - o, t: 'bin' };
    case 0xc5: return { v: bin(be(2)), n: i - o, t: 'bin' };
    case 0xc6: return { v: bin(be(4)), n: i - o, t: 'bin' };
    case 0xc7: { const L = be(1); return { v: ext(L), n: i - o, t: 'ext' }; }
    case 0xc8: { const L = be(2); return { v: ext(L), n: i - o, t: 'ext' }; }
    case 0xc9: { const L = be(4); return { v: ext(L), n: i - o, t: 'ext' }; }
    case 0xca: { need(4, i); const v = dv.readFloatBE(i); i += 4; return { v, n: i - o, t: 'f32' }; }
    case 0xcb: { need(8, i); const v = dv.readDoubleBE(i); i += 8; return { v, n: i - o, t: 'f64' }; }
    case 0xcc: return { v: be(1), n: i - o, t: 'int' };
    case 0xcd: return { v: be(2), n: i - o, t: 'int' };
    case 0xce: return { v: be(4), n: i - o, t: 'int' };
    case 0xcf: return { v: be(8), n: i - o, t: 'int' };
    case 0xd0: return { v: (be(1) << 24) >> 24, n: i - o, t: 'int' };
    case 0xd1: return { v: (be(2) << 16) >> 16, n: i - o, t: 'int' };
    case 0xd2: return { v: be(4) | 0, n: i - o, t: 'int' };
    case 0xd3: return { v: Number(BigInt.asIntN(64, BigInt('0x' + bin(8).toString('hex') || '0'))), n: i - o, t: 'int' };
    case 0xd4: return { v: ext(1), n: i - o, t: 'ext' };
    case 0xd5: return { v: ext(2), n: i - o, t: 'ext' };
    case 0xd6: return { v: ext(4), n: i - o, t: 'ext' };
    case 0xd7: return { v: ext(8), n: i - o, t: 'ext' };
    case 0xd8: return { v: ext(16), n: i - o, t: 'ext' };
    case 0xd9: { const L = be(1); need(L, i); const v = dv.subarray(i, i + L).toString('utf8'); i += L; return { v, n: i - o, t: 'str' }; }
    case 0xda: { const L = be(2); need(L, i); const v = dv.subarray(i, i + L).toString('utf8'); i += L; return { v, n: i - o, t: 'str' }; }
    case 0xdb: { const L = be(4); need(L, i); const v = dv.subarray(i, i + L).toString('utf8'); i += L; return { v, n: i - o, t: 'str' }; }
    case 0xdc: { const L = be(2); const a = []; for (let k = 0; k < L; k++) { const r = decode(buf, i); a.push(r.v); i += r.n; } return { v: a, n: i - o, t: 'array' }; }
    case 0xdd: { const L = be(4); const a = []; for (let k = 0; k < L; k++) { const r = decode(buf, i); a.push(r.v); i += r.n; } return { v: a, n: i - o, t: 'array' }; }
    case 0xde: { const L = be(2); const m = {}; for (let k = 0; k < L; k++) { const kk = decode(buf, i); i += kk.n; const vv = decode(buf, i); i += vv.n; m[kk.v] = vv.v; } return { v: m, n: i - o, t: 'map' }; }
    case 0xdf: { const L = be(4); const m = {}; for (let k = 0; k < L; k++) { const kk = decode(buf, i); i += kk.n; const vv = decode(buf, i); i += vv.n; m[kk.v] = vv.v; } return { v: m, n: i - o, t: 'map' }; }
    default: throw new Error(`unknown byte 0x${b.toString(16)} @${i - 1}`);
  }
}

export function decodeAll(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) { const r = decode(buf, i); out.push(r.v); i += r.n; }
  return out;
}

function summarize(v, depth, maxDepth) {
  if (v === null || typeof v !== 'object') return v;
  if (Buffer.isBuffer(v)) return `<bin ${v.length}B${v.length <= 32 ? ' ' + v.toString('hex') : ''}>`;
  if (v.__ext !== undefined) {
    if (v.bytes === 16 && v.__ext === 5) return `<ext5 uuid ${v.hex.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}>`;
    if (v.bytes === 64) {
      const f = []; for (let k = 0; k < 16; k++) f.push(v.data.readFloatLE(k * 4).toFixed(3));
      return `<ext${v.__ext} mat4 [${f.join(',')}]>`;
    }
    if (v.bytes === 16) {
      const f4 = []; for (let k = 0; k < 4; k++) f4.push(v.data.readFloatLE(k * 4).toFixed(4));
      return `<ext${v.__ext} 4f [${f4.join(',')}]>`;
    }
    if (v.bytes === 8) {
      const f2 = []; for (let k = 0; k < 2; k++) f2.push(v.data.readFloatLE(k * 4).toFixed(3));
      return `<ext${v.__ext} 2f [${f2.join(',')}] hex=${v.hex}>`;
    }
    if (v.bytes === 4) {
      return `<ext${v.__ext} f=${v.data.readFloatLE(0).toFixed(4)} i=${v.data.readInt32LE(0)}>`;
    }
    return `<ext${v.__ext} ${v.bytes}B ${v.hex.slice(0, 48)}${v.hex.length > 48 ? '…' : ''}>`;
  }
  if (Array.isArray(v)) {
    if (depth >= maxDepth) return `<array ${v.length}>`;
    return v.map((x) => summarize(x, depth + 1, maxDepth));
  }
  const o = {};
  for (const k of Object.keys(v)) o[k] = summarize(v[k], depth + 1, maxDepth);
  return o;
}

const isMain = !!process.argv[1] && (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('mp.mjs'));
if (isMain) {
  const file = process.argv[2];
  const di = process.argv.indexOf('--depth');
  const maxDepth = di > 0 ? Number(process.argv[di + 1]) : 6;
  const buf = fs.readFileSync(file);
  const r = decode(buf, 0);
  console.log(`size=${buf.length} consumed=${r.n} ${r.n === buf.length ? 'FULL ✓' : 'TRAILING ' + (buf.length - r.n)}`);
  console.log(JSON.stringify(summarize(r.v, 0, maxDepth), null, 2));
  // 统计各级 ext/bin
  const stats = { ext: {}, bin: {} };
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return;
    if (Buffer.isBuffer(v)) { const k = 'len' + (v.length <= 64 ? v.length : '>64'); stats.bin[k] = (stats.bin[k] || 0) + 1; return; }
    if (v.__ext !== undefined) { const k = 'ext' + v.__ext + '_' + v.bytes + 'B'; stats.ext[k] = (stats.ext[k] || 0) + 1; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(r.v);
  console.log('\n== stats ==');
  console.log(JSON.stringify(stats, null, 2));
}
