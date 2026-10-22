/** 命令详解分片 3：见 ../ompCommandDetails.ts 的编写规则。 */
import type { OmpCommandDetail } from "../ompCommandDetails";

export const PART_3: Record<string, OmpCommandDetail> = {
  wt: {
    when: "想在干净的分支上动代码、又不想污染当前工作区时；当前目录的未提交改动会跟着会话一起搬过去。",
    cautions: ["会把当前改动搬到新 worktree，原目录的工作区状态随之变化，搬之前先确认没有不想带走的改动。"],
    params: [{ token: "<branch>", zh: "新分支名；省略则交互式选择。" }],
    related: ["git", "move", "fork"],
  },
  "add-dir": {
    when: "当前任务涉及多个目录（比如前后端分仓），需要让 agent 同时读写会话外的目录时。",
    cautions: ["该目录会进入 agent 的可操作范围，含敏感文件的目录谨慎添加。"],
    params: [{ token: "<path>", zh: "要加入会话的目录路径。" }],
    related: ["dirs", "remove-dir"],
  },
  "remove-dir": {
    when: "某个目录的任务已结束，想缩小 agent 的可操作范围、避免它误改不相关的目录时。",
    params: [{ token: "<path>", zh: "要从会话移除的目录路径。" }],
    related: ["dirs", "add-dir"],
  },
  dirs: {
    when: "不确定 agent 当前能操作哪些目录，想核对会话的工作目录清单时。",
    related: ["add-dir", "remove-dir"],
  },
  git: {
    when: "想在不离开终端的情况下浏览提交、分支与改动，或做提交、切分支等日常版本控制操作时。",
    params: [{ token: "revision", zh: "打开时定位到的提交、分支或标签；省略则打开默认视图。" }],
    related: ["wt", "move"],
  },
  share: {
    when: "想把当前会话发给别人看（比如请同事帮忙看一次排查过程）时；对方通过链接打开只读副本。",
    cautions: ["会生成一条加密链接，拿到链接的人可打开这次会话的内容；确认不含密钥、Token 等敏感信息再分享。"],
    related: ["export", "collab", "dump"],
  },
  collab: {
    when: "需要别人实时看你操作、甚至一起参与当前会话（比如结对排查线上问题）时。",
    cautions: ["共享期间对方可实时看到会话内容（含终端输出）；协作结束记得 stop。"],
    params: [
      { token: "start", zh: "开始共享当前会话。" },
      { token: "view", zh: "查看一次实时共享。" },
      { token: "list", zh: "列出正在进行的共享。" },
      { token: "stop", zh: "停止当前共享。" },
      { token: "status", zh: "查看共享状态。" },
      { token: "relayUrl", zh: "自建中继地址；省略则用默认中继。" },
    ],
    related: ["share", "join", "leave"],
  },
  join: {
    when: "同事发来一条协作链接，邀请你实时加入他的会话一起看、一起操作时。",
    params: [{ token: "<link>", zh: "对方发来的协作链接。" }],
    related: ["collab", "leave"],
  },
  leave: {
    when: "已经看完或帮完忙，想退出别人共享给你的协作会话时。",
    related: ["join", "collab"],
  },
  marketplace: {
    when: "想从插件市场找现成能力（比如新的评审流程、部署工具）装进 omp 时。",
    cautions: ["remove 会卸载插件，插件提供的命令、工具与钩子随之失效。"],
    params: [
      { token: "list", zh: "列出市场中的可用插件。" },
      { token: "discover", zh: "发现、浏览市场中的插件。" },
      { token: "add", zh: "添加一个市场源。" },
      { token: "install", zh: "安装指定插件。" },
      { token: "update", zh: "更新市场索引或已装插件。" },
      { token: "remove", zh: "卸载指定插件。" },
    ],
    related: ["plugins", "reload-plugins", "skills"],
  },
  plugins: {
    when: "想看看装了哪些插件，或临时关掉某个捣乱的插件、稍后再重新启用时。",
    params: [
      { token: "list", zh: "列出已安装的插件。" },
      { token: "enable", zh: "启用指定插件。" },
      { token: "disable", zh: "停用指定插件（不停删，随时可再启用）。" },
    ],
    related: ["marketplace", "reload-plugins", "extensions"],
  },
  "reload-plugins": {
    when: "刚装好、升级完或手动改过插件，需要让新技能、命令与工具立即生效、又不想重启应用时。",
    related: ["plugins", "marketplace"],
  },
  skills: {
    when: "想从技能注册表找现成技能（比如某种代码规范检查）装进来用时。",
    params: [
      { token: "search", zh: "按关键词搜索技能。" },
      { token: "install", zh: "安装指定技能。" },
      { token: "installed", zh: "列出已安装的技能。" },
      { token: "update", zh: "更新已安装的技能。" },
    ],
    related: ["marketplace", "plugins", "skillful"],
  },
  mcp: {
    when: "需要接外部数据源或工具（比如数据库、浏览器、云服务）进会话，让 agent 直接调用时。",
    cautions: ["remove 会删除该服务的配置，需重新配置才能恢复；外部服务只接可信来源。"],
    params: [
      { token: "list", zh: "列出已配置的服务。" },
      { token: "add", zh: "添加一个服务。" },
      { token: "remove", zh: "移除指定服务及其配置。" },
      { token: "test", zh: "测试指定服务的连通性。" },
      { token: "enable", zh: "启用指定服务。" },
      { token: "disable", zh: "停用指定服务。" },
    ],
    related: ["plugins", "reload-plugins", "extensions"],
  },
  skillful: {
    when: "技能太多把系统提示撑大、想省上下文，或者反过来想让 agent 重新看到技能列表时。",
    params: [
      { token: "on", zh: "在系统提示中展示技能列表。" },
      { token: "off", zh: "在系统提示中隐藏技能列表。" },
      { token: "status", zh: "查看当前开关状态。" },
    ],
    related: ["skills"],
  },
  extensions: {
    when: "想在一个地方总览各类扩展（插件、技能、外部服务等）的状态并统一管理时。",
    related: ["plugins", "skills", "mcp"],
  },
  ssh: {
    when: "需要在 omp 里管理常用的远程主机（比如给远程开发或部署用的机器建 profile）时。",
    cautions: ["remove 会删除该主机的保存信息，需要重新添加。"],
    params: [
      { token: "add", zh: "添加一台主机。" },
      { token: "list", zh: "列出已保存的主机。" },
      { token: "remove", zh: "删除指定主机。" },
      { token: "help", zh: "查看主机管理的帮助。" },
    ],
    related: ["settings", "setup"],
  },
  settings: {
    when: "想改通用设置（外观、行为偏好等），但记不清配置项写在哪个文件时。",
    related: ["setup", "login"],
  },
  setup: {
    when: "刚装好或换了服务商，需要登录账号、配密钥或打开联网搜索时。",
    params: [{ token: "providers", zh: "直接打开服务商配置页；省略则打开完整配置向导。" }],
    related: ["login", "settings", "model"],
  },
  login: {
    when: "服务商需要重新做 OAuth 登录（比如换了电脑，或 Token 过期被踢下线）时。",
    params: [
      { token: "provider", zh: "要登录的服务商；省略则交互式选择。" },
      { token: "redirect URL", zh: "浏览器回跳地址，远程登录流程用。" },
    ],
    related: ["logout", "setup", "session"],
  },
  logout: {
    when: "不再用某个 OAuth 账号（比如换了工作账号，或清理共用机器上的登录态）时。",
    cautions: ["会移除该账号的本地凭据，登出后相关模型不可用，直到重新登录。"],
    params: [{ token: "provider", zh: "要登出的服务商；省略则交互式选择。" }],
    related: ["login", "setup"],
  },
  browser: {
    when: "浏览器预设跑不起来、想亲眼看页面发生了什么，或者反过来想切回无界面省资源时。",
    params: [
      { token: "headless", zh: "无界面模式，后台运行浏览器。" },
      { token: "visible", zh: "有界面模式，能看到浏览器窗口。" },
    ],
    related: ["settings"],
  },
};
