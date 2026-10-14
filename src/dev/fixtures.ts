/**
 * DEV-ONLY 夹具数据：仅开发/测试使用，生产包必须不包含。
 * 探针标记（用于 build 后 grep 验证）：__OMP_RESUME_FIXTURE_ONLY__
 */
import type {
  Conversation,
  ConversationItem,
  ListSessionsResult,
  SessionSummary,
  TreeData,
  TreeNode,
} from "../types";

export const FIXTURE_MARKER = "__OMP_RESUME_FIXTURE_ONLY__";

const SESSIONS_DIR = "/Users/chenjing/.omp/agent/sessions";
const NOW = Date.now();
const MIN = 60000;

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * MIN).toISOString();
}

function sessPath(dir: string, stamp: string, id: string): string {
  return `${SESSIONS_DIR}/${dir}/${stamp}_${id}.jsonl`;
}

function baseSummary(over: Partial<SessionSummary> & Pick<SessionSummary, "id" | "path" | "cwd" | "title">): SessionSummary {
  return {
    cwdExists: true,
    createdAt: iso(60 * 26),
    modifiedAt: iso(12),
    sizeBytes: 41200,
    messageCount: 8,
    branchCount: 1,
    inUse: false,
    probeOk: true,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
    ...over,
  };
}

function tn(
  id: string,
  parentId: string | null,
  childIds: string[],
  kind: TreeNode["kind"],
  role: string | null,
  preview: string,
  minutesAgo: number,
  extra?: Partial<TreeNode>,
): TreeNode {
  return {
    id,
    parentId,
    childIds,
    kind,
    role,
    timestamp: iso(minutesAgo),
    preview,
    label: null,
    isCompaction: false,
    isBranchSummary: false,
    ...extra,
  };
}

/** 线性小树 + 每节点对话：供普通会话使用。 */
function linearTree(
  tag: string,
  texts: { role: string; preview: string; item: ConversationItem }[],
): { tree: TreeData; itemsByNode: Record<string, ConversationItem[]> } {
  const nodes: TreeNode[] = texts.map((t, i) =>
    tn(
      `${tag}-n${i}`,
      i === 0 ? null : `${tag}-n${i - 1}`,
      i === texts.length - 1 ? [] : [`${tag}-n${i + 1}`],
      "message",
      t.role,
      t.preview,
      300 - i * 7,
    ),
  );
  const itemsByNode: Record<string, ConversationItem[]> = {};
  texts.forEach((t, i) => {
    itemsByNode[`${tag}-n${i}`] = [t.item];
  });
  const leafId = nodes.length > 0 ? nodes[nodes.length - 1].id : null;
  return {
    tree: {
      path: "",
      leafId,
      rootIds: nodes.length > 0 ? [nodes[0].id] : [],
      activePathIds: nodes.map((n) => n.id).reverse(),
      nodes,
    },
    itemsByNode,
  };
}

const U = (text: string): ConversationItem => ({ kind: "user", text });
const A = (text: string): ConversationItem => ({
  kind: "assistant",
  blocks: [{ kind: "text", text }],
});

export interface FixtureSession {
  summary: SessionSummary;
  tree: TreeData;
  itemsByNode: Record<string, ConversationItem[]>;
}

function withPath(
  s: FixtureSession,
  path: string,
): FixtureSession {
  return { ...s, summary: { ...s.summary, path }, tree: { ...s.tree, path } };
}

