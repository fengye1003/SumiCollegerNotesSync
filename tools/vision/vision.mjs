#!/usr/bin/env node
// vision.mjs — 通用识图/读屏工具（Qwen VL，OpenAI 兼容接口）
//
// 背景：当前驱动星澄的模型（deepseek-v4-flash）不支持图像输入（read_image 直接报错），
// 通用识图 CLI（OpenAI 兼容 /chat/completions，零依赖），给支持工具调用的 Agent 做"眼睛"：
//   截图/图片 → 本工具 → 模型返回中文要点描述 → 星澄据此决策。
//
// 用法：
//   node vision.mjs <图片路径|URL>                    # 默认详细描述
//   node vision.mjs <图> --task screen                # 读屏预设（GUI 自动化）
//   node vision.mjs <图> --task ocr                   # 纯文字提取预设
//   node vision.mjs <图> --prompt "你的自定义要求"
//   node vision.mjs <图> --json                       # JSON 输出
//   node vision.mjs <图> --no-cache                   # 跳过本地缓存
//   node vision.mjs --test                            # 连通性自测（不发图）
//   node vision.mjs --creds-info                      # 查看凭据来源（掩码）
//
// 凭据解析优先级（apiKey/baseUrl/model/proxy）：
//   1. 环境变量 QWEN_API_KEY | QWEN_BASE_URL | QWEN_MODEL | QWEN_PROXY（别名 VISION_*）
//   2. 本目录 creds.json（可选覆盖）
//   3. moments 插件运行时 DB（cordis.patch.yml 的 dbFile → configs 表 vision.*）—— 令牌单一真值，不复制
// 默认 baseUrl=https://dashscope.aliyuncs.com/compatible-mode/v1  model=qwen-vl-max
// 默认代理：无（dashscope 国内直连）；设 proxy 走 HTTP CONNECT 隧道
//
// 缓存：本地 cache/<sha256(图)-<sha256(提示词+模型)前16位>.txt，同图同提示不重复调用

import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
// 压掉 node:sqlite 的 ExperimentalWarning 噪音（CLI 工具）
process.removeAllListeners("warning");
const DEFAULT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-vl-max";
const MAX_IMAGE_BYTES = 9 * 1024 * 1024;
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

const TASKS = {
  describe: [
    "请用要点式、简练的中文详细描述这张图片的全部内容和细节，要求：",
    "1. 覆盖：主体、人物/动物/物体、动作、表情、服装、环境/背景、画面中的文字、颜色、光线、视角、构图、情绪氛围；",
    "2. 每条信息一句话或一个短语，信息密度高，避免空话套话、重复和文学化修饰；",
    "3. 顺序：先一句整体概括，再逐项列细节；",
    "4. 全文不超过约 400 字（中文字符），但细节必须完整。",
  ].join("\n"),
  screen: [
    "这是一张屏幕截图。请用要点式中文只描述画面中实际可见的内容，不推测：",
    "1. 这是什么界面（应用/页面类型，能判断就写）；",
    "2. 逐条列出画面上全部可见文字（标题/正文/按钮文字/输入框占位符等），尽量完整不遗漏；",
    "3. 标注主要可交互控件及其大致位置（如\"顶部右侧：设置按钮\"\"底部中间：发送\"）；",
    "4. 列出异常或值得注意的元素（弹窗、红点、加载中、错误提示、开关状态、通知栏内容）；",
    "5. 看不清就写\"看不清\"，绝不编造。",
  ].join("\n"),
  ocr: "请把这张图片里出现的所有文字逐条、按阅读顺序输出（相当于 OCR）：只输出文字本身，每行一条，不要解释、不要总结、不要重复。",
};

