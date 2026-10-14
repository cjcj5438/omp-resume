# fixtures：合成会话冒烟套件

用合成数据冒烟测试真机 app/后端，**永不触碰 `~/.omp`**。
三个脚本均为 Node 22、无第三方依赖。

## 生成

```sh
node scripts/fixtures/make-fixtures.mjs /tmp/omp-resume-fixtures
```

产物（`<outDir>/` 下）：

- `sessions/`：合成 sessions 根（含 3 个项目目录、11 个顶层 `.jsonl`，
  其中 1 个无标题零用户消息会被隐藏；另有 sibling artifacts 目录、
  `.bak` 残留、`.lock.os` 点文件、嵌套子 agent 会话——扫描必须全部忽略，
  只认顶层 `*.jsonl`）；
- `owners/`：空锁目录（holder 会在里面建锁文件）；
- `cwd/{alpha,beta,gamma}/`：真实存在的项目目录（header `cwd` 指向它们；
  另有一个会话 `cwd` 指向不存在的路径，`cwdExists` 应为 false）；
- `manifest.json`：已知真相（见下）。

fixture 内容（中英 emoji 混合标题，mtime  spread 最近 2–3 天）：

| 会话 | 要点 | 期望 |
|---|---|---|
| (a) 线性工具链 | thinking/text/toolCall、tool_execution_start、toolResult、bashExecution、developer | branch 1，msg 3，conv 6 |
| (b) 三分支 | 嵌套分支、label、compaction、branch_summary、末物理行为跳过的 session_exit | branch 3，msg 4，leaf=分支三回答，conv 5 |
| (c1) fork | parentSession=(a) 的 id | 父标题/路径可解析 |
| (c2) 幽灵 fork | parentSession 不存在 | 父标题/路径均为 null |
| (d) v2 | header version 2 | formatSupported=false，无预览/树 |
| (e) stub | 空标题零用户消息 | 隐藏，hiddenEmpty=1 |
| (f) 坏行 | 2 行垃圾 | badLines=2，照常列出 |
| (g) 大会话 | ~3000 条 | msg 3000（性能冒烟） |
| (h) 附件 | sibling 目录 + 嵌套子会话 + .bak + 点文件 | 只列出顶层 |
| 缺 cwd | cwd 不存在 | cwdExists=false |
| (i) 占用中 | 配合 hold-lock | holder 运行时 inUse=true |

`manifest.json` 结构：`groups`（dirName + 期望展示顺序的会话 id）、
`hiddenEmpty`、`heldSessionId`、`sessions[id]` =
`{file, title, branchCount, messageCount, formatSupported, version,
badLines, cwdExists, inUse, fork, leafId?, activePath?, convItems?}`。
生成器同时把 manifest 打印到 stdout。

## 占用 holder

```sh
node scripts/fixtures/hold-lock.mjs /tmp/omp-resume-fixtures/owners <sessionId> &
# 看到 "HELD <sessionId>" 后再跑验证；结束时 kill %1
```

macOS 的 flock 由子进程 `python3 -c 'fcntl.flock...'` 持有（Node 无 flock
绑定；无 python3 时可用 perl `flock` 等价替代）。

## 快照（给删除/marker 测试做 before/after diff）

```sh
node scripts/fixtures/session-dir-snapshot.mjs /tmp/omp-resume-fixtures/sessions > before.txt
# ... 跑删除/marker ...
node scripts/fixtures/session-dir-snapshot.mjs /tmp/omp-resume-fixtures/sessions > after.txt
diff before.txt after.txt
```

输出为排序好的 `<相对路径>\t<字节数>\t<sha256>`。

## 后端自验证（读 manifest 断言）

```sh
cd src-tauri
OMP_RESUME_SESSIONS_DIR=/tmp/omp-resume-fixtures/sessions \
OMP_RESUME_OWNERS_DIR=/tmp/omp-resume-fixtures/owners \
OMP_RESUME_MANIFEST=/tmp/omp-resume-fixtures/manifest.json \
cargo test --test fixtures -- --ignored --nocapture
```

`src-tauri/tests/fixtures.rs`（`#[ignore]`）逐项比对 manifest：
分组数/顺序、hiddenEmpty、每会话 branchCount/messageCount/title/
formatSupported/version/badLines/cwdExists/fork/inUse（held 仅在 holder
运行时为 true）、分支会话的 leaf/activePath、(a)(b) 的会话条目数。
