/**
 * 管理视图：模型 / Agent / 插件 / Skills / MCP / 记忆库六个标签页 + 全部更新 + 单操作日志。
 * 单操作模型（useOmpOp）在此创建并传入插件与技能面板；模型/Agent/MCP 面板不感知
 * omp 操作，用 fieldset 在忙时禁用其内部按钮（结构保持不变，不重挂载）。
 */
import { useState } from "react";
import {
  checkOmpUpdate,
  normalizeError,
  updateOmpMarketplaces,
  updateOmpSkills,
  upgradeOmpPlugins,
} from "../api";
import { errorText } from "../format";
import type { OmpUpdateCheck, PluginUpgradeChange } from "../types";
import { McpPanel } from "./McpPanel";
import { MemoryPanel } from "./MemoryPanel";
import { AgentsTab } from "./AgentsTab";
import { ModelsTab } from "./ModelsTab";
import { PluginsPanel, upgradeIsUpToDate } from "./PluginsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { useAlive, useOmpOp, type ToastFn } from "./useOmpOp";

export interface ManageProject {
  cwd: string;
  name: string;
}

interface ManageViewProps {
  projects: ManageProject[];
  onToast: ToastFn;
  onBack: () => void;
  /** 与侧栏「检查 omp 更新」同一回调：有新版时打开更新对话框。 */
  onCheckOmp: () => void;
  /** 当前列表已加载的会话 id：记忆库「查看来源会话」据此判断可用性。 */
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
}

type ManageTab = "models" | "agents" | "plugins" | "skills" | "mcp" | "memory";

interface UpdateAllStep {
  name: string;
  ok: boolean;
  detail: string;
}

const TABS: { key: ManageTab; label: string }[] = [
  { key: "models", label: "模型" },
  { key: "agents", label: "Agent" },
  { key: "plugins", label: "插件" },
  { key: "skills", label: "Skills" },
  { key: "mcp", label: "MCP" },
  { key: "memory", label: "记忆库" },
];

export function ManageView({ projects, onToast, onBack, onCheckOmp, loadedSessionIds, onOpenSession }: ManageViewProps) {
  const op = useOmpOp();
  const alive = useAlive();
  const [tab, setTab] = useState<ManageTab>("models");
  const [refreshToken, setRefreshToken] = useState(0);
  const [summary, setSummary] = useState<UpdateAllStep[] | null>(null);
  const busy = op.running !== null;

  /** 全部更新：顺序执行，首个失败即停并点名失败步骤；最后检查 omp 本体。 */
  async function updateAll() {
    setSummary(null);
    const steps: UpdateAllStep[] = [];
    let latest: OmpUpdateCheck | null = null;
    const outcome = await op.run("全部更新", async (onLine) => {
      try {
        await updateOmpMarketplaces(null, onLine);
        steps.push({ name: "更新 marketplace 目录", ok: true, detail: "完成" });
      } catch (e: unknown) {
        steps.push({
          name: "更新 marketplace 目录",
          ok: false,
          detail: errorText(normalizeError(e)),
        });
        return;
      }
      try {
        const upgraded = await upgradeOmpPlugins(null, onLine);
        steps.push({
          name: "升级插件",
          ok: true,
          detail: upgradeDetail(upgraded.changes, upgraded.output),
        });
      } catch (e: unknown) {
        steps.push({
          name: "升级插件",
          ok: false,
          detail: errorText(normalizeError(e)),
        });
        return;
      }
      try {
        await updateOmpSkills(onLine);
        steps.push({ name: "更新 registry skills", ok: true, detail: "完成" });
      } catch (e: unknown) {
        steps.push({
          name: "更新 registry skills",
          ok: false,
          detail: errorText(normalizeError(e)),
        });
        return;
      }
      try {
        const check = await checkOmpUpdate();
        if (check.latest !== null) {
          latest = check;
          steps.push({
            name: "检查 omp 更新",
            ok: true,
            detail: `发现新版 ${check.latest}`,
          });
        } else {
          steps.push({ name: "检查 omp 更新", ok: true, detail: "omp 已是最新" });
        }
      } catch (e: unknown) {
        steps.push({
          name: "检查 omp 更新",
          ok: false,
          detail: errorText(normalizeError(e)),
        });
      }
    });
    if (!alive.current) return;
    if (!outcome.ok && steps.length === 0) {
      // 重入防御触发：任务根本没跑，只 toast，不刷列表、不开对话框。
      onToast(errorText(outcome.error), "error");
      return;
    }
    setSummary(steps);
    setRefreshToken((t) => t + 1);
    const failed = steps.find((s) => !s.ok);
    if (failed !== undefined) {
      onToast(`全部更新在「${failed.name}」失败：${failed.detail}`, "error");
    } else {
      onToast("全部更新完成", "info");
      // 有新版才打开更新对话框（App 现有流程负责确认与执行）；已是最新只记一行。
      if (latest !== null) onCheckOmp();
    }
  }

  return (
    <main className="detail manage">
      <header className="detail-head manage-head">
        <button type="button" className="btn" onClick={onBack}>
          返回会话
        </button>
        <h1 className="detail-title">管理</h1>
      </header>
      <div className="toolbar">
        <button
          type="button"
          className="btn btn-accent"
          disabled={busy}
          onClick={() => void updateAll()}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          全部更新
        </button>
        {busy ? <span className="muted">正在执行：{op.running}…</span> : null}
      </div>
      {summary !== null ? (
        <ul className="manage-summary" aria-label="全部更新结果">
          {summary.map((s) => (
            <li key={s.name} className={s.ok ? "manage-step-ok" : "manage-step-fail"}>
              {s.ok ? "✔" : "✘"} {s.name}：{s.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="tabs" role="tablist" aria-label="管理视图">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`tab-manage-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-manage-${t.key}`}
            className={tab === t.key ? "tab tab-active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`panel-manage-${tab}`}
        aria-labelledby={`tab-manage-${tab}`}
        className="panel"
      >
        {tab === "models" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            {/* 忙时整页禁用是故意的：bench 虽不占单写锁，但全部更新期间避免一切中途编辑。 */}
            <ModelsTab onToast={onToast} />
          </fieldset>
        ) : tab === "agents" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            <AgentsTab onToast={onToast} />
          </fieldset>
        ) : tab === "plugins" ? (
          <PluginsPanel op={op} onToast={onToast} refreshToken={refreshToken} />
        ) : tab === "skills" ? (
          <SkillsPanel op={op} onToast={onToast} refreshToken={refreshToken} />
        ) : tab === "mcp" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            <McpPanel projects={projects} onToast={onToast} />
          </fieldset>
        ) : (
          <MemoryPanel
            loadedSessionIds={loadedSessionIds}
            onOpenSession={onOpenSession}
            onToast={onToast}
          />
        )}
      </div>
      {busy || op.lines.length > 0 ? (
        <section className="manage-log" aria-label="操作日志区">
          <div className="muted">{busy ? `操作日志（${op.running}…）` : "操作日志"}</div>
          <pre className="plain-text mono" aria-label="操作日志">
            {op.lines.join("\n")}
          </pre>
        </section>
      ) : null}
    </main>
  );
}

/** 升级步骤的一行小结：有变化报个数，无变化且输出声明已是最新才报最新。 */
function upgradeDetail(changes: PluginUpgradeChange[], output: string): string {
  if (changes.length > 0) return `${changes.length} 个插件已升级`;
  if (upgradeIsUpToDate(changes, output)) return "全部已是最新";
  return "完成";
}
