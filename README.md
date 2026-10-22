# omp-resume

macOS 原生桌面应用（Tauri 2 + React + TypeScript + Rust），用于管理
`omp`（oh-my-pi）的编码会话与本地环境：按项目浏览会话历史、只读回顾对话
与会话树、一键在 iTerm 中继续、永久删除、从任意树节点分叉继续、新开会话、
用量与运行统计、清理与会话备注，以及 omp 版本、模型与 Agent 配置、插件、技能与 MCP 配置。

**为什么做它**：omp 的会话是一棵 append-only 的 JSONL 树。现有开源工具要么在
浏览器/Electron 里重做一遍聊天界面（omp-web、ompweb、oh-my-pi-gui），要么是
pi 专用的 TUI 扩展（pi-session-manager）；没有一个能把会话交还给真正的
`omp --resume` CLI，在 iTerm 新标签页里继续。
UI 文案为中文。

> 会话格式、占用租约、删除与分叉语义针对 omp **v18.10.3** 验证；模型/Agent 配置、用量、history.db 等新功能针对 **v18.11.1** 验证；命令速查数据基于 **v18.12.3**（87 条内置命令）。

## 功能

- **会话列表**：按项目（cwd）分组，组内按修改时间倒序；文本过滤；
  徽章标注占用中（含归属应用，如 `占用中 · VS Code`）/ cwd 已删除 / fork 血缘 / 分支数 / 非 v3 格式。
- **只读对话预览**：user / assistant（thinking、text、工具调用）/
  toolResult / bashExecution / 压缩摘要等逐条渲染，大输出自动截断。不回写。
- **树视图**：omp 会话树的完整呈现——线性链折叠显示、当前位置（leaf）标记、
  label 标签、压缩（compaction）与分支摘要节点，方向键浏览。
- **在 iTerm 继续**：在 iTerm 当前窗口开新标签页执行
  `cd '<cwd>' && omp --resume '<会话文件>'`（无窗口开新窗口，未运行先启动 iTerm）。
- **批量永久删除**：多选后一次性删除，逐条独立失败；搜索行右侧的「多选」开关是批量入口——打开后全部勾选框常显、选择条常驻（即使 0 选中也可一键「全选当前列表」），关闭时清空选择；项目组头与置顶区头的三态复选框可批量勾选（含已折叠行）。行内勾选框平时隐藏，悬停行、键盘聚焦或已有选中项时显示，不打断列表扫读。
- **命令速查**：侧栏「速查」按钮打开 omp 内置斜杠命令中文速查，基准 18.12.3、共 87 条
  （较 18.12.2 新增 `/forget-approvals`）；两个视图——「全部命令」（分组 + 过滤，行内一键复制
  `/name`，带参数命令另有「参数」按钮复制模板；空查询时顶部有「常用」分组，过滤支持
  参数提示与意图关键词）与「组合用法」（12 个场景的命令序列，
  每步可复制、也可复制全部）；安装版本与基准不一致时提示可能有差异。
