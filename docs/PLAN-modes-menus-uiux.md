# 模型模式切换 + 会话右键菜单 + ui-ux-pro-max 视觉升级

## Context

用户提了三个需求：
1. 增加 agent 模型「模式」切换：切到模式 A 就用 A 的整套模型配置（角色模型、各 agent 的模型、默认推理档位），切到 B 就用 B 的。
2. 当前 UI 太素，吸引不了用户。设计 skill 用 **ui-ux-pro-max**（上游 nextlevelbuilder/ui-ux-pro-max-skill；open-design 目录里的同名条目只有元数据，所以必须装上游完整包），本机尚未安装。由它指导并验收一轮视觉升级。
3. 会话列表增加右键快捷菜单。功能与交互已定，见 Phase B。

硬性要求：代码健壮。每条新路径都要处理空、缺失、冲突、并发、出错的情况，并有行为级测试覆盖。

最终状态：
- 侧栏底部和菜单栏托盘都能看到并切换模式，切换写入 omp 全局配置。
- 会话行和项目组头有原生右键菜单。
- 全应用使用统一的 SVG 图标与设计 token，窗口为统一标题栏加半透明侧栏。

## Facts (verified this session)

- **omp 18.12.6 原生预设**（`~/.local/bin/omp`）：配置键 `modelPresets`（record，本机当前为 `{}`）。
  - 条目校验只读 `modelRoles`（必须是映射，每个值必须是非空字符串）和可选的 `defaultThinkingLevel`，其他字段被忽略。
  - 名称正则：`^[a-zA-Z][\w-]*$`。
  - `/modelpreset save` 会把整个条目覆盖成 `{modelRoles, defaultThinkingLevel}`。
  - `/modelpreset switch` 先校验 `default` 模型可用，再写回 `modelRoles`。
  - 激活判定：当前非空 `modelRoles` 与预设 `modelRoles` 键集合相同且值逐个相等；若预设带 `defaultThinkingLevel`，还要与当前值相等。按名称排序后取第一个命中的。
- `defaultThinkingLevel` 是独立配置键，枚举 `minimal|low|medium|high|xhigh|max|auto`，本机当前为 `high`。
- `task.agentModelOverrides`（task/sonic/scout/reviewer/security-reviewer）的值都是具体 selector，**不随** `modelRoles` 变化。所以「模式」必须同时快照它，否则切换后子 agent 仍用旧模型。
- `PI_CODING_AGENT_DIR=<dir> omp config path` 打印 `<dir>`，说明该环境变量能把 omp 配置完全隔离到沙箱目录。
- app 写 omp 配置的统一路径（`src-tauri/src/omp_models.rs`）：
  - 底层函数：`get_raw_value`、`get_shaped_value`、`set_raw_value`，以及 `KEY_MODEL_ROLES`、`KEY_AGENT_OVERRIDES` 两个常量。
  - 执行器：`omp_cli::run_omp(bin, args, CHECK_TIMEOUT, ..)` + `require_success`；互斥锁 `omp_cli::OmpBusy::try_acquire()`。
  - 写入方式：整键 JSON 覆盖。
  - 测试：用假 omp 脚本 `fake_stateful()`（`omp_models.rs:706`），配合 `seed`、`set_log`。
- 托盘（`src-tauri/src/menubar/`）：
  - `tray.rs::build_menu` 构建菜单，`handle_menu_event` 按 id 前缀路由（已有 `SESSION_PREFIX="session:"`），`refresh_tray` 刷新。
  - `send_plain(app, title, body)` 发系统通知。
  - `menu.rs::MenuModel` 加 `same_structure` 决定刷新方式；`spawn_poller` 每 3 秒建一次 model。
  - 前端没有任何 `listen`/`emit` 事件通道，只靠拉取。
- 前端：
  - `@tauri-apps/api` 2.12.3：`Menu/MenuItem/CheckMenuItem/PredefinedMenuItem/Submenu` 来自 `@tauri-apps/api/menu`；`Menu.popup()` 在光标处弹出。菜单权限在 `core:default` 内，无需额外配置。
  - 全前端没有 `onContextMenu`。
  - 元数据写入 `setSessionMeta(sessionId, {alias,tags,note}|null, expectedRevision)` 是**整条替换**；版本号不一致返回 `CONFLICT`。限制：别名 ≤80 字，标签 ≤10 个、每个 ≤24 字（大小写不敏感去重），备注 ≤2000 字。
- 续聊命令由 `ops/iterm.rs::resume_command(cwd, path)` 生成，引号处理用 `shell_quote`；没有命令把它暴露给前端。`open_in_iterm_impl`（`ops/commands.rs:137`）内含会话路径、cwd、控制字符校验。
- ui-ux-pro-max 最新 tag 为 `v2.15.0`，仓库里 `.claude/skills/ui-ux-pro-max/{SKILL.md,data,references,scripts}` 自成一体，纯 Python 3 运行（本机 3.13.3）。
  - 它的 SKILL.md 用 `${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py` 调用脚本，在 omp 下该环境变量未定义。
  - omp 从 `~/.agents/skills/` 加载用户 skill。
- 视觉现状：
  - 13px 系统字体；CSS 里有 18 种 `font-size`、15 种 `border-radius`。
  - 15 个文件共 37 处 emoji/unicode 字形被当作图标。
  - 没有图标库，没有 vibrancy；窗口为默认标题栏（`tauri.conf.json:14-21`）。
- `lucide-react` 最新版为 1.61.0（peer：react ^19 可用）。

## Approach

三个阶段互相独立，但都会改 `src/components/Sidebar.tsx`，因此按 A → B → C 顺序执行。每个阶段结束时，`npm run check` 和 `cargo test` 都必须通过。

### 跨阶段健壮性规则（每一步都要遵守）

- **后端写操作**一律：先校验输入，再 `OmpBusy::try_acquire()` 互斥，然后「读当前值 → 与调用方的 expected 比对（不一致报 `CONFLICT`）→ 写 → 重读并返回新状态」。多键写入必须带回滚日志。
- **前端异步操作**一律：用 ref 防止重入；组件卸载后不再 setState，沿用现有 `useAlive()`；错误经 `errorText(normalizeError(e))` 转成 toast；遇到 `CONFLICT` 先重新拉取最新状态，再提示用户重试。
- **右键菜单**执行动作前，按 path 从最新列表重新解析会话。会话已不存在时 toast `会话已不存在`，并且不调用任何后端。

### Phase A — 模型模式

**存储格式（定稿）**：模式就是 omp 的 `modelPresets.<name>` 条目，格式为
`{ "modelRoles": {role: selector}, "defaultThinkingLevel"?: level, "agentModelOverrides"?: {agent: selector} }`。
- `agentModelOverrides` 是本 app 的扩展字段。omp 会忽略它：终端里 `/modelpreset switch` 只切角色和档位，`/modelpreset save` 覆盖条目时会丢掉它。
- 名称规则与 omp 一致：`^[a-zA-Z][\w-]*$`，另加长度 ≤ 64。
- 切换写全局配置，不使用 `--config` 叠加。

#### A1 后端：`src-tauri/src/model_presets.rs`（新模块，在 `lib.rs` 里 `pub mod model_presets;`）

