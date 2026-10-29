/**
 * omp 内置斜杠命令速查数据（手写静态表）。
 *
 * 基准：omp 18.13.3 编译产物内嵌的统一内置注册表（88 条内置命令）。
 * 复核方法：
 * 1. `echo '{"id":"c1","type":"get_available_commands"}' | omp --mode rpc`
 *    返回启动帧 `available_commands_update` 与命令回包中机器可读的
 *    [{name, description, input.hint, aliases, subcommands}]，但只覆盖可在
 *    RPC 下执行的子集（18.13.3 实测 52 条非 skill 命令；/autoresearch、/init、
 *    /annotate、/green、/review 的 source 分别为 extension / file / custom，不在统一
 *    内置注册表内，其中随包发布的 review/green/annotate 单列「扩展命令」分组，
 *    /skill:* 与本机自定义命令仍不收录——见文件尾脚注口径）。
 * 2. TUI 补全列表覆盖全部内置命令：输入 `/` 后按前缀滚动，可从每行的名称、
 *    图标与英文说明核对；再对每条命令按 Tab，用输入行的参数提示（ghost hint）
 *    校对 args。
 * 3. 上游源码 tag v18.13.3 的 `packages/coding-agent/src/slash-commands/builtin-*.ts`
 *    即统一内置注册表本身：v18.12.6 → v18.13.3 新增内置 `/local`，`/hub` 新增
 *    别名 `/subagents`（编译产物内嵌注册表核对）。
 * 改动本表后请用这几种方式抽查名称拼写、参数提示与别名。
 */
export const OMP_VERSION = "18.13.3";

export interface OmpCommand {
  /** 不带前导 `/` 的命令名，如 "compact"。 */
  name: string;
  /** 别名（不带 `/`），如 ["q"]。 */
  aliases: string[];
  /** omp 自身的参数提示（英文原文），无则为空字符串。 */
  args: string;
  /** 手写中文说明（一句话）。 */
  zh: string;
  /**
   * 可直接粘贴的用法示例（1–3 条）。
   * 规则：每条是一整行命令，首个 token 必须等于 `/` + `name` 或其某个 `aliases`；
   * `args` 非空的命令至少有 1 条带真实参数；可变部分写成 `<中文占位>`；
   * 不出现 `args` 里没有的 flag 或子命令。
   */
  examples: string[];
}

export interface OmpCommandGroup {
  group: string;
  commands: OmpCommand[];
}

