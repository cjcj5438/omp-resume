# omp-resume 契约（CONTRACT）

> 权威规格。本文 + `src-tauri/src/model.rs` + `src/types.ts` + `src/api.ts`
> 四者互相一致；冲突时以本文为准，并同步修正另三处。
> 后端实现时**不得**另起一套命名或语义，只能填充本文规定的行为。

产品：macOS-only 原生桌面应用（Tauri 2 + React + TS + Vite + Rust），中文 UI。
管理 `omp`（oh-my-pi）的会话、CLI 版本、用户级插件与技能。功能包括：
会话浏览（按项目分组）、只读会话预览、树视图、iTerm 一键续聊、
永久删除、从树节点续聊、omp 版本查询与更新、插件/marketplace 管理、技能查询/更新、
MCP 原生配置管理、用量与运行统计、清理、记忆库（Mnemopi）浏览与维护、模型测速。无会话重命名、无 fork 建文件、无导出、
无全文搜索、无多 profile、无回收站。

## 0. 一致性规则（给后续 worker）

- 加命令时四处同改：本文（语义）→ `model.rs`（serde 类型）→
  `types.ts`（逐字段镜像）→ `api.ts`（一个封装函数），
  并注册到 `lib.rs` 的 `generate_handler!`。
- 命令名 snake_case；进出 JSON 一律 camelCase；
  Rust 侧 `#[serde(rename_all = "camelCase")]`，
  联合类型用 `#[serde(tag = "kind")]`（`TreeNodeKind` 例外，直接序列化为字符串）。
- 所有命令返回 `Result<T, AppError>`，`AppError { code, message }`。
- 时间一律 ISO-8601 UTC 毫秒字符串（如 `2026-10-14T02:18:47.387Z`），
  不使用 unix 时间戳。
- 命令清单（§4 编号）：4.1–4.11 会话/更新、4.12–4.22 插件/技能、
  4.30–4.35 MCP、4.36–4.38 模型配置、4.39–4.50 记忆库、4.51–4.53 模型测试、4.56 bench 记录删除、
  4.54–4.55 模型规格（§21）、4.57–4.58 Agent 舞台（§23）、4.59 agent 定义详情（§23.6）、
  4.60–4.63 模型模式（§24）、4.64–4.67 会话右键菜单辅助（§25）。

## 1. 配置解析

- `sessionsDir`：CLI 参数 `--sessions-dir <path>` >
  环境变量 `OMP_RESUME_SESSIONS_DIR` > `$HOME/.omp/agent/sessions`。
- `ownersDir`：环境变量 `OMP_RESUME_OWNERS_DIR` >
  `$HOME/.omp/run/session-owners`。
- `memoryDir`：环境变量 `OMP_RESUME_MEMORY_DIR` >
  `$HOME/.omp/agent/memories/mnemopi/banks`（记忆库 bank 根目录，见 §18）。
- 启动参数由 `lib.rs` 解析后存入 Tauri `State`（实现细节，后续 worker 定）。
- omp 二进制：存在的 `OMP_RESUME_OMP_BIN` 环境变量路径 >
  `$HOME/.local/bin/omp` > `/opt/homebrew/bin/omp` > `/usr/local/bin/omp` >
  `$HOME/.bun/bin/omp`；逐项检查存在性，不依赖 GUI 进程的 PATH 查找。

## 2. 会话文件格式（实测，已验证）

### 2.1 存放布局

`<sessionsDir>/<编码cwd>/<UTC时间>_<uuid>.jsonl`，例如
`-my-omp-resume/2026-10-14T02-18-47-387Z_01a13834-...jsonl`。

- 每个 `.jsonl` 旁有一个**同名去扩展 sibling 目录**（artifacts + 子 agent
  嵌套 `*.jsonl`，扫描时必须忽略，只扫顶层）。
- 同目录有点文件 `.<name>.jsonl.lock.os`（omp 发布锁，忽略）。
- 可能有 `<name>.jsonl.<snowflake>.bak` 残留（EPERM 重写遗留，扫描忽略，
  删除时清理）。
- 扫描规则：只取各项目目录**顶层**、非点文件、`*.jsonl`；
  忽略嵌套目录、点文件、`.bak`。
- 实测样本：十余个项目目录、数十个顶层会话、总体积约百 MB 量级，单文件最大约 4 MB，
  header `version` 均为 3。

### 2.2 行类型

首行可选 `title` 记录（固定宽度槽位，改名时原地重写，无 id）：

```json
{"type":"title","v":1,"title":"🎛️ DEMO: ...","source":"auto","updatedAt":"2026-10-14T02:33:40.897Z","pad":"   ..."}
```

注意 `source` 可缺省（实测有缺 `source` 的 title 行）。`title` 可为空字符串。

第二行是 `session` header（`version:3`，`id` 即会话 id，`cwd` 为项目真实路径）：

```json
{"type":"session","version":3,"id":"01a13834-...","timestamp":"2026-10-14T02:18:47.387Z","cwd":"/Users/demo/my/omp-resume"}
```

header 还可能带 `parentSession`（fork 血缘，不透明字符串：id 或路径）、
`previousSessionFiles`（路径数组，移动/复活指针，**不是** fork）、
`providerPromptCacheKey`、`title` / `titleSource`。

之后每行是一个条目，通用包络 `{type, id, parentId, timestamp}`。
`id` 通常 8 位十六进制，碰撞耗尽时回退为 Snowflake（不得假设定宽）；
`parentId` 可为 `null`（根条目）。**缺少字符串 `id` 的行不参与树与会话**
（见 2.6）。

全量 46 文件统计的 `type` 分布：
`title` 46、`session` 46、`message` 4635、`custom` 2939、
`model_change` 108、`thinking_level_change` 105、`custom_message` 109/162（含嵌套）、
`model_usage` 112、`mode_change` 53、`title_change` 50、
`credential_pin` 13、`reset_boundary` 9、`service_tier_change` 6。
`compaction` / `branch_summary` / `label` / `session_init` /
`ttsr_injection` 本机数据未出现，形状以 omp 文档为准（下文）。

### 2.3 `message`（message.role 区分大小写，必须原文匹配）

| role | 内容 |
|---|---|
| `user` | `{content:[{type:text,text}], attribution?, timestamp?}` |
| `assistant` | `{content:[thinking\|text\|toolCall], api?, provider?, model?, usage?, stopReason?, ...}` |
| `toolResult` | `{toolCallId, toolName, content:[text\|image], isError?, details?, timestamp?}` |
| `bashExecution` | `{command, output, exitCode?, cancelled?, truncated?, timestamp?, excludeFromContext?}`（无 `content` 数组） |
| `developer` | `{content:[{type:text,text}], attribution?, timestamp?}` |
| `hookMessage` / `fileMention` / `pythonExecution` | 文档有、本地无，按 `other` 处理 |

内容块：

- `text`: `{type:"text", text}`。
- `thinking`: `{type:"thinking", thinking, thinkingSignature?, summary?}`。
- `toolCall`: `{type:"toolCall", id, name, arguments?, partialArgs?}` ——
  注意这是 assistant `content` 数组里的**块类型**，不是 role。
- `image`: `{type:"image", data:"blob:sha256:...", mimeType, detail?}` ——
  图片已外部化为 blob 引用，无内联大 base64（实测 55 个均为引用）。

### 2.4 `custom`（不透明，非 LLM 记录）

```json
{"type":"custom","customType":"tool_execution_start","data":{"toolCallId":"...","toolName":"read","startedAt":"...","args":{...},"intent":"..."},"id":"27553b59","parentId":"3e16c00b","timestamp":"..."}
```

本地见过的 `customType`：`tool_execution_start`（最多，assistant 与
toolResult 之间）、`system-prompt-digest`、`session_exit`、`memory_recall`、
`vibe-session-lifecycle`、`todo_hud_state`、`goal-completed` 等。
`custom` **不进入**模型上下文（`buildSessionContext` 只转换
`message` / `custom_message` / `branch_summary`；未知命名空间
`customType` 对核心重建完全不透明——omp 文档原话）。
这就是 `append_branch_marker` 追加 `custom` 行安全的原因（见 §7）。

### 2.5 `custom_message` / `label` / `compaction` / `branch_summary`

- `custom_message`：`{customType, content(字符串或块数组), display?, details?, attribution?, id, parentId, timestamp}`，
  参与 LLM 上下文，但多为扩展通知流量（如 `skill-prompt` 全文转储），
  **v1 不展示**：不是保留类型，不进树、不进会话。
- `label`（文档形状，本地未见）：
  `{"type":"label","id":..,"parentId":..,"timestamp":..,"targetId":"...","label":"..."}`。
  **不是可见节点**，而是把 `label` 字符串挂到 `targetId` 节点上；
  同一节点多个 label 取文件顺序最后一个；`label` 缺失/undefined 视为清除。
- `compaction`（文档形状）：`{summary, shortSummary?, firstKeptEntryId?, ...}`。
- `branch_summary`（文档形状）：`{fromId("root" 或 id), summary, ...}`。

### 2.6 树与 leaf 语义（omp 源码/文档行为）

- 模型是「append-only 树 + 可变 leaf 指针」；**leaf 不持久化**，
  加载时重建为**文件顺序最后一个有 id 的条目**。
- `parentId` 缺失/悬空（指向不存在的 id）→ 该节点视为根（入 `rootIds`）。
  环（id 重复出现）→ 走到重复处截断，防止死循环。
- `reset_boundary`（`/clear`  marker）只影响模型上下文折叠，
  **v1 树与会话均不过滤它**（它是被跳过类型；完整导出保留全部历史——
  与 omp 全量 transcript 行为一致）。

### 2.7 保留类型与重链接

可见节点**仅**三种：`message`、`compaction`、`branch_summary`。
`label` 只提供挂载字符串，不建节点。
其余所有类型（`custom`、`custom_message`、`model_change`、
`thinking_level_change`、`model_usage`、`mode_change`、
`service_tier_change`、`title_change`、`credential_pin`、
`reset_boundary`、`session_init`、`ttsr_injection` 等）全部跳过，
其子节点**重链接到最近的保留祖先**（找不到则为根）。
这条规则是必需的：`tool_execution_start` 等 `custom` 行永远插在
assistant 与 toolResult 之间，不跳过它们树会断裂。

## 3. 占用探测（flock）

- omp 写会话的进程持有 `<ownersDir>/<session-id>.lock` 的 OS `flock`
 （macOS 为 sidecar 文件锁；Linux 为抽象 socket、Windows 为命名互斥体——
  本应用只跑 macOS）。
  注意：omp 文档把该租约写作 `<session-owners>/<session-id>`（无后缀），
  但本机磁盘文件一律为 `<session-id>.lock`（以后缀为准；锁文件持续累积，
  数量只作参考，占用判定只看 flock，不看文件是否存在）。
- 探测：对该文件 `flock(LOCK_EX|LOCK_NB)`。
  `EWOULDBLOCK` → `inUse:true`；文件不存在或加锁成功（立即释放）→
  `inUse:false`；其他失败（权限等）→ `probeOk:false, inUse:false`。
- 会话 id 取自 header.id；id 解析不出 → `probeOk:false`。
- 全量探测对每个锁文件做一次非阻塞 flock（360 余个约 5ms，见 §17 实测）。
- 只读打开（share/export/预览）不占租约——我们的读/探测都不写文件，
  唯二写操作是删除与 marker 追加，且都先拒绝 `inUse`。

## 3.1 占用者识别（occupant，仅展示）

> 尽力而为的展示信息：告诉用户**哪个应用**里的 omp 进程占着会话。
> `inUse` / `probeOk` 与全部写门禁仍**只**来自 §3 的 flock 探测；
> 本节任何失败都静默降级为"无占用者信息"（`occupant: null`），永不报错、
> 永不改变 `inUse`。DeleteDialog 与错误码（`IN_USE` 等）行为不变。

- `Occupant { pid: u32, app: string|null, appVersion: string|null }`
  （JSON camelCase：`{pid, app, appVersion}`）；
  `SessionSummary.occupant`：非占用或未找到 PID 时为 null；
  找到 PID 但应用无法识别时为 `{pid, app:null, appVersion:null}`。
- 解析时机：在 `list_sessions` 内同步进行，每次调用至多一次，
  仅当 ≥1 可见会话 `inUse` 时才做；无占用会话时不调 `lsof`、不读环境。
- 找 PID：系统 `lsof`（绝对路径 `/usr/sbin/lsof`，GUI 应用 PATH 极简），
  `lsof -nP -F pn -- <lockfile>...` 一次查全部 in-use 会话的锁文件
  （字段输出 `p<pid>` / `n<path>` 行）。硬超时 ~2s（超时杀子进程），
  stdin 为 null；exit 1 无输出 = 无持有者（正常情况）。
  按锁文件名 basename（`<id>.lock`）匹配会话 id；一锁多 PID 时取最低 pid。
- 读环境：对持有者 PID 用 `sysctl([CTL_KERN, KERN_PROCARGS2, pid])` 原生读取
  （`ps eww` 在 macOS 不显示环境，不用它；祖先链回溯不用——iTerm2 会话
  父进程已消亡，实测验证）。同用户进程无需 root 即可读（~26ms/PID）；
  EPERM/ESRCH/截断 → 无信息。**只提取白名单变量**
  （`TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`__CFBundleIdentifier`、
  `TMUX`、`TERMINAL_EMULATOR`），其余不保留、不日志、不传前端。
- 分类（纯函数，优先级 tmux > bundle id > TERM_PROGRAM）：
  - `TMUX` 非空或 `TERM_PROGRAM == "tmux"` → `tmux`（tmux 内底层窗口应用不可靠，无版本）。
  - `__CFBundleIdentifier` 查表：com.googlecode.iterm2→`iTerm2`（已验证）、
    com.microsoft.VSCode→`VS Code`（已验证）、com.microsoft.VSCodeInsiders→
    `VS Code Insiders`、com.apple.Terminal→`Terminal`、com.mitchellh.ghostty→
    `Ghostty`、com.todesktop.230313mzl4w4u92→`Cursor`、dev.zed.Zed→`Zed`、
    dev.warp.Warp-Stable→`Warp`、com.github.wez.wezterm→`WezTerm`、
    net.kovidgoyal.kitty→`kitty`、org.alacritty→`Alacritty`、co.zeit.hyper→
    `Hyper`、`com.jetbrains.` 前缀或 `TERMINAL_EMULATOR=JetBrains-JediTerm`→
    `JetBrains`。bundle id **优先于** `TERM_PROGRAM`（Cursor 等 VS Code
    fork 会伪装 `TERM_PROGRAM=vscode`）。
  - 否则 `TERM_PROGRAM` 查表：`iTerm.app`→iTerm2（已验证）、`Apple_Terminal`→
    Terminal、`vscode`→`VS Code`（已验证）、`ghostty`→Ghostty、
    `WarpTerminal`→Warp、`WezTerm`→WezTerm、`Hyper`→Hyper；其他非空值原样展示。
  - 版本：仅当所选展示名与 `TERM_PROGRAM` 派生名一致时取
    `TERM_PROGRAM_VERSION`（如 Cursor 进程带 VS Code 的版本号，不能算到
    Cursor 头上）；tmux 永无版本。
- 表中除 iTerm2 / VS Code 外均为**未验证**（tmux、Cursor、Ghostty、
  Terminal.app、JetBrains、SSH/rpc 模式的无头进程大概率无应用名，
  只显示 PID 或 null）。
- 展示：列表徽章 `占用中 · <应用>`（应用未知时保持 `占用中` 原样）；
  详情页显示 `<应用> <版本> · PID <n>`，应用未知但有 PID 时只显示 `PID <n>`。

## 4. 命令

### 4.1 `get_config`（已删除）

（已删除：`get_config` 命令已移除，编号保留。）

### 4.2 `list_sessions() -> { sessionsDir, hiddenEmpty, groups }`

- 扫 §2.1 规则的顶层 `*.jsonl`；坏行（非 JSON / 无 `type`）跳过并计入
  `badLines`（宽容解析，与 omp `loadEntriesFromFile` 一致）。
- `groups` 按组内最新会话 `modifiedAt` 倒序；组内会话 `modifiedAt` 倒序。
  `ProjectGroup { cwd, dirName, sessions }`：
  `cwd` 取该目录下会话 header 的 `cwd`（不一致时取多数/首个——实现自定，
  文档说明）；`dirName` 为编码目录名。
- 隐藏规则：**无标题且零用户消息**的会话不入列表，计入 `hiddenEmpty`。
  「无标题」指 §4.2.1 算出的标题为空或缺失；
  「零用户消息」指全文件无 `role=user` 的 message 条目。
- `SessionSummary` 字段（详见 model.rs）：
  - `title`（§4.2.1）：最新标题 / 首用户消息 60 字 / `(无标题)`。
  - `messageCount`：**active 路径**上的 user + assistant 消息数。
  - `branchCount`：保留树的叶子数；仅 >1 时 UI 显示「N 个分支」。
  - `occupant`（§3.1）：`null`（非占用 / 未找到 PID）或
    `{pid, app: string|null, appVersion: string|null}`。
  - `fork`：header 有 `parentSession` 时为 `{ parentRaw,
    parentTitle: string|null, parentPath: string|null }`，
    否则 null。解析：字符串等于被扫会话的 id → 取其标题与路径；
    否则若为 sessionsDir 下存在的 `.jsonl` 路径 → 读其廉价标题；
    否则两字段均为 null。`previousSessionFiles` **不是** fork，忽略。
  - 非 v3（`version !== 3`）：`formatSupported:false`，
    只填 `id/cwd/modifiedAt/size/title（仅 title 行 + header，不扫全文）`，
    不可预览/建树（`get_conversation`/`get_tree` 报 `UNSUPPORTED_FORMAT`）。
    `version` 为实际值或缺失（null）。
  - `createdAt` 取 header.timestamp；`modifiedAt` 取文件 mtime；
    `cwdExists` 为 cwd 可进入（`cd` 语义，目录存在即可）。

#### 4.2.1 标题解析

按文件顺序取**最后一个非空**字符串，候选依次为：首行 title 记录 `.title`、
header `.title`、每个 `title_change` 的 `.title`。
全空 → active 路径最早 user 消息截断 60 字；无 user 消息 → `(无标题)`。
（title 槽位在改名时原地重写，与 `title_change` 审计一致，取最后非空即当前值。）

### 4.3 `get_conversation { path, nodeId? } -> Conversation`

- `path` 必须指向 sessionsDir 下的顶层 `.jsonl`（校验同 §6，通过才读）。
- 建树（§5），`leafId` = 文件末物理条目向上最近的保留节点。
  文件无保留节点时 `leafId:null`：未指定 `nodeId` → 返回空 `items`
 （`targetId:""`）；指定了 `nodeId` → `INVALID_NODE`。
- 未指定 `nodeId` 时 `targetId = leafId`（leaf 存在时）；
  指定 `nodeId` 时必须命中保留节点，否则 `INVALID_NODE`。
- `items` 为根 → target 路径上的保留条目，映射：
  - user → `{kind:user, text}`（text 块 `\n` 拼接，image 块记 `[图片]`）。
  - assistant → `{kind:assistant, blocks}`，
    块为 `text | thinking{text} | toolCall{id,name,args}`。
    `args` 取 toolCall `.arguments`（缺失为 null）；`partialArgs` 忽略。
  - toolResult → `{kind:toolResult, toolCallId, toolName, isError(缺省false),
    text, truncated}`。text 为 text 块拼接（image 记 `[图片]`），
    超 `MAX_TEXT_BYTES` 截断（见 §9）并置 `truncated:true`。
  - bashExecution → `{kind:bashExecution, command, text(output),
    truncated, exitCode(可null), cancelled(缺省false)}`，同上截断。
  - compaction → `{kind:compaction, summary}`；无 summary 时为空字符串。
  - branch_summary → `{kind:branchSummary, summary}`，同上。
  - 其他 message role（developer 等）→ `{kind:other, role, text}`，
    text 为首 2000 字（见 §9）。
- 非保留类型不出现在 items 中（`custom_message` 亦不出现）。

### 4.4 `get_tree { path } -> TreeData`

- 同样的路径校验；非 v3 → `UNSUPPORTED_FORMAT`。
- 保留类型仅 `message/compaction/branch_summary`（§2.7），
  `label` 挂载到 `targetId`（取最后）。
- `TreeNode { id, parentId, childIds, kind, role, timestamp, preview,
  label, isCompaction, isBranchSummary }`：
  - `kind`：message | compaction | branchSummary。
  - `role`：message 节点的 message.role，其余 null。
  - `preview ≤80 字`：user→首 text；assistant→首 text 块，
    无则首 thinking，无则 toolCall 名拼接（`name1, name2`）；
    toolResult→text 头；bashExecution→`command` + output 头；
    developer/other→text 头；compaction/branch_summary→summary 头。
    超长截断加 `…`。
  - `parentId`：重链接后的 kept 父，无则 null；对应的 `rootIds`。
  - `leafId`：文件末物理条目向上最近的保留节点，无则 null。
  - `activePathIds`：leaf → 根（leaf 在前，环/缺失截断）。
- 返回扁平 `nodes`（文件顺序）；链折叠由前端做。

### 4.5 `check_session { path } -> { inUse, probeOk }`

纯 §3 探测。路径不存在 → `NOT_FOUND`。

### 4.6 `delete_sessions { paths } -> DeleteResult[]`

- 逐路径独立结果 `{ path, ok, error }`，不因单个失败中断。
- 拒绝：`inUse` → `IN_USE`；`probeOk:false` → `PROBE_FAILED`。
- 路径安全（任一违反 → `OUTSIDE_ROOT`，单个结果内返回，不抛）：
  规范化（canonicalize，解析 `..` 与符号链接）后必须形如
  `<sessionsDir>/<单层dir>/<file>.jsonl`；点文件、嵌套、非 `.jsonl` 一律拒绝；
  目标不存在 → `NOT_FOUND`。
- 删除集合（与 omp `deleteSessionWithArtifacts` 一致，已对源码验证）：
  1. `unlink <file>.jsonl`；
  2. `rm -rf <同 stem sibling 目录>`（`<file>` 去掉 `.jsonl` 后缀；
     不存在视为成功）；
  3. `unlink <file>.jsonl.*.bak`（best-effort，单个失败只告警不回滚）。
- 不碰 `~/.omp/agent/history.db`（omp 自己也不碰）。
- 永久删除，无回收站（v1 决定）。
- 损坏会话（header 不可读）→ 无法确定会话 id 与占用状态，
  单路径返回 `PROBE_FAILED`（不敢盲目删除），文件保留；
  header 可读但 id 缺失同样走此路径。`NOT_FOUND` 则透出（路径本身不存在）。
- 附加安全（比上游保守，单测锁定）：sibling 为符号链接时只删链接本身
  （不跟随递归，绝不误删链接目标）；sibling 为普通文件时保持不动。

### 4.7 `append_branch_marker { path, nodeId } -> { markerId }`

- 拒绝：`inUse` → `IN_USE`；`probeOk:false` → `PROBE_FAILED`；
  `nodeId` 非保留节点 → `INVALID_NODE`；
  文件末尾非 `\n` 结尾 → `IO`（防半行追加；omp 正常写入恒为整行）。
- `nodeId` 已是 leaf → **无操作**，返回 `{ markerId: null }`。
- 否则以 `O_APPEND` 单次写入追加恰好一行：
  `{"type":"custom","customType":"omp-resume-branch","id":<8位小写十六进制，文件内唯一>,"parentId":<nodeId>,"timestamp":<ISO-8601 UTC毫秒>,"data":{}}`
  末尾含 `\n`。id 碰撞则重抽（以 omp 的 8-hex / Snowflake 回退惯例为准）。
- 安全性（已对 omp 文档验证，并经真实 omp 18.10.3 TUI 实测）：
  `customType:"omp-resume-branch"` 为命名空间值，
  核心重建视为不透明，不进入模型上下文（§2.4）；
  字段名与 `custom` 条目完全一致。resume 后该 marker 只是树上一个
  被跳过的自定义节点，其子（新续聊内容）挂在其下——这正是「从该节点续聊」。
  实测：`omp --resume` 把 leaf 重建为该 marker 并从 `parentId` 继续，
  未知 `customType` 完全容忍。**omp 不校验 `parentId`**（错误 id 静默给出
  空分支），因此 `nodeId` 必须由本应用先校验为保留节点。
- 追加后该文件 leaf 变为 marker（它是文件末行）；
  用 `omp --resume <path>` 打开即从该分支继续。
- 实现：写入前**复探**一次占用（收窄"探测→写"竞态窗口）。残余竞态
  无法完全消除：`O_APPEND` 保证单次写行级原子（文件不会坏行），
  最坏是 marker 之后又多了 omp 的行（marker 不再是末行、分支被覆盖），
  续聊前重查 leaf 即可发现。

### 4.8 `open_in_iterm { path } -> ()`

- 拒绝：`inUse` → `IN_USE`（探测失败**允许继续**，只读打开不占租约）；
  记录的 `cwd` 不存在 → `CWD_MISSING`；文件不存在 → `NOT_FOUND`。
- 行为：在 iTerm 当前窗口开新 tab（无窗口则开新窗口；
  iTerm 未运行则启动），执行
  `cd '<cwd>' && omp --resume '<abs path>'`，
  单引号 shell 转义（`'` → `'"'"'`），AppleScript 字符串转义。
