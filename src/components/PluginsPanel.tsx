/**
 * 插件面板（仅 user scope）：已安装插件、npm 只读列表、marketplace 管理。
 * 所有变更操作走 useOmpOp 单操作模型；忙时全部变更按钮禁用。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  addOmpMarketplace,
  discoverOmpPlugins,
  installOmpPlugin,
  listOmpPlugins,
  normalizeError,
  removeOmpMarketplace,
  setOmpPluginEnabled,
  uninstallOmpPlugin,
  updateOmpMarketplaces,
  upgradeOmpPlugins,
} from "../api";
import { errorText, formatFullTime, formatRelativeTime } from "../format";
import type {
  AppError,
  DiscoverEntry,
  PluginSummary,
  PluginsListResult,
  PluginUpgradeChange,
} from "../types";
import { Badge, Disclosure, Modal } from "./ui";
import { useAlive, type OmpOpController, type ToastFn } from "./useOmpOp";

interface PluginsPanelProps {
  op: OmpOpController;
  onToast: ToastFn;
  /** 全部更新完成后递增，触发列表重载。 */
  refreshToken: number;
}

interface BrowseState {
  name: string;
  entries: DiscoverEntry[];
  loading: boolean;
  error: string | null;
}

interface UpgradeSummary {
  scope: string;
  changes: PluginUpgradeChange[];
  output: string;
}

/** 单条升级变化的展示行：`hello-plugin@probe-mkt 1.0.0 → 1.1.0`（from 缺失时只显示去向）。 */
export function formatUpgradeChange(change: PluginUpgradeChange): string {
  return change.from === null
    ? `${change.id} → ${change.to}`
    : `${change.id} ${change.from} → ${change.to}`;
}

/** changes 为空且输出声明已是最新时，才能报「已是最新」，绝不编造版本变化。 */
export function upgradeIsUpToDate(
  changes: PluginUpgradeChange[],
  output: string,
): boolean {
  return changes.length === 0 && /up to date/i.test(output);
}

