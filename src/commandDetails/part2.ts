/** 命令详解分片 2：见 ../ompCommandDetails.ts 的编写规则。 */
import type { OmpCommandDetail } from "../ompCommandDetails";

export const PART_2: Record<string, OmpCommandDetail> = {
  plan: {
    when: "需求比较大、想先看方案再动手时用：进入计划模式后模型只给计划、经你确认后才执行。",
    params: [{ token: "prompt", zh: "要规划的需求；省略则只切换模式" }],
    related: ["plan-review", "compact", "handoff"],
  },
  "plan-review": {
    when: "已经切走、想回头再看一眼最新那份计划评审时用，只能在计划模式里打开。",
    related: ["plan"],
  },
  vibe: {
    when: "想当甩手掌柜时用：主会话只做只读指挥，把具体活派给常驻的 fast/good 工作会话并行去干。",
    params: [{ token: "prompt", zh: "交给并行工作会话的目标" }],
    cautions: ["会拉起常驻工作会话并行干活，同样消耗额度与并发槽位"],
    related: ["tan", "jobs", "hub"],
  },
  goal: {
    when: "目标明确但路径很长、想让模型自主多轮推进时用，比如“把这个迁移做完”。",
    params: [
      { token: "[objective]", zh: "直接给出目标描述并进入目标模式" },
      { token: "set", zh: "设定目标" },
      { token: "show", zh: "查看当前目标与进度" },
      { token: "pause", zh: "暂停目标推进" },
      { token: "resume", zh: "恢复被暂停的目标" },
      { token: "drop", zh: "丢弃当前目标" },
      { token: "budget", zh: "设 token 预算防跑飞（<N|off>，省略看当前用量）" },
    ],
    cautions: ["目标模式会自主多轮推进，消耗额度较快；drop 会丢弃当前目标，进度不可恢复"],
    related: ["guided-goal", "pause", "jobs"],
  },
  "guided-goal": {
    when: "想用目标模式但目标还说不清楚时用：模型会通过问答帮你把目标定下来再开工。",
    params: [{ token: "rough objective", zh: "大致的目标方向，细节在问答中补齐" }],
    cautions: ["目标定下来后会进入目标模式自主推进，消耗额度较快"],
    related: ["goal"],
  },
  loop: {
    when: "同一件事要反复试直到满足条件时用，比如改完跑测试、不通过就继续修。",
    params: [
      { token: "count", zh: "固定轮数，如 5" },
      { token: "duration", zh: "持续时长，如 30m" },
      { token: "--while", zh: "命令成功时继续下一轮" },
      { token: "--until", zh: "命令成功时停止循环" },
      { token: "'<cmd>'", zh: "判停用的 shell 命令，写在引号里" },
      { token: "prompt", zh: "每轮重发的提示词" },
    ],
    cautions: ["每轮都是一次完整调用，长期循环消耗额度很快；--until 条件一直不满足时会一直跑下去"],
    related: ["pause", "jobs", "retry"],
  },
  live: {
    when: "想用说话代替打字、实时跟模型边聊边改时用，会进入基于 Codex 的语音模式。",
  },
  model: {
    when: "本会话当前模型不顺手、想换一个继续聊时用，会弹出模型选择器。",
    related: ["switch", "modelpreset", "effort"],
  },
  switch: {
    when: "知道要换哪个模型、想一行命令直接切过去时用，支持模糊名、@角色和 :档位。",
    params: [{ token: "model", zh: "目标模型，支持模糊匹配、@角色与 :档位，如 @slow:high" }],
    related: ["model", "modelpreset", "effort"],
  },
  fast: {
    when: "赶时间、愿意为更快响应多花钱时用：切到各家的极速服务档。",
    params: [
      { token: "on", zh: "开启极速档" },
      { token: "ultra", zh: "开启最高优先档（OpenAI ultrafast）" },
      { token: "off", zh: "关闭，回到普通档" },
      { token: "status", zh: "查看当前档位" },
    ],
    cautions: ["极速档按更高费率计费，ultra 档最贵；用完记得 off"],
    related: ["slow", "effort", "usage"],
  },
  slow: {
    when: "不赶时间、想省钱时用：OpenAI/Google 走 flex 便宜档，Anthropic 限额后低优先级续跑。",
    params: [
      { token: "on", zh: "开启慢速档" },
      { token: "off", zh: "关闭，回到普通档" },
      { token: "status", zh: "查看当前档位" },
    ],
    related: ["fast", "effort", "usage"],
  },
  effort: {
    when: "觉得模型想得太浅或太深时用：调本会话的推理强度档位，难题调高、简单活调低。",
    params: [{ token: "level", zh: "推理强度档位，如 high" }],
    cautions: ["会改变本会话的推理档位，影响之后所有回合的延迟与费用"],
    related: ["model", "switch", "modelpreset"],
  },
  modelpreset: {
    when: "有几套常用的角色模型加推理档位组合、想一键来回切时用，先 save 存下来再 switch。",
    params: [
      { token: "save", zh: "把当前组合存为预设" },
      { token: "switch", zh: "切换到指定预设" },
      { token: "delete", zh: "删除指定预设" },
      { token: "list", zh: "列出全部预设" },
      { token: "name", zh: "预设名" },
    ],
    cautions: ["delete 会删除指定预设，不可撤销（只删配置，不影响当前会话）"],
    related: ["model", "switch", "effort"],
  },
  prewalk: {
    when: "当前模型额度快用完、想预约一次换模型交接时用：本轮用完后自动换模型继续。",
    params: [
      { token: "restart", zh: "重新发起一次模型交接" },
      { token: "off", zh: "取消已预约的交接" },
    ],
    related: ["model", "switch", "agents"],
  },
  "extended-context": {
    when: "上下文总是不够用、大仓库塞不下时用：打开扩展上下文窗口换取更大的容量。",
    params: [
      { token: "on", zh: "开启扩展上下文窗口" },
      { token: "off", zh: "关闭" },
      { token: "status", zh: "查看当前开关状态" },
    ],
    cautions: ["窗口变大后每轮消耗的 token 显著增加，费用跟着涨"],
    related: ["context", "compact", "shake"],
  },
  tan: {
    when: "手头主线不能断、又有个旁支小活要查要改时用：丢给后台 agent 去做，做完回来汇报。",
    params: [{ token: "<work>", zh: "旁支任务描述" }],
    cautions: ["后台任务同样消耗额度与并发槽位，开多了会挤占主线"],
    related: ["jobs", "hub", "vibe"],
  },
  omfg: {
    when: "模型刚犯了你之前明确说过的错、气得想骂人时用：把这条抱怨沉淀成 TTSR 规则防止重犯。",
    params: [{ token: "<complaint>", zh: "不想再犯的那次抱怨，写清楚错在哪" }],
    cautions: ["规则会写盘并长期生效；写错或写太宽的规则会影响之后所有会话的行为"],
    related: ["memory"],
  },
  force: {
    when: "模型老是选错工具、你明确知道下一轮该调哪个工具时用，强制它用指定的工具走一轮。",
    params: [
      { token: "<tool-name>", zh: "强制使用的工具名" },
      { token: "prompt", zh: "给下一轮的提示" },
    ],
    cautions: ["强制指定工具可能让模型在不合适的场景调工具、做出错误操作"],
    related: ["tools", "retry"],
  },
  ratchet: {
    when: "有一套反复跑的流程、想让它越跑越好时用：自动建评测集并爬坡优化流程。",
    params: [{ token: "flow and goal", zh: "要优化的流程描述与目标" }],
    cautions: ["会自动多轮跑评测与优化，消耗额度较多"],
    related: ["cleanse", "advisor"],
  },
  advisor: {
    when: "对模型输出不放心、想每轮都有个评审官复核一遍时用，关键改动前建议打开。",
    params: [
      { token: "on", zh: "开启评审官" },
      { token: "off", zh: "关闭评审官" },
      { token: "status", zh: "查看评审官状态" },
      { token: "dump", zh: "导出评审记录" },
      { token: "raw", zh: "导出原始评审记录" },
      { token: "configure", zh: "配置评审官" },
    ],
    cautions: ["开启后每轮多一次复核调用，会增加延迟与费用"],
    related: ["model", "effort", "plan-review"],
  },
  todo: {
    when: "长任务步骤多、怕模型跑偏或漏步时用：维护一份待办清单并让模型按清单推进。",
    params: [
      { token: "append", zh: "追加一条待办" },
      { token: "start", zh: "标记某条开始做" },
      { token: "done", zh: "标记某条已完成" },
      { token: "drop", zh: "丢弃某条待办" },
      { token: "rm", zh: "删除某条待办" },
      { token: "edit", zh: "编辑待办内容" },
      { token: "expand", zh: "展开待办详情" },
      { token: "collapse", zh: "折叠待办详情" },
      { token: "export", zh: "导出待办清单" },
      { token: "import", zh: "从外部导入待办" },
      { token: "copy", zh: "复制待办内容" },
    ],
    cautions: ["done 会改变待办状态；drop/rm 删掉的待办不可恢复"],
    related: ["handoff", "plan"],
  },
  jobs: {
    when: "起了后台任务后想看跑得怎么样、或某个任务卡住想杀掉时用。",
    params: [
      { token: "full", zh: "查看完整任务详情" },
      { token: "kill <id>", zh: "终止指定 id 的后台任务" },
      { token: "kill all", zh: "终止全部后台任务" },
    ],
    cautions: ["kill 会终止后台任务，未完成的工作会丢失"],
    related: ["tan", "hub", "pause"],
  },
  agents: {
    when: "想统一管理手头的 agent、模型和交接时用，会打开 agent 中心。",
    related: ["hub", "jobs", "model"],
  },
  hub: {
    when: "同时跑着多个 agent、想一眼看清谁在干什么时用，会打开实时总览。",
    related: ["agents", "jobs", "pause"],
  },
  computer: {
    when: "任务必须动真桌面（点窗口、操作 GUI 软件）时用，打开桌面操控执行环境。",
    params: [
      { token: "on", zh: "开启桌面操控" },
      { token: "off", zh: "关闭桌面操控" },
      { token: "status", zh: "查看当前开关状态" },
    ],
    cautions: ["模型会实际操控你的桌面，可能误点误操作；只在可信任务中开启，用完及时 off"],
    related: ["tools", "pause"],
  },
  pause: {
    when: "发现 agent 们跑偏了、想先叫停所有人再处理时用，一键冻结全部 agent 直到恢复。",
    cautions: ["冻结期间所有前后台 agent 全部停滞，记得回来恢复"],
    related: ["jobs", "hub", "retry"],
  },
  "forget-approvals": {
    when: "之前点了 Ask and remember、现在想收回对某些文件或目录的信任时用，清掉记住的审批。",
  },
  retry: {
    when: "上一轮因为报错、超时或输出不对而失败时用，原样重试一次。",
    cautions: ["重试会重新执行上一轮，有副作用的操作（如写文件、发请求）可能被重复执行"],
    related: ["fresh", "force"],
  },
};
