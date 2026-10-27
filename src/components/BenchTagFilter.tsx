/**
 * bench 标签筛选行：全部 / 预设标签 / 自定义标签删除 / 添加自定义标签，
 * 以及当前筛选标签的角色指向。
 * 从 ModelTesterPanel.tsx 逐字拆出，无行为变化。
 */
import type { ReactNode } from "react";
import type { BenchTag } from "../modelBench";
import { X } from "lucide-react";
import { Ico } from "./ui";

export interface BenchTagFilterProps {
  tags: BenchTag[];
  tagCounts: Map<string, number>;
  benchCount: number;
  tagFilter: string | null;
  filterTag: BenchTag | null;
  filterCurrent: unknown;
  onFilter: (tag: string | null) => void;
  onRemoveCustomTag: (tag: string) => void;
  onAddTag: () => void;
}

export function BenchTagFilter(props: BenchTagFilterProps): ReactNode {
  const { tags, tagCounts, benchCount, tagFilter, filterTag, filterCurrent, onFilter, onRemoveCustomTag, onAddTag } = props;
  return (
    <>
      <div className="bench-chips" role="group" aria-label="按标签筛选">
        <button
          type="button"
          className={tagFilter === null ? "tag-chip tag-chip-on" : "tag-chip"}
          aria-pressed={tagFilter === null}
          onClick={() => onFilter(null)}
        >
          全部 <span className="tag-count">{benchCount}</span>
        </button>
        {tags.map((t) => (
          <span key={t.id} className="bench-chipwrap">
            <button
              type="button"
              className={tagFilter === t.id ? "tag-chip tag-chip-on" : "tag-chip"}
              aria-pressed={tagFilter === t.id}
              title={t.unused ? `写入 modelRoles.${t.id}；在『Agent』页把 agent 设为 @${t.id} 后生效` : undefined}
              onClick={() => onFilter(tagFilter === t.id ? null : t.id)}
            >
              {t.label} <span className="tag-count">{tagCounts.get(t.id) ?? 0}</span>
              {t.unused ? <span className="badge badge-grey">未使用</span> : null}
            </button>
            {t.custom ? (
              <button
                type="button"
                className="btn btn-small bench-chip-x"
                aria-label={`删除自定义标签 ${t.id}`}
                title={`删除自定义标签 ${t.id}`}
                onClick={() => onRemoveCustomTag(t.id)}
              >
                <Ico icon={X} size={12} />
              </button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          className="tag-chip"
          aria-label="添加自定义标签"
          onClick={onAddTag}
        >
          +
        </button>
      </div>
      {filterTag !== null ? (
        <div className="muted bench-current">
          当前 {filterTag.label} →{" "}
          <span className="mono">{typeof filterCurrent === "string" ? filterCurrent : "未设置"}</span>
        </div>
      ) : null}
    </>
  );
}