export function PluginsPanel({ op, onToast, refreshToken }: PluginsPanelProps) {
  const alive = useAlive();
  const [data, setData] = useState<PluginsListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<AppError | null>(null);
  const [ompMissing, setOmpMissing] = useState(false);
  const [browse, setBrowse] = useState<BrowseState | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<PluginSummary | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [upgradeSummary, setUpgradeSummary] = useState<UpgradeSummary | null>(null);
  const busy = op.running !== null;
  // 浏览请求单调序号：只采纳最新一次的响应，丢弃乱序到达的陈旧结果。
  const browseRequestId = useRef(0);

  const load = useCallback(async () => {
    if (alive.current) {
      setLoading(true);
      setListError(null);
      setOmpMissing(false);
    }
    try {
      const res = await listOmpPlugins();
      if (!alive.current) return;
      setData(res);
      // 浏览中的 marketplace 若已不存在，清空浏览面板，避免展示陈旧条目。
      setBrowse((prev) =>
        prev !== null && !res.marketplaces.some((m) => m.name === prev.name) ? null : prev,
      );
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

  /** 通用变更：走单操作模型，成功 toast + 重载列表，失败 toast；返回是否成功。 */
  async function mutate<T>(
    label: string,
    successText: string,
    task: (onLine: (line: string) => void) => Promise<T>,
  ): Promise<boolean> {
    const outcome = await op.run(label, task);
    if (!alive.current) return outcome.ok;
    if (outcome.ok) {
      onToast(successText, "info");
      await load();
    } else {
      onToast(errorText(outcome.error), "error");
    }
    return outcome.ok;
  }

  function toggleEnabled(p: PluginSummary) {
    const label = p.enabled ? `禁用 ${p.id}` : `启用 ${p.id}`;
    const done = p.enabled ? `已禁用 ${p.id}` : `已启用 ${p.id}`;
    void mutate(label, done, (onLine) => setOmpPluginEnabled(p.id, !p.enabled, onLine));
  }

  async function upgrade(id: string | null) {
    const scope = id ?? "全部插件";
    const outcome = await op.run(id === null ? "升级全部插件" : `升级 ${id}`, (onLine) =>
      upgradeOmpPlugins(id, onLine),
    );
    if (!alive.current) return;
    if (!outcome.ok) {
      onToast(errorText(outcome.error), "error");
      return;
    }
    const { changes, output } = outcome.value;
    setUpgradeSummary({ scope, changes, output });
    if (changes.length > 0) {
      onToast(
        scope === "全部插件"
          ? `已升级 ${changes.length} 个插件`
          : `已升级 ${changes.map(formatUpgradeChange).join("；")}`,
        "info",
      );
    } else if (upgradeIsUpToDate(changes, output)) {
      onToast(scope === "全部插件" ? "全部已是最新" : `已是最新：${id}`, "info");
    } else {
      onToast("升级完成，原始输出见下方", "info");
    }
    await load();
  }

  function confirmUninstall(p: PluginSummary) {
    setUninstallTarget(null);
    void mutate(`卸载 ${p.id}`, `已卸载 ${p.id}`, (onLine) =>
      uninstallOmpPlugin(p.id, onLine),
    );
  }

  function confirmRemoveMarketplace(name: string) {
    setRemoveTarget(null);
    void mutate(`移除 marketplace ${name}`, `已移除 ${name}`, (onLine) =>
      removeOmpMarketplace(name, onLine),
    );
  }

  function install(entry: DiscoverEntry, marketplace: string) {
    const id = `${entry.name}@${marketplace}`;
    void mutate(`安装 ${id}`, `已安装 ${id}`, (onLine) => installOmpPlugin(id, onLine));
  }

  async function addMarketplace(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    const submitted = source;
    const outcome = await op.run("添加 marketplace", (onLine) =>
      addOmpMarketplace(submitted, onLine),
    );
    if (!alive.current) return;
    if (outcome.ok) {
      setSource("");
      onToast(`已添加 marketplace：${submitted}`, "info");
      await load();
    } else if (outcome.error.code === "INVALID_INPUT") {
      // 输入校验以后端为准，原文内联展示，不做自己的预校验。
      setAddError(outcome.error.message);
    } else {
      onToast(errorText(outcome.error), "error");
    }
  }

  async function browseMarketplace(name: string) {
    browseRequestId.current += 1;
    const requestId = browseRequestId.current;
    setBrowse({ name, entries: [], loading: true, error: null });
    try {
      const entries = await discoverOmpPlugins(name);
      if (!alive.current) return;
      if (browseRequestId.current !== requestId) return;
      setBrowse({ name, entries, loading: false, error: null });
    } catch (e: unknown) {
      if (!alive.current) return;
      if (browseRequestId.current !== requestId) return;
      setBrowse({
        name,
        entries: [],
        loading: false,
        error: errorText(normalizeError(e)),
      });
    }
  }

  if (data === null) {
    if (ompMissing)
      return <div className="pane-note">未找到 omp，请先安装 omp 后再管理插件。</div>;
    if (listError !== null)
      return (
        <div className="banner banner-error" role="alert">
          <span>{errorText(listError)}</span>
          <button type="button" className="btn btn-small" onClick={() => void load()}>
            重试
          </button>
        </div>
      );
    return <div className="pane-note">正在加载插件…</div>;
  }

  return (
    <div className="manage-section">
      {loading ? <div className="pane-note">正在加载插件…</div> : null}
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
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void mutate("刷新 marketplace 目录", "marketplace 目录已刷新", (onLine) =>
              updateOmpMarketplaces(null, onLine),
            )
          }
        >
          刷新 marketplace 目录
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void upgrade(null)}
        >
          升级全部插件
        </button>
      </div>
      {upgradeSummary !== null ? (
        <div className="manage-result">
          <div>升级结果（{upgradeSummary.scope}）：</div>
          {upgradeSummary.changes.length > 0 ? (
            <ul className="manage-list mono">
              {upgradeSummary.changes.map((c) => (
                <li key={c.id}>{formatUpgradeChange(c)}</li>
              ))}
            </ul>
          ) : upgradeIsUpToDate(upgradeSummary.changes, upgradeSummary.output) ? (
            <div>{upgradeSummary.scope === "全部插件" ? "全部已是最新" : "已是最新"}</div>
          ) : (
            <div className="muted">升级完成，原始输出见下方</div>
          )}
          <Disclosure label="查看原始输出">
            <pre className="plain-text mono">{upgradeSummary.output}</pre>
          </Disclosure>
        </div>
      ) : null}
      <h3 className="manage-sub">已安装插件</h3>
      {data.plugins.length === 0 ? (
        <div className="pane-note">尚未安装插件</div>
      ) : (
        <table className="manage-table">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">来源</th>
              <th scope="col">版本</th>
              <th scope="col">状态</th>
              <th scope="col">时间</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {data.plugins.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.name}</td>
                <td className="mono muted">{p.marketplace}</td>
                <td className="mono">{p.version ?? "—"}</td>
                <td>
                  {p.enabled ? (
                    <Badge tone="accent">启用</Badge>
                  ) : (
                    <Badge tone="grey">已禁用</Badge>
                  )}
                </td>
                <td className="muted">
                  <span title={p.installedAt === null ? undefined : formatFullTime(p.installedAt)}>
                    安装 {p.installedAt === null ? "—" : formatRelativeTime(p.installedAt)}
                  </span>{" "}
                  <span title={p.lastUpdated === null ? undefined : formatFullTime(p.lastUpdated)}>
                    更新 {p.lastUpdated === null ? "—" : formatRelativeTime(p.lastUpdated)}
                  </span>
                </td>
                <td>
                  <div className="manage-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      aria-label={`${p.enabled ? "禁用" : "启用"} ${p.id}`}
                      onClick={() => toggleEnabled(p)}
                    >
                      {p.enabled ? "禁用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      aria-label={`升级 ${p.id}`}
                      onClick={() => void upgrade(p.id)}
                    >
                      升级
                    </button>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy}
                      aria-label={`卸载 ${p.id}`}
                      onClick={() => setUninstallTarget(p)}
                    >
                      卸载
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3 className="manage-sub">npm 插件（只读）</h3>
      {data.npm.length === 0 ? (
        <div className="pane-note">暂无 npm 插件</div>
      ) : (
        <ul className="manage-list">
          {data.npm.map((n) => (
            <li key={n.name}>
              <span className="mono">{n.name}</span>{" "}
              <span className="mono muted">{n.version ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="manage-sub">Marketplace</h3>
      {data.marketplaces.length === 0 ? (
        <div className="pane-note">尚未配置 marketplace</div>
      ) : (
        <ul className="manage-list">
          {data.marketplaces.map((m) => (
            <li key={m.name} className="manage-mkt">
              <span className="mono">{m.name}</span>{" "}
              <span className="mono muted">{m.source}</span>
              <div className="manage-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`浏览 ${m.name}`}
                  onClick={() => void browseMarketplace(m.name)}
                >
                  浏览
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  aria-label={`刷新 ${m.name}`}
                  onClick={() =>
                    void mutate(`刷新 marketplace ${m.name}`, `已刷新 ${m.name}`, (onLine) =>
                      updateOmpMarketplaces(m.name, onLine),
                    )
                  }
                >
                  刷新
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  aria-label={`移除 ${m.name}`}
                  onClick={() => setRemoveTarget(m.name)}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {browse !== null ? (
        <div className="manage-browse">
          <div className="manage-browse-head">
            <span>
              浏览 <span className="mono">{browse.name}</span>
            </span>
            <button type="button" className="btn btn-small" onClick={() => setBrowse(null)}>
              关闭
            </button>
          </div>
          {browse.loading ? (
            <div className="pane-note">正在加载…</div>
          ) : browse.error !== null ? (
            <div className="banner banner-error" role="alert">
              <span>{browse.error}</span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => void browseMarketplace(browse.name)}
              >
                重试
              </button>
            </div>
          ) : browse.entries.length === 0 ? (
            <div className="pane-note">该 marketplace 没有可安装的插件</div>
          ) : (
            <ul className="manage-list">
              {browse.entries.map((e) => {
                const id = `${e.name}@${browse.name}`;
                const installed = data.plugins.some((p) => p.id === id);
                return (
                  <li key={e.name} className="manage-mkt">
                    <span className="mono">{e.name}</span>{" "}
                    <span className="mono muted">{e.version}</span>{" "}
                    <span className="muted">{e.description}</span>
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={busy || installed}
                      aria-label={installed ? `已安装 ${id}` : `安装 ${id}`}
                      onClick={() => install(e, browse.name)}
                    >
                      {installed ? "已安装" : "安装"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      <h3 className="manage-sub">添加 Marketplace</h3>
      <form className="manage-form" onSubmit={(e) => void addMarketplace(e)}>
        <input
          className="filter-input"
          aria-label="marketplace 来源"
          placeholder="owner/repo、URL 或本地路径"
          value={source}
          disabled={busy}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setSource(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy}>
          添加
        </button>
      </form>
      {addError !== null ? (
        <div className="banner banner-error" role="alert">
          {addError}
        </div>
      ) : null}
      {uninstallTarget !== null ? (
        <Modal
          title={`卸载插件 ${uninstallTarget.id}？`}
          onClose={() => {
            if (!busy) setUninstallTarget(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                data-autofocus
                disabled={busy}
                onClick={() => setUninstallTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => confirmUninstall(uninstallTarget)}
              >
                卸载
              </button>
            </>
          }
        >
          <p>将卸载 {uninstallTarget.id}，之后可重新安装。</p>
        </Modal>
      ) : null}
      {removeTarget !== null ? (
        <Modal
          title={`移除 marketplace ${removeTarget}？`}
          onClose={() => {
            if (!busy) setRemoveTarget(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn"
                data-autofocus
                disabled={busy}
                onClick={() => setRemoveTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => confirmRemoveMarketplace(removeTarget)}
              >
                移除
              </button>
            </>
          }
        >
          <p>将移除 marketplace {removeTarget}。</p>
        </Modal>
      ) : null}
    </div>
  );
}