export const OMP_COMMANDS: OmpCommandGroup[] = [
  {
    group: "会话",
    commands: [
      { name: "new", aliases: [], args: "", zh: "开始一个新会话", examples: ["/new"] },
      { name: "delete", aliases: [], args: "", zh: "删除当前会话并开始新会话", examples: ["/delete"] },
      { name: "resume", aliases: [], args: "[session id|@claude|@codex]", zh: "恢复另一个会话，可按编号选择", examples: ["/resume", "/resume 01a0285c", "/resume @claude"] },
      { name: "pin", aliases: [], args: "[session id]", zh: "把会话置顶到恢复列表顶部（再执行一次取消置顶）", examples: ["/pin", "/pin 01a0285c"] },
      { name: "rename", aliases: [], args: "[title]", zh: "重命名当前会话，缺省自动生成", examples: ["/rename", "/rename <新标题>"] },
      { name: "move", aliases: [], args: "[<path>]", zh: "把当前会话搬到另一目录", examples: ["/move", "/move <目标目录>"] },
      { name: "branch", aliases: ["rewind"], args: "", zh: "回退到某条消息，原路径保留为分支", examples: ["/branch", "/rewind"] },
      { name: "fork", aliases: [], args: "[pane|window|tab]", zh: "分叉当前会话，在新终端面板或窗口打开", examples: ["/fork", "/fork window", "/fork tab"] },
      { name: "tree", aliases: [], args: "", zh: "浏览会话树并切换分支", examples: ["/tree"] },
      { name: "session", aliases: [], args: "[info|delete|pin [account]]", zh: "会话管理：查看信息、删除、给本会话绑定 OAuth 账号", examples: ["/session", "/session info", "/session pin"] },
      { name: "queue", aliases: [], args: "<message>", zh: "把消息排到 agent 本轮结束后发送", examples: ["/queue <要排到本轮结束后的消息>"] },
      { name: "btw", aliases: [], args: "[question]", zh: "提一个旁支问题，或浏览本会话的旁问历史", examples: ["/btw", "/btw <旁支问题>"] },
      { name: "copy", aliases: [], args: "", zh: "从对话中挑选文本或代码复制", examples: ["/copy"] },
      { name: "open", aliases: [], args: "", zh: "在浏览器打开对话中最近的链接（多条时先用 /copy 挑选）", examples: ["/open"] },
      { name: "export", aliases: [], args: "[--themes] [path]", zh: "导出会话为 HTML 文件", examples: ["/export", "/export <输出路径>", "/export --themes"] },
      { name: "dump", aliases: [], args: "[all|anon]", zh: "复制会话记录到剪贴板，并写出 LLM 请求 JSON（all/anon 打包含子 agent 的 zip）", examples: ["/dump", "/dump all", "/dump anon"] },
      { name: "seance", aliases: [], args: "[session id|path] [--model selector]", zh: "只读咨询另一个已保存的会话，不恢复它", examples: ["/seance", "/seance 01a0285c", "/seance <会话路径> --model <provider/model>"] },
      { name: "local", aliases: [], args: "[name]", zh: "在编辑器中打开本会话的 local:// 文件，不带名称时先列出供挑选", examples: ["/local", "/local <文件名>"] },
    ],
  },
  {
    group: "上下文",
    commands: [
      { name: "clear", aliases: [], args: "", zh: "就地清空上下文，会话保留", examples: ["/clear"] },
      { name: "fresh", aliases: [], args: "", zh: "重置模型连接状态，不改动本地记录", examples: ["/fresh"] },
      { name: "compact", aliases: [], args: "[soft|remote|snapcompact] [focus]", zh: "手动压缩会话上下文", examples: ["/compact", "/compact 保留接口签名", "/compact remote 保留接口签名"] },
      { name: "shake", aliases: [], args: "[elide|images|thinking]", zh: "丢弃工具结果等臃肿内容", examples: ["/shake", "/shake images", "/shake thinking"] },
      { name: "handoff", aliases: [], args: "[focus instructions]", zh: "生成交接摘要并就地压缩", examples: ["/handoff", "/handoff 保留失败排查过程"] },
      { name: "context", aliases: [], args: "", zh: "查看上下文占用明细", examples: ["/context"] },
    ],
  },
  {
    group: "模式",
    commands: [
      { name: "plan", aliases: [], args: "[prompt]", zh: "切换计划模式，先规划再执行", examples: ["/plan", "/plan <要规划的需求>"] },
      { name: "plan-review", aliases: [], args: "", zh: "重新打开最新计划评审（仅计划模式）", examples: ["/plan-review"] },
      { name: "vibe", aliases: [], args: "[prompt]", zh: "切换 vibe 模式：由主会话指挥常驻的 fast/good 工作会话（自身仅只读工具）", examples: ["/vibe", "/vibe <交给并行会话的目标>"] },
      { name: "goal", aliases: [], args: "[objective] | set|show|pause|resume|drop|budget", zh: "切换目标模式，自主推进既定目标", examples: ["/goal <目标描述>", "/goal show", "/goal budget"] },
      { name: "guided-goal", aliases: [], args: "[rough objective]", zh: "通过问答帮你设定目标模式", examples: ["/guided-goal", "/guided-goal <大致目标>"] },
      { name: "loop", aliases: [], args: "[count|duration] [--while|--until '<cmd>'] [prompt]", zh: "循环模式，每轮结束后自动重发提示", examples: ["/loop <提示词>", "/loop 5 <提示词>", "/loop --until '<命令>' <提示词>"] },
      { name: "live", aliases: [], args: "", zh: "进入基于 Codex 的实时语音模式", examples: ["/live"] },
    ],
  },
  {
    group: "模型与推理",
    commands: [
      { name: "model", aliases: ["models"], args: "", zh: "切换本会话的模型", examples: ["/model", "/models"] },
      { name: "switch", aliases: [], args: "[model]", zh: "模糊切换模型，支持 @角色与 :档位", examples: ["/switch", "/switch <provider/model>", "/switch @slow:high"] },
      { name: "fast", aliases: [], args: "[on|ultra|off|status]", zh: "切换极速服务档（OpenAI priority/ultrafast、Anthropic fast、Google priority）", examples: ["/fast", "/fast status", "/fast ultra"] },
      { name: "slow", aliases: [], args: "[on|off|status]", zh: "切换慢速档：OpenAI/Google 走 flex 档，Anthropic 限额后低优先级续跑", examples: ["/slow", "/slow status"] },
      { name: "effort", aliases: [], args: "[level]", zh: "设置推理强度档位", examples: ["/effort", "/effort high"] },
      { name: "modelpreset", aliases: [], args: "[save|switch|delete|list] [name]", zh: "保存与切换模型预设（角色模型 + 推理强度）", examples: ["/modelpreset list", "/modelpreset save <预设名>", "/modelpreset switch <预设名>"] },
      { name: "prewalk", aliases: [], args: "[restart|off]", zh: "预约、重启或取消一次性的模型交接", examples: ["/prewalk", "/prewalk off"] },
      { name: "extended-context", aliases: [], args: "[on|off|status]", zh: "开关扩展上下文窗口", examples: ["/extended-context", "/extended-context status"] },
    ],
  },
  {
    group: "智能体与任务",
    commands: [
      { name: "tan", aliases: [], args: "<work>", zh: "后台起 agent 处理旁支任务", examples: ["/tan <旁支任务描述>"] },
      { name: "omfg", aliases: [], args: "<complaint>", zh: "把一次抱怨沉淀为 TTSR 规则，防止重犯", examples: ["/omfg <不想再犯的那次抱怨>"] },
      { name: "force", aliases: ["force:"], args: "<tool-name> [prompt]", zh: "强制下一轮使用指定工具", examples: ["/force <tool-name> <给下一轮的提示>", "/force: <tool-name> <给下一轮的提示>"] },
      { name: "ratchet", aliases: [], args: "[flow and goal]", zh: "为流程建评测并自动爬坡优化", examples: ["/ratchet", "/ratchet <流程与目标>"] },
      { name: "advisor", aliases: [], args: "[on|off|status|dump [raw]|configure]", zh: "开关评审官，每轮给出复核意见", examples: ["/advisor", "/advisor status", "/advisor configure"] },
      { name: "todo", aliases: [], args: "<edit|copy|expand|collapse|export|import|append|start|done|drop|rm>", zh: "查看或修改待办：增删、标记完成、导入导出", examples: ["/todo", "/todo append <待办内容>", "/todo done <待办内容>"] },
      { name: "jobs", aliases: [], args: "[full|kill <id>|kill all]", zh: "查看后台异步任务状态", examples: ["/jobs", "/jobs full", "/jobs kill <任务 id>"] },
      { name: "agents", aliases: [], args: "", zh: "打开 agent 中心，管理模型与交接", examples: ["/agents"] },
      { name: "hub", aliases: ["subagents"], args: "", zh: "打开实时 agent 总览", examples: ["/hub", "/subagents"] },
      { name: "computer", aliases: [], args: "[on|off|status]", zh: "开关桌面操控执行环境", examples: ["/computer", "/computer status"] },
      { name: "pause", aliases: [], args: "", zh: "冻结全部 agent 直到恢复", examples: ["/pause"] },
      { name: "forget-approvals", aliases: [], args: "", zh: "清除 Ask and remember 记住的文件/目录审批，下次读写重新询问", examples: ["/forget-approvals"] },
      { name: "retry", aliases: [], args: "", zh: "重试上一次失败的回合", examples: ["/retry"] },
    ],
  },
  {
    group: "工作区",
    commands: [
      { name: "wt", aliases: ["worktree"], args: "[<branch>]", zh: "把会话搬进新 worktree，改动一并带走", examples: ["/wt", "/wt <分支名>", "/worktree <分支名>"] },
      { name: "add-dir", aliases: [], args: "<path>", zh: "给会话添加工作目录", examples: ["/add-dir <目录路径>"] },
      { name: "remove-dir", aliases: [], args: "<path>", zh: "从会话移除工作目录", examples: ["/remove-dir <目录路径>"] },
      { name: "dirs", aliases: [], args: "", zh: "列出会话的工作目录", examples: ["/dirs"] },
      { name: "git", aliases: [], args: "[revision]", zh: "打开可视化 git 界面", examples: ["/git", "/git <revision>"] },
    ],
  },
  {
    group: "协作分享",
    commands: [
      { name: "share", aliases: [], args: "", zh: "生成加密链接分享会话", examples: ["/share"] },
      { name: "collab", aliases: [], args: "[start|view|list|stop|status] [relayUrl]", zh: "通过中继实时共享：开始、查看、停止", examples: ["/collab", "/collab start", "/collab status"] },
      { name: "join", aliases: [], args: "<link>", zh: "加入共享的协作会话", examples: ["/join <协作链接>"] },
      { name: "leave", aliases: [], args: "", zh: "离开协作会话", examples: ["/leave"] },
    ],
  },
  {
    group: "插件·技能·MCP",
    commands: [
      { name: "marketplace", aliases: [], args: "<add|remove|update|list|discover|install|uninstall|installed|upgrade|help>", zh: "管理插件市场：添加、安装、升级", examples: ["/marketplace list", "/marketplace add <市场地址>", "/marketplace install <插件名>"] },
      { name: "plugins", aliases: ["plugin"], args: "[list|enable|disable]", zh: "查看管理已装插件", examples: ["/plugins", "/plugins list", "/plugin list"] },
      { name: "reload-plugins", aliases: [], args: "", zh: "重载全部插件（技能、命令、钩子、工具、agent、MCP）", examples: ["/reload-plugins"] },
      { name: "skills", aliases: [], args: "[search|install|installed|update]", zh: "搜索、安装、更新注册表中的技能", examples: ["/skills search <关键词>", "/skills installed"] },
      { name: "mcp", aliases: [], args: "<add|list|remove|test|reauth|unauth|enable|disable|smithery-search|smithery-login|smithery-logout|reconnect|reload|resources|prompts|notifications|help>", zh: "管理 MCP 服务：增删、测试、重连", examples: ["/mcp list", "/mcp test <服务名>", "/mcp add <服务名>"] },
      { name: "skillful", aliases: [], args: "[on|off|status]", zh: "开关系统提示中的技能列表", examples: ["/skillful", "/skillful status"] },
      { name: "extensions", aliases: ["status"], args: "", zh: "打开扩展控制中心", examples: ["/extensions", "/status"] },
    ],
  },
  {
    group: "配置与登录",
    commands: [
      { name: "ssh", aliases: [], args: "<add|list|remove|help>", zh: "管理 SSH 主机增删与列表", examples: ["/ssh list", "/ssh add <主机名>"] },
      { name: "settings", aliases: [], args: "", zh: "打开设置菜单", examples: ["/settings"] },
      { name: "setup", aliases: ["providers"], args: "[providers]", zh: "打开服务商配置（登录与联网搜索）", examples: ["/setup", "/setup providers", "/providers"] },
      { name: "login", aliases: [], args: "[provider|redirect URL]", zh: "登录 OAuth 服务商", examples: ["/login", "/login <provider>"] },
      { name: "logout", aliases: [], args: "[provider]", zh: "登出 OAuth 账号", examples: ["/logout", "/logout <provider>"] },
      { name: "browser", aliases: [], args: "[headless|visible]", zh: "切换浏览器 eval 预设的有界面/无界面模式", examples: ["/browser", "/browser visible"] },
    ],
  },
  {
    group: "诊断与统计",
    commands: [
      { name: "cleanse", aliases: [], args: "[request] [--all] [--tests] [-n <agents>] [-m <model>]", zh: "并行检测修复项目诊断问题", examples: ["/cleanse", "/cleanse ts errors", "/cleanse --all"] },
      { name: "debug", aliases: [], args: "", zh: "打开调试工具选择器", examples: ["/debug"] },
      { name: "security", aliases: [], args: "<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>", zh: "安全扫描：规划、执行、查看、处置", examples: ["/security plan", "/security scan", "/security status"] },
      { name: "trace", aliases: [], args: "", zh: "在统计面板打开会话链路", examples: ["/trace"] },
      { name: "stats", aliases: [], args: "[--port <port>] [--host <host>]", zh: "启动本地统计面板", examples: ["/stats", "/stats --port 7777"] },
      { name: "usage", aliases: [], args: "[show|reset [provider/credential-id|provider/active]]", zh: "查看服务商用量与限额", examples: ["/usage", "/usage show", "/usage reset"] },
      { name: "changelog", aliases: [], args: "[full|last [N]]", zh: "查看更新日志", examples: ["/changelog", "/changelog last 5"] },
      { name: "memory", aliases: [], args: "<view|stats|diagnose|queue|sync|clear|reset|enqueue|rebuild|mm list|mm show|mm refresh|mm history|mm seed|mm delete|mm reload>", zh: "记忆库维护（子命令是否可用取决于 memory.backend；mnemopi 下 clear 会删除整个记忆库）", examples: ["/memory stats", "/memory mm list", "/memory view"] },
    ],
  },
  {
    group: "扩展命令",
    commands: [
      {
        name: "review",
        aliases: [],
        args: "[pr url|number]",
        zh: "启动交互式代码审查（GitHub PR / GitLab MR，省略则在当前仓库里挑改动）",
        examples: ["/review", "/review 123", "/review <PR 链接>"],
      },
      {
        name: "green",
        aliases: [],
        args: "",
        zh: "生成让 CI 反复重跑直到分支变绿的提示",
        examples: ["/green"],
      },
      {
        name: "annotate",
        aliases: [],
        args: "[latest|message|changes|pr|file <path>]",
        zh: "标注最近回复、会话里的消息或代码块、本地改动/PR，或按路径标注文件",
        examples: ["/annotate latest", "/annotate changes", "/annotate file <文件路径>"],
      },
    ],
  },
  {
    group: "应用",
    commands: [
      { name: "restart", aliases: [], args: "", zh: "以相同参数重启并恢复会话", examples: ["/restart"] },
      { name: "exit", aliases: [], args: "", zh: "退出应用", examples: ["/exit"] },
      { name: "quit", aliases: ["q"], args: "", zh: "退出应用", examples: ["/quit", "/q"] },
      { name: "hotkeys", aliases: [], args: "", zh: "查看全部快捷键", examples: ["/hotkeys"] },
      { name: "tools", aliases: [], args: "", zh: "查看 agent 可见工具", examples: ["/tools"] },
      { name: "record", aliases: [], args: "", zh: "开始或停止录制屏幕回放", examples: ["/record"] },
    ],
  },
];