1. **复用 omp_models.rs 的底层函数**：把 `get_raw_value`、`get_shaped_value`、`set_raw_value`、`ConfigKind` 改为 `pub(crate)`，`list_models_impl` 已经是 pub。再新增：

   ```rust
   pub(crate) fn set_raw_string(bin: &Path, key: &str, value: &str) -> Result<(), AppError>
   ```

   它执行 `omp config set <key> <value>`（传原样字符串，不加 JSON 引号），失败摘要为 `"写入模型配置失败"`。A5 用沙箱验证这个格式；若验证不通过，改成传 `serde_json::to_string(value)`。

2. **抽出共享的假 omp**：把 `omp_models.rs` tests 里的 `write_fake`、`fake_stateful`、`fake_with_marker`、`seed`、`set_log` 原样移到新文件 `src-tauri/src/omp_fake.rs`，模块声明为 `#[cfg(test)] pub(crate) mod omp_fake;`，函数都是 `pub(crate)`。omp_models 的 tests 改为 `use crate::omp_fake::*;`，不保留旧副本。`fake_stateful` 脚本加三处：
   - `config set` 的键为 `defaultThinkingLevel` 时，写 `"value":"%s"`（带引号）。
   - 存在 `$STATE/fail-set-$3` 文件时，`config set $3` 直接 `exit 1`（用于注入失败）。
   - `models --json`：有 `$STATE/models.json` 就 `cat` 它，否则输出 `{"models":[]}`。

3. **类型**（加到 `src-tauri/src/model.rs`，都 `#[serde(rename_all = "camelCase")]`）：

   ```rust
   #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
   pub struct ModelPresetSnapshot {
       pub model_roles: Value,             // 当前 modelRoles 原值（对象）
       pub agent_model_overrides: Value,   // 当前 task.agentModelOverrides 原值（对象）
       pub default_thinking_level: Option<String>,
   }
   #[derive(Debug, Clone, Serialize, PartialEq)]
   pub struct ModelPreset {
       pub name: String,
       pub model_roles: serde_json::Map<String, Value>,
       pub default_thinking_level: Option<String>,
       pub agent_model_overrides: Option<serde_json::Map<String, Value>>,
       pub invalid_reason: Option<String>, // Some = 条目格式无效（不可切换，可删除）
   }
   #[derive(Debug, Clone, Serialize, PartialEq)]
   pub struct ModelPresetsState {
       pub presets: Vec<ModelPreset>,   // 按名称排序：先比小写，再比原文
       pub active: Option<String>,
       pub current: ModelPresetSnapshot, // 切换时的 expected
       pub raw_presets: Value,           // 保存/删除时的 expected（未设置时为 {}）
   }
   ```

4. **纯函数**（都要有单测）：
   - `validate_preset_name(name: &str) -> Result<(), AppError>`：
     - 空字符串 → `InvalidInput "模式名不能为空"`。
     - 超过 64 字符或不满足 `^[a-zA-Z][\w-]*$`（ASCII，手写字符判断，不引入 regex crate）→ `InvalidInput "模式名需以字母开头，只能包含字母、数字、- 或 _（与 omp /modelpreset 通用）"`。
   - `parse_presets(raw: &Value) -> Vec<ModelPreset>`：raw 为 null 时视为 `{}`。逐条宽容解析：
     - 条目不是对象 → `invalid_reason = "不是映射"`。
     - `modelRoles` 缺失或不是对象 → `"modelRoles 缺失或不是映射"`。
     - 某个值不是非空字符串 → `"角色 {role} 的值不是模型 selector"`。
     - `defaultThinkingLevel` 存在但不在 7 个档位里 → `"defaultThinkingLevel 不是有效档位"`。
     - `agentModelOverrides` 存在但不是「非空字符串值的对象」→ `"agentModelOverrides 格式无效"`。
     - 名称不合法的条目同样保留，并标记 `"名称不符合 omp 规则"`。
   - `non_empty_strings(v: &Value) -> Map`：只保留值为非空字符串的键。
   - `find_active(presets, current) -> Option<String>`：在排序后的有效预设中，取第一个同时满足以下条件的：
     - `model_roles == non_empty_strings(current.model_roles)`；
     - 预设 thinking 为 `None` 或等于当前值；
     - 预设 overrides 为 `None` 或等于 `non_empty_strings(current.agent_model_overrides)`。
   - `selector_base(value: &str) -> &str`：与 `src/modelConfig.ts::parseSelectorValue` 同规则——取最后一个 `:` 之后的部分，若匹配 `[A-Za-z0-9_-]+` 则去掉它。

5. **读状态** `pub fn read_presets_state(bin: &Path) -> AppResult<ModelPresetsState>`：
   - 依次读 `modelPresets`（raw，必须是对象或 null，否则报 `OmpFailed "modelPresets 配置形状异常，请在终端运行 omp config get modelPresets 检查"`）、`modelRoles`（`get_shaped_value(StringRecord)`）、`task.agentModelOverrides`（同上）、`defaultThinkingLevel`（`get_raw_value(..).ok()`，取 `as_str`；读不到时为 `None`）。
   - 组装出 `presets` 与 `active`。

6. **保存** `pub fn save_preset_impl(bin, busy: &OmpBusy, name: &str, overwrite: bool, expected_presets: &Value) -> AppResult<ModelPresetsState>`：
   - `validate_preset_name` → `try_acquire` → `read_presets_state`。
   - `raw_presets != expected_presets` → `Conflict "模式列表已被外部修改，请刷新后重试"`。
   - 同名已存在且 `!overwrite` → `InvalidInput "已有同名模式「{name}」"`。
   - `roles = non_empty_strings(current.model_roles)`；为空 → `InvalidInput "当前没有任何角色模型配置，无法保存为模式"`。
   - 条目内容：`modelRoles` = roles；`defaultThinkingLevel` = 当前值（为 `None` 时省略）；`agentModelOverrides` = 当前 overrides 的非空部分（为空时省略）。
   - 在 raw 对象中插入或替换该条目，其余条目原样保留 → `set_raw_value(bin, "modelPresets", &new)` → 返回 `read_presets_state`。

7. **切换** `pub fn switch_preset_impl(bin, busy, name: &str, expected: Option<&ModelPresetSnapshot>) -> AppResult<ModelPresetsState>`（`expected = None` 只供托盘使用）：
   1. `validate_preset_name` → `try_acquire` → `read_presets_state`。
   2. 找不到该名称 → `NotFound "模式「{name}」不存在（可能已被删除）"`。
   3. 条目有 `invalid_reason` → `InvalidInput "模式「{name}」格式无效：{reason}"`。
   4. `Some(exp)` 且 `exp != state.current` → `Conflict "模型配置已被外部修改，请刷新后重试"`。
   5. 预设含 `default` 角色，且值不以 `@` 或 `pi/` 开头时，调用 `list_models_impl(bin)`。没有任何 `m.selector` 等于原值或其 `selector_base` → `InvalidInput "模式「{name}」的 default 模型 {value} 不在 omp 可用模型列表中，未切换"`。
   6. 依次写入，每写成功一步就把旧值记入回滚日志；与当前值相同的键跳过：
      - ① `modelRoles` = 预设 roles（`set_raw_value`）；
      - ② 若预设带 overrides：`task.agentModelOverrides` = overrides；
      - ③ 若预设带 thinking 且与当前不同：`set_raw_string("defaultThinkingLevel", level)`。
   7. 任一步失败时，按逆序把已写的键恢复为旧值（thinking 旧值为 `None` 时不恢复）：
      - 全部恢复成功 → `OmpFailed "切换失败，已恢复原配置：{原错误}"`；
      - 恢复也失败 → `OmpFailed "切换失败且恢复原配置失败（{恢复错误}），请到「管理 → 模型」检查：{原错误}"`。
   8. 成功则返回 `read_presets_state`。