- **从此节点继续**：从树上任意节点（而非当前 leaf）继续对话，见下方安全规则。
- **置顶**：项目（按 cwd）与会话两级置顶；项目置顶在所属项目组内上浮，会话置顶跨项目聚合为列表顶部「置顶」区（可折叠、按修改时间倒序、行内标注所属项目，原项目组内不再重复出现），过滤（文本 + 标签）时置顶区只显示匹配项、无匹配则整区隐藏；组内会话全被置顶时保留组头并显示「该项目的会话均已置顶」。仅存于本机界面偏好，不修改会话文件。
- **omp 版本与更新**：侧栏底部显示本机 omp 版本，可手动「检查 omp 更新」并一键更新（仅以版本号变化判定成功；已打开的 omp 会话需重启后生效；包管理器托管的安装会提示去其管理器更新）；版本行与更新对话框内的「更新日志」链接在浏览器打开 omp 官方 CHANGELOG。
- **复制会话 ID**：点击详情头里的会话 ID 即可复制。
- **管理视图**：侧栏「管理」按钮打开模型（默认首页）/ Agent / 插件 / Skills / MCP / 记忆库六个标签页。
  模型：自上而下是模型库 → 测试 → 角色分配，一页闭环。模型库是全部可用模型的只读一览表
  （搜索，规格列上下文/最大输出/目录价/思考/用途，名下 muted selector 次行、紧凑数字列
  （`1M` / `393,216` / `$0.3 / $1.2`）、思考档位以 `·` 连接，「加入测试」/「测试 ▶」/「规格」入口）；
  测试是内嵌的 bench 测试器（见下）；角色分配即「主要模型」（角色卡）+「其他模型的兜底」。
  每个角色一张卡（主模型 + 同卡内的有序「兜底模型」，读作「主模型出错时按顺序改用」），
  按模型的兜底融进正在用它的角色卡（「不管哪个角色在用这个模型，出错时都按顺序改用」），
  没被使用的收在底部折叠区「其他模型的兜底」；未配置的角色折叠成一行
  「未单独设置，实际使用：<回退解析出的模型>」，点「设置」才展开成卡，
  能力类角色（图片生成等）默认收在「更多角色」里；顶部只读一行展示全局兜底状态
  （总开关关闭时有醒目提示）。Agent：顶部是状态 chips（编排器 / 子代理数 / 停用 / 顾问 /
  Vibe 两档）与「主对话模型在『模型』页修改」的提示，其下是一张可交互的编排流程图：
  主代理（编排器，显示 default 角色当前模型）按需把子任务派给下面的 agent，
  每个节点是中文职责 + 「当前使用」的模型/档位 + 状态（已停用/顾问/自定义），
  底部虚线「结果回传」；点节点滚动到对应的 Agent 配置行并短暂高亮。
  其下是「Vibe 工作会话」卡：omp 的 `/vibe` 模式中 fast 档用内置 agent sonic、good 档用 task，
  两行各自可改模型与思考强度（写入的仍是既有 `task.agentModelOverrides.sonic` / `.task`，
  不新增配置键；`@角色` 别名按解析结果展示、保存时不被展开），并只读显示指挥者
  （主对话角色）模型与三行各自的兜底（只读：指挥者与强力档是角色链 + 吸附到生效模型的链，
  快速档只显示吸附链）；这两档与普通子代理（机械处理 / 通用执行）共用模型，修改会同时影响它们。
  再往下是 Agent 行：每行先看「当前使用」（`@角色` 别名解析成该角色当前模型），
  可改用模型 / 停用 / 顾问三态。「当前使用」与指挥者/兜底展示都按未保存草稿实时重算，
  picker 一改就更新，不必等保存。经 `omp config set` 只写 5 个白名单配置键
  （另 3 个兜底开关键只读展示），不读 models.yml/models.json、不碰凭据；
  模型选择按 provider 分组可搜索（友好名 + 上下文/价格提示），未知值
  （`@smol` 别名、已下线模型）原样保留；分区吸底保存条（有未保存修改才出现）
  并带冲突保护，「还原」只还原本区块（角色分配块含全部兜底草稿），
  部分失败会点名已保存的键并重新载入；
  agent 内置默认读取顺序：`~/.omp/agent/agents/<name>.md`
  存在则以它为准，否则取 `omp agents unpack` 的内置定义。
  插件（仅 user scope）：已安装列表的启用 / 禁用 / 升级 / 卸载，
  marketplace 的添加 / 移除 / 刷新 / 浏览安装；Skills：registry 技能列表
  与一键更新（`~/.agents/skills` 下的技能由其他工具管理，不受影响）；
  MCP：用户级 `~/.omp/agent/mcp.json` 与项目级 `<cwd>/.omp/mcp.json` 的
  服务器列表 / 启停 / 新增 / 编辑 / 删除——列表只显示 env/headers 键名
  不显示值，编辑框才取真实值，保存前校验输入并以 revision 做冲突保护，
  原子写入（新文件权限 `0600`）；已运行的 omp 会话需 `/mcp reload` 或重启后生效。
