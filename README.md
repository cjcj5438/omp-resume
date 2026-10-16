# omp-resume

macOS 原生桌面应用（Tauri 2 + React + TypeScript + Rust），用于管理
`omp`（oh-my-pi）的编码会话与本地环境：按项目浏览会话历史、只读回顾对话
与会话树、一键在 iTerm 中继续、永久删除、从任意树节点分叉继续、新开会话、
用量统计、清理与会话备注，以及 omp 版本、模型与 Agent、插件、技能与 MCP 配置。

**为什么做它**：omp 的会话是一棵 append-only 的 JSONL 树。现有开源工具要么在
浏览器/Electron 里重做一遍聊天界面（omp-web、ompweb、oh-my-pi-gui），要么是
pi 专用的 TUI 扩展（pi-session-manager）；没有一个能把会话交还给真正的
`omp --resume` CLI，在 iTerm 新标签页里继续。
UI 文案为中文。

> 会话格式、占用租约、删除与分叉语义针对 omp **v18.10.3** 验证；模型/Agent 配置、用量、history.db 等新功能针对 **v18.11.1** 验证。

## 功能

- **会话列表**：按项目（cwd）分组，组内按修改时间倒序；文本过滤；
  徽章标注占用中（含归属应用，如 `占用中 · VS Code`）/ cwd 已删除 / fork 血缘 / 分支数 / 非 v3 格式。
- **只读对话预览**：user / assistant（thinking、text、工具调用）/
  toolResult / bashExecution / 压缩摘要等逐条渲染，大输出自动截断。不回写。
- **树视图**：omp 会话树的完整呈现——线性链折叠显示、当前位置（leaf）标记、
  label 标签、压缩（compaction）与分支摘要节点，方向键浏览。
- **在 iTerm 继续**：在 iTerm 当前窗口开新标签页执行
  `cd '<cwd>' && omp --resume '<会话文件>'`（无窗口开新窗口，未运行先启动 iTerm）。
- **批量永久删除**：多选后一次性删除，逐条独立失败。
- **命令速查**：侧栏「速查」按钮打开 omp 18.10.3 内置斜杠命令中文速查（85 条，分组 + 过滤，只读）。
- **从此节点继续**：从树上任意节点（而非当前 leaf）继续对话，见下方安全规则。
- **置顶**：项目（按 cwd）与会话两级置顶，置顶项排在各自列表最前；仅存于本机界面偏好，不修改会话文件。
- **omp 版本与更新**：侧栏底部显示本机 omp 版本，可手动「检查 omp 更新」并一键更新（仅以版本号变化判定成功；已打开的 omp 会话需重启后生效；包管理器托管的安装会提示去其管理器更新）。
- **复制会话 ID**：点击详情头里的会话 ID 即可复制。
- **管理视图**：侧栏「管理」按钮打开模型与 Agent（默认首页）/ 插件 / Skills / MCP 四个标签页。
  模型与 Agent：每个角色一张卡（主模型 + 同卡内的有序「兜底模型」，读作
  「主模型出错时按顺序改用」），按模型的兜底融进正在用它的角色卡
  （「不管哪个角色在用这个模型，出错时都按顺序改用」），
  没被使用的收在底部折叠区「其他模型的兜底」；未配置的角色折叠成一行
  「未单独设置，实际使用：<回退解析出的模型>」，点「设置」才展开成卡，
  能力类角色（图片生成等）默认收在「更多角色」里；顶部只读一行展示全局兜底状态
  （总开关关闭时有醒目提示）。Agent 每行先看「当前使用」（`@角色` 别名解析成
  该角色当前模型），可改用模型 / 停用 / 顾问三态。
  经 `omp config set` 只写 5 个白名单配置键（另 3 个兜底开关键只读展示），
  不读 models.yml/models.json、不碰凭据；
  模型选择按 provider 分组可搜索（友好名 + 上下文/价格提示），未知值
  （`@smol` 别名、已下线模型）原样保留；
  分区吸底保存条（有未保存修改才出现）并带冲突保护，部分失败会点名已保存的键并重新载入；
  agent 内置默认读取顺序：`~/.omp/agent/agents/<name>.md`
  存在则以它为准，否则取 `omp agents unpack` 的内置定义。
  插件（仅 user scope）：已安装列表的启用 / 禁用 / 升级 / 卸载，
  marketplace 的添加 / 移除 / 刷新 / 浏览安装；Skills：registry 技能列表
  与一键更新（`~/.agents/skills` 下的技能由其他工具管理，不受影响）；
  MCP：用户级 `~/.omp/agent/mcp.json` 与项目级 `<cwd>/.omp/mcp.json` 的
  服务器列表 / 启停 / 新增 / 编辑 / 删除——列表只显示 env/headers 键名
  不显示值，编辑框才取真实值，保存前校验输入并以 revision 做冲突保护，
  原子写入（新文件权限 `0600`）；已运行的 omp 会话需 `/mcp reload` 或重启后生效。
