# 功能验收报告（FUNCTIONAL AUDIT）

> 调查日期：2026-11-15 · 仓库 `/Users/chenjing/my/omp-resume`
> 本文只记录缺陷与覆盖证据。本轮不改代码、不新增永久测试（BUG-001 的验证用了已删除的 throwaway 测试）、不发版、不改 README。

## 1. 结论

- **本轮新增确认缺陷 1 条**：BUG-001（Superagent 服务页 socket 行「在 Finder 中显示」必然失败）。工作区真实实现与已安装 0.9.1 的 UI 双向确认。
- **用户已报告缺陷 1 条待定位**：BUG-002（Dock「在 Dock 显示图标」开关）。用户报告作为事实接受，本轮**未定位发生条件**，因此严重度待定、优先排查。
- 缺陷计数口径：**1 条本轮新增确认 + 1 条用户已报告待定位**。不把用户报告当作未证实而忽略，也不把无运行证据的怀疑计入确认缺陷。
- 自动化全绿（2399 用例）**不等于全功能可用**：BUG-001 的错误行为被现有前端测试写成了期望值，套件因此无法发现它。
- 版本边界：
  - 源码 / 工作树版本 `0.9.1`（`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 三处一致）。
  - 已安装 `/Applications/omp-resume.app` 同为 `0.9.1`。**同版本号 ≠ 同构建**：工作树有大量未提交改动，无法证明安装包由当前工作树构建。故：BUG-001 两边都实测过（结论一致）；其余源码层结论只对工作树成立，原生 UI 结论只对已安装构建成立。
  - 本机 `omp` 为 `18.18.2`；应用内速查表基准钉在 `18.16.0`。

## 2. 缺陷总表

| 编号 | 优先级 | 证据状态 | 影响 | 版本范围 |
|---|---|---|---|---|
| BUG-001 | P2 | 已确认：工作区真实实现隔离复现 + 已安装 0.9.1 UI 复现 | 服务页 socket 行的 Finder 按钮 100% 报「文件不存在」 | 工作树与安装版 0.9.1 均复现 |
| BUG-002 | 优先排查（严重度待定） | 用户报告；原生侧现场取样未复现 | Dock 图标开关无用户可感知效果 | 用户报告来自已安装版；发生条件本轮未定位 |

### BUG-001（P2）Superagent 服务页 socket 行「在 Finder 中显示」必然失败

**复现步骤（用户可见）**

1. 启用 Superagent，守护进程运行中。
2. 打开侧栏「Superagent → 服务」，在「路径」区找到 `socket` 行。
3. 点该行右侧「在 Finder 中显示」。

**期望**：在 Finder 中定位该 socket（或该行不提供按钮）。
**实际**：toast「在 Finder 中显示失败：文件不存在：<socket 路径>」，而该路径真实存在。

**证据 A —— 工作区真实实现（隔离复现，本轮执行）**

隔离集成测试直接调用 `omp_resume_lib::ops::commands::reveal_file_impl`（真实产品函数，非抄写逻辑），在临时目录 `UnixListener::bind` 一个 `daemon.sock`；`Runner` 桩在触发 `/usr/bin/open` 时 panic，确保无任何真实副作用。运行输出：

```
PROOF path=/var/folders/.../.tmpXXXX/daemon.sock exists=true is_file=false
PROOF code=NotFound message=文件不存在：/var/folders/.../.tmpXXXX/daemon.sock
test socket_path_rejected_by_reveal_file ... ok
```

**证据 B —— 已安装 0.9.1 原生 UI（原生验收实测）**

守护进程运行中，点 socket 行「在 Finder 中显示」→ toast `在 Finder 中显示失败：文件不存在：/Users/…/superagent/daemon.sock`。文件系统核实：该路径为 `srw-------`，`test -S` 为真、`test -f` 为假 → 确为 Unix socket，不是普通文件。同一页的「日志文件」「omp 可执行文件」两行点击正常返回，无错误 toast。
（截图含真实本地路径，仅留存本地 `/tmp/omp-audit/`，未纳入 `docs/media`。）

**代码位置**

- `src/components/superagent/SuperagentServiceView.tsx:124` — `socketPath` 行标 `isFile: true`。
- 同文件 `:217-235` — `isFile` 为真即渲染按钮，点击调用 `revealFile`。
- `src-tauri/src/ops/commands.rs:396` `reveal_file_impl` — 要求绝对路径、无控制字符、`is_file()`，否则 `NotFound("文件不存在：…")`。
- `src/components/superagent/SuperagentServiceView.test.tsx:82-87` — 现有测试断言「正好 3 个 Finder 按钮」，把错误行为固化为期望。

**根因**：unix domain socket 即使已 bind，`Path::is_file()` 仍为 `false`，必然命中 `NotFound` 分支，与 socket 是否存在无关。

**建议修法（本轮不实施）**：socket 行不渲染 Finder 按钮，或改为「在 Finder 中显示所在目录」（走目录 reveal）；同步修正上述前端断言；CONTRACT §26.4 补一句 socket 行语义（当前未定义，属契约缺口）。

### BUG-002（优先排查，严重度待定）Dock「在 Dock 显示图标」开关

**状态**：用户报告「现在 Dock 显示图标也不显示了」，作为事实接受。原生侧做过状态转换实测，行为与源码设计一致；但**用户报告的发生条件本轮未定位**，因此不算已修复、也不算复现失败。不判定为用户误操作，也不归因到旧版本。

**原生场景验证（已安装 0.9.1，本轮执行；下表是若干独立场景，非连续步骤顺序）**

| 步骤 | activationPolicy | Dock tile | 窗口 |
|---|---|---|---|
| 起始：`showDockIcon: true`，主窗口可见 | 0 (Regular) | 有，图标为正常紫底白 Π | 可见 |
| 设置页关闭开关（读前 `"1"` → 关） | 仍 0 (Regular) | 有 | 仍可见（`apply_settings` 的 `window_visible` 短路） |
| `true` 下点窗口 close（隐藏非退出） | 0 (Regular) | 仍有 | 隐藏 |
| 点 Dock tile | 0 (Regular) | 有 | 窗口回来且 `active=true` |
| 开关为 `false` 后点 close（隐藏） | **1 (Accessory)** | **tile 消失** | 隐藏 |
| `open -a /Applications/omp-resume.app` | 0 (Regular) | 恢复 | 窗口回来 |
| 再点开关 → `true` | 0 (Regular) | 有 | 可见 |

- 结论：`true` + 隐藏 = 保留 Dock 图标；`false` + 隐藏 = Accessory、图标消失；Reopen 路径（`lib.rs:541-545` → `show_main`）强制回 Regular。**与源码设计一致**。
- 结束时 `settings.json` 的 `showDockIcon` 已由同一 UI 复选框恢复为 `true`，UI 回读 `"1"`，其余字段未动；应用进程未重启（同一 pid、未崩溃）。
- 截图（含真实桌面内容）仅留存本地 `/tmp/omp-audit/`，未纳入 `docs/media`。

**已记录的相关源码事实（解释上述行为，非结论）**

- 三个入口共用同一 patch 路径：托盘菜单 `tray.rs:589` `ITEM_TOGGLE_DOCK`、`SettingsView.tsx:199`、`TrayView.tsx:361`。
- `tray.rs:487-500` `hide_main()`：隐藏主窗口后，仅当 `show_dock_icon == false` 才切 `Accessory`。
- `tray.rs:506-560` `apply_settings()`：落盘 + 改内存后，**仅当主窗口不可见**才立即应用激活策略；主窗口可见时切换该开关不产生即时效果，要等下次隐藏窗口（上表第 2 行即此行为）。
- `tray.rs:481` `show_main()` 无条件切 `Regular`。
- 启动路径（`lib.rs` setup）不设置激活策略，策略来自 `Info.plist` 缺省（无 `LSUIElement` → `Regular`）。
- `menubar/dock.rs` 只注入 Dock 右键菜单，不影响图标显示。
- **覆盖缺口**：`show_dock_icon → set_activation_policy` 的生效路径没有任何自动化断言。

**仍未定位的触发条件**：用户是在哪个状态序列下看到图标消失。需覆盖冷启动初始策略、托盘左键面板/右键菜单/blur 自动隐藏、多显示器、Dock 右键菜单——这些本轮均未执行（见 §4）。

## 3. 功能矩阵（17 个可见页面 + 会话详情）

`src/routes.ts` 事实：`Route` 联合 18 项；`NAV_GROUPS` 可见页面 17 个；另 `session` 为详情路由（非侧栏项）。`ConfigRoute` 7 个 = 环境配置 6（models/agents/plugins/skills/mcp/memory）+ bench（工具组）。

覆盖层标注（**可叠加**，不是互斥状态）：

- `N` 原生/真机：已安装 0.9.1 的 AX 读取 + 必要时截图。本列只代表「页面载入 + 所列交互」这一层，不代表未列出的动作通过。
- `A` 后端真实逻辑：Rust 单测/集成，tempdir + 假 omp/iTerm，不碰真实数据。
- `I` 隔离交互：RTL 组件测试，IPC / iTerm / osascript 全 mock。
- `D` 演示层：浏览器 + mockIPC 的真实 DOM 断言（`?mock`），**不代表真实落盘或原生**。
- `—` 本轮未覆盖。

### 3.1 会话列表（sessions）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 扫描 / 按项目分组 / cwd 标记 / 排序 | A + N | `tests/backend.rs::list_sorts_and_cwd_flags`；原生：186 会话、已隐藏 1 空会话、7 运行中，项目折叠与置顶控件状态读数正确 |
| 文本搜索（命中 / 无命中 / 清空） | N + I | 原生：命中收敛到 2 行；无命中「共 0 个 + 没有匹配的会话」；清空恢复「共 186 个」。逻辑侧 `listUtils.test.ts`、`SessionList.meta.test.tsx` |
| 四种状态筛选（全部 / 运行中 / 已置顶 / 有问题） | N + I | 原生：186 / 7 / 2 / 4，计数与侧栏一致。`listUtils.test.ts` |
| 多选 + 批量恢复对话框 + 取消 | D | D1：多选开启后选 2 条，批量对话框显示「恢复 2 个会话 … 已跳过 1 个（使用中 1 个）」，取消后对话框关闭、选择保持 2 条 |
| 别名 / 标签 / 备注写入（revision 冲突、0600、损坏不覆盖、删除联动清理） | A | `src-tauri/src/meta.rs`：`stale_revision_conflicts_and_leaves_file_untouched`、`corrupt_file_is_never_overwritten`、`delete_success_prunes_meta_and_prune_failure_keeps_delete_ok` |
| 备注编辑 → 保存 → 重开读回 | D + I | D2：填入别名/标签/备注并保存，对话框关闭，重新打开三个字段均为保存值（mock 内存态）。`SessionMetaDialog.test.tsx`、`metaOps.test.ts` |
| 删除：占用拒绝提示 | D + A | D5 点删除某在占用会话 → 出现阻断对话框「选中的会话正在被 omp 持有 … 不会删除任何文件」，仅「知道了」。`safety.rs::safety_delete_in_use_child_flock_leaves_bytes`、`DeleteDialog.test.tsx` |
| 删除：确认后取消（未占用会话） | D + A | D5：逐个尝试待删行。占用中的目标 → 阻断框「选中的会话正在被 omp 持有 … 不会删除任何文件」（仅「知道了」）；换到未占用会话 → 出现「永久删除 1 个会话 … 没有废纸篓，也没有撤销 … 取消 / 永久删除」，点「取消」后对话框关闭、会话仍在。`safety.rs` 占用门禁、`DeleteDialog.test.tsx` |
| 空会话 / 标题规则 / fork 隐藏 / 截断落字符边界 | A | `backend.rs::hidden_empty_title_rules_and_fork`、`truncation_on_char_boundary` |
| 非 v3 格式降级 | A + N | `backend.rs::non_v3_degrades`；原生列表出现 v2 会话并带 `v2` 标记 |
| 置顶排序 / 三态勾选 / 选择保持 | I | `pins.test.ts`、`listUtils.test.ts`；存储仅在 WebView localStorage（既有限制） |

### 3.2 会话详情（session）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 三 tab（概览 / 对话 / 树）载入 | N | 原生：概览含标题、cwd、184 条消息、模型、`v3 · 可恢复`、开始时间与时长；对话 798 节点；树 408 节点、1 条活跃分支 |
| 只读对话渲染（text / thinking / toolCall / toolResult / bashExecution / usage / compaction） | A + I + N | `backend.rs::list_tree_conversation_kitchen_sink`；`ConversationView.test.tsx`；原生：`仅工具`/`仅思考` 筛选、展开的思考块、bash 工具块 |
| 按类型过滤（chat / tools / thinking，零用量丢弃） | I + D | `conversationFilter.test.ts`。D3（重跑，正确路径）：详情三 tab 为「概览 / 对话 / 树」；点「对话」后点「思考」筛选，`aria-pressed=true`，对话条数 5 → 3；再点回「概览」，摘要区仍在 |
| 树视图与折叠、节点预览、从此节点分叉入口 | A + I + N | `tree/layout.test.ts`、`tree/fold.test.ts`、`TreeView.test.tsx`；原生：分支点、父/子节点、`从此节点分叉`、内容预览 |
| 分叉预览 → 取消 | D | D4：出现「从节点分叉 … 将追加一个 custom 分支标记 … 原会话不会被改写」，取消后对话框关闭、路由未变 |
| 分支标记 + iTerm 续聊成功判定（命令串、引号、跟踪证据） | A | `ops.rs::marker_end_to_end_branch`、`iterm_resume_requires_tracked_evidence`、`safety.rs::safety_marker_concurrent_appends_no_interleave`、`safety_iterm_hostile_quoting_no_breakout` |
| iTerm 真机续聊 / 聚焦标签 / 新会话开 tab | — | 本轮未执行（会开真实标签页）。历史证据见 `local://resume-verification.md`、`local://review-followups-evidence.md`（非本轮） |
| 单会话用量（fork 链归属、缓存 stamp） | A + I | `usage/` 单测、`Usage.test.tsx`、`usageFormat.test.ts`；原生「本次用量」区块存在 |
| 会话摘要（recap）渲染 | N | 原生：「最近节点 4 / 473」+ 助手/用户片段 + 短 hash |