8. **删除** `pub fn delete_preset_impl(bin, busy, name, expected_presets) -> AppResult<ModelPresetsState>`：
   - 名称只要求非空（允许删除名称不合法的旧条目）→ `try_acquire` → 读状态。
   - 冲突检查同保存。
   - 名称不存在 → `NotFound`。
   - 移除该键 → `set_raw_value` → 返回新状态。

9. **Tauri 命令**（照抄 `omp_models.rs:641-690` 的写法：`crate::blocking` + `resolve_omp().ok_or_else(omp_not_found)`，写操作用 `app.state::<OmpBusy>()`）：
   - `list_model_presets() -> ModelPresetsState`
   - `save_model_preset(app: AppHandle, name: String, overwrite: bool, expected_presets: Value)`
   - `switch_model_preset(app: AppHandle, name: String, expected: ModelPresetSnapshot)`
   - `delete_model_preset(app: AppHandle, name: String, expected_presets: Value)`

   三个写命令成功后都调用 `crate::menubar::tray::publish_modes(&app, &state)`。四个命令都要在 `lib.rs` 的 `invoke_handler` 里注册，位置紧接 `omp_models::update_model_config`。

#### A2 托盘「模式」子菜单

- `menu.rs`：
  - 新增 `#[derive(Debug, Clone, PartialEq, Eq)] pub struct ModeEntry { pub name: String, pub active: bool, pub enabled: bool }`。
  - `MenuModel` 加字段 `pub modes: Option<Vec<ModeEntry>>`；`None` 表示尚未读到或读取失败，此时菜单不显示子菜单。
  - `build_model` 签名不变，设 `modes: None`。
  - `same_structure` 追加条件 `&& self.modes == other.modes`。
  - 新增纯函数 `pub fn mode_entries(state: &ModelPresetsState) -> Vec<ModeEntry>`：`enabled = invalid_reason.is_none()`，`active = state.active == Some(name)`。
- `tray.rs`：
  - `Shared` 加 `pub modes: Mutex<Option<Vec<ModeEntry>>>`，初始为 `None`。
  - 新常量 `MODE_PREFIX = "mode:"`。
  - `build_menu` 在会话行和「更多…」之后、「打开主窗口」前的分隔线之前，若 `model.modes` 为 `Some(list)`：
    - 先插入分隔线，再加 `Submenu::with_id_and_items(app, "modes", format!("模式：{}", 当前激活名或 "自定义"), true, &items)`。
    - items 为每个条目的 `CheckMenuItem::with_id(app, format!("{MODE_PREFIX}{name}"), menu_text(name), enabled, active, None::<&str>)`。
    - 列表为空时只放一个禁用的 `MenuItem`：「还没有模式（在主窗口侧栏底部保存）」。
  - `handle_menu_event` 开头加：`if let Some(name) = id.strip_prefix(MODE_PREFIX) { switch_mode_from_tray(app, name.to_string()); return; }`。
  - `fn switch_mode_from_tray(app, name)`：起后台线程执行（同 `focus_session` 写法）：
    - `resolve_omp()` 为 `None` → `send_plain(app, "切换模式失败", "未找到 omp")`。
    - 否则 `switch_preset_impl(&bin, &app.state::<OmpBusy>(), &name, None)`：
      - `Ok(state)` → `publish_modes` + `send_plain(app, "已切换模式", &format!("当前模式：{name}"))`；
      - `Err(e)` → `send_plain(app, "切换模式失败", &e.message)`，然后尽力 `read_presets_state` 并 `publish_modes`，让勾选状态回到真实值。
  - `pub fn publish_modes<R: Runtime>(app: &AppHandle<R>, state: &ModelPresetsState)`：
    - 算出 `mode_entries`；与 `Shared.modes` 相同则直接返回。
    - 否则写入 `Shared.modes`；若 `last_menu` 有缓存，克隆它、替换 `modes` 后调用 `refresh_tray`。
  - 轮询循环（`spawn_poller` 中拿到 `outcome.menu` 之后、`refresh_decision` 之前）：把 `model.modes` 设为 `Shared.modes` 的当前值。
  - 新增 `pub fn spawn_modes_refresher<R: Runtime + 'static>(app: AppHandle<R>)`，线程名 `"menubar-modes"`：
    - 循环：先 `resolve_omp`，再 `read_presets_state`；成功则 `publish_modes`，失败保持旧值不发布；然后 `sleep(30s)`。
    - 首轮立即执行。
    - 在 `lib.rs` setup 中紧接 `spawn_poller(...)` 之后调用。
- Dock 菜单（`dock.rs`）只渲染会话行，不改。

#### A3 前端数据层

- `src/types.ts` 新增与 A1 对应的 `ModelPresetSnapshot`、`ModelPreset`、`ModelPresetsState`。
- `src/api.ts` 新增（沿用 `call<T>`）：
  - `listModelPresets(): Promise<ModelPresetsState>`
  - `saveModelPreset(req: {name: string; overwrite: boolean; expectedPresets: unknown})`
  - `switchModelPreset(req: {name: string; expected: ModelPresetSnapshot})`
  - `deleteModelPreset(req: {name: string; expectedPresets: unknown})`

  后三个都返回 `Promise<ModelPresetsState>`。
- 新增 `src/modelPresets.ts`，作为模块级共享 store，用 `useSyncExternalStore` 暴露：
  - `export type PresetsView = {status:"loading"} | {status:"error"; message:string} | {status:"ready"; state: ModelPresetsState; busy: boolean}`
  - `export function usePresets(): PresetsView`：首个订阅者挂载时调用 `refreshPresets()`，并注册 window `focus` 监听（同样调用 `refreshPresets`）。
  - `export function refreshPresets(): Promise<void>`：并发调用复用同一个在途 promise；失败时若已有 ready 状态则保留并 toast 不显示，否则进入 `error`。
  - `export function runPresetOp(op: () => Promise<ModelPresetsState>): Promise<void>`：`busy` 时直接返回（防重入）。成功 → 存新状态 + `emitModelConfigChanged("presets")`；`CONFLICT` → `refreshPresets()` 后再抛出；其他错误直接抛出。busy 标志在 `finally` 中复位。
  - `export function onModelConfigChanged(fn: (origin: "presets" | "draft") => void): () => void` 与 `emitModelConfigChanged(origin)`：一个 `Set` 加普通函数（仓库里没有现成的事件总线，这是唯一的一个）。
- `src/modelDraft.ts`：
  - `useModelDraft` 中新增 effect 订阅 `onModelConfigChanged`。origin 为 `"presets"` 时：任一区块 `deriveDirty(config, draft)` 为脏 → `reloadBaseline()`；否则 → `loadConfig()`。
  - `saveBlock` 成功的分支末尾调用 `emitModelConfigChanged("draft")`。
  - `modelPresets.ts` 订阅 `"draft"` → `refreshPresets()`。

#### A4 侧栏底部 ModePicker

- 新增 `src/components/ModePicker.tsx` 和 `ModePicker.css`，复制 `AppearancePanel.tsx:60-142` 的弹层模式：`wrap` 包 `ref` + 按钮带 `aria-expanded`/`aria-haspopup="dialog"`；按下外部 `mousedown` 或 `Escape` 关闭，关闭后焦点回到按钮。
- 按钮文案：
  - loading → `模式 …`；
  - error → `模式 ⚠`，title 为错误信息；
  - ready 且有 active → `模式：{active}`；
  - ready 且无 active → `模式：自定义`。
