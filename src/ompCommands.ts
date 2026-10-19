/**
 * omp 内置斜杠命令速查数据（手写静态表）。
 *
 * 基准：omp 18.12.2 编译产物内嵌的统一内置注册表（86 条内置命令）。
 * 复核方法：
 * 1. `echo '{"id":"c1","type":"get_available_commands"}' | omp --mode rpc`
 *    返回启动帧 `available_commands_update` 与命令回包中机器可读的
 *    [{name, description, input.hint, aliases, subcommands}]，但只覆盖可在
 *    RPC 下执行的子集（本次 45 条）。
 * 2. TUI 补全列表覆盖全部内置命令：输入 `/` 后按前缀滚动，可从每行的名称、
 *    图标与英文说明核对；再对每条命令按 Tab，用输入行的参数提示（ghost hint）
 *    校对 args。
 * 改动本表后请用这两种方式抽查名称拼写、参数提示与别名。
 */
export const OMP_VERSION = "18.12.2";

export interface OmpCommand {
  /** 不带前导 `/` 的命令名，如 "compact"。 */
  name: string;
  /** 别名（不带 `/`），如 ["q"]。 */
  aliases: string[];
  /** omp 自身的参数提示（英文原文），无则为空字符串。 */
  args: string;
  /** 手写中文说明（一句话）。 */
  zh: string;
}

export interface OmpCommandGroup {
  group: string;
  commands: OmpCommand[];
}