// ---- 会话 1：普通 ----
const s1id = "01a13834-80db-70cb-83b5-2f528fc1d96c";
const s1path = sessPath(
  "-my-omp-resume",
  "2026-10-14T02-18-47-387Z",
  s1id,
);
const s1lin = linearTree("s1", [
  {
    role: "user",
    preview: "给 omp 加一个可视化配置桌面应用",
    item: U("给 omp 加一个**可视化配置**桌面应用，需求如下：\n\n- [x] 浏览会话\n- [ ] 一键续聊\n\n参考 [ Tauri 文档 ](https://tauri.app)。"),
  },
  {
    role: "assistant",
    preview: "我先看一下目录结构，然后给方案",
    item: {
      kind: "assistant",
      blocks: [
        { kind: "thinking", text: "用户要做桌面应用，先看目录再定技术方案。" },
        {
          kind: "toolCall",
          id: "call_9f21",
          name: "read",
          args: { path: "src-tauri/tauri.conf.json", i: "读 Tauri 配置" },
        },
        { kind: "text", text: "我先看一下目录结构，然后给方案。" },
      ],
    },
  },
  {
    role: "toolResult",
    preview: "tauri.conf.json 内容…",
    item: {
      kind: "toolResult",
      toolCallId: "call_9f21",
      toolName: "read",
      isError: false,
      text: '{"productName": "omp-resume"}\n{"windows": [{"width": 1200}]}',
      truncated: false,
    },
  },
  {
    role: "assistant",
    preview: "方案如下：Tauri 2 + React…",
    item: A("方案如下：Tauri 2 + React + Rust。\n\n```json\n{\"port\": 1420}\n```\n\n先搭架子，再填功能。"),
  },
]);
const s1: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s1id,
      path: s1path,
      cwd: "/Users/chenjing/my/omp-resume",
      title: "🎛️ DEMO: 构建可视化配置桌面应用",
      messageCount: 24,
      sizeBytes: 1218560,
      modifiedAt: iso(3),
      firstUserMessage: "给 omp 加一个可视化配置桌面应用",
    }),
    ...s1lin,
  },
  s1path,
);

// ---- 会话 2：在用 ----
const s2id = "01a134a7-11aa-22bb-33cc-4d528fc1aa01";
const s2path = sessPath("-my-omp-resume", "2026-10-14T01-02-11-004Z", s2id);
const s2lin = linearTree("s2", [
  { role: "user", preview: "修复示例代理连接失败", item: U("修复示例代理连接失败，报错 407。") },
  { role: "assistant", preview: "正在复现，先抓日志…", item: A("正在复现，先抓日志看看握手阶段。") },
]);
const s2: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s2id,
      path: s2path,
      cwd: "/Users/chenjing/my/omp-resume",
      title: "🏠 DEMO4: 修复示例代理连接失败",
      inUse: true,
      messageCount: 31,
      sizeBytes: 2097152,
      modifiedAt: iso(1),
      firstUserMessage: "修复示例代理连接失败",
    }),
    ...s2lin,
  },
  s2path,
);

// ---- 会话 3：fork（父可解析） ----
const s3id = "01a134fa-44dd-55ee-66ff-7d528fc1bb02";
const s3path = sessPath("-my-omp-resume", "2026-10-13T22-41-00-111Z", s3id);
const s3lin = linearTree("s3", [
  { role: "user", preview: "把鉴权中间件重构成洋葱模型", item: U("把鉴权中间件重构成洋葱模型。") },
  {
    role: "bashExecution",
    preview: "cargo test auth && echo done",
    item: {
      kind: "bashExecution",
      command: "cargo test auth",
      text: "running 12 tests\ntest result: ok. 12 passed",
      truncated: false,
      exitCode: 0,
      cancelled: false,
    },
  },
]);
const s3: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s3id,
      path: s3path,
      cwd: "/Users/chenjing/my/omp-resume",
      title: "🔀 fork：鉴权中间件重构",
      fork: { parentRaw: s1id, parentTitle: s1.summary.title, parentPath: s1path },
      messageCount: 6,
      modifiedAt: iso(42),
      firstUserMessage: "把鉴权中间件重构成洋葱模型",
    }),
    ...s3lin,
  },
  s3path,
);

// ---- 会话 4：fork（父已不存在） ----
const s4id = "01a12ecf-77aa-88bb-99cc-0d528fc1cc03";
const s4path = sessPath("-my-Obsidian-doc", "2026-10-12T06-31-48-446Z", s4id);
const s4lin = linearTree("s4", [
  { role: "user", preview: "用 DEMO3 跑本地模型总结笔记", item: U("用 DEMO3 跑本地模型总结这批笔记。") },
  { role: "assistant", preview: "已连上 llama3，开始总结…", item: A("已连上 `llama3`，开始总结……") },
]);
const s4: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s4id,
      path: s4path,
      cwd: "/Users/chenjing/my/Obsidian-doc",
      title: "🦙 DEMO3: 本地模型总结笔记",
      fork: { parentRaw: "01a00000-dead-beef-0000-000000000000", parentTitle: null, parentPath: null },
      messageCount: 12,
      modifiedAt: iso(60 * 30),
      firstUserMessage: "用 DEMO3 跑本地模型总结笔记",
    }),
    ...s4lin,
  },
  s4path,
);