- 命令跑完后 shell 保留（不 `exit`），用户可继续交互。
  `omp` 用 bare 命令名（走用户 PATH，与 brief 一致）。
- AppleScript 失败 → `ITERM_FAILED`（含系统信息）。
  需要的 `NSAppleEventsUsageDescription` 已随包发布（见 §10）。
- 实现：纯逻辑层 `open_in_iterm_impl(cfg, path, opener)` 的终端打开器
  可注入（`&dyn Fn(&str) -> Result<(), AppError>`；生产传 `ops::iterm::open_tab`），
  测试注入桩以断言精确命令串而不启动 iTerm。

### 4.9 `omp_version() -> { version, path }`

- 按 §1 解析 omp，运行 `--version`（10 秒超时），本地只读、不联网。
- `version` 为 `omp/18.11.1` 中的版本字符串（含预发布后缀）；无法解析为 null。
  `path` 为解析到的二进制路径；未找到时两个字段均为 null，不报错，UI 隐藏徽章。

### 4.10 `omp_update_check() -> { current, latest, upToDate, raw }`

- 运行 `omp update --check`（60 秒超时），只检查、不安装；未找到 → `OMP_NOT_FOUND`，
  非零退出 → `OMP_FAILED`。查询与 §4.9 不占用写操作门禁。
- `Current version: X` → `current`，`New version available: Y` → `latest`；
  无对应输出时为 null。仅含 `Already up to date`（忽略大小写）且没有新版提示时
  `upToDate:true`。不从未识别文本猜测状态。
- `raw` 是去除 ANSI 控制序列后的完整合并输出。包管理器托管等未识别输出原样展示，
  提示「未识别的输出，可能由包管理器托管；请在其管理器中更新」，不提供更新按钮。

### 4.11 `omp_update_run { onLine } -> { before, after, changed, output }`

- 全局 `OmpBusy` 写操作门禁（RAII 自动释放）；已占用 → `BUSY`，
  文案「另一个 omp 操作正在进行」。本命令只暴露固定参数，不接受任意 CLI 参数。
- 查询更新前版本 → `omp update`（15 分钟超时）→ 查询更新后版本；
  `before` / `after` 无法解析为 null，`changed = before != after && after != null`。
  非零退出 → `OMP_FAILED`；退出 0 不代表升级成功（包管理器托管可不做修改），
  `changed:false` 时只显示「版本未变化」与输出，不宣称成功。
- `onLine` 为 `Channel<string>`，每行去除 ANSI 后实时发送；`output` 为合并完整输出。
  更新中不可关闭对话框；版本改变时提示已打开的 omp 会话需重启后使用新版本。
- 所有阻塞工作在 `spawn_blocking` 中执行。runner 使用绝对路径、不经过 shell，
  stdin 为 null，stdout/stderr 由 reader 线程经通道按到达顺序逐行合并；
  `NO_COLOR=1`，PATH 为 `/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:` +
  继承 PATH + `:/usr/bin:/bin:/usr/sbin:/sbin`。超时杀进程并回收子进程与 reader 线程，
  返回 `TIMEOUT`；超时与非零退出错误文案保留输出末约 500 字。

### 4.12 `omp_plugins_list() -> { plugins, npm, marketplaces, warnings }`

- 仅管理 user scope。运行 `omp plugin list --json --scope user` 与
  `omp plugin marketplace list --scope user`，各限 60 秒，不占写门禁。
  两次查询独立；任意一次失败或插件 JSON 无法解析，仍返回另一部分并追加中文 `warnings`。
  omp 不存在仍报 `OMP_NOT_FOUND`。
- marketplace 插件 JSON 形如 `{marketplace:[{id, scope, entries:[...]}], npm:[...]}`；
  每个插件仅取 `entries` 中 `scope:"user"` 的条目，无 user 条目则跳过。
  `PluginSummary {id, name, marketplace, version, enabled, installedAt, lastUpdated, installPath}`；
  `id` 为 `name@marketplace`，`enabled` 缺省 true；其余缺失元数据为 null。
- npm 仅只读展示 `{name, version:string|null}`，对未知条目尽力提取，异常条目不拖垮列表。
  **已在 omp 18.11.1 沙箱实测** `omp-enforce-uv@0.3.0`：npm 数组条目含
  `{name, version, path, manifest, enabledFeatures, enabled}`，这里只公开名称与版本。
  npm 安装会提示 `--scope` 仅用于 marketplace 并忽略该标志；本应用不提供 npm 写操作。
- marketplace 文本仅解析 `Configured Marketplaces:` 后的缩进行
  `名称  来源` → `{name, source}`；`No marketplaces configured` 或未识别输出 → 空数组，
  不猜测、不报解析错误。

### 4.13 `omp_plugin_discover { marketplace } -> DiscoverEntry[]`

- `omp plugin discover <marketplace> --scope user`（60 秒）；解析缩进行
  `name@version` 与随后更深缩进的描述 → `{name, version, description}`。
  容忍空行、额外标题与未知行，不能识别时为空数组。

### 4.14 `omp_plugin_install { id, onLine } -> OmpOpResult`

- `omp plugin install <id> --scope user`。

### 4.15 `omp_plugin_uninstall { id, onLine } -> OmpOpResult`

- `omp plugin uninstall <id> --scope user`。

### 4.16 `omp_plugin_set_enabled { id, enabled, onLine } -> OmpOpResult`

- 根据 `enabled` 运行 `omp plugin enable|disable <id> --scope user`。

### 4.17 `omp_plugin_upgrade { id?, onLine } -> { output, changes }`

- `omp plugin upgrade [id] --scope user`；id 为 null 时升级全部 user marketplace 插件。
- `changes: {id, scope, from:string|null, to}[]` 解析以下两种 user 行：
  `  hello-plugin@probe-mkt (user): 1.0.0 -> 1.1.0` 与
  `Upgraded hello-plugin@probe-mkt (user) to 1.1.0`（此形式 `from:null`）。
  同一 id/scope 的前后行合并；未识别输出仍完整保留在 `output`；
  `All marketplace plugins are up to date.` → 空 changes，不根据退出 0 编造版本变化。

### 4.18 `omp_marketplace_update { name?, onLine } -> OmpOpResult`

- `omp plugin marketplace update [name] --scope user`；name 为 null 时更新全部来源缓存。

### 4.19 `omp_marketplace_add { source, onLine } -> OmpOpResult`

- `omp plugin marketplace add <source> --scope user`，保留原始输出（如
  `✔ Added marketplace: /tmp/omp-mkt`），不从提示行伪造 marketplace 名称。

### 4.20 `omp_marketplace_remove { name, onLine } -> OmpOpResult`

- `omp plugin marketplace remove <name> --scope user`。
- §4.14–§4.20 共用 §4.11 的 `OmpBusy` RAII 门禁、ANSI 清理、Channel 逐行日志、
  stdin=null、15 分钟长超时（Git 来源可能耗时）；`OmpOpResult {output}`。
  非零退出 → `OMP_FAILED`（中文摘要 + 输出末约 500 字），超时 → `TIMEOUT`，忙 → `BUSY`。
  所有阻塞工作在 `spawn_blocking` 中完成，不暴露自由 argv。
- 参数校验失败 → `INVALID_INPUT`：插件 id 严格为
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；
  marketplace 名称为 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。
  source 非空、最多 512 字、无控制字符且不以 `-` 开头；仅允许 `owner/repo` 简写、
  `http://` / `https://` / `ssh://` URL、`git@host:path`、绝对路径或 `~/` 路径。
  路径中的空格/分号仅作为 argv 字面值，不交给 shell 执行。
- 已在隔离 HOME 的 omp 18.11.1 实测 install/uninstall/enable/disable/upgrade、
  discover 与 marketplace add/list/update/remove 均接受 `--scope user`，无需省略。

### 4.21 `omp_skills_list() -> { skills, warnings }`

- `omp skill list -g --json`（60 秒，只读）；每条完整镜像
  `{name, description, filePath, baseDir, source, hide}`，未知字段忽略，缺失字符串为 `""`、
  hide 缺省 false；保留上游字符串 warnings。坏 JSON → `OMP_FAILED`。

### 4.22 `omp_skills_update { onLine } -> OmpOpResult`

- `omp skill update -g`，绝不传 `-y`（不能自动批准带脚本的技能）。
  共用全局 `OmpBusy`、15 分钟超时、逐行日志与错误语义。
- 只更新 registry 管理的全局技能；`~/.agents/skills` 由另一个工具维护，不受本命令影响。
  本节没有技能安装、删除、任意命令或项目级变更入口。
> §4.23–§4.29 保留未用；MCP 一组固定从 §4.30 起编号。

### 4.30 MCP 配置范围、类型与安全规则

- 所有 MCP 命令直接读写 JSON，不启动 omp、不联网、不占用 `OmpBusy`。
  阻塞文件 IO 在 `spawn_blocking` 内执行；三个变更命令共用独立的进程级 `Mutex`，
  锁覆盖重新读取、比较 revision、修改和原子写入；只读命令不加锁。
- `scope: "user" | "project"`。只允许默认 profile 的 `$HOME/.omp/agent/mcp.json`
  与 `<project>/.omp/mcp.json`；不接受任意配置文件路径，不扫描其他工具配置。
  `project?: string|null` 是绝对、存在且为目录的 cwd，canonicalize 后不得等于 HOME；
  project scope 必须提供；只要提供 project 就校验，失败为 `INVALID_INPUT`。
  纯逻辑层注入 HOME，测试只用临时目录。
- 文件 JSON 顶层与 `mcpServers`（若有）必须是对象。保留 `$schema`、
  `disabledServers`、`enabledServers`、其他服务器及所有未知字段与键顺序。
  JSON 重序列化为 2 空格缩进并补末尾换行，原始格式/空白可能改变，内容及未修改键的顺序保留。
- `revision` 有三种值：不存在为 `"absent"`；权限/IO 错误导致 bytes 无法读取时为 `"unreadable"`；
  可读取时为**原始文件 bytes** 的小写十六进制 SHA-256（包括 JSON 解析失败的文件）。
  `expectedRevision:"unreadable"` 或当前文件不可读时，所有变更先返回 `IO`，不触碰文件或目录。
  其余变更重新读取并比较 `expectedRevision`，不一致返回 `CONFLICT`（「文件已被外部修改」），
  不覆盖文件；解析失败返回 `IO`（「配置文件不是合法 JSON，请先手动修复」），绝不重建覆盖。
  同目录独占创建临时文件后 rename；保留原文件权限位，新文件权限 `0600`。
  缺少 `.omp/`（用户级还包括 `agent/`）时按需创建；临时文件在失败时清理。
- 软链接写穿到目标、保留链接：目标 `mcp.json` 本身是软链接（dotfiles 常见做法）时，
  变更写穿到最终目标（临时文件 + rename 都在目标目录），链接本身保持不动，
  权限位取自目标；失效链接（目标缺失）拒绝写入并报 `IO`
  「配置文件是一个失效的软链接，请先修复」。读取与 revision 本就跟随链接。
- 列表绝不返回 env/header **值**、args 内容、auth/oauth 内容，也不生成可被回写的掩码值。
  只有 `mcp_get_server` 供编辑框返回真实配置；禁止记录/展示这些值到日志。

### 4.31 `mcp_list { project? } -> McpListResult`

- `{ files: McpFileInfo[], servers: McpServer[] }`；顺序为 user、project，
  各文件服务器按配置键顺序。未提供 project 时只有用户文件。
- `McpFileInfo { scope, path, exists, readError: string|null, revision,
  disabledServers: string[], enabledServers: string[] }`。
  单文件读取/解析失败记中文 `readError`、省略该文件服务器，不让整个命令失败；
  项目文件的两个覆盖列表始终为 `[]`，只读取用户文件的同名覆盖列表。
- `McpServer { scope, name, transport: "stdio"|"http"|"sse"|"unknown",
  command: string|null, argCount: number, url: string|null, enabled: boolean,
  effective: boolean, shadowedBy: null|"project"|"disabledServers"|"disabled",
  envKeys: string[], headerKeys: string[], hasAuth: boolean }`。
  `enabled` 为源条目的自身开关（缺省 true）；`hasAuth` 表示存在非 null 的 auth 或 oauth。
  未写 type 时 command 条目推断 stdio，只有 url 的条目推断 http；无法识别为 unknown。
- 按名称先选 project，否则 user；不合并同名定义。实际有效性（从上至下优先）：

  | 条件 | effective | shadowedBy |
  |---|---|---|
  | 用户 disabledServers 包含该名称（包括同名落败条目） | false | disabledServers |
  | 用户条目被同名项目条目覆盖 | false | project |
  | 胜出条目 enabled=false，且用户 enabledServers 未包含名称 | false | disabled |
  | 胜出条目 enabled=true 或用户 enabledServers 包含名称 | true | null |

  enabledServers 永远不能越过 disabledServers；项目文件自己的覆盖列表不参与计算。

### 4.32 `mcp_get_server { scope, project?, name } -> McpServerRaw`

- `{ config: unknown, revision: string }`，config 为该条目的真实 JSON（包括 secret）。
  每次重新读文件，无内存缓存；文件或名称不存在为 `NOT_FOUND`。

### 4.33 `mcp_save_server { scope, project?, name, config, expectedRevision, originalName? } -> McpSaveResult`

- `{ revision: string }`。新增或替换 `mcpServers[name]`；`originalName` 用于重命名：
  必须存在，移除旧键并插入新键；新名称若已被其他条目使用则 `INVALID_INPUT`，不覆盖其他服务器。
- 名称 1–100 个字符，仅 ASCII 字母/数字、`_`、`-`、`.`、`:`，
  允许非空名称段之间的**单个空格**，不允许首尾空格或连续空格。
- config 必须是对象；显式 type 仅 stdio/http/sse。未写 type 按 §4.31 推断，
  无 command/url 时按 stdio 校验；stdio 必须有非空 command，http/sse 必须有非空 url；
  command 与 url 不可同时存在。args 为字符串数组，env/headers 为字符串值对象，
  enabled 为 bool，timeout 为非负数（允许 0）。这些错误均返回中文 `INVALID_INPUT`。
- **防掩码回写**：env/headers 任一值若全由 `•` 组成（包括 `••••`），返回 `INVALID_INPUT`，
  文案指出对应键名，文件 bytes 不变；不会用占位符覆盖真实 secret。
- 新文件按顺序创建 `$schema`（OMP 官方 mcp-schema.json URL）与 `mcpServers`；
  只改目标条目，未修改字段/其他条目的内容与键顺序不变。

### 4.34 `mcp_set_enabled { scope, project?, name, enabled, expectedRevision } -> McpSaveResult`

- 名称不存在为 `NOT_FOUND`。禁用写入 `enabled:false`；启用则**删除** enabled 键，
  用缺省 true，不写 `enabled:true`。其余字段、用户覆盖列表不动；
  因 disabledServers 或同名项目条目而无效的服务器，单改自身开关不保证实际有效。
- revision、输入校验、无效 JSON 拒绝、原子写入与 §4.33 相同。

### 4.35 `mcp_delete_server { scope, project?, name, expectedRevision } -> McpSaveResult`

- 只移除目标键，名称不存在为 `NOT_FOUND`；不删空文件，不清理其他服务器。
  不触碰 disabledServers/enabledServers 中的旧名称（残留无害）。
  revision 与原子写入规则同 §4.33。
- 已知限制：仅默认 profile；不读取 PI_CONFIG_DIR/PI_CODING_AGENT_DIR 覆盖；
  不模拟不同名称等价 endpoint 的去重，不模拟 `mcp.enableProjectConfig` 或运行时连接/浏览器过滤。
  `effective` 仅表示这两个原生文件中的名称优先级/开关规则，并非在线状态。
  正在运行的 omp 会话需 `/mcp reload` 或重启后读取修改；本应用不负责连接测试与 OAuth 登录。
