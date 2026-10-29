/**
 * omp 终端子命令速查数据（手写静态表，单一分组、按 name 字母序）。
 *
 * 基准：omp 18.13.3 的 `omp --help` COMMANDS 清单（不含顶层 flags）。
 * 复核方法：
 * 1. `omp --help` 的 COMMANDS 段落给出全部子命令与一行英文说明；
 * 2. 逐条 `omp <name> --help` 核对参数与 flag，示例只用那里真实出现的形式；
 * 3. 无法确认参数时只写 `omp <name> --help` 作为保守示例。
 * 改动本表后请用同样方式抽查：`--help` 的 USAGE 行必须能容纳示例里的每个 token。
 */
import { OMP_VERSION } from "./ompCommands";
export const OMP_CLI_VERSION: string = OMP_VERSION;

export interface OmpCliCommand {
  /** 子命令名，如 "bench"。 */
  name: string;
  /** 位置参数/子动作提示（取自 `omp <name> --help` 的 ARGUMENTS），无则为空字符串。 */
  args: string;
  /** 手写中文说明（一句话，译自 `omp --help` 的英文说明）。 */
  zh: string;
  /** 可直接粘贴的示例；每条都以 `omp ` 开头，且参数在该子命令的 `--help` 里真实存在。 */
  examples: string[];
}

