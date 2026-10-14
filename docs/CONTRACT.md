# omp-resume 契约（CONTRACT）

> 权威规格。本文 + `src-tauri/src/model.rs` + `src/types.ts` + `src/api.ts`
> 四者互相一致；冲突时以本文为准，并同步修正另三处。
> 后端实现时**不得**另起一套命名或语义，只能填充本文规定的行为。

产品：macOS-only 原生桌面应用（Tauri 2 + React + TS + Vite + Rust），中文 UI。
管理 `omp`（oh-my-pi，`~/.local/bin/omp`，v18.10.3）的会话。v1 仅含：
会话浏览（按项目分组）、只读会话预览、树视图、iTerm 一键续聊、
永久删除、从树节点续聊。无重命名、无 fork 建文件、无导出、无统计、
无监控、无全文搜索、无多 profile、无回收站。

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

## 1. 配置解析

- `sessionsDir`：CLI 参数 `--sessions-dir <path>` >
  环境变量 `OMP_RESUME_SESSIONS_DIR` > `$HOME/.omp/agent/sessions`。
- `ownersDir`：环境变量 `OMP_RESUME_OWNERS_DIR` >
  `$HOME/.omp/run/session-owners`。
- `get_config() -> { sessionsDir, ownersDir }` 返回解析后的绝对路径。
- 启动参数由 `main.rs` 解析后存入 Tauri `State`（实现细节，后续 worker 定）。

## 2. 会话文件格式（实测，已验证）

### 2.1 存放布局

`<sessionsDir>/<编码cwd>/<UTC时间>_<uuid>.jsonl`，例如
`-my-omp-resume/2026-10-14T02-18-47-387Z_01a13834-80db-70cb-83b5-2f528fc1d96c.jsonl`。

- 每个 `.jsonl` 旁有一个**同名去扩展 sibling 目录**（artifacts + 子 agent
  嵌套 `*.jsonl`，扫描时必须忽略，只扫顶层）。
- 同目录有点文件 `.<name>.jsonl.lock.os`（omp 发布锁，忽略）。
- 可能有 `<name>.jsonl.<snowflake>.bak` 残留（EPERM 重写遗留，扫描忽略，
  删除时清理）。
- 扫描规则：只取各项目目录**顶层**、非点文件、`*.jsonl`；
  忽略嵌套目录、点文件、`.bak`。
- 本机实测：11 个项目目录、46 个顶层会话、约 120 MB，最大约 4 MB，
  header `version` 全为 3。

### 2.2 行类型

首行可选 `title` 记录（固定宽度槽位，改名时原地重写，无 id）：

```json
{"type":"title","v":1,"title":"🎛️ DEMO: ...","source":"auto","updatedAt":"2026-10-14T02:33:40.897Z","pad":"   ..."}
```

注意 `source` 可缺省（实测有缺 `source` 的 title 行）。`title` 可为空字符串。

第二行是 `session` header（`version:3`，`id` 即会话 id，`cwd` 为项目真实路径）：