- 已知限制（跨进程竞态）：与 omp 之间没有共享锁协议；在最终 revision 复检与 rename 之间
  （约数十微秒）发生的外部写入会被覆盖且无提示；应用内由 Mutex 串行，
  跨进程只靠 revision 比对降低概率。

## 5. 建树算法（`list/get_conversation/get_tree` 共用）

1. 逐行解析；坏行计数跳过。首行 `title` 与 `session` header 不入树。
2. 无字符串 `id` 的行跳过（不计坏行——形状合法但无链接能力）。
3. kept 判定与 label 收集（§2.7）；`parentId` 指向 kept 节点则直接挂载
   （kept 之间的链接原样保留，即使成环——与 omp 一致）；
   否则沿 `parentId` 链上溯找最近 kept 祖先（经跳过节点），
   找不到 / 遇到 null / 上溯中成环 → 根。
   走访（active 路径、会话展开）遇重复 id 即截断，防止死循环。
4. `childIds` 按文件顺序；`leafId` = 从文件末有 id 条目向上找的
   最近 kept 节点（无则 null）。
5. `branchCount` = 无 child 的 kept 节点数。

复杂度：单遍 O(n)，4 MB 文件常温下 <100ms 量级（实现时注意别二次全量序列化）。

## 6. 路径校验（读/删/标记/iTerm 共用）

1. `path` 为绝对路径；相对路径 → `OUTSIDE_ROOT`。
2. canonicalize（含符号链接）后必须以 `sessionsDir + "/"` 为前缀，
   且相对部分恰为两段 `<dir>/<file>.jsonl`，文件名不以 `.` 开头。
3. 不存在 → `NOT_FOUND`。

## 7. 错误码

| code | 含义 |
|---|---|
| `IN_USE` | 会话正被 omp 进程占用（flock 持有） |
| `PROBE_FAILED` | 占用探测本身失败（权限等），不敢断言空闲 |
| `CWD_MISSING` | 记录的 cwd 不存在（iTerm 打开前检查） |
| `NOT_FOUND` | 路径不存在 / 节点不存在（会话级） |
| `OUTSIDE_ROOT` | 路径逃出 sessionsDir 或形状非法 |
| `UNSUPPORTED_FORMAT` | 非 v3 会话（不可预览/建树）；文件末尾异常也用 `IO`（§4.7） |
| `INVALID_NODE` | nodeId 未知 / 非保留节点 |
| `IO` | 其他文件系统失败 |
| `ITERM_FAILED` | AppleScript / iTerm 调用失败 |
| `OMP_NOT_FOUND` | 未找到 omp 二进制（§4.9 除外） |
| `OMP_FAILED` | omp 非零退出或技能列表 JSON 无法解析；中文摘要（非零退出附输出末约 500 字） |
| `BUSY` | 另一个 omp 写操作正在进行 |
| `TIMEOUT` | omp 执行超过期限；已杀进程并回收，附部分输出末尾 |
| `INVALID_INPUT` | 用户输入不合法 |
| `CONFLICT` | 文件已被外部修改 |
| `META_CORRUPT` | 应用侧 `meta.json` 解析失败或版本不兼容（§15.3；绝不覆盖，UI 禁用保存） |
| `INVALID_KEY` | 配置键不在模型配置白名单内（§16.1；仅 `update_model_config` 产生，绝不调用 omp） |
| `UNKNOWN` | **仅前端**：传输层或未预期失败的归一化（后端永不产生） |

`AppError { code, message }`；`message` 为中文人类可读。

## 8. 类型文件

- `src-tauri/src/model.rs`：serde 权威定义（含 `AppResult<T>` 与 8 个
  序列化单测）。`Option` 字段序列化为 null（不明缺省，保持全字段）。
- `src/types.ts`：逐字段镜像（`Option<T>` → `T | null`，
  `u64/usize` → `number`，`Value` → `unknown`）。
- `src/api.ts`：每命令一函数 + `normalizeError`。
  后端 `invoke` 拒绝值即 `AppError` 形状；未知形状降级 `UNKNOWN`。
- 后端模块布局（`src-tauri/src/`）：`util.rs`（共享小工具）、
  `config.rs`（配置解析 + 路径校验）、`lock.rs`（flock 占用探测）、
  `occupant.rs`（占用归属识别）、`sessions/`（`parse` 解析 + 树索引、
  `list` / `conversation` / `tree`）、`ops/`（删除 / 标记 / iTerm /
  目录选择）、`omp_cli.rs`（omp 路径解析 / 安全 runner / 版本与更新）、
  `omp_plugins.rs`（用户级插件 / marketplace / registry 技能）、
  `omp_models.rs`（模型与 Agent 白名单配置）、`history.rs`（recap /
  提示词历史只读）、`cleanup.rs`（清理候选）、`meta.rs`（别名/标签/备注）、
  `menubar/`（托盘菜单 / 检测 / 聚焦 / 通知 / 设置）、`mcp_config.rs`
  （MCP 原生配置读写）、`memory/`（记忆库浏览 + 备份/删除/恢复，见 §18）、
  `model_bench.rs`（模型测速与历史）、`model_specs/`（`mod` / `yaml` /
  `validate` / `io` / `tests`，规格编辑，见 §21）、`usage/`（`mod` /
  `cache` / `parse` / `window` / `stats` / `health` / `redact` / `tests`，
  用量与运行看板，见 §12）、`stage/`（`mod` / `cursor` / `actor_tail` /
  `derive` / `tests`，Agent 舞台，见 §23）。

## 9. 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `MAX_TEXT_BYTES` | 8000（UTF-8 字节，字符边界截断，尾加 `…[已截断]`） | toolResult / bashExecution 文本 |
| `TITLE_FALLBACK_CHARS` | 60（含尾 `…`，总长 ≤60） | 无标题时首用户消息截断 |
| `FIRST_USER_MESSAGE_CHARS` | 200（含尾 `…`） | `firstUserMessage` 字段 |
| `OTHER_TEXT_CHARS` | 2000（含尾 `…`） | `other` 条目文本 |
| `TREE_PREVIEW_CHARS` | 80（含尾 `…`，总长 ≤80） | 树节点 preview |
| `MARKER_CUSTOM_TYPE` | `omp-resume-branch` | 分支标记 customType |
| `UNTITLED` | `(无标题)` | 无标题兜底 |
| `MEMORY_SNIPPET_CHARS` | 240（空白折叠后字符数，字符边界截断，超长尾加 `…`） | 记忆列表 snippet |
| `MEMORY_CONTENT_CAP_BYTES` | 204800（200KB，UTF-8 字节，字符边界截断） | `memory_detail` 全文上限 |
| `MEMORY_LIST_LIMIT` | 默认 50，钳制 1..=200 | `memory_list` 分页 |
| `MEMORY_DETAIL_FACTS_LIMIT` | 50 | `memory_detail` facts 上限 |
| `MEMORY_DELETE_IDS_MAX` | 500（去重后计数，超 ⇒ `INVALID_INPUT`） | 单次删除 id 上限 |
| `MEMORY_BACKUP_KEEP` | 5（`before-delete` / `before-restore` 按 bank+kind 留存） | 备份自动修剪 |

## 10. 打包要求

- `productName`/窗口标题 `omp-resume`，`identifier com.chenjing.omp-resume`，
  窗口 1200×800、最小 900×600，包管理器 npm。
- `src-tauri/Info.plist` 含 `NSAppleEventsUsageDescription` =
  `omp-resume 需要控制 iTerm 来打开 omp 会话`；
  Tauri 会自动合并与 tauri.conf.json 同目录的 `Info.plist`
  （`bundle.macOS.infoPlist`，见 @tauri-apps/cli 的 config.schema.json），
  发布后必须在 `.app` 的 Info.plist 里验证。
- `npm run tauri build`（不签名）产物
  `src-tauri/target/release/bundle/macos/omp-resume.app` 可启动。
- 打包目标 `targets: ["app","dmg"]`（`bundle.targets`）。
  CSP（`app.security.csp`）：`default-src 'self' customprotocol:; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' asset: data: https: http:; font-src 'self' data:; connect-src ipc:
  http://ipc.localhost`（dev 另有 `devCsp` 放行 localhost，见 `tauri.conf.json`）。

## 11. 纯前端功能（无后端命令）

（已删除：以代码为准）

## 附录 A. 真实条目示例（节选，已脱敏截断）

title 首行（注意无 `source` 的变体存在）：

```json
{"type":"title","v":1,"title":"","updatedAt":"2026-10-12T07:38:04.760Z","pad":"   ..."}
{"type":"title","v":1,"title":"🎛️ DEMO: Build a visual config desktop app","source":"auto","updatedAt":"2026-10-14T02:33:40.897Z","pad":"   ..."}
```

fork 血缘 header（`parentSession` 为 id，`previousSessionFiles` 为路径数组，
二者语义不同）：

```json
{"type":"session","version":3,"id":"01a134fa-...","timestamp":"...","cwd":"/Users/demo/my","title":"🚂 DEMO2: ...","titleSource":"auto","parentSession":"01a134a7-...","providerPromptCacheKey":"01a134a7-..."}
{"type":"session","version":3,"id":"01a12ecf-...","timestamp":"...","cwd":"/Users/demo/my/notes-app","title":"🦙 DEMO3: ...","titleSource":"auto","previousSessionFiles":["/Users/demo/.omp/agent/sessions/-my-demo-project/2026-10-12T06-31-48-446Z_01a12ecf-....jsonl"]}
```

assistant（含 thinking + toolCall 块）与 toolResult 紧邻对：

```json
{"type":"message","id":"25472e7f","parentId":"27f428d0","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","thinkingSignature":"...","summary":false},{"type":"toolCall","id":"call_1a9b...","name":"read","arguments":{"path":"...","i":"..."},"partialArgs":"..."}],"stopReason":"stop",...}}
{"type":"message","id":"0b708322","parentId":"eca87a7f","timestamp":"...","message":{"role":"toolResult","toolCallId":"call_1a9b...","toolName":"read","content":[{"type":"text","text":"# Clash Verge ..."}],...}}
```

bashExecution（无 content 数组）与 developer：

```json
{"type":"message","id":"205852e4","parentId":"55e13298","timestamp":"...","message":{"role":"bashExecution","command":"cd /Users/demo/my/notes-app","output":"","exitCode":0,"cancelled":false,"truncated":false,"timestamp":1791793713325,"excludeFromContext":false}}
{"type":"message","id":"b62be44d","parentId":"9ce3ff0f","timestamp":"...","message":{"role":"developer","content":[{"type":"text","text":"<system-reminder>..."}],"attribution":"agent","timestamp":1791789697264}}
```

`custom` 插行（assistant→toolResult 之间）与 `custom_message`：

```json
{"type":"custom","customType":"tool_execution_start","data":{"toolCallId":"toolu_01U6...","toolName":"read","startedAt":"...","args":{"path":"skill://grilling"},"intent":"..."},"id":"27553b59","parentId":"3e16c00b","timestamp":"..."}
{"type":"custom_message","customType":"tool-roster-notice","content":"<system-notice>...","display":false,"details":{"added":[...],"removed":[...]},"attribution":"agent","id":"210f1b9a","parentId":"280bb23c","timestamp":"..."}
```

`title_change` / `mode_change` / `model_usage` / `reset_boundary` /
`credential_pin` / `service_tier_change`：

```json
{"type":"title_change","id":"faaa7038","parentId":"7ba2b395","timestamp":"...","title":"🏠 DEMO4: 修复示例代理连接失败","source":"auto"}
{"type":"mode_change","id":"e7d1631d","parentId":"a569a3be","timestamp":"...","mode":"vibe","data":{...}}
{"type":"model_usage","id":"a569a3be","parentId":"b97bd9bd","timestamp":"...","purpose":"memory","role":"memory","api":"openai-completions","provider":"5438","model":"deepseek-v4.1-flash","usage":{...},"stopReason":"stop"}
{"type":"reset_boundary","id":"816d2e46","parentId":"b6c7e33f","timestamp":"..."}
{"type":"credential_pin","id":"5f721855","parentId":"daff6acd","timestamp":"...","provider":"factory-droid","hash":"f70dd73b..."}
{"type":"service_tier_change","id":"93a74675","parentId":"d0600012","timestamp":"...","serviceTier":null}
```

## 附录 B. 未验证 / 待实现注意

已移至 DECISIONS.md D1

## 12. 用量与花费统计（只读，omp 18.11.1）

本节定义用量/花费与运行看板能力；不改动既有会话浏览、树与写命令语义。
不调用 LLM，不启动 omp，不读取 models.yml / models.json 或其他凭据；绝不写入会话 JSONL。

### 12.1 命令与类型

- `get_session_usage { path: string } -> SessionUsage`：沿用 §6 顶层路径校验，
  返回此会话归属的全部历史（非 active 路径），包含 sibling 附件目录内递归的子代理 JSONL。
- `get_usage_stats { range: UsageRange } -> UsageStats`：`UsageRange` =
  `"today" | "24h" | "7d" | "30d" | "all"`；UI 花费页默认 `30d`。窗口按**本机时区**：
  `today` 本地当天 0 点至今；`24h` 当前本地整点绝对时间 −23 小时起的 24 个整点桶
  （含当前小时；起点由请求时刻的绝对时间直接截断整点，不经本地→UTC 反查）；
  `7d` 今天及前 6 天、`30d` 今天及前 29 天（均自首日 0 点起）；`all` 不限。
  固定窗口为 **[起点, now] 闭区间**（`now` 为请求时刻，未来时间戳一律排除），
  按**每条消息/后台调用自身时间**比较，不是按文件 mtime；
  固定窗口的起点恒为有界绝对时间（仅 `all` 不限）：午夜落在 DST 缺口时取缺口后
  第一个存在的时刻，重复整点（秋季回拨）按绝对时间取请求时刻所在的一次。
- `get_usage_health { range } -> UsageHealth`：运行看板（口径见 §12.3），
  窗口与分桶规则同 `get_usage_stats`；UI 看板默认 `today`。
- `UsageTokens { input, output, cacheRead, cacheWrite, total }`：非负整数；
  total 优先使用 usage.totalTokens，缺失则四项相加；reasoningTokens 不重复加到输出或总数。
- `UsageCost { total, main, background, subagent }`：USD 浮点数，
  total = main + background + subagent；直接用上游 usage.cost.total，缺失则 cost 四项相加，
  无 usage 时为 0，不读取价目表、不自行估价。
- `UsageMessages { user, assistant }`：归属后全历史中对应角色的消息数（含子代理），
  toolResult / custom / developer 不计消息数；model_usage 不是 assistant 消息。
- `UsageModel { provider, model, messages, cost, tokens, tps?, ttftMs? }`：provider/model 缺失为空字符串；
  messages 为 assistant + model_usage 的调用条数（包括无 usage 的 assistant）。
  `tps`/`ttftMs` 为该模型速度（`SessionUsage.models` 沿用同结构，无样本时字段缺省）：
  速度 = Σoutput ÷ Σ(duration−ttft)，只取非 error/aborted 且 duration/ttft 均有效、
  duration ≥ ttft ≥ 0 的调用；tps 分子再要求 gen ≥ 500ms 且 output ≥ 16，
  无样本时为 null。统计含子代理调用（主对话+嵌套）。
- `SessionUsage { messages: UsageMessages, tokens: UsageTokens, cost: UsageCost, models: UsageModel[] }`。
- `UsageStats { total: SessionUsage, byProject: UsageProject[], byModel: UsageModel[],
  trend: UsageTrend, sessions, timing: UsageTiming, topSessions: UsageSession[], activity: UsageTrendPoint[] }`；
  `UsageProject { cwd, cost, tokens, sessions }`，sessions 为范围内有归属条目的顶层会话数。
  cwd 取顶层 owner 的 header.cwd。项目/模型按花费降序（相同时按名称）。
- `sessions`：范围内有归属条目的顶层会话数（含只有 user 消息的会话），与各项目 sessions 之和恒等。
- `UsageTiming { waitMs, genMs, toolMs, toolCalls, calls, tps }`：**仅主对话**（子代理与主对话并行，
  累加会超过挂钟时间）。waitMs/genMs 为 assistant 自报 duration/ttft 的累加
  （round 到毫秒；无效值跳过）；calls 为带有效 timing 的主对话调用数（含 error/aborted）；
  toolCalls 为紧随主对话助手的 toolResult 行数；tps 与模型速度同口径（经 500ms/16 输出过滤，
  故与简单 calls 不成简单比例）；toolMs = 上一条 `stopReason=="toolUse"` 助手的 completedAt
  到下一条助手 timestamp 的间隔累加：间隔超过 10 分钟视为闲置不计；中间出现 user 消息
  则该间隔不计（含人的思考时间）；completedAt 缺失时该次为 0。
- `UsageSession { id, path, cwd, cost, tokens, calls, lastMs }`：topSessions 为范围内 cost > 0 的
  顶层会话，按 cost 降序、再 lastMs 降序、再 path 升序，取前 8；cost/tokens/calls/lastMs 均为范围内累加，
  calls 只计 assistant 条目，path 为顶层会话绝对路径。
- `activity`：近 182 天（含今天）的日花费点，复用 `UsageTrendPoint`，稠密 182 项升序、
  缺桶补零，**不受 range 影响且只收带合法时间戳条目**（model_change 不进）。end 为请求时刻 now，
  故末桶只收 now 之前的数据。
- `UsageTrend { unit: "hour"|"day", points: UsageTrendPoint[] }`；
  `UsageTrendPoint { key, cost, tokens }`：today/24h 为 hour 桶（key 为本地时区
  `"YYYY-MM-DD HH"`），其余为 day 桶（`"YYYY-MM-DD"`；本节桶 key 例外于 §0 的
  UTC 时间字符串规则）。升序；固定窗口（today/24h/7d/30d）补零到窗口内每个桶，
  `all` 只含有数据的日期。不变量：固定窗口下 `sum(points.cost) == total.cost.total`。
  `model_change` 不进趋势（也不产生花费/消息数）。
- 无合法时间戳的条目只进 `all` 的总计与项目/模型表；带窗口的范围统计、趋势、
  时间线与 recent 列表一律不纳入。

### 12.2 口径与 fork 归属

以下归属与去重口径对 `get_usage_stats` 与 `get_usage_health` 同样适用。

1. 顶层主文件 `message.role=assistant` 的 usage.cost →「主对话」。
2. **所有 `model_usage`（含嵌套文件里的）→「后台」**。
3. sibling 目录递归 JSONL 的 assistant usage.cost →「子代理」；
   这些文件只作为所属顶层会话的成本来源，不额外生成统计会话。
4. 不从 task / 其他工具的 toolResult、文本、details、progress 里提取任何 cost，
   因为那是工具状态/转述而非独立模型账单；账单只认以上两种条目形状。
5. **绝不全局按 8 位 entry id 去重**。仅沿 header.parentSession 的可解析、仍存在的 fork 祖先链找复制来源。
   parentSession 可为已扫描会话 id 或会话路径；previousSessionFiles 是迁移指针，不建立 fork 边。
   同 id 且时间、parentId、角色/类型、provider/model、tokens/cost 一致才确认复制，
   条目归链上最早的仍存在会话（父文件正常计，子文件跳过）。链外同 id 各自计入，
   链内同 id 但内容不符也视为无法确认来源而计自身。
6. 父文件删除 / 无法解析 / 不在安全扫描集合 / 血缘成环 / 时间缺失，无法确认来源则计自身；
   祖先中间文件已删时不猜测跨过它的血缘。统计筛时间之前先确定归属，避免 fork 复制重复入账。
7. 只支持 header.version=3，详情非 v3 报 `UNSUPPORTED_FORMAT`，前端静默隐藏；
   统计忽略非 v3 顶层会话及其附件。坏 JSON、非 UTF-8 行、形状/字段类型损坏行跳过；
   合法 user/assistant 无 usage 仍计消息数、tokens/cost 为 0。

### 12.3 `get_usage_health` 运行看板

窗口、分桶、补零/clamp 与 fork 归属口径同 §12.1/§12.2；请求、错误、兜底、缓存
统计前均先经 `inherited()`（id + timestamp + parent + 全字段相等才认复制）去重，
与 stats 复用同一次 scan。

- `requests`：窗口内 assistant 消息（含子代理文件、含 stopReason 为 `error` /
  `aborted` 的）+ `model_usage` 后台调用条目。
