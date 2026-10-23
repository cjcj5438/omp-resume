import { beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TreeView } from "./TreeView";
import { FIXTURE_SESSIONS } from "../dev/fixtures";
import type { Conversation } from "../types";

beforeEach(() => {
  clearMocks();
});

const noop = () => {};

it("快速切节点预览跟随最后选中", async () => {
  // s5：分支树，节点 bx-c2 与 bx-d1 可点。
  const s5 = FIXTURE_SESSIONS[4];
  const slow = Promise.withResolvers<Conversation>();
  mockIPC((cmd, args) => {
    if (cmd === "get_tree") return s5.tree;
    if (cmd === "get_conversation" && args && typeof args === "object" && "nodeId" in args && args.nodeId === "bx-c2") return slow.promise;
    if (cmd === "get_conversation") {
      return { path: s5.summary.path, leafId: s5.tree.leafId, targetId: "bx-d1", items: [{ kind: "user", text: "快节点预览内容" }] };
    }
    throw `no handler for ${cmd}`;
  });
  render(<TreeView session={s5.summary} onContinue={async () => ({ notice: null })} refreshKey={0} onToast={noop} />);
  // 树加载完后自动选中叶子节点；先切到慢节点，再切到快节点。
  const items = await screen.findAllByRole("treeitem");
  expect(items.length).toBeGreaterThan(1);
  const byText = (t: string) => {
    const el = screen.getByText(t).closest("[role=treeitem]");
    if (!el) throw new Error(`缺少节点行：${t}`);
    return el;
  };
  fireEvent.click(byText("方案A：中间件实现…"));
  fireEvent.click(byText("已压缩：项目结构与鉴权方案…"));
  expect(await screen.findByText("快节点预览内容")).toBeTruthy();
  slow.resolve({ path: s5.summary.path, leafId: s5.tree.leafId, targetId: "bx-c2", items: [{ kind: "user", text: "慢节点预览内容" }] });
  await waitFor(() => expect(screen.queryByText("慢节点预览内容")).toBeNull());
});
