/** DeleteDialog 变体单测：「无法删除」与 cleanup。 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DeleteDialog } from "./DeleteDialog";
import type { DeleteTarget } from "../flows";

const noop = () => {};
const target = (over: Partial<DeleteTarget> = {}): DeleteTarget => ({
  path: "/s/a.jsonl",
  id: "a",
  title: "会话 A",
  cwd: "/Users/demo/my/omp-resume",
  sizeBytes: 1024,
  messageCount: 8,
  inUse: false,
  ...over,
});

describe("DeleteDialog 无法删除变体", () => {
  it("全在用时单按钮「知道了」，无删除键", () => {
    render(
      <DeleteDialog
        targets={[target({ inUse: true }), target({ path: "/s/b.jsonl", id: "b", title: "会话 B", inUse: true })]}
        requestDelete={async () => []}
        onClose={noop}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("无法删除");
    expect(screen.getByRole("button", { name: "知道了" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "永久删除" })).toBeNull();
  });
});

describe("DeleteDialog cleanup 变体", () => {
  it("kv 四行 + 确认「删除 N 项」+ warn note", async () => {
    const requestDelete = vi.fn(async () => []);
    render(
      <DeleteDialog
        targets={[target()]}
        requestDelete={requestDelete}
        onClose={noop}
        variant="cleanup"
        cleanup={{ count: 3, bytes: 12 * 1024 * 1024, excluded: 1 }}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("删除清理候选");
    expect(dialog).toHaveTextContent("3 项");
    expect(dialog).toHaveTextContent("12.0 MB");
    expect(dialog).toHaveTextContent("占用中已排除");
    expect(dialog).toHaveTextContent("1 项");
    expect(dialog).toHaveTextContent("不可用");
    const confirm = screen.getByRole("button", { name: "删除 3 项" });
    fireEvent.click(confirm);
    expect(requestDelete).toHaveBeenCalledTimes(1);
  });
});
