/**
 * 模型规格抽屉：只读事实 + models.yml 条目的内联编辑表单。
 * 无规格时只读（内置目录），有规格时可改名/窗口/输出/推理/模态/价格。
 * 保存走 update_model_spec（读-比-写）；CONFLICT 时重载并保留表单与 touched。
 * 表单只从 yml 规格播种：目录值只做占位提示，不进入补丁；补丁 = touched ∩ 与基线语义不同。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { normalizeError, updateModelSpec } from "../api";
import { errorText } from "../format";
import type { ModelInfo, ModelSpec, ModelSpecPatch, ModelSpecUpdateResult } from "../types";
import { formatContextWindow, formatCost } from "../roleCards";
import { Drawer } from "./Drawer";
import type { ToastFn } from "./useOmpOp";

interface ModelSpecDrawerProps {
  selector: string;
  model: ModelInfo | null;
  spec: ModelSpec | null;
  revision: string;
  specsPath: string;
  editable: boolean;
  /** 父级 reload 进行中时禁用保存（防自 CONFLICT）。 */
  reloading?: boolean;
  onClose: () => void;
  /** 保存成功（含 CONFLICT 后的提示）都回传结果；CONFLICT 时 result 为 null。 */
  onSaved: (result: ModelSpecUpdateResult | null) => void;
  onToast: ToastFn;
}

function Fact(props: { label: string; value: string }): ReactNode {
  return (
    <div className="spec-fact">
      <span className="muted">{props.label}</span>
      <span>{props.value}</span>
    </div>
  );
}

function formatCache(cost: number | null): string {
  return cost === null ? "—" : `$${cost}`;
}

/** 严格正整数字面量：纯数字，不接受 1e3 / 1_000 / 小数 / 符号。 */
export function parseStrictPositiveInt(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, error: "须为正整数" };
  const value = Number(trimmed);
  if (value > Number.MAX_SAFE_INTEGER) return { ok: false, error: "数值过大" };
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, error: "须为正整数" };
  return { ok: true, value };
}

