/**
 * 活动流：所有角色的 `recent` 合并按时间降序取前 100；
 * 选中角色时只看它。顶部显示选中角色的详情条。
 */
import { formatUsd } from "../format";
import { compactNumber } from "../components/usageFormat";
import { STATE_WORD } from "./stateWords";
import type { StageActor } from "../types";

/** 活动流最多展示条数。 */
export const FEED_LIMIT = 100;

export interface FeedRow {
  id: string;
  name: string;
  at: string;
  text: string;
  tool: string | null;
  kind: string;
}

/** 合并所有角色的活动（旧→新取尾部 FEED_LIMIT 条，再反转成新→旧）。 */
export function buildFeed(actors: StageActor[], selectedId: string | null): FeedRow[] {
  const source = selectedId === null ? actors : actors.filter((a) => a.id === selectedId);
  const rows: FeedRow[] = [];
  for (const actor of source) {
    for (const item of actor.recent) {
      rows.push({
        id: actor.id,
        name: actor.name,
        at: item.at,
        text: item.text,
        tool: item.tool,
        kind: item.kind,
      });
    }
  }
  rows.sort((a, b) => b.at.localeCompare(a.at));
  return rows.slice(0, FEED_LIMIT);
}

function clock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "--:--:--";
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export interface ActivityFeedProps {
  actors: StageActor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ActivityFeed({ actors, selectedId, onSelect }: ActivityFeedProps) {
  const rows = buildFeed(actors, selectedId);
  const selected = selectedId === null ? null : actors.find((a) => a.id === selectedId) ?? null;
  return (
    <div className="stage-feed">
      {selected !== null ? (
        <div className="stage-feed-detail">
          <strong>{selected.name}</strong>
          <span>{STATE_WORD[selected.state]}</span>
          <span className="stage-mono">{selected.model ?? "无模型信息"}</span>
          <span className="stage-mono">上下文 {compactNumber(selected.contextTokens)}</span>
          <span className="stage-mono">花费 {formatUsd(selected.cost)}</span>
          <span className="stage-mono">工具 {selected.toolCalls}</span>
        </div>
      ) : (
        <div className="stage-feed-detail">
          <span>全部角色 · {rows.length} 条活动</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="stage-empty-note">还没有活动记录。</p>
      ) : (
        <ul className="stage-feed-list">
          {rows.map((row, i) => (
            <li key={`${row.id}:${row.at}:${i}`}>
              <button type="button" className="stage-feed-row" onClick={() => onSelect(row.id)}>
                <span className="stage-mono stage-feed-time">{clock(row.at)}</span>
                <span className="stage-feed-name">{row.name}</span>
                <span className="stage-feed-text">
                  {row.tool !== null ? <span className="stage-chip">{row.tool}</span> : null}
                  {row.text}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
