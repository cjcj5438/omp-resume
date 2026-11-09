import type { SessionUsage } from "../types";

export const mockSessionUsage: SessionUsage = {
  messages: { user: 24, assistant: 86 },
  tokens: { input: 125400, output: 48700, cacheRead: 920000, cacheWrite: 60300, total: 1154400 },
  cost: { total: 12.84, main: 9.4, background: 1.04, subagent: 2.4 },
  models: [
    { provider: "anthropic", model: "claude-sonnet-4-5", messages: 72, cost: 10.44, tokens: { input: 100000, output: 40000, cacheRead: 800000, cacheWrite: 50000, total: 990000 } },
    { provider: "openai", model: "gpt-5", messages: 18, cost: 2.4, tokens: { input: 25400, output: 8700, cacheRead: 120000, cacheWrite: 10300, total: 164400 } },
  ],
};
