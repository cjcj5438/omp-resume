import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import type { ProjectGroup } from "../types";
import { Ico } from "./ui";

interface SessionGroupToggleProps {
  groups: readonly ProjectGroup[];
  collapsed: ReadonlySet<string>;
  onSetGroupsOpen: (cwds: readonly string[], open: boolean) => void;
  className: string;
}

export function SessionGroupToggle({ groups, collapsed, onSetGroupsOpen, className }: SessionGroupToggleProps) {
  const hasOpenGroup = groups.some((group) => !collapsed.has(group.cwd));
  const label = hasOpenGroup ? "折叠全部" : "展开全部";

  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      disabled={groups.length === 0}
      onClick={() => onSetGroupsOpen(groups.map((group) => group.cwd), !hasOpenGroup)}
    >
      <Ico icon={hasOpenGroup ? ChevronsDownUp : ChevronsUpDown} size={14} />
    </button>
  );
}