- **用量/花费**：详情页显示 token、消息数、模型与主对话/后台/子代理分项花费；
  侧栏「统计」按项目/模型/按天汇总（近 30 天或全部），沿 fork 链去重不重复计费。
- **新开会话**：侧栏「新会话…」选目录或项目分组头「+」，在 iTerm 新标签页只执行
  `cd '<目录>' && omp`，不带参数、不发送任何内容。
- **会话概要与提示词历史**：详情页显示 omp 生成的最新 recap；侧栏「提示词历史」
  只读检索 `~/.omp/agent/history.db`（复制 / 跳到来源会话 / 在该目录新会话）；
  库缺失或结构不符时静默隐藏。
- **清理**：侧栏「清理」按规则（空会话、cwd 已删除、体积前 N 且 ≥5MB、超过 N 天）
  列出候选与可释放空间（体积含附件目录与 .bak），勾选后走既有永久删除流程。
- **别名/标签/备注**：应用侧存储（`meta.json`，revision 冲突保护 + 原子写入 + 0600），
  不改会话文件；列表显示别名并附原标题小字，标签过滤条，过滤框同时匹配别名/标签/备注。
- **全部更新**：按 marketplace 目录 → 插件 → registry skills → 检查 omp
  的顺序执行，首个失败即停并点名；有新版 omp 时只打开更新对话框，
  不自动执行 `omp update`。
- **主题切换**：侧栏底部「外观」面板，主题模式（跟随系统 / 浅色 / 深色，
  跟随系统实时响应 `prefers-color-scheme` 变化）与 6 种强调色
  （蓝 / 紫 / 绿 / 橙 / 粉 / 灰）即时生效；macOS 原生标题栏跟随应用主题。

## 安全规则（如何保证不弄坏数据）

- **占用检测**：omp 的写进程持有 `~/.omp/run/session-owners/<会话id>.lock`
  上的 OS `flock`。本应用以非阻塞 `flock(LOCK_EX|LOCK_NB)` 探测：被持有 ⇒
  拒绝写操作；探测失败 ⇒ 写操作（删除 / 分支标记）保守拒绝，
  而「在 iTerm 继续」不受影响（只读打开不占租约，见 CONTRACT §4.8）。
  **依赖 omp 内部实现**——锁文件路径与
  命名来自 omp 的 `session-storage`（租约按会话 id 建立），omp 升级可能改变，
  见「已知限制」。
- **永久删除**：完全镜像 omp 自己的 `deleteSessionWithArtifacts`——删除
  `<file>.jsonl`、同名 sibling 附件目录、`<file>.jsonl.*.bak` 残留；
  **不进回收站**（与 omp 一致的永久删除）；删除永远不碰 `~/.omp/agent/history.db`
  （omp 自己删除时也不碰），会话概要与提示词历史以 `SQLITE_OPEN_READ_ONLY` 只读使用它。
  写路径前先 canonicalize 并强制限定在会话根目录内
  `<项目>/<文件>.jsonl` 两段，符号链接逃逸一律拒绝。
- **从此节点继续（分支标记）**：向会话文件末尾**只追加一行**
  `{"type":"custom","customType":"omp-resume-branch",...,"parentId":<节点>,...}`，
  单次 `O_APPEND` 写入。经真实 omp 18.10.3 TUI 实测：`omp --resume` 会把
  leaf 重建为该标记并从 `parentId` 继续；`custom` 条目不进入模型上下文，
  未知 `customType` 被完全容忍。注意 omp **不校验** `parentId`（错误 id 会静默
  给出空分支），所以应用侧先把节点校验为保留节点，再写入。
