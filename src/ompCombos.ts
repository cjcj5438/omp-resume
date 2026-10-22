/**
 * 命令速查的「组合用法」数据：场景 → 按顺序执行的命令序列。
 *
 * 每条步骤只允许引用 OMP_COMMANDS 中真实存在的命令（含别名），
 * 单测会逐条校验；带参数的步骤写成含 `<占位符>` 的模板，由用户自行替换。
 * 说明文字与紧凑程度都以 omp 内置命令注册表为准（18.12.6），不描述表外的行为。
 */
import { findOmpCommand } from "./ompCommands";

export interface OmpComboStep {
  /** 要复制的命令行（含前导 `/`），可带 `<占位符>`。 */
  cmd: string;
  /** 一句话说明这一步做什么。 */
  note: string;
}

export interface OmpCombo {
  id: string;
  /** 场景标题。 */
  title: string;
  /** 一句话说明什么时候用。 */
  when: string;
  steps: OmpComboStep[];
}

export const OMP_COMBOS: OmpCombo[] = [
  {
    id: "context-full",
    title: "上下文快满了",
    when: "会话开得太久、/context 显示占用偏高，或模型开始遗忘早期内容时。",
    steps: [
      { cmd: "/context", note: "先看占用明细，确认接近上限。" },
      { cmd: "/shake elide", note: "先丢掉工具结果等臃肿内容，代价最低。" },
      { cmd: "/compact", note: "再压缩上下文；有要保留的重点就写成 /compact <重点>。" },
      { cmd: "/context", note: "复查占用是否降下来。" },
    ],
  },
  {
    id: "fresh-start",
    title: "开新任务的稳妥开局",
    when: "接手一个新任务，想从干净会话开始、先把范围说清楚。",
    steps: [
      { cmd: "/new", note: "开新会话，避免旧上下文干扰。" },
      { cmd: "/add-dir <项目路径>", note: "需要多目录时补上工作目录。" },
      { cmd: "/plan <任务目标>", note: "先让 agent 规划再动手。" },
    ],
  },
  {
    id: "plan-first",
    title: "复杂任务先计划再执行",
    when: "改动牵扯面大、方案不唯一，不想让 agent 直接边想边改。",
    steps: [
      { cmd: "/plan <任务目标>", note: "进入计划模式，先出方案。" },
      { cmd: "/plan-review", note: "重新打开最新计划的评审面板（仅计划模式）。" },
      { cmd: "/effort high", note: "进入执行前抬高推理强度（可按需改档位）。" },
    ],
  },
  {
    id: "rewind",
    title: "想回退或试另一条思路",
    when: "当前这条路走歪了，想回到之前的节点换个做法，又不想丢掉原路径。",
    steps: [
      { cmd: "/tree", note: "浏览会话树，找到要回到的节点。" },
      { cmd: "/branch", note: "回退到该消息，原路径保留为分支，随时能切回。" },
      { cmd: "/fork pane", note: "想并行试两条思路时，把当前会话分叉到新终端面板。" },
    ],
  },
  {
    id: "vibe",
    title: "并行多路开发",
    when: "任务能拆成几条互不依赖的支线，想同时推进。",
    steps: [
      { cmd: "/vibe <总目标>", note: "进入 vibe 模式，主会话只做指挥与验收。" },
      { cmd: "/hub", note: "打开实时 agent 总览，随时看各路进度。" },
      { cmd: "/jobs full", note: "查看后台异步任务的完整命令行。" },
    ],
  },
  {
    id: "usage-model",
    title: "看用量、限额，再决定模型",
    when: "怀疑额度快用完、响应变慢，或想换成更省钱/更强的模型。",
    steps: [
      { cmd: "/usage", note: "看各服务商用量与限额。" },
      { cmd: "/switch <模型>", note: "模糊切换模型，支持 @角色与 :档位。" },
      { cmd: "/effort <档位>", note: "按任务难度调整推理强度。" },
    ],
  },
  {
    id: "diagnose",
    title: "排查问题、看日志",
    when: "行为不符合预期：想看后台在跑什么、这一轮的链路和工具调用。",
    steps: [
      { cmd: "/jobs full", note: "先确认后台任务与完整命令行。" },
      { cmd: "/trace", note: "在统计面板打开本会话链路。" },
      { cmd: "/debug", note: "打开调试工具选择器逐个看。" },
      { cmd: "/cleanse", note: "怀疑是项目诊断问题就并行检测一遍并修复。" },
    ],
  },
  {
    id: "wrap-up",
    title: "整理收尾与提交",
    when: "一轮开发做完，准备清理诊断问题并提交。",
    steps: [
      { cmd: "/todo", note: "先看待办是否都已收口。" },
      { cmd: "/cleanse", note: "并行检测并修复项目诊断问题。" },
      { cmd: "/git", note: "打开可视化 git 界面，检查改动并提交。" },
    ],
  },
  {
    id: "handoff-out",
    title: "把工作交接出去",
    when: "要换会话继续、或把成果发给别人时。",
    steps: [
      { cmd: "/handoff <要保留的要点>", note: "生成交接摘要并就地压缩，供新会话接着干。" },
      { cmd: "/dump all", note: "打包完整记录（含子 agent）留档。" },
      { cmd: "/share", note: "需要发给别人时，生成加密链接分享会话。" },
    ],
  },
  {
    id: "goal",
    title: "让 omp 自主推进一个目标",
    when: "目标明确、验收标准清楚，想让它自己一轮轮推。",
    steps: [
      { cmd: "/goal set <目标>", note: "设定目标，进入目标模式自主推进。" },
      { cmd: "/goal budget <N|off>", note: "设 token 预算防跑飞：把 N 换成 token 数，或写 off 关闭。" },
      { cmd: "/goal show", note: "随时查看目标详情与进度。" },
      { cmd: "/goal drop", note: "不需要了随时放弃目标。" },
    ],
  },
  {
    id: "memory",
    title: "记忆库维护",
    when: "memory.backend 为 mnemopi 时，想确认 omp 记住了什么、看统计与诊断（其它后端部分子命令不可用）。",
    steps: [
      { cmd: "/memory view", note: "看当前注入的长期记忆。" },
      { cmd: "/memory stats", note: "看记忆库统计：各 bank 的条目、triple 数与最后写入时间。" },
      { cmd: "/memory diagnose", note: "跑一遍后端诊断，有问题会列出来。" },
      { cmd: "/memory enqueue", note: "强制合并一次：保留当前会话并 sleep（只合并 12 小时以上的条目）。" },
    ],
  },
  {
    id: "mcp-setup",
    title: "给会话接入 MCP 服务",
    when: "想让 agent 用上外部工具（搜索、数据库、浏览器等）时，先把 MCP 服务接进来再开工。",
    steps: [
      { cmd: "/mcp add <服务名>", note: "新增 MCP 服务：只给名称会进交互向导；也可照参数模板补 --url <地址>，或把本地启动命令接在 -- 后面。" },
      { cmd: "/mcp test <服务名>", note: "测试新服务是否连得通。" },
      { cmd: "/mcp list", note: "确认服务已在列表中并处于启用状态。" },
    ],
  },
];

/**
 * 组合用法过滤：场景标题、何时使用、每步命令与说明，
 * 大小写不敏感子串匹配；空查询返回原数组。
 */
export function filterOmpCombos(combos: OmpCombo[], query: string): OmpCombo[] {
  const q = query.trim().toLowerCase().replace(/^\/+/, "");
  if (!q) return combos;
  return combos.filter((c) => {
    if (c.title.toLowerCase().includes(q)) return true;
    if (c.when.toLowerCase().includes(q)) return true;
    return c.steps.some(
      (s) => s.cmd.toLowerCase().includes(q) || s.note.toLowerCase().includes(q),
    );
  });
}

/** 组合里某一步不存在于内置注册表时返回该步，便于单测与调试。 */
export function findUnknownComboStep(combo: OmpCombo): OmpComboStep | undefined {
  return combo.steps.find((s) => {
    const name = s.cmd.trim().replace(/^\/+/, "").split(/\s+/, 1)[0] ?? "";
    return findOmpCommand(name) === undefined;
  });
}