- `errors`：`total` **只计** assistant 消息 `stopReason == "error"`；`model_usage`
  的 stopReason/errorMessage 不计错误（只计 requests）。`aborted`（stopReason
  `"aborted"`，用户中断）单独计，**不含入** `total` / `byKind` / `recent`。
  `byKind: [{kind, count}]` 按 count 降序（同数按 kind 名升序）；`recent` ≤20 条、
  新→旧、仅含有效时间戳条目，字段 `time`(epoch ms) / `provider` / `model` / `kind` /
  `message`（单行、按字符截断 200；Bearer / Authorization 凭证、api_key /
  apikey / token / secret / password 类键值、sk- / ghp_ / github_pat_ /
  xox[bpas]- / AKIA / AIza 等密钥前缀、JWT 三段形态、≥32 位无特征长串一律
  替换为 `[已脱敏]`）。
- **ErrorKind**（7 值）：`quota | rate_limit | auth | timeout | network | server | other`。
  分类为启发式：错误原文小写后**先命中先赢**，顺序 quota → rate_limit → timeout →
  auth → network → server → other：
  quota = 行首 `402`，或 usage limit / quota / payment / subscription / billing /
  insufficient / out of credit（403 报文含 payment 同归 quota；「Retry budget」
  是重试预算耗尽，不归 quota）；rate_limit = 行首 `429` 或 rate limit /
  too many requests；timeout = timed out / timeout / stalled / deadline exceeded /
  stream_timeout / etimedout；auth = 行首 `401`/`403` 或 unauthorized /
  invalid api key / forbidden 等；network = econn* / connection / socket / fetch /
  tls / certificate / stream was interrupted / closed before /
  ended before completion 等；server = 行首 5xx 或 server_error / upstream /
  unavailable / internal error / overloaded / try again later 等；未命中一律 other。
- `fallbacks`：判定 = `type=="model_change"` 且 `role=="fallback"` 且
  `resolvedModelIsFallback==true`（role 缺失 / `temporary` / `default` / `subagent:*`
  或 resolved=false 均不计）。`to` 为该条 `model` 按**首个** `/` 拆出的
  provider / model；`from` 为同一文件内此前最近一次 model_change（任意 role）或 assistant
  消息所用模型，二者合并取最近；找不到为 `null`（该预查不过滤窗口、不做去重：
  它描述切换瞬间此前生效的模型）。`byTarget` 按 count 降序（同数按 provider/model
  升序）；`recent` ≤20 条、新→旧、仅含有效时间戳条目。
- `cache`：`hitRate = cacheRead / (input + cacheRead + cacheWrite)`（窗口内
  assistant + model_usage 的 token 累加）；分母为 0，或 `cacheRead + cacheWrite`
  全为 0（上游不报缓存）时为 `null`（界面显示「—」而不是 0%）；`read` / `write` /
  `input` 为累计值；`byModel: [{provider, model, requests, hitRate|null}]` 按
  requests 降序（同数按 provider/model 升序），口径相同。
- `timeline: { unit, points: [{ key, requests, errors, fallbacks, cacheRead,
  promptTokens }] }`：unit / 桶 key / 补零 / 升序 / clamp 同 §12.1 的 trend；
  `promptTokens = input + cacheRead + cacheWrite`；`errors` 只计 `"error"`
  （不含 aborted）；界面按 cacheRead/promptTokens 逐桶算命中率，promptTokens=0
  的桶断线、不画 0。
  - 已知风险：DST 跳变导致桶 key 落到预设范围外时，由首/末桶 clamp 保住分桶合计
  等于总计的不变量；固定窗口起点恒有界（缺口前跳、重复取绝对时间），不会因
  DST 静默变成全量；错误分类是启发式，未见过的新报文落入 other。

### 12.4 前端（统计视图）

侧栏视图切换条「统计」→ `StatsView`，两个标签页（手写 SVG 图表，无新增依赖）：

- 「总览」（默认范围 `today`）：范围分段（今天 / 近 24 小时 / 近 7 天 / 近 30 天 /
  全部，激活态为 `--accent-soft` 底 + `--accent` 描边）+ 刷新；6 张 KPI 卡、
  花费/Token 可切换趋势柱状图（按 `trend.unit` 画 hour/day 桶；该范围内全为 0 时
  不画空坐标系，改显示「花费/Token 在该范围内为 0」）、Token 与耗时构成环、
  活跃度卡片（独占一行：热力图 + 右侧四格汇总「活跃天数 / 合计花费 / 最高单日
  （同价取最早）/ 连续活跃天数」，图例在卡片头右侧；近 26 周按日花费，不受上方范围影响）、
  高花费会话榜（独占一行）、「按项目」「按模型」表（花费、token、会话数 /
  调用次数，行内占比条）。所有 `.health-card` 标题统一 14px（`.card-head > h2` 也吃到）。
- 「运行看板」（默认范围 `today`；KPI：请求数（含失败与用户中断）、错误数 + 错误率（`errors.total /
  requests`，另注「另有 N 次用户中断」）、兜底切换次数、缓存命中率（`null` 显示「—」
  并注明「该上游未返回缓存数据」）；请求趋势（错误/兜底叠加）、缓存命中率趋势、
  错误类型分布（中文：额度用尽 / 触发限流 / 鉴权失败 / 响应超时 / 网络异常 / 服务端错误 / 其他）、
  兜底去向（含最近切换）、最近错误、按模型缓存命中。
- 图表悬停（`UsageCharts.tsx` 的 `ChartBucket` 统一包装）：每桶 = 可见图形 + 竖向虚线
  `line.chart-guide`（默认 `opacity: 0`，仅悬停该桶时 0.55）+ 透明全高热区 `rect.chart-hit`
  （承 `data-tip`，`pointer-events: all`；图形本身 `pointer-events: none`，避免细柱/圆点抢命中）。
  悬停反馈：热区填 `--accent-soft` 并描 `--accent` 边框、柱 `filter: brightness(1.15)`、
  折线圆点 `r` 2.5→5、兜底圆点 `r` 3→4，全部 `var(--motion)` 过渡；提示浮层由全局 `ChartTip` 渲染。
- 每个标签页各自记住范围；两个面板数据独立请求（范围/刷新按钮各自一套），
  迟到响应不覆盖当前结果；已加载过的「范围」再切回时命中缓存不再请求（必须同时
  复位加载态，否则刷新按钮会永久禁用）；**换范围时立刻不显示上一个范围的数据**
  （命中过的范围用该范围缓存顶上，没命中过则清空并显示加载文案）；同范围刷新
  （refresh nonce 变化）保留旧数据，避免闪空；加载 / 空数据 / 错误与重试状态与既有视图同风格。

### 12.5 IO、缓存与错误

逐行复用 buffer，以 serde 最小字段结构解析，content/details 等直接跳过，不构造完整 Value 树。
三个命令的阻塞扫描均在 spawn_blocking；`get_usage_stats` 与 `get_usage_health`
复用同一次扫描（解析产物同进 UsageCache）。进程内缓存只保存解析结果与索引，不落盘：
key 为每个文件的 canonical path + mtime（纳秒精度）+ size + ctime + inode。
每次请求重新枚举全部顶层/嵌套 JSONL 并检查各文件 metadata（比「目录最新 mtime + 文件数」更严格，
能覆盖旧嵌套文件追加、删除/新建及同尺寸替换），读前/读后 metadata 不一致的解析不入缓存。
运行中的会话持续追加时下次调用必失效；这是读取过程的快照，不声称跨文件事务一致性。
目录/文件软链接不跟随；子文件 canonicalize 后必须仍在会话根及其 owner sibling 目录内。
失效路径 `NOT_FOUND`、顶层路径不合法/逃逸 `OUTSIDE_ROOT`、其他 IO 失败 `IO`；
详情所有失败静默隐藏，统计与运行看板均有加载/空数据/错误与重试状态。

### 12.6 真实数据只读调查（2026-10-16）

已移至 DECISIONS.md D2

## 13. 新开会话与会话概要 / 提示词历史（本次追加）

### 13.0 `new_session_in_iterm { cwd } -> ()` 与 `choose_directory() -> string | null`

**硬性不变量**：应用内不做聊天、不调用任何 LLM；新开会话**绝不带 prompt、
不自动发送任何内容、不带任何参数**，只执行 `omp`。

- `new_session_in_iterm { cwd }`：
  - `cwd` 必须为**存在的绝对目录**，否则 `CWD_MISSING`
    （不存在 / 是文件 / 相对路径同一错误码，与现有 §4.8 一致）。
  - `cwd` 含控制字符（换行等）→ `INVALID_INPUT`：AppleScript 字符串字面量
    转义会**静默剥离**控制字符（§4.8 的 fail-safe 策略），若不拒绝，
    `cd` 目标会与实际目录不一致。
  - 行为：复用 §4.8 的 iTerm 原语（无窗口开新窗口、未运行先启动、当前窗口开新 tab），
    在该 tab 执行 `cd '<cwd>' && omp`（POSIX 单引号转义 `'` → `'"'"'`，
    再经 AppleScript 字符串转义）。命令跑完 shell 保留，用户可继续交互。
  - 失败 → `ITERM_FAILED`（复用 §4.8 的 osascript 错误映射与自动化授权指引）。
  - 实现：纯逻辑层 `ops::commands::new_session_in_iterm_impl(cwd, opener)`
    （opener 可注入，生产传 `ops::iterm::open_tab`）；命令构造纯函数
    `ops::iterm::new_session_command`。
- `choose_directory() -> string | null`：
  - `osascript -e 'POSIX path of (choose folder with prompt "选择项目目录")'`
    （不新增依赖、不改 capabilities）。
  - **用户取消（osascript 错误 -128）返回 `null`，不是错误**；
    其他 osascript 失败 → `IO`。
  - 返回值去掉尾部换行与末尾斜杠；根目录保留 `/`。
  - 纯函数 `ops::picker::parse_choose_output` 负责解释结果。
- 前端：侧栏顶部强调色「新会话…」按钮 → `choose_directory` → 有结果则
  `new_session_in_iterm`；项目分组头「+」按钮（hover/focus 显示，
  与置顶按钮并排，tooltip「在此项目新会话」）直接用该组 `cwd`。目录不存在时禁用。
  成功 / 失败提示沿用「在 iTerm 继续」的 toast 处理。
  `api.ts`：`newSessionInIterm(cwd)` 与 `chooseDirectory()`。

### 13.1 `get_session_recap { sessionId } -> string | null`

- 数据源：`$HOME/.omp/agent/history.db`，可用环境变量
  `OMP_RESUME_HISTORY_DB` 覆盖（供测试）。
- **只读**（`SQLITE_OPEN_READ_ONLY`）：不写、不 checkpoint、不创建库文件。
- 取该会话最新一条 recap：`session_recaps` 按 `created_at DESC, id DESC LIMIT 1`。
- 库不存在 / 表列对不上 / 任何 SQL 错误 / 结果空白 → `null`，**静默**
  （功能隐藏，不报错；与 §3.1 占用归属同样的降级方式）。
- 前端：`RecapBlock.tsx` 挂载在详情页会话头（DetailPane 内一行）；
  无 recap 不渲染；默认折叠 3 行（CSS line-clamp），可展开 / 收起。

### 13.2 `search_prompt_history { query? } -> PromptHistoryEntry[]`

- `PromptHistoryEntry { id: i64, prompt: string, cwd: string|null,
  sessionId: string|null, createdAt: string, useCount: i64 }`（JSON camelCase）。
  `cwd` / `sessionId` 为空串或 NULL → `null`；`createdAt` 为 ISO-8601 UTC 毫秒
  （由 `history.created_at` 秒级 epoch 转换，§0 时间约定）。
- 排序：`created_at DESC, id DESC`。返回上限固定 200（`history.rs` 的
  `DEFAULT_SEARCH_LIMIT`，无 `limit` 参数）。
- `query`：**大小写不敏感 LIKE 子串**匹配（空白 / 缺省 = 不过滤），
  转义 `\` `%` `_` 并配 `ESCAPE '\'`。**不使用 `history_fts`**
  （FTS5 默认分词器不切 CJK；约 425 行规模 LIKE 足够）。
  注意 `LIKE` 的大小写不敏感仅对 ASCII 生效（CJK 本无大小写）。
- 库不存在 / 表列对不上 / 任何 SQL 错误 → 空列表，**静默**。
  单行时间戳缺失或越界 → 跳过该行，不影响其他行。
- 实测（omp 18.11.1，2026-10-16）：`history` 429 行、`session_recaps` 110 行
  覆盖 39 个会话；库为 WAL 模式。只读查询前后 `history.db` 主文件
  大小与 mtime 不变，`-wal` / `-shm` 亦无变化。
- 前端：侧栏视图切换条「提示词历史」→ `PromptHistoryView.tsx`：搜索框（200ms 防抖）
  + 列表（prompt 截断 2 行、cwd 末段、相对时间、使用次数），每条三个动作：
  「复制」（`clipboard.ts`）、「跳到来源会话」（**仅当 sessionId 命中当前已加载
  会话列表时可用**，否则禁用，选中该会话）、「在该目录新会话」
  （调用 §13.0 `new_session_in_iterm`；`cwd` 为 null 时禁用；**绝不携带 prompt**）。

## 14. 清理候选（只读，`list_cleanup_candidates`）

> 目标：帮用户找出**可以安全清理**的历史会话。本命令**纯只读**——
> 不删除、不修改、不移动任何文件，也不写 omp 自己的库。
> 真正删除仍然只有一条路径：§4.6 `delete_sessions` + 前端 DeleteDialog
> （占用拒绝、逐条独立失败、路径限定在会话根目录内）。

### 14.1 命令与类型

`list_cleanup_candidates { olderThanDays, topN } -> CleanupCandidate[]`

- `olderThanDays: u32`（`stale` 阈值，天）；`topN: u32`（`large` 名额）。
  `olderThanDays < 1` → `INVALID_INPUT`。阻塞 IO 在 `spawn_blocking` 内。
- `CleanupCandidate { path, id, title, cwd, mtime, bytes, reasons, inUse, probeOk }`
  （camelCase）：`mtime` 为文件 mtime（ISO-8601）；`bytes` 为**删除将释放的
  总字节**；`reasons: CleanupReason[]`；`inUse` / `probeOk` 来自 §3 的 flock 探测。
- `CleanupReason`（snake_case）：`empty` | `cwd_missing` | `large` | `stale`。
- 结果**按 `bytes` 降序**（同值按 path 升序）。无候选时返回空数组（不报错）。

### 14.2 判定规则（命中任一即候选；原因可叠加，顺序固定为 empty → cwd_missing → large → stale）

| 原因 | 判定 | 说明 |
|---|---|---|
| `empty` | 整个文件没有任何 `message.role == "user"` 条目 | **仅 v3 可判定**；非 v3 不标 |
| `cwd_missing` | header 的 `cwd` 缺失或不是可进入目录 | 与列表 `cwdExists` 同一判定 |
| `large` | 总字节跨全部会话排名前 `topN` **且** ≥ 5 MiB（`LARGE_MIN_BYTES`） | 先按字节排序再取前 N，不足 N 或低于下限的不标 |
| `stale` | 文件 mtime 早于 `now - olderThanDays` 天 | mtime 取文件系统值 |

- `bytes` = `<file>.jsonl` + 同 stem sibling 目录（**递归**，不跟随符号链接）
  + `<file>.jsonl.*.bak`（与 §4.6 的删除集合一致）。sibling 若是普通文件则
  **不计入**（删除时不动它）；不可读的子目录按 0 计（尽力而为，不让整个列表失败）。
- 扫描范围与列表一致（§2.1：各项目目录顶层非点文件 `*.jsonl`；符号链接目录/
  文件一律忽略），因此 `path` 恒在会话根目录内。
- 解析为**流式单遍**：逐行反序列化到只含所需字段的结构体（serde 跳过其余字段），
  不构造整文件 `Value` 树；仅首个 user 消息文本会额外解析一次。坏行跳过。
- 标题取 `title` 记录 → header → `title_change` 的最后非空值，全空则用首个
  user 消息文本（截断 `TITLE_FALLBACK_CHARS`），仍无可用的为 `(无标题)`。
  简化点：不走 active 路径（与 §4.2.1 在「有 fork 分支」时理论上可能不同）。

### 14.3 占用语义（与写操作门禁一致）

- 被 flock 持有的会话**仍然列出**，但标 `inUse: true`；探测失败标 `probeOk: false`。
- 二者在 UI 中**都不可勾选**（分别显示「占用中」「占用未知」），
  与 §4.6 的 `IN_USE` / `PROBE_FAILED` 拒绝规则一致：宁可拒绝也不猜。

### 14.4 前端

- 侧栏视图切换条「清理」（与「管理」「统计」同条）→ 主区域 `CleanupView`：
  「超过 N 天 / 体积前 N 名」两个数字输入、排序分段「体积倒序 / 体积正序」
  （`sortCandidates`，同体积按 path 升序，与后端返回顺序无关；勾选集合按 path，
  换序不丢选中）、候选表格（标题、cwd 末段、原因标签、
  体积、修改时间、复选框、「查看」）、顶部「已选 X 个，可释放 Y」、
  「全选可勾选项」与「删除所选…」。
- **视图返回**：`App` 持有视图栈（`sessions` 为根），侧栏切换是「进入」，再点同一按钮或视图内的
  「返回」/`Esc` 是「退回上一级」——不是一律回到会话页。打开对话框或抽屉时 `Esc` 先关它们，
  不触发返回。每个视图头部都有一枚 `返回` 按钮（`PromptHistoryView` 也补了头部）。
- 「删除所选…」**复用** App 的既有批量删除编排与 DeleteDialog：
  清理视图不新增任何删除路径；删除后刷新会话列表与候选（`refreshToken`）。
- 「查看」仅在会话出现在当前已加载列表时可点（否则禁用并说明原因——
  例如「无标题且零用户消息」的会话被 §4.2 隐藏）。

### 14.5 真实数据只读回归（2026-10-16）

已移至 DECISIONS.md D3

## 15. 会话别名 / 标签 / 备注（应用侧 meta.json）

> 只存应用侧，**绝不写会话 .jsonl 或 omp 的任何文件**。
> `/resume` 里仍显示原标题（预期代价），UI 用小号灰字区分「别名」与「原标题」。

### 15.1 文件格式与存储

- 路径：`$HOME/Library/Application Support/omp-resume/meta.json`；
  环境变量 `OMP_RESUME_DATA_DIR` 可覆盖数据目录（测试/开发用）。
  目录不存在时创建。
- 格式：`{"version":1,"revision":N,"sessions":{"<sessionId>":{"alias":"…","tags":["…"],"note":"…","updatedAt":"ISO"}}}`。
  以**会话 id** 为键（不用路径——路径含时间戳）。`updatedAt` 为 ISO-8601 UTC 毫秒。
  文件不存在 = `revision 0`、空 `sessions`。
- 写入：同目录独占创建临时文件（`O_CREAT|O_EXCL`）→ 写 → 同步 →
  复检 revision → `rename` 原子替换；新文件权限 `0600`
  （已有文件保留原权限位；实现复用 `mcp_config.rs` 的写法）。
  失败时临时文件自动清理。
- 并发：同进程内 `set` 与删除联动清理共用一把进程级互斥，覆盖
  重读 → 比 revision → 改 → 写的全过程；跨进程无锁，靠 revision 复检
  降低竞态概率（与 §4.35 同口径的已知限制）。
- 读：`get_meta` 不加锁（原子 rename 保证读到完整的新旧其一）。

### 15.2 命令

#### `get_meta() -> MetaSnapshot`

`MetaSnapshot { revision: number, sessions: Record<sessionId, SessionMeta> }`；
`SessionMeta { alias: string|null, tags: string[], note: string|null, updatedAt: string }`。

#### `set_session_meta { sessionId, meta, expectedRevision } -> MetaSnapshot`

- `meta: { alias?, tags, note? } | null`：`null` 或 trim 后全空（空 alias/空 tags/空 note）
  = **删除该会话条目**；否则新增/替换，`updatedAt` 更新为当前时间。
- 校验（trim 后）：`alias ≤ 80` 字符；单个 `tag ≤ 24` 字符、每会话 `≤ 10` 个、
  大小写不敏感去重（保留首次原文）、空标签丢弃；`note ≤ 2000` 字符。
  超限 → `INVALID_INPUT`（中文文案），文件不变。
- `expectedRevision != 当前 revision` → `CONFLICT`（「备注已被外部修改，请重新载入后重试」），文件不变。
- 成功后 `revision + 1` 并返回**完整新快照**。
- 值与现有条目完全一致时不写文件、不 bump revision（幂等保存）。