- **用量/花费**：「统计」视图分两个标签页——「花费」（范围：今天 / 近 24 小时 /
  近 7 天 / 近 30 天 / 全部，默认近 30 天；总额与主对话/后台/子代理分项、花费趋势
  柱状图、按项目/按模型表）与「运行看板」（默认今天；请求数、错误数与错误率、
  兜底切换次数、缓存命中率，请求 / 缓存命中率趋势、错误类型分布、兜底去向、
  最近错误、按模型缓存命中）；详情页仍显示单会话 token、消息数与分项花费，
  统计沿 fork 链去重不重复计费。图表为手写 SVG。
- **新开会话**：侧栏「新会话…」选目录或项目分组头「+」，在 iTerm 新标签页只执行
  `cd '<目录>' && omp`，不带参数、不发送任何内容。
- **会话概要与提示词历史**：详情页显示 omp 生成的最新 recap；侧栏「提示词历史」
  只读检索 `~/.omp/agent/history.db`（复制 / 跳到来源会话 / 在该目录新会话）；
  库缺失或结构不符时静默隐藏。
- **清理**：侧栏「清理」按规则（空会话、cwd 已删除、体积前 N 且 ≥5MB、超过 N 天）
  列出候选与可释放空间（体积含附件目录与 .bak），勾选后走既有永久删除流程。
- **别名/标签/备注**：应用侧存储（`meta.json`，revision 冲突保护 + 原子写入 + 0600），
  不改会话文件；列表显示别名并附原标题小字，标签过滤条，过滤框同时匹配别名/标签/备注。
- **菜单栏**：菜单栏图标 + 紧凑计数（`2·1`，在工作·在等我，疑似卡住加 `!`），
  点图标（左键或右键）展开下拉，列出当前占用中的 omp 会话（状态、标题、归属应用、持续时长、子代理数），
  一行点击即可聚焦到对应 iTerm 标签；状态判定（工作中 / 等待输入 / 空闲 / 疑似卡住）
  基于 flock 占用 + 会话记录尾部 + iTerm 标题状态符；会话进入等待输入或疑似卡住时
  发系统通知（可关）并 Dock 跳一次；关闭窗口后驻留菜单栏（Dock 图标可隐藏，
  点 Dock 图标回到主窗口）；Dock 角标 = 等待输入 + 疑似卡住数，右键 Dock 图标
  可直接聚焦会话或打开主窗口。
- **全部更新**：按 marketplace 目录 → 插件 → registry skills → 检查 omp
  的顺序执行，首个失败即停并点名；有新版 omp 时只打开更新对话框，
  不自动执行 `omp update`。
- **主题切换**：侧栏底部状态条的「外观」按钮（齿轮图标），主题模式（跟随系统 / 浅色 / 深色，
  跟随系统实时响应 `prefers-color-scheme` 变化）与 6 种强调色
  （蓝 / 紫 / 绿 / 橙 / 粉 / 灰）即时生效；macOS 原生标题栏跟随应用主题。
- **记忆库**：管理视图「记忆库」标签页浏览 omp 长期记忆（Mnemopi 各项目 bank）。
  顶部是健康卡（总数 / 未召回 / 未合并 / 磁盘占用，占比 > 50% 淡琥珀底）；「项目库」是排名条形图：
  每行一个库，条形 = 工作 + 情节（按比例堆叠，非零至少 4px），下方细条为未召回 / 未合并比例，
  无效库带徽章与条纹；点行选中（行内无按钮）后在右侧抽屉里展开该库（窄窗口改为覆盖层，Esc 或「关闭」退出），
  不必滚到长列表底部：抽屉内是选中库操作条（路径 / 规模 / 最近记忆 +「备份与恢复」「移除此库…」）与记忆内容。
  记忆列表支持搜索（LIKE 子串）、过滤、排序、分页与详情，可复制或跳来源会话。
- **记忆关系图**：抽屉内「列表 | 关系图」切换（默认列表），展示情节摘要→原记忆（`summary_of`）与图谱边
  （`graph_edges`）的引用关系；悬停高亮邻域、点击选卡（含相邻跳转）、滚轮缩放、拖拽平移/移点、
  图例过滤边种类；无关联的记忆只计数不渲染（上限 200 节点）；「在列表中打开」可跨分页定位回列表。
