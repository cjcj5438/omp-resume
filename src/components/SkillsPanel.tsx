/**
 * 技能面板：只读列表 + 更新 registry skills。
 * 变更走 useOmpOp 单操作模型；忙时更新按钮禁用。
 */
import { useCallback, useEffect, useState } from "react";
import { listOmpSkills, normalizeError, updateOmpSkills } from "../api";
import { errorText } from "../format";
import type { AppError, SkillsListResult } from "../types";
import { Badge } from "./ui";
import { useAlive, type OmpOpController, type ToastFn } from "./useOmpOp";

interface SkillsPanelProps {
  op: OmpOpController;
  onToast: ToastFn;
  /** 全部更新完成后递增，触发列表重载。 */
  refreshToken: number;
}

export function SkillsPanel({ op, onToast, refreshToken }: SkillsPanelProps) {
  const alive = useAlive();
  const [data, setData] = useState<SkillsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<AppError | null>(null);
  const [ompMissing, setOmpMissing] = useState(false);
  const busy = op.running !== null;

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
      <div className="toolbar">
        <button type="button" className="btn" disabled={busy} onClick={() => void update()}>
          更新 registry skills
        </button>
      </div>
      <p className="pane-note">仅更新通过 omp skill 从 registry 安装的技能；~/.agents/skills 下的技能由其他工具管理，不受影响。</p>
      <h3 className="manage-sub">已安装技能</h3>
      {data.skills.length === 0 ? (
        <div className="pane-note">暂无技能</div>
      ) : (
        <table className="manage-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">描述</th>
              <th scope="col">来源</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {data.skills.map((s) => (
              <tr key={s.filePath}>
                <td className="mono">{s.name}</td>
                <td className="manage-desc" title={s.description}>
                  {s.description}
                </td>
                <td>
                  <Badge tone={s.source === "registry" ? "accent" : "grey"}>
                    {s.source}
                  </Badge>
                </td>
                <td>
                  {s.hide ? (
                    <Badge tone="grey">隐藏</Badge>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
