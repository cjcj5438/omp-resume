/**
 * 会话备注（alias / tags / note）的批量写入封装。
 *
 * 后端 `set_session_meta` 是**整条替换 + revision 乐观锁**：每次写入都必须
 * 带回最新 revision，并且必须保留本次没改动的字段（否则会把备注或别名清空）。
 * 批量打标签因此只能串行：一次 `CONFLICT` 就停手，把已完成的进度交给调用方。
 */
import { setSessionMeta } from "./api";
import type { AppError, MetaSnapshot } from "./types";

/** 标签上限（与后端 `meta::TAGS_MAX_COUNT` 一致）。 */
export const TAGS_MAX = 10;

export class MetaBatchError extends Error {
  constructor(
    /** 最后一次成功写入后的快照（失败那次没生效）。 */
    public readonly snapshot: MetaSnapshot,
    /** 已成功写入的会话数。 */
    public readonly updated: number,
    public readonly cause: AppError,
  ) {
    super(cause.message);
    this.name = "MetaBatchError";
  }
}

/** 写入别名（`null` = 清除），保留标签与备注。 */
export async function writeAlias(
  snapshot: MetaSnapshot,
  id: string,
  alias: string | null,
): Promise<MetaSnapshot> {
  const entry = snapshot.sessions[id] ?? null;
  const trimmed = alias === null ? null : alias.trim();
  const nextAlias = trimmed !== null && trimmed.length > 0 ? trimmed : null;
  // 整条替换语义：未改动的 tags / note 必须回传原值。
  return setSessionMeta(
    id,
    { alias: nextAlias, tags: entry?.tags ?? [], note: entry?.note ?? null },
    snapshot.revision,
  );
}

/**
 * 批量加/移除标签：串行写、每次用上一次返回的 revision，并保留别名与备注。
 *
 * 跳过（计入 `skipped`）的情况：标签无变化；要加标签但会话已有 10 个。
 * 中途失败抛 [`MetaBatchError`]，带最后一次成功的快照与已更新数量。
 */
export async function applyTag(
  snapshot: MetaSnapshot,
  ids: string[],
  tag: string,
  on: boolean,
): Promise<{ snapshot: MetaSnapshot; updated: number; skipped: number }> {
  const wanted = tag.trim();
  const lower = wanted.toLowerCase();
  let current = snapshot;
  let updated = 0;
  let skipped = 0;
  for (const id of ids) {
    const entry = current.sessions[id] ?? null;
    const tags = entry?.tags ?? [];
    const has = tags.some((t) => t.toLowerCase() === lower);
    if (on === has) {
      skipped += 1;
      continue;
    }
    if (on && tags.length >= TAGS_MAX) {
      skipped += 1;
      continue;
    }
    const nextTags = on ? [...tags, wanted] : tags.filter((t) => t.toLowerCase() !== lower);
    try {
      current = await setSessionMeta(
        id,
        { alias: entry?.alias ?? null, tags: nextTags, note: entry?.note ?? null },
        current.revision,
      );
    } catch (e: unknown) {
      throw new MetaBatchError(current, updated, e as AppError);
    }
    updated += 1;
  }
  return { snapshot: current, updated, skipped };
}
