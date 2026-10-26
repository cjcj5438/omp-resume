/** 角色状态的中文词（卡片、悬停提示、活动流、读屏播报共用一份）。 */
import type { StageActorState } from "../types";

export const STATE_WORD: Record<StageActorState, string> = {
  queued: "排队中",
  running: "运行中",
  idle: "待命",
  done: "已完成",
  failed: "失败",
  lost: "失联",
};
