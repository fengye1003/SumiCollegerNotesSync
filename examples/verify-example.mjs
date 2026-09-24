#!/usr/bin/env node
// verify-example.mjs —— 「先验证，再订正」的模板
// 场景：你从手写笔记里读出一个结论，想写进复习资料。不许凭"看起来对"，先跑这个模板。
//
// 三种手段（按需取用）：
//   A. 枚举验证    —— 逻辑/离散：把所有取值组合跑一遍
//   B. 双路数值    —— 代数/线代：两种独立算法互核 + 随机数代入
//   C. 穷举计数    —— 组合/数据结构：小规模全枚举，和闭式/结论对齐
//
// 用法: node examples/verify-example.mjs
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ❌ ' + msg); } };

// ── A. 枚举验证：真值表 ────────────────────────────────────────────────────
// 待验证结论（示例）：德摩根律 ¬(p∧q) ≡ ¬p∨¬q，以及 (p→q) ≡ (¬p∨q)
console.log('A. 真值表枚举');
{
  const vals = [false, true];
  let sameDeMorgan = true, sameImpl = true;
  for (const p of vals) for (const q of vals) {
    if (!( (!(p && q)) === ((!p) || (!q)) )) sameDeMorgan = false;
    if (!( ((!p) || q) === (!p || q) )) sameImpl = false;      // 改写形式，仍应恒等
  }
  ok(sameDeMorgan, '德摩根律在全部 4 种赋值下成立');
  ok(sameImpl, '蕴含等值式在全部 4 种赋值下成立');

  // 反例演练：如果你读错了一个符号（把 ¬ 读成 →），断言会立刻炸
  let wrong = true;
  for (const p of vals) for (const q of vals) if (((!p) || q) !== (p || q)) wrong = false;
  ok(!wrong, '故意写错的版本应当被断言拒绝（说明断言真的在起作用）');
}

// ── B. 双路数值验证：行列式 ───────────────────────────────────────────────
console.log('B. 行列式双路数值核验');
{
  const detExpand = (m) => {                                  // 路径 1：按定义递归展开
    const n = m.length;
    if (n === 1) return m[0][0];
    let s = 0;
    for (let j = 0; j < n; j++) {
      const sub = m.slice(1).map((row) => row.filter((_, k) => k !== j));
      s += (j % 2 ? -1 : 1) * m[0][j] * detExpand(sub);
    }
    return s;
  };
  const detLU = (m0) => {                                     // 路径 2：高斯消元（列主元）
    const m = m0.map((r) => [...r]); const n = m.length; let det = 1;
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
      if (Math.abs(m[piv][i]) < 1e-12) return 0;
      if (piv !== i) { [m[i], m[piv]] = [m[piv], m[i]]; det = -det; }
      det *= m[i][i];
      for (let r = i + 1; r < n; r++) {
        const f = m[r][i] / m[i][i];
        for (let c = i; c < n; c++) m[r][c] -= f * m[i][c];
      }
    }
    return det;
  };
  const rnd = () => Math.round((Math.random() * 20 - 10));
  let agree = true, checked = 0;
  for (let t = 0; t < 200; t++) {
    const n = 2 + (t % 3);                                    // 2×2 ~ 4×4
    const m = Array.from({ length: n }, () => Array.from({ length: n }, rnd));
    if (Math.abs(detExpand(m) - detLU(m)) > 1e-6) { agree = false; break; }
    checked++;
  }
  ok(agree, `两种独立算法在 ${checked} 组随机矩阵上一致`);

  // 用双路核验去判一条"读到的结论"（示例：这个 3×3 行列式 = -2(x³+y³)）
  const symbolic = (x, y) => [[x, y, x + y], [y, x + y, x], [x + y, x, y]];
  let hit = true;
  for (const [x, y] of [[1, 2], [3, -1], [0.5, 2.5], [-2, 4]]) {
    const got = detExpand(symbolic(x, y));
    const want = -2 * (x ** 3 + y ** 3);
    if (Math.abs(got - want) > 1e-9) hit = false;
  }
  ok(hit, '结论 -2(x³+y³) 在 4 组数值上成立（→ 可以写进正文）');
}

// ── C. 穷举计数：出栈序列数 = 卡特兰数 ────────────────────────────────────
console.log('C. 穷举计数');
{
  const seqs = (n) => {
    const out = [];
    const go = (inp, st, res) => {
      if (res.length === n) { out.push(res.join(',')); return; }
      if (inp.length) go(inp.slice(1), [...st, inp[0]], res);           // 入栈
      if (st.length) go(inp, st.slice(0, -1), [...res, st[st.length - 1]]); // 出栈
    };
    go([...Array(n)].map((_, i) => i + 1), [], []);
    return out;
  };
  const catalan = (n) => { let c = 1; for (let i = 0; i < n; i++) c = c * 2 * (2 * i + 1) / (i + 2); return Math.round(c); };
  let allMatch = true;
  for (const n of [1, 2, 3, 4, 5]) if (seqs(n).length !== catalan(n)) allMatch = false;
  ok(allMatch, 'n=1..5 的出栈序列数分别等于卡特兰数（1,2,5,14,42）');
  ok(seqs(3).length === 5, 'n=3 恰好 5 种（可用于核对笔记里的列举是否漏项）');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 断言 ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
