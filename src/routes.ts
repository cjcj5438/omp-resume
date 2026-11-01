/**
 * 顶层路由：每个功能是一个独立页面。左侧导航按 NAV_GROUPS 渲染。
 * usage/health 同族（StatsView 常驻），配置类路由同族（ManageView 常驻），
 * 切换同族路由时组件不卸载，保住缓存与写入门禁。
 */
import {
  Activity,
  BookOpen,
  Bot,
  Brain,
  ChartColumn,
  Cpu,
  Eraser,
  FlaskConical,
  History,
  MessagesSquare,
  PanelTop,
  Plug,
  Server,
  Settings,
  Sparkles,
  Theater,
  type LucideIcon,
} from "lucide-react";

export type Route =
  | "sessions"
  | "session"
  | "usage"
  | "health"
  | "cleanup"
  | "history"
  | "stage"
  | "models"
  | "bench"
  | "agents"
  | "plugins"
  | "skills"
  | "mcp"
  | "memory"
  | "cheatsheet"
  | "settings"
  | "tray";

export type ConfigRoute = "models" | "bench" | "agents" | "plugins" | "skills" | "mcp" | "memory";

export function isConfigRoute(r: Route): r is ConfigRoute {
  return (
    r === "models" ||
    r === "bench" ||
    r === "agents" ||
    r === "plugins" ||
    r === "skills" ||
    r === "mcp" ||
    r === "memory"
  );
}

/** 导航分组：顺序与文案照设计稿。MCP 没有合适图标，用 Server（机架）。 */
export const NAV_GROUPS: {
  label: string;
  items: { route: Route; label: string; icon: LucideIcon }[];
}[] = [
  { label: "会话", items: [{ route: "sessions", label: "会话列表", icon: MessagesSquare }] },
  {
    label: "分析",
    items: [
      { route: "usage", label: "用量", icon: ChartColumn },
      { route: "health", label: "运行健康", icon: Activity },
      { route: "cleanup", label: "清理候选", icon: Eraser },
      { route: "history", label: "提示词历史", icon: History },
    ],
  },
  { label: "Agent Stage", items: [{ route: "stage", label: "像素办公室", icon: Theater }] },
  {
    label: "环境配置",
    items: [
      { route: "models", label: "模型", icon: Cpu },
      { route: "agents", label: "Agent", icon: Bot },
      { route: "plugins", label: "插件", icon: Plug },
      { route: "skills", label: "技能", icon: Sparkles },
      { route: "mcp", label: "MCP", icon: Server },
      { route: "memory", label: "记忆", icon: Brain },
    ],
  },
  {
    label: "工具",
    items: [
      { route: "bench", label: "模型测试", icon: FlaskConical },
      { route: "cheatsheet", label: "速查表", icon: BookOpen },
    ],
  },
  {
    label: "设置",
    items: [
      { route: "settings", label: "外观与行为", icon: Settings },
      { route: "tray", label: "菜单栏", icon: PanelTop },
    ],
  },
];

/** 面包屑与命令面板用的路由标题：session 为「会话」，其余与各页页头标题一致。 */
export const ROUTE_TITLE: Record<Route, string> = {
  sessions: "会话",
  session: "会话",
  usage: "用量",
  health: "运行健康",
  cleanup: "清理候选",
  history: "提示词历史",
  stage: "像素办公室",
  models: "模型",
  bench: "模型测试",
  agents: "Agent",
  plugins: "插件",
  skills: "技能",
  mcp: "MCP 服务器",
  memory: "记忆",
  cheatsheet: "速查表",
  settings: "外观与行为",
  tray: "菜单栏",
};
