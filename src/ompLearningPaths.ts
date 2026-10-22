/**
 * 入门路径：把散落的命令按学习顺序串起来，供速查页「入门路径」使用。
 *
 * 与 `ompCombos.ts` 的区别：组合用法解决「眼下这个场景该按什么顺序敲」，
 * 这里解决「我该按什么顺序把这些能力学会」。每一步都引用
 * `OMP_COMMANDS` 里真实存在的命令（含别名），单测逐条校验。
 */
export interface LearningStep {
  /** 要学的命令（不带 `/`），必须能在 `findOmpCommand` 里查到。 */
  cmd: string;
  /** 这一步解决什么问题、为什么排在这里。 */
  why: string;
  /** 现在就试一次的示例（可带 `<占位符>`），复制按钮复制这一行。 */
  tryIt: string;
}

export interface LearningPath {
  id: string;
  title: string;
  /** 学完这条路径能达到什么。 */
  goal: string;
  /** 建议先读的前置路径 id（可为空）。 */
  after?: string;
  steps: LearningStep[];
}

export const OMP_LEARNING_PATHS: LearningPath[] = [
  {
    id: "first-hour",
    title: "第一小时：把日常操作跑一遍",
    goal: "能独立开会话、看上下文、切模型、压缩、退出，不被基础操作绊住。",
    steps: [
      { cmd: "new", why: "每个任务一个新会话，旧上下文不会污染判断。", tryIt: "/new" },
      { cmd: "context", why: "随时知道上下文用了多少，是后面所有优化的前提。", tryIt: "/context" },
      { cmd: "model", why: "先看清当前用的是什么模型，再谈换不换。", tryIt: "/model" },
      { cmd: "compact", why: "上下文过半时主动压缩，比等到爆掉再救便宜得多。", tryIt: "/compact 保留接口签名和失败原因" },
      { cmd: "hotkeys", why: "键盘操作比敲斜杠命令快一个量级。", tryIt: "/hotkeys" },
      { cmd: "exit", why: "会话会被保存；下次用 /resume 接着聊。", tryIt: "/exit" },
    ],
  },
  {
    id: "context-budget",
    title: "上下文预算：什么时候压、压什么",
    goal: "在长会话里稳定推进，不因遗忘早期内容而返工，也不浪费 token。",
    after: "first-hour",
    steps: [
      { cmd: "context", why: "先量：看是工具结果占大头还是对话本身占大头。", tryIt: "/context" },
      { cmd: "shake", why: "工具结果是最没营养的部分，先丢它代价最小。", tryIt: "/shake elide" },
      { cmd: "compact", why: "丢完还是高，再压缩；把不能丢的要点写进参数。", tryIt: "/compact 保留迁移步骤与回滚方案" },
      { cmd: "handoff", why: "要换会话或换人接手时，先让 omp 写交接摘要再压缩。", tryIt: "/handoff 保留未完成的改动清单" },
      { cmd: "clear", why: "任务彻底结束时清空，比带着旧结论开新任务更干净。", tryIt: "/clear" },
    ],
  },
  {
    id: "model-cost",
    title: "模型与成本：按任务选档",
    goal: "知道什么任务该用哪个模型/档位，并能在会话中途切换而不丢上下文。",
    after: "first-hour",
    steps: [
      { cmd: "modelpreset", why: "把「常用组合」存成预设，之后一键切换。", tryIt: "/modelpreset save 日常" },
      { cmd: "effort", why: "同一个模型，推理档位不同，质量和花费差很多。", tryIt: "/effort low" },
      { cmd: "switch", why: "会话中途换模型，支持 @角色 与 :档位。", tryIt: "/switch @slow:high" },
      { cmd: "fast", why: "赶时间时切极速档，代价是更贵。", tryIt: "/fast status" },
      { cmd: "slow", why: "批量、不着急的活切慢速档，省钱。", tryIt: "/slow status" },
      { cmd: "usage", why: "看各账号限额还剩多少，避免撞额度。", tryIt: "/usage" },
      { cmd: "prewalk", why: "规划阶段用贵模型、动手时切便宜模型，一次性交接。", tryIt: "/prewalk" },
    ],
  },
  {
    id: "parallel-agents",
    title: "多 agent：把活分出去",
    goal: "能让 omp 并行干活、看得见谁在干什么、随时叫停。",
    after: "context-budget",
    steps: [
      { cmd: "agents", why: "先看清有哪些内置 agent 和它们各自用什么模型。", tryIt: "/agents" },
      { cmd: "plan", why: "并行前必须有清晰计划，否则子代理各做各的。", tryIt: "/plan <任务目标>" },
      { cmd: "tan", why: "把互不相关的旁支任务丢到后台，主线继续。", tryIt: "/tan <旁支任务描述>" },
      { cmd: "jobs", why: "看后台任务跑到哪、有没有失败。", tryIt: "/jobs" },
      { cmd: "hub", why: "实时总览所有 agent 的状态。", tryIt: "/hub" },
      { cmd: "pause", why: "发现方向错了先冻结全部 agent，比逐个杀快。", tryIt: "/pause" },
    ],
  },
  {
    id: "workspace-git",
    title: "工作区与 git：安全改代码",
    goal: "能在隔离 worktree 里试改动、随时回退、把结果放进 git。",
    after: "first-hour",
    steps: [
      { cmd: "dirs", why: "先确认会话能碰到哪些目录，避免改到范围外。", tryIt: "/dirs" },
      { cmd: "wt", why: "有风险的改动搬进新 worktree，主工作区不受影响。", tryIt: "/wt <分支名>" },
      { cmd: "git", why: "用可视化界面看 diff、暂存、写提交信息。", tryIt: "/git" },
      { cmd: "branch", why: "对话走偏时回退到某条消息，原路径留作分支。", tryIt: "/branch" },
      { cmd: "cleanse", why: "提交前并行跑诊断与测试，把低级错误挡在提交前。", tryIt: "/cleanse" },
    ],
  },
  {
    id: "shared-handoff",
    title: "交接与协作：把会话交给别人或另一台机器",
    goal: "能把工作原样交出去，也能只读地请教别人的会话。",
    after: "context-budget",
    steps: [
      { cmd: "handoff", why: "先写好交接摘要，接手方不用重读全文。", tryIt: "/handoff 保留未完成的改动清单" },
      { cmd: "export", why: "把会话导成 HTML，便于归档或贴给别人。", tryIt: "/export <输出路径>" },
      { cmd: "seance", why: "只读咨询另一个已存的会话，不会修改它。", tryIt: "/seance <会话路径>" },
      { cmd: "share", why: "生成加密链接分享会话（链接可访问，注意内容）。", tryIt: "/share" },
      { cmd: "collab", why: "需要实时一起看同一会话时才用中继协作。", tryIt: "/collab start" },
    ],
  },
];