### 15.3 错误码

| code | 含义 |
|---|---|
| `INVALID_INPUT` | 会话 id 为空/过长，或 alias/tags/note 超限 |
| `CONFLICT` | `expectedRevision` 与当前 revision 不一致 |
| `META_CORRUPT` | meta.json 解析失败或 `version` 不兼容；**绝不覆盖**，UI 禁用保存 |
| `IO` | 其他文件系统失败（含写锁不可用） |

`META_CORRUPT` 为本节新增错误码（§7 表的扩展，`SCREAMING_SNAKE_CASE` 序列化）。

### 15.4 孤儿策略与删除联动

- **孤儿条目保持惰性**：会话在应用外被删除后，meta.json 里的条目在读取时
  原样返回（不显示在列表，因为没有对应会话），**绝不自动修剪**——
  换 `--sessions-dir` 或跑 fixture 时修剪会误删真实数据。
- 仅当**本应用**的 `delete_sessions` 删除成功时，联动清掉对应条目
  （在 `ops::commands::delete_one` 的成功路径上调用，best-effort：
  清理失败静默忽略，不让删除失败、不阻塞）；meta 文件损坏时跳过清理
  （删除结果不变，损坏文件原样保留）。删除后前端重新拉取快照同步 revision。

### 15.5 实测记录（2026-10-16，macOS arm64）

已移至 DECISIONS.md D4

## 16. 模型与 Agent 配置（§4.36–§4.38，追加章节）

> 管理视图「模型」「Agent」两个标签页的后端契约。三块 UI：模型角色
> （`modelRoles`）、Agent 表（`task.agentModelOverrides` / `task.disabledAgents` /
> `task.agentAdvisor` 三个键）、回退链（`retry.fallbackChains`）。
> 本章命令不聊天、不调用任何 LLM（唯一例外是 §20 的 `omp bench` 测速）；配置写入全部经 `omp config set`。

### 16.1 白名单与安全规则

- **只允许写 5 个 key**，其他 key 一律 `INVALID_KEY` 且**绝不调用 omp**：
  `modelRoles`（record：角色 → `provider/model[:thinking]`）、
  `task.agentModelOverrides`（record：agent → selector，值同上可带 `:thinking`）、
  `task.disabledAgents`（array：agent 名）、
  `task.agentAdvisor`（record：agent → `"on"` / `"off"`）、
  `retry.fallbackChains`（record：角色或 selector（可含 `provider/*` 通配） →
  有序 selector 字符串数组）。
- 另有 **3 个只读白名单 key**（仅布尔/枚举，无凭据，供全局兜底状态展示）：
  `retry.modelFallback`（boolean）、`retry.fallbackOn`（enum）、
  `retry.fallbackRevertPolicy`（enum）。可经 `omp config get <key> --json` 读取；
  **写入这 3 个 key 同样报 `INVALID_KEY`**（`update_model_config` 不接受），
  其他一切 key（含这三个的写入）都被拒绝且不调用 omp。读不到或形状异常时
  `ModelConfig.retryStatus` 对应字段为 null（UI 显示「未知」），不让读取失败。
- 绝不读取凭据文件（`~/.omp/agent/models.yml` / `models.json` 等，含明文 apiKey），
  绝不运行 `omp config list`（会输出 token 类设置）；`omp models --json` 本身
  不含凭据。任何 omp 输出都不写日志、测试输出不打印配置值。
  **唯一例外**：§21 模型规格编辑是经评审的刻意例外——只读写 models.yml 的
  非凭据规格字段（行级手术、不整体重排），凭据永不经 IPC/日志/错误文本。
- 不触碰 omp 自己的库（`~/.omp/agent/*.db`；唯一例外：§20.3 只读 `agent.db` 的 `model_perf` 表）；
  不读项目级 `.omp/agents`（仅 user scope）。
- record 整体读-改-写（omp 的 `config set` 不支持点号子键，实测
  `modelRoles.plan` → Unknown setting），**未被用户触碰的键与值原样保留**
  （包括不认识的角色 / agent / 回退链键、别名 `@smol`、已下线 selector）；
  删除某项 = 写不含该项的 record，没有 reset 按钮。

### 16.2 值形状校验（读宽松、写严格）

- 读取（`omp config get <key> --json` 取 `value`）：只校验外层形状
  （record 必须对象、array 必须数组），不符 → `OMP_FAILED`（点名 key）；
  内层条目**原样保留**（可能是非字符串脏值，UI 原样展示且未触碰不改写）。
- 写入：外层形状 + 内层全量校验 → 否则 `INVALID_INPUT`（点名 key）：
  `modelRoles` / `task.agentModelOverrides` 值必须是字符串；
  `task.agentAdvisor` 值必须 `"on"`/`"off"`；`task.disabledAgents` 必须是字符串数组；
  `retry.fallbackChains` 值必须是字符串数组。理由：omp 的 `config set` 实测
  只校验外层对象/数组（`{"a":1}`、`{"a":"b"}` 均可静默写入），内层垃圾由本应用拒绝。

### 16.3 / 4.36 `list_models() -> ModelInfo[]`

- 运行 `omp models --json`（60 秒超时，只读，不占写门禁；**绝不运行
  `omp models refresh`**）。每条取精简字段：
  `ModelInfo { selector, provider, id, name, thinkingLevels: string[],
  contextWindow: number|null, maxTokens: number|null, reasoning: boolean,
  input: string[], costInput: number|null, costOutput: number|null,
  costCacheRead: number|null, costCacheWrite: number|null }`（camelCase）。
  无 selector 的条目跳过；缺字段容忍为 null/空。坏 JSON → `OMP_FAILED`。
- 可能较慢（耗时数秒到十几秒不等，随机器/网络波动）：前端异步加载 + 进程内缓存
  （模块级，跨挂载复用）。缓存条目记录读取时 `models.yml` 的 revision（`get_model_specs`
  的字节 SHA256，读取先于 `list_models`）；「模型」/「Agent」页挂载与窗口重新聚焦时
  先对照当前 revision：不变沿用缓存，变化（外部手动增删 provider/模型）才重跑本命令；
  revision 读取失败沿用缓存；并发的非强制校验互斥，只启动一次 omp。
  「刷新模型列表」按钮强制重跑本命令。只覆盖 `models.yml`，不含 `models.json`、登录
  带来的目录变化。
  模型选择器按 provider 分组、可搜索；当前值不在列表（别名 / 已下线）时
  原样显示并标「未知值 · 保留」，用户不动就不改写。

### 16.4 / 4.37 `get_model_config() -> ModelConfig`

- 白名单 5 个 key 逐个 `omp config get <key> --json`（60 秒，只读不占门禁） +
  agent 默认值。返回（camelCase）：

  ```jsonc
  {
    "roles":            { "<角色>": "<selector[:thinking]>" },   // 原始 JSON 值
    "agentOverrides":   { "<agent>": "<selector[:thinking]>" },
    "disabledAgents":   ["<agent>"],
    "agentAdvisor":     { "<agent>": "on|off" },
    "fallbackChains":   { "<角色|selector>": ["<selector>"] },
    "agents": [{ "name", "description", "source": "builtin|user",
                 "defaultModel": ["<selector>"], "defaultThinkingLevel": "<级>|null" }]
  }
  ```

  record / 数组条目值类型不作强制（原样透传），外层形状见 §16.2。

- **agent「内置默认」读取顺序**（每条只取一处）：
  1. `~/.omp/agent/agents/<name>.md` 存在 → 以它的 frontmatter 为默认值；
  2. 否则取 `omp agents unpack --dir <临时目录> --json` 导出的内置定义
     （用完删除临时目录；结果按 omp 版本 + 二进制路径缓存在进程内存）。
  `~/.omp/agent/agents/` 下用户自建的额外 agent md 一并列出，`source:"user"`
  （UI 标「自定义」）；内置 agent 即使被用户文件覆盖默认值仍为 `source:"builtin"`。
  列表顺序：内置（按文件名序）在前，用户自建在后。目录不存在或单个文件读取
  失败 → 静默跳过该文件；`agents unpack` 失败 → `OMP_FAILED`。
- frontmatter 只解析 `name` / `description` / `model` / `thinkingLevel` 四个顶层键
  （手写轻量解析，不引 YAML 依赖）：`model` 支持字符串（`model: "@smol"`）、
  块列表（`model:` + `  - x`）与行内 `["a","b"]` 三种写法，统一归一为字符串数组；
  引号剥壳（双引号处理 `\\` `\"` `\n`，单引号处理 `''`）；其余键
  （tools/output 等嵌套结构）忽略。缺 name 用文件名兜底、缺 thinkingLevel 为 null。

### 16.5 / 4.38 `update_model_config { key, value, expected } -> UpdateModelConfigResult`

- `value` / `expected` 为任意 JSON 值；返回 `{ key, value }`（写后复读的新值）。
- 流程（整体持有 `OmpBusy` 单写门禁，多余的报 `BUSY`）：
  1. `key` 白名单校验 → 不在表内报 `INVALID_KEY`（不调用 omp）；
  2. `value` 形状校验（§16.2）→ 不符报 `INVALID_INPUT`（不调用 omp）；
  3. 复读该 key 现值，与 `expected` **深度比较**（对象按键集合、数组按顺序），
     不一致 → `CONFLICT`「配置已被外部修改，请刷新后重试」，不写入；
  4. `omp config set <key> <紧凑 JSON>`（60 秒超时；`require_success` 错误语义）；
  5. 写后再读校验并返回新值。
- 前端每块独立「保存 / 还原」+ dirty 状态（「还原」只还原本区块，见 §16.6）；保存只写值有变化的 key，
  逐 key 串行（Agent 表一次保存最多写 3 个 key，中途失败即停止并整体重载，
  已写入的 key 不回滚）；`CONFLICT` 提示「配置已被外部修改，请刷新」并重新载入。
- 错误码：`INVALID_KEY`（新）、`INVALID_INPUT`、`CONFLICT`、`BUSY`、`OMP_FAILED`、
  `TIMEOUT`、`OMP_NOT_FOUND`、`IO`（语义同 §7）。`INVALID_KEY` 仅本命令产生。

### 16.6 前端形态（无新命令；2026-10-16 重设计，2026-10-21 拆分为「模型」「Agent」两页）

（已删除：以代码为准）

### 16.7 实测记录（omp 18.11.1，2026-10-16）

已移至 DECISIONS.md D5

### 16.8 兜底语义调研（2026-10-16，omp 18.11.2；UI 文案依据）

规则摘要：`retry.fallbackChains` 的 key 有角色名、模型 selector（匹配时忽略 `:thinking` 后缀）、
provider 通配三种；`retry.modelFallback`（默认 true）是兜底总开关，关闭后全部链不生效。
已移至 DECISIONS.md D6

## 17. macOS 菜单栏：运行中 omp 会话（本次追加）

> 在菜单栏查看并管理**当前正在运行**的 omp 会话（只读检测 + 聚焦）。
> MVP 控制动作只有「聚焦」；**绝不** kill / 发信号 / 停止任何进程，
> **绝不**向任何 iTerm session `write text` / 发送按键，绝不安装 omp hooks。
> iTerm 只允许 `activate` + `select`（已对 `Iterm2.sdef` 核对：select =
> "Make receiver visible and selected."）。不聊天、不调 LLM、不写会话 .jsonl、
> 不读凭据（models.yml / models.json 禁止读取，不运行 `omp config list`）。
> `omp ps` 管的是后台守护进程而非交互式会话，**不用作数据源**。

### 17.1 状态判定（`menubar::classify`，纯函数 + 单测）

输入：inUse（不 inUse 不展示）、iTerm 标题状态符、最后一条「有意义记录」及时间、
未配对 toolCall 数（assistant 的 toolCall id 无对应 toolResult）、子代理 lifecycle 配对。
「有意义记录」= `message`（user/assistant/toolResult/bashExecution）与
`custom` 的 `tool_execution_start/end`；**必须忽略**：`model_usage`（尤其
purpose=cache-warm/memory 的心跳，约每 5 分钟一条 aborted 会让 mtime 变新）、
`title_change`、`todo_hud_state`、`model_change`、`thinking_level_change`、
`custom_message`、`system-prompt-digest`、`memory_recall`、`credential_pin`。
**不能用文件 mtime 当主依据。**

```
ATTENTION_IDLE=30min  STUCK=10min  RECENT=60s
classify:
  not inUse → 不展示
  if 标题含旋转符 or 有子代理运行中 → 工作中
  elif 标题是 '>' and 有未配对 toolCall → 等待输入（疑似审批）
  elif 有未配对 toolCall → 工作中（工具执行）
  elif last 是 toolResult/bashExecution/user/toolEvent 且 < RECENT → 工作中（生成中/有进展）
  elif last 是 assistant 且 stop → (距今 < ATTENTION_IDLE ? 等待输入 : 空闲)
  elif last 是 assistant 且非 stop（回合未结束）→ 工作中
  else 空闲
  工作中 且 无运行子代理 且 距最后有意义记录 > STUCK 且 有未配对 toolCall → 疑似卡住
```

状态用词：工作中 / 等待输入 / 空闲 / 疑似卡住。阈值是推断值，集中定义于
`classify.rs` 常量，注释「待校准」。补充语义（单测锁定）：

- `user` 视同 `toolResult`：用户刚发消息必然是模型在生成；
- `tool_execution_start/end` 新鲜时说明工具有进展；陈旧则不算；
- `assistant` 且 `stopReason != "stop"`（如 `toolUse`）= 回合未结束 → 工作中；
  `stopReason` **缺失视为 stop**（否则陈旧会话会永判工作中）；
- 标题状态符：`>` = 在提示符；盲文旋转符（U+2800–U+28FF 任一帧）= 正在工作；
  其他（无 `π ` 前缀等）= 不携带信号，只用 jsonl 规则。
- 非 iTerm 占用者（如 VS Code）拿不到标题：只用 jsonl 规则判定，
  行内不提供聚焦动作，仅「占用中 · 应用名」（不可点）。

**实测修正（2026-10-16，对真实数据两处误判后收窄）**：

1. 卡住覆盖要求**无运行中的子代理**。父会话等子代理时，进展写在子代理自己的
   文件里，父文件「有意义记录」长期不更新是正常的（任务工具的未配对调用要等
   子代理返回）；实测曾把正在工作的父会话（iTerm 标题为旋转符、子代理就是
   本 worker）误判「疑似卡住」。子代理活动即此类会话的活性信号。
2. jsonl 尾部种子读取为**首次见到该会话时全文件单遍**（此后仍增量），
   而非固定 64KB 尾窗：cache-warm 心跳与大 toolResult 会把
   `vibe-session-lifecycle` 配对行挤出尾窗，实测导致子代理漏检。

### 17.2 检测分层（`menubar::detect` / `poller` / `tail` / `iterm`）

全程后台线程（`std::thread`，3 秒一轮，不阻塞 UI）；无占用会话时只跑 T0。

- **T0** 每轮：flock 全量探测 `ownersDir/*.lock` → inUse 集合
  （实测 360 余把锁约 5ms）。锁目录不可读 → 跳过本轮、保留旧菜单。
- **T1** 仅当 inUse 集合变化（或每 10 轮兜底）：重建 id→路径索引
  （文件名 `<ts>_<id>.jsonl` 尾段即会话 id，只扫顶层）；`lsof` 查持有 PID
  复用 `occupant.rs` 归类应用；`lsof -a -p PID -d 0` 得 tty。**一个 omp 进程
  会同时持有多个会话的锁**（父 + 子代理），展示按**顶层会话**行，
  无法归属到顶层文件的锁（子代理锁）只计入「未归属」计数，不成行。
- **T2** 对 inUse 的顶层会话：`TailState` 增量读取（首次全文件单遍，
  之后 seek 已消费偏移只读新增；处理末行不完整、超大行（>16MB 跳过）、
  截断/替换重建）；提取有意义记录、toolCall 配对、`vibe-session-lifecycle`
  子代理运行态（按 `data.id` 分组：spawn/turn-started=运行、turn-settled=停、
  tombstone=移除）、标题（title 行 → header → title_change 最后非空）。
  未配对 toolCall 记录 24h 过期（孤儿 id 不永久污染判定）。
- **T3** iTerm 标题：仅当存在 iTerm 占用者且 iTerm 在运行时（查询前必须
  `pgrep -x iTerm2` 门禁，`tell application "iTerm2"` 会把没在跑的 iTerm 拉起来），
  每轮一次 osascript **批量**取回全部 `tty → 标题`（单脚本遍历全部
  window→tab→session，绝不逐会话一次）。AppleScript 里不能直接用 `tab` 常量
  （会被解析为 iTerm 的 tab 类），用 `character id 9` 作分隔（实测验证）。

### 17.3 菜单结构与图标标题（`menubar::menu`，纯函数 + 单测）

图标：单色模板图 `src-tauri/icons/tray-icon.png`（44×44 黑+alpha，π 字形，
2× 超采样生成，`icon_as_template(true)` 随系统深浅模式取色）。
生成方法：纯 Python 画 88×88 位图（顶横+双竖的 π）后 2×2 盒式下采样到 44×44
写 RGBA PNG；如需重绘，按上述逻辑重跑即可。

图标旁标题（单色窄文本；无占用时只显示图标）：

| 情形 | 字样 |
|---|---|
| 无占用会话 | （空） |
| 有占用 | `<工作中+疑似卡住>·<等待输入>`，如 `2·1` |
| 有疑似卡住 | 追加 `!`，如 `1·0!` |

下拉菜单自上而下：①头部（禁用项）`omp 会话 · 占用 N · 工作中 X · 等待输入 Y`
（含疑似卡住时追加 `· 疑似卡住 Z`；无占用：`没有运行中的 omp 会话`）；
②分隔线；③会话行按 疑似卡住 → 等待输入 → 工作中 → 空闲 排序，
每行 `<状态符> <标题去 π 前缀与 (omp) 后缀，截断 32 字> · <应用名> · <持续时长>`
（持续时长自会话 header 创建时间起：`刚刚/X分/X小时Y分/X天`），
有子代理在跑时行尾加 `· 子代理 n`；最多 8 行，超出进「更多…」子菜单；
点击行 = 聚焦该会话所在 iTerm 标签（`activate` + 按 tty `select`）；
非 iTerm 占用者行置灰不可点，行内注明原因（`仅 iTerm 可聚焦` /
`未找到占用进程` / `未找到终端`）；④分隔线；⑤「打开主窗口」；
⑥勾选项「完成时通知」（默认开）、「在 Dock 显示图标」（默认关）；
⑦分隔线；⑧「退出 omp-resume」。菜单项 id 编码会话 id（`session:<id>`）路由事件。
菜单刷新（`menu::refresh_decision`，纯函数 + 单测）：模型一致不动；
**仅行内时长文字变化**时用已装配菜单项的 `set_text` **就地更新**
（NSMenu 展开时改文字安全，不会关掉用户正看着的菜单）；
**结构性变化**（会话增减 / 状态变化 / 排序变化 / 标题变化 / 设置勾选变化，
任一都会改头部计数、图标标题或行形状）才 `set_menu` 整体重建
（重建会关闭已展开的菜单，故仅限结构变化时发生）。
聚焦失败（找不到 tty / iTerm 未运行 / 无 Automation 权限）以系统通知明示
（文案含「系统设置 → 隐私与安全性 → 自动化」指引），不静默。

### 17.4 设置文件（`menubar::settings`）

`<data_dir>/settings.json`（`OMP_RESUME_DATA_DIR` 可覆盖数据目录）：

```json
{"version": 1, "notifyOnWaiting": true, "showDockIcon": false}
```

原子写入（同目录临时文件 → sync → rename），新文件 0600，已有文件保留原权限位。
损坏/版本不兼容 → **回落默认且不覆盖损坏文件**（与 meta.json 的「拒绝读写」
口径不同：设置丢了可重选，备注丢了不行）。无 revision（唯一写者是菜单勾选）。

### 17.5 通知（`menubar::notify` + `tray` 接线）

- 仅「工作中 → 等待输入」转换通知，且该会话此前工作中（Working/Stuck）
  持续 ≥ 30 秒；同会话 30 秒防抖；同一轮询周期 > 3 个会话转换 → 合并成一条汇总
  （「N 个会话在等你」）；「疑似卡住」首次出现通知一次（离开卡住态后重新计数，
  即按 episode 一次）。正文只含会话标题（截断 60 字）与状态，**不含对话内容**。
  设置「完成时通知」关闭时不发。
