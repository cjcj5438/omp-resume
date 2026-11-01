import { Info, Terminal } from "lucide-react";
import { formatUsd } from "../format";
import { compactNumber } from "../components/usageFormat";
import { StatePill } from "../components/page";
import type { StageActor } from "../types";
import { charFor, type StagePrefs } from "./prefs";
import { CharacterAvatar } from "./StageCanvas";
import { buildFeed, feedTextNodes } from "./ActivityFeed";
import { STATE_WORD } from "./stateWords";

/** 单角色活动流（aside 内：HH:MM + 亮色多行文本 + code pill）。 */
function ActorFeed({ actor }: { actor: StageActor }) {
  const rows = buildFeed([actor], actor.id);
  if (rows.length === 0) return <p className="stage-empty-note">该角色暂无活动记录。</p>;
  return (
    <div className="feed-list">
      {rows.map((row, i) => (
        <div key={`${row.at}:${i}`} className="feed-item" title={row.at}>
          <span className="feed-time">{row.at.slice(11, 16)}</span>
          <span className="feed-text">{feedTextNodes(row.text)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 选中角色 aside（设计稿 stage-layout 右列 316px）：
 * 摘要（头像+名+role·model+pill）+ detail-list（Token/成本/状态来源/开始时间/工具）+
 * 活动流 head + feed + 查看原始节点。
 */
export function ActorAside({
  actor,
  prefs,
  onDetail,
}: {
  actor: StageActor;
  prefs: StagePrefs;
  onDetail: () => void;
}) {
  const started = actor.startedAt === null ? null : actor.startedAt.slice(5, 16).replace("T", " ");
  return (
    <aside className="panel stage-aside" aria-label={`${actor.name} 详情`}>
      <div className="actor-summary">
        <CharacterAvatar charId={charFor(prefs, actor)} />
        <div className="actor-summary-text">
          <h3>{actor.name}</h3>
          <p className="mono">{`${actor.agent ?? actor.kind} · ${actor.model ?? "无模型信息"}`}</p>
        </div>
        <StatePill state={actor.state}>{STATE_WORD[actor.state]}</StatePill>
      </div>
      <div className="panel-body" style={{ paddingTop: 10, paddingBottom: 8 }}>
        <dl className="detail-list">
          <div className="detail-row"><dt>Token</dt><dd className="mono">{compactNumber(actor.contextTokens)}</dd></div>
          <div className="detail-row"><dt>成本</dt><dd className="mono">{formatUsd(actor.cost)}</dd></div>
          <div className="detail-row"><dt>状态来源</dt><dd className="mono">{actor.provenance ?? "—"}</dd></div>
          {started !== null ? <div className="detail-row"><dt>开始时间</dt><dd className="mono">{started}</dd></div> : null}
          <div className="detail-row"><dt>工具调用</dt><dd className="mono">{actor.toolCalls} 次</dd></div>
        </dl>
      </div>
      <div className="panel-head" style={{ borderTop: "1px solid var(--border)" }}>
        <div className="panel-title">
          <Terminal size={14} aria-hidden="true" />
          活动流
        </div>
      </div>
      <div className="panel-body" style={{ paddingTop: 4, maxHeight: 240, overflowY: "auto" }}>
        <ActorFeed actor={actor} />
      </div>
      <div className="side-actions" style={{ borderTop: "1px solid var(--border)" }}>
        <button type="button" className="btn btn-ghost btn-block" onClick={onDetail}>
          <Info size={14} aria-hidden="true" />
          查看原始节点
        </button>
      </div>
    </aside>
  );
}