- **拒绝规则**：占用中（`IN_USE`）、探测失败（`PROBE_FAILED`）、
  节点非法（`INVALID_NODE`）、路径逃出根（`OUTSIDE_ROOT`）、cwd 已删除时
  打开 iTerm（`CWD_MISSING`）、文件末尾不完整（`IO`）——宁可拒绝也不猜。
- **模型配置**：只写 5 个白名单键（`modelRoles`、`task.agentModelOverrides`、
  `task.disabledAgents`、`task.agentAdvisor`、`retry.fallbackChains`），经 `omp config set`
  写入；另有 3 个兜底开关键（`retry.modelFallback`/`retry.fallbackOn`/
  `retry.fallbackRevertPolicy`）只读展示、写入一律拒绝；不读 models.yml/models.json、
  不运行 `omp config list`，不碰凭据。
- **应用侧备注**：别名/标签/备注存于应用自己的 `meta.json`，revision 冲突保护 +
  原子写入；孤儿条目（会话已删）惰性保留不自动修剪，仅本应用删除成功时联动清理。

## 构建与安装

前置：macOS（arm64/x86_64）、Rust（`rustup`，stable）、Node.js 22、
Xcode Command Line Tools。国内网络慢时可配 crates 镜像（如
`~/.cargo/config.toml` 指向 rsproxy/USTC 稀疏索引），构建无需其他依赖。

```sh
npm install
npm run tauri build        # 普通本地构建（ad-hoc 签名，不含更新签名）；产物在
                           # src-tauri/target/release/bundle/macos/omp-resume.app
cp -R src-tauri/target/release/bundle/macos/omp-resume.app /Applications

# 需要 updater 产物（.app.tar.gz + .sig，供 latest.json 使用）时，先提供签名私钥（见「发版流程」）：
# export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/omp-resume.key"
# npm run tauri build
```

首次启动：本地构建未经公证（ad-hoc 签名）。若经 DMG/网络分发后被 Gatekeeper
拦截，在「应用程序」中**右键 → 打开**即可。

首次使用「在 iTerm 继续」时，macOS 会询问是否允许 omp-resume 控制 iTerm
（Apple 事件）：在 **系统设置 → 隐私与安全性 → 自动化** 中勾选
omp-resume → iTerm；拒绝后该功能会报 `ITERM_FAILED`，可随时在设置里补开。

## 发版流程

发版由 GitHub Actions 自动完成：推送 `v*` 形式的 tag 会触发
`.github/workflows/release.yml`，构建 macOS(arm64) 产物并创建 **草稿** Release
（含 updater 的 `latest.json`），人工核对资产后再手动发布。

### 版本号必须三处同步

`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`
（`[package].version`）三处版本号必须完全一致，且与 tag 一致。CI 在 tag 推送时先跑
`node scripts/check-versions.mjs <tag>` 做校验（本地也可手动执行），不一致即失败。

### 步骤

```sh
# 1. 同步三处版本号后提交
node scripts/check-versions.mjs        # 本地先自检
git add -A && git commit -m "chore(release): 0.2.0"
# 2. 推送主分支
git push origin main
# 3. 打 tag 并推送（触发发版）
git tag v0.2.0
git push origin v0.2.0
```

随后在 Actions 里等 `check` 与 `release` 两个 job 变绿；到 Releases 页面核对草稿
里的资产（`omp-resume_<版本>_aarch64.dmg`、`omp-resume_aarch64.app.tar.gz`、
`omp-resume_aarch64.app.tar.gz.sig`、`latest.json`），确认无误后点 **Publish release** 正式发布。
应用内的更新端点指向 `releases/latest/download/latest.json`，只有**正式发布**
（非草稿）后 `/latest` 才会解析到它。

### 签名密钥（CI 已配置）

CI 需要仓库 secret `TAURI_SIGNING_PRIVATE_KEY`（updater 签名私钥，内容或路径）。
本项目密钥无密码，因此**不设置** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。该 secret
已在 `cjcj5438/omp-resume` 上配置好。

### 本地签名构建（生成 updater 产物）

