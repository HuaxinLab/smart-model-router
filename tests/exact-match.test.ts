import { describe, it, expect } from "vitest";
import { extractExplicitModel, findExactMatch, resolveFromPrompt } from "../plugin/src/exact-match.js";
import type { ExactRule, ModelRef } from "../plugin/src/config-store.js";

describe("extractExplicitModel", () => {
  it("extracts '用xxx模型'", () => {
    expect(extractExplicitModel("用 coder 模型帮我看代码")).toBe("coder");
    expect(extractExplicitModel("用coder模型")).toBe("coder");
  });

  it("extracts '切换到xxx'", () => {
    expect(extractExplicitModel("切换到 claude")).toBe("claude");
    expect(extractExplicitModel("切换到claude")).toBe("claude");
  });

  it("extracts 'use xxx model'", () => {
    expect(extractExplicitModel("use kimi model")).toBe("kimi");
    expect(extractExplicitModel("Use Claude model to help")).toBe("Claude");
  });

  it("extracts '@xxx'", () => {
    expect(extractExplicitModel("@coder 这段代码什么意思")).toBe("coder");
  });

  it("extracts provider/model format", () => {
    expect(extractExplicitModel("用 bailian/qwen3-coder-plus 模型分析")).toBe("bailian/qwen3-coder-plus");
  });

  it("returns null when no explicit model", () => {
    expect(extractExplicitModel("帮我写个排序")).toBeNull();
    expect(extractExplicitModel("今天天气怎么样")).toBeNull();
    expect(extractExplicitModel("")).toBeNull();
  });
});

describe("findExactMatch", () => {
  const rules: ExactRule[] = [
    { id: 1, keywords: ["代码", "code", "bug"], target: "coder" },
    { id: 2, keywords: ["翻译", "translate"], target: "kimi" },
  ];

  it("matches keyword in prompt", () => {
    expect(findExactMatch("这段代码有 bug", rules)?.id).toBe(1);
    expect(findExactMatch("帮我翻译这篇文章", rules)?.id).toBe(2);
  });

  it("matches case-insensitively", () => {
    expect(findExactMatch("Fix this BUG", rules)?.id).toBe(1);
    expect(findExactMatch("Translate this", rules)?.id).toBe(2);
  });

  it("returns first matching rule", () => {
    expect(findExactMatch("翻译这段代码", rules)?.id).toBe(1); // "代码" in rule 1 matches first
  });

  it("returns null when no match", () => {
    expect(findExactMatch("今天天气怎么样", rules)).toBeNull();
    expect(findExactMatch("", rules)).toBeNull();
  });
});

describe("resolveFromPrompt", () => {
  const rules: ExactRule[] = [
    { id: 1, keywords: ["代码", "code"], target: "coder" },
  ];
  const aliases: Record<string, ModelRef> = {
    coder: { provider: "bailian", model: "qwen3-coder-plus" },
    claude: { provider: "anthropic", model: "claude-sonnet-4-6" },
  };

  it("explicit model takes priority over keyword match", () => {
    const result = resolveFromPrompt("用 claude 模型看这段代码", rules, aliases);
    expect(result?.source).toBe("explicit");
    expect(result?.ref.provider).toBe("anthropic");
  });

  it("falls back to keyword match", () => {
    const result = resolveFromPrompt("这段代码有问题", rules, aliases);
    expect(result?.source).toBe("exact");
    expect(result?.ref.provider).toBe("bailian");
  });

  it("returns null when nothing matches", () => {
    expect(resolveFromPrompt("今天天气", rules, aliases)).toBeNull();
  });
});
