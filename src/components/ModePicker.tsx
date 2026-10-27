/**
 * 侧栏底部的「模型模式」切换器：列出 omp `modelPresets` 里的整套模型配置，
 * 一键切换（角色模型 + agent 模型覆盖 + 默认推理档位），并支持把当前配置
 * 存为新模式、覆盖、删除。
 *
 * 数据来自模块级 store（`../modelPresets`）：与「管理 → 模型」共享同一份
 * omp 配置，任一侧写成功都会让对方重载，避免互相 CONFLICT。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeError } from "../api";
import { errorText } from "../format";
import { presetOps, refreshPresets, usePresets } from "../modelPresets";
import type { ModelPreset } from "../types";
import { popupMenu } from "../nativeMenu";
import type { ToastFn } from "./useOmpOp";
import { Ico, Modal } from "./ui";
import { Check, TriangleAlert } from "lucide-react";
import "./ModePicker.css";

/** 与后端 `validate_preset_name` 完全同规则（`^[a-zA-Z][\w-]*$` + ≤ 64）。 */
const NAME_RULE = /^[a-zA-Z][\w-]*$/;
const NAME_MAX = 64;
const NAME_HINT =
  "模式名需以字母开头，只能包含字母、数字、- 或 _（与 omp /modelpreset 通用）";

function nameError(name: string): string | null {
  if (name.length === 0) return "模式名不能为空";
  if (name.length > NAME_MAX) return `模式名不能超过 ${NAME_MAX} 个字符（当前 ${name.length} 个）`;
  if (!NAME_RULE.test(name)) return NAME_HINT;
  return null;
}

/** selector 末段（`provider/model[:thinking]` → `model`）。 */
function selectorTail(value: string): string {
  const colon = value.lastIndexOf(":");
  const base = colon > 0 && /^[A-Za-z0-9_-]+$/.test(value.slice(colon + 1)) ? value.slice(0, colon) : value;
  const slash = base.lastIndexOf("/");
  return slash >= 0 ? base.slice(slash + 1) : base;
}

function summary(preset: ModelPreset): string {
  const parts: string[] = [];
  const roles = Object.entries(preset.modelRoles);
  const def = roles.find(([role]) => role === "default")?.[1];
  if (typeof def === "string" && def.length > 0) parts.push(`default：${selectorTail(def)}`);
  else if (roles.length > 0) parts.push(`${roles.length} 个角色`);
  else parts.push("无角色模型");
  parts.push(`推理 ${preset.defaultThinkingLevel ?? "继承"}`);
  const overrides = preset.agentModelOverrides;
  if (overrides != null) {
    const n = Object.keys(overrides).length;
    if (n > 0) parts.push(`agent 模型 ${n} 个`);
  }
  return parts.join(" · ");
}