- **无效库清理**：`cwdExists=false` / 空库 / 不可读即无效。「只看无效库（N）」过滤，「清理无效库…」
  逐个探测占用（使用中 / 探测失败 / 不可读禁用并写原因），勾选后逐个移除、失败继续，结果逐条列出并 toast 汇总。
- **记忆维护（写）**：删除单条记忆（工作 / 情节记忆，含 facts、embeddings、annotations、gists、
  memoria_*、graph_edges 的级联清理与 episodic summary 引用提示）、整库移除、备份列表 / 恢复 /
  永久删除。每次破坏性操作前自动 `VACUUM INTO` 快照到 `memory-backups/<bank>/<UTC>-<kind>/`
  （目录 0700、文件 0600，每 bank 保留最新 5 份；整库移除的备份永不自动清理），恢复带完整性校验与
  失败回滚。写入前用 `lsof` 检查 bank 的 db / `-wal` / `-shm` 是否被 omp 占用，占用或探测失败一律
  拒绝（`IN_USE` / `PROBE_FAILED`）。
- **记忆多选删除**：列表头「选择」进入多选（行内复选框 + 选择条，一次最多 500 条，只在同库同筛选内
  跨页保持）。「删除所选…」与详情里的「删除这条…」都先弹确认框，用 `memory_delete_preview` 显示将删
  条数、级联清理、摘要引用提示与跳过项，并做占用门禁（使用中 / 探测失败禁用确认、可重试）。
- **模型测试**：管理视图「模型」标签页的「测试」区，用 omp 自带的 `omp bench` 测模型的速度与稳定性。每轮是
  短探针 5 次（100 token）加长探针 3 次（600 token），单请求串行；列表展示成功率、TTFT p50/p95、
  生成速度 tok/s（±波动），以及相对主模型（`modelRoles.default`，置顶为基线）的倍率；
  另有一列「日常实测」，只读取自 omp 的 `model_perf`。模型从 `omp models` 目录添加（思考强度算模型身份的一部分，
  宽对话框带实时规格预览，支持改已加入的条目），当前已分配给角色的模型自动纳入。
  标签就是 omp 角色名（任务 / 审查 / 自定义如 `test`），用来圈定候选池；
  「一键推荐」在每个标签的候选里，挑 24h 成功率 ≥95% 且样本 ≥5 的最高分者，和抽屉里的「设为 <标签>」一样
  回填进下面「角色分配」的草稿（测试区自己没有保存条），在角色分配确认保存后写入 `modelRoles`，新会话生效。
  可开定时监控（30 分 / 1 时 / 6 时，应用开着才跑），按钮上显示预估花费。历史存为应用数据目录下的 `model-bench.jsonl`，保留 30 天。
- **模型规格编辑**：改 `models.yml` 里单个模型的非凭据规格（名称 / 上下文窗口 /
  最大输出 / 推理开关 / 输入类型 / 四项费用）。行级手术替换，其余字节（含凭据、
  注释、锚点）不动；写前用真实 omp 在沙箱目录校验新文件，校验不过拒绝写入；
  每次写前备份原文（同目录保留最新 10 份），revision 冲突保护；omp 缺失时拒绝写入。
  `cost` 含分层价格（如 `longContext`）的模型暂不支持编辑（抽屉显示「分层价格，暂不支持编辑」并禁用保存）。

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
  不运行 `omp config list`，不碰凭据（唯一例外：模型规格编辑刻意读写 models.yml
  的非凭据规格字段，行级手术、不整体重排，凭据永不经 IPC/日志/错误文本）。
- **模型规格编辑**：只改单个模型的非凭据规格字段；写前沙箱校验（真实 omp
  `models --json`，校验不过/无 omp 可校验一律拒绝写入）；写前备份（0600，
  保留最新 10 份），原子替换（0600），revision 冲突保护；rename 前任何失败原文不动。
- **模型测速**：唯一会调用 LLM 的路径是 `omp bench`（selector 校验后作为单个 argv，不经 shell）；
  `agent.db` 含凭据表，本应用只以 `SQLITE_OPEN_READ_ONLY` 执行一条写死的 `SELECT … FROM model_perf`。