```json
{"type":"session","version":3,"id":"01a13834-...","timestamp":"2026-10-14T02:18:47.387Z","cwd":"/Users/chenjing/my/omp-resume"}
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
  但本机磁盘文件一律为 `<session-id>.lock`（140 个），以后缀为准。
- 探测：对该文件 `flock(LOCK_EX|LOCK_NB)`。
  `EWOULDBLOCK` → `inUse:true`；文件不存在或加锁成功（立即释放）→
  `inUse:false`；其他失败（权限等）→ `probeOk:false, inUse:false`。
- 会话 id 取自 header.id；id 解析不出 → `probeOk:false`。
- 本机验证时 140 个锁文件中有 10 个被持有（含当前正在运行的会话）。
- 只读打开（share/export/预览）不占租约——我们的读/探测都不写文件，
  唯二写操作是删除与 marker 追加，且都先拒绝 `inUse`。

## 4. 命令

### 4.1 `get_config() -> { sessionsDir, ownersDir }`

返回 §1 解析后的绝对路径。无参数，不失败（目录不存在也不报错，
由各命令在实际访问时报 `IO`/`NOT_FOUND`）。

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

### 4.7 `append_branch_marker { path, nodeId } -> { markerId }`

- 拒绝：`inUse` → `IN_USE`；`probeOk:false` → `PROBE_FAILED`；
  `nodeId` 非保留节点 → `INVALID_NODE`；
  文件末尾非 `\n` 结尾 → `IO`（防半行追加；omp 正常写入恒为整行）。
- `nodeId` 已是 leaf → **无操作**，返回 `{ markerId: null }`。
- 否则以 `O_APPEND` 单次写入追加恰好一行：
  `{"type":"custom","customType":"omp-resume-branch","id":<8位小写十六进制，文件内唯一>,"parentId":<nodeId>,"timestamp":<ISO-8601 UTC毫秒>,"data":{}}`
  末尾含 `\n`。id 碰撞则重抽（以 omp 的 8-hex / Snowflake 回退惯例为准）。
- 安全性（已对 omp 文档验证）：
  `customType:"omp-resume-branch"` 为命名空间值，
  核心重建视为不透明，不进入模型上下文（§2.4）；
  字段名与 `custom` 条目完全一致。resume 后该 marker 只是树上一个
  被跳过的自定义节点，其子（新续聊内容）挂在其下——这正是「从该节点续聊」。
- 追加后该文件 leaf 变为 marker（它是文件末行）；
  用 `omp --resume <path>` 打开即从该分支继续。

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

## 5. 建树算法（`list/get_conversation/get_tree` 共用）

1. 逐行解析；坏行计数跳过。首行 `title` 与 `session` header 不入树。
2. 无字符串 `id` 的行跳过（不计坏行——形状合法但无链接能力）。
3. kept 判定与 label 收集（§2.7）；`parentId` 指向 kept 节点则挂载，
   否则沿 `parentId` 链上溯找最近 kept 祖先（经跳过节点），
   找不到 / 遇到 null / 环 → 根。
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
| `UNKNOWN` | **仅前端**：传输层或未预期失败的归一化（后端永不产生） |

`AppError { code, message }`；`message` 为中文人类可读。

## 8. 类型文件

- `src-tauri/src/model.rs`：serde 权威定义（含 `AppResult<T>` 与 3 个
  序列化单测）。`Option` 字段序列化为 null（不明缺省，保持全字段）。
- `src/types.ts`：逐字段镜像（`Option<T>` → `T | null`，
  `u64/usize` → `number`，`Value` → `unknown`）。
- `src/api.ts`：每命令一函数 + `normalizeError`。
  后端 `invoke` 拒绝值即 `AppError` 形状；未知形状降级 `UNKNOWN`。

## 9. 常量

| 常量 | 值 | 用途 |
|---|---|---|
| `MAX_TEXT_BYTES` | 8000（UTF-8 字节，字符边界截断，尾加 `…[已截断]`） | toolResult / bashExecution 文本 |
| `TITLE_FALLBACK_CHARS` | 60 | 无标题时首用户消息截断 |
| `FIRST_USER_MESSAGE_CHARS` | 200 | `firstUserMessage` 字段 |
| `OTHER_TEXT_CHARS` | 2000 | `other` 条目文本 |
| `TREE_PREVIEW_CHARS` | 80 | 树节点 preview |
| `MARKER_CUSTOM_TYPE` | `omp-resume-branch` | 分支标记 customType |
| `UNTITLED` | `(无标题)` | 无标题兜底 |

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

## 附录 A. 真实条目示例（节选，已脱敏截断）

title 首行（注意无 `source` 的变体存在）：

```json
{"type":"title","v":1,"title":"","updatedAt":"2026-10-12T07:38:04.760Z","pad":"   ..."}
{"type":"title","v":1,"title":"🎛️ DEMO: Build a visual config desktop app","source":"auto","updatedAt":"2026-10-14T02:33:40.897Z","pad":"   ..."}
```

fork 血缘 header（`parentSession` 为 id，`previousSessionFiles` 为路径数组，
二者语义不同）：

```json
{"type":"session","version":3,"id":"01a134fa-...","timestamp":"...","cwd":"/Users/chenjing/my","title":"🚂 DEMO2: ...","titleSource":"auto","parentSession":"01a134a7-...","providerPromptCacheKey":"01a134a7-..."}
{"type":"session","version":3,"id":"01a12ecf-...","timestamp":"...","cwd":"/Users/chenjing/my/Obsidian-doc","title":"🦙 DEMO3: ...","titleSource":"auto","previousSessionFiles":["/Users/chenjing/.omp/agent/sessions/-my-tuozu-mcp-project/2026-10-12T06-31-48-446Z_01a12ecf-....jsonl"]}
```

assistant（含 thinking + toolCall 块）与 toolResult 紧邻对：

```json
{"type":"message","id":"25472e7f","parentId":"27f428d0","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"...","thinkingSignature":"...","summary":false},{"type":"toolCall","id":"call_1a9b...","name":"read","arguments":{"path":"...","i":"..."},"partialArgs":"..."}],"stopReason":"stop",...}}
{"type":"message","id":"0b708322","parentId":"eca87a7f","timestamp":"...","message":{"role":"toolResult","toolCallId":"call_1a9b...","toolName":"read","content":[{"type":"text","text":"# Clash Verge ..."}],...}}
```

bashExecution（无 content 数组）与 developer：

```json
{"type":"message","id":"205852e4","parentId":"55e13298","timestamp":"...","message":{"role":"bashExecution","command":"cd /Users/chenjing/my/Obsidian-doc","output":"","exitCode":0,"cancelled":false,"truncated":false,"timestamp":1791793713325,"excludeFromContext":false}}
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

- `compaction` / `branch_summary` / `label` / `session_init` /
  `ttsr_injection` 本机无实例，形状与挂载语义以 omp 文档为准；
  首次遇到真实数据时以后端单测锁定。
- `custom_message` 在全量 162 行中均有 `id`（早期抽样疑似缺 id 系长行截断误读），
  但解析仍须容忍无 id 行（跳过，不计坏行）。
- 锁文件名后缀 `.lock` 以本机磁盘为准；omp 文档写作无后缀，
  如遇上游变更以后端探测单测为准。
- `open_in_iterm` 用 bare `omp`（走 PATH）；若用户 PATH 无 omp，
  后续 worker 可在 CONTRACT 修订中改用 `~/.local/bin/omp` 兜底。
