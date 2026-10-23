# omp-resume

## 简介

macOS 原生桌面应用（Tauri 2 + React + TypeScript + Rust），用于管理
`omp`（oh-my-pi）的编码会话与本地环境：按项目浏览会话历史、只读回顾对话
与会话树、一键在 iTerm 中继续、永久删除、从任意树节点分叉继续、新开会话、
用量与运行统计、清理与会话备注，以及 omp 版本、模型与 Agent 配置、插件、技能与 MCP 配置。

**为什么做它**：omp 的会话是一棵 append-only 的 JSONL 树。现有开源工具要么在
浏览器/Electron 里重做一遍聊天界面（omp-web、ompweb、oh-my-pi-gui），要么是
pi 专用的 TUI 扩展（pi-session-manager）；没有一个能把会话交还给真正的
`omp --resume` CLI，在 iTerm 新标签页里继续。
UI 文案为中文。

> 会话格式、占用租约、删除与分叉语义针对 omp **v18.10.3** 验证；模型/Agent 配置、用量、history.db 等新功能针对 **v18.11.1** 验证；命令速查数据基于 **v18.12.6**（87 条内置斜杠命令 + 3 条随包扩展命令 + 51 个终端子命令）。

## 安装

前置：macOS（arm64/x86_64）、Rust（`rustup`，stable）、Node.js 22、
Xcode Command Line Tools。国内网络慢时可配 crates 镜像（如
`~/.cargo/config.toml` 指向 rsproxy/USTC 稀疏索引）。

```sh
npm install
npm run tauri build        # 产物在 src-tauri/target/release/bundle/macos/omp-resume.app
cp -R src-tauri/target/release/bundle/macos/omp-resume.app /Applications
```

本地构建未经公证（ad-hoc 签名）。若被 Gatekeeper 拦截，在「应用程序」中
**右键 → 打开**即可。

首次使用「在 iTerm 继续」时，macOS 会询问是否允许 omp-resume 控制 iTerm
（Apple 事件）：在 **系统设置 → 隐私与安全性 → 自动化** 中勾选
omp-resume → iTerm；拒绝后该功能会报 `ITERM_FAILED`，可随时在设置里补开。

## 开发与测试命令

```sh
npm run dev                # 纯前端开发，URL 加 ?mock（或 ?mock=1）启用 mock 后端
npm run tauri dev          # 完整桌面应用开发模式
npm run check              # typecheck + vitest（前端全部检查）
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

mock 后端仅 dev 构建包含：`?fail=<命令>` 强制失败、`?conflict=<命令>` 强制
CONFLICT、`?latency=<毫秒>` 加延迟等（完整参数见 `src/dev/mockBackend.ts`）。

## 发版要点

版本号必须三处同步：`package.json`、`src-tauri/tauri.conf.json`、
`src-tauri/Cargo.toml`（`[package].version`），且与 tag 一致：

```sh
node scripts/check-versions.mjs        # 本地先自检（CI 在 tag 推送时也会跑）
git add -A && git commit -m "chore(release): 0.2.0"
git push origin main
git tag v0.2.0 && git push origin v0.2.0   # 触发发版
```

推送 `v*` tag 会触发 [.github/workflows/release.yml](.github/workflows/release.yml)，
构建 macOS（arm64）产物并创建**草稿** Release；到 Releases 页面核对资产后
点 **Publish release** 正式发布（只有正式发布后 `/latest` 才会解析到它）。

更新签名密钥在 CI secret `TAURI_SIGNING_PRIVATE_KEY` 中已配好；本项目密钥无密码，
不设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。本地签名构建：
`export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/omp-resume.key"` 后再 `npm run tauri build`。
**丢失旧私钥后，已安装的旧版本将无法再收到更新**。

## 文档链接

- [docs/CONTRACT.md](docs/CONTRACT.md)：权威规格（数据格式、命令、语义、错误码）。
- [docs/DECISIONS.md](docs/DECISIONS.md)：实测与决策记录（D1–D9，从 CONTRACT 移出）。

## 已知限制

- 仅支持 session version 3；删除永久、无回收站；占用检测依赖 omp 私有租约路径。
- 完整限制见 CONTRACT 附录 A/B 与各节「未验证」条目（附录 B 原文已移至 DECISIONS D1）。
- 实测数据与决策依据见 [docs/DECISIONS.md](docs/DECISIONS.md)（D1–D9）。
