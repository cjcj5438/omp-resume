/**
 * Agent 库：列出 omp 里真实存在的 agent（内置 + 自定义）与本次舞台出现的 agent，
 * 每个可指定像素形象（只存本应用 localStorage），并只读展示它的配置。
 *
 * 不写任何 omp 配置：这里没有保存/修改 agent 定义的入口。
 */
import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/ui";
import { AGENT_INFO } from "../roleCards";
import type { AgentDetail, ModelConfig } from "../types";
import { AgentConfigPanel } from "./AgentConfigPanel";
import type { AgentCatalog } from "./agentCatalog";
import {
  ADVISOR_KEY,
  DEFAULT_AGENT_CHARS,
  MAIN_KEY,
  charForKey,
  saveStagePrefs,
  type StagePrefs,
} from "./prefs";
import { CHARACTER_IDS, CHARACTERS, drawSprite, type CharacterId, type SpritePose } from "./sprites";

const PREVIEW_SCALE = 4;
/** 预览动画帧轮换间隔。 */
const PREVIEW_FRAME_MS = 400;
const PREVIEW_POSES: SpritePose[] = ["idle", "walkA", "walkB"];

function CharacterTile({ charId, frame }: { charId: CharacterId; frame: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    drawSprite(
      ctx,
      charId,
      PREVIEW_POSES[frame % PREVIEW_POSES.length],
      "none",
      34,
      74,
      PREVIEW_SCALE,
    );
  }, [charId, frame]);
  return <canvas ref={ref} width={68} height={74} aria-hidden="true" />;
}

/** 条目清单：主会话 → 全部 agent 定义 → 本次舞台出现的 agent → 顾问。 */
function libraryKeys(
  details: AgentDetail[],
  config: ModelConfig | null,
  stageAgents: readonly string[],
): string[] {
  const catalogKeys =
    details.length > 0
      ? details.map((d) => d.name)
      : config !== null && config.agents.length > 0
        ? config.agents.map((a) => a.name)
        : Object.keys(DEFAULT_AGENT_CHARS).filter(
            (key) => key !== MAIN_KEY && key !== ADVISOR_KEY,
          );
  const ordered = [MAIN_KEY, ...catalogKeys, ...stageAgents, ADVISOR_KEY];
  return [...new Set(ordered)];
}

export interface AgentLibraryProps {
  prefs: StagePrefs;
  onChange: (next: StagePrefs) => void;
  onClose: () => void;
  catalog: AgentCatalog;
  /** 本次舞台出现的 agent 键（可能含自定义 agent）。 */
  stageAgents: string[];
}

export function AgentLibrary({
  prefs,
  onChange,
  onClose,
  catalog,
  stageAgents,
}: AgentLibraryProps) {
  const [frame, setFrame] = useState(0);
  const keys = libraryKeys(catalog.details, catalog.config, stageAgents);
  const [picked, setPicked] = useState<string>(keys[0] ?? MAIN_KEY);
  useEffect(() => {
    const timer = window.setInterval(() => setFrame((f) => f + 1), PREVIEW_FRAME_MS);
    return () => window.clearInterval(timer);
  }, []);

  const update = (next: StagePrefs) => {
    saveStagePrefs(next);
    onChange(next);
  };
  const setChar = (key: string, charId: CharacterId) => {
    update({ chars: { ...prefs.chars, [key]: charId } });
  };
  const resetChar = (key: string) => {
    const chars = { ...prefs.chars };
    delete chars[key];
    update({ chars });
  };

  const current = keys.includes(picked) ? picked : (keys[0] ?? MAIN_KEY);
  const overridden = prefs.chars[current] !== undefined;

  return (
    <Modal
      title="Agent 库"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="stage-lib">
        <p className="stage-lib-hint">
          形象只保存在本应用，不修改 omp 配置；agent 配置为只读展示。
        </p>
        <div className="stage-lib-split">
          <div className="stage-lib-list" aria-label="agent 列表">
            {keys.map((key) => {
              const label = AGENT_INFO[key]?.label ?? (key === MAIN_KEY ? "主会话" : key === ADVISOR_KEY ? "顾问" : "自定义");
              return (
                <button
                  key={key}
                  type="button"
                  className={
                    key === current ? "stage-lib-row stage-lib-row-active" : "stage-lib-row"
                  }
                  aria-pressed={key === current}
                  onClick={() => setPicked(key)}
                >
                  <CharacterTile charId={charForKey(prefs, key)} frame={frame} />
                  <span className="stage-lib-row-text">
                    <span className="mono">{key}</span>
                    <span className="muted">{label}</span>
                    <span className="muted">
                      形象：{CHARACTERS[charForKey(prefs, key)].name}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="stage-lib-detail">
            <label className="stage-lib-field">
              <span>形象</span>
              <select
                className="filter-input"
                aria-label={`${current} 的形象`}
                value={charForKey(prefs, current)}
                onChange={(e) => setChar(current, e.target.value as CharacterId)}
              >
                {CHARACTER_IDS.map((id) => (
                  <option key={id} value={id}>
                    {CHARACTERS[id].name}
                  </option>
                ))}
              </select>
            </label>
            {overridden ? (
              <button type="button" className="btn btn-small" onClick={() => resetChar(current)}>
                恢复默认形象
              </button>
            ) : null}
            <AgentConfigPanel entryKey={current} actor={null} catalog={catalog} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
