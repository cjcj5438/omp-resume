/** 命令详解分片 4：见 ../ompCommandDetails.ts 的编写规则。 */
import type { OmpCommandDetail } from "../ompCommandDetails";

export const PART_4: Record<string, OmpCommandDetail> = {
  cleanse: {
    when: "项目里攒了一堆类型报错、lint 告警或测试失败，想让多个子 agent 并行分头修时用它。",
    cautions: ["会并行起很多子 agent 并实际改代码，大项目一次跑下来消耗额度不少，先用 --tests 或小范围试一次。"],
    params: [
      { token: "[request]", zh: "限定要处理的问题，如 ts errors；省略则全量诊断。" },
      { token: "--all", zh: "全量诊断并修复，而不仅是当前改动涉及的问题。" },
      { token: "--tests", zh: "只处理测试相关的问题。" },
      { token: "-n <agents>", zh: "并行子 agent 数量。" },
      { token: "-m <model>", zh: "子 agent 使用的模型。" },
    ],
    related: ["security", "usage", "jobs"],
  },
  debug: {
    when: "遇到奇怪行为（工具没按预期跑、界面状态不对）想看内部状态或开调试手段时用它。",
    related: ["trace", "stats"],
  },
  security: {
    when: "想给项目做一次安全扫描，或查看、处置历史扫描结果时用它。",
    cautions: ["scan 会实际跑扫描流程，大仓库耗时较长并消耗额度。"],
    params: [
      { token: "plan", zh: "规划一次扫描：定范围与策略，还不执行。" },
      { token: "scan", zh: "按规划执行扫描。" },
      { token: "status", zh: "查看当前扫描进度。" },
      { token: "show", zh: "查看某次扫描的详细结果。" },
      { token: "cancel", zh: "取消正在跑的扫描。" },
    ],
    related: ["cleanse", "usage"],
  },
  trace: {
    when: "想看清本会话这一轮到底走了哪些工具调用、花了多少 token 时用它，会在统计面板里打开链路。",
    related: ["stats", "usage"],
  },
  stats: {
    when: "想在浏览器里看用量、耗时、会话链路等统计面板时用它，会在本机起一个服务。",
    params: [
      { token: "--port <port>", zh: "面板服务的监听端口。" },
      { token: "--host <host>", zh: "面板服务的监听地址。" },
    ],
    related: ["usage", "trace"],
  },
  usage: {
    when: "想确认各服务商的剩余额度、限额重置时间，或用量显示不对想重拉时用它。",
    params: [
      { token: "show", zh: "显示当前用量与限额明细。" },
      { token: "reset", zh: "重置本地用量缓存并重新同步。" },
      { token: "provider/credential-id", zh: "只重置指定凭证的用量，如 openai/acc1。" },
      { token: "provider/active", zh: "只重置该服务商当前生效凭证的用量。" },
    ],
    related: ["stats", "model"],
  },
  changelog: {
    when: "升级后想看看新版本改了什么，或确认某个行为变化是不是版本更新带来时用它。",
    params: [
      { token: "full", zh: "查看完整更新日志。" },
      { token: "last [N]", zh: "只看最近 N 个版本的更新日志。" },
    ],
    related: ["stats"],
  },
  memory: {
    when: "记忆库行为异常（记不住、记错了）或想查看、整理长期记忆时用它。",
    cautions: [
      "mnemopi 后端下 clear 会删除整个记忆库，不可撤销。",
      "reset / rebuild 会重建记忆索引，大记忆库耗时较长。",
    ],
    params: [
      { token: "view", zh: "查看记忆内容。" },
      { token: "stats", zh: "查看记忆库统计信息。" },
      { token: "diagnose", zh: "诊断记忆库健康状况。" },
      { token: "clear", zh: "清空记忆（mnemopi 后端下是删整个库，慎用）。" },
      { token: "mm list", zh: "列出记忆条目。" },
      { token: "mm show", zh: "查看单条记忆详情。" },
    ],
    related: ["context", "compact"],
  },
  review: {
    when: "想让人审 PR/MR 之前先过一遍 AI 审查，或接手别人的分支想快速了解改动质量时用它。",
    cautions: ["审大 PR 会拉取大量 diff 并消耗较多额度。"],
    params: [
      { token: "pr url", zh: "要审查的 PR/MR 链接。" },
      { token: "number", zh: "要审查的 PR/MR 编号；省略则在当前仓库里挑改动。" },
    ],
    related: ["annotate", "git"],
  },
  green: {
    when: "分支 CI 老红、想让 agent 反复修反复重跑直到变绿时用它，它会生成一条拿来即用的提示。",
    cautions: ["按生成的提示跑起来后会长时间占用一个会话反复试错，大项目烧额度很快。"],
    related: ["jobs", "tan"],
  },
  annotate: {
    when: "想给某段回复、某条消息、本地改动或文件逐行加标注说明时用它。",
    params: [
      { token: "latest", zh: "标注最近一次回复。" },
      { token: "message", zh: "标注会话里的某条消息。" },
      { token: "changes", zh: "标注本地未提交的改动。" },
      { token: "pr", zh: "标注当前分支关联的 PR 改动。" },
      { token: "file <path>", zh: "按路径标注指定文件。" },
    ],
    related: ["review", "copy"],
  },
  restart: {
    when: "应用状态不对（连接卡死、界面异常）且 fresh 救不回来时用它，会重启进程并恢复会话。",
    cautions: ["会重启整个进程，正在跑的后台任务与实时协作会被中断。"],
    related: ["fresh", "exit"],
  },
  exit: {
    when: "正常结束工作、想退出应用时用它。",
    related: ["quit", "restart"],
  },
  quit: {
    when: "想退出应用时用它，和 exit 同义，q 是更短的别名。",
    related: ["exit", "restart"],
  },
  hotkeys: {
    when: "忘记快捷键，或刚上手想看看有哪些键盘操作时用它。",
    related: ["settings"],
  },
  tools: {
    when: "怀疑某个工具没加载（如 MCP 工具缺失），想确认 agent 当前能看到哪些工具时用它。",
    related: ["mcp", "plugins"],
  },
  record: {
    when: "想录一段屏幕回放来复现 bug 或演示操作时用它，再执行一次停止录制。",
    cautions: ["录制内容会上传用于回放分享，屏幕上有密钥、token 等敏感信息时谨慎使用。"],
    related: ["export", "dump"],
  },
};