export const OMP_COMMANDS: OmpCommandGroup[] = [
  {
    group: "会话",
    commands: [
      { name: "new", aliases: [], args: "", zh: "开始一个新会话" },
      { name: "delete", aliases: [], args: "", zh: "删除当前会话并开始新会话" },
      { name: "resume", aliases: [], args: "[session id|@claude|@codex]", zh: "恢复另一个会话，可按编号选择" },
      { name: "pin", aliases: [], args: "[session id]", zh: "把会话置顶到恢复列表顶部（再执行一次取消置顶）" },
      { name: "rename", aliases: [], args: "[title]", zh: "重命名当前会话，缺省自动生成" },
      { name: "move", aliases: [], args: "[<path>]", zh: "把当前会话搬到另一目录" },
      { name: "branch", aliases: ["rewind"], args: "", zh: "回退到某条消息，原路径保留为分支" },
      { name: "fork", aliases: [], args: "[pane|window|tab]", zh: "分叉当前会话，在新终端面板或窗口打开" },
      { name: "tree", aliases: [], args: "", zh: "浏览会话树并切换分支" },
      { name: "session", aliases: [], args: "[info|delete|pin [account]]", zh: "会话管理：查看信息、删除、给本会话绑定 OAuth 账号" },
      { name: "queue", aliases: [], args: "<message>", zh: "把消息排到 agent 本轮结束后发送" },
      { name: "btw", aliases: [], args: "[question]", zh: "提一个旁支问题，或浏览本会话的旁问历史" },
      { name: "copy", aliases: [], args: "", zh: "从对话中挑选文本或代码复制" },
      { name: "open", aliases: [], args: "", zh: "在浏览器打开对话中的链接" },
      { name: "export", aliases: [], args: "[--themes] [path]", zh: "导出会话为 HTML 文件" },
      { name: "dump", aliases: [], args: "[all|anon]", zh: "复制会话记录到剪贴板，并写出 LLM 请求 JSON（all/anon 打包含子 agent 的 zip）" },
      { name: "seance", aliases: [], args: "[session id|path] [--model selector]", zh: "只读咨询另一个已保存的会话，不恢复它" },
    ],
  },
  {
    group: "上下文",
    commands: [
      { name: "clear", aliases: [], args: "", zh: "就地清空上下文，会话保留" },
      { name: "fresh", aliases: [], args: "", zh: "重置模型连接状态，不改动本地记录" },
      { name: "compact", aliases: [], args: "[soft|remote|snapcompact] [focus]", zh: "手动压缩会话上下文" },
      { name: "shake", aliases: [], args: "[elide|images|thinking]", zh: "丢弃工具结果等臃肿内容" },
      { name: "handoff", aliases: [], args: "[focus instructions]", zh: "生成交接摘要并就地压缩" },
      { name: "context", aliases: [], args: "", zh: "查看上下文占用明细" },
    ],
  },
  {
    group: "模式",
    commands: [
      { name: "plan", aliases: [], args: "[prompt]", zh: "切换计划模式，先规划再执行" },
      { name: "plan-review", aliases: [], args: "", zh: "重新打开最新计划评审（仅计划模式）" },
      { name: "vibe", aliases: [], args: "[prompt]", zh: "切换 vibe 模式：由主会话指挥常驻的 fast/good 工作会话（自身仅只读工具）" },
      { name: "goal", aliases: [], args: "[objective] | set|show|pause|resume|drop|budget", zh: "切换目标模式，自主推进既定目标" },
      { name: "guided-goal", aliases: [], args: "[rough objective]", zh: "通过问答帮你设定目标模式" },
      { name: "loop", aliases: [], args: "[count|duration] [--while|--until '<cmd>'] [prompt]", zh: "循环模式，每轮结束后自动重发提示" },
      { name: "live", aliases: [], args: "", zh: "进入基于 Codex 的实时语音模式" },
    ],
  },
  {
    group: "模型与推理",
    commands: [
      { name: "model", aliases: ["models"], args: "", zh: "切换本会话的模型" },
      { name: "switch", aliases: [], args: "[model]", zh: "模糊切换模型，支持 @角色与 :档位" },
      { name: "fast", aliases: [], args: "[on|ultra|off|status]", zh: "切换极速服务档（OpenAI priority/ultrafast、Anthropic fast、Google priority）" },
      { name: "slow", aliases: [], args: "[on|off|status]", zh: "切换慢速档：OpenAI/Google 走 flex 档，Anthropic 限额后低优先级续跑" },
      { name: "effort", aliases: [], args: "[level]", zh: "设置推理强度档位" },
      { name: "modelpreset", aliases: [], args: "[list|save|switch|delete] [name]", zh: "保存与切换模型预设（角色模型 + 推理强度）" },
      { name: "prewalk", aliases: [], args: "[restart|off]", zh: "预约、重启或取消一次性的模型交接" },
      { name: "extended-context", aliases: [], args: "[on|off|status]", zh: "开关扩展上下文窗口" },
    ],
  },
  {
    group: "智能体与任务",
    commands: [
      { name: "tan", aliases: [], args: "<work>", zh: "后台起 agent 处理旁支任务" },
      { name: "omfg", aliases: [], args: "<complaint>", zh: "把一次抱怨沉淀为 TTSR 规则，防止重犯" },
      { name: "force", aliases: ["force:"], args: "<tool-name> [prompt]", zh: "强制下一轮使用指定工具" },
      { name: "ratchet", aliases: [], args: "[flow and goal]", zh: "为流程建评测并自动爬坡优化" },
      { name: "advisor", aliases: [], args: "[on|off|status|dump [raw]|configure]", zh: "开关评审官，每轮给出复核意见" },
      { name: "todo", aliases: [], args: "<edit|copy|expand|collapse|export|import|append|start|done|drop|rm>", zh: "查看或修改待办：增删、标记完成、导入导出" },
      { name: "jobs", aliases: [], args: "[full|kill <id>|kill all]", zh: "查看后台异步任务状态" },
      { name: "agents", aliases: [], args: "", zh: "打开 agent 中心，管理模型与交接" },
      { name: "hub", aliases: [], args: "", zh: "打开实时 agent 总览" },
      { name: "computer", aliases: [], args: "[on|off|status]", zh: "开关桌面操控执行环境" },
      { name: "pause", aliases: [], args: "", zh: "冻结全部 agent 直到恢复" },
      { name: "retry", aliases: [], args: "", zh: "重试上一次失败的回合" },
    ],
  },
  {
    group: "工作区",
    commands: [
      { name: "wt", aliases: ["worktree"], args: "[<branch>]", zh: "把会话搬进新 worktree，改动一并带走" },
      { name: "add-dir", aliases: [], args: "<path>", zh: "给会话添加工作目录" },
      { name: "remove-dir", aliases: [], args: "<path>", zh: "从会话移除工作目录" },
      { name: "dirs", aliases: [], args: "", zh: "列出会话的工作目录" },
      { name: "git", aliases: [], args: "[revision]", zh: "打开可视化 git 界面" },
    ],
  },
  {
    group: "协作分享",
    commands: [
      { name: "share", aliases: [], args: "", zh: "生成加密链接分享会话" },
      { name: "collab", aliases: [], args: "[start|view|list|stop|status] [relayUrl]", zh: "通过中继实时共享：开始、查看、停止" },
      { name: "join", aliases: [], args: "<link>", zh: "加入共享的协作会话" },
      { name: "leave", aliases: [], args: "", zh: "离开协作会话" },
    ],
  },
  {
    group: "插件·技能·MCP",
    commands: [
      { name: "marketplace", aliases: [], args: "<add|remove|update|list|discover|install|uninstall|installed|upgrade|help>", zh: "管理插件市场：添加、安装、升级" },
      { name: "plugins", aliases: ["plugin"], args: "[list|enable|disable]", zh: "查看管理已装插件" },
      { name: "reload-plugins", aliases: [], args: "", zh: "重载全部插件（技能、命令、钩子、工具、agent、MCP）" },
      { name: "skills", aliases: [], args: "[search|install|installed|update]", zh: "搜索、安装、更新注册表中的技能" },
      { name: "mcp", aliases: [], args: "<add|list|remove|test|reauth|unauth|enable|disable|smithery-search|smithery-login|smithery-logout|reconnect|reload|resources|prompts|notifications|help>", zh: "管理 MCP 服务：增删、测试、重连" },
      { name: "skillful", aliases: [], args: "[on|off|status]", zh: "开关系统提示中的技能列表" },
      { name: "extensions", aliases: ["status"], args: "", zh: "打开扩展控制中心" },
    ],
  },
  {
    group: "配置与登录",
    commands: [
      { name: "ssh", aliases: [], args: "<subcommand> (add|list|remove|help)", zh: "管理 SSH 主机增删与列表" },
      { name: "settings", aliases: [], args: "", zh: "打开设置菜单" },
      { name: "setup", aliases: ["providers"], args: "[providers ...]", zh: "打开服务商配置（登录与联网搜索）" },
      { name: "login", aliases: [], args: "[provider|redirect URL]", zh: "登录 OAuth 服务商" },
      { name: "logout", aliases: [], args: "[provider]", zh: "登出 OAuth 账号" },
      { name: "browser", aliases: [], args: "[headless|visible]", zh: "切换浏览器 eval 预设的有界面/无界面模式" },
    ],
  },
  {
    group: "诊断与统计",
    commands: [
      { name: "cleanse", aliases: [], args: "[request] [--all] [--tests] [-n <agents>] [-m <model>]", zh: "并行检测修复项目诊断问题" },
      { name: "debug", aliases: [], args: "", zh: "打开调试工具选择器" },
      { name: "security", aliases: [], args: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>", zh: "安全扫描：规划、执行、查看、处置" },
      { name: "trace", aliases: [], args: "", zh: "在统计面板打开会话链路" },
      { name: "stats", aliases: [], args: "[--port <port>] [--host <host>]", zh: "启动本地统计面板" },
      { name: "usage", aliases: [], args: "[show|reset [provider/credential-id|provider/active]]", zh: "查看服务商用量与限额" },
      { name: "changelog", aliases: [], args: "[full|last [N]]", zh: "查看更新日志" },
      { name: "memory", aliases: [], args: "<view|stats|diagnose|queue|sync|clear|reset|enqueue|rebuild|mm list|mm show|mm refresh|mm history|mm seed|mm delete|mm reload>", zh: "记忆库维护：查看、同步、清理" },
    ],
  },
  {
    group: "应用",
    commands: [
      { name: "restart", aliases: [], args: "", zh: "以相同参数重启并恢复会话" },
      { name: "exit", aliases: [], args: "", zh: "退出应用" },
      { name: "quit", aliases: ["q"], args: "", zh: "退出应用" },
      { name: "hotkeys", aliases: [], args: "", zh: "查看全部快捷键" },
      { name: "tools", aliases: [], args: "", zh: "查看 agent 可见工具" },
      { name: "record", aliases: [], args: "", zh: "开始或停止录制屏幕回放" },
    ],
  },
];

/**
 * 速查过滤：命令名（带或不带前导 `/`）、别名、中文说明，
 * 大小写不敏感子串匹配；空查询返回原分组；空组隐藏。
 */
export function filterOmpCommands(
  groups: OmpCommandGroup[],
  query: string,
): OmpCommandGroup[] {
  const q = query.trim().toLowerCase().replace(/^\/+/, "");
  if (!q) return groups;
  const out: OmpCommandGroup[] = [];
  for (const g of groups) {
    const commands = g.commands.filter((c) => {
      if (c.name.toLowerCase().includes(q)) return true;
      if (c.aliases.some((a) => a.toLowerCase().includes(q))) return true;
      if (c.zh.toLowerCase().includes(q)) return true;
      return false;
    });
    if (commands.length > 0) out.push({ ...g, commands });
  }
  return out;
}

/** 命令名或别名查一条命令（用于组合用法引用校验与展示）。 */
export function findOmpCommand(name: string): OmpCommand | undefined {
  const n = name.toLowerCase().replace(/^\/+/, "");
  for (const g of OMP_COMMANDS) {
    for (const c of g.commands) {
      if (c.name.toLowerCase() === n) return c;
      if (c.aliases.some((a) => a.toLowerCase() === n)) return c;
    }
  }
  return undefined;
}

/**
 * 已安装版本与速查基准版本是否不一致。
 * 只做相等判断（不做 semver 比较）：已安装版本为空或无法读取时不提示。
 */
export function versionMismatch(installed: string | null | undefined): boolean {
  const v = installed?.trim();
  return typeof v === "string" && v !== "" && v !== OMP_VERSION;
}