/** 严格非负价格字面量：整数或小数，不接受 1e3 / 0x10 / Infinity / 符号。 */
export function parseStrictCost(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

/**
 * 补丁键：用户碰过的字段才进补丁。cost 四子键视为一个整体（改任一即要求四个
 * 全合法、整体替换），避免拼出半个 cost 块。
 */
type FieldKey = "name" | "contextWindow" | "maxTokens" | "reasoning" | "input" | "cost";

interface SpecBaseline {
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
  modalities: string[];
  cost: [string, string, string, string];
  /** 每个顶层键在 yml 里是否有值（无值=目录值仅作占位提示）。 */
  present: { name: boolean; contextWindow: boolean; maxTokens: boolean; reasoning: boolean; input: boolean };
}

function baselineFromSpec(spec: ModelSpec | null): SpecBaseline {
  return {
    name: spec?.name ?? "",
    contextWindow: spec?.contextWindow?.toString() ?? "",
    maxTokens: spec?.maxTokens?.toString() ?? "",
    reasoning: spec?.reasoning ?? false,
    modalities: spec?.input === null || spec?.input === undefined ? [] : [...spec.input],
    cost: [
      spec?.costInput?.toString() ?? "",
      spec?.costOutput?.toString() ?? "",
      spec?.costCacheRead?.toString() ?? "",
      spec?.costCacheWrite?.toString() ?? "",
    ],
    present: {
      name: spec?.name !== null && spec?.name !== undefined,
      contextWindow: spec?.contextWindow !== null && spec?.contextWindow !== undefined,
      maxTokens: spec?.maxTokens !== null && spec?.maxTokens !== undefined,
      reasoning: spec?.reasoning !== null && spec?.reasoning !== undefined,
      input: spec?.input !== null && spec?.input !== undefined,
    },
  };
}

export function ModelSpecDrawer(props: ModelSpecDrawerProps): ReactNode {
  const { selector, model, spec, revision, specsPath, editable, reloading = false, onClose, onSaved, onToast } = props;
  // 只从 spec（yml 条目）播种；目录值只做 placeholder 提示。
  const [name, setName] = useState(spec?.name ?? "");
  const [contextWindow, setContextWindow] = useState(spec?.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(spec?.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(spec?.reasoning ?? false);
  const [modalities, setModalities] = useState<string[]>(spec?.input === null || spec?.input === undefined ? [] : [...spec.input]);
  const [costInput, setCostInput] = useState(spec?.costInput?.toString() ?? "");
  const [costOutput, setCostOutput] = useState(spec?.costOutput?.toString() ?? "");
  const [costCacheRead, setCostCacheRead] = useState(spec?.costCacheRead?.toString() ?? "");
  const [costCacheWrite, setCostCacheWrite] = useState(spec?.costCacheWrite?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /**
   * 用户碰过的键：补丁只从 touched 里取。CONFLICT 重拍基线时保留 touched，
   * 重试与首次发送相同的意图，不把外部改动当自己的发回去。
   */
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const markTouched = (key: FieldKey): void => {
    setTouched((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };
  // 挂载基线：CONFLICT 重载后以新 spec 重拍，但保留用户已输入的值与 touched。
  const [baseline, setBaseline] = useState<SpecBaseline>(() => baselineFromSpec(spec));
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const savingRef = useRef(false);
  savingRef.current = saving;

  const context = spec?.contextWindow ?? model?.contextWindow ?? null;
  const maxOut = spec?.maxTokens ?? model?.maxTokens ?? null;
  const costLine = formatCost(spec?.costInput ?? model?.costInput ?? null, spec?.costOutput ?? model?.costOutput ?? null);
  const cacheRead = spec?.costCacheRead ?? model?.costCacheRead ?? null;
  const cacheWrite = spec?.costCacheWrite ?? model?.costCacheWrite ?? null;
  const inputModes = spec?.input ?? model?.input ?? [];
  const isReasoning = spec?.reasoning ?? model?.reasoning ?? false;

  const toggleModality = (mode: string): void => {
    markTouched("input");
    setModalities((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  };

  const costValues = [costInput, costOutput, costCacheRead, costCacheWrite];
  const modalitiesChanged =
    modalities.length !== baseline.modalities.length || modalities.some((m) => !baseline.modalities.includes(m));

  function validate(): ModelSpecPatch | null {
    // 补丁 = touched ∩ 与基线语义不同：没碰过的键永不发送（CONFLICT 重拍基线也不影响）。
    if (touched.size === 0) {
      setFormError("没有改动");
      return null;
    }
    const patch: ModelSpecPatch = {};
    if (touched.has("name")) {
      const trimmedName = name.trim();
      // 必填键：碰过即校验；与基线语义相等才省略（"Fast " 不发请求）。
      if (trimmedName === "") {
        setFormError("名称不能为空");
        return null;
      }
      if (trimmedName !== baseline.name) {
        if ([...trimmedName].length > 200) {
          setFormError("名称最多 200 个字符");
          return null;
        }
        if (/[\n\r]/.test(trimmedName)) {
          setFormError("名称不能换行");
          return null;
        }
        if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(trimmedName)) {
          setFormError("名称包含非法字符");
          return null;
        }
        patch.name = trimmedName;
      }
    }
    if (touched.has("contextWindow") && contextWindow !== baseline.contextWindow) {
      const parsed = parseStrictPositiveInt(contextWindow);
      if (!parsed.ok) {
        setFormError(parsed.error === "数值过大" ? "上下文窗口数值过大" : "上下文窗口须为正整数");
        return null;
      }
      // 原值为空=新增；否则按数值语义比较（"0200000"/纯空白差不算改动）。
      if (baseline.contextWindow === "" || Number(baseline.contextWindow) !== parsed.value) {
        patch.contextWindow = parsed.value;
      }
    }
    if (touched.has("maxTokens") && maxTokens !== baseline.maxTokens) {
      const parsed = parseStrictPositiveInt(maxTokens);
      if (!parsed.ok) {
        setFormError(parsed.error === "数值过大" ? "最大输出数值过大" : "最大输出须为正整数");
        return null;
      }
      if (baseline.maxTokens === "" || Number(baseline.maxTokens) !== parsed.value) {
        patch.maxTokens = parsed.value;
      }
    }
    if (touched.has("reasoning") && reasoning !== baseline.reasoning) patch.reasoning = reasoning;
    if (touched.has("input") && modalitiesChanged) {
      if (modalities.length === 0) {
        setFormError("至少选择一种输入模态");
        return null;
      }
      patch.input = [...modalities];
    }
    if (touched.has("cost") && costValues.some((v, i) => v !== baseline.cost[i])) {
      const parsed: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const result = parseStrictCost(costValues[i]);
        if (!result.ok) {
          setFormError("价格须为 ≥ 0 的数字");
          return null;
        }
        parsed.push(result.value);
      }
      // 四键语义全等（仅空白/小数写法差异）则整体省略。
      const costRealChange = parsed.some((v, i) => baseline.cost[i] === "" || v !== Number(baseline.cost[i]));
      if (costRealChange) {
        patch.cost = { input: parsed[0], output: parsed[1], cacheRead: parsed[2], cacheWrite: parsed[3] };
      }
    }
    if (Object.keys(patch).length === 0) {
      // touched 但全与基线语义相等（如 "Fast "、"200000 "）：不发请求。
      setFormError("没有改动");
      onToast("没有改动", "info");
      return null;
    }
    setFormError(null);
    return patch;
  }

  const blockedClose = useMemo(() => {
    // 保存中禁止关闭：Drawer 无禁用钩子，父级 onClose 在 saving 时被吞掉。
    return (): void => {
      if (savingRef.current) return;
      onClose();
    };
  }, [onClose]);

  async function handleSave(): Promise<void> {
    if (spec === null || saving) return;
    const patch = validate();
    if (patch === null) return;
    setSaving(true);
    try {
      const result = await updateModelSpec({ provider: spec.provider, id: spec.id, patch, expectedRevision: revisionRef.current });
      revisionRef.current = result.revision;
      // 成功即以返回的 spec 重拍基线并同步表单、清空 touched：第二次连存无改动。
      const fresh = baselineFromSpec(result.spec);
      setBaseline(fresh);
      setName(fresh.name);
      setContextWindow(fresh.contextWindow);
      setMaxTokens(fresh.maxTokens);
      setReasoning(fresh.reasoning);
      setModalities([...fresh.modalities]);
      setCostInput(fresh.cost[0]);
      setCostOutput(fresh.cost[1]);
      setCostCacheRead(fresh.cost[2]);
      setCostCacheWrite(fresh.cost[3]);
      setTouched(new Set());
      // 后端 no-op 返回空备份路径：不谎称已备份。
      onToast(result.backupPath === "" ? "没有改动" : "已写入 models.yml（已备份）", "info");
      onSaved(result);
    } catch (e: unknown) {
      const err = normalizeError(e);
      if (err.code === "CONFLICT") {
        setFormError(`配置已被外部修改，请刷新后重试：${errorText(err)}（表单已保留）`);
        onSaved(null);
      } else {
        setFormError(`保存失败：${errorText(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }

  // 父级重载 landing 后通过 spec prop 变化重拍基线（保留用户输入与 touched）。
  const specKey = spec === null ? "null" : `${spec.provider}/${spec.id}:${revision}`;
  useEffect(() => {
    setBaseline(baselineFromSpec(spec));
  }, [specKey]);

  const saveDisabled = saving || reloading || touched.size === 0 || (spec?.costTiered ?? false);
  const namePlaceholder = baseline.present.name ? undefined : (model?.name ?? undefined);
  const windowPlaceholder = baseline.present.contextWindow ? undefined : (model?.contextWindow?.toString() ?? undefined);
  const maxPlaceholder = baseline.present.maxTokens ? undefined : (model?.maxTokens?.toString() ?? undefined);
  const costPlaceholders = [
    baseline.cost[0] !== "" ? undefined : (model?.costInput?.toString() ?? undefined),
    baseline.cost[1] !== "" ? undefined : (model?.costOutput?.toString() ?? undefined),
    baseline.cost[2] !== "" ? undefined : (model?.costCacheRead?.toString() ?? undefined),
    baseline.cost[3] !== "" ? undefined : (model?.costCacheWrite?.toString() ?? undefined),
  ];

  return (
    <Drawer label={`模型规格 ${selector}`} title={<span className="mono">{selector}</span>} onClose={blockedClose}>
      <div className="spec-facts">
        <Fact label="供应商" value={model?.provider ?? spec?.provider ?? "—"} />
        <Fact label="selector" value={selector} />
        <Fact label="模型 id" value={model?.id ?? spec?.id ?? "—"} />
        <Fact label="名称" value={model?.name ?? spec?.name ?? "—"} />
        <Fact label="上下文" value={formatContextWindow(context) ?? "—"} />
        <Fact label="最大输出" value={maxOut === null ? "—" : maxOut.toLocaleString()} />
        <Fact label="输入模态" value={inputModes.length === 0 ? "—" : inputModes.join(" / ")} />
        <Fact label="推理" value={isReasoning ? "是" : "否"} />
        <Fact label="思考档位" value={(model?.thinkingLevels ?? []).length === 0 ? "无" : (model?.thinkingLevels ?? []).join(" / ")} />
        <Fact label="目录价" value={costLine ?? "—"} />
        <Fact label="缓存读/写" value={`${formatCache(cacheRead)} / ${formatCache(cacheWrite)}`} />
        <Fact label="来源" value={editable ? "models.yml（可编辑）" : "内置目录（只读）"} />
      </div>

      {editable && spec !== null ? (
        <div className="spec-form">
          <div className="spec-form-title">编辑规格</div>
          {/* 保存中整组锁定：后端用 omp 校验最长约一分钟，期间禁止输入，避免成功时基线同步吞掉用户刚打的字。 */}
          <fieldset className="spec-form-fieldset" disabled={saving || reloading} style={{ display: "flex", flexDirection: "column", gap: 10, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <label className="spec-field">
              <span className="muted">名称{baseline.present.name ? "" : "（目录值仅供参考）"}</span>
              <input className="filter-input" value={name} maxLength={400} placeholder={namePlaceholder} onChange={(e) => { markTouched("name"); setName(e.target.value); }} />
            </label>
            <div className="spec-grid">
              <label className="spec-field">
                <span className="muted">上下文窗口{baseline.present.contextWindow ? "" : "（目录值仅供参考）"}</span>
                <input className="filter-input" inputMode="numeric" value={contextWindow} placeholder={windowPlaceholder} onChange={(e) => { markTouched("contextWindow"); setContextWindow(e.target.value); }} />
              </label>
              <label className="spec-field">
                <span className="muted">最大输出{baseline.present.maxTokens ? "" : "（目录值仅供参考）"}</span>
                <input className="filter-input" inputMode="numeric" value={maxTokens} placeholder={maxPlaceholder} onChange={(e) => { markTouched("maxTokens"); setMaxTokens(e.target.value); }} />
              </label>
            </div>
            <label className="spec-check">
              <input type="checkbox" checked={reasoning} onChange={(e) => { markTouched("reasoning"); setReasoning(e.target.checked); }} />
              推理模型{baseline.present.reasoning ? "" : "（目录值仅供参考）"}
            </label>
            <div className="spec-check-row" role="group" aria-label="输入模态">
              {(["text", "image"] as const).map((mode) => (
                <label key={mode} className="spec-check">
                  <input type="checkbox" checked={modalities.includes(mode)} onChange={() => toggleModality(mode)} />
                  {mode}
                </label>
              ))}
              {baseline.present.input ? null : <span className="muted">（目录：{(model?.input ?? []).join(" / ") || "—"}，仅供参考）</span>}
            </div>
            {spec?.costTiered === true ? (
              <div className="muted">分层价格，暂不支持编辑</div>
            ) : (
              <div className="spec-grid">
                <label className="spec-field">
                  <span className="muted">输入价</span>
                  <input className="filter-input" inputMode="decimal" value={costInput} placeholder={costPlaceholders[0]} onChange={(e) => { markTouched("cost"); setCostInput(e.target.value); }} />
                </label>
                <label className="spec-field">
                  <span className="muted">输出价</span>
                  <input className="filter-input" inputMode="decimal" value={costOutput} placeholder={costPlaceholders[1]} onChange={(e) => { markTouched("cost"); setCostOutput(e.target.value); }} />
                </label>
                <label className="spec-field">
                  <span className="muted">缓存读</span>
                  <input className="filter-input" inputMode="decimal" value={costCacheRead} placeholder={costPlaceholders[2]} onChange={(e) => { markTouched("cost"); setCostCacheRead(e.target.value); }} />
                </label>
                <label className="spec-field">
                  <span className="muted">缓存写</span>
                  <input className="filter-input" inputMode="decimal" value={costCacheWrite} placeholder={costPlaceholders[3]} onChange={(e) => { markTouched("cost"); setCostCacheWrite(e.target.value); }} />
                </label>
              </div>
            )}
          </fieldset>
          {formError !== null ? <div className="spec-error" role="alert">{formError}</div> : null}
          {saving ? <div className="muted">正在写入并用 omp 校验，请稍候…</div> : null}
          <div>
            <button type="button" className="btn btn-accent" disabled={saveDisabled} title={spec?.costTiered === true ? "分层价格，暂不支持编辑" : (touched.size === 0 && !saving ? "没有改动" : undefined)} onClick={() => void handleSave()}>
              {saving ? <span className="spinner" aria-hidden="true" /> : null}
              {saving ? "保存中…" : "保存规格"}
            </button>
          </div>
        </div>
      ) : (
        <div className="pane-note">
          这个模型来自 omp 的内置目录，没有 models.yml 条目，因此只读。只有出现在规格列表里的模型才能编辑。
        </div>
      )}

      <div className="muted spec-path">规格文件：<span className="mono">{specsPath}</span></div>
      <div className="muted spec-note">保存前自动备份，写入后用 omp 校验；凭据不读取不入库。</div>
    </Drawer>
  );
}