// ── tiny utils ───────────────────────────────────────────────────────────
function now() { return Date.now(); }
function maskKey(k) {
  if (!k) return "(空)";
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}****${k.slice(-4)}`;
}
function parseArgs(argv) {
  const a = { positionals: [], prompt: "", task: "describe", json: false, noCache: false, credsInfo: false, test: false, proxy: "", cacheDir: join(TOOL_DIR, "cache") };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--prompt") { a.prompt = argv[++i] ?? ""; }
    else if (t === "--task") { a.task = String(argv[++i] ?? "describe").toLowerCase(); if (!TASKS[a.task]) { console.error(`未知预设 --task ${a.task}（可选: ${Object.keys(TASKS).join("/")}）`); process.exit(2); } }
    else if (t === "--json") a.json = true;
    else if (t === "--no-cache") a.noCache = true;
    else if (t === "--creds-info") a.credsInfo = true;
    else if (t === "--test") a.test = true;
    else if (t === "--proxy") a.proxy = argv[++i] ?? "";
    else if (t === "--cache-dir") a.cacheDir = argv[++i] ?? a.cacheDir;
    else if (t === "-h" || t === "--help") a.help = true;
    else a.positionals.push(t);
  }
  return a;
}

// ── creds ─────────────────────────────────────────────────────────────────
function readJsonFile(f, fallback = null) {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
}
function resolveCreds(cliProxy) {
  const pick = (a, b) => String(a || b || "");
  // 1. 环境变量（推荐）
  const env = {
    apiKey: process.env.QWEN_API_KEY || process.env.VISION_API_KEY || "",
    baseUrl: process.env.QWEN_BASE_URL || process.env.VISION_BASE_URL || "",
    model: process.env.QWEN_MODEL || process.env.VISION_MODEL || "",
    proxy: process.env.QWEN_PROXY || process.env.VISION_PROXY || "",
  };
  if (env.apiKey) return { source: "env", ...env, baseUrl: pick(env.baseUrl, DEFAULT_BASE), model: pick(env.model, DEFAULT_MODEL), enabled: true };
  // 2. 本目录 creds.json（可选；请勿提交到仓库）
  const cf = readJsonFile(join(TOOL_DIR, "creds.json"), {});
  if (cf.apiKey) {
    return { source: "creds.json", apiKey: String(cf.apiKey), baseUrl: pick(cf.baseUrl, DEFAULT_BASE), model: pick(cf.model, DEFAULT_MODEL), proxy: pick(cf.proxy, ""), enabled: cf.enabled !== false };
  }
  return { source: "none", apiKey: "", baseUrl: DEFAULT_BASE, model: DEFAULT_MODEL, proxy: "", enabled: false };
}

// ── http（CONNECT 隧道可选；参考 dsh-moments/dsh-tg-bot 同款零依赖实现）─────
function createProxyTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(proxyUrl); } catch (error) { reject(new Error(`invalid proxy URL: ${error.message}`)); return; }
    const req = httpRequest({
      host: u.hostname, port: u.port ? Number(u.port) : 7897, method: "CONNECT",
      path: `${host}:${port}`, headers: { host: `${host}:${port}` },
      ...(u.username ? { auth: `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` } : {}),
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timeout")));
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`)); return; }
      socket.setTimeout(0);
      resolve(socket);
    });
    req.on("error", reject);
    req.end();
  });
}
function wrapTls(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket, servername: host });
    const timer = setTimeout(() => tlsSocket.destroy(new Error("TLS handshake timeout")), timeoutMs);
    tlsSocket.once("error", (e) => { clearTimeout(timer); reject(e); });
    tlsSocket.once("secureConnect", () => { clearTimeout(timer); resolve(tlsSocket); });
  });
}
function httpsGetJson(urlStr, { headers = {}, body, proxy, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (error) { reject(new Error(`invalid URL: ${error.message}`)); return; }
    const doRequest = (createConnection) => {
      const req = httpsRequest({
        host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body ?? "") },
        ...(createConnection ? { createConnection } : {}),
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-json */ }
          if (res.statusCode >= 400) {
            const msg = json?.error?.message || json?.message || raw.slice(0, 300) || `HTTP ${res.statusCode}`;
            reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
          } else resolve(json);
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    };
    if (proxy) {
      createProxyTunnel(proxy, u.hostname, Number(u.port || 443), timeoutMs)
        .then((s) => wrapTls(s, u.hostname, timeoutMs))
        .then((ts) => doRequest(() => ts))
        .catch(reject);
    } else doRequest(null);
  });
}
function httpsGetBytes(urlStr, { proxy, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (error) { reject(new Error(`invalid URL: ${error.message}`)); return; }
    const doGet = (createConnection) => {
      const req = httpsRequest({
        host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, method: "GET",
        headers: { "user-agent": "Mozilla/5.0" },
        ...(createConnection ? { createConnection } : {}),
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timeout after ${timeoutMs}ms`)));
      req.on("response", (res) => {
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`)); return; }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    };
    if (proxy) {
      createProxyTunnel(proxy, u.hostname, Number(u.port || 443), timeoutMs)
        .then((s) => wrapTls(s, u.hostname, timeoutMs))
        .then((ts) => doGet(() => ts))
        .catch(reject);
    } else doGet(null);
  });
}

