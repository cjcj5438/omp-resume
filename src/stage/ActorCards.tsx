/**
 * 角色卡片行：每个角色一张按钮卡（头像 + 名称 + agent 标签 + 状态 + 当前活动
 * + 上下文 tokens + 花费）。选中卡与场景选中同步。
 */
import { formatUsd } from "../format";
import { compactNumber } from "../components/usageFormat";
import type { StageActor, StageActorState } from "../types";
import { charFor, type StagePrefs } from "./prefs";
import { CharacterAvatar } from "./StageCanvas";
import { STATE_WORD } from "./stateWords";

/** statusText 是否与状态词重复（或只是它的同义补充）。 */
function redundant(state: StageActorState, statusText: string): boolean {
  if (statusText === STATE_WORD[state]) return true;
  return (state === "done" && statusText === "已结束") || (state === "idle" && statusText === "待命");
}

export interface ActorCardsProps {
  actors: StageActor[];
  prefs: StagePrefs;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 键盘 ←/→ 在其中移动。 */
  onMove: (delta: number) => void;
}

export function ActorCards({ actors, prefs, selectedId, onSelect, onMove }: ActorCardsProps) {
  return (
    <div
      className="stage-cards"
      role="group"
      aria-label="角色卡片"
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onMove(e.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      {actors.map((actor) => {
        const charId = charFor(prefs, actor);
        const active = actor.id === selectedId;
        const stateClass = `stage-card stage-card-${actor.state}${active ? " stage-card-active" : ""}`;
        return (
          <button
            key={actor.id}
            type="button"
            className={stateClass}
            aria-pressed={active}
            onClick={() => onSelect(active ? null : actor.id)}
          >
            <span className="stage-card-top">
              <CharacterAvatar charId={charId} />
              <span className="stage-card-name">
                {actor.name}
                {actor.agent !== null ? <span className="stage-chip">{actor.agent}</span> : null}
              </span>
            </span>
            <span className="stage-card-state">
              {STATE_WORD[actor.state]}
              {/* 后端 statusText 常常就是状态词本身（「已结束」「待命」），不重复显示。 */}
              {actor.statusText !== null && !redundant(actor.state, actor.statusText) ? (
                <span className="stage-card-note"> · {actor.statusText}</span>
              ) : null}
            </span>
            <span className="stage-card-line">{actor.current?.text ?? actor.brief ?? "—"}</span>
            <span className="stage-card-foot">
              <span className="stage-mono">{compactNumber(actor.contextTokens)}</span>
              <span className="stage-mono">{formatUsd(actor.cost)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
