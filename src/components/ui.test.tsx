/** SessionBadges 占用者后缀单测：有应用名时徽章带后缀，无则保持原样。 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionSummary } from "../types";
import { SessionBadges } from "./ui";

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "s",
    path: "/p/s.jsonl",
    cwd: "/w/p",
    cwdExists: true,
    title: "t",
    createdAt: "2026-10-14T00:00:00.000Z",
    modifiedAt: "2026-10-14T00:00:00.000Z",
    sizeBytes: 1,
    messageCount: 1,
    branchCount: 1,
    inUse: true,
    probeOk: true,
    occupant: null,
    fork: null,
    formatSupported: true,
    version: 3,
    badLines: 0,
    firstUserMessage: null,
    ...over,
  };
}

describe("SessionBadges 占用者", () => {
  it("有应用名时徽章为“使用中 · 应用”", () => {
    render(
      <SessionBadges
        s={summary({ occupant: { pid: 3074, app: "VS Code", appVersion: "1.138.0" } })}
      />,
    );
    expect(screen.getByText("使用中 · VS Code")).toBeTruthy();
  });

  it("有 PID 但无应用名时徽章保持“使用中”原样", () => {
    render(
      <SessionBadges s={summary({ occupant: { pid: 99, app: null, appVersion: null } })} />,
    );
    expect(screen.getByText("使用中", { exact: true })).toBeTruthy();
  });

  it("非占用会话不渲染使用中徽章（occupant 字段被忽略）", () => {
    const { container } = render(
      <SessionBadges
        s={summary({
          inUse: false,
          occupant: { pid: 99, app: "iTerm2", appVersion: null },
        })}
      />,
    );
    expect(container.textContent).not.toContain("使用中");
  });
});
