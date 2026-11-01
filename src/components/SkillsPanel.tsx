/**
 * 技能面板：卡片网格（设计稿 skill-grid）+ 更新 registry skills。
 * CLI 无版本/可更新字段（2026-10-31 实测）：不渲染版本与检查更新。
 * 变更走 useOmpOp 单操作模型；忙时更新按钮禁用。
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { listOmpSkills, normalizeError, updateOmpSkills } from "../api";
import { errorText } from "../format";
import type { AppError, SkillsListResult } from "../types";
import { Badge, Ico } from "./ui";
import { PageHeader } from "./page";
import { useAlive, type OmpOpController, type ToastFn } from "./useOmpOp";
import "./SkillsPanel.css";
 interface SkillsPanelProps {
  op: OmpOpController;
  onToast: ToastFn;
  /** 全部更新完成后递增，触发列表重载。 */
  refreshToken: number;
  busy: boolean;
}

export function SkillsPanel({ op, onToast, refreshToken, busy }: SkillsPanelProps) {
  const alive = useAlive();
  const [data, setData] = useState<SkillsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<AppError | null>(null);
  const [ompMissing, setOmpMissing] = useState(false);

  const load = useCallback(async () => {
    if (alive.current) {
      setLoading(true);
      setListError(null);
      setOmpMissing(false);
    }
    try {
      const res = await listOmpSkills();
      if (!alive.current) return;
      setData(res);
    } catch (e: unknown) {
      if (!alive.current) return;
      const err = normalizeError(e);
      if (err.code === "OMP_NOT_FOUND") setOmpMissing(true);
      else setListError(err);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [alive]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function update() {
    const outcome = await op.run("更新 registry skills", (onLine) =>
      updateOmpSkills(onLine),
    );
    if (!alive.current) return;
    if (outcome.ok) {
      onToast("registry skills 已更新", "info");
      await load();
    } else {
      onToast(errorText(outcome.error), "error");
    }
  }

  if (data === null) {
    if (ompMissing)
      return <div className="pane-note">未找到 omp，请先安装 omp 后再管理技能。</div>;
    if (listError !== null)
      return (
        <div className="banner banner-error" role="alert">
          <span>{errorText(listError)}</span>
          <button type="button" className="btn btn-small" onClick={() => void load()}>
            重试
          </button>
        </div>
      );
    return <div className="pane-note">正在加载技能…</div>;
  }

  return (
    <div className="manage-section">
      <PageHeader
        kicker="环境配置 · 技能"
        title="技能"
        sub="已安装技能。更新只拉取 registry 版本，不会自动改写技能内容。"
        actions={
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void update()}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            更新全部{data.skills.length > 0 ? ` (${data.skills.length})` : ""}
          </button>
        }
      />
      {loading ? <div className="pane-note">正在加载技能…</div> : null}
      {listError !== null ? (
        <div className="banner banner-error" role="alert">
          <span>{errorText(listError)}</span>
          <button type="button" className="btn btn-small" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}
      {data.warnings.length > 0 ? (
        <div className="banner banner-warn">
          <ul className="manage-list">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="pane-hint">仅更新通过 omp skill 从 registry 安装的技能；~/.agents/skills 下的技能由其他工具管理，不受影响。</p>
      <h3 className="manage-sub">已安装技能</h3>
      {data.skills.length === 0 ? (
        <div className="pane-note">暂无技能</div>
      ) : (
        <div className="skill-grid">
          {data.skills.map((s) => (
            <article key={s.filePath} className="skill-card">
              <div className="skill-head">
                <span className="skill-name" title={s.filePath}>{s.name}</span>
                {s.hide ? <Badge tone="grey">隐藏</Badge> : <Badge tone="quiet">{s.source}</Badge>}
              </div>
              <p className="skill-desc" title={s.description}>{s.description}</p>
              <div className="skill-foot">
                <span className="mono" title={s.baseDir}>{s.baseDir.split("/").pop() ?? s.baseDir}</span>
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="inline-note"><Ico icon={ShieldCheck} size={12} /> 技能目录是只读材料，更新只拉取 registry 版本；如需修改技能本体，请直接编辑技能文件。</div>
    </div>
  );
}