export const OMP_CLI_COMMANDS: OmpCliCommand[] = [
  {
    name: "acp",
    args: "",
    zh: "以 ACP（Agent Client Protocol）服务端运行，走 stdio",
    examples: ["omp acp"],
  },
  {
    name: "agents",
    args: "[unpack]",
    zh: "导出/管理随包分发的 task agent",
    examples: ["omp agents unpack", "omp agents unpack --project --force"],
  },
  {
    name: "anonymize",
    args: "[SESSION]",
    zh: "写出可分享的会话副本：内容打码、元数据保留、路径与字面量替换成一致的假名",
    examples: ["omp anonymize", "omp anonymize 01a0285c -o ./bug-report"],
  },
  {
    name: "auth",
    args: "ACTION [FILE]",
    zh: "导出或导入已存储的服务商凭据（API key 与 OAuth）为 JSON",
    examples: ["omp auth export > credentials.json", "omp auth import credentials.json"],
  },
  {
    name: "auth-broker",
    args: "[serve|token|login|logout|import|migrate|status|list]",
    zh: "管理 omp 凭据保管库（auth-broker）",
    examples: ["omp auth-broker serve", "omp auth-broker token --regenerate", "omp auth-broker list"],
  },
  {
    name: "auth-gateway",
    args: "[serve|stdio|token|status|check]",
    zh: "运行 auth-gateway：由保管库支撑的 HTTP 转发代理，或在 stdio 上收发 JSON 行",
    examples: ["omp auth-gateway serve", "omp auth-gateway serve --bind=127.0.0.1:4000", "omp auth-gateway status"],
  },
  {
    name: "bench",
    args: "MODELS...",
    zh: "基准测试模型：TTFT/预填充对解码吞吐的 p50/p95，覆盖对话、预填充、生成与提示缓存负载",
    examples: [
      "omp bench anthropic/claude-opus-4-5 openai/gpt-5.2",
      "omp bench opus --runs 3",
      "omp bench opus sonnet --profile generation",
    ],
  },
  {
    name: "browser-relay",
    args: "[serve|install]",
    zh: "运行本地 CDP relay，让 browser 预置驱动你自己的 Chrome 标签页",
    examples: ["omp browser-relay install", "omp browser-relay -p 9333 --token s3cret"],
  },
  {
    name: "cleanse",
    args: "[REQUEST]",
    zh: "用加权并行子代理检测并修复项目诊断问题",
    examples: ["omp cleanse", "omp cleanse \"ts errors\"", "omp cleanse --all"],
  },
  {
    name: "clip",
    args: "[FILE]",
    zh: "把 /record 录制上传到 live.omp.sh 作为公开 clip 并打印链接",
    examples: ["omp clip", "omp clip -t \"<标题>\" -d \"<描述>\""],
  },
  {
    name: "collab",
    args: "[list|link] [SELECTOR]",
    zh: "列出本地协作会话，或取回指定实例的控制链接（--view 为只读链接）",
    examples: ["omp collab list", "omp collab link <instanceId|pid> --view"],
  },
  {
    name: "commit",
    args: "",
    zh: "生成提交信息并更新 changelog",
    examples: ["omp commit", "omp commit --dry-run", "omp commit --push"],
  },
  {
    name: "completions",
    args: "SHELL",
    zh: "打印 shell 补全脚本（bash / zsh / fish）",
    examples: ["omp completions zsh", "omp completions bash", "omp completions fish"],
  },
  {
    name: "compress",
    args: "FILES...",
    zh: "把文本文件改写成高密度的提示词文体，并报告丢弃了哪些内容",
    examples: ["omp compress notes.md -o notes.compressed.md", "omp compress 'src/prompts/**/*.md' -i"],
  },
  {
    name: "config",
    args: "[list|get|set|reset|path|init-xdg] [KEY] [VALUE]",
    zh: "管理配置项：列出、读取、设置、重置、查看路径",
    examples: ["omp config list", "omp config get <key>", "omp config path", "omp config list --scope global"],
  },
  {
    name: "dry-balance",
    args: "[MODEL]",
    zh: "用随机 session id 空跑 OAuth 账号均衡，看凭据会落到哪个账号",
    examples: ["omp dry-balance", "omp dry-balance --count 1000 --concurrency 64"],
  },
  {
    name: "find",
    args: "[QUERY] [PATH]",
    zh: "语义搜索：用自然语言描述行为，返回实现它的文件与行区间",
    examples: ["omp find \"<行为描述>\"", "omp find \"<行为描述>\" src --hidden"],
  },
  {
    name: "gallery",
    args: "",
    zh: "以确定性的视觉画廊预览工具、输入框与状态栏渲染器",
    examples: ["omp gallery", "omp gallery --tool <工具名> --plain"],
  },
  {
    name: "gc",
    args: "",
    zh: "运行存储垃圾回收（默认 dry-run，加 --apply 才落盘）",
    examples: ["omp gc", "omp gc --apply", "omp gc --apply --blobs --archive --wal", "omp gc --compress --apply"],
  },
  {
    name: "git",
    args: "[REVISION]",
    zh: "全屏 git 界面：分栏 diff、暂存侧栏与提交编辑器",
    examples: ["omp git", "omp git HEAD~2", "omp git -C ~/projects/app"],
  },
  {
    name: "grep",
    args: "[PATTERN] [PATH]",
    zh: "测试 grep 工具：按正则搜索并输出匹配（仅供调试工具用）",
    examples: ["omp grep \"<正则>\" src", "omp grep TODO src -f"],
  },
  {
    name: "grievances",
    args: "[list|clean|push]",
    zh: "查看、清理或推送工具问题报告（auto-QA grievances）",
    examples: ["omp grievances", "omp grievances list --tool find", "omp grievances clean --all"],
  },
  {
    name: "if-bench",
    args: "MODELS...",
    zh: "基准测试指令遵循与工作记忆：一条缓存线程上的字符数组操作，外加会移动的指令",
    examples: ["omp if-bench opus sonnet gpt-5.2", "omp if-bench opus --turns 40 --par 1"],
  },
  {
    name: "images",
    args: "[status|doctor|probe|purge]",
    zh: "检查、诊断、探测与清理图片发布后端",
    examples: ["omp images status --json", "omp images doctor", "omp images purge --all --apply"],
  },
  {
    name: "install",
    args: "TARGETS...",
    zh: "安装或链接扩展包（等价于 plugin install / plugin link）",
    examples: ["omp install <npm 包或本地路径>", "omp install <包名> --scope project"],
  },
  {
    name: "join",
    args: "LINK",
    zh: "加入共享的协作会话（同 /join）",
    examples: ["omp join \"<协作链接>\""],
  },
  {
    name: "login",
    args: "[PROVIDER]",
    zh: "登录模型服务商（终端版的 /login）",
    examples: ["omp login", "omp login anthropic"],
  },
  {
    name: "models",
    args: "[ls|find|refresh|<provider>] [PATTERN]",
    zh: "列出、搜索、刷新可用模型",
    examples: ["omp models", "omp models find minimax", "omp models refresh"],
  },
  {
    name: "play",
    args: "[FILE]",
    zh: "在终端回放 /record 录制（空格暂停，q 退出）",
    examples: ["omp play", "omp play <录制文件> -s 2 -i 1"],
  },
  {
    name: "plugin",
    args: "[install|uninstall|list|link|doctor|features|config|enable|disable|marketplace|discover|upgrade]",
    zh: "管理插件：安装、卸载、列出、诊断、特性开关",
    examples: ["omp plugin list", "omp plugin doctor", "omp plugin doctor --fix"],
  },
  {
    name: "predict",
    args: "",
    zh: "输入提示词，实时对比各单词补全引擎的 ghost 文本",
    examples: ["omp predict"],
  },
  {
    name: "ps",
    args: "[list|info|logs|stop|kill|restart] [NAME]",
    zh: "列出与控制守护进程托管的后台进程（日志、停止、杀掉、重启）",
    examples: ["omp ps", "omp ps --all", "omp ps logs <进程名> --follow", "omp ps stop <进程名>"],
  },
  {
    name: "read",
    args: "PATH",
    zh: "展示 read 工具对某个路径、URL 或内部 URI 会返回什么",
    examples: ["omp read src/foo.ts", "omp read src/foo.ts:50-100", "omp read omp://"],
  },
  {
    name: "render",
    args: "[SESSION]",
    zh: "用生产环境的 transcript 渲染管线画出整个会话线程（带重绘耗时）",
    examples: ["omp render", "omp render 01a0285c --plain", "omp render <会话文件> -q -t --repaint 5"],
  },
  {
    name: "say",
    args: "[TEXT]",
    zh: "用本地 TTS 引擎合成并播放文本",
    examples: ["omp say \"hello world\"", "omp say --file notes.md --speed 1.25"],
  },
  {
    name: "search",
    args: "[QUERY...]",
    zh: "测试联网搜索服务商",
    examples: ["omp search \"<查询>\"", "omp search \"<查询>\" -l 5 --compact"],
  },
  {
    name: "session",
    args: "pack|unpack|moved [SOURCE] [OUTPUT]",
    zh: "把会话交给另一台机器：打包、解包，或标记本地副本已搬走",
    examples: [
      "omp session pack <会话文件> /tmp/session.tar",
      "omp session unpack /tmp/session.tar --cwd ~/src/project",
      "omp session moved <会话文件> --to cloud",
    ],
  },
  {
    name: "setup",
    args: "[python|speech]",
    zh: "运行引导配置，或安装可选功能的依赖",
    examples: ["omp setup", "omp setup --check", "omp setup speech"],
  },
  {
    name: "share",
    args: "SESSION",
    zh: "通过加密链接分享已保存的会话（同 /share）",
    examples: ["omp share <会话 id>", "omp share <会话 id> --gist"],
  },
  {
    name: "shell",
    args: "",
    zh: "交互式 shell 控制台",
    examples: ["omp shell", "omp shell -C <目录>"],
  },
  {
    name: "skill",
    args: "[publish|version|tag|yank|deprecate|owner|token|import|install|update|uninstall|search|info|list] [TARGETS...]",
    zh: "在 Skillshare 注册表（skills.omp.sh）上安装、搜索、发布与管理技能",
    examples: ["omp skill search <关键词>", "omp skill install <技能名>", "omp skill list"],
  },
  {
    name: "ssh",
    args: "[add|remove|list]",
    zh: "管理 SSH 主机配置",
    examples: ["omp ssh list", "omp ssh add <主机名> --host <地址> --user <用户名>"],
  },
  {
    name: "stats",
    args: "",
    zh: "查看用量统计（可起本地面板或直接输出 JSON/摘要）",
    examples: ["omp stats", "omp stats --summary", "omp stats --json"],
  },
  {
    name: "stream",
    args: "",
    zh: "把本机会话屏幕与对话广播到公开直播频道",
    examples: ["omp stream", "omp stream --title \"<标题>\""],
  },
  {
    name: "tiny-models",
    args: "[download|list] [MODEL]",
    zh: "下载本地小模型（会话标题、记忆、单词补全）",
    examples: ["omp tiny-models list", "omp tiny-models download smollm"],
  },
  {
    name: "token",
    args: "PROVIDER",
    zh: "取某个服务商的 API key 或 OAuth token",
    examples: ["omp token anthropic", "omp token github-copilot --raw", "omp token anthropic -l"],
  },
  {
    name: "toks",
    args: "INPUT...",
    zh: "用所有内置离线分词器（OpenAI、Claude、Qwen…）统计文件或文本的 token 数",
    examples: ["omp toks README.md", "omp toks \"<文本>\" --json"],
  },
  {
    name: "ttsr",
    args: "[test|list|scan]",
    zh: "检查与测试 Time-Traveling Stream Rules（TTSR）",
    examples: ["omp ttsr list", "omp ttsr test <片段文本>", "omp ttsr scan <目录>"],
  },
  {
    name: "update",
    args: "",
    zh: "检查并安装更新",
    examples: ["omp update", "omp update --check", "omp update --canary"],
  },
  {
    name: "usage",
    args: "[invalidate|clients|accounts|reset]",
    zh: "查看每个已认证账号的服务商用量限额",
    examples: ["omp usage", "omp usage --provider anthropic", "omp usage --history --days 7"],
  },
  {
    name: "worktree",
    args: "[list|clear|add] [PATH] [COMMIT]",
    zh: "添加、列出或清理 git worktree",
    examples: ["omp worktree", "omp worktree add <路径> <commit> -b <分支>", "omp worktree clear -n"],
  },
];