- 弹层（`role="dialog"`，`aria-label="模型模式"`）：
  - 标题「模型模式」。
  - 列表行（`button`，`role="menuitemradio"`，`aria-checked`）：
    - 主文本为名称；
    - 副文本：`default：{selector_base 的最后一段}` · `推理 {level|继承}` · `agent 模型 {n} 个`（没有 overrides 时省略这一段）；
    - title 逐行列出全部 `角色 → selector`；
    - 激活行显示 Check 图标；
    - 无效行禁用，副文本为 `格式无效：{reason}`。
  - 每行右侧有 `MoreHorizontal` 按钮（`aria-label="更多操作：{name}"`），点击后用 Phase B 的 `popupMenu` 弹出原生菜单，两项：「用当前配置覆盖「{name}」」「删除「{name}」…」。
  - 点击非激活的有效行 → `runPresetOp(() => switchModelPreset({name, expected: state.current}))`：
    - 成功 → toast `已切换到模式「{name}」`；
    - `CONFLICT` → toast `omp 配置已被外部修改，已刷新，请重试`；
    - 其他错误 → toast 错误文本；
    - 执行期间整个列表禁用。
  - 有预设但无 active 时，列表上方提示「当前配置未保存为模式」。
  - 没有预设时显示「还没有模式。先在「管理 → 模型」配好角色和 agent 模型，再存为模式。」
  - 底部按钮「将当前配置存为模式…」，点击后切换为内联表单：
    - 输入框 `maxLength=64`，自动聚焦；
    - 每次输入都按 `^[a-zA-Z][\w-]*$` 校验，错误文案与后端相同；
    - 与已有名称同名时提示 `已有同名模式，请用该模式「⋯」菜单里的「覆盖」`，保存按钮禁用；
    - Enter 或「保存」→ `runPresetOp(() => saveModelPreset({name, overwrite:false, expectedPresets: state.rawPresets}))`，成功后 toast `已保存模式「{name}」` 并收起表单；
    - Esc 或「取消」收起表单。
  - 错误态：错误文本加「重试」按钮（调用 `refreshPresets`）。
- 覆盖、删除都先弹确认框，复用 `ui.tsx` 的 `Modal`，Modal 渲染在弹层外部，打开前先关闭弹层：
  - 覆盖：标题「用当前配置覆盖模式「{name}」？」，按钮 [取消] [覆盖]，确认后调用 `saveModelPreset({overwrite:true, ...})`。
  - 删除：标题「删除模式「{name}」？」，正文「只删除这个模式的保存记录，不影响当前正在使用的模型配置。」，按钮 [取消] [删除]（危险样式），确认后调用 `deleteModelPreset`。
- 接入 `Sidebar.tsx`：
  - footer 第一行（`:364-394` 处）在 `<AppearancePanel />` 前插入 `<ModePicker onToast={onToast} />`。
  - `SidebarProps` 新增 `onToast: ToastFn`（从 `components/useOmpOp.ts` 导入类型），`App.tsx` 传入 `addToast`。

#### A5 omp 写格式验证（实现 `set_raw_string` 后立刻做，不碰真实配置）

```sh
T=$(mktemp -d) && export PI_CODING_AGENT_DIR="$T"
omp config path                                  # 必须输出 $T
omp config set defaultThinkingLevel xhigh && omp config get defaultThinkingLevel --json   # 期望 "value": "xhigh"
omp config set modelPresets '{"A":{"modelRoles":{"default":"x/y"},"defaultThinkingLevel":"high","agentModelOverrides":{"task":"x/y"}}}'
omp config get modelPresets --json               # 期望 A 条目三字段原样保留
unset PI_CODING_AGENT_DIR; rm -rf "$T"
```

两种不通过的情况与对应处理：
- 第二条命令报错，或回读的值带引号：把 `set_raw_string` 改为传 JSON 字符串，然后重跑这段验证。
- `agentModelOverrides` 被 omp 剔除：把扩展字段改存到 app 数据目录的 `model-presets-ext.json`（结构 `{name: overrides}`，原子写，删除模式时同步删除对应项），其余设计不变。

### Phase B — 会话右键菜单

#### B1 后端辅助命令（`src-tauri/src/ops/commands.rs` + `lib.rs`）

- 重构：把 `open_in_iterm_impl` 中 `:142-168` 的校验抽成 `fn resume_target(cfg: &Config, path: &str) -> Result<ResumeTarget, AppError>`，其中 `struct ResumeTarget { path: PathBuf, cwd: String, session_id: String }`，`session_id` 即 `info.id`。`open_in_iterm_impl` 改为 `resume_target` + 原有的占用探测 + opener，行为不变，现有测试必须原样通过。
- 新增三个函数：
  - `pub fn resume_command_impl(cfg, path) -> Result<String, AppError>`：`resume_target` 后返回 `iterm::resume_command(&cwd, &path)`，不做占用探测。
  - `pub fn reveal_session_file_impl(cfg, path, run: &dyn crate::menubar::iterm::Runner) -> Result<(), AppError>`：
    - 先 `config::validate_session_path`；路径含控制字符时 → `InvalidInput`；
    - 然后 `run.run("/usr/bin/open", &["-R", path])`；
    - `Err(s)` → `AppError::new(ErrorCode::Io, format!("无法在 Finder 中显示：{s}"))`。
  - `pub fn open_project_dir_impl(cwd: &str, run: &dyn Runner) -> Result<(), AppError>`：
    - 校验规则与 `new_session_in_iterm_impl` 相同（必须是绝对路径且为目录，否则 `CwdMissing`；含控制字符 → `InvalidInput`）；
    - 然后 `run.run("/usr/bin/open", &[cwd])`，错误文案为 `无法打开项目目录：{s}`。
- `lib.rs` 新增三个命令，写法照抄 `open_in_iterm`（`:163-176`），并注册到 `invoke_handler`：
  - `resume_command_for(cfg, path) -> String`
  - `reveal_session_file(cfg, path)`
  - `open_project_dir(cwd)`

  生产代码传 `&crate::menubar::iterm::SystemRunner`。
- `src/api.ts` 新增 `getResumeCommand(path)`、`revealSessionFile(path)`、`openProjectDir(cwd)`。

#### B2 原生菜单基础设施：`src/nativeMenu.ts`

```ts
export type MenuSpec =
  | { kind: "item"; text: string; enabled?: boolean; run: () => void | Promise<void> }
  | { kind: "check"; text: string; checked: boolean; enabled?: boolean; run: () => void | Promise<void> }
  | { kind: "separator" }
  | { kind: "submenu"; text: string; enabled?: boolean; items: MenuSpec[] };
export async function popupMenu(items: MenuSpec[]): Promise<void>;
```

- 用 `MenuItem.new`、`CheckMenuItem.new`、`PredefinedMenuItem.new({item:"Separator"})`、`Submenu.new` 逐个显式构建，再 `Menu.new({items})`，最后 `menu.popup()`。
- id 一律为 `ctx:${递增序号}`，保证不会和托盘的 `session:`、`mode:` 以及固定 id 相撞，托盘路由的 `_ => {}` 会忽略它们。
- 每个 `action` 包装为 `() => { void Promise.resolve().then(spec.run).catch((e) => console.error("menu action", e)); }`。
- 竞态与资源：
  - 模块级维护 `seq` 计数和 `live: Menu | null`。
  - 构建完成后若 `mine !== seq`（已有更新的弹出请求），关闭本菜单并返回。
  - 否则先关闭上一个 `live`（`.close().catch(() => {})`），再把 `live` 设为本菜单并弹出。
  - 这样同一时刻最多只有一个存活的菜单资源。
