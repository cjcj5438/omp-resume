/**
 * 「主要模型」+「其他模型的兜底」两个区块：角色卡 / 紧凑行 / 更多角色 /
 * 其他兜底的 chain 编辑器。纯渲染组件，状态全部来自 ModelDraftState。
 * 与 AgentsSection 同源（见 modelDraft.ts 头注）；组件测试在
 * ModelSections.test.tsx。
 */
import { useState } from "react";
import "./ModelsAgentsPanel.css";
import type { ModelInfo } from "../types";
import {
  COMMON_ROLES,
  MORE_ROLES,
  attachedChainKeys,
  classifyChainKey,
  describeRoleFallback,
  roleInfo,
  rowAfterModelChange,
  type ChainDraft,
  type SelectorRow,
} from "../roleCards";
import { attachedTitle, type ModelDraftState } from "../modelDraft";
import { ChainChip, ThinkingSegment } from "./ModelDraftWidgets";
import { ModelPicker } from "./ModelPicker";
import { Plus } from "lucide-react";
import { Ico } from "./ui";

export function ModelsSection(props: { state: ModelDraftState }) {
  const s = props.state;
  const { config, draft, modelsList } = s;
  const busy = s.busyBlock !== null;

  /** 某角色的一行：卡还是紧凑行（与原 renderRoleEntry 逐字一致）。 */
  const renderRoleEntry = (role: string) => {
    if (!s.roleCardVisible(role)) {
      const fallback = describeRoleFallback(role, config.roles, modelsList);
      return (
        <RoleCompactRow
          key={role}
          role={role}
          modelText={fallback.modelText}
          modelUnknown={fallback.modelUnknown}
          viaDisplay={fallback.viaDisplay}
          disabled={busy}
          onExpand={() => s.expandRole(role)}
        />
      );
    }
    const row = draft.roles.get(role) ?? { selector: null, thinking: "", touched: false };
    const primary = row.selector;
    const attached =
      primary !== null
        ? attachedChainKeys(primary, [...draft.chains.keys()]).filter((key) =>
            draft.chains.has(key),
          )
        : [];
    const roleChain = draft.chains.get(role) ?? null;
    // 未配置、没兜底、没改过、非 default 的卡可收起回紧凑行。
    const collapsible =
      config.roles[role] === undefined &&
      !row.touched &&
      !draft.chains.has(role) &&
      role !== "default";
    return (
      <RoleCard
        key={role}
        role={role}
        row={row}
        roleChain={roleChain}
        attachedKeys={attached}
        chains={draft.chains}
        models={modelsList}
        disabled={busy}
        collapsible={collapsible}
        onRow={(next) => s.setRow("roles", role, next)}
        onEnsureChain={s.ensureChain}
        onDeleteChain={s.deleteChain}
        onChain={s.updateChain}
        onCollapse={() => s.collapseRole(role)}
      />
    );
  };

  return (
    <div className="models-agents">
      <section className="block-section" aria-label="主要模型">
        <div className="block-head">
          <h3 className="manage-sub">主要模型</h3>
          <span className="muted">每个角色的主模型与兜底在同一张卡里改</span>
        </div>
        {s.blockErrors.roles !== null ? (
          <div className="banner banner-error" role="alert">
            {s.blockErrors.roles}
          </div>
        ) : null}
        {draft.shownRoles
          .filter((role) => !MORE_ROLES.includes(role))
          .map((role) => renderRoleEntry(role))}
        {COMMON_ROLES.filter(
          (role) => !MORE_ROLES.includes(role) && !draft.shownRoles.includes(role),
        ).map((role) => renderRoleEntry(role))}
        <details
          className="more-roles"
          open={s.moreOpen}
          data-testid="more-roles"
        >
          <summary
            onClick={(e) => {
              e.preventDefault();
              s.setMoreOpen(!s.moreOpen);
            }}
          >
            更多角色（图片生成、联网搜索等能力类，默认收起）
          </summary>
          <p className="muted">
            能力类角色需要专用模型；未单独设置时用 omp 内置默认。配过的同样在这里改。
          </p>
          {MORE_ROLES.map((role) => renderRoleEntry(role))}
        </details>
        {s.dirty.roles ? (
          <div className="save-bar" role="status">
            <span>{s.rolesChangeCount} 处未保存修改</span>
            <button
              type="button"
              className="btn"
              disabled={s.busyBlock !== null}
              onClick={() => s.revert("roles")}
            >
              还原
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={s.busyBlock !== null}
              onClick={s.saveRoles}
            >
              {s.busyBlock === "roles" ? <span className="spinner" aria-hidden="true" /> : null}
              {s.rolesSaveLabel}
            </button>
          </div>
        ) : null}
      </section>


      <section className="block-section" aria-label="其他模型的兜底">
        <div className="block-head">
          <h3 className="manage-sub">其他模型的兜底</h3>
          <span className="muted">当前没有角色在用的模型的兜底（正在用的在上面的角色卡里）</span>
        </div>
        {s.blockErrors.others !== null ? (
          <div className="banner banner-error" role="alert">
            {s.blockErrors.others}
          </div>
        ) : null}
        <details className="others-details" open={s.othersOpen} data-testid="others-details">
          <summary
            onClick={(e) => {
              e.preventDefault();
              s.setOthersOpen(!s.othersOpen);
            }}
          >
            {s.othersKeys.length === 0
              ? "暂无其他兜底（点击展开，可新增）"
              : `共 ${s.othersKeys.length} 条（点击${s.othersOpen ? "收起" : "展开"}）`}
            {s.dirty.others ? <span className="muted"> · 未保存的修改</span> : null}
          </summary>
          <p className="muted">
            这些兜底按模型生效：不管哪个角色在用这个模型，出错时都会按顺序切换。
          </p>
          {s.othersKeys.length === 0 ? (
            <div className="pane-note">没有其他兜底：所有按模型的兜底都已显示在上面的角色卡里。</div>
          ) : null}
          {s.othersKeys.map((key) => {
            const kind = classifyChainKey(key);
            const title =
              kind === "role" ? `「${roleInfo(key)?.name ?? key}」的兜底` : s.chainLabel(key);
            const note =
              kind === "role"
                ? "没有同名的模型角色，omp 可能不会使用这条配置（原样保留，可删除）"
                : null;
            const hint =
              kind === "role"
                ? "该角色的主模型出错时，按顺序改用"
                : "不管哪个角色在用这个模型，出错时都按顺序改用";
            return (
              <ChainEditor
                key={key}
                chainKey={key}
                title={title}
                hint={hint}
                note={note}
                draft={draft.chains.get(key) ?? null}
                models={modelsList}
                disabled={s.busyBlock !== null}
                onEnsure={s.ensureChain}
                onDeleteChain={s.deleteChain}
                onChange={s.updateChain}
              />
            );
          })}
          <div className="chain-add">
            <ModelPicker
              models={modelsList}
              value={s.newModelKey}
              allowUnset={false}
              unsetLabel="选择模型…"
              disabled={s.busyBlock !== null}
              label="为新兜底选择模型"
              onChange={s.setNewModelKey}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={s.busyBlock !== null || s.newModelKey === null}
              onClick={() => s.newModelKey !== null && s.addChain(s.newModelKey)}
            >
              添加该模型的兜底
            </button>
          </div>
          <div className="chain-add">
            <input
              className="filter-input"
              placeholder="或其他 key，如 p1/*、my-role"
              aria-label="新兜底的其他 key"
              value={s.newCustomKey}
              disabled={s.busyBlock !== null}
              onChange={(e) => {
                s.setNewCustomKey(e.target.value);
                s.setNewKeyError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") s.addChain(s.newCustomKey);
              }}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={s.busyBlock !== null}
              onClick={() => s.addChain(s.newCustomKey)}
            >
              添加
            </button>
          </div>
          {s.newKeyError !== null ? (
            <div className="muted" role="alert">
              {s.newKeyError}
            </div>
          ) : null}
        </details>
        {s.dirty.others ? (
          <div className="save-bar" role="status">
            <span>{s.chainsChangeCount} 处未保存修改</span>
            <button
              type="button"
              className="btn"
              disabled={s.busyBlock !== null}
              onClick={() => s.revert("others")}
            >
              还原
            </button>
            <button
              type="button"
              className="btn btn-accent"
              disabled={s.busyBlock !== null}
              onClick={s.saveOthers}
            >
              {s.busyBlock === "others" ? <span className="spinner" aria-hidden="true" /> : null}
              保存兜底
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** 模型 + 思考强度共用的行编辑单元。 */
function SelectorCell(props: {
  models: ModelInfo[];
  row: SelectorRow;
  unsetLabel: string;
  label: string;
  disabled: boolean;
  onChange: (row: SelectorRow) => void;
}) {
  const { models, row, unsetLabel, label, disabled, onChange } = props;
  const levels =
    row.selector !== null
      ? (models.find((m) => m.selector === row.selector)?.thinkingLevels ?? [])
      : [];
  return (
    <div className="selector-cell">
      <div className="field">
        <span className="field-label">主模型</span>
        <ModelPicker
          models={models}
          value={row.selector}
          allowUnset
          unsetLabel={unsetLabel}
          disabled={disabled}
          label={label}
          onChange={(selector) => onChange(rowAfterModelChange(row, selector, models))}
        />
      </div>
      <ThinkingSegment
        levels={levels}
        value={row.thinking}
        disabled={disabled || row.selector === null}
        label={`${label}的思考强度`}
        onChange={(thinking) => onChange({ ...row, thinking, touched: true })}
      />
    </div>
  );
}

/** 单条兜底的编辑器：一行说明 + 紧凑有序条目 + 弹出式添加。 */
function ChainEditor(props: {
  chainKey: string;
  title: string;
  hint: string;
  note: string | null;
  draft: ChainDraft | null;
  models: ModelInfo[];
  disabled: boolean;
  onEnsure: (key: string) => void;
  onDeleteChain: (key: string) => void;
  onChange: (key: string, patch: (chain: ChainDraft) => ChainDraft) => void;
}) {
  const { chainKey, title, hint, note, draft, models, disabled, onEnsure, onDeleteChain, onChange } =
    props;
  const [adding, setAdding] = useState(false);
  if (draft === null) {
    return (
      <div className="chain-block" data-testid={`chain-${chainKey}`}>
        <div className="chain-block-head">
          <span className="chain-block-title">{title}</span>
          <span className="muted">{hint}</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => onEnsure(chainKey)}
          >
            添加兜底
          </button>
        </div>
        {note !== null ? <div className="muted chain-note">{note}</div> : null}
      </div>
    );
  }

  const moveEntry = (index: number, delta: number) => {
    onChange(chainKey, (chain) => {
      const entries = [...chain.entries];
      const target = index + delta;
      [entries[index], entries[target]] = [entries[target], entries[index]];
      return { ...chain, entries };
    });
  };

  const appendEntry = (value: string) => {
    onChange(chainKey, (chain) => ({ ...chain, entries: [...chain.entries, value] }));
  };

  return (
    <div className="chain-block" data-testid={`chain-${chainKey}`}>
      <div className="chain-block-head">
        <span className="chain-block-title">{title}</span>
        <span className="muted">{hint}</span>
        <button
          type="button"
          className="btn btn-small btn-quiet-danger"
          disabled={disabled}
          aria-label={`删除${title}（${chainKey}）`}
          onClick={() => onDeleteChain(chainKey)}
        >
          删除这条兜底
        </button>
      </div>
      {note !== null ? <div className="muted chain-note">{note}</div> : null}
      {draft.entries.length === 0 ? (
        <div className="pane-note">还没有兜底模型：在下面添加，或删除这条兜底。</div>
      ) : (
        <ol className="chain-chips">
          {draft.entries.map((entry, index) => (
            <ChainChip
              key={`${index}-${typeof entry === "string" ? entry : JSON.stringify(entry) ?? index}`}
              entry={entry}
              index={index}
              last={index === draft.entries.length - 1}
              models={models}
              disabled={disabled}
              onMove={moveEntry}
              onDelete={() =>
                onChange(chainKey, (chain) => ({
                  ...chain,
                  entries: chain.entries.filter((_, i) => i !== index),
                }))
              }
            />
          ))}
        </ol>
      )}
      {!adding ? (
        <div>
          <button
            type="button"
            className="btn btn-small"
            disabled={disabled}
            onClick={() => setAdding(true)}
          >
            <Ico icon={Plus} size={12} /> 添加兜底模型
          </button>
        </div>
      ) : (
        <ChainAddPanel
          chainKey={chainKey}
          title={title}
          models={models}
          disabled={disabled}
          onAdd={(value) => {
            appendEntry(value);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

/** 添加兜底面板：选模型 → 选思考强度（默认继承）→ 添加；或使用自定义值。 */
function ChainAddPanel(props: {
  chainKey: string;
  title: string;
  models: ModelInfo[];
  disabled: boolean;
  onAdd: (value: string) => void;
  onClose: () => void;
}) {
  const { chainKey, title, models, disabled, onAdd, onClose } = props;
  const [selector, setSelector] = useState<string | null>(null);
  const [thinking, setThinking] = useState("");
  const [custom, setCustom] = useState(false);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const levels =
    selector !== null
      ? (models.find((m) => m.selector === selector)?.thinkingLevels ?? [])
      : [];

  const addComposed = () => {
    if (selector === null) return;
    onAdd(thinking !== "" ? `${selector}:${thinking}` : selector);
  };

  const addManual = () => {
    const text = manual.trim();
    if (text === "") {
      setManualError("先输入一个模型（provider/model，可带 :thinking，或通配如 p1/*）");
      return;
    }
    onAdd(text);
  };

  return (
    <div className="chain-add-panel">
      {!custom ? (
        <>
          <ModelPicker
            models={models}
            value={selector}
            allowUnset={false}
            unsetLabel="选择模型…"
            disabled={disabled}
            label={`为${title}选择兜底模型`}
            onChange={(next) => {
              setSelector(next);
              setThinking("");
            }}
          />
          {selector !== null ? (
            <ThinkingSegment
              levels={levels}
              value={thinking}
              disabled={disabled}
              label={`新兜底模型的思考强度（${chainKey}）`}
              defaultLabel="继承"
              onChange={setThinking}
            />
          ) : null}
          <div className="chain-add-panel-actions">
            <button
              type="button"
              className="btn btn-small btn-accent"
              disabled={disabled || selector === null}
              onClick={addComposed}
            >
              添加
            </button>
            <button type="button" className="btn btn-small" onClick={onClose}>
              取消
            </button>
          </div>
          <button
            type="button"
            className="link-btn muted"
            disabled={disabled}
            onClick={() => setCustom(true)}
          >
            使用自定义值…
          </button>
        </>
      ) : (
        <>
          <input
            className="filter-input"
            placeholder="provider/model[:thinking]，或 p1/*"
            aria-label={`手动输入${title}的兜底模型`}
            value={manual}
            disabled={disabled}
            onChange={(e) => {
              setManual(e.target.value);
              setManualError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addManual();
            }}
          />
          <div className="chain-add-panel-actions">
            <button
              type="button"
              className="btn btn-small btn-accent"
              disabled={disabled}
              onClick={addManual}
            >
              添加
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setCustom(false);
                setManualError(null);
              }}
            >
              返回选择模型
            </button>
            <button type="button" className="btn btn-small" onClick={onClose}>
              取消
            </button>
          </div>
          {manualError !== null ? <div className="muted">{manualError}</div> : null}
        </>
      )}
    </div>
  );
}


/** 角色卡：主模型 + 同卡内的兜底。 */
function RoleCard(props: {
  role: string;
  row: SelectorRow;
  roleChain: ChainDraft | null;
  attachedKeys: string[];
  chains: Map<string, ChainDraft>;
  models: ModelInfo[];
  disabled: boolean;
  /** 未配置且干净的卡可收起回紧凑行。 */
  collapsible: boolean;
  onRow: (row: SelectorRow) => void;
  onEnsureChain: (key: string) => void;
  onDeleteChain: (key: string) => void;
  onChain: (key: string, patch: (chain: ChainDraft) => ChainDraft) => void;
  onCollapse: () => void;
}) {
  const {
    role,
    row,
    roleChain,
    attachedKeys,
    chains,
    models,
    disabled,
    collapsible,
    onRow,
    onEnsureChain,
    onDeleteChain,
    onChain,
    onCollapse,
  } = props;
  const info = roleInfo(role);
  const primary = row.selector !== null ? row.selector : null;
  return (
    <div className="role-card" data-testid={`role-card-${role}`}>
      <div className="role-card-head">
        <div className="role-card-title">
          <strong className="role-card-name">{info?.name ?? role}</strong>
          <span className="mono muted role-key">{role}</span>
          {info === null ? <span className="badge badge-grey">自定义角色</span> : null}
          {info?.kind === "capability" ? (
            <span className="badge badge-grey">能力角色</span>
          ) : null}
          {primary === null ? <span className="badge badge-grey">未配置</span> : null}
          {row.touched ? <span className="muted">已修改</span> : null}
        </div>
        <div className="muted role-card-blurb">{info?.blurb ?? "此配置里的自定义角色"}</div>
      </div>
      <SelectorCell
        models={models}
        row={row}
        unsetLabel="未设置"
        label={`${info?.name ?? role}的主模型`}
        disabled={disabled}
        onChange={onRow}
      />
      {collapsible ? (
        <div>
          <button type="button" className="btn btn-small" disabled={disabled} onClick={onCollapse}>
            收起
          </button>
        </div>
      ) : null}
      <ChainEditor
        chainKey={role}
        title="兜底模型"
        hint="主模型出错时，按顺序改用"
        note={null}
        draft={roleChain}
        models={models}
        disabled={disabled}
        onEnsure={onEnsureChain}
        onDeleteChain={onDeleteChain}
        onChange={onChain}
      />
      {attachedKeys.map((key) => (
        <ChainEditor
          key={key}
          chainKey={key}
          title={attachedTitle(key, models)}
          hint="不管哪个角色在用这个模型，出错时都按顺序改用（优先于按角色的兜底）"
          note={null}
          draft={chains.get(key) ?? null}
          models={models}
          disabled={disabled}
          onEnsure={onEnsureChain}
          onDeleteChain={onDeleteChain}
          onChange={onChain}
        />
      ))}
    </div>
  );
}
/** 未配置角色的紧凑行：实际使用 + 设置按钮，点开才展开成完整卡。 */
function RoleCompactRow(props: {
  role: string;
  modelText: string;
  modelUnknown: boolean;
  viaDisplay: string | null;
  disabled: boolean;
  onExpand: () => void;
}) {
  const { role, modelText, modelUnknown, viaDisplay, disabled, onExpand } = props;
  const info = roleInfo(role);
  return (
    <div className="role-compact" data-testid={`role-compact-${role}`}>
      <span className="role-compact-name">
        <strong>{info?.name ?? role}</strong>
        <span className="mono muted role-key">{role}</span>
      </span>
      <span className="muted">
        未单独设置，实际使用：{modelText}
        {viaDisplay !== null ? `（${viaDisplay}角色）` : ""}
      </span>
      {modelUnknown ? <span className="badge badge-grey">未知值 · 保留</span> : null}
      <button
        type="button"
        className="btn btn-small"
        disabled={disabled}
        data-testid={`expand-role-${role}`}
        onClick={onExpand}
      >
        设置
      </button>
    </div>
  );
}