// ---- 会话 5：分支树（3 分支，嵌套 fork，label，compaction，leaf 非文件末） ----
const s5id = "01a12eaa-12ab-34cd-56ef-8d528fc1dd04";
const s5path = sessPath("-my-Obsidian-doc", "2026-10-12T09-15-20-200Z", s5id);
const s5nodes: TreeNode[] = [
  tn("bx-r1", null, ["bx-m1"], "message", "user", "帮我看看这个项目的结构", 900),
  tn("bx-m1", "bx-r1", ["bx-m2"], "message", "assistant", "我先看一下目录结构…", 890),
  tn("bx-m2", "bx-m1", ["bx-F"], "message", "toolResult", "package.json 内容…", 880),
  tn("bx-F", "bx-m2", ["bx-c1", "bx-d1"], "message", "assistant", "同时读了 auth.ts 和 router.ts", 870),
  tn("bx-c1", "bx-F", ["bx-c2"], "message", "user", "那把鉴权加上，支持 OAuth", 860),
  tn("bx-c2", "bx-c1", ["bx-c3"], "message", "assistant", "方案A：中间件实现…", 850, { label: "重要" }),
  tn("bx-c3", "bx-c2", ["bx-e1", "bx-e2"], "message", "assistant", "两种实现各有优劣…", 840),
  tn("bx-e1", "bx-c3", ["bx-L"], "message", "user", "用第一种，开始写吧", 830),
  tn("bx-L", "bx-e1", [], "message", "assistant", "已完成 ✅ 中间件代码如下", 820),
  tn("bx-d1", "bx-F", ["bx-d2"], "compaction", null, "已压缩：项目结构与鉴权方案…", 865, {
    isCompaction: true,
  }),
  tn("bx-d2", "bx-d1", [], "message", "toolResult", "glob 结果：42 个文件…", 855),
  tn("bx-e2", "bx-c3", [], "message", "assistant", "备选：用现成 auth 库…", 825),
];
const s5items: Record<string, ConversationItem[]> = {
  "bx-r1": [U("帮我看看这个项目的结构，重点是鉴权相关的代码。")],
  "bx-m1": [
    {
      kind: "assistant",
      blocks: [
        { kind: "thinking", text: "先看目录结构，定位鉴权模块。目录可能很大，只读顶层。" },
        { kind: "text", text: "我先看一下**目录结构**，然后定位鉴权模块。" },
      ],
    },
  ],
  "bx-m2": [
    {
      kind: "toolResult",
      toolCallId: "call_list",
      toolName: "read",
      isError: false,
      text: "src/auth.ts\nsrc/router.ts\nsrc/main.ts",
      truncated: false,
    },
  ],
  "bx-F": [
    {
      kind: "assistant",
      blocks: [
        { kind: "thinking", text: "两个文件都很关键，并行读取省时间。" },
        {
          kind: "toolCall",
          id: "call_a1",
          name: "read",
          args: { path: "src/auth.ts", i: "读鉴权实现" },
        },
        {
          kind: "toolCall",
          id: "call_a2",
          name: "read",
          args: { path: "src/router.ts" },
        },
        { kind: "text", text: "我同时读了 `auth.ts` 和 `router.ts`。" },
      ],
    },
  ],
  "bx-c1": [U("那把鉴权加上，要求支持 OAuth 和本地登录。")],
  "bx-c2": [A("方案A：中间件实现。\n\n```ts\napp.use(auth())\n```")],
  "bx-c3": [A("两种实现各有优劣：中间件更通用，装饰器更显式。")],
  "bx-e1": [U("用第一种，开始写吧。")],
  "bx-L": [
    A("已完成 ✅\n\n## 变更\n\n- 新增 `authMiddleware`\n- 接入 OAuth 回调\n\n```ts\nexport function auth() {}\n```\n\n链接不跳转：[ والعربية ](https://example.invalid)，纯文本展示。"),
  ],
  "bx-d1": [{ kind: "compaction", summary: "此前讨论了项目结构、鉴权方案A/B，决定用中间件。" }],
  "bx-d2": [
    {
      kind: "toolResult",
      toolCallId: "call_g1",
      toolName: "glob",
      isError: true,
      text: "Error: pattern too broad\nsrc/**/*.ts",
      truncated: true,
    },
  ],
  "bx-e2": [{ kind: "other", role: "developer", text: "<system-reminder>备选：用现成 auth 库也可以。</system-reminder>" }],
};
const s5: FixtureSession = {
  summary: baseSummary({
    id: s5id,
    path: s5path,
    cwd: "/Users/chenjing/my/Obsidian-doc",
    title: "🔀 分支很多的会话：鉴权方案 A/B 对比",
    messageCount: 9,
    branchCount: 3,
    sizeBytes: 4194304,
    modifiedAt: iso(60 * 20),
    firstUserMessage: "帮我看看这个项目的结构",
  }),
  tree: {
    path: s5path,
    leafId: "bx-L",
    rootIds: ["bx-r1"],
    activePathIds: ["bx-L", "bx-e1", "bx-c3", "bx-c2", "bx-c1", "bx-F", "bx-m2", "bx-m1", "bx-r1"],
    nodes: s5nodes,
  },
  itemsByNode: s5items,
};

