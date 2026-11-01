/**
 * 管理视图外壳：状态提供者（useModelDraft/useModelSpecs/useOmpOp 共享实例）+ 路由 + 操作日志。
 * 各面板自渲染 PageHeader；模型/Agent/MCP 面板用 fieldset 在忙时禁用其内部按钮（结构保持不变，不重挂载）。
 */
import { useState, type ReactNode } from "react";
import { type ConfigRoute } from "../routes";
import {
  checkOmpUpdate,
  normalizeError,
  updateOmpMarketplaces,
  updateOmpSkills,
  upgradeOmpPlugins,
} from "../api";
import { errorText } from "../format";
import { useModelDraft, useModelSpecs, type ModelDraftState } from "../modelDraft";
import type { OmpUpdateCheck, PluginUpgradeChange } from "../types";
import { McpPanel } from "./McpPanel";
import { MemoryPanel } from "./MemoryPanel";
import { AgentsTab } from "./AgentsTab";
import { BenchTab } from "./BenchTab";
import { ModelsTab } from "./ModelsTab";
import { PluginsPanel, upgradeIsUpToDate } from "./PluginsPanel";
import { SkillsPanel } from "./SkillsPanel";
import { useAlive, useOmpOp, type ToastFn } from "./useOmpOp";
import { Check, X } from "lucide-react";
import { Ico } from "./ui";

export interface ManageProject {
  cwd: string;
  name: string;
}

interface ManageViewProps {
  projects: ManageProject[];
  onToast: ToastFn;
  tab: ConfigRoute;
  /** 与导航「检查 omp 更新」同一回调：有新版时打开更新对话框。 */
  onCheckOmp: () => void;
  /** 当前列表已加载的会话 id：记忆库「查看来源会话」据此判断可用性。 */
  loadedSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
  onNavigate: (route: "bench") => void;
}

interface UpdateAllStep {
  name: string;
  ok: boolean;
  detail: string;
}

export function ManageView({ projects, onToast, tab, onCheckOmp, loadedSessionIds, onOpenSession, onNavigate }: ManageViewProps) {
  const op = useOmpOp();
  const draftLoad = useModelDraft(onToast);
  const draftLoadState = draftLoad.status === "ready" ? draftLoad.state : null;
  const specs = useModelSpecs(draftLoadState === null ? () => {} : (force?: boolean) => void draftLoadState.loadModels(force ?? false));
  const alive = useAlive();
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
  /** 模型/Agent 共用一份草稿：加载与错误外壳收在这里，两页只渲染 ready 态。 */
  const draftPanel = (render: (state: ModelDraftState) => ReactNode): ReactNode =>
    draftLoad.status === "loading" ? <div className="pane-note">正在读取模型配置…</div>
    : draftLoad.status === "error" ? (
      <div className="manage-section"><div className="banner banner-error" role="alert">
        <div>{draftLoad.loadError ?? "读取模型配置失败"}</div>
        <button type="button" className="btn btn-small" onClick={() => void draftLoad.loadConfig()}>重试</button>
      </div></div>)
    : render(draftLoad.state);

  // 各面板自渲染 PageHeader（COPY 随之迁移）；ManageView 只做状态提供者 + 路由 + 日志。
  return (
    <div className="view manage">
      {summary !== null ? (
        <ul className="manage-summary" aria-label="全部更新结果">
          {summary.map((s) => (
            <li key={s.name} className={s.ok ? undefined : "manage-step-fail"}>
              {s.ok ? <Ico icon={Check} size={12} /> : <Ico icon={X} size={12} />} {s.name}：{s.detail}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="page-body">
        {tab === "models" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            {draftPanel((s) => <ModelsTab onToast={onToast} state={s} specs={specs} onNavigateBench={() => onNavigate("bench")} />)}
          </fieldset>
        ) : tab === "bench" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            {/* 忙时整页禁用是故意的：bench 虽不占单写锁，但全部更新期间避免一切中途编辑。BenchTab 自带页头。 */}
            {draftPanel((s) => <BenchTab onToast={onToast} state={s} specs={specs} bare />)}
          </fieldset>
        ) : tab === "agents" ? (
          <fieldset disabled={busy} className="manage-fieldset">
            {draftPanel((s) => <AgentsTab state={s} onToast={onToast} />)}
          </fieldset>
        ) : tab === "plugins" ? (
          <PluginsPanel op={op} onToast={onToast} refreshToken={refreshToken} busy={busy} onUpdateAll={() => void updateAll()} />
        ) : tab === "skills" ? (
          <SkillsPanel op={op} onToast={onToast} refreshToken={refreshToken} busy={busy} />
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
    </div>
  );
}

/** 升级步骤的一行小结：有变化报个数，无变化且输出声明已是最新才报最新。 */
function upgradeDetail(changes: PluginUpgradeChange[], output: string): string {
  if (changes.length > 0) return `${changes.length} 个插件已升级`;
  if (upgradeIsUpToDate(changes, output)) return "全部已是最新";
  return "完成";
}

