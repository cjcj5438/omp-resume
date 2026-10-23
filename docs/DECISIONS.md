# omp-resume 实测与决策记录（DECISIONS）

本文件收录从 `docs/CONTRACT.md` 移出的带日期实测与调研记录（D1–D9）。
内容均为移出时的原文，不再随代码更新；CONTRACT 原位置留有指引行。

## D1：未验证 / 待实现注意（原 CONTRACT 附录 B）

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

## D2：用量统计真实数据只读调查（原 CONTRACT §12.6）

### 12.6 真实数据只读调查（2026-10-16）

方法：只遍历 ~/.omp/agent/sessions 的顶层与 sibling 目录 JSONL，逐行解析，
按 entry id 收集「文件、行号、type、原文规范化内容」；分别比较同文件重复、跨文件完全复制、
跨无关文件同 id 不同内容；再对照 header.parentSession 与 previousSessionFiles，未读任何模型凭据。

- 首次快照：68 顶层 + 269 嵌套（相较简报 264，运行中会继续增加），无坏行。
- 顶层有 173 种重复 entry id，均为唯一 fork 父子复制，**103 次 message id 重复全部来自这对 fork**：
  48 assistant、51 toolResult、4 user；其余重复为 custom/配置等类型及 3 条 model_usage。
  父会话 `01a134a7-…` → 子会话 `01a134fa-…`，复制条目内容完全一致；没有同文件内重复。
- 全部顶层 + 嵌套另发现 **1 个跨无关 advisor 文件真实撞 id：a417d51d**，
  分别为不同 owner 会话 advisor 中的 user 与 toolResult，时间/内容不同，无 fork 血缘；
  **不去重**。单测还覆盖两个无关 advisor 即使 id/时间/用量完全相同也分别计费。
- previousSessionFiles 仅 1 个迁移记录，不建立去重关系；嵌套 parentSession 也有指向 owner 的正常情况，
  不据此合并不相同条目。
- task 核实方法：检查所有 toolName=task 的 toolResult.details 中递归 numeric cost，
  并与 sibling JSONL 的 assistant/model_usage 对照。首次快照有 47 条带 cost 字样的 task toolResult，
  74 个 cost 数值均为 progress.*.cost=0，results=[]（async 状态），并非新增账单；
  这些状态不参与花费提取，嵌套 usage 单独求和，杜绝后续非零转述与嵌套重复入账。
- fork 复制涉及主对话 $0.27746302、后台 $0.00673590，去重后总账相应扣除。
  首次 Python 只读粗合计（去重前）：主 $124.66452912、顶层后台 $8.89896352、
  嵌套 assistant $25.29857611、嵌套后台 $0.24156056；与简报的出入来自运行中的追加与嵌套后台纳入。

- Rust 实现只读回归（同日稍后，debug 构建）：337 文件 = 68 顶层 + 269 嵌套；
  去重后主对话 **$124.49429938**、后台（含嵌套）**$9.35127952**、子代理 **$26.77144350**，
  总计 **$160.61702240**、Token **2,131,166,844**；冷扫描 **2.244 秒**，缓存再扫描 **75.94 毫秒**。
  比首次快照仍有少量增量，来自同时运行的会话追加；上述两次计时均只读、不改写原始数据。

## D3：清理候选真实数据只读回归（原 CONTRACT §14.5）

### 14.5 真实数据只读回归（2026-10-16）

`cargo test --lib real_data_cleanup -- --ignored --nocapture`（只读，不改写 `~/.omp`）：

- 68 个顶层会话，**18 个候选**：`empty` 4、`cwd_missing` 4、`large` 10、`stale` 0；
  占用中 3、占用未知 0；可释放合计约 **271–273 MB**（两次运行间隔内仍在增长的线上会话会抬高该值）；
  耗时约 **0.4 秒**。
- 最大候选 73 MB（jsonl 2.49 MB + sibling 附件目录约 71 MB），与 `du` 核对一致
  ——印证体积必须把附件算进去。
- 与立项时快照（68 个会话、附件 965 文件/53 MB）相比，sessions 目录已增长到
  约 325 MB（附件 1181 文件），故「可释放合计」远大于快照值。

## D4：别名/标签/备注实测（原 CONTRACT §15.5）

### 15.5 实测记录（2026-10-16，macOS arm64）

- 后端单测 13 项（往返、revision 冲突、损坏不覆盖、0600、校验边界、
  全空删除条目、无操作幂等、孤儿保留、删除联动清理、清理失败不影响删除、
  数据目录覆盖）全部通过。
- 前端单测 26 项（filterGroups 命中 alias/tag/note、标签 AND 过滤、
  标签计数、别名行内展示、标签过滤条、编辑器脏态/冲突/损坏）全部通过。
- `npm run dev + ?mock=1` 真实浏览器冒烟：编辑别名/标签/备注并保存，
  列表行显示别名 + 原标题灰字 + 标签徽章，标签过滤条按 AND 过滤，
  详情编辑器 dirty/保存/还原行为正确。