- 发送：优先 `tauri-plugin-notification`（2.7.0；Rust 侧 `NotificationExt` 直接
  发送，不需要前端权限调用；`default.json` 不声明通知权限）；
  点击通知（`tap`）聚焦对应 iTerm 标签（汇总/失败类通知点击打开主窗口）。
  插件发送失败退回 `osascript display notification`（只展示、不可点击；
  标题/正文经 `applescript_escape` 转义）。
- **未验证项**：ad-hoc 签名下通知是否需要用户首次授权、点击回调在 ad-hoc 下
  是否投递（以真机验证结论为准，见 §17.8）。

真机实测（2026-10-16）补充：

- 转换判定链路本身在真机验证中暴露并修复了一个真实缺陷：`busy_secs` 在离开
  工作态时先清 `busy_since` 再取值，恒为 0，导致「工作中 ≥ 30 秒」门槛永远
  不过、等待输入通知从未发出；已修复并加 poller 级回归测试
  （`busy_duration_gates_waiting_notification`）。
- 发送链路有诊断日志（stderr）：`通知发送尝试…` / `插件发送调用成功…`。
  真机观察到：插件（mac-notification-sys，legacy `NSUserNotification`）
  `show()` 返回成功，但内容横幅未展示；macOS 只弹了本应用的**通知权限提示**
  （「"omp-resume" 通知 / 「通知」可能包括提醒、声音和图标标记。」，
  `com.apple.notificationcenter.askpermissions` 类）；NotificationCenter 里
  也没有本应用条目（只有 iTerm2 自带的 Session 提醒）。osascript 回退
  （`display notification`）归属「脚本编辑器」（`com.apple.ScriptEditor2`，
  通知权限为关）同样无展示。系统勿扰模式开启（系统日志
  `muted by DND suppression: delay`）进一步抑制横幅。
- 结论：**转换检测 → 门槛/防抖/汇总/开关 → 发送调用**链路实测工作；
  **内容横幅弹出与点击聚焦回调未能在本机验证**（被通知权限未决 + 勿扰阻断，
  且不改变用户系统设置）。需用户在「系统设置 → 通知」允许 omp-resume、
  关闭勿扰后复验。stuck「首次出现通知一次」逻辑实测触发
  （会话 E、H1、H2 的首次卡住均有发送日志）。

### 17.6 驻留与窗口行为

- 关闭主窗口 = 拦截 `CloseRequested` → `hide()`，应用继续驻留菜单栏；
  红钮与 ⌘W 等效（macOS 默认应用菜单自带 `Close Window` ⌘W，走同一拦截）；
  隐藏时若「在 Dock 显示图标」为关 → `ActivationPolicy::Accessory`（Dock 图标隐藏）；
  「打开主窗口」/ 点 Dock 图标 → 切回 `Regular` + `unminimize` + `show` + `set_focus`
  （Dock 点击经 `RunEvent::Reopen`，入口为 `Builder::build(..).run(..)`，见 §17.9）。
- 真退出路径不拦截：菜单「退出」先置 quitting 标志再 `app.exit(0)`；
  ⌘Q（默认应用菜单 `Quit omp-resume`）/ Dock 退出 / 系统关机走的
  `RunEvent::ExitRequested` / 进程终止**不经** CloseRequested 拦截，正常退出（详见 README 已知限制）。

### 17.7 模块与命令

后端 `src-tauri/src/menubar/`：`classify`（状态判定）、`tail`（jsonl 增量读取）、
`iterm`（标题批量查询/解析/聚焦、`Runner` 可注入）、`detect`（T0 + 索引）、
`poller`（T0–T3 组装，`OccupantSource` 可注入）、`menu`（菜单模型，含 Dock 角标计数）、
`settings`（settings.json）、`notify`（通知判定 + osascript 回退）、
`tray`（托盘装配与事件路由，`Shared` 状态 + 轮询线程，含角标应用与 Dock 跳动）、
`dock`（仅 macOS：Dock 右键菜单，运行时注入 `applicationDockMenu:`）。无新增前端命令；
探针 `cargo test --test menubar_probe -- --ignored --nocapture`（只读）。

### 17.8 实测记录（2026-10-16，macOS arm64）

已移至 DECISIONS.md D7

### 17.9 Dock 图标（点击 / 角标 / 跳动 / 右键菜单）

- 点 Dock 图标 = 回到主窗口：入口为 `Builder::build(..).run(..)`，
  `RunEvent::Reopen { .. }` → `tray::show_main`（与「打开主窗口」同路径：
  `Regular` + `unminimize` + `show` + `set_focus`）。此前 `Builder::run` 丢弃
  run 事件，点击 Dock 图标无反应。
- 角标 = 需要用户处理的会话数（等待输入 + 疑似卡住），0 时清除。
  计数由纯 `menu::build_model` 算出（`MenuModel.badge_count`，参与
  `same_structure`，单测锁定：0 → 无、等待+卡住求和、工作/空闲不计），
  经主窗口 `set_badge_count` 应用（macOS → 应用级 NSDockTile badge）。
  应用点：初始模型 + 每次结构性重建（`refresh_tray`）；仅时长文字变化时
  计数不变，不重设。由于本机通知横幅常被静默丢弃（见 §17.5），Dock 角标是
  可见的主信号。
- 跳动：轮询一轮产出任一通知动作即 `request_user_attention(Informational)`
  一次（每轮至多一次，不按动作数重复）。判定沿用通知的开关/30 秒门槛/防抖，
  macOS 在应用已激活时忽略跳动（系统行为）。
- 右键菜单：Dock 右键弹出与托盘同内容的精简菜单——禁用头行、会话行
  （同文案/同 enabled/同 id `session:<id>`，超 8 行进「更多…」子菜单）、
  分隔线、「打开主窗口」（`open-window`）；无 toggles/quit（Dock 自带
  选项/退出）。点击走既有 `handle_menu_event`（聚焦 iTerm 标签 / 显示主窗口）。
- 实现（`menubar::dock`，仅 macOS，直连 `muda 0.20` / `objc2 0.6` /
  `objc2-app-kit 0.3`，版本与 Cargo.lock 一致）：tauri/tao 无 Dock 菜单 API，
  且 tao 的 delegate 类未定义 `applicationDockMenu:`，故在 setup（主线程）对
  当前 `NSApp.delegate` 的动态类（`object_getClass`，不硬编码类名）用
  `class_addMethod`（编码 `@@:@`）运行时注入；IMP 每次按缓存 `last_menu`
  现场新建 `muda::Menu` 并经 `ns_menu()` 返回指针，上一个菜单保存在主线程
  `thread_local` 直到下一次调用，AppHandle 经 `OnceLock` 获取。
  风险：若未来 tao 自己定义了该方法（`class_addMethod` 返回 false）或替换了
  delegate 类，Dock 菜单会静默消失（仅 stderr 一行日志），应用其余行为不变；
  注入失败同样只打日志跳过。
- 应用图标 = 紫→靛渐变圆角瓦片 + 白色 π（与托盘字形同比例）；母版
  `src-tauri/icons/app-icon.png` 由 `swift scripts/gen-app-icon.swift` 生成，
  再 `npx tauri icon src-tauri/icons/app-icon.png` 产出各尺寸（随后删掉 CLI
  额外生成的 `android/`、`ios/`、`64x64.png`）；macOS 可能缓存旧图标，
  必要时 `killall Dock`。

## 18. 记忆库（§4.39–§4.50，Mnemopi 维护：只读 + 写操作 + 关系图）

> 维护 omp 长期记忆库（每项目一个 bank）。§18.1–§18.3、§18.5–§18.7 只读，§18.8 写操作。
> （`memory_growth` 已移除，§18.4 号段留空，其余编号不变以免交叉引用失效。）
> 后端 `src-tauri/src/memory/`，类型在 `model.rs`。
>
> 数据源：`OMP_RESUME_MEMORY_DIR` > `$HOME/.omp/agent/memories/mnemopi/banks/`，每 bank 为
> `<bank>/mnemopi.db`（+ `-wal` / `-shm`）。命令名 snake_case、JSON camelCase（§0）。

### 18.1 `memory_overview() -> MemoryOverview`（§4.39）

```ts
MemoryOverview = { available: boolean; backend: string | null; root: string; banks: MemoryBankSummary[];
  totals: { banks: number; working: number; episodic: number; facts: number; bytes: number;
            neverRecalled: number; unconsolidated: number; missingSourceSessions: number; sourceSessions: number } }
MemoryBankSummary = { bank: string; displayName: string; cwd: string | null; cwdExists: boolean | null;
  working: number; episodic: number; facts: number; bytes: number; firstMemoryAt: string | null;
  lastMemoryAt: string | null; neverRecalled: number; unconsolidated: number; sourceSessions: number;
  missingSourceSessions: number; readable: boolean; error: string | null }
```

- `available=false`（根不存在/不可读）是正常空状态（`banks=[]`、`totals` 全零，`root` 仍为展示路径）；
  `backend` = `omp config get memory.backend --json` 的 `.value`，omp 缺失/超时/异常 ⇒ null，永不让命令失败。
- `banks` 按 `lastMemoryAt` 倒序（null 最小），再 `bank` 升序；`totals` 为同名字段求和（`banks` = 库数）。
- 单 bank：`cwd` = 两表按 `timestamp` 倒序首条非空 `metadata_json.cwd`；`displayName` = cwd basename
  （未知时去目录名末段 `-<hash>`）；`cwdExists`（未知 ⇒ null）；`bytes` = 三文件之和；
  `first/lastMemoryAt`（§0 格式，无有效行 ⇒ null）；`neverRecalled`（`recall_count=0`，列缺失视为 0）；
  `unconsolidated`（working `consolidated_at IS NULL`，列缺失 ⇒ 0）；`sourceSessions`（`session_id` 去重）、
  `missingSourceSessions`（§18.5 无同名文件数）。不可用时 `readable=false` + 简短中文 `error`，计数按 0。

### 18.2 `memory_list(args) -> MemoryPage`（§4.40）

```ts
memory_list(args: { bank: string; query?: string | null; kind?: "all" | "working" | "episodic";
                    onlyNeverRecalled?: boolean; onlyUnconsolidated?: boolean; onlyMissingSource?: boolean;
                    sort?: "newest" | "oldest" | "mostRecalled"; limit?: number; offset?: number }): MemoryPage
MemoryPage = { total: number; items: MemoryItem[] }
MemoryItem = { id: string; kind: "working" | "episodic"; snippet: string; contentChars: number;
  createdAt: string | null; sourceSessionId: string | null; sourceSessionExists: boolean | null;
  recallCount: number; lastRecalledAt: string | null; importance: number | null;
  veracity: string | null; memoryType: string | null; consolidated: boolean; superseded: boolean }
```

- `bank` 非法 ⇒ `OUTSIDE_ROOT`，不存在 ⇒ `NOT_FOUND`，库损坏/两表皆无 ⇒ `IO`；`kind` 指向的表缺失
  但另一表存在 ⇒ 空页。`query` 空白/null = 不过滤，否则 LIKE 子串（§18.7）匹配 `content` 与 `embed_text`。
- `kind`/`sort` 默认 `all`/`newest`；`onlyNeverRecalled`（`recall_count=0`）；`onlyUnconsolidated`
  （working 且 `consolidated_at IS NULL`，episodic 永不命中，列缺失命中 0 行）；`onlyMissingSource`（§18.5）。
- 排序：`timestamp` 文本倒/正序或 `recall_count` 倒序；NULL/空 `timestamp` 恒最后；次级 `kind` 再 `id`。
  `limit` 默认 50 钳制 1..=200，`offset` 默认 0 负数按 0；`total` = 过滤后总数。
- `snippet` = `content` 空白折叠后前 240 字符（字符边界，超长尾 `…`）；`contentChars` = 字符数；
  `createdAt`/`lastRecalledAt` §0 格式或 null；`sourceSessionId`（非字符串/缺失 ⇒ null）与存在性
  （id 为 null ⇒ null）；`recallCount`（缺列/NULL ⇒ 0）；`importance`/`veracity`/`memoryType` 原文或 null；
  `consolidated`（working 看 `consolidated_at`，episodic 恒 true）；`superseded`（`superseded_by` 非空或
  `valid_until` 早于 now）。

### 18.3 `memory_detail { bank, id } -> MemoryDetail`（§4.41）

```ts
MemoryDetail = MemoryItem & { content: string; truncated: boolean; embedText: string | null;
  metadata: Record<string, unknown> | null; summaryOf: string[]; relatedEdges: number;
  facts: { subject: string | null; predicate: string | null; object: string | null; key: string | null }[] }
```

- 查找：working 先、episodic 后，`id` 精确匹配，皆无 ⇒ `NOT_FOUND`；`bank` 语义同 §18.2。
- `content` 全文，上限 200KB（UTF-8 字节、字符边界，超出 `truncated=true`）；`embedText` NULL 或与
  `content` 全等 ⇒ null（同上限）。`metadata` 解析为对象才返回（数组/标量/失败 ⇒ null），并删除顶层键名
  含 `token`/`key`/`passwd`/`password`/`secret`/`authorization`/`credential`（小写）的键。
- `facts`（≤50，`facts` 在前、`memoria_facts` 在后，各按 rowid）：`facts` 行 ⇒
  `{ subject, predicate, object, key: null }`（`source_msg_id=id`）；`memoria_facts` 行 ⇒
  `{ subject: null, predicate: fact_type, object: value, key }`（`source_memory_id=id`）；缺表/列 ⇒ 0 条。
- `summaryOf`：episodic 的 `summary_of` 按 `,` 切分去空白去空（working ⇒ `[]`）；`relatedEdges`：
  `graph_edges` 的 `source=id OR target=id` 计数（缺表 ⇒ 0）。

### 18.5 只读、校验与降级规则

- 只读连接 + `busy_timeout` 500ms；永不创建/修改文件，读 live 库（含 WAL）不拷贝。只读打开会刷新
  `-shm` 的 mtime（SQLite WAL-index 行为），文件名/大小/db/`-wal` 均不变。
- `bank` 校验：非空纯目录名单段（无 `/` `\` `\0`，非 `.`/`..`），canonicalize 后须仍在根内
  （否则 `OUTSIDE_ROOT`）；不存在 ⇒ `NOT_FOUND`。缺表/缺列按“零/None/空”降级，永不 panic；
  SQL 内 `COUNT`/`LIMIT`/`OFFSET`，列表只取 512 字符前缀 + `LENGTH`。
- 隐私：日志/错误/测试输出永不含记忆正文；`content` 仅经 IPC 返回前端。

### 18.6 sessions 目录文件名匹配（近似）

- 各项目顶层 `*.jsonl` 名形如 `<ts>_<uuid>.jsonl`，取 `_` 后、`.jsonl` 前部分精确匹配；每命令至多扫一次
  文件名、不读内容。`header.id` 与文件名不一致时误判、只扫顶层、目录不可读 ⇒ 判“不存在”。

### 18.7 LIKE-not-FTS 决策与证据

规则摘要：记忆搜索用 `LIKE`（转义 `%`/`_`/`\` + `ESCAPE '\'`），不用 FTS5——
FTS5 默认分词把连续 CJK 切成一个 token，而搜索框语义是子串匹配。
已移至 DECISIONS.md D8

### 18.8 写操作（§4.43–§4.49，第 2 轮）

上游语义（omp v18.12.3 `packages/mnemopi/src/core/beam/store.ts`，逐条镜像）：`forget` 按
`id + session_id=bank` 删 working 行后级联 purge：`facts`（`source_msg_id`，收集 `fact_id`）、
`annotations`/`memory_embeddings`（`memory_id`）、5 张 `memoria_*`（`source_memory_id`）、`gists`
（`memory_id`）、`graph_edges`（`source`/`target` ∈ `{id, gist_<id>}` ∪ 关联 `fact_id`；缺表有守卫）；
FTS 由触发器自清。`memory_validations`（审计）/`triples`/`consolidation_log`/`scratchpad`/`summary_of`
不动（preview 报 `citedBySummaries`）。`invalidate`/`update` 本工具不做。

#### 18.8.1 episodic 删除决策

- `vec_episodes` 是 sqlite-vec 虚表，本工具 SQLite 无该扩展：`sqlite_master` 含此表 ⇒ episodic id 一律
  `unsupported`（且 `VACUUM INTO` 预期失败 ⇒ 写操作安全中止，该 bank 实际只读）。无此表 ⇒ episodic 可删，
  级联**与 working 共用同一 purge**（仅 base 表不同）：上游 `consolidateToEpisodic` 以 episodic id 调
  facts/图谱/embedding，实测附属表大量引用 episodic id。

#### 18.8.2 新命令

```ts
memory_bank_status(args: { bank: string }): MemoryBankStatus         // §4.43
MemoryBankStatus = { bank: string; inUse: boolean; probeFailed: boolean;
                     holders: { pid: number; command: string }[]; backups: MemoryBackup[] }
MemoryBackup = { id: string /* `{bank}@{dirname}`，见下 */; bank: string; bytes: number;
                 kind: "before-delete" | "before-restore" | "bank-removed"; createdAt: string /* ISO UTC */;
                 working: number | null; episodic: number | null; cwd: string | null }
memory_backups(args?: { bank?: string | null }): MemoryBackup[]      // §4.44
memory_delete_preview(args: { bank: string; ids: string[] }): MemoryDeletePreview  // §4.45
MemoryDeletePreview = { requested: number; deletable: { working: number; episodic: number };
                        unsupported: number; notFound: number; citedBySummaries: number;
                        cascade: { facts: number; embeddings: number; annotations: number; edges: number; other: number } }
memory_delete_items(args: { bank: string; ids: string[] }): MemoryDeleteResult     // §4.46
MemoryDeleteResult = { deleted: string[]; skipped: { id: string; reason: "not_found" | "unsupported" }[];
                       backup: MemoryBackup }
memory_delete_bank(args: { bank: string }): MemoryBackup            // §4.47
memory_restore(args: { backupId: string }): { bank: string; restoredFrom: MemoryBackup; safetyBackup: MemoryBackup | null }  // §4.48
memory_delete_backup(args: { backupId: string }): null              // §4.49
```

- `memory_bank_status`：lsof 问题永不报错 ⇒ `probeFailed=true`（`inUse=false`、`holders=[]`）。
  `memory_backups`：newest first，`bank` null/缺省 = 全部（含 bank 已不存在的）。`memory_delete_preview`：
  纯只读不设门禁；`cascade.other` = `gists` + 5 张 `memoria_*`；数字必须等于实际删除（共用同一级联规划）。
  无任何可删 id ⇒ `INVALID_INPUT`，**不建备份、不开写连接、不修剪**。
- `backupId` = `{bank}@{dirname}`（按**最后** `@` 切分；dirname 严格
  `^\d{8}T\d{6}Z-(before-delete|before-restore|bank-removed)$`；canonicalize 后须在备份根内）：
  形状非法 ⇒ `OUTSIDE_ROOT`，不存在 ⇒ `NOT_FOUND`。ids 去重；>500 或空 ⇒ `INVALID_INPUT`；
  不存在 ⇒ `skipped.not_found`（不 abort 其余）；`session_id ≠ bank` ⇒ `skipped.unsupported`。

#### 18.8.3 占用门禁（所有破坏性操作，无例外）

- `/usr/sbin/lsof -nP -F pcn -- <db> <-wal> <-shm>` 硬超时 2s（复用 `occupant::LSOF`/`LSOF_TIMEOUT`）：
  任一持有者 ⇒ `IN_USE`（含 pid + command），lsof 缺失/超时/不可解析 ⇒ `PROBE_FAILED`。preview/status
  不设门（status 探针失败 ⇒ `probeFailed=true`）。时序：门禁 → 备份 → 破坏性步骤前**再过一次门禁**。

#### 18.8.4 备份

- 触发：任何破坏性操作前（删行/删 bank/恢复覆盖已存在目标时）。方式：`VACUUM INTO`（不改源库，
  WAL 数据一致并入）；落点 `<data_dir>/memory-backups/<bank>/<ts>-<kind>/` + `manifest.json`
  （`{ bank, kind, createdAt, cwd, working, episodic, sourceBankDirName }`），目录 `0700`、文件 `0600`。
- `bank-removed`：先写 manifest，再 move 整个 bank 目录 → `…/<ts>-bank-removed/bank/`（rename；跨设备
  copy + 字节校验 + 删源）；任一步失败 ⇒ 清掉该 ts 目录后报错，原库不动。