function rolesTitle(preset: ModelPreset): string {
  const lines = Object.entries(preset.modelRoles).map(([role, value]) => `${role} → ${String(value)}`);
  if (preset.agentModelOverrides != null) {
    const agents = Object.entries(preset.agentModelOverrides);
    if (agents.length > 0) {
      lines.push("");
      for (const [agent, value] of agents) lines.push(`${agent} → ${String(value)}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "没有角色模型";
}

type Confirm =
  | { kind: "overwrite"; preset: ModelPreset }
  | { kind: "delete"; preset: ModelPreset }
  | null;

export function ModePicker({ onToast }: { onToast: ToastFn }) {
  const view = usePresets();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 点击外部关闭；Escape 关闭并把焦点还给按钮。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current != null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setCreating(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const state = view.status === "ready" ? view.state : null;
  const busy = view.status === "ready" ? view.busy : false;

  const names = useMemo(
    () => new Set((state?.presets ?? []).map((p) => p.name)),
    [state],
  );
  const draftError = creating ? nameError(draftName) : null;
  const duplicate = creating && draftName.length > 0 && names.has(draftName);

  function failToast(e: unknown) {
    const err = normalizeError(e);
    onToast(errorText(err), "error");
  }

  async function closePreset(preset: ModelPreset) {
    if (state == null) return;
    try {
      await presetOps.switch(preset.name, state.current);
      onToast(`已切换到模式「${preset.name}」`, "info");
      setOpen(false);
    } catch (e: unknown) {
      const err = normalizeError(e);
      onToast(
        err.code === "CONFLICT" ? "omp 配置已被外部修改，已刷新，请重试" : errorText(err),
        "error",
      );
    }
  }

  async function saveDraft() {
    if (state == null || draftError != null || duplicate) return;
    try {
      await presetOps.save(draftName, false, state.rawPresets);
      onToast(`已保存模式「${draftName}」`, "info");
      setCreating(false);
      setDraftName("");
    } catch (e: unknown) {
      failToast(e);
    }
  }

  async function runConfirm() {
    if (state == null || confirm == null) return;
    const { kind, preset } = confirm;
    setConfirm(null);
    try {
      if (kind === "overwrite") {
        await presetOps.save(preset.name, true, state.rawPresets);
        onToast(`已用当前配置覆盖模式「${preset.name}」`, "info");
      } else {
        await presetOps.remove(preset.name, state.rawPresets);
        onToast(`已删除模式「${preset.name}」`, "info");
      }
    } catch (e: unknown) {
      failToast(e);
    }
  }

  const label =
    view.status === "loading"
      ? "模式 …"
      : view.status === "error"
        ? "模式"
        : state?.active != null
          ? `模式：${state.active}`
          : "模式：自定义";

  return (
    <div className="mode-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-small mode-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="模型模式"
        title={view.status === "error" ? view.message : "切换整套模型配置（角色、agent 模型、推理档位）"}
        onClick={() => {
          // 打开即重拉：外部（终端 / 草稿保存）改过配置时，列表与激活项必须是最新的，
          // 否则会把过期的 expected 发给后端，白白吃一次 CONFLICT。
          if (!open) void refreshPresets();
          setOpen(!open);
        }}
      >
        {view.status === "error" ? <Ico icon={TriangleAlert} size={12} /> : null}
        {label}
      </button>
      {open ? (
        <div className="mode-pop" role="dialog" aria-label="模型模式">
          <div className="mode-pop-title">模型模式</div>
          {view.status === "loading" ? <div className="mode-note">读取中…</div> : null}
          {view.status === "error" ? (
            <div className="mode-error">
              <div>{view.message}</div>
              <button type="button" className="btn btn-small" onClick={() => void refreshPresets()}>
                重试
              </button>
            </div>
          ) : null}
          {state != null ? (
            <>
              {state.presets.length === 0 ? (
                <div className="mode-note">
                  还没有模式。先在「管理 → 模型」配好角色和 agent 模型，再存为模式。
                </div>
              ) : (
                <>
                  {state.active == null ? (
                    <div className="mode-note mode-note-warn">当前配置未保存为模式</div>
                  ) : null}
                  <ul className="mode-list" role="none">
                    {state.presets.map((preset) => {
                      const isActive = state.active === preset.name;
                      const invalid = preset.invalidReason != null;
                      return (
                        <li key={preset.name} className="mode-row">
                          <button
                            type="button"
                            className={isActive ? "mode-item mode-item-active" : "mode-item"}
                            role="menuitemradio"
                            aria-checked={isActive}
                            disabled={busy || invalid}
                            title={invalid ? preset.invalidReason ?? undefined : rolesTitle(preset)}
                            onClick={() => void closePreset(preset)}
                          >
                            <span className="mode-item-name">
                              {isActive ? (
                                <span className="mode-check">
                                  <Ico icon={Check} size={12} />
                                </span>
                              ) : null}
                              {preset.name}
                            </span>
                            <span className="mode-item-sub">
                              {invalid ? `格式无效：${preset.invalidReason}` : summary(preset)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-small mode-more"
                            aria-label={`更多操作：${preset.name}`}
                            disabled={busy}
                            onClick={() =>
                              void popupMenu([
                                {
                                  kind: "item",
                                  text: `用当前配置覆盖「${preset.name}」`,
                                  run: () => setConfirm({ kind: "overwrite", preset }),
                                },
                                {
                                  kind: "item",
                                  text: `删除「${preset.name}」…`,
                                  run: () => setConfirm({ kind: "delete", preset }),
                                },
                              ])
                            }
                          >
                            ⋯
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {creating ? (
                <form
                  className="mode-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveDraft();
                  }}
                >
                  <input
                    ref={inputRef}
                    className="mode-input"
                    type="text"
                    maxLength={NAME_MAX}
                    placeholder="模式名（字母开头）"
                    aria-label="模式名"
                    aria-invalid={draftError != null || duplicate}
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setCreating(false);
                        setDraftName("");
                      }
                    }}
                  />
                  {draftError != null ? <div className="mode-form-error">{draftError}</div> : null}
                  {draftError == null && duplicate ? (
                    <div className="mode-form-error">
                      已有同名模式，请用该模式「⋯」菜单里的「覆盖」
                    </div>
                  ) : null}
                  <div className="mode-form-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        setCreating(false);
                        setDraftName("");
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      className="btn btn-small btn-accent"
                      disabled={busy || draftError != null || duplicate || draftName.length === 0}
                    >
                      保存
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className="btn btn-small mode-save"
                  disabled={busy}
                  onClick={() => setCreating(true)}
                >
                  将当前配置存为模式…
                </button>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {confirm != null ? (
        <Modal
          title={
            confirm.kind === "overwrite"
              ? `用当前配置覆盖模式「${confirm.preset.name}」？`
              : `删除模式「${confirm.preset.name}」？`
          }
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                type="button"
                className={confirm.kind === "delete" ? "btn btn-danger" : "btn btn-accent"}
                data-autofocus
                onClick={() => void runConfirm()}
              >
                {confirm.kind === "delete" ? "删除" : "覆盖"}
              </button>
            </>
          }
        >
          {confirm.kind === "overwrite" ? (
            <p>这个模式保存的角色模型、agent 模型和推理档位将被当前配置替换。</p>
          ) : (
            <p>只删除这个模式的保存记录，不影响当前正在使用的模型配置。</p>
          )}
        </Modal>
      ) : null}
    </div>
  );
}