- **菜单栏只读检测，聚焦仅 activate + select**：菜单栏功能只读 flock 锁、
  会话 jsonl 尾部与 iTerm 标题；唯一的控制动作「聚焦」也只做 iTerm 的
  `activate` + 按 tty `select`，**不发送任何按键 / 任何信号 / 不 kill 进程**，
  不写会话文件，不安装 omp hooks。查询 iTerm 前必先确认其进程在跑
  （轮询绝不把没在运行的 iTerm 拉起来）。
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
| 记忆库 bank 根 `memoryDir` | `OMP_RESUME_MEMORY_DIR` | `$HOME/.omp/agent/memories/mnemopi/banks` |
| omp 运行库 `agent.db`（只读 `model_perf`） | `OMP_RESUME_AGENT_DB` | `$HOME/.omp/agent/agent.db` |
| 模型规格 `models.yml`（规格编辑） | `OMP_RESUME_MODELS_YML` > `$PI_CODING_AGENT_DIR/models.yml` | `$HOME/.omp/agent/models.yml` |
| 应用数据目录（含 `meta.json` / `settings.json`） | `OMP_RESUME_DATA_DIR` | `$HOME/Library/Application Support/omp-resume` |

带参数启动（GUI 的 argv 不易透传，可直接跑二进制）：

```sh
/Applications/omp-resume.app/Contents/MacOS/omp-resume \
  --sessions-dir /path/to/sessions
```

## 开发

仓库布局：

- `src/`：React 前端（`api.ts` 命令封装、`types.ts` 类型镜像、
  `components/` UI（含 `ManageView` / `PluginsPanel` / `SkillsPanel` /
  `McpPanel` / `OmpUpdateDialog` / `StatsView` / `HealthBoard` / `UsageCharts` /
  `Sidebar`（`Sidebar.css`）/ `CheatSheetDialog`（`CheatSheet.css`））、
  `usageFormat.ts`（统计格式与错误类型中文名）、`tree/` 链折叠、
  `pins.ts`（置顶偏好）、`ompCommands.ts` / `ompCombos.ts`（命令速查与组合用法数据）、
  `appearance.ts`（主题模式/强调色偏好）、`clipboard.ts`（复制）、
  `dev/` 仅开发用 mock）。
- `src-tauri/src/`：`config.rs`（配置 + 路径校验）、`lock.rs`（flock 探测）、
  `occupant.rs`（占用归属识别）、`sessions/`（解析 / 列表 / 对话 / 树）、
  `ops/`（删除 / 标记 / iTerm）、`ops/picker.rs`（目录选择）、`omp_cli.rs`（omp 路径解析 /
  安全 runner / 版本与更新）、`omp_plugins.rs`（用户级插件 / marketplace / registry 技能）、
  `omp_models.rs`（模型与 Agent 白名单配置）、`usage.rs`（用量与运行看板统计）、`history.rs`
  （recap/提示词历史只读）、`cleanup.rs`（清理候选）、`meta.rs`（别名/标签/备注）、
  `menubar/`（托盘菜单/检测/聚焦/通知/设置）、`mcp_config.rs`（MCP 原生配置读写）、
  `memory/`（记忆库浏览 + 备份/删除/恢复）、`model_bench.rs`（模型测速与历史）、
  `model.rs`（前后端共享类型）、`lib.rs`（命令注册）。
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
`?fallback=off`（模拟兜底总开关关闭）、`?latency=<毫秒>`（所有命令延迟）、`?usage=empty`（模拟空用量）、
`?memory=off`（模拟没有本地记忆库）、`?memoryBackend=<名称>`（改记忆后端名，默认 mnemopi）、
`?memoryInUse=<库名>`（该库报占用中，写操作报 `IN_USE`）、`?memoryProbe=fail`（占用探测失败，写操作报 `PROBE_FAILED`）、
`?memoryBanks=37`（37 个批量库，规模递减，含空库 / 目录已删 / 不可读与一个使用中）。

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
- 置顶与外观偏好（主题模式/强调色，键 `omp-resume:appearance`）都存于 WebView 的 localStorage，开发模式（localhost:1420）与打包后的 .app 是不同来源，互不共享；在 dev 里的置顶/主题设置不会出现在 .app 里。
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
- 统计与运行看板是逐文件扫描的瞬时快照；fork 归属仅在条目完全一致时认定复制，无法确认则计入自身；错误类型分类为启发式，未见过的新报文归入「其他」；缓存命中率在上游不返回缓存 token 时为「—」。
- 提示词历史大小写不敏感仅 ASCII、子串匹配；「跳到来源会话」仅在会话已加载时可用；
  history.db 结构变化时功能静默消失。