私钥位于 `~/.tauri/omp-resume.key`（仓库外，**绝不能提交**，也不要把内容写进任何文件）：

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/omp-resume.key"
npm run tauri build        # 额外产出 .app.tar.gz + .sig
```

若私钥丢失，用 `npx tauri signer generate -w ~/.tauri/omp-resume.key` 重新生成，
并同步更新 `src-tauri/tauri.conf.json` 里的 `plugins.updater.pubkey`；
**丢失旧私钥后，已安装的旧版本将无法再收到更新**。

### 更新行为

应用启动时静默检查一次**本应用自身**的更新：有新版本则弹窗显示版本号/
发布日期/更新说明，点「下载并安装」后再选「立即重启」或「稍后重启」；
自身更新无手动检查按钮（与侧栏的「检查 omp 更新」无关，那是 omp CLI 的更新），
重启后会再次检查。
开发模式（DEV）跳过网络检查；所有失败均静默处理。

### 架构

仅构建 **arm64**（`macos-latest` 即 Apple Silicon runner），不构建、不发布 x86_64。

## 配置

| 项 | 优先级（高→低） | 默认 |
|---|---|---|
| 会话根 `sessionsDir` | `--sessions-dir <path>` 参数 > `OMP_RESUME_SESSIONS_DIR` | `$HOME/.omp/agent/sessions` |
| 租约目录 `ownersDir` | `OMP_RESUME_OWNERS_DIR` | `$HOME/.omp/run/session-owners` |
| omp 二进制 | `OMP_RESUME_OMP_BIN` > `~/.local/bin/omp` > `/opt/homebrew/bin/omp` > `/usr/local/bin/omp` > `~/.bun/bin/omp` | 逐项检查存在性，不依赖 PATH |
| 提示词库 `history.db` | `OMP_RESUME_HISTORY_DB` | `$HOME/.omp/agent/history.db` |
| 应用数据目录（含 `meta.json`） | `OMP_RESUME_DATA_DIR` | `$HOME/Library/Application Support/omp-resume` |

带参数启动（GUI 的 argv 不易透传，可直接跑二进制）：

```sh
/Applications/omp-resume.app/Contents/MacOS/omp-resume \
  --sessions-dir /path/to/sessions