/**
 * 意图关键词：命令名/别名/参数提示/中文说明覆盖不到的常用说法。
 * 只收录指向明确的词（过滤时与其它字段一样做大小写不敏感子串匹配）。
 */
const OMP_INTENT_KEYWORDS: Readonly<Record<string, string[]>> = {
  branch: ["后悔", "回滚"],
  vibe: ["并行"],
  tan: ["支线"],
  collab: ["分享", "协作"],
  join: ["协作", "链接"],
  leave: ["协作"],
  effort: ["思考", "thinking"],
  rename: ["改名"],
  resume: ["继续"],
  queue: ["排队"],
  login: ["账号"],
  logout: ["退出登录"],
  setup: ["设置"],
  settings: ["配置"],
  extensions: ["插件"],
  ratchet: ["评估"],
  handoff: ["总结"],
  goal: ["预算"],
  usage: ["额度"],
  slow: ["省钱"],
  fast: ["加速"],
  pause: ["暂停"],
  loop: ["重复"],
  hotkeys: ["键盘"],
  changelog: ["版本"],
  "forget-approvals": ["批准"],
  review: ["审查", "评审", "PR"],
  green: ["CI", "流水线", "变绿"],
  annotate: ["标注", "注释"],
};

/**
 * 空查询时置顶在「常用」分组的命令（按常用程度排序）。
 * 每个名字都必须存在于 OMP_COMMANDS（单测校验）；只影响展示顺序，不计入总数。
 */
export const OMP_PINNED_COMMANDS: string[] = [
  "compact",
  "plan",
  "model",
  "context",
  "effort",
  "resume",
  "new",
  "todo",
];

/**
 * 速查过滤：命令名（带或不带前导 `/`）、别名、参数提示、中文说明、示例、意图关键词，
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
      if (c.args.toLowerCase().includes(q)) return true;
      if (c.zh.toLowerCase().includes(q)) return true;
      if (c.examples.some((ex) => ex.toLowerCase().includes(q))) return true;
      if ((OMP_INTENT_KEYWORDS[c.name] ?? []).some((k) => k.toLowerCase().includes(q))) return true;
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