- 后端真实读写冒烟（`OMP_RESUME_DATA_DIR=/tmp/...`）：写入 meta.json
  权限 0600，删除会话后条目被联动清除。

## D5：模型配置实测（原 CONTRACT §16.7）

### 16.7 实测记录（omp 18.11.1，2026-10-16）

- `omp models --json`：65 个模型，10.3 秒；字段与 §16.3 一致，无凭据；
  `thinking` 档位集合有 `minimal/low/medium/high/xhigh/max` 的多种组合。
- `omp config get <key> --json` → `{"key","value","type","description"}`；
  5 个 key 的 type 分别为 record/record/array/record/record。
  `omp config set <key> <json>`：不支持点号子键；只校验外层对象/数组，
  内层垃圾值（数字、伪 on/off、链条目非数组）会静默写入 → 由本应用 §16.2 拦截。
- `omp agents unpack --dir <不存在的目录> --json` 会自建目录并写 5 个内置
  md（task/sonic/scout/reviewer/security-reviewer），frontmatter 含
  name/description/model/thinkingLevel（如 `model:\n  - "@task"`、
  `model: "@smol"`；security-reviewer 无 model 与 thinkingLevel）。
- 沙箱冒烟（`cargo test --test models_sandbox -- --ignored --nocapture`，
  单测试串行）：真实 HOME 只读 `get_model_config` 仅打印条数（roles 10、
  overrides 5、disabled 0、advisor 2、chains 9）与 5 个内置 agent 名；
  随后 `HOME=<临时目录>` 用真实 omp 对 5 个 key 各 set 一遍（含
  `modelRoles` 的 `:thinking` 后缀、`retry.fallbackChains` 数组值、
  `task.disabledAgents` 数组），断言 `$HOME/.omp/agent/config.yml` 落盘内容
  与复读结果一致，并验证旧 expected 写入报 `CONFLICT`。
- 已知限制：一个 chain 里存在脏值（非字符串条目）时该 chain 保存会被
  `INVALID_INPUT` 拒绝（点名，需在 omp 侧手动修复）；新增角色只能来自
  常见角色列表；`provider/*` 通配 key 可经手动输入新建（与旧限制不同）。
- （2026-10-18，omp 18.12.2，只读 `omp models --json`）120 条模型、6 个
  provider：`name` 只对**部分账号**自带「(账号)」后缀（本机 10 条带、其余
  不带；个别条目的括号里是产品名而非账号，如「… (New)」），不能靠 `name`
  判断供应商；另有 4 条 `thinking: null`，档位表为空。据此 chip 一律显示
  `ModelInfo.provider` 徽章，档位徽章不再省略（§16.6）。同版本
  `omp agents unpack` 实测内置 agent 为 6 个（新增 seance，含
  `spawns`/`tools` frontmatter；§16.6 流程图与 `AGENT_INFO` 只覆盖
  name/description，不解析 spawns/tools）。

## D6：兜底语义调研（原 CONTRACT §16.8）

### 16.8 兜底语义调研（2026-10-16，omp 18.11.2；UI 文案依据）

> 方法：`omp config get <key> --json` 读白名单 key 的完整 description 与值
> （只读；未运行 `omp config list`、未读 models.yml/models.json）；
> 从 omp 二进制字符串（`strings`）反编译出配置 schema 与
> `retry-fallback-chains.ts` 的匹配逻辑；`HOME=<临时目录>` + 真实 omp 验证
> 枚举值校验。**不修改用户真实配置。**

**已验证：**

- **角色清单**（模型浏览器固定列表）：`default / smol / slow / vision / plan /
  commit / tiny / memory / task / advisor`（对话类）+ `image / web / speech /
  dictation / judge`（能力类，需专用模型）。内置中文名与用途：
  主对话（平时主力）、轻快任务（提交信息/标题等轻量活）、深度思考、图片理解、
  方案设计（plan，Architect）、提交信息（commit，生成 git 提交信息）、极简任务
  （tiny，标题生成等）、记忆助手（memory）、子任务（task，子代理未指定模型时）、
  顾问（advisor，每轮被动评审）；能力类：图片生成 / 联网搜索 / 语音合成 /
  语音听写 / 裁判（judge）。
- **别名**：`@role[:thinking]` / `pi/role[:thinking]` 解析到角色的 `modelRoles`
  值；未配置时按角色回退链（advisor→slow→default、memory→tiny→smol→…、
  tiny→smol→default，源码 `abe` 表）或内置默认（如 smol 的内置候选表）。
  `@smol` 等值不在模型列表时 UI 原样保留显示。
- **`retry.fallbackChains` 的 key** 三种（description 原文 + 匹配代码）：
  ① 角色名（无 `/`）——该角色的模型出错时用；② 模型 selector
  （`provider/model`，匹配忽略 `:thinking` 后缀）——**不管哪个角色在用**，
  该模型出错时用；③ provider 通配（`provider/*` 或 `id/prefix/*`）——保留出错
  模型的 id 换 provider，`a/b/*` 只匹配 `a` 下 `b/` 开头的 id。
