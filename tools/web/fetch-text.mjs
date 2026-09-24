// fetch-text.mjs — 网页可见文本提取工具（抓页面 → 纯文本，不输出 HTML 源码）
// 用法:
//   node fetch-text.mjs <url>                       # 纯文本
//   node fetch-text.mjs <url> -n 5000               # 最多输出 5000 字符
//   node fetch-text.mjs <url> --links               # 末尾附上文中链接
//   node fetch-text.mjs <url> --json                # JSON {title, text, links}
// 实现：抓 HTML → 去 script/style/nav 等 → 标签转文本 → 实体解码 → 压缩空白
import { fetchText } from './net.mjs';
import { URL } from 'node:url';

function decodeEntities(s) {
  const map = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
    '&nbsp;': ' ', '&apos;': "'", '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
    '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&middot;': '·',
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-zA-Z]+;/g, (m) => map[m] || m);
}

// 平衡标签提取：找到 <tag ...> 后扫描到配对 </tag>
function extractBalanced(html, tag) {
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i');
  const m = openRe.exec(html);
  if (!m) return null;
  let depth = 0, i = m.index;
  const re = new RegExp(`</?${tag}(\\s[^>]*)?>`, 'gi');
  re.lastIndex = m.index;
  let cur;
  while ((cur = re.exec(html)) !== null) {
    const isOpen = !cur[0].startsWith('</');
    if (isOpen) depth++;
    else depth--;
    if (depth === 0) return html.slice(m.index, re.lastIndex);
  }
  return null;
}

function htmlToText(html) {
  // 0. 若存在主内容区（main/article/[role=main]/id*=content），优先只提取它
  const mainMatch = extractBalanced(html, 'main')
    || extractBalanced(html, 'article')
    || html.match(/<div[^>]+role=["']main["'][\s\S]*?<\/div>/i)
    || html.match(/<div[^>]+id=["'][^"']*content[^"']*["'][\s\S]*?<\/div>/i);
  if (mainMatch && mainMatch.length < 300000) html = mainMatch;
  // 1. 去掉完全无用的区域
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // 2. 可见性忽略的块（有的页面用 hidden/aria-hidden）
  s = s
    .replace(/<nav[\s\S]*?<\/nav>/gi, '\n')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '\n')
    .replace(/<header[\s\S]*?<\/header>/gi, '\n');
  // 3. 块级标签 → 换行
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|table|ul|ol|br|hr)>/gi, '\n');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  // 4. 去掉所有剩余标签
  s = s.replace(/<[^>]+>/g, '');
  // 5. 实体解码 + 压缩空白
  s = decodeEntities(s)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/^\s+|\s+$/g, '');
  return s;
}

function extractLinks(html, base) {
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < 100) {
    const href = m[1];
    const text = htmlToText(m[2]).slice(0, 80);
    if (/^(javascript:|#|mailto:)/.test(href)) continue;
    try {
      links.push({ url: new URL(href, base).href, text });
    } catch {}
  }
  return links;
}

// ---- 参数 ----
const args = process.argv.slice(2);
const url = args.find((a) => /^https?:\/\//i.test(a));
let maxLen = 8000, showLinks = false, asJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-n' || args[i] === '--max') maxLen = Number(args[++i]);
  else if (args[i] === '--links') showLinks = true;
  else if (args[i] === '--json') asJson = true;
}
if (!url) {
  console.error('用法: node fetch-text.mjs <url> [-n 字符数] [--links] [--json]');
  process.exit(1);
}

try {
  const { status, headers, body } = await fetchText(url, {
    headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', 'Accept': 'text/html,application/xhtml+xml' },
    retries: 2,
  });
  if (status >= 400) {
    console.error(`HTTP ${status} (${url})`);
    process.exit(1);
  }
  const title = htmlToText((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 120);
  const text = htmlToText(body);
  const links = showLinks || asJson ? extractLinks(body, url) : [];

  if (asJson) {
    console.log(JSON.stringify({ url, status, title, text: text.slice(0, maxLen), links }, null, 2));
  } else {
    if (title) console.log(`# ${title}\n`);
    console.log(text.slice(0, maxLen));
    if (text.length > maxLen) console.log(`\n…[已截断，全文 ${text.length} 字符，用 -n 调大]`);
    if (showLinks && links.length) {
      console.log(`\n--- 文中链接 (${links.length}) ---`);
      links.slice(0, 30).forEach((l, i) => console.log(`${i + 1}. ${l.text || l.url}\n   ${l.url}`));
    }
  }
} catch (e) {
  console.error('抓取失败:', e.message);
  process.exit(1);
}