```

## 开发

仓库布局：

- `src/`：React 前端（`api.ts` 命令封装、`types.ts` 类型镜像、
  `components/` UI（含 `ManageView` / `PluginsPanel` / `SkillsPanel` /
  `McpPanel` / `OmpUpdateDialog`）、`tree/` 链折叠、`pins.ts`（置顶偏好）、
  `clipboard.ts`（复制）、`dev/` 仅开发用 mock）。
- `src-tauri/src/`：`config.rs`（配置 + 路径校验）、`lock.rs`（flock 探测）、
  `occupant.rs`（占用归属识别）、`sessions/`（解析 / 列表 / 对话 / 树）、
  `ops/`（删除 / 标记 / iTerm）、`ops/picker.rs`（目录选择）、`omp_cli.rs`（omp 路径解析 /
  安全 runner / 版本与更新）、`omp_plugins.rs`（用户级插件 / marketplace / registry 技能）、
  `omp_models.rs`（模型与 Agent 白名单配置）、`usage.rs`（用量统计）、`history.rs`
  （recap/提示词历史只读）、`cleanup.rs`（清理候选）、`meta.rs`（别名/标签/备注）、
  `mcp_config.rs`（MCP 原生配置读写）、`model.rs`（前后端共享类型）、
  `lib.rs`（命令注册）。
- `docs/CONTRACT.md`：**权威规格**（数据格式、命令、语义、错误码）。
- `scripts/fixtures/`：合成会话冒烟套件（详见其 README）。

测试与检查：

```sh
cargo test                  # src-tauri 单元 + 集成（fixtures/真实数据用例默认 ignored）
npm run test                # vitest + testing-library + @tauri-apps/api/mocks
npm run typecheck           # tsc --noEmit
cargo clippy --all-targets  # 0 warning
cargo fmt --check
```

合成 fixture 冒烟（不触碰 `~/.omp`）：

```sh
node scripts/fixtures/make-fixtures.mjs /tmp/omp-resume-fixtures
node scripts/fixtures/hold-lock.mjs /tmp/omp-resume-fixtures/owners <会话id> &
cd src-tauri
OMP_RESUME_SESSIONS_DIR=/tmp/omp-resume-fixtures/sessions \
OMP_RESUME_OWNERS_DIR=/tmp/omp-resume-fixtures/owners \
OMP_RESUME_MANIFEST=/tmp/omp-resume-fixtures/manifest.json \
cargo test --test fixtures -- --ignored --nocapture   # 按 manifest 逐项断言
kill %1
```

真实数据只读回归：`cargo test --test backend -- --ignored --nocapture`
（扫描 `$HOME/.omp/agent/sessions`，只读，打印统计与耗时）。

纯前端开发（无 Tauri）：`npm run dev` 后在 URL 加 `?mock=1`（或 `?mock`）
启用开发用 mock 后端（内存态，会话 / omp / 插件 / 技能 / MCP 命令全覆盖；
仅 dev 构建包含）。可用参数：`?omp=new`（模拟有新版 omp）/
`?omp=managed`（模拟包管理器托管）、`?fail=<命令名>`（强制该命令失败）、
`?conflict=<命令名>`（强制该命令报 CONFLICT）、`?pick=cancel`（模拟取消选目录）、
`?fallback=off`（模拟兜底总开关关闭）、`?latency=<毫秒>`（所有命令延迟）。

开发者注意：omp 收到绝对路径形式的 `PI_CONFIG_DIR` 时会把状态写到 `$HOME`
下的重复路径；沙箱测试只用 HOME 隔离，不要用它指向临时目录。

## 已知限制

- 仅支持 **session version 3**：其他版本列表中可见（只读廉价字段），
  不可预览/建树，但「在 iTerm 继续」与删除仍然可用。
- 占用检测依赖 omp 的私有租约路径（`run/session-owners/<id>.lock`），
  omp 改版可能变化；探测失败时一律保守拒绝写操作。
- 占用归属应用（`占用中 · VS Code` 这类后缀与详情页 `PID` 行）是尽力识别的
  展示信息（`lsof` + 进程环境白名单变量），失败时静默无后缀，不影响占用判断；
  iTerm2 / VS Code 已验证，其余应用（tmux、Cursor 等）未验证、无头进程通常无应用名。
- 删除是**永久**的，无回收站（镜像 omp 自身行为）。
- 「在 iTerm 继续」按登录 shell 的 `PATH` 查找 `omp`；若未安装在 PATH 中，
  需先保证 iTerm 的 shell 能找到它。
- macOS 专用；应用未经签名/公证（本地构建即用）。
- 置顶与外观偏好（主题模式/强调色）都存于 WebView 的 localStorage，开发模式（localhost:1420）与打包后的 .app 是不同来源，互不共享；在 dev 里的置顶/主题设置不会出现在 .app 里。
- 版本显示与更新所用的 omp 路径解析顺序：`OMP_RESUME_OMP_BIN` > `~/.local/bin/omp` > Homebrew（`/opt/homebrew/bin/omp`）> `/usr/local/bin/omp` > `~/.bun/bin/omp`，不依赖 PATH。
- 管理功能仅 user scope（插件与技能均为用户级）；MCP 仅默认 profile，
  不读 `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR` 覆盖，不做 endpoint 等价去重，
  也不对 `mcp.enableProjectConfig` 建模。
- npm 插件只读展示，不提供安装与启停。
- `omp plugin upgrade` 没有 dry-run，本应用不猜测可升级项，故没有「可升级」徽章。
- marketplace 列表来自 `omp plugin marketplace list` 纯文本输出的解析，
  omp 升级后若文案变化会退化为空列表（不报错）。
- 并发执行 plugin upgrade / skill 命令的行为未经实测，应用内同一时间
  只允许一个 omp 写操作，多余的报 `BUSY`。
- omp 更新/升级期间若把窗口放到后台或其他桌面空间，WKWebView 可能延迟投递完成事件，对话框要等窗口回到前台才显示完成（后端已完成，最长受 15 分钟超时约束）；请保持窗口在前台。
- 别名只在本应用显示，omp `/resume` 里仍是原标题。
- `meta.json` 损坏/版本不兼容时拒绝读写，需手动修复；孤儿条目不自动清理。
- 统计是逐文件扫描的瞬时快照；fork 归属仅在条目完全一致时认定复制，无法确认则计入自身。
- 提示词历史大小写不敏感仅 ASCII、子串匹配；「跳到来源会话」仅在会话已加载时可用；
  history.db 结构变化时功能静默消失。
- `omp models --json` 约 10 秒，缓存只在进程内；新增角色只能来自常见角色列表；
  一个区块保存串行写多个 key，中途失败**不回滚**（会点名已保存的键并重新载入最新配置）；
  没有同名角色的兜底 key 会原样保留但可能不被 omp 使用（见 CONTRACT §16.8）。
- 目录选择对话框在应用未激活时可能出现在窗口后方。