- 留存：仅成功提交/恢复后修剪同 bank 同 kind ∈ {`before-delete`,`before-restore`}，留最新 5；
  `bank-removed` 永不剪；失败/被拒的操作绝不修剪。有效备份 = 目录名严格匹配**且** manifest 可解析；
  无 manifest 的残留不列出、不占名额、不被自动删（恢复它 ⇒ `IO`，原库不动）。备份失败 ⇒ 操作中止
  （`IO`，不加错误码）。

#### 18.8.5 删除事务与校验

- 删行：门禁 → 备份 → 复检门禁 → **一个 `BEGIN IMMEDIATE`** 内按序删 working/episodic → **事务内 recount**
  （计划内 id 逐表 `COUNT(*)` 必须全 0，不一致 ⇒ 回滚 + `IO`）→ commit → best-effort `wal_checkpoint`；
  `deleted`/`skipped` 保请求序。
- 恢复：门禁 → 目标存在则先拍 `before-restore` → 删边车 → 放置（`bank-removed` 复制回目录）→ 校验
  （`integrity_check`=ok + 行数=manifest）→ 成功后才修剪。失败 ⇒ 用安全快照回滚并同样校验：通过 ⇒ 删冗余
  安全快照 + `IO`「…已回滚」；无法验证 ⇒ 保留并在错误里点名；不修剪；`bank-removed` 回滚前整目录重建。
- 测试断言：`integrity_check` + FTS5 `integrity-check` + 删后六表无孤儿。

#### 18.8.6 错误码

- 复用现有：`IN_USE`、`PROBE_FAILED`、`IO`、`INVALID_INPUT`、`OUTSIDE_ROOT`、`NOT_FOUND`
  （id 级走 `skipped`）。**无新增错误码。**

#### 18.8.7 风险与未验证

- vec bank 备份/删除与跨设备 `EXDEV` 分支未实测；`summary_of` 悬挂与上游一致（无害）；omp 进程内
  recall 缓存（默认关）至多 5 分钟过期，WAL 锁保证无损坏。

#### 18.8.8 实现与测试

- 模块：`mod.rs`（浏览 + 命令）、`rows.rs`（列表/详情）、`gate.rs`（门禁）、`backup.rs`
  （快照/manifest/留存/`backupId`）、`delete.rs`（preview/删行/删库/恢复/备份管理）；测试见
  `tests/memory*.rs`（超集 schema 在 `tests/common`，各含 1 个 `#[ignore]` 真实数据用例）。


### 18.9 前端（记忆库标签页）

（已删除：以代码为准）

### 18.10 `memory_graph { bank } -> MemoryGraph`（§4.50，只读关系图）

```ts
memory_graph(args: { bank: string }): MemoryGraph
MemoryGraph = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; truncated: boolean;
                totalNodes: number; totalEdges: number; unlinkedCount: number }
MemoryGraphNode = { id: string; kind: "working" | "episodic"; snippet: string /* ≤80 字 */;
                    createdAt: string | null; recallCount: number; importance: number | null;
                    degree: number /* 保留边中的关联数，节点大小据此 */ }
MemoryGraphEdge = { source: string; target: string; kind: "summary" | "related" | "context" }
```

- 边只取真实有行的数据（实测 2026-10-20，多 bank 只读）：① `summary`——
  `episodic_memory.summary_of` 按 `,` 切分（`working ⇒ []`，悬挂 id 丢弃）；
  ② `related`——`graph_edges` 中 `edge_type` 为 `related_to`/`references`/`rel` 及其他未知类型；
  ③ `context`——`graph_edges` 中 `edge_type = 'ctx'`。两端点必须都是记忆 id，
  `gist_*`/`fact_*` 等伪节点与库外 id 自动排除（实测主库 `ctx` 13、`related_to` 8、
  `references` 6、`rel` 2，另有 `gist_*`/`fact_*` 端点若干，均已排除）。
- 刻意不建的边：`superseded_by`（全库无行）、`session_id` 相同（单库常唯一，稍多即成毛球）、
  facts 共享主体（`fact`/`version` 等泛词连接 up to 8 条记忆，成团无意义）。
- 节点上限 200：按关联度降序、再新近（解析失败恒最后）、再 id 排序取前 200，
  只保留存活端点间的边；`truncated=true` 时 UI 显示「显示 N / 共 M」。
  无关联的记忆默认不渲染为孤点，只计入 `unlinkedCount`（图为空时才明示）。
  空库返回空图（总数为 0），不是错误。
- 降级与只读语义同 §18.2/§18.5：只读打开 + `spawn_blocking`；缺表/缺列降级
  （`summary_of` 缺失则无摘要边，`graph_edges` 缺失则只有摘要边）；两表皆无 ⇒ `IO`；
  `bank` 校验语义同 §18.2；日志/错误永不含记忆正文。
- 前端（`MemoryGraph.tsx` + `graphLayout.ts`，合计 ≈550 行）：选中库操作条下的
  「列表 | 关系图」切换（默认列表，`aria-pressed` chips）；SVG 直绘无依赖；
  确定性力导向布局（固定种子 + 固定 tick，单测锁定）同步跑完；悬停高亮邻域、
  点击选卡（类型/时间/片段/召回/关联/重要度/相邻跳转）、滚轮围绕光标缩放、背景拖拽平移、
  节点拖拽移点、「重置视图」；图例含节点色（复用库条形色）与边种类
  过滤 chips；节点提示走全局 `data-tip`。Esc 清选择，且**只在有选中卡时** `stopPropagation`
  ——否则抽屉（§18.9 的 `Drawer` 在 document 上监听 Esc）会连带关闭；无选中时不拦截，
  Esc 正常关抽屉。选中卡「在列表中打开」切回列表并经
  `focusId`（`memoryDetail` 直取，跨分页）置顶展示该记忆。

## 19. 视觉系统与交互约定（全应用统一）

> 唯一来源是 `src/App.css` 顶部的 token 区；组件 CSS 只消费变量，不写字面量。
> 改色后必须复核对比度：正文/次要文字对所在底色 ≥ 4.5:1（浅深两套都要）。

### 19.1 token

- 表面：`--bg`（主区）/ `--bg-elevated`（浮层、激活段）/ `--bg-sidebar` / `--bg-card`（成组块）/ `--bg-inset`（弱化条、胶囊）。
- 交互态：`--bg-hover`（悬停）/ `--bg-active`（按下）/ `--bg-selected`（选中行）。
- 文字：`--text` / `--text-muted`（次要，≥4.5:1）/ `--text-faint`（第三级，仅装饰与非关键标签，浅色 ≥4.6:1）。
- 边界：`--border`（分割线）/ `--border-strong`（输入框与按钮边界）。
- 强调：`--accent` / `--accent-fill`（实心按钮）/ `--accent-soft`（淡底）/ `--accent-ring`（焦点、内描边）；6 个预设由 `data-accent` 覆盖。
- 字号 `--fs-xs..2xl`、间距 `--sp-1..6`、圆角 `--radius-xs..xl`/`full`、动效 `--motion-fast`/`--motion-base`/`--ease-out`、阴影 `--shadow-sm`/`--shadow-md`、层级 `--z-titlebar`/`--z-sticky`/`--z-popover`/`--z-overlay`。
- 例外：舞台画布内 7/8/9px 与 §12 图形内的字号不受字号刻度约束。

### 19.2 形态规则

- **分层靠底色，不靠边框**：成组内容用 `--bg-card`，悬停转 `--bg-inset`；只有分割线与输入框画 1px 边。
- **选中用底色**，不用左侧色条；需要归属提示（右键菜单目标、流程图选中）用 `inset` 内描边。
- 页签是**下划线式**（`.tab::after` 强调色 2px），不用带框 chrome tab。
- 分段控件（`.seg`、`.segment`、`.bench-segment`）统一：`--bg-inset` 容器 + 透明项，激活项 `--bg-elevated` + `--shadow-sm`。
- 浮动层（modal/drawer/popover/toast/tooltip）用 `--shadow-md`；流内卡片用 `--shadow-sm` 或不加。
- 详情头部结构固定为：标题行（标题 + 徽章 + 右对齐 `.detail-actions`）→ `.detail-meta`（一行元信息）→ 用量指标条 → 概要。
  会话头动作（在 iTerm 继续 / 置顶 / 备注 / 删除）全在标题行右侧，不再单独占一条工具栏。
- 别名/标签/备注编辑器默认收起（`.detail-actions` 的「备注」按钮展开），切换会话自动收起。
- 图标一律经 `Ico`（lucide，`strokeWidth 1.75`）；禁止把 emoji/unicode 字形当图标。

### 19.3 动效

- 只用 `--motion-fast`（110ms）/ `--motion-base`（170ms）+ `--ease-out`；不写裸毫秒。
- 悬停态只改 `background-color`/`color`/`box-shadow`，不改宽高。
- `prefers-reduced-motion: reduce` 时全局停掉动画与过渡（`App.css` 末尾统一规则）。
- `prefers-reduced-transparency: reduce` 时侧栏回退为不透明 `--bg-sidebar`。

## 20. 模型测试器（§4.51–§4.53、§4.56，管理视图「模型」标签页的「测试」区）

> 测速度、测稳定性，结果可写回 `modelRoles`。测速走 omp 自带的 `omp bench`（直连模型，
> 不带 agent 前缀），是本应用唯一会调用 LLM 的路径。写配置仍然只走 §16.5
> `update_model_config`；本章唯一的写盘命令是 §20.4（删除 `model-bench.jsonl` 里的记录）。
> 实现：`src-tauri/src/model_bench.rs`、
> `src/modelBench.ts`、`src/components/ModelTesterPanel.tsx`（及 `BenchToolbar` /
> `BenchTagFilter` / `BenchSparkline` / `BenchDrawer` / `BenchRecords` / `BenchSavebar` /
> `ModelEntryModal` 拆出件）。

### 20.1 / 4.51 `model_bench_run { selector } -> BenchRound`

- `selector`：`provider/model[:thinking]`，≤200 字符，首字符为字母或数字（防参数注入），
  无空白，含 `/`；否则 `INVALID_INPUT`，不调用 omp。
- 依次跑两次探针（不经 shell，selector 整串作为一个 argv；**不占 `OmpBusy`**：只读，
  且不能把配置保存卡几分钟）：
  1. 短探针：`omp bench <selector> --json --par 1 --profile chat --runs 5 --max-tokens 100`
  2. 长探针：`omp bench <selector> --json --par 1 --profile generation --runs 3 --max-tokens 600`
  每次超时 6 分钟。`--par 1` 必须写：omp 默认 4 并发，会让延迟数据失真。
  bench 只测指定模型，失败不会走 `retry.fallbackChains`（实测）。
- **不看退出码**（有请求失败时 bench 返回 1，但照样输出 JSON）：从合并输出中第一个以 `{`
  开头的行起流式解析第一个 JSON 值，取 `models[0].results[]`
  （`{ ok, error?, ttftMs?, generationTps?, cost?, challenge }`）。
  - 找不到或解析失败 → `OMP_FAILED`（带输出尾部），不写历史。
  - 某次探针超时 → 按计划请求数（5 或 3）记失败，错误文本「超时（6 分钟）」，另一次照常跑；
    两次都超时仍记一轮（ok=0）。`OMP_NOT_FOUND` / `IO` 原样返回，不写历史。
- 合成一轮：

  ```jsonc
  BenchRound {
    at,                    // ISO-8601 UTC 毫秒，本轮开始时间
    selector,              // 原样（含 :thinking）
    total, ok,             // 请求总数 / 成功数（正常 8）
    ttftP50Ms, ttftP95Ms,  // 全部成功请求 ttftMs 的分位数（最近秩法）；无样本 null
    tpsP50, tpsCv,         // 长探针成功请求 generationTps 的 p50 / 变异系数（总体标准差÷均值，
                           // 样本 <2 为 null）；长探针无样本时退回短探针，仍无则 null
    cost,                  // 成功请求 cost 之和（美元），缺失按 0
    errors                 // 失败请求错误文本：去重，每条 ≤200 字符，最多 5 条
  }
  ```
  tok/s 只取长探针的理由（实测）：100 token 的短探针 tok/s 在 34–168 之间抖动，
  600 token 的长探针稳定在 163–168，混在一起算会把稳定的模型误判成不稳定。
- 结果追加一行到数据目录（同 `meta.json`，`OMP_RESUME_DATA_DIR` 可覆盖）的
  `model-bench.jsonl`，进程内互斥锁保护追加与裁剪。bench 原始输出与错误全文不写日志。

### 20.2 / 4.52 `model_bench_history() -> BenchRound[]`

- 读 `model-bench.jsonl`，只保留最近 30 天，按 `at` 从早到晚。文件不存在 → `[]`，坏行静默跳过；
  有裁剪或坏行时「临时文件 + rename」原子重写，失败不报错。

### 20.3 / 4.53 `model_perf_list() -> ModelPerf[]`

- 数据源 omp 的 `agent.db`（`OMP_RESUME_AGENT_DB` 可覆盖，默认 `~/.omp/agent/agent.db`）。
  **该库含凭据表**：只用 `SQLITE_OPEN_READ_ONLY` 打开（复用 `memory::open_readonly`），
  SQL 写死为一条 `SELECT model_key, samples, output_tokens, gen_ms, ttft_samples, ttft_ms,
  updated_at FROM model_perf`，不提供通用查询，代码不出现其他表名。
- 列为 omp 累计值：`ModelPerf { selector: model_key, samples: round(samples),
  ttftMs: ttft_ms/ttft_samples（>0 时，否则 null）, tps: output_tokens/(gen_ms/1000)（>0 时，否则 null）,
  updatedAt: ISO(updated_at 秒) }`，按 samples 降序。
- 库不存在、表/列不匹配、任何 SQL 错误 → `[]`（前端隐藏「日常实测」列）。

### 20.4 / 4.56 `model_bench_delete { selector, at? } -> number`

- `selector` 校验同 §20.1（不合法 → `INVALID_INPUT`）。
- `at` 为 ISO-8601 UTC 毫秒字符串时只删 `selector` 与 `at` 都精确匹配的那一轮；为 `null` /
  缺省时删 `selector` 的全部轮次。返回删除条数。
- 文件不存在或没有命中 → 返回 0，不写盘。命中时按 §20.2 的口径重写
  `model-bench.jsonl`（坏行与无时间戳行一并丢弃），失败 → `IO`（与裁剪的静默不同：
  用户显式删除必须能报错）。持同一把进程内互斥锁，全程读-改-写。
- 前端入口在抽屉的「测试记录」块：单轮可删，另有「清空记录…」（`Modal` 二次确认）。
  抽屉自带「删除」（移除测试条目）不动记录。
- **从测试列表移除**（`removeFromBench` / `addToBench`，`src/modelBench.ts`）：
  `BenchConfig.hidden: string[]` 记录「被移除但角色仍在用」的 selector，`deriveBenchList`
  过滤掉它们。被角色占用的行按钮文案是「移除」（不是禁用的「删除」），点后角色分配
  `modelRoles` 完全不改；「添加模型」重新加入时清掉对应 hidden 并保留原标签/监控。
  未被角色占用的行仍走原路径（直接删本地条目，不写 hidden）。旧配置缺 `hidden` 视为 `[]`。

### 20.5 前端（纯前端状态，不新增配置键）

（已删除：以代码为准；以下两项保留）
- bench 测试器配置存 localStorage `omp-resume:model-tester:v1`（损坏回默认；dev 与 .app 不互通）。
- **综合分**（0–100，仅排序与推荐）：`round(100 × (0.5·成功率 + 0.3·tps/全表最大tps
  + 0.2·全表最小ttftP50/ttftP50))`，缺项按 0。

### 20.6 实测记录（omp 18.12.3，2026-10-20）

已移至 DECISIONS.md D9

## 21. 模型规格编辑（§4.54–§4.55，models.yml 行级编辑）

> 改 omp 实时模型注册表 `models.yml` 里单个模型的非凭据规格字段
> （名称 / 上下文窗口 / 最大输出 / 推理开关 / 输入类型 / 费用）。
> §16.1「绝不读取凭据文件」的**刻意例外**（见该节）：只做行级外科手术替换，
> 绝不 YAML 解析再整体重排（锚点文件重排会复制/换行凭据）。
> 实现：`src-tauri/src/model_specs.rs`、类型在 `model.rs`。
>
> 背景（本机验证）：`models.yml` 是 omp 启动读取、mtime 热重载的实时源；
> `models.json` 在 yml 存在时是遗留死文件；`models.db` 是缓存，永不触碰。
> 文件锚点密集（`&u5438` / `*u5438`）且含明文 apiKey。omp 校验严格且
> fail-closed：任一 schema 错误禁用**全部**自定义 provider；`cost` 出现时
> 四个数必须齐全；`contextWindow` / `maxTokens` 必须 > 0。

### 21.1 路径与文件规则

- 路径：`OMP_RESUME_MODELS_YML`（存在且非空）> `PI_CODING_AGENT_DIR` +
  `/models.yml` > `$HOME/.omp/agent/models.yml`。
- 大小上限 2 MiB，超限 `INVALID_INPUT` 并提示手动编辑。
- `revision` = 文件字节 SHA256 十六进制；文件缺失时读侧 revision 为
  `"absent"`，不可读时为 `"unreadable"`（只读展示，不可写）。
- 读侧文件权限忽略；一切写盘（备份/临时/目标）均为 0600。

### 21.2 / 4.54 `get_model_specs() -> ModelSpecsResult`

- 只读，不占 `OmpBusy`。返回（camelCase）：

  ```jsonc
  ModelSpecsResult = { path: string; available: boolean; revision: string;
                       specs: ModelSpec[]; error: string | null }
  ModelSpec = { provider, id, selector /* provider/id */, name: string | null,
                contextWindow: number | null, maxTokens: number | null,
                reasoning: boolean | null, input: string[] | null,
                costInput: number | null, costOutput: number | null,
                costCacheRead: number | null, costCacheWrite: number | null,
                costTiered: boolean /* cost 含分层价（longContext 等）时 true，四费用为 null */ }
  ```

- 文件缺失 → `available=false` 正常空状态（`specs=[]`、`error=null`）；
  超大/非 UTF-8/形状异常 → `available=true` + 中文 `error`（`specs=[]`），
  错误文本永不含文件内容。
- 只返回非凭据字段；`apiKey` / `baseUrl` 等永不经 IPC。

### 21.3 / 4.55 `update_model_spec { provider, id, patch, expectedRevision } -> ModelSpecUpdateResult`

- 类型（camelCase）：

  ```jsonc
  ModelSpecPatch = { name?: string; contextWindow?: number; maxTokens?: number;
                     reasoning?: boolean; input?: string[];
                     cost?: { input, output, cacheRead, cacheWrite: number } }
  ModelSpecPatchRequest = { provider: string; id: string; patch: ModelSpecPatch;
                            expectedRevision: string }
  ModelSpecUpdateResult = { revision: string; spec: ModelSpec; backupPath: string }
  ```

- 缺席字段不触碰；`cost` 必须四个数字整体替换（omp fail-closed 要求四键齐全）。
- 分层价（`cost:` 含嵌套映射如 `longContext`）整模型拒改：读侧四费用为
  `None` + `costTiered=true`，写侧任何补丁（含非 cost）均 `INVALID_INPUT`
  「该模型的 cost 含分层价格，暂不支持自动编辑，请手动编辑 models.yml」。
- 流程（整体持有 `OmpBusy`，多余报 `BUSY`）：
  1. 校验 `provider` / `id`（非空、≤200 字符、无换行、不含 `/`）与补丁值
     （name 非空 ≤200 字符无换行无控制字符；窗口/输出 > 0 且 ≤ 2^53-1；
     input 非空、≤8 个、每项 1–32 位 `[A-Za-z0-9_-]`、不重复；费用四数非负有限
     ≤ 1e9 且精度 ≥ 1e-6）→ 不符 `INVALID_INPUT`；
  2. `expectedRevision` 与文件字节 SHA256 比对，不一致 → `CONFLICT`
     「模型规格文件已被外部修改，请刷新后重试」，不写入；
     哨兵串 `absent` / `unreadable` 直接 `INVALID_INPUT`（须先刷新）；
  3. 行级生成新文本（§21.4）；与原文一致 → 直接返回现规格，不写盘
     （`backupPath=""`）；
  4. 沙箱校验（§21.5）→ 不通过 `INVALID_INPUT`（固定文案，不回显 omp 输出）；
  5. 复检 revision（校验耗时，防并发外部改）→ 不一致 `CONFLICT`；
     复检与 rename 之间有毫秒级 last-writer-wins 窗口（已知接受）；
  6. 备份原文到同目录 `models.yml.omp-resume.<UTC紧凑>.bak`（0600，
     只留最新 10 份，按名倒序删旧）；
  7. 同目录临时文件（0600）+ fsync + rename（目标 chmod 尽力而为）；
     符号链接目标与只读目标拒绝写入（`IO` 中文说明）；
  8. 重读返回新 revision 与规格。rename 前任何失败原文不动。