- `omp models --json` 耗时数秒到十几秒不等（随机器与网络波动），缓存只在进程内；新增角色只能来自常见角色列表；
  一个区块保存串行写多个 key，中途失败**不回滚**（会点名已保存的键并重新载入最新配置）；
  没有同名角色的兜底 key 会原样保留但可能不被 omp 使用（见 CONTRACT §16.8）。
- 目录选择对话框在应用未激活时可能出现在窗口后方。
- 菜单栏的状态判定是启发式：阈值（空闲 30 分 / 卡住 10 分 / 新近 60 秒）为推断值待校准；
  「等待输入（疑似审批）」的形态未在真实审批场景验证；子代理运行中的父会话不判疑似卡住
  （其进展不在父文件里，实测修正）。非 iTerm 占用者的会话不可聚焦（行内置灰并注明）。
- 菜单栏通知在本机实测未弹出横幅：ad-hoc 签名 + 系统勿扰模式开启的环境下，
  `tauri-plugin-notification`（legacy NSUserNotification）与 osascript 回退
  （`display notification`，归属「脚本编辑器」）都被静默丢弃；需在
  「系统设置 → 通知」允许对应应用、且勿扰关闭后才可见。转换检测与发送链路本身有单测覆盖。
- 关闭主窗口（红钮或 ⌘W「Close Window」）= 隐藏并驻留菜单栏（Dock 图标按设置隐藏，`ActivationPolicy::Accessory`，点 Dock 图标回到主窗口）；
  「退出 omp-resume」/ ⌘Q / Dock 退出 / 系统关机才真正退出（不拦截）。Dock 右键菜单经运行时注入实现，若未来 tao 自带该方法会静默消失（仅日志），不影响其他功能。
- 记忆库（Mnemopi）schema 是 omp 私有实现（按 18.12.3 实测），omp 升级可能变化：对不上的 bank 按「不可读」置灰静默降级，不报错；「来源会话缺失」只看 sessions 文件名近似判断（不解析文件）；搜索是 LIKE 子串匹配（大小写不敏感仅 ASCII），非分词全文检索。
- 记忆删除只镜像 omp 自己的 `forget` 语义：含 `vec_episodes`（sqlite-vec 虚表，需外部扩展）的 bank 上，情节记忆一律不可删（报告为「不支持」）——本机 37 个 bank 均无该表；删除工作记忆不会改动引用它的情节摘要 `summary_of`（上游行为一致，UI 用「被 N 条摘要引用」提示）；`memory_validations` 审计行保留不删。
- 备份是 `VACUUM INTO` 全库快照（含 WAL 已提交内容）；恢复只覆盖 db 文件、不还原已被移动前的目录权限细节；设备跨盘移动整库时用「复制 + 逐字节校验 + 删源」，大库会更慢。
- bank 占用检测同样依赖 `lsof`；`lsof` 缺失 / 超时一律按「探测失败」拒绝写（宁可误拒不会误删）。omp 进程内的 recall 结果缓存（默认关闭）可能在删除后数分钟内仍返回已删条目。
- 模型测试的 TTFT 是直连模型测得的，提示词只有约 84 个输入 token；omp 真实对话每次带约 23k token 的前缀，所以实际首字延迟会更长，应以「日常实测」列为准。`model_perf` 是 omp 的私有表，对不上时整列隐藏。测试器配置（模型、标签、监控）存在 localStorage，dev 与 .app 之间不互通。