// ── image ─────────────────────────────────────────────────────────────────
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
async function loadImage(positional, proxy) {
  let buf;
  let mime = null;
  if (/^https?:\/\//i.test(positional)) {
    buf = await httpsGetBytes(positional, { proxy: proxy || null });
    mime = sniffMime(buf);
    const extMatch = /\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i.exec(positional);
    if (!mime && extMatch) mime = MIME_BY_EXT[extMatch[1].toLowerCase()] || null;
  } else {
    if (!existsSync(positional)) throw new Error(`文件不存在: ${positional}`);
    buf = readFileSync(positional);
    const ext = positional.split(".").pop().toLowerCase();
    mime = MIME_BY_EXT[ext] || sniffMime(buf);
  }
  if (!mime) throw new Error("无法识别图片格式（支持 png/jpg/gif/webp/bmp）");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 9MB 限制`);
  return { buf, mime };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(`vision.mjs — Qwen VL 通用识图/读屏\n\n用法：node vision.mjs <图片|URL> [--task describe|screen|ocr] [--prompt 文本] [--json] [--no-cache] [--proxy URL]\n其他：node vision.mjs --test | --creds-info`); process.exit(0); }

  const creds = resolveCreds(a.proxy);
  if (a.credsInfo) {
    console.log(`凭据来源 : ${creds.source}`);
    console.log(`apiKey    : ${maskKey(creds.apiKey)}`);
    console.log(`baseUrl   : ${creds.baseUrl}`);
    console.log(`model     : ${creds.model}`);
    console.log(`proxy     : ${creds.proxy || "(直连)"}`);
    console.log(`enabled   : ${creds.enabled}${creds.source === "moments db (...)" ? "" : ""}`);
    process.exit(creds.apiKey ? 0 : 1);
  }

  if (!creds.apiKey) {
    console.error("未找到 API Key。设置方式：①环境变量 QWEN_API_KEY ②本目录 creds.json（不要提交）");
    process.exit(1);
  }
  const proxy = a.proxy || creds.proxy || "";

  if (a.test) {
    const t0 = now();
    const out = await httpsGetJson(`${creds.baseUrl}/chat/completions`, {
      headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({ model: creds.model, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
      proxy, timeoutMs: 30000,
    });
    const text = typeof out?.choices?.[0]?.message?.content === "string" ? out.choices[0].message.content : JSON.stringify(out?.choices?.[0]?.message?.content);
    console.log(`✅ 连通正常 model=${creds.model} latencyMs=${now() - t0} sample="${(text || "").slice(0, 80)}"`);
    process.exit(0);
  }

  const positional = a.positionals[0];
  if (!positional) { console.error("需要图片路径或 URL（或使用 --test / --creds-info）"); process.exit(2); }

  const { buf, mime } = await loadImage(positional, proxy);
  const prompt = a.prompt || TASKS[a.task] || TASKS.describe;
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const imgHash = createHash("sha256").update(buf).digest("hex");
  const keyHash = createHash("sha256").update(`${prompt}\x00${creds.model}`).digest("hex").slice(0, 16);
  const cacheFile = join(a.cacheDir, `${imgHash}-${keyHash}.txt`);

  if (!a.noCache && existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, "utf8").trim();
    if (cached) { if (a.json) console.log(JSON.stringify({ ok: true, cached: true, model: creds.model, description: cached }, null, 2)); else console.log(cached); process.exit(0); }
  }

  const payload = {
    model: creds.model,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
    max_tokens: 4096,
    temperature: 0.3,
  };
  const t0 = now();
  const out = await httpsGetJson(`${creds.baseUrl}/chat/completions`, {
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(payload),
    proxy, timeoutMs: 120000,
  });
  let text = out?.choices?.[0]?.message?.content;
  if (Array.isArray(text)) text = text.map((p) => (p && typeof p === "object" ? p.text || "" : String(p))).filter(Boolean).join("\n");
  if (typeof text !== "string" || !text.trim()) throw new Error(`模型未返回描述（${out?.error?.message || "未知响应"}）`);
  const description = text.trim();
  if (!a.noCache) {
    try { mkdirSync(a.cacheDir, { recursive: true }); writeFileSync(cacheFile, description, "utf8"); } catch { /* cache write 失败不影响结果 */ }
  }
  if (a.json) {
    console.log(JSON.stringify({ ok: true, cached: false, model: creds.model, source: creds.source, ms: now() - t0, description }, null, 2));
  } else {
    console.log(`[vision] model=${creds.model} source=${creds.source} ms=${now() - t0} cached=false\n`);
    console.log(description);
  }
}

main().catch((e) => { console.error(`[vision] 失败: ${e.message}`); process.exit(1); });
