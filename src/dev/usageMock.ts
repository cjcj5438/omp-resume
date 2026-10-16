import type { SessionUsage, UsageStats } from "../types";

export const mockSessionUsage: SessionUsage = {
  messages: { user: 24, assistant: 86 },
  tokens: { input: 125400, output: 48700, cacheRead: 920000, cacheWrite: 60300, total: 1154400 },
  cost: { total: 12.84, main: 9.4, background: 1.04, subagent: 2.4 },
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-5", messages: 72, cost: 10.44, tokens: { input: 100000, output: 40000, cacheRead: 800000, cacheWrite: 50000, total: 990000 } },
    { provider: "openai", model: "gpt-5", messages: 18, cost: 2.4, tokens: { input: 25400, output: 8700, cacheRead: 120000, cacheWrite: 10300, total: 164400 } },
  ],
};

export function mockUsageStats(sinceDays: number | null): UsageStats {
  const total = structuredClone(mockSessionUsage);
  const multiplier = sinceDays === null ? 2 : 1;
  total.messages.user *= multiplier;
  total.messages.assistant *= multiplier;
  for (const key of Object.keys(total.tokens) as (keyof typeof total.tokens)[]) total.tokens[key] *= multiplier;
  for (const key of Object.keys(total.cost) as (keyof typeof total.cost)[]) total.cost[key] *= multiplier;
  for (const model of total.models) {
    model.cost *= multiplier;
    model.messages *= multiplier;
    for (const key of Object.keys(model.tokens) as (keyof typeof model.tokens)[]) model.tokens[key] *= multiplier;
  }
  const today = new Date().toLocaleDateString("sv-SE");
  const older = new Date(Date.now() - 45 * 86400000).toLocaleDateString("sv-SE");
  return {
    total,
    byProject: [{ cwd: "/Users/demo/my/omp-resume", cost: mockSessionUsage.cost.total, tokens: mockSessionUsage.tokens, sessions: 5 }, ...(sinceDays === null ? [{ cwd: "/Users/demo/my/api-service", cost: mockSessionUsage.cost.total, tokens: mockSessionUsage.tokens, sessions: 3 }] : [])],
    byModel: total.models,
    byDay: [{ date: today, cost: mockSessionUsage.cost.total, tokens: mockSessionUsage.tokens }, ...(sinceDays === null ? [{ date: older, cost: mockSessionUsage.cost.total, tokens: mockSessionUsage.tokens }] : [])],
  };
}
