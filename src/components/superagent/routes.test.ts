/** Superagent 三页进导航与命令面板（空查询列全部页，非空按 label 匹配）。 */
import { describe, expect, it } from "vitest";
import { paletteItems } from "../../palette";

describe("Superagent 页面可发现", () => {
  it("空查询包含三页", () => {
    const pages = paletteItems("", [], null).filter((i) => i.kind === "page");
    const routes = pages.map((p) => (p.kind === "page" ? p.route : ""));
    expect(routes).toContain("superagent");
    expect(routes).toContain("superagent-sessions");
    expect(routes).toContain("superagent-service");
  });

  it("搜「服务」命中服务页", () => {
    const hits = paletteItems("服务", [], null).filter((i) => i.kind === "page");
    expect(hits.map((p) => (p.kind === "page" ? p.route : ""))).toContain("superagent-service");
  });

  it("搜「会话」命中 Superagent 会话页且不只命中主会话页", () => {
    const hits = paletteItems("会话", [], null)
      .filter((i) => i.kind === "page")
      .map((p) => (p.kind === "page" ? p.route : ""));
    expect(hits).toContain("superagent-sessions");
  });
});
