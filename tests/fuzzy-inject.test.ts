import { describe, it, expect } from "vitest";
import { buildFuzzyPrompt } from "../plugin/src/fuzzy-inject.js";

describe("buildFuzzyPrompt", () => {
  it("returns empty string when no rules", () => {
    expect(buildFuzzyPrompt([])).toBe("");
  });

  it("builds Chinese prompt with rules", () => {
    const rules = [
      { id: 1, text: "复杂推理用 anthropic/claude-sonnet-4-6" },
      { id: 2, text: "数据分析用 bailian/kimi-k2.5" },
    ];
    const prompt = buildFuzzyPrompt(rules);

    expect(prompt).toContain("模型路由规则");
    expect(prompt).toContain("1. 复杂推理用 anthropic/claude-sonnet-4-6");
    expect(prompt).toContain("2. 数据分析用 bailian/kimi-k2.5");
    expect(prompt).toContain("sessions_spawn");
    expect(prompt).toContain("你自己回答");
  });

  it("uses strict tone", () => {
    const prompt = buildFuzzyPrompt([{ id: 1, text: "test" }]);
    expect(prompt).not.toContain("MUST");
    expect(prompt).toContain("必须");
    expect(prompt).not.toContain("可选");
  });
});