### 3.3 清理候选（cleanup）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 页面载入、分类计数、阈值输入、排序、删除按钮禁用态 | N | 原生：41 项（空会话 1 / cwd 已删除 4 / 体积大 10 / 久未更新 26），「删除选中」在未选时 disabled |
| 聚合逻辑 | A + I | `src-tauri/src/cleanup.rs` 单测、`CleanupView.test.tsx` |
| 真实数据汇总 | — | `cleanup::tests::real_data_cleanup_summary` 本轮未执行 |

### 3.4 提示词历史（history）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 页面载入、真实条目渲染 | N | 原生：prompt 文本 + 所属项目/时间，可点击 |
| 只读打开（不建库、不改字节） | A | `history.rs::missing_db_is_silent_and_not_created`、`readonly_queries_leave_db_bytes_untouched` |
| 搜索边界：`%`/`_`/`\` 转义、ASCII 大小写、CJK 子串、上限 200、排序 | A | `history.rs::like_wildcards_are_literal`、`search_matches_cjk_substring_and_ascii_case_insensitively`、`search_orders_desc_and_honours_limit` |
| 标题 JOIN 与缺表回落 | A | `history.rs::join_returns_title_and_search_matches_cwd_and_title`、`missing_titles_table_falls_back_to_rows_without_title` |
| 坏 schema / 时间戳越界静默跳过 | A | `history.rs::schema_mismatch_is_silent` |
| 界面搜索 / 项目分段 / 空态 / 跳转来源 | I | `PromptHistoryView.test.tsx`、`historyFilter.test.ts` |
| 真实 history.db 校验 | — | `probe_real_history_db` 本轮未执行 |

### 3.5 Agent Stage（stage）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 页面载入、运行中/回看计数、角色图、诚实提示 | N | 原生：`运行中 2`、`回看会话 2`、`2 个角色：运行 0、完成 1、异常 0`，提示后台 bash 与内部队列不在会话文件内 |
| 状态派生（按序短路） | A | `src-tauri/src/stage/tests.rs` |
| 增量游标（首读 / 截断重置 / 末行留待下轮 / 超长行跳过） | A | `stage/tests.rs::cursor_reads_appended_lines_and_holds_partial_tail`、`cursor_resets_on_truncation`、`cursor_skips_oversized_line_and_empty_lines` |
| 布局 / 精灵 / 场景 / 时间线 | I | `layout.test.ts`、`scene.test.ts`、`timeline.test.ts`、`glyphs.test.ts`、`StageView.test.tsx` |
| Agent 库与角色配置 | I | `AgentLibrary.test.tsx`、`AgentConfigPanel.test.tsx`、`agentCatalog.test.tsx` |
| 已知限制：1.5 s 轮询、看不到后台 bash / 内部队列 | 既有限制 | CONTRACT §23 |

### 3.6 Superagent（3 页 + 守护进程托管）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 管理面板载入（守护进程运行中） | N | 原生：内嵌 6 tab 可读，`待处理工单 0`、`系统问题 2`、真实空态「没有设置智能体的 GitHub CLI」「没有人能发起工作：各来源上的名单都为空」 |
| 管理面板：守护进程未启用时的降级 | D | 演示层：显示「Superagent 未启用 / 守护进程未运行时，管理面板不可用。前往服务页」，与状态相符，无崩溃 |
| 管理面板六 tab | N | 原生：6 tab 入口（overview / source / trigger / eval / execution / settings）可读，未逐 tab 操作 |
| 会话页：无工单时的空态 | N | 原生：显示「该会话还没有记录」，与「待处理工单 0」一致 → 正确空态，不是缺陷 |
| 会话页：列表轮询 / 坏行丢弃 / 只读对话 | I | `SuperagentSessionsView.test.tsx` |
| 服务页载入（状态、pid、启动时间、重启次数、路径五行、日志末尾 200 行） | N | 原生：运行中 / pid / 启动时间 / 重启次数 0；状态目录、socket、日志、资源目录、omp 路径解析正确；日志含 daemon 真实行 |
| 服务页 socket 行 Finder 按钮 | **BUG-001** | §2（两侧复现） |
| 服务页日志 / omp 行 Finder 按钮 | N | 原生：两点均无错误 toast |
| 服务页重启 / 改用新状态目录 / 启用开关切换 | — | 未覆盖（会重启用户守护进程或改状态目录，本轮不做）。组件层有 `SuperagentServiceView.test.tsx`（IPC mock） |
| 状态目录按通道、debug seed、socket 长度回落 | A | `superagent/paths.rs` 单测、`config.rs::extra_root_follows_state_dir_channels` |
| 启停 / 退出码 3 不重启 / 孤儿接管 / pid 校验 / 退避上限 | A | `supervisor.rs`：`start_stop_lifecycle_with_real_child`、`exit_code_3_does_not_restart`、`reclaim_orphan_kills_verified_pid_and_starts`、`reclaim_refuses_recycled_pid` |
| schema 预检与一键归档恢复 | A | `supervisor.rs` schema 守卫、`superagent_reset_state` 参数校验 |
| 日志轮转与 tail 行数校验 | A | `supervisor::open_log_rotates_over_5mib`、`last_log_line_reads_tail_only`、`superagent_log_tail` 1..=2000 |
| HTTP 代理（方法白名单、`..`/`%2e%2e`/非法转义、32 MiB、超时映射） | A | `superagent/proxy.rs` 单测 |
| 真实工单执行（GitHub / Feishu → 真实 worker） | — | 未执行（会在外部产生工单与评论） |

### 3.7 环境配置（models / agents / plugins / skills / mcp / memory）

| 页面 | 子功能与覆盖层 | 证据 |
|---|---|---|
| models | 载入（模型测试 / 模型库 / 角色分配 / 主要模型 / 兜底）`N` | 原生：536 节点全部渲染 |
| models | 添加模型对话框 → 取消 `D`；编辑/切换页面保留 `—` | D6：对话框显示「添加模型 … 只能加入已有提供方 …」，取消后关闭、路由未变。切页保留本轮未执行 |
| models | 模型库 / 草稿 / 配置写（revision + 回滚）`A`+`I` | `omp_models.rs`、`model_presets.rs`、`model_specs/tests.rs`；`ModelsTab.test.tsx`、`modelConfig.test.ts`、`modelDraft.test.ts`、`ModelSections.test.tsx` |
| models | 真实 `models.yml` 往返 `—` | `real_models_yml_copy_roundtrip` 本轮未执行 |
| agents | 载入 + 空态 `N` | 原生：526 节点，含「还没有兜底模型」空态 |
| agents | 组织树 / 角色卡 / 新增 / 库筛选 `I` | `AgentsTab.test.tsx`（角色卡、组织树、库）、`roleCards.test.ts`、`agentCatalog.test.tsx`、`AgentLibrary.test.tsx`、`AgentConfigPanel.test.tsx` |
| plugins | 载入 + 只读 npm 段 `N` | 原生：`插件 / npm 插件（只读）/ 添加 Marketplace`，`暂无 npm 插件` |
| plugins | 列表 / 发现 / 安装 / 卸载 / 启停 / 升级 / marketplace `I` | `ompPlugins.test.ts`、`PluginsPanel.test.tsx`、`src-tauri/src/omp_plugins.rs` 单测。真实 `omp plugin` 执行为 `—` |
| skills | 载入 `N`；列表与更新 `I` | 原生：`已安装技能`，157 节点。`SkillsPanel.test.tsx`。真实安装/更新为 `—` |
| mcp | 载入 `N`；添加对话框：取消 `D`、坏 JSON 校验 `D`；读写/revision/0600/未知字段保序/占位值拒绝/密钥不外泄 `A` | 原生 225 节点。D7：对话框「添加 MCP 服务器 … 字段白名单校验，并携带 revision」，取消后关闭。D7b：填名字 + 配置写 `{ bad json` 后点保存，对话框**不关闭**并就地报「JSON 格式不正确：Expected property name or '}' in JSON at position 2」，再取消可关闭（未写入新服务器）。`mcp_config.rs`（`list_masks_nothing_and_leaks_no_secret_values`、`rejects_stale_revision_and_invalid_json_without_writing`、`save_preserves_unknown_content_order_and_existing_permissions`）、`McpPanel.test.tsx`、`mcp.test.ts` |
| memory | 载入 `N`；搜索有/无命中与清空恢复 `D`；库删除预览 → 取消 `D`；详情/备份/恢复/写入门禁 `A` | 原生 177 节点。D8：搜索无命中「没有匹配的项目库。」，清空后列表与计数恢复。D8b：`记忆库` 页有两个删除入口——「移除此库…」弹「移除项目库（omp-resume）… 会先备份并移到备份区 … 取消 / 移除此库」，「清理无效库…」弹「清理无效库 … 将移除 2 个库、共 3 条记忆 … 取消 / 备份并移除 2 个库」；两者点「取消」后关闭、未执行。记忆**条目级**详情内的删除预览入口在演示 fixture 中不存在（列表项只有查看来源/复制片段），故条目级预览未覆盖。`memory.rs`、`memory_write.rs`（`preview_equals_delete_and_purges_both_kinds`、`recount_mismatch_rolls_back`、`restore_roundtrips`、`restore_failure_rolls_back`、`gate_refuses_writes_when_held`）、`MemoryMaintenance.test.tsx` |
| memory | 条目级删除预览 → 取消 | — 未覆盖：演示 fixture 的条目行无删除入口（只有查看来源会话 / 复制片段） |
| memory | 备份 → 恢复 | — 未覆盖（本轮未点这些写操作） |
| memory | 真实 Mnepi 库只读与副本写入 | — `real_data_readonly`、`e2e_on_real_copy` 本轮未执行 |

### 3.8 工具（cheatsheet / bench）

| 页面 | 子功能与覆盖层 | 证据 |
|---|---|---|
| cheatsheet | 载入 + 5 个学习路径 + 复制按钮存在 `N` | 原生：799 节点 |
| cheatsheet | 搜索过滤 `D` | D10：输入 `resume` 后 meta 变为「匹配 2 / 142 条」 |
| cheatsheet | 复制按钮实际写入剪贴板 | — 未覆盖（演示层未验证剪贴板内容） |
| cheatsheet | 命令注册表 / 详情 / 组合 / 学习路径数据一致性 | `I`：`ompCommands.test.ts`、`ompCommandDetails.test.ts`、`ompCombos.test.ts`、`CheatSheetView.test.tsx` |
| bench | 载入 + 空态 + 成本提示，**未发起真实调用** `N`+`D` | 原生：「还没有测试数据，点「测试全部」跑一轮…」。演示层：页面显示「≈$0.24」「一键推荐」「延迟探针 5×100 · 吞吐探针 3×600」，`测试全部` 存在但**未点击**（会触发付费调用） |
| bench | 记录 / 历史 / 删除 / 性能列表逻辑 | `A`+`I`：`model_bench.rs` 单测、`modelBench.test.ts`、`BenchTab.test.tsx` |

### 3.9 设置（settings / tray）

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 外观页载入 | N | 原生：215 节点 |
| 主题切换 → 恢复 | D | D12：`dark → light → dark`，偏好写入 `localStorage["omp-resume:appearance"]` |
| 外观偏好（主题 / 强调色 / 密度）逻辑 | I | `appearance.test.ts`、`SettingsView.test.tsx` |
| 菜单栏页载入（Dock / 通知 / 面板宽度控件） | N | 原生：193 节点 |
| 菜单栏设置：徽标样式 / 标题宽度 / 行内容 / 点击行为 / 搜索框 / 通知开关 | I | `TrayView.test.tsx`、`menubar/settings.rs` 单测（`patch_rejects_unknown_keys_and_applies_only_given`、`legacy_show_cost_key_is_ignored`、`legacy_menu_click_action_migrates_to_panel`） |
| 设置落盘（0600、损坏回落不覆盖、legacy 继承） | A | `menubar/settings.rs` 单测 |
| 分类器 / 菜单模型 / 通知判定（30 s 门槛、30 s 防抖、>3 合并、stuck 每 episode 一次） | A | `classify.rs`、`menu.rs`、`notify.rs`、`poller.rs`（`busy_duration_gates_waiting_notification`、`first_sight_stuck_notifies_once`） |
| 轮询降级（owners 不可读保留旧菜单、未知锁不归属、非 iTerm 行不可聚焦） | A | `poller.rs::owners_unreadable_keeps_old_menu`、`unknown_lock_is_unattributed`、`non_iterm_row_not_focusable` |
| Dock 图标开关：开关 + 隐藏/恢复的状态转换 | N + **BUG-002** | 原生实测 7 步（见 §2 BUG-002）：关开关后隐藏 → Accessory + tile 消失；`true` 下隐藏 → 保留；`open -a` → Regular 并恢复窗口；结束时恢复为 `true`。无自动化断言；用户报告的发生条件未定位 |
| Dock 右键菜单 / 角标 / 跳动 | — | 本轮未执行（需原生菜单交互与通知投递） |
| 托盘面板定位 / blur 守卫 | — | 未覆盖（需真实窗口管理器） |
| 应用内更新：检查 | — | 未执行（原生与演示层均未点；不预设会安装或退出） |
| 应用内更新：下载 / 安装 / 重启 | — | 未执行（会安装软件并退出应用） |
| 更新 UI 逻辑 | I | `update.test.tsx`、`OmpUpdateDialog.test.tsx` |

### 3.10 壳层与跨页能力

| 子功能 | 覆盖层 | 证据 |
|---|---|---|
| 17 个侧栏页面导航与返回 | N | 原生：逐页点开，每页 heading 与节点数见 §3.1–3.9 |
| 路由 / 返回 / 快捷键 / 标题与面包屑 | I | `App.test.tsx` |
| 全局搜索（命令面板） | I | `shell/CommandPalette.test.tsx`；原生可见「搜索会话与页面 ⌘K」按钮，未逐一验证面板行为 |
| 原生菜单事件 → 路由跳转 | I | `App.tsx` `onOpenMainRouteRequest` |
| 设置类路由常驻（切 tab 保留缓存与写入门禁） | I | `ManageView.test.tsx` |
| 错误边界与错误归一化 | I + A | `ErrorBoundary.test.tsx`、`api.test.ts`、`tests/contract.rs::tauri_commands_match_api_wrappers` |
| 演示后端覆盖所有路由 | I | `dev/mockCoverage.test.ts`、`dev/superagentMock.test.ts` |
| 删除 / 分叉 / 占用 / 路径逃逸 / 符号链接 / 并发标记 | A | `tests/safety.rs`（26 例） |
| 通用「在 Finder 中显示」 | A | `ops.rs::reveal_file_accepts_only_absolute_existing_files` |
| 17 页全部动作逐一验收 | — | 未覆盖：原生做了 17 页载入 + §3.1/3.2 列出的交互；其余页面动作见各页行 |

## 4. 未验证事项（条件与原因）

| 项 | 条件 |
|---|---|
| BUG-002 的剩余触发条件 | 已实测开关 + 隐藏/恢复序列；**未测**：冷启动初始策略（需重启应用）、托盘左键面板 / 右键原生菜单 / blur 自动隐藏、多显示器、Dock 右键菜单 |
| Dock 右键菜单 / 角标 / 跳动 | 需原生菜单交互与通知投递（点 Dock tile 回主窗口本轮已用 AXPress 验证，见 §2） |
| 托盘左键面板 / 右键原生菜单 / blur 自动隐藏 / 多显示器 | 本轮未执行：隐藏期间无法稳定定位状态项，且不反复试探用户配置 |
| iTerm 续聊 / 聚焦标签 / 新会话开 tab | 需真实 iTerm2 与自动化授权，会开真实标签页 |
| `omp` 更新检查 / 安装 / 重启 | 检查本身只读；本轮未执行。安装会改用户环境，需明确授权 |
| 应用自身 updater（下载 / 安装） | 需发版私钥与 CI 产物 |
| bench 真实模型调用 | 付费外部 API（页面已提示 ≈$0.24/轮） |
| Superagent 真实工单执行 | 会在 GitHub/Feishu 产生工单与评论 |
| Superagent 真实状态目录写入操作 | 点「改用新状态目录」「重启」会重启用户守护进程，本轮未做 |

## 5. 演示层交互验证（浏览器 + mockIPC，仅演示）

`npm run dev` + `?mock`：`src/main.tsx` 仅在 DEV 且 URL 带 `mock` 参数时动态装载 `src/dev/mockBackend.ts`，把 IPC 接到内存态。
**这是演示 IPC 交互，不是真实落盘、不是原生、不是 Tauri 运行时。** mock 不校验 user scope 的 `project` 参数；revision 是规范 JSON 的 SHA（真后端是文件原始字节的 SHA）。套件已覆盖的细粒度逻辑不在本层重测。

独立标签 `functional-audit-mock`，viewport 1440×900，全部断言基于 DOM 读取（含可见文本、`aria-pressed`、`role="dialog"` 内容）。按下表记录最终成功与受限结果（个别流程补验过实际路径，表内为准）。

### 5.1 演示结果（实际执行）

| # | 流程 | 结果 | DOM 证据 |
|---|---|---|---|
| D1 | 会话列表多选 → 批量恢复对话框 → 取消 | **通过** | 多选开启后选中 2 条（`aria-pressed=true`）；对话框「恢复 2 个会话 … 已跳过 1 个（使用中 1 个）」；取消后 `[role=dialog]` 消失，仍保持 2 条选中 |
| D2 | 备注填别名/标签/备注 → 保存 → 重开 | **通过** | 保存后对话框关闭；重开读到 `["audit-alias","审计, mock","audit-note-1"]` |
| D3 | 详情三 tab → 「对话」→ 思考筛选 → 回概览 | **通过** | tab 名为「概览 / 对话 / 树」；点「思考」后 `aria-pressed=true`，对话条目 5 → 3；回概览后「会话摘要」仍在 |
| D4 | 分叉预览 → 取消 | **通过** | 对话框「从节点分叉 … 追加一个 custom 分支标记 … 原会话不会被改写」；取消后关闭，路由未变 |
| D5 | 删除：占用拒绝 + 未占用会话确认后取消 | **通过** | 占用中的会话 → 阻断框「选中的会话正在被 omp 持有 … 不会删除任何文件」（仅「知道了」）；换未占用会话 → 「永久删除 1 个会话 … 没有废纸篓，也没有撤销 …」含「取消 / 永久删除」，点「取消」后关闭、会话保留 |
| D6 | 模型 → 添加模型对话框 → 取消 | **通过** | 对话框「添加模型 … 只能加入已有提供方」；取消后关闭，路由不变 |
| D7 | MCP → 添加服务器：取消 + 坏 JSON 保存 | **通过** | 取消路径：对话框关闭。校验路径：填名字 + 配置写 `{ bad json` 后点保存，对话框**不关闭**并就地提示「JSON 格式不正确：Expected property name or '}' in JSON at position 2」，随后取消关闭、未新增服务器 |
| D8 | 记忆库搜索 + 库删除预览取消 | **通过（含一处未覆盖）** | 搜索无命中「没有匹配的项目库。」，清空后列表与计数恢复。「移除此库…」→「移除项目库（omp-resume）… 会先备份并移到备份区 … 取消 / 移除此库」；「清理无效库…」→「将移除 2 个库、共 3 条记忆 … 取消 / 备份并移除 2 个库」；两者取消后关闭、未执行。**条目级**删除预览：演示 fixture 的条目行只有「查看来源会话 / 复制片段」，无删除入口 → 未覆盖 |
| D9 | Superagent 管理面板（未启用）/ 服务页 | **通过（仅降级态）** | 管理面板显示「Superagent 未启用 … 管理面板不可用。前往服务页」（与 mock 状态一致、无错误 banner、15 节点）；服务页载入无错误（84 节点）。演示 mock 未启用守护进程，六 tab 内容层在演示中**未覆盖**（原生侧已确认六 tab 可读，见 §3.6） |
| D10 | 速查表搜索 | **通过** | 输入 `resume` → meta「匹配 2 / 142 条」 |
| D11 | 模型测试页（不发起调用） | **通过（仅载入）** | 页面含「测试全部 ≈$0.24」「延迟探针 5×100 · 吞吐探针 3×600」；`测试全部` **未点击** |
| D12 | 主题切换 → 恢复 | **通过** | `data-theme`: `dark → light → dark`；偏好键 `omp-resume:appearance` |

未达成的项已标注为「仅降级态 / 未覆盖」，没有占位或推定通过。演示层全部为 mock 内存态，**不代表真实落盘或原生行为**。

## 6. 自动化检查记录（一次运行，未重跑）

| # | 命令 | 结果 | exit |
|---|---|---|---|
| C1 | `npm run check` | `superagent:build`(tsdown) OK；`tsc --noEmit` OK；`tsc -p tsconfig.node.json` OK；vitest **81 files / 732 tests passed**；`superagent:typecheck` OK；superagent vitest **53 files / 1130 tests passed** | 0 |
| C2 | `cargo test --offline` | **537 passed / 0 failed / 16 ignored** | 0 |

合计 **2399 passed**，0 失败，16 忽略（清单见 §6.2）。

### 6.1 Rust 各 suite

| suite | passed | ignored |
|---|---|---|
| lib 单测 | 456 | 6 |
| backend.rs | 11 | 1 |
| contract.rs | 1 | 0 |
| fixtures.rs | 0 | 1 |
| history.rs | 11 | 1 |
| memory.rs | 10 | 1 |
| memory_write.rs | 12 | 1 |
| menubar_probe.rs | 0 | 1 |
| meta_smoke.rs | 0 | 1 |
| models_sandbox.rs | 0 | 1 |
| ops.rs | 10 | 1 |
| safety.rs | 26 | 0 |
| specs_sandbox.rs | 0 | 1 |
| main.rs / doc-tests | 0 | 0 |

### 6.2 16 条 ignored 测试（原样枚举，本轮未执行）

```
cleanup::tests::real_data_cleanup_summary
model_bench::tests::bench_smoke_real_agent_db
ops::iterm::tests::smoke_new_session_real
ops::iterm::tests::smoke_open_tab_echo_and_close
ops::iterm::tests::smoke_resume_failure_real
ops::iterm::tests::smoke_resume_real
real_data_validation            (tests/backend.rs)
fixture_manifest_check          (tests/fixtures.rs)
probe_real_history_db           (tests/history.rs)
real_data_readonly              (tests/memory.rs)
e2e_on_real_copy                (tests/memory_write.rs)
live_pipeline_once              (tests/menubar_probe.rs)
real_roundtrip_write_0600_and_delete_prune     (tests/meta_smoke.rs)
real_home_readonly_summary_then_sandbox_write_smoke (tests/models_sandbox.rs)
smoke_marker_real               (tests/ops.rs)
real_models_yml_copy_roundtrip  (tests/specs_sandbox.rs)
```

本轮未执行这些测试，不推断其通过或失败的原因；需要结论须单独授权运行。

## 7. 静态待验风险（无运行证据，不作为缺陷）

| 编号 | 风险 | 位置 | 待验方式 |
|---|---|---|---|
| R-01 | 速查表终端子命令表钉在 18.16.0（51 条）；本机 `omp 18.18.2 --help` 列 54 条（多 `bash`/`sh`/`zsh`），表内无多余条目；页面上「内置 88 条 / 142 条」等计数也是手写静态值，同源 | `src/ompCliCommands.ts`、`src/ompCommands.ts`、`CheatSheetView.tsx` | 用 18.16.0 二进制对比即可定论；当前已有版本不匹配横幅，最多是信息缺口 |
| R-02 | `image` 内容块（`blob:sha256:` 引用）可能不渲染 | `src/types.ts` 的 `AssistantBlock` 无 image 分支；`sessions/conversation.rs` 未见映射 | 用含 image 块的 fixture 跑一次 `get_conversation` |
| R-03 | 服务页「日志文件」行在日志尚不存在时同样会 `NotFound`（与 BUG-001 同一门禁） | `SuperagentServiceView.tsx` + `reveal_file_impl` | 在从未启动过的状态目录下点一次 |

CONTRACT §17.9 已把 Dock 右键菜单的注入失败（`class_addMethod` 返回 false 或 delegate 被替换，仅打 stderr）记为**设计风险**，不是本次新缺陷，故不重复列入。

## 8. 文档缺口（非功能缺陷）

- README 统计与实测不符：README 写前端 731 tests / Rust 523 tests；实测 732 / 537（+16 ignored）。属文档漂移，本轮不改 README。
- CONTRACT §26.4 未定义 Superagent 服务页 socket 行是否应提供 Finder 入口（BUG-001 的契约缺口）。

## 9. 证据索引（本地）

| 内容 | 位置 |
|---|---|
| `npm run check` 完整日志 | `/tmp/faudit/check.log` |
| `cargo test --offline` 完整日志 | `/tmp/faudit/cargo.log` |
| BUG-001 工作区真实实现复现输出 | 本文 §2 证据 A（临时测试已删除，未留在仓库） |
| BUG-001 安装版 UI 复现截图（含真实路径，仅本地留存） | `/tmp/omp-audit/sa-service-socket-reveal-fail.png` |
| 原生逐页与详情实测明细 | `local://functional-native-audit.md` |
| Dock 状态转换实测与恢复记录 | `local://functional-native-final-state.md` |
| iTerm 续聊历史验证（非本轮） | `local://resume-verification.md`、`local://review-followups-evidence.md` |
| 演示层结果 | 本文 §5.1 |