- 空数组直接返回，不弹出。

#### B3 菜单内容：`src/sessionMenus.ts`（纯函数构建器，可脱离 Tauri 单测）

```ts
export interface SessionMenuActions {
  openIterm(s: SessionSummary): void; newSessionIn(cwd: string): void;
  togglePin(kind: PinKind, key: string): void; startRename(path: string): void;
  toggleTag(ids: string[], tag: string, on: boolean): void; newTag(ids: string[]): void;
  copy(kind: "id" | "path" | "cwd" | "resume", targets: SessionSummary[]): void;
  revealFile(path: string): void; openProjectDir(cwd: string): void;
  enterSelect(path: string): void; requestDelete(paths: string[]): void;
  selectGroup(paths: string[]): void; collapseAll(): void; expandAll(): void;
}
export function buildSessionMenu(s: SessionSummary, ctx: { meta: SessionMeta | null; pinned: boolean; allTags: string[] }, a: SessionMenuActions): MenuSpec[];
export function buildBatchMenu(targets: SessionSummary[], ctx: { metaOf: (id: string) => SessionMeta | null; pinnedIds: ReadonlySet<string>; allTags: string[] }, a: SessionMenuActions): MenuSpec[];
export function buildGroupMenu(g: { cwd: string; name: string; paths: string[]; dirMissing: boolean; pinned: boolean } | { pinnedHeader: true; paths: string[] }, a: SessionMenuActions): MenuSpec[];
```

**单会话菜单**（逐项，括号内为启用条件）：
1. 「在 iTerm 继续」（`!s.inUse && s.cwdExists`，与 `DetailPane.tsx:66` 的 `itermDisabled` 取反一致）
2. 「在此项目新建会话」（`s.cwdExists`）
3. 分隔线
4. 「置顶」或「取消置顶」
5. 「重命名…」
6. 子菜单「标签」：
   - `allTags` 中每个标签对应一个 check 项。会话已有该标签（大小写不敏感）时为勾选；会话已满 10 个标签时，未勾选的项禁用。
   - 列表非空时加一条分隔线，然后是「新标签…」（满 10 个时禁用）。
7. 分隔线
8. 子菜单「复制」：「会话 ID」「会话文件路径」「项目路径」「续聊命令」（最后一项要求 `s.cwdExists`）
9. 「在 Finder 中显示」
10. 「在 Finder 中打开项目目录」（`s.cwdExists`）
11. 分隔线
12. 「选择」
13. 分隔线
14. 「删除…」（`!s.inUse`）

**批量菜单**：右键的行已被勾选，且勾选数 ≥ 2 时使用；targets 为所有勾选且仍在当前列表中的会话。
1. 禁用的标题项「已选 {N} 个会话」
2. 分隔线
3. 全部已置顶时显示「取消置顶全部」，否则显示「置顶全部」（只对未置顶的会话调用 `togglePin`）
4. 子菜单「标签」：全部会话都有该标签时为勾选。点击已勾选项 → 从全部移除；点击未勾选项 → 加到缺少的会话。末尾为「新标签…」。
5. 「复制会话 ID」（多个 ID 用换行连接）
6. 分隔线
7. 「删除 {N} 个会话…」（至少一个会话 `!inUse` 时启用；在用的会话由现有的 `DeleteDialog`/`planDelete` 跳过）

**项目组头菜单**：
1. 「在此项目新建会话」（`!dirMissing`）
2. 「置顶项目」或「取消置顶项目」
3. 「在 Finder 中打开项目目录」（`!dirMissing`）
4. 「复制项目路径」
5. 分隔线
6. 「选择组内全部会话」（`paths` 非空时启用）
7. 「折叠全部」
8. 「展开全部」

**置顶区组头菜单**：「选择全部置顶会话」、分隔线、「折叠全部」、「展开全部」。

#### B4 元数据写入：`src/metaOps.ts`

```ts
export class MetaBatchError extends Error { constructor(public snapshot: MetaSnapshot, public updated: number, public cause: AppError) }
export async function writeAlias(meta: MetaSnapshot, id: string, alias: string | null): Promise<MetaSnapshot>;
export async function applyTag(meta: MetaSnapshot, ids: string[], tag: string, on: boolean): Promise<{ snapshot: MetaSnapshot; updated: number; skipped: number }>;
```

- 两个函数都**保留原条目的其他字段**：调用 `setSessionMeta(id, { alias, tags, note: entry?.note ?? null }, snap.revision)` 时，`alias` 和 `tags` 未改动的那一个取原值。
- `applyTag` 逐个会话**串行**写入，每次使用上一次返回的 `revision`。以下情况跳过并计入 `skipped`：标签无变化；或要加标签但会话已有 10 个。中途出错时抛 `MetaBatchError`，携带最后一次成功的快照和已更新的数量。
- 标签比较一律大小写不敏感（与后端 `normalize_tags` 一致）。

#### B5 Sidebar 接线（`src/components/Sidebar.tsx`、`src/App.tsx`）

- **新增 props**：
  - `onToast: ToastFn`（A4 已加）
  - `onOpenIterm: (s: SessionSummary) => void`
  - `onRequestDelete: (paths: string[]) => void`
  - `onMetaSnapshot: (snap: MetaSnapshot) => void`
- **App.tsx 改动**：
  - 把 `DetailPane` 的内联 `onOpenIterm`（`:490-494`）提成 `handleOpenIterm` 回调，同时传给 DetailPane 和 Sidebar。
  - `onRequestDelete`：`const targets = paths.flatMap((p) => byPath.get(p) ?? [])`，非空时 `setDeleteTargets(targets)`。
  - `onMetaSnapshot={handleMetaSnapshot}`（`:352`）。
- **Sidebar 内部状态**：
  - `menuTarget: string | null`（行 path 或组 key）：被右键的行或组头加类名 `row-menu-target`，`popupMenu` 的 promise 结束后清空。
  - `renamingPath: string | null`。
  - `const byPathLocal = useMemo(...)`：由 `groups` 与 `pinnedSessions` 构建 path → SessionSummary 的映射，`run` 执行时从它重新解析会话。
- **事件绑定**：
  - `Row` 根 div 加 `onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRowMenu(s); }}`；两个 `.group-header-row` 加同样的处理，调用 `onGroupMenu`。
  - **右键不改变 `selectedPath`**（Mail 风格）。
  - 右键的行已勾选且 `checked.size >= 2` → 批量菜单，否则 → 单会话菜单。