- **匹配优先级**（源码 `Qv`）：模型 key 精确（含 thinking）→ 模型 key base
  （忽略 thinking）→ 通配 key（长 id 前缀优先）→ 会话钉住的角色 →
  角色 key（仅「effort 不同」的弱匹配，能完全匹配直接命中）→ `default`。
  一个失败回合可能同时挂多条链：钉住的角色链在前、解析出的角色链在后。
- **`:thinking` 后缀**：chain **key** 匹配时忽略（base 比较）；chain **条目**
  带后缀（`:low/:high/:max/:off`）显式指定档位，裸条目继承出错回合的档位；
  通配条目恒继承。§16.7 曾记「thinking level 不同则链被跳过」的 bug 已被
  omp 修复（changelog #13789），匹配照常。
- **`retry.fallbackOn`** 枚举（沙箱 set 有效值 + 非法值被拒并列出全集）：
  `any`（任何错误都切换，默认）/ `usage-limit`（仅用尽额度时切换）/
  `except-usage-limit`（除用尽额度外都切换）。
- **`retry.fallbackRevertPolicy`** 枚举（同上验证）：`cooldown-expiry`
  （主模型抑制窗口结束后自动切回，默认）/ `never`（切走后不自动切回）。
- **`retry.modelFallback`**（boolean，默认 true）：兜底总开关，关掉后
  `retry.fallbackChains` 全部不生效（changelog #15636 明确）。
  `retry.usageAwareFallback`（boolean，默认 false）：额度感知兜底，
  本 UI 不展示（另有 `usageReservePct/Policy` 相关设置，超出本页范围）。

**未验证（UI 用保守措辞）：**

- agent 名（如 `task`/`sonic`）作为 chain key 的行为：按匹配代码，非角色名的
  key 无法命中（`getModelRole(name)` 为空则不匹配），但子代理带 roleHint（如
  `@task`）时按角色 key 处理；UI 对「没有同名角色的 key」只提示
  「omp 可能不会使用这条配置」，原样保留。
- `default` 链的「自动补全」语义（`wL`：default 链会临时补给没有链的
  常见角色）只在运行时验证过方向、未做端到端实验。
- 压制/冷却窗口的具体时长（`suppressSelector` 默认 5 分钟或按错误类型）未逐一验证。

> 已知限制见 §16.7。注意：通配 key 可经「使用自定义值…」手动输入新建，
> 本节不保留旧的「无法新建通配 key」说法。

## D7：菜单栏实测（原 CONTRACT §17.8）

### 17.8 实测记录（2026-10-16，macOS arm64）

（真机验证数据见下节补充；以下为探针数据）
- flock 全量探测 362 把锁约 5ms；`lsof` 批量查持有者约 0.1–0.35s（T1 仅变化时跑）；
  T2 首轮全文件种子约 180ms（4 个会话），增量轮 1–2ms；
  T3 osascript 批量取标题约 10–30ms（单次实测 0.17s 冷启，热轮更低）。
- 真实环境判定（详见报告）：11 把被持有锁 → 4 个顶层会话（其余为子代理锁，
  计入未归属）；3 个「空闲」（iTerm 标题 `>`、数小时无有意义记录），
- 图标点击（2026-10-16 复测）：**左键与右键都能弹出下拉菜单**
  （`show_menu_on_left_click(true)` 生效）。此前「左键不弹」的结论是
  合成点击（CGEventPost 之外的注入路径）打不到 `TaoTrayTarget` 覆盖层的
  测试假象；硬件级事件（`CGEventCreateMouseEvent` + `CGEventPost(kCGHIDEventTap)`，
  先 mouseMoved 再 Down/Up）实测左键正常弹出，对照组（系统菜单栏 Apple 菜单）
  同一手段可弹。

## D8：LIKE-not-FTS 决策（原 CONTRACT §18.7）

### 18.7 LIKE-not-FTS 决策与证据

- 搜索用 `LIKE`（转义 `%`/`_`/`\` + `ESCAPE '\'`），不用 FTS5：FTS5 默认分词把连续 CJK 切成一个 token，
  `MATCH` 要求 token 边界对齐，而搜索框语义是子串。证据（2026-10-20 真实库只读）：CJK 长串内部 2 字为查询，
  三 bank 均 `MATCH`=0、`LIKE`=1。

## D9：模型测试器实测（原 CONTRACT §20.6）

### 20.6 实测记录（omp 18.12.3，2026-10-20）

- `amr-link/deepseek-v4.1-flash:max` 按 §20.1 两次探针实跑：短探针 32.5s、长探针 11.5s，
  共 $0.0022；短探针 tok/s 34–168，长探针 163–168（据此定 tok/s 只取长探针）。
- 免费档 `opencode-zen/*-free` 实跑：`{"ok":false,"error":"403 … FreeTierError"}`、退出码 1、
  JSON 照常输出、无回退替换。
- 对真实 `agent.db` 执行 `model_perf_list`：读前读后 `agent.db` / `-wal` / `-shm` 的大小与 mtime 均不变。
