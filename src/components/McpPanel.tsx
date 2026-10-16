/**
 * MCP 原生配置管理面板：用户级 / 项目级 mcp.json 的服务器列表与编辑。
 * 由 ManageView 按标签页挂载；props 签名固定（shell 直接导入）。
 * 语义见 docs/CONTRACT.md §4.30–§4.35：列表只含 secret 键名，编辑框才取真实值。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import "./McpPanel.css";
import {
  deleteMcpServer,
  getMcpServer,
  listMcp,
  normalizeError,
  saveMcpServer,
  setMcpEnabled,
} from "../api";
import { errorText } from "../format";
import type { McpFileInfo, McpListResult, McpScope, McpServer } from "../types";
import { Badge, Modal } from "./ui";

const ADD_TEMPLATE = `{
  "type": "stdio",
  "command": "",
  "args": []
}`;

const CONFLICT_TEXT =
  "配置文件已被外部修改（例如在 omp 会话里执行了 /mcp add）。列表已刷新，但编辑框仍是你的版本；再次点击保存将以你的内容覆盖该条目（其他条目保持外部修改后的内容）。";
const UNREADABLE_TEXT = "配置文件无法读取（请先手动修复读取权限并刷新）";
const DISABLED_SERVERS_HINT =
  "该名称在 disabledServers 中被禁用；本应用不修改 disabledServers，请手动编辑 mcp.json 后刷新";

function statusText(s: McpServer): string {
  if (s.effective) return "生效";
  if (s.shadowedBy === "project") return "未生效：被项目级覆盖";
  if (s.shadowedBy === "disabledServers") return "未生效：被 disabledServers 禁用";
  if (s.shadowedBy === "disabled") return "未生效：已禁用";
  return "未生效";
}

function blocked(file: McpFileInfo | undefined): boolean {
  return !!file && (file.readError !== null || file.revision === "unreadable");
}

interface EditState {
  mode: "add" | "edit";
  scope: McpScope;
  name: string;
  originalName: string | null;
  text: string;
  expectedRevision: string;
  error: string | null;
  conflict: boolean;
  notEffective: string | null;
}

export function McpPanel(props: {
  projects: { cwd: string; name: string }[];
  onToast: (text: string, kind: "info" | "error") => void;
}): JSX.Element {
  const { projects, onToast } = props;
  const [scopeKey, setScopeKey] = useState("user");
  const [data, setData] = useState<McpListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 同步忙守卫：按钮 disabled 是 state 派生，同一帧内的第二次点击需同步拦截。
  const busyRef = useRef(false);
  const [changedOnce, setChangedOnce] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [deleting, setDeleting] = useState<{ scope: McpScope; name: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const projectCwd = scopeKey === "user" ? null : scopeKey;
  const selectedScope: McpScope = projectCwd === null ? "user" : "project";

  // 项目列表变化后 previously 选中的 cwd 消失则回到用户级。
  useEffect(() => {
    if (projectCwd !== null && !projects.some((p) => p.cwd === projectCwd)) setScopeKey("user");
  }, [projects, projectCwd]);

  const load = useCallback(async (): Promise<{ data: McpListResult | null; error: string | null }> => {
    if (!alive.current) return { data: null, error: null };
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listMcp(projectCwd === null ? {} : { project: projectCwd });
      if (!alive.current) return { data: null, error: null };
      setData(result);
      return { data: result, error: null };
    } catch (e) {
      if (!alive.current) return { data: null, error: null };
      const text = errorText(normalizeError(e));
      setData(null);
      setLoadError(text);
      return { data: null, error: text };
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectCwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const fileFor = (scope: McpScope): McpFileInfo | undefined =>
    data?.files.find((f) => f.scope === scope);
  const targetFile = fileFor(selectedScope);
  const targetBlocked = blocked(targetFile);
  const rows = data?.servers.filter((s) => s.scope === selectedScope) ?? [];
  // 项目选中时，附带展示被覆盖的用户级同名条目（只读，状态 chip 即提示）。
  const shadowedPeers =
    selectedScope === "project" && data !== null
      ? data.servers.filter(
          (s) =>
            s.scope === "user" &&
            data.servers.some((p) => p.scope === "project" && p.name === s.name),
        )
      : [];

  async function toggle(s: McpServer) {
    if (s.shadowedBy === "disabledServers") return;
    const file = fileFor(s.scope);
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await setMcpEnabled({
        scope: s.scope,
        project: projectCwd,
        name: s.name,
        enabled: !s.enabled,
        expectedRevision: file.revision,
      });
      if (!alive.current) return;
      onToast(s.enabled ? `已禁用 ${s.name}` : `已启用 ${s.name}`, "info");
      setChangedOnce(true);
      await load();
    } catch (e) {
      if (!alive.current) return;
      onToast(errorText(normalizeError(e)), "error");
      await load();
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function openEdit(s: McpServer) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const raw = await getMcpServer({ scope: s.scope, project: projectCwd, name: s.name });
      if (!alive.current) return;
      setEditing({
        mode: "edit",
        scope: s.scope,
        name: s.name,
        originalName: s.name,
        text: JSON.stringify(raw.config, null, 2),
        expectedRevision: raw.revision,
        error: null,
        conflict: false,
        notEffective: s.effective ? null : statusText(s),
      });
    } catch (e) {
      if (!alive.current) return;
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function openAdd() {
    if (!targetFile || busyRef.current) return;
    setEditing({
      mode: "add",
      scope: selectedScope,
      name: "",
      originalName: null,
      text: ADD_TEMPLATE,
      expectedRevision: targetFile.revision,
      error: null,
      conflict: false,
      notEffective: null,
    });
  }

  async function submitEdit() {
    if (!editing || busyRef.current) return;
    let config: unknown;
    try {
      config = JSON.parse(editing.text) as unknown;
    } catch (e) {
      setEditing({ ...editing, error: `JSON 格式不正确：${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const renamed = editing.mode === "edit" && editing.originalName !== null && editing.name !== editing.originalName;
    const savedName = editing.name;
    const savedScope = editing.scope;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveMcpServer({
        scope: editing.scope,
        project: projectCwd,
        name: editing.name,
        config,
        expectedRevision: editing.expectedRevision,
        originalName: renamed && editing.originalName !== null ? editing.originalName : null,
      });
      if (!alive.current) return;
      onToast(`已保存 ${savedName}`, "info");
      setChangedOnce(true);
      setEditing(null);
      await load();
    } catch (e) {
      if (!alive.current) return;
      const err = normalizeError(e);
      if (err.code === "CONFLICT") {
        // 用户输入予以保留：刷新列表但不碰输入框；同时把对话框的 revision
        // 换成刚取回的新值，使核对后的第二次保存成为显式确认。
        // 函数式更新：对话框已被成功保存关闭时（prev 为 null），陈旧的
        // CONFLICT 绝不重新打开它。
        const reloaded = await load();
        if (!alive.current) return;
        const fresh = reloaded.data;
        if (fresh === null) {
          const text = reloaded.error ?? "加载失败，请关闭后重试";
          setEditing((prev) => (prev === null ? null : { ...prev, conflict: true, error: text }));
        } else {
          const file = fresh.files.find((f) => f.scope === savedScope);
          if (file === undefined) {
            setEditing((prev) =>
              prev === null ? null : { ...prev, conflict: true, error: "未找到对应范围的配置文件，请关闭后重试" },
            );
          } else if (file.readError !== null) {
            setEditing((prev) => (prev === null ? null : { ...prev, conflict: true, error: file.readError }));
          } else if (file.revision === "unreadable") {
            setEditing((prev) => (prev === null ? null : { ...prev, conflict: true, error: UNREADABLE_TEXT }));
          } else {
            const revision = file.revision;
            setEditing((prev) =>
              prev === null ? null : { ...prev, conflict: true, error: null, expectedRevision: revision },
            );
          }
        }
      } else if (err.code === "INVALID_INPUT") {
        const message = err.message;
        setEditing((prev) => (prev === null ? null : { ...prev, error: message }));
      } else {
        onToast(errorText(err), "error");
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleting || busyRef.current) return;
    const file = fileFor(deleting.scope);
    if (!file) {
      setDeleting(null);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await deleteMcpServer({
        scope: deleting.scope,
        project: projectCwd,
        name: deleting.name,
        expectedRevision: file.revision,
      });
      if (!alive.current) return;
      onToast(`已删除 ${deleting.name}`, "info");
      setChangedOnce(true);
      setDeleting(null);
      await load();
    } catch (e) {
      if (!alive.current) return;
      onToast(errorText(normalizeError(e)), "error");
      setDeleting(null);
      await load();
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="mcp-panel">
      <div className="mcp-toolbar">
        <label className="mcp-scope">
          配置范围
          <select
            aria-label="配置范围"
            value={scopeKey}
            disabled={busy}
            onChange={(e) => setScopeKey(e.target.value)}
          >
            <option value="user">用户级 (~/.omp/agent/mcp.json)</option>
            {projects.map((p) => (
              <option key={p.cwd} value={p.cwd}>
                {p.name} — {p.cwd}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-small" disabled={busy || loading || targetBlocked} onClick={openAdd}>
          新增
        </button>
      </div>
      {targetFile !== undefined && <div className="muted mono mcp-path">{targetFile.path}</div>}
      {loadError !== null && (
        <div className="banner banner-error">
          <span>{loadError}</span>
          <button type="button" className="btn btn-small" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {targetFile?.readError !== null && targetFile?.readError !== undefined && (
        <div className="banner banner-error">{targetFile.readError}（请先手动修复该 JSON 文件）</div>
      )}
      {targetFile !== undefined && targetFile.readError === null && targetFile.revision === "unreadable" && (
        <div className="banner banner-error">{UNREADABLE_TEXT}</div>
      )}
      {loading && data === null ? (
        <div className="muted">加载中…</div>
      ) : (
        <div className="mcp-list">
          {targetFile !== undefined && !targetFile.exists && (
            <div className="muted">该范围还没有 MCP 配置文件，新增第一条服务器即可创建。</div>
          )}
          {rows.map((s) => (
            <div key={`${s.scope}:${s.name}`} className="mcp-row" data-testid={`mcp-row-${s.scope}-${s.name}`}>
              <div className="mcp-row-head">
                <span className="mono mcp-name">{s.name}</span>
                <Badge tone={s.transport === "unknown" ? "danger" : "grey"}>{s.transport}</Badge>
                <Badge
                  tone={s.effective ? "accent" : s.shadowedBy === "disabledServers" ? "danger" : "grey"}
                >
                  {statusText(s)}
                </Badge>
                {s.hasAuth && <Badge tone="grey">OAuth/auth</Badge>}
              </div>
              <div className="muted mono mcp-endpoint">
                {s.command !== null ? (
                  <>
                    {s.command}
                    {s.argCount > 0 && <span> · {s.argCount} 个参数</span>}
                  </>
                ) : (
                  (s.url ?? "—")
                )}
              </div>
              {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                <div className="mcp-keys">
                  {s.envKeys.map((k) => (
                    <span key={`env:${k}`} className="mcp-key-chip mono" title="环境变量名（值不会展示）">
                      env:{k}
                    </span>
                  ))}
                  {s.headerKeys.map((k) => (
                    <span key={`header:${k}`} className="mcp-key-chip mono" title="请求头名（值不会展示）">
                      header:{k}
                    </span>
                  ))}
                </div>
              )}
              <div className="mcp-actions">
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`${s.enabled ? "禁用" : "启用"} ${s.name}`}
                  title={
                    s.shadowedBy === "disabledServers"
                      ? DISABLED_SERVERS_HINT
                      : s.effective
                        ? undefined
                        : `该条目当前不会生效：${statusText(s)}`
                  }
                  disabled={busy || targetBlocked || s.shadowedBy === "disabledServers"}
                  onClick={() => void toggle(s)}
                >
                  {s.enabled ? "禁用" : "启用"}
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  aria-label={`编辑 ${s.name}`}
                  disabled={busy || targetBlocked}
                  onClick={() => void openEdit(s)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  aria-label={`删除 ${s.name}`}
                  disabled={busy || targetBlocked}
                  onClick={() => setDeleting({ scope: s.scope, name: s.name })}
                >
                  删除
                </button>
              </div>
              {s.shadowedBy === "disabledServers" ? (
                <div className="muted mcp-hint">{DISABLED_SERVERS_HINT}</div>
              ) : null}
            </div>
          ))}
          {shadowedPeers.length > 0 && (
            <div className="mcp-secondary">
              <div className="muted">用户级同名条目（已被项目级覆盖，只读；切换到用户级范围可管理）</div>
              {shadowedPeers.map((s) => (
                <div key={`peer:${s.name}`} className="mcp-row mcp-row-peer" data-testid={`mcp-row-user-${s.name}`}>
                  <span className="mono mcp-name">{s.name}</span>
                  <Badge tone={s.shadowedBy === "disabledServers" ? "danger" : "grey"}>{statusText(s)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {changedOnce && (
        <div className="pane-note">已运行的 omp 会话需执行 /mcp reload 或重启后才会读取修改。</div>
      )}
      {editing !== null && (
        <Modal
          title={editing.mode === "add" ? "新增 MCP 服务器" : "编辑 MCP 服务器"}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                取消
              </button>
              <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void submitEdit()}>
                保存
              </button>
            </>
          }
        >
          {editing.notEffective !== null && (
            <p className="muted">该条目当前不会生效：{editing.notEffective}</p>
          )}
          {editing.conflict && <div className="banner banner-error">{CONFLICT_TEXT}</div>}
          {editing.error !== null && <div className="banner banner-error">{editing.error}</div>}
          <label className="mcp-field">
            服务器名称
            <input
              aria-label="服务器名称"
              className="mcp-input"
              data-autofocus
              disabled={busy}
              value={editing.name}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </label>
          <label className="mcp-field">
            配置 JSON
            <textarea
              aria-label="服务器配置 JSON"
              className="mono mcp-textarea"
              disabled={busy}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            />
          </label>
          <p className="muted">env / headers 中的值会原样写入配置文件</p>
        </Modal>
      )}
      {deleting !== null && (
        <Modal
          title="删除 MCP 服务器"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn" data-autofocus onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                删除
              </button>
            </>
          }
        >
          <p>
            确定删除 <span className="mono">{deleting.name}</span>（
            {deleting.scope === "user" ? "用户级" : "项目级"}）吗？只移除该条目，不影响其他配置。
          </p>
        </Modal>
      )}
    </div>
  );
}