// ---- 会话 6：不支持的格式 v2 ----
const s6id = "0199-old-format-0000-000000000006";
const s6path = sessPath("-my-Obsidian-doc", "2025-08-01T10-00-00-000Z", s6id);
const s6: FixtureSession = {
  summary: baseSummary({
    id: s6id,
    path: s6path,
    cwd: "/Users/chenjing/my/Obsidian-doc",
    title: "很老的会话（格式 v2）",
    formatSupported: false,
    version: 2,
    messageCount: 0,
    branchCount: 0,
    sizeBytes: 8192,
    modifiedAt: iso(60 * 24 * 70),
    createdAt: iso(60 * 24 * 75),
    firstUserMessage: null,
  }),
  tree: { path: s6path, leafId: null, rootIds: [], activePathIds: [], nodes: [] },
  itemsByNode: {},
};

// ---- 会话 7：目录不存在 ----
const s7id = "01a15555-aaaa-bbbb-cccc-dd528fc1ee05";
const s7path = sessPath("-work-secret-project", "2026-10-11T08-00-00-000Z", s7id);
const s7lin = linearTree("s7", [
  { role: "user", preview: "删库前先备份", item: U("删库前先备份，再跑迁移。") },
  { role: "assistant", preview: "已备份到 /tmp/db.bak", item: A("已备份到 `/tmp/db.bak`。") },
]);
const s7: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s7id,
      path: s7path,
      cwd: "/Users/chenjing/work/secret-project",
      cwdExists: false,
      title: "🗑️ 旧项目：删库迁移记录",
      messageCount: 4,
      modifiedAt: iso(60 * 49),
      firstUserMessage: "删库前先备份",
    }),
    ...s7lin,
  },
  s7path,
);

// ---- 会话 8：超长标题 + emoji + CJK ----
const s8id = "01a16666-eeee-ffff-0000-11528fc1ff06";
const s8path = sessPath("-work-secret-project", "2026-10-10T12-00-00-000Z", s8id);
const LONG_TITLE =
  "🎉🐛🔥 超长标题测试·混合Setup CJK 与 emoji 📦📦📦📦📦 重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复重复结尾";
const s8lin = linearTree("s8", [
  { role: "user", preview: LONG_TITLE.slice(0, 40), item: U("标题很长，看看省略和换行会不会炸。") },
  {
    role: "bashExecution",
    preview: "$ echo hello && sleep 0",
    item: {
      kind: "bashExecution",
      command: "echo hello",
      text: "hello\n".repeat(50),
      truncated: true,
      exitCode: 1,
      cancelled: false,
    },
  },
]);
const s8: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s8id,
      path: s8path,
      cwd: "/Users/chenjing/work/secret-project",
      title: LONG_TITLE,
      messageCount: 5,
      sizeBytes: 512000,
      modifiedAt: iso(60 * 50),
      badLines: 3,
      firstUserMessage: "标题很长",
    }),
    ...s8lin,
  },
  s8path,
);