- omp 缺失 → `OMP_NOT_FOUND` 并拒绝写入（无法校验就不写）。

### 21.4 行级编辑器规则（纯函数 + 单测）

- 定位：顶层 `providers:` → 同级 provider 键（引号键允许）→ 其块内 `models:` →
  缩进大于 `models:` 的 `- ` 项中 `id:` 等于目标的条目（单/双引号允许；
  `models:` 后横线同列的零额外缩进序列亦可（首项确立条目缩进，同列后项同属该列表）。
  支持 `- id: x`、续行 `id: x`、`- &anchor` 锚条目头三种条目形；
  纯别名条目（`- *name`）无本地字段，读侧跳过、写侧不可定位（`INVALID_INPUT`）。
- 作用域：只认条目直接子字段（首行内联键列确立的缩进）；
  嵌套映射键、块标量体一律不透明；`id` 同理（锚值剥 `&name` 后比对，
  同条目两不同顶层 `id` → 手动改）；直接子 `cost:` 之外的嵌套 `cost:` 忽略。
- 拒绝（`INVALID_INPUT` + 中文「请手动编辑 models.yml」）：流式条目（`- {…}`）、
  首行非 `key: value` 写法、provider/id 重复、条目内同键重复、
  `cost` 行内写法（`cost: {...}`，锚头 `cost: &x` 是合法块头）、`cost` 缺子键、
  分层价 cost（含嵌套映射，整模型拒改）、块标量值字段、
  目标条目定义的锚（`- &name` / `cost: &name`）被正文他处 `*name` 引用
  （改锚会静默波及引用者；别名比对按完整名，字符集含 `._:%`）。
- 替换：只改已存在标量行的值段，保留缩进/键原文/行尾注释/换行（CRLF 保留）。
  `input` 块序列形（`input:` + `- text` 子行）改头为流式并删子行；
  读侧块序列与流式均解析。
- 插入：缺失的简单字段紧随 `- ` 行之后；缺失的 `cost` 插完整四键块
  （与字段同级缩进，子键深两格，顺序 input/output/cacheRead/cacheWrite）；
  EOF 无尾换行先补换行再插入。
- 格式：name 双引号转义（`\\` `\"`）；数字不加引号；布尔 `true`/`false`；
  input 行内 `[text, image]`；费用最多 6 位小数去尾零。
- 其余字节（注释、锚点、凭据行、其他 provider/模型）逐字节不动。

### 21.5 沙箱校验（真实 omp，fail-closed）

- 新文本写入 `<tmp>/agent/models.yml`（沙箱目录 0700，文件 0600，
  Drop 守卫保证 panic 亦清理），跑解析到的 omp 二进制
  （`resolve_omp` 约定）`models --json`，环境 `PI_CODING_AGENT_DIR=<tmp>/agent`
  （不继承用户值），60 秒超时 + 退出后 ≤2 秒收输出
  （`OmpBusy` 最坏持有 62 秒），退出码忽略，用后删除沙箱；
  每路输出上限 8 MiB（超限判失败）。
- 拒绝（`INVALID_INPUT`，固定中文文案）条件任一：
  合并输出含 `validation failed` 或 `Failed to load config file models`；
  输出首个 JSON 的 `models[]` 里没有 `provider/id`；补丁字段
  （name 精确、reasoning 布尔、input 无序集合、窗口/输出、
  费用四数容差 1e-9）与 omp 读回不一致或缺字段。
- omp 输出永不写日志、永不进错误文本（可能含配置警告）。

### 21.6 安全

- 凭据（apiKey 等）永不经 IPC 返回、永不写日志、永不进错误文本；
  前后端类型里没有凭据字段。
- 不整体重排 YAML；不读 `models.json` / `models.db`；测试永不碰真实
  `~/.omp/agent/models.yml`（单测用内存样例 + tempfile，假 omp 脚本覆盖
  沙箱路径；`specs_sandbox.rs` 手动回归只读复制真实文件到 /tmp 写副本）。
- 备份与目标文件均为 0600；备份保留 10 份供手动恢复；
  符号链接与只读目标拒绝写入（不断 dotfiles 布局）。

### 21.7 错误码

- `INVALID_INPUT`（值非法/形状需手动改/沙箱未通过/`revision` 缺失）、
  `CONFLICT`（revision 不一致）、`BUSY`（写门禁被占）、`TIMEOUT`（校验超时）、
  `OMP_NOT_FOUND`（无 omp 可校验，拒绝写入）、`IO`（读/备份/写盘失败）。

### 21.8 前端与 mock

（已删除：以代码为准；类型引用保留）
- `src/types.ts` 镜像 §21.2–§21.3 类型；`src/api.ts` 封装 `getModelSpecs()` /
  `updateModelSpec(req)`（参数透传 `provider/id/patch/expectedRevision`）。

## 22. 管理视图信息架构（`ManageView` 六个标签页）

（已删除：以代码为准）

## 23. Agent 舞台（§4.57–§4.58，`stage/`）

把**一个已存在的会话**（顶层 `<项目>/<文件>.jsonl`）里的主会话、`task` 子代理、
`vibe_spawn` 工作者与 advisor 拼成可视化所需的状态。**只读**：不写任何会话文件、
不向 omp 发信号、不调 LLM；因此界面里没有任何「停止」按钮。

### 23.1 数据来源（全部是既有 jsonl 内容，无新数据源）

- 顶层 jsonl：`session` header（id / version / cwd / timestamp）、`title` 与
  `title_change`、`model_change`、assistant 的 `usage` / `stopReason` / `content`、
  `custom/tool_execution_start`（`data.toolCallId/toolName/args/intent`）、
  assistant `toolCall`（`task.tasks[]` 与 `vibe_spawn.arguments.name`）、
  `custom/vibe-session-lifecycle`（`data.id/action/agent/childSessionFile`）、
  `custom/session_exit`（`data.kind/reason/recordedAt`）。
- 附件目录 = 顶层文件去 `.jsonl` 的同名目录：其中**直接子文件**全部算角色，
  深度 ≥2 的非 `__advisor.jsonl` 也算（按目录关系设 `parentId`）；嵌套
  `__advisor.jsonl` 一律忽略。深度 1 的 `__advisor.jsonl` → `Advisor`；
  `childSessionFile` 命中的 → `Worker`；其余 → `Subagent`。
- **不**用 mtime 或心跳（`model_usage`）判活（与 §17.1 同规则）；`model_usage`、
  `custom_message`、`todo_hud_state` 等行直接忽略。

### 23.2 增量与上限

- 每个文件一个游标 + 状态，最多缓存 4 个会话（LRU）；不在本轮目录列表里的文件项
  当轮丢弃。游标语义与 §17.2 一致：首次/截断重置、末行不完整留待下轮、
  单行 >16 MiB 跳过。
- 附件目录 canonicalize 后必须同时位于 sessionsDir 与附件目录内，否则 `OUTSIDE_ROOT`
  （符号链接在枚举阶段已跳过）。
- 单会话最多展开 200 个附件 jsonl（超出按 mtime 降序保留），丢弃数写入 `omitted`。
- 活动流每角色保留最近 30 条；文本经 `usage::redact::sanitize_message` 脱敏后截断
  （活动 80 字符、派发说明 60 字符）。

### 23.3 状态判定（`stage/derive.rs`，纯函数，按序短路）

`Main`：`!parentInUse` → `done`「已结束」；否则 `working`→`running`、
`waiting`→`idle`「等待输入」、`idle`→`idle`「空闲」、`stuck`→`failed`「疑似卡住」、
未知（轮询器还没见到）→`running`。

`Worker`（按 `child_file` 命中把父会话 lifecycle 的动作传进来；子代理/advisor 恒无动作）：
异常 `exit.kind != normal` 优先 → `failed`（`statusText` 为 `reason`）；文件里已有
`exit.kind == normal` → `done`（worker 会话进程已终结，`turn-settled` 可能尚未落盘）；
`spawn`→`queued`；`turn-started`→`running`（父会话不在用 → `lost`）；
`turn-settled`→`idle`「待命」。

`session_exit` 只在「最后一次」有效：出现更晚的活动行（`session_init`、`model_change`、
任意 `message`、`tool_execution_start`、`vibe-session-lifecycle`、更晚的 `session_exit`）
即作废上一次退出记录——worker/子代理会被 `omp --resume` 恢复（实测
`app-icon.jsonl`：`exit(normal)` 后 18 分钟又 `session_init` 并继续跑），
陈旧的 `exit` 不能把正在运行的角色显示成已完成。`title` / `title_change` /
`model_usage`（心跳）不算活动。

`Subagent`/`Advisor`（无 action 时的 worker 文件不存在分支也走这里）：文件不存在→
`queued`；`exit.kind == normal`→`done`；其它 exit→`failed`；**无 exit、无未配对工具
且最后 stopReason 为 `error`/`aborted`→`failed`（终态，不随父会话是否在用而变化；
例外：`Advisor` 的 `aborted` 是「顾问被重置」的正常机制 → `done`）**；父会话不在用
且无未配对工具、最后一条 assistant 已 `stop` 或无 assistant 记录 → `done`（真实
样本里 advisor 与子代理常缺 `session_exit`，直接判 `lost` 会把已完成的历史会话
显示成全员异常）；父会话不在用且上述终态/干净收尾都不满足 → `lost`「会话已退出」；
无 exit 且无未配对工具、最后一条 assistant 已 `stop`、静默超过 `ORPHAN_DONE_SECS`
（120s）→`done`；其余 `running`。

角色的 `agent`（前端按它选形象、显示配置）：`task.tasks[].agent` → `vibe_spawn` 的
lifecycle `agent` → 省略 agent 的 `task` 调用按 omp 约定记 `task`。孙代理
`<父>/<父>.<子>.jsonl` 的 `name` 去掉重复的父名前缀，`agent`/`brief` 取自**父代理**
tail 里的 `spawn_info`（不在主会话里）。派发说明 `brief` 取值顺序：块级 `intent` →
`arguments.i` → 任务正文（`tasks[].task` / `vibe_spawn.prompt`）第一行有内容的文字
（`# Target` 这类纯标题词跳过）。

`parentInUse = probe.inUse || (!probe.probeOk && 轮询器快照存在)`；header 无 id 时
`parentInUse = 轮询器快照存在`。

### 23.4 / 4.57 `get_agent_stage { path } -> AgentStage`

`path` 经 §6 校验（仅顶层文件）。返回 `actors[0]` 恒为主会话（`id="main"`，
`name="管理员"`），其余按 `startedAt` 升序（缺省排后）、再按 `id`。`current` 仅对
`running`/`idle` 的角色（Main 是 `state != done`）计算：取「最新未配对工具」
（按 `tool_execution_start` 的到达时间），否则（`running` 且最后一条 assistant
未收尾、`stopReason` 不是 `stop`）为 `thinking`。`cost` = Σ assistant
`usage.cost.total`（不含 `model_usage`，与 §12.2 口径一致）；
`contextTokens` = 最近一条非零的 assistant `usage.totalTokens`（缺失时四项相加；
合计为 0 的出错轮次不覆盖已知值）。`current` 对 `done`/`failed`/`lost` 一律为
`null`——已收尾的角色不再显示过期的当前活动（例外：`stuck` 主会话仍在用，
`state=failed` 但照常显示其未配对工具）。
顶层 header 非 v3 → `UNSUPPORTED_FORMAT`；文件不存在 → `NOT_FOUND`。

### 23.5 / 4.58 `list_running_sessions() -> RunningSession[]`

菜单栏轮询器（§17）每轮成功后整体覆盖发布的快照（`Shared::running`）：
`status` 取 `"working"|"waiting"|"idle"|"stuck"`（与中文 `statusText` 一一对应）。
本轮轮询失败不覆盖（保留上一轮），因此该命令永不写盘、永不阻塞。

### 23.6 / 4.59 `list_agent_details() -> AgentDetail[]`（只读）

与 `get_model_config` 同源同序（用户文件缺省 → 内置 unpack（§16.4 顺序），同名用户文件
覆盖默认值但 `source` 仍为 `builtin`；同名匹配按精确名称，大小写不同视为两个 agent），
并多读三个字段：`tools`（`null` = 未声明 → omp 默认工具集；`[]` = 无工具）、
`spawns`（`null` = 未声明；`["*"]` = 任意 agent）、`systemPrompt`（frontmatter
之后的正文，首尾空白已除，超过 64K 字符截断并追加截断标记；带 frontmatter 但无
正文 → 空串）。项目级 `.omp/agents` 不读。
**绝不写 omp 配置**：本命令与 `get_model_config` 共用内置定义缓存，不调用
`set_raw_value` / `update_model_config` / `update_model_spec` / `mcp_*_save`。
内置定义来自 `omp agents unpack --dir <临时目录> --json`（临时目录用完即删）。

### 23.7 前端

- 轮询：`useStagePoll` 单链（同一时刻至多一个请求；隐藏时不排期、恢复可见立即拉一次）；
  `inUse=false` 的会话 10s 一轮（`ENDED_INTERVAL_MS`），回到在用自动恢复 1.5s。
- 形象：按 agent 固定（`DEFAULT_AGENT_CHARS`），用户可在「Agent 库」里逐个覆盖；
  偏好只存 `localStorage`（`omp-resume:stage:v2`，另清掉语义已变的 v1），不写 omp。
- 配置展示：「选中详情」与「Agent 库」共用 `AgentConfigPanel`，全部只读，没有保存入口。
- 在舞台视图里点侧栏会话只切换舞台目标，不离开舞台（看详情走头部「查看会话」）。

## 24. 模型模式（§4.60–§4.63）

> 「模式」= 一整套模型配置的快照，切换即整体改写 omp 全局配置。
> 存储就落在 omp 自己的 `modelPresets` 里，因此终端 `/modelpreset` 与本应用互认。

### 24.1 存储格式

```json
{ "A": { "modelRoles": {"default": "p/m"}, "defaultThinkingLevel": "high",
         "agentModelOverrides": {"task": "p/m"} } }
```

- `modelRoles` / `defaultThinkingLevel` 是 omp 原生字段（`/modelpreset save|switch` 只认这两个）。
- `agentModelOverrides` 是本应用扩展字段：`task.agentModelOverrides` 不随 `modelRoles`
  变化，不快照它切完模式子 agent 仍用旧模型。omp 实测会**原样保留**未知字段，
  但终端 `/modelpreset save` 覆盖同名条目时会丢掉它（已知取舍，UI 用「用当前配置覆盖」修正）。
- 模式名规则与 omp 完全一致：`^[a-zA-Z][\w-]*$`，另加长度 ≤ 64（不支持中文名，为了和终端通用）。
- 条目解析**宽容**：格式问题记进 `ModelPreset.invalidReason`，保留条目以便删除，但不可切换。

### 24.2 写规则（与 §16 同构，另加回滚）

- 一律先校验输入 → `OmpBusy::try_acquire()` → 读当前值 → 与调用方 `expected*` 比对
  （不一致 → `CONFLICT`）→ 写 → 重读返回新状态。
- 切换会写 2–3 个键（`modelRoles` → `task.agentModelOverrides` → `defaultThinkingLevel`），
  每成功一步把旧值压入回滚日志；任一步失败则逆序恢复：
  全成功 → `OMP_FAILED`「切换失败，已恢复原配置：{原因}」；
  恢复也失败 → `OMP_FAILED`「切换失败且恢复原配置失败（{恢复原因}）…：{原因}」。
- 切换前若预设的 `default` 不是 `@`/`pi/` 别名，则用 `list_models` 校验它在可用列表里，
  不在则 `INVALID_INPUT` 且**一个键都不写**（避免切完没有可用主模型）。
- 只写全局配置，不用 `--config` 叠加；不动 `retry.*`、`task.disabledAgents`、`task.agentAdvisor`。

### 24.3 / 4.60 `list_model_presets() -> ModelPresetsState`（只读）

`ModelPresetsState { presets: ModelPreset[], active: string|null,
current: ModelPresetSnapshot, rawPresets: unknown }`。

- `presets` 按名称排序（先比小写再比原文）；`active` = 第一个「角色值逐个相等，
  且（预设带 thinking 时）档位相等，且（预设带 overrides 时）覆盖相等」的有效预设。
- `current` = 同时刻的三份原值（切换时的 expected）；`rawPresets` = `modelPresets` 原值
  （保存/删除时的 expected，未设置时 `{}`）。
- `modelPresets` 形状异常（不是对象/null）→ `OMP_FAILED` 并提示去终端检查；读取失败按未设置处理。

### 24.4 / 4.61 `save_model_preset { name, overwrite, expectedPresets } -> ModelPresetsState`

把**当前**角色模型 + agent 覆盖 + 推理档位存成一条模式。同名且 `overwrite=false` →
`INVALID_INPUT`；当前没有任何角色模型 → `INVALID_INPUT`；`expectedPresets` 过期 → `CONFLICT`。

### 24.5 / 4.62 `switch_model_preset { name, expected: ModelPresetSnapshot } -> ModelPresetsState`

见 §24.2。名称不存在 → `NOT_FOUND`；条目无效 → `INVALID_INPUT`；`expected` 过期 → `CONFLICT`。
托盘菜单走同一实现但**不带** `expected`（`None`）：菜单里的勾选反映的是上一轮状态，
带 expected 会让「刚被终端改过」的场景永远失败。

### 24.6 / 4.63 `delete_model_preset { name, expectedPresets } -> ModelPresetsState`

只删保存记录，不改当前配置。名称只要求非空（允许清理名称不合法的历史条目）；
不存在 → `NOT_FOUND`；`expectedPresets` 过期 → `CONFLICT`。

### 24.7 前端

- `src/modelPresets.ts` 是模块级 store（`useSyncExternalStore`）：首个订阅者挂载、
  **弹层打开**、窗口聚焦时拉取；并发拉取复用同一在途请求。
- 写操作经 `runPresetOp` 串行化（`busy` 期间直接返回）；成功后 `emitModelConfigChanged("presets")`
  让「管理 → 模型」草稿重载（有脏草稿只换基线，草稿不丢）；草稿保存成功后回通知
  （`"draft"`）让模式列表重算激活项。
- 托盘「模式」子菜单由 `spawn_modes_refresher`（30 秒）与三个写命令的
  `tray::publish_modes` 驱动；`MenuModel.modes = None` 表示尚未读到（不显示子菜单）。

## 25. 会话右键菜单的辅助命令（§4.64–§4.67）

> 右键菜单用原生菜单（`src/nativeMenu.ts`），动作分两类：纯前端（复制、置顶、折叠）
> 与需要后端的一条命令。这里只记后端新增的四个。

### 25.1 校验复用

`resume_command_for`、`open_in_iterm` 共用 `resume_target(cfg, path)`：会话路径校验（§6）→
`header_info` 的 `cwd` → cwd 必须是存在的绝对目录且无控制字符 → 会话路径无控制字符。
任何一项不过都返回与 §4.8 相同的错误码，**保证「按钮能开」和「菜单能复制」永远一致**。

### 25.2 / 4.64 `resume_command_for { path } -> string`（只读）

返回 `cd '<cwd>' && omp --resume '<abs path>'`（§4.8 同一生成函数）。
**不做占用探测**：正在运行的会话也需要把命令粘到别处。

### 25.3 / 4.65 `copy_text { text } -> ()`（写系统剪贴板）

走 `/usr/bin/pbcopy` 的 stdin（不拼 shell 命令）。存在理由：WebView 的
`navigator.clipboard` 需要用户激活，而「复制续聊命令」必须先 await 后端取命令，
激活态已丢失 → `NotAllowedError`。前端 `copyText` 先试 `navigator.clipboard`，
失败再落到本命令。

### 25.4 / 4.66 `reveal_session_file { path } -> ()`

`/usr/bin/open -R <path>`（Finder 里选中该 `.jsonl`）。非会话路径 → `OUTSIDE_ROOT`；
含控制字符 → `INVALID_INPUT`（两者都不调用 Runner）；Runner 失败 → `IO`。

### 25.5 / 4.67 `open_project_dir { cwd } -> ()`

`/usr/bin/open <cwd>`。校验与 `new_session_in_iterm` 相同：
非绝对路径/不是目录 → `CWD_MISSING`；含控制字符 → `INVALID_INPUT`；Runner 失败 → `IO`。