- **动作实现**：
  - `startRename` → `setRenamingPath`。
  - `enterSelect` → `setMultiMode(true); onToggleCheck(path, true)`。
  - `selectGroup` → `setMultiMode(true); onToggleChecks(paths, true)`。
  - `collapseAll` → `setCollapsed(new Set([PINNED_KEY, ...groups.map((g) => g.cwd)]))`；`expandAll` → `setCollapsed(new Set())`。
  - `copy`：先取文本（`resume` 需要 `await getResumeCommand(path)`），再 `copyText`。
    - 成功 toast：`已复制会话 ID` / `已复制会话文件路径` / `已复制项目路径` / `已复制续聊命令`；批量复制 ID 时为 `已复制 {N} 个会话 ID`。
    - 剪贴板失败 → `复制失败：剪贴板不可用`（error）。
    - 后端失败 → 错误文本（error）。
  - `revealFile`、`openProjectDir`：失败时 toast 错误文本。
  - `toggleTag`：调用 `applyTag(meta, ids, tag, on)`。
    - 成功：`onMetaSnapshot`；toast 内容为 `已更新 {updated} 个会话的标签`，若 `skipped > 0` 追加 `（{skipped} 个已满 10 个标签，已跳过）`。
    - `MetaBatchError` 且原因是 `CONFLICT`：`onMetaSnapshot(await getMeta())`，toast `备注已被外部修改，已重新载入，请重试（已更新 {updated} 个）`。
    - 其他 `MetaBatchError`：`onMetaSnapshot(err.snapshot)` 并 toast 错误。
    - `meta` 为 null（元数据加载失败）时，标签和重命名项全部禁用（作为 ctx 传入构建器）。
  - `newTag` 打开新组件 `NewTagDialog`（放在 `src/components/NewTagDialog.tsx`，用 `Modal`）：
    - 输入框 `maxLength=24`；
    - 校验：trim 后非空，且所有目标会话都已有该标签（大小写不敏感）时提示「这些会话都已有该标签」；
    - 确定后调用 `applyTag(..., true)`，后续处理同 `toggleTag`。
- **行内重命名**：`Row` 新增 `renaming: boolean`、`onRenameDone: () => void` 两个 props，以及父组件提供的提交函数。渲染为 `input.row-rename`：
  - 预填 `alias ?? s.title`，自动聚焦并全选，`maxLength=80`，点击时 `stopPropagation`。
  - **提交**（Enter 或 blur，用 `committingRef` 防止 Enter 和 blur 重复提交）：
    - trim 后的值等于当前别名，或无别名时等于原标题 → 视为无改动，直接关闭；
    - 空字符串 → 别名设为 `null`；
    - 否则 → `writeAlias`。
  - 保存期间输入框禁用。
  - **结果处理**：
    - 成功 → `onMetaSnapshot` 并关闭。
    - `CONFLICT` → `onMetaSnapshot(await getMeta())`，toast `备注已被外部修改，已重新载入，请重试`，编辑框保持打开。
    - 其他错误 → toast 错误，编辑框保持打开。
  - Esc 取消，不写入。
  - 用一个 effect 保证：`renamingPath` 不在 `byPathLocal` 中时自动清空。
- **CSS**（`Sidebar.css`）：
  - `.row-menu-target { box-shadow: inset 0 0 0 2px var(--accent); }`
  - `.row-rename { width: 100%; font: inherit; }`，聚焦描边沿用现有 `outline: 2px solid var(--accent)` 写法。

### Phase C — 安装 ui-ux-pro-max 并做视觉升级

#### C1 安装 skill（仓库外，用户级）

```sh
git clone --depth 1 --branch v2.15.0 https://github.com/nextlevelbuilder/ui-ux-pro-max-skill /tmp/uupm
mkdir -p ~/.agents/skills && cp -R /tmp/uupm/.claude/skills/ui-ux-pro-max ~/.agents/skills/ui-ux-pro-max && rm -rf /tmp/uupm
python3 ~/.agents/skills/ui-ux-pro-max/scripts/search.py "developer tool" --domain product   # 必须有输出
```

- clone 失败时重试一次；仍然失败就改下载 `https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/refs/tags/v2.15.0`，解压后同样复制该子目录。
- `~/.agents/skills/ui-ux-pro-max` 已存在时，先移到 `~/.agents/skills/.ui-ux-pro-max.bak-<时间戳>` 再复制。
- 安装完成后，用 `edit` 工具把已安装的 `~/.agents/skills/ui-ux-pro-max/SKILL.md` 中所有 `${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/` 替换为 `~/.agents/skills/ui-ux-pro-max/`。

#### C2 用 skill 产出依据（结果只存在会话本地，不写进仓库）

依次运行（`S=~/.agents/skills/ui-ux-pro-max/scripts/search.py`），把输出保存到 `local://uiux-findings.md`：

```sh
python3 $S "developer tool desktop session manager" --design-system -p omp-resume --density 8 --variance 3 --motion 3 -f markdown
python3 $S "icon button accessible label" --domain icons
python3 $S "focus visible keyboard" --domain ux
python3 $S "reduced motion" --domain ux
python3 $S "context menu" --domain ux
python3 $S "list rerender memo" --stack react
```

**采纳规则**：
- 下面 C3–C7 的 token 与改动是定稿，不用 skill 输出替换。
- skill 输出只用来补充 C3–C7 未覆盖的具体规则（焦点、减弱动效、图标按钮标签）。
- 读取 `~/.agents/skills/ui-ux-pro-max/references/pro-rules.md` 中的 Pre-Delivery Checklist，作为 C8 的验收清单。

#### C3 设计 token（`src/App.css` 顶部 `:root` 区，与现有变量同处）

- 新增：
  - 字号：`--fs-xs:11px; --fs-sm:12px; --fs-md:13px; --fs-lg:14px; --fs-xl:16px; --fs-2xl:20px; --fs-3xl:26px;`
  - 圆角：`--radius-xs:3px; --radius-sm:5px; --radius-md:7px; --radius-lg:10px; --radius-xl:14px; --radius-full:999px;`
  - 动效：`--motion-fast:120ms; --motion-base:180ms; --ease-out:cubic-bezier(0.2,0.8,0.2,1);`
  - 浅色阴影：`--shadow-sm:0 1px 2px rgba(0,0,0,.06),0 0 0 .5px rgba(0,0,0,.06); --shadow-md:0 6px 16px rgba(0,0,0,.10),0 0 0 .5px rgba(0,0,0,.08);`
  - 深色阴影（写在 dark 块）：`--shadow-sm:0 1px 2px rgba(0,0,0,.4),0 0 0 .5px rgba(255,255,255,.06); --shadow-md:0 8px 24px rgba(0,0,0,.45),0 0 0 .5px rgba(255,255,255,.08);`
  - `--z-titlebar:5`
- 保留 `--motion`，改为 `var(--motion-fast)` 的别名。
- **全仓 CSS 替换字面量**（`src/**/*.css`，`src/stage/Stage.css` 中的 7/8/9px 画布字号除外）：
  - 字号：10→xs，11→xs，11.5→sm，12→sm，12.5→md，13→md，14→lg，15→lg，16→xl，17→xl，20→2xl，22→2xl，24→3xl，26→3xl。
  - 圆角：1/2/3px→xs，4/5px→sm，6/7px→md，8/10px→lg，12px→xl，999px→full；`50%`、`0`、`inherit` 不变；`6px 6px 0 0` → `var(--radius-md) var(--radius-md) 0 0`。
  - 阴影：浮层元素（`position: absolute|fixed` 的 popover、toast、drawer、下拉）→ `var(--shadow-md)`；流内卡片 → `var(--shadow-sm)`；modal 保持 `var(--shadow)`。
- `body` 追加：`-webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;`
- 标题：`font-size >= var(--fs-xl)` 的标题加 `letter-spacing: -0.01em; font-weight: 600;`
- 文件末尾追加全局规则：
  - `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }`
  - 兜底焦点样式：`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`。已有的组件级 focus 规则保留。

#### C4 图标：`lucide-react`（`npm install --save-exact lucide-react@1.61.0`）

