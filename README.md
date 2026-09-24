# SumiCollegerNotesSync —— 手写素材 → 知识库 → 画布 的可复制流水线

> 一套**零依赖 Node 工具 + 明文规矩**，把"手写画板 / 截屏 / 散落文件"变成**可检索的知识库**，再变成**可浏览的画布导图**。
> 写给**支持 skills / 工具调用的 Agent**（DSH 或类似的 harness）：照着 `docs/` 翻一遍，就能从**零工具**开始把这条流水线跑起来。
> 配套长文（面向 Agent 的完整讲解）：`blog/concepts-to-knowledge-base.md`

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-fengye1003%2FSumiCollegerNotesSync-blue)](https://github.com/fengye1003/SumiCollegerNotesSync)

---

## 这条流水线解决什么问题

手写笔记应用（Concepts、GoodNotes、Excalidraw…）与知识库（Obsidian 等）之间通常只有"手动导出 + 人工整理"。本项目把它拆成五段可自动化的工序：

```
① 采集      从远程主机 / 挂载点 / 共享目录把原始素材取回本地（带完整性校验）
② 解包      私有画布格式（.concepts = zip + MessagePack+ext）自己解析，不依赖原 App 导出
③ 重渲染    自研光栅器/PDF 写出，把画布渲染成任意分辨率 PNG / 矢量 PDF；切"可读小块"
④ 归档      视觉判读（多读数交叉）→ 忠实转录稿 → 按主题重组的知识库（标签 + 双链 + MOC）
⑤ 导出画布  生成 Obsidian JSON Canvas（思维导图 / 流程图），并做**机械自检**（不重叠、字段合法）
```

配套纪律（比代码更值钱）：**先验证再订正**、**看不清就标存疑**、**原料不进可见区**、**发布前脱敏**。

## 目录

| 路径 | 内容 |
|---|---|
| `docs/01-overview.md` | **全流程总览**：每一段工序的目标、输入输出、验收标准；以及给 Agent 的"上手清单" |
| `docs/02-tools.md` | **工具手册**：每个脚本的作用 / 命令 / 参数 / 输出 / 已知坑 |
| `docs/03-conventions.md` | **规矩与踩坑**：格式规范速查、多读数交叉验证、脱敏、沙箱与云同步文件的坑 |
| `tools/concepts/` | `.concepts` 解析 → 重渲染 → PNG/PDF → 切块体检（Node 零依赖 + 可选 Python） |
| `tools/canvas/` | Obsidian Canvas **读取器** + **生成器**（`mindmap` 大纲→导图、`from-json` 任意图） |
| `tools/vision/` | 通用识图 CLI（OpenAI 兼容 `/chat/completions`）——多读数交叉的"第二读者" |
| `tools/web/` | 网页正文抽取（给"读文档"用，不啃 HTML） |
| `tools/remote/` | 远程执行/取文件封装（PowerShell 5.1 安全姿势 + 双端 sha256 校验脚本） |
| `examples/` | 示例大纲 + 生成的示例画布 + 通用验证脚本 |
| `blog/` | 面向人/Agent 的图文长文（本项目的"故事版"） |

## 快速上手（3 分钟）

```bash
# 0) 前提：Node ≥ 18（仅 `tools/concepts/render` 的图片合成与 PDF 回渲染需要 Python+Pillow/PyMuPDF）
node --version

# 1) 读一块 Obsidian 画布讲了什么
node tools/canvas/canvas.mjs scan                 # 全库概览
node tools/canvas/canvas.mjs dump path/to/board.canvas

# 2) 用 Markdown 大纲生成一张思维导图 canvas
node tools/canvas/canvas-create.mjs mindmap examples/outline.example.md \
     -o out/mindmap.canvas --groups --normalize
#   → 自带自检：字段合法 · id 唯一 · 边引用有效 · 无节点重叠 · 无分组重叠

# 3) 解析 / 重渲染一个 Concepts 画布（把画布放到 canvas-source/ 下，或用 --dir 指定）
node tools/concepts/concepts-render.mjs scan   --dir canvas-source
node tools/concepts/concepts-render.mjs scene  --dir canvas-source canvas-source/demo/1.concepts
node tools/concepts/concepts-render.mjs png canvas-source/demo/1.concepts -o out/1.png --max 2600
node tools/concepts/concepts-render.mjs tiles canvas-source/demo/1.concepts --outdir out/tiles/1

# 4) 识图（第二读者）
export QWEN_API_KEY=...            # 或自建 tools/vision/creds.json（不要提交）
node tools/vision/vision.mjs out/tiles/1/r01c01.png --task ocr
```

## 设计原则（照做能少踩一半坑）

1. **可执行验证 > 看起来对**：订正/补全必须跑脚本（真值表枚举、数值双路核验、量纲检查、穷举计数）。
2. **多读数交叉**：任何"结论级"识图至少两路（自读 + 第二模型），不一致就报存疑、**不替用户挑一个**。
3. **原料不进可见区**：喂工具的原始素材放隐藏工作目录（如 `.agent/`），知识库里只放"给人读的成品"。
4. **机械自检优先**：能断言的事（重叠、字段、引用存在性、哈希一致）就别靠肉眼。
5. **脱敏是发布前置条件**：见 `docs/03-conventions.md` 的红线清单。

## 依赖与边界

- 纯 Node 标准库（`node:fs` `node:zlib` `node:path`…），无 npm 依赖；
- 可选 Python（Pillow 解内嵌照片、PyMuPDF 回渲染校验 PDF）；
- `tools/remote/remote-run.ps1` 面向 Windows PowerShell 5.1（含编码/管道/BOM 的硬坑），其他平台看 `docs/03-conventions.md` 的等价做法。

## 脱敏声明

本仓库是**脱敏后的通用版**：所有主机名 / 用户名 / 端口 / 密钥路径 / 域名 / 私有目录都已替换为占位符（`<LOCAL_PATH>`、`remote-host`、`<PORT>`…），**不含任何真实凭据、个人信息或用户数据**。
示例画布与示例大纲是**虚构内容**。

## 许可

MIT（见 `LICENSE`）。文档与代码由 AI Agent（Hoshino Sumi / 星澄）基于真实实践撰写，并经人工审阅。
"# SumiCollegerNotesSync" 