// ---- 会话 9：探测失败 ----
const s9id = "01a17777-1111-2222-3333-22528fc10007";
const s9path = sessPath("-work-secret-project", "2026-10-09T09-00-00-000Z", s9id);
const s9lin = linearTree("s9", [
  { role: "user", preview: "权限问题排查", item: U("这个目录权限有问题，帮我看看。") },
  { role: "assistant", preview: "需要 root，先确认…", item: A("需要 root，先确认一下。") },
  {
    role: "toolResult",
    preview: "ls: Permission denied…",
    item: {
      kind: "toolResult",
      toolCallId: "call_ls",
      toolName: "bash",
      isError: true,
      text: "ls: Permission denied",
      truncated: false,
    },
  },
]);
const s9: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s9id,
      path: s9path,
      cwd: "/Users/chenjing/work/secret-project",
      title: "🔒 权限问题排查",
      probeOk: false,
      messageCount: 7,
      modifiedAt: iso(60 * 55),
      firstUserMessage: "权限问题排查",
    }),
    ...s9lin,
  },
  s9path,
);

// ---- 会话 10：普通小会话 ----
const s10id = "01a18888-4444-5555-6666-33528fc10008";
const s10path = sessPath("-work-secret-project", "2026-10-08T08-00-00-000Z", s10id);
const s10lin = linearTree("s10", [
  { role: "user", preview: "hi", item: U("hi") },
  { role: "assistant", preview: "你好！有什么可以帮你？", item: A("你好！有什么可以帮你？") },
]);
const s10: FixtureSession = withPath(
  {
    summary: baseSummary({
      id: s10id,
      path: s10path,
      cwd: "/Users/chenjing/work/secret-project",
      title: "(无标题)",
      messageCount: 2,
      sizeBytes: 2048,
      modifiedAt: iso(8),
      firstUserMessage: "hi",
    }),
    ...s10lin,
  },
  s10path,
);

export const FIXTURE_SESSIONS: FixtureSession[] = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10];

export function buildListResult(sessions: FixtureSession[]): ListSessionsResult {
  const byCwd = new Map<string, FixtureSession[]>();
  for (const s of sessions) {
    const list = byCwd.get(s.summary.cwd) ?? [];
    list.push(s);
    byCwd.set(s.summary.cwd, list);
  }
  const groups = [...byCwd.entries()].map(([cwd, list]) => ({
    cwd,
    dirName: list[0].summary.path.split("/").slice(-2, -1)[0] ?? "",
    sessions: list
      .map((s) => s.summary)
      .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1)),
  }));
  groups.sort((a, b) =>
    a.sessions[0].modifiedAt < b.sessions[0].modifiedAt ? 1 : -1,
  );
  return { sessionsDir: SESSIONS_DIR, hiddenEmpty: 2, groups };
}

/** 按树算 root→target 的对话（与后端 get_conversation 语义一致）。 */
export function conversationForPath(
  s: FixtureSession,
  nodeId?: string | null,
): Conversation {
  const chain: string[] = [];
  if (s.tree.nodes.length === 0 || s.tree.leafId == null) {
    if (nodeId) throw { code: "INVALID_NODE", message: "节点不存在" };
    return { path: s.summary.path, leafId: null, targetId: "", items: [] };
  }
  const target = nodeId ?? s.tree.leafId;
  const byId = new Map(s.tree.nodes.map((n) => [n.id, n]));
  if (!byId.has(target)) throw { code: "INVALID_NODE", message: "节点不存在" };
  let cur: string | null = target;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.unshift(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return {
    path: s.summary.path,
    leafId: s.tree.leafId,
    targetId: target,
    items: chain.flatMap((id) => s.itemsByNode[id] ?? []),
  };
}

/** 3000 条大型会话生成器（性能验证用）。 */
export function generateLargeConversation(n = 3000): Conversation {
  const items: ConversationItem[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      items.push(U(`第 ${i / 2 + 1} 个问题：这段代码是什么意思？请解释一下。`));
    } else {
      items.push(
        A(
          `这是第 ${(i - 1) / 2 + 1} 个回答：\n\n- 要点 **一**：先看调用栈\n- 要点二：再看 \`error\` 字段\n\n\`\`\`ts\nconst x: number = ${(i - 1) / 2};\n\`\`\``,
        ),
      );
    }
  }
  return { path: "large", leafId: null, targetId: "", items };
}