- 在 `src/components/ui.tsx` 新增唯一的图标封装：

  ```tsx
  export function Ico({ icon: I, size = 14 }: { icon: LucideIcon; size?: number }) {
    return <I size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />;
  }
  ```

  所有图标都经由 `Ico` 使用；纯图标按钮必须保留或补上 `aria-label`。
- **替换表**（字形 → lucide 名）：

  | 位置 | 原字形 | lucide 名 |
  |---|---|---|
  | `AppearancePanel` | ⚙ / ✓ | `Palette` / `Check` |
  | `BenchTagFilter` | ✕ | `X` |
  | `BenchToolbar`、`ModelLibrary`（「测试」前）、`ModelTesterPanel` | ▶ | `Play` |
  | `CheatSheetDialog` | 「已复制 ✓」 | 「已复制」+ `Check` |
  | `ConversationView` | 🔧 / ✗ / ✓ | `Wrench` / `X` / `Check` |
  | `ManageView`、`MemoryBanks` | ✔ / ✘ | `Check` / `X` |
  | `ModelDraftWidgets` | ↑ / ↓ / ✕ | `ArrowUp` / `ArrowDown` / `X` |
  | `ModelsSection` | ＋ | `Plus` |
  | `SessionMetaEditor` | × | `X` |
  | `Sidebar` | ↻ / ☑ / ▸ / 📌 | `RotateCw` / `ListChecks` / `ChevronRight`（保留 CSS 旋转）/ `Pin` |
  | `Sidebar:335`、`BenchTagFilter:65`、`BenchDrawer:118` | ASCII `+` 按钮 | `Plus` |
  | `TreeView` | 👤 / 🤖 / 🔧 / 🗜 / 🔀 / ▾ / ▸ | `User` / `Bot` / `Wrench` / `Shrink` / `GitBranch` / `ChevronDown` / `ChevronRight` |
  | `StageCanvas` | ＋ / － | `Plus` / `Minus` |

  `src/stage/glyphs.ts` 的像素图标保持不动。
- 侧栏 `.view-nav` 每个按钮在文字前加图标：舞台 `Theater`、统计 `ChartColumn`、清理 `Eraser`、提示词历史 `History`、管理 `Settings2`、速查 `BookOpen`。「新会话…」按钮加 `SquarePen`。
- 若某个名称在 1.61.0 中不存在（`tsc` 报缺少导出），按以下备选替换：
  - `Theater→Clapperboard`
  - `ChartColumn→BarChart3`
  - `Settings2→Settings`
  - `SquarePen→PenSquare`
  - `Shrink→Minimize2`
  - `ListChecks→CheckSquare`
- 已置顶状态由 `.pin-toggle-on` 的颜色表达，图标本身不填充。

#### C5 窗口外观：统一标题栏 + 半透明侧栏

- `tauri.conf.json` 窗口配置加：`"titleBarStyle": "Overlay"`、`"hiddenTitle": true`、`"transparent": true`、`"windowEffects": { "effects": ["sidebar"], "state": "followsWindowActiveState" }`；`app` 下加 `"macOSPrivateApi": true`。
- `Cargo.toml` 的 tauri features 加 `"macos-private-api"`。
- `capabilities/default.json` 的 permissions 追加 `"core:window:allow-start-dragging"`。
- `src/main.tsx` 在挂载前执行 `document.documentElement.dataset.vibrancy = "on"`。
- CSS：
  - `:root[data-vibrancy="on"]` 下：`html, body { background: transparent; }`，`.sidebar { background: transparent; }`。
  - `App.tsx` 用 `<main className="main-pane">` 包住视图切换区（`:439-510`），样式 `.main-pane { flex: 1; min-width: 0; display: flex; overflow: hidden; background: var(--bg); }`。原视图根节点的 `flex: 1` 保持有效。
  - `App.tsx` 根 `.app` 内首个子元素加 `<div className="titlebar" data-tauri-drag-region />`，样式 `position: fixed; top: 0; left: 0; right: 0; height: 28px; z-index: var(--z-titlebar);`。
  - `.app` 加 `padding-top: 28px; box-sizing: border-box;`。
  - 所有 modal、drawer、toast 的遮罩层级必须高于 `--z-titlebar`；某处低于 5 时调到 ≥ 10。
- **回退**：C8 冒烟时若出现黑底、白闪或文字发虚，删除 `transparent`、`windowEffects`、`macOSPrivateApi`、cargo feature 以及 `main.tsx` 那一行，保留 Overlay 标题栏与 `.titlebar` 拖拽条，侧栏恢复使用不透明的 `--bg-sidebar`。

#### C6 列表与选中态（`App.css` 中的 `.row` 和 `:511` 的 `.row-selected`）

- `.row { margin: 1px 6px; padding: 6px 10px; border-left: 0; border-radius: var(--radius-md); transition: background-color var(--motion-fast) var(--ease-out); }`
- `.row:hover { background: var(--bg-hover); }`
- `.row-selected, .row-selected:hover { background: var(--bg-selected); }`，删除 `border-left-color`。
- `.row-pinned` 现有样式保留。
- 组头 `.group-header` 统一使用 `--fs-sm`、`font-weight: 600`、颜色 `--text-muted`。

#### C7 空状态组件

- `ui.tsx` 新增：

  ```tsx
  export function EmptyState({ icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode })
  ```

  样式 `.empty-state`：
  - 容器：居中纵向排列，`gap: 8px`，`padding: 32px 16px`。
  - 图标：放在 52px 圆形内，背景 `--accent-soft`，前景 `--accent`，图标尺寸 26。
  - 标题：`--fs-lg`，字重 600。
  - 描述：`--fs-sm`，`--text-muted`，`max-width: 36ch`，`text-wrap: balance`。
- 替换以下 7 处：

  | 位置 | 图标 | 标题 | 描述 |
  |---|---|---|---|
  | `DetailPane.tsx:119-121` 未选中会话 | `PanelLeft` | 选择一个会话 | 从左侧列表选中会话，查看对话、分支树和用量。右键会话可快速继续、重命名、打标签。 |
  | `DetailPane.tsx:119-121` 会话已不存在 | `FileX` | 该会话已不存在 | 它可能已被删除或移动，点侧栏的刷新按钮更新列表。 |
  | `Sidebar.tsx:236` | `SearchX` | 没有匹配的会话 | 换个关键词，或清除标签筛选。 |
  | `StageView.tsx:188` `.stage-empty` | `Theater` | 没有运行中的会话 | 沿用原说明句 |
  | `PromptHistoryView.tsx:78` | `History` | 沿用原两种文案 | — |
  | `CleanupView.tsx:212` | `Sparkles` | 很干净 | 没有符合清理规则的会话（空会话 / 目录已删除 / 体积大 / 久未更新） |
  | `StatsView.tsx:170` | `ChartColumn` | 此范围内暂无用量数据 | 换个时间范围试试。 |

  其他 `pane-note` 不改。

#### C8 skill 验收

- 跑 `npm run tauri dev`，在浅色和深色两种主题下分别截图：会话页（选中与未选中）、管理 → 模型、统计、舞台、底部模式弹层、右键菜单。
- 对照 pro-rules Pre-Delivery Checklist 逐条检查。重点项：
  - 没有 emoji 图标；
  - 纯图标按钮有标签；
  - 浅色和深色主题对比度 ≥ 4.5:1（用浏览器 devtools 取色，重点测 `--text-muted` 落在 `--bg-selected` 和侧栏材质上）；
  - 键盘焦点可见；
  - 系统开启「减少动态效果」时无动画。
