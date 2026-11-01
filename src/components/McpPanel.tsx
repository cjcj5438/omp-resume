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
  handshakeMcpServer,
  listMcp,
  normalizeError,
  revealFile,
  saveMcpServer,
  setMcpEnabled,
} from "../api";
import { displayCwd, errorText, formatRelativeTime } from "../format";
import type { McpFileInfo, McpHandshakeResult, McpListResult, McpScope, McpServer } from "../types";
import { Badge, Modal } from "./ui";
import { PageHeader, Panel, Seg } from "./page";

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
  const [scope, setScope] = useState<McpScope>("user");
  const [projectCwd, setProjectCwd] = useState<string | null>(null);
  const [data, setData] = useState<McpListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 同步忙守卫：按钮 disabled 是 state 派生，同一帧内的第二次点击需同步拦截。
  const busyRef = useRef(false);
  const [changedOnce, setChangedOnce] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [deleting, setDeleting] = useState<{ scope: McpScope; name: string } | null>(null);
  const [handshakes, setHandshakes] = useState<Record<string, McpHandshakeResult>>({});
  const [handshaking, setHandshaking] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    // StrictMode 双挂载会先跑一次清理；不复位会导致首次加载被跳过、永远停在加载中。
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const selectedScope: McpScope = scope;
  const effectiveCwd = scope === "project" ? (projectCwd ?? projects[0]?.cwd ?? null) : null;

  // 项目列表变化后 previously 选中的 cwd 消失则回到用户级。
  useEffect(() => {
    if (scope === "project" && effectiveCwd !== null && !projects.some((p) => p.cwd === effectiveCwd)) {
      setProjectCwd(null);
      setScope("user");
    }
  }, [projects, scope, effectiveCwd]);

  const load = useCallback(async (): Promise<{ data: McpListResult | null; error: string | null }> => {
    if (!alive.current) return { data: null, error: null };
    setLoading(true);
    setLoadError(null);
    try {
      const result = await listMcp(effectiveCwd === null ? {} : { project: effectiveCwd });
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
  }, [effectiveCwd]);

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

  /** 握手测试：只在用户点击时执行；结果进内存态（工具数来自最近一次握手）。 */
  async function handshake(s: McpServer) {
    const key = `${s.scope}:${s.name}`;
    if (handshaking !== null || busyRef.current) return;
    setHandshaking(key);
    try {
      const res = await handshakeMcpServer({ scope: s.scope, project: effectiveCwd, name: s.name });
      if (!alive.current) return;
      setHandshakes((prev) => ({ ...prev, [key]: res }));
      if (res.ok) {
        onToast(res.tools === null ? `${s.name} 握手成功` : `${s.name} 握手成功 · ${res.tools} 个工具`, "info");
      } else {
        onToast(`${s.name} 握手失败：${res.error ?? "未知错误"}`, "error");
      }
    } catch (e) {
      if (!alive.current) return;
      onToast(errorText(normalizeError(e)), "error");
    } finally {
      if (alive.current) setHandshaking(null);
    }
  }

  async function toggle(s: McpServer) {
    if (s.shadowedBy === "disabledServers") return;
    const file = fileFor(s.scope);
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await setMcpEnabled({
        scope: s.scope,
        project: effectiveCwd,
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
      const raw = await getMcpServer({ scope: s.scope, project: effectiveCwd, name: s.name });
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

  async function revealConfig() {
    if (targetFile === undefined || busyRef.current) return;
    try {
      await revealFile(targetFile.path);
    } catch (e) {
      if (!alive.current) return;
      onToast(errorText(normalizeError(e)), "error");
    }
  }

  async function submitEdit() {
    if (!editing || busyRef.current) return;
    // 作用域在对话框内可切换：revision 取对话框 scope 对应文件的 revision。
    const scopeFile = fileFor(editing.scope);
    if (editing.mode === "add" && scopeFile !== undefined && scopeFile.revision !== editing.expectedRevision) {
      setEditing({ ...editing, expectedRevision: scopeFile.revision });
    }
    let config: unknown;
    try {
      config = JSON.parse(editing.text) as unknown;
    } catch (e) {
      setEditing({ ...editing, error: `JSON 格式不正确：${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    // 手工把 type 留空串也按自动推断处理：删字段而非发 ""（后端拒空串）。
    if (typeof config === "object" && config !== null && (config as Record<string, unknown>).type === "") {
      delete (config as Record<string, unknown>).type;
    }
    const renamed = editing.mode === "edit" && editing.originalName !== null && editing.name !== editing.originalName;
    const savedName = editing.name;
    const savedScope = editing.scope;
    busyRef.current = true;
    setBusy(true);
    try {
      await saveMcpServer({
        scope: editing.scope,
        project: effectiveCwd,
        name: editing.name,
        config,
        expectedRevision: editing.expectedRevision,
        originalName: renamed && editing.originalName !== null ? editing.originalName : null,
      });
      if (!alive.current) return;
      onToast(editing.mode === "add" ? `已添加 MCP 服务器 · ${savedName}` : "MCP 配置已保存 · revision 已校验", "info");
      setChangedOnce(true);
      setSavedNote(true);
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
        project: effectiveCwd,
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
      <PageHeader
        kicker="环境配置 · MCP"
        title="MCP 服务器"
        sub="用户级与项目级两套作用域。写入前校验字段白名单，并携带 revision 以避免并发覆盖。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" disabled={busy || loading} onClick={() => void revealConfig()}>
              打开配置文件
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || loading || targetBlocked} onClick={openAdd}>
              添加服务器
            </button>
          </>
        }
      />
      <div className="mcp-toolbar">
        <Seg
          label="配置范围"
          value={scope}
          disabled={busy}
          onChange={(v) => setScope(v)}
          options={[
            { value: "user", label: "用户级" },
            { value: "project", label: "项目级" },
          ]}
        />
        {scope === "project" ? (
          <label className="mcp-scope">
            项目
            <select
              aria-label="项目"
              value={effectiveCwd ?? ""}
              disabled={busy || projects.length === 0}
              onChange={(e) => setProjectCwd(e.target.value === "" ? null : e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.cwd} value={p.cwd}>
                  {p.name} — {p.cwd}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="spacer" />
        {targetFile !== undefined ? (
          <span className="meta" title={targetFile.revision}>
            rev {targetFile.revision === "absent" || targetFile.revision === "unreadable" ? targetFile.revision : targetFile.revision.slice(0, 12)}
            {targetFile.modifiedAt === null ? null : ` · ${formatRelativeTime(targetFile.modifiedAt)}`}
          </span>
        ) : null}
      </div>
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
        <Panel
          title="服务器"
          body="flush"
          foot={<><span>{rows.length} 个服务器 · 工具数来自最近一次握手</span><span className="mono">{savedNote ? "revision 已校验" : targetFile === undefined ? "—" : targetFile.revision.slice(0, 12)}</span></>}
        >
          {targetFile !== undefined && !targetFile.exists ? (
            <div className="pane-note">该范围还没有 MCP 配置文件，新增第一条服务器即可创建。</div>
          ) : rows.length === 0 ? (
            <div className="pane-note">该范围还没有服务器。</div>
          ) : (
            <div className="tbl-wrap">
            <table className="tbl mcp-table">
              <thead>
                <tr>
                  <th scope="col">服务器</th>
                  <th scope="col">传输</th>
                  <th scope="col">命令 · 地址</th>
                  <th scope="col" className="r">工具</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="r">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const key = `${s.scope}:${s.name}`;
                  const hs = handshakes[key];
                  // mcp-P1-5：argv 可能含 token，后端只给首词 + 计数；此处渲染首词 + 参数计数，
                  // 完整命令见编辑框（避免泄露凭据）。
                  const endpoint = s.command !== null ? s.command : (s.url ?? "—");
                  const argsHint = s.command !== null && s.argCount > 0 ? ` · ${s.argCount} 个参数` : "";
                  const sub = s.scope === "user" ? "~/.omp/agent/mcp.json" : `${displayCwd(effectiveCwd ?? "")}/.omp/mcp.json`;
                  return (
                    <tr key={key} data-testid={`mcp-row-${s.scope}-${s.name}`}>
                      <td>
                        <span className="strong">{s.name}</span>
                        <span className="sub mono" title={targetFile?.path}>{sub}</span>
                      </td>
                      <td>
                        <Badge tone="quiet">{s.transport}</Badge>
                      </td>
                      <td className="mono mcp-cmd" title={s.command !== null ? `${endpoint}${argsHint}（完整命令见编辑框）` : endpoint}>{endpoint}{argsHint === "" ? null : <span className="muted">{argsHint}</span>}</td>
                      <td className="r mono">{hs === undefined ? <span className="muted">—</span> : hs.ok ? (hs.tools ?? "—") : <span className="muted">—</span>}</td>
                      <td>
                        <Badge tone={s.effective ? "ok" : s.shadowedBy === "disabledServers" ? "danger" : "grey"}>
                          {s.effective ? <span className="dot ok" aria-hidden="true" /> : null}
                          {statusText(s)}
                        </Badge>
                      </td>
                      <td className="r cell-actions">
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
                          disabled={busy || targetBlocked || handshaking !== null}
                          aria-busy={handshaking === key}
                          onClick={() => void handshake(s)}
                        >
                          {handshaking === key ? "测试中…" : "测试"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet"
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
                          className="btn btn-small btn-quiet"
                          aria-label={`编辑 ${s.name}`}
                          disabled={busy || targetBlocked}
                          onClick={() => void openEdit(s)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-small btn-quiet btn-danger-ghost"
                          aria-label={`删除 ${s.name}`}
                          disabled={busy || targetBlocked}
                          onClick={() => setDeleting({ scope: s.scope, name: s.name })}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {shadowedPeers.map((s) => (
                  <tr key={`peer:${s.name}`} className="mcp-shadowed" data-testid={`mcp-row-user-${s.name}`}>
                    <td>
                      <span className="strong muted">{s.name}</span>
                      <span className="sub mono">~/.omp/agent/mcp.json</span>
                    </td>
                    <td><Badge tone="quiet">{s.transport}</Badge></td>
                    <td className="mono mcp-cmd muted">{s.command ?? s.url ?? "—"}</td>
                    <td className="r mono muted">—</td>
                    <td><Badge tone="grey">被覆盖</Badge></td>
                    <td className="r muted">只读</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Panel>
      )}
      <div className="inline-note">同时被其他进程修改时，保存会以冲突返回而不是覆盖；先刷新再保存。</div>
      {changedOnce && (
        <div className="pane-note">已运行的 omp 会话需执行 /mcp reload 或重启后才会读取修改。</div>
      )}
      {editing !== null && (
        <Modal
          title={editing.mode === "add" ? "添加 MCP 服务器" : "编辑 MCP 服务器"}
          sub="写入前会做字段白名单校验，并携带 revision。"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submitEdit()}>
                {editing.mode === "add" ? "添加" : "保存"}
              </button>
            </>
          }
        >
          {editing.notEffective !== null && (
            <p className="muted">该条目当前不会生效：{editing.notEffective}</p>
          )}
          {editing.conflict && <div className="banner banner-error">{CONFLICT_TEXT}</div>}
          {editing.error !== null && <div className="banner banner-error">{editing.error}</div>}
          <div className="fld">
            <label htmlFor="mcp-edit-name">服务器名称</label>
            <input
              id="mcp-edit-name"
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
          </div>
          <div className="fld-2">
            <div className="fld">
              <label htmlFor="mcp-edit-scope">作用域</label>
              <select
                id="mcp-edit-scope"
                aria-label="作用域"
                disabled={busy}
                value={editing.scope}
                onChange={(e) => setEditing({ ...editing, scope: e.target.value as McpScope })}
              >
                <option value="user">用户级</option>
                <option value="project">项目级</option>
              </select>
            </div>
            <div className="fld">
              <label htmlFor="mcp-edit-transport">传输</label>
              <select
                id="mcp-edit-transport"
                aria-label="传输"
                disabled={busy}
                value={(() => { try { const v = JSON.parse(editing.text) as { type?: unknown }; return typeof v.type === "string" ? v.type : ""; } catch { return ""; } })()}
                onChange={(e) => {
                  try {
                    const v = JSON.parse(editing.text) as Record<string, unknown>;
                    // 自动推断 = 缺省 type（后端无 type 即按 command/url 推断；空串会被拒）。
                    if (e.target.value === "") delete v.type;
                    else v.type = e.target.value;
                    setEditing({ ...editing, text: JSON.stringify(v, null, 2) });
                  } catch {
                    // JSON 非法时不改写，等用户修好（保存时有 parse 报错）。
                  }
                }}
              >
                <option value="">自动推断</option>
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="mcp-edit-json">配置 JSON</label>
            <textarea
              id="mcp-edit-json"
              aria-label="服务器配置 JSON"
              className="mono mcp-textarea"
              disabled={busy}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            />
          </div>
          <p className="muted">env / headers 中的值会原样写入配置文件</p>
          <div className="inline-note">保存后会立即尝试握手；握手失败不破坏已保存的配置。</div>
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
