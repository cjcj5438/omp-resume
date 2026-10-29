/** 命令详解分片 1：见 ../ompCommandDetails.ts 的编写规则。 */
import type { OmpCommandDetail } from "../ompCommandDetails";

export const PART_1: Record<string, OmpCommandDetail> = {
  new: {
    when: "当前话题已经结束、想另起一题时用；旧会话会自动保存，随时可以回来。",
    related: ["resume", "clear", "fork"],
  },
  delete: {
    when: "当前会话已经没有保留价值、想直接丢掉并开一个新会话时用。",
    cautions: ["会删掉当前会话，删除后无法恢复。"],
    related: ["new", "clear", "session"],
  },
  resume: {
    when: "想回到之前某个会话继续聊时用；不带参数会列出可恢复的会话供挑选。",
    params: [
      { token: "session id", zh: "要恢复的会话编号（用列表里显示的前缀即可）。" },
      { token: "@claude", zh: "恢复一个 Claude Code 导出的会话。" },
      { token: "@codex", zh: "恢复一个 Codex 导出的会话。" },
    ],
    related: ["seance", "pin", "new"],
  },
  pin: {
    when: "有几个常用会话、希望它们一直排在恢复列表顶部时用；对已置顶的会话再执行一次即取消置顶。",
    params: [
      { token: "session id", zh: "要置顶/取消置顶的会话编号，缺省为当前会话。" },
    ],
    related: ["resume", "session", "rename"],
  },
  rename: {
    when: "自动生成的会话标题看不出内容、想给当前会话起个好认的名字时用。",
    params: [{ token: "title", zh: "新标题；缺省则重新自动生成一个。" }],
    related: ["pin", "session"],
  },
  move: {
    when: "当前会话一开始开错了目录、想把它整体搬到另一个项目目录下继续时用。",
    params: [{ token: "<path>", zh: "目标目录路径。" }],
    related: ["wt", "add-dir", "dirs"],
  },
  branch: {
    when: "对话走偏了、想从中间某条消息换个方向重来，但又不想丢掉后面已有的尝试时用。",
    related: ["tree", "fork", "clear"],
  },
  fork: {
    when: "想基于当前会话并行试另一个方案、又不想打断当前进度时用，会在新的终端面板或窗口里打开分叉。",
    params: [
      { token: "pane", zh: "在当前终端的新面板里打开分叉。" },
      { token: "window", zh: "在新终端窗口里打开分叉。" },
      { token: "tab", zh: "在当前终端的新标签页里打开分叉。" },
    ],
    related: ["branch", "tree", "new"],
  },
  tree: {
    when: "回退或分叉了好几次、想看清各条分支都走到哪、再切到其中一条继续时用。",
    related: ["branch", "fork", "resume"],
  },
  session: {
    when: "想查看当前会话的详细信息、清理它，或给它绑定一个固定的 OAuth 账号时用。",
    params: [
      { token: "info", zh: "查看当前会话的信息。" },
      { token: "delete", zh: "删除当前会话。" },
      { token: "pin", zh: "给本会话绑定 OAuth 账号。" },
      { token: "account", zh: "要绑定的账号，缺省时从可用账号里选。" },
    ],
    cautions: ["delete 子命令会删掉当前会话，无法恢复。"],
    related: ["delete", "pin", "login"],
  },
  queue: {
    when: "agent 还在跑上一轮、你已经想好下一句要说什么时用，消息会在本轮结束后自动发出，不用干等。",
    params: [{ token: "<message>", zh: "要排队的消息内容。" }],
    related: ["btw", "retry", "pause"],
  },
  btw: {
    when: "正事聊到一半、突然想顺带问个不相关的小问题，又不想打断主线时用；不带参数可回顾本会话问过的旁支问题。",
    params: [{ token: "question", zh: "旁支问题的内容。" }],
    related: ["queue", "tan", "copy"],
  },
  copy: {
    when: "对话里出现了一段想拿走的代码或文本、用鼠标框选太麻烦时用，可以逐块挑选复制。",
    related: ["open", "export", "dump"],
  },
  open: {
    when: "对话里刚出现过链接、想直接在浏览器里打开看时用；有多条链接时先用挑选命令选定一条。",
    related: ["copy", "export"],
  },
  export: {
    when: "想把整个会话存成一个 HTML 文件，方便发给别人看或自己归档时用。",
    params: [
      { token: "--themes", zh: "列出导出可用的主题。" },
      { token: "path", zh: "输出文件路径，缺省为自动生成的文件名。" },
    ],
    cautions: ["会把完整会话内容写入你指定的文件，注意别把含密钥的内容发出去。"],
    related: ["dump", "share", "copy"],
  },
  dump: {
    when: "会话出了怪问题、需要把完整记录和请求报文交给开发者排查时用；会复制到剪贴板并写出 LLM 请求 JSON。",
    params: [
      { token: "all", zh: "把子 agent 的记录也一起打进 zip。" },
      { token: "anon", zh: "打包含子 agent 的 zip，但做匿名化处理。" },
    ],
    cautions: ["会把会话内容写入剪贴板和本地文件，含敏感信息，分享前先检查。"],
    related: ["export", "debug", "trace"],
  },
  seance: {
    when: "只想问问另一个旧会话里记了什么、不想真的切过去时用；以只读方式咨询，不会打乱当前会话。",
    params: [
      { token: "session id", zh: "要咨询的已保存会话的编号。" },
      { token: "path", zh: "要咨询的会话文件的路径。" },
      { token: "--model", zh: "指定回答这次咨询用的模型。" },
      { token: "selector", zh: "模型选择器，形如 provider/model。" },
    ],
    related: ["resume", "memory", "btw"],
  },
  local: {
    when: "agent 把计划、报告等写进了会话的 local:// 文件，想直接在自己的编辑器里查看或修改时用。",
    params: [{ token: "name", zh: "local:// 下的文件名；缺省先弹出选择列表。" }],
    related: ["export", "copy"],
  },
  clear: {
    when: "当前会话的上下文已经很臃肿、回答开始变慢变差，但话题本身还要继续时用；会话记录保留，只清空上下文。",
    cautions: ["会整段清空模型上下文且不生成摘要，之前的细节模型完全看不到；重要结论先记下来。"],
    related: ["compact", "shake", "handoff"],
  },
  fresh: {
    when: "模型连接卡住、报错或行为异常，怀疑是连接状态问题而不是上下文问题时用；只重置连接，不动本地记录。",
    related: ["clear", "retry", "model"],
  },
  compact: {
    when: "上下文快满了、但还不想结束当前话题时用；手动触发一次压缩，把历史压成摘要腾出空间。",
    params: [
      { token: "soft", zh: "轻量压缩，保留更多原文细节。" },
      { token: "remote", zh: "用远端模型做压缩，本地不占推理。" },
      { token: "snapcompact", zh: "快照式压缩，先留快照再压。" },
      { token: "focus", zh: "告诉压缩过程要重点保留哪些内容。" },
    ],
    cautions: ["压缩是有损的，部分细节会被摘要替代，关键结论建议先让模型复述确认。"],
    related: ["clear", "shake", "handoff"],
  },
  shake: {
    when: "上下文里塞满了冗长的工具输出、图片或思考过程，想定向甩掉其中一类包袱时用，比整轮压缩更精准。",
    params: [
      { token: "elide", zh: "丢弃过长的工具结果，只留摘要。" },
      { token: "images", zh: "丢弃上下文里的图片内容。" },
      { token: "thinking", zh: "丢弃模型的思考过程，只留结论。" },
    ],
    cautions: ["丢弃的内容不可恢复；甩掉思考过程后，模型后续可能忘记当初为什么这么做。"],
    related: ["compact", "clear", "context"],
  },
  handoff: {
    when: "想把当前进度交接给下一个会话（或换人/换模型接手）时用；会生成一份交接摘要并就地压缩。",
    params: [{ token: "focus instructions", zh: "交代摘要里必须保留的重点，例如保留失败排查过程。" }],
    cautions: ["交接后当前上下文会被压缩，没写进摘要的细节会丢失，交代重点时尽量具体。"],
    related: ["compact", "clear", "export"],
  },
  context: {
    when: "感觉回答变差、怀疑上下文快爆了，想先看清各类内容各占了多少空间再决定怎么瘦身时用。",
    related: ["compact", "shake", "clear"],
  },
};