- 不达标的项按 C3–C7 的 token 修正。若 `--text-muted` 在半透明侧栏上低于 4.5:1，就在 `[data-vibrancy="on"] .sidebar` 下把它覆盖为 `#5f5f64`（浅色）和 `#b0b0b6`（深色）。

## Critical files & anchors

- `src-tauri/src/omp_models.rs:121-195, 611-635, 692-761`：配置读写底层函数、`update_model_config_impl` 的冲突写法（照抄）、需要迁出的假 omp 测试辅助函数。
- `src-tauri/src/menubar/tray.rs:78-151, 171-189, 345-356, 438-530`：`build_menu`、`handle_menu_event`、`send_plain`、轮询循环（注入 `modes` 的位置）。
- `src-tauri/src/ops/commands.rs:137-182`：`open_in_iterm_impl` 的校验块，要抽成 `resume_target`。
- `src/components/Sidebar.tsx:97-130, 239-359, 364-394, 428-529`：本地状态、两种组头、footer、`Row`/`PinToggle`。
- `src/modelDraft.ts:146-161, 299-332, 377-443`：`deriveDirty`、`loadConfig`/`reloadBaseline`、`saveBlock` 的接入点。

## Verification

每个阶段结束时都运行（工作目录为仓库根）：

```sh
npm run check
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
```

**新增的永久测试**（必须覆盖以下行为）：
- Rust `model_presets` 模块（使用 `omp_fake`）：
  - 名称边界：`"A"`、`"a-1_b"` 通过；`""`、`"1a"`、`"中文"`、65 字符被拒。
  - `parse_presets` 对 5 类非法条目给出对应的 `invalid_reason`。
  - `find_active`：thinking 不同时不命中；overrides 不同时不命中；两个预设内容相同时取排序在前的。
  - save：新建成功；同名且未覆盖 → InvalidInput；覆盖成功；expected 不一致 → Conflict 且不发生 set；当前角色为空 → InvalidInput。
  - switch：`set_log` 按顺序记录 roles → overrides → thinking；expected 不一致 → Conflict 且无 set；名称不存在 → NotFound；条目无效 → InvalidInput；default 模型不在 `models.json` 中 → InvalidInput 且无 set；用 `fail-set-defaultThinkingLevel` 注入失败后，日志显示 roles 和 overrides 被写回旧值，错误信息含「已恢复原配置」；busy 时第二个写入者收到 Busy。
  - delete：成功；不存在 → NotFound；可以删除名称不合法的条目。
- Rust `menu.rs`：`modes` 不同 → `same_structure` 为 false，`refresh_decision` 为 Rebuild；`mode_entries` 正确标记 active 和 enabled。
- Rust `ops`：`resume_command_impl` 返回 `cd '<cwd>' && omp --resume '<path>'`；`reveal_session_file_impl` 用假 Runner 断言调用参数为 `("/usr/bin/open", ["-R", path])`，非会话路径报错且不调用 Runner；`open_project_dir_impl` 对不存在的目录返回 `CwdMissing` 且不调用 Runner。
- TS `sessionMenus.test.ts`：
  - 在用会话的「在 iTerm 继续」和「删除…」禁用；cwd 缺失时三项禁用。
  - 标签勾选状态大小写不敏感；已满 10 个时未勾选项和「新标签…」禁用。
  - 批量菜单的置顶文案切换正确；组头菜单在 `dirMissing` 时对应项禁用。
- TS `metaOps.test.ts`（用 `mockIPC`）：串行写入时 `expectedRevision` 逐次递增；alias 和 note 保持原值；第二次写返回 CONFLICT 时抛出 `MetaBatchError`，`updated` 为 1。
- TS `Sidebar.test.tsx`（用 `vi.mock("../nativeMenu")` 捕获 specs）：
  - 右键未勾选行时 `selectedPath` 不变，弹出单会话菜单；右键已勾选行（共勾选 2 项）时弹出批量菜单。
  - 运行「重命名…」后出现输入框；输入新名按 Enter，`setSessionMeta` 收到 `{alias:新名, tags:原值, note:原值}`；按 Esc 不发生调用。
- TS `ModePicker.test.tsx`（用 `mockIPC`）：
  - 按钮显示 `模式：A` 或 `模式：自定义`；
  - 非法名称时保存按钮禁用并显示规则文案；
  - 点击预设后调用 `switch_model_preset` 并带上 `expected`；
  - 返回 CONFLICT 时重新调用 `list_model_presets` 并显示 toast。
- 修改 C4 和 C7 后，凡是靠字形或旧空态文案查询元素的测试，改为 `getByRole(..., { name })` 或新文案。

**端到端冒烟**（`npm run tauri dev`；用 `computer` 截图或读 AX 取证）：
1. **模式**。在沙箱里跑，不碰真实配置：

   ```sh
   T=$(mktemp -d); chmod 700 "$T"; cp ~/.omp/agent/config.yml ~/.omp/agent/models.yml "$T"/
   PI_CODING_AGENT_DIR="$T" npm run tauri dev
   ```

   结束后 `rm -rf "$T"`。步骤：
   - 底部模式弹层 → 存为 `A`。
   - 到「管理 → 模型」把 default 改成另一个模型并保存，存为 `B`。
   - 切换到 `A`：`PI_CODING_AGENT_DIR="$T" omp config get modelRoles --json` 和 `task.agentModelOverrides` 的结果都应与保存 `A` 时一致；按钮显示 `模式：A`；托盘「模式」子菜单中 A 被勾选（最多等 30 秒，或切换后立刻生效）。
   - 从托盘点 B：收到「已切换模式」通知；回到窗口聚焦后，按钮显示 `模式：B`。
   - 在终端用 `omp config set` 改动 modelRoles 后，在弹层点 A：出现 CONFLICT toast，列表已刷新。
2. **右键菜单**。
   - 右键未选中的行：出现原生菜单，详情页不切换，该行出现描边；「复制 ▸ 续聊命令」后剪贴板为 `cd '…' && omp --resume '…'`。
   - 「在 Finder 中显示」：Finder 打开并选中对应的 `.jsonl`。
   - 「重命名…」：改名后回车，列表主标题更新，详情页的元数据编辑器中标签和备注不变。
   - 勾选两行后右键：出现批量菜单；加标签后两行都出现该标签。
   - 右键组头：「折叠全部」后所有组折叠。
3. **视觉**：完成 C8 的截图与清单，确认侧栏呈半透明材质（或已走回退方案），全应用没有残留的 emoji 图标。

## Assumptions & contingencies

- 模式包含三项：角色模型、默认推理档位、各 agent 模型覆盖。兜底链、禁用 agent、advisor 不属于模式。切换只写全局配置，不提供「按模式单次启动」。
- 模式名受 omp 规则限制，不支持中文名；这是为了能和终端的 `/modelpreset` 通用。
- 右键菜单不标快捷键，列表也不加键盘导航；菜单里不提供「用模式打开」。
- 删除依旧是现有的永久删除并带确认框，不加移到废纸篓、归档或导出。
- README 截图不在本计划内更新。
- 若 A5 验证显示 omp 会剔除 `agentModelOverrides`：改用 A5 中写明的 app 侧 `model-presets-ext.json` 方案。
- 若 C5 的透明窗口出现渲染问题：执行 C5 写明的回退方案。
- 若 C1 两种下载方式都失败：停在 C1，向用户报告网络错误；Phase A、B 不受影响，照常交付。
