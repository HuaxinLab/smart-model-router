import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfigSync,
  addExactRule,
  removeExactRule,
  addFuzzyRule,
  removeFuzzyRule,
  setAlias,
  removeAlias,
  clearAll,
  resolveTarget,
  getDisplayLabel,
} from "../plugin/src/config-store.js";

let tempDir: string;
let configPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "smr-test-"));
  configPath = join(tempDir, "config.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConfigSync", () => {
  it("returns empty config when file does not exist", () => {
    const data = loadConfigSync(configPath);
    expect(data.exactRules).toEqual([]);
    expect(data.fuzzyRules).toEqual([]);
    expect(data.aliases).toEqual({});
  });
});

describe("exact rules", () => {
  it("adds and loads exact rules", () => {
    const rule = addExactRule(configPath, ["代码", "code"], "coder");
    expect(rule.id).toBe(1);
    expect(rule.keywords).toEqual(["代码", "code"]);
    expect(rule.target).toBe("coder");

    const data = loadConfigSync(configPath);
    expect(data.exactRules).toHaveLength(1);
    expect(data.exactRules[0].id).toBe(1);
  });

  it("auto-increments IDs", () => {
    addExactRule(configPath, ["a"], "x");
    const rule2 = addExactRule(configPath, ["b"], "y");
    expect(rule2.id).toBe(2);
  });

  it("removes exact rules by ID", () => {
    addExactRule(configPath, ["a"], "x");
    addExactRule(configPath, ["b"], "y");
    expect(removeExactRule(configPath, 1)).toBe(true);
    expect(removeExactRule(configPath, 99)).toBe(false);

    const data = loadConfigSync(configPath);
    expect(data.exactRules).toHaveLength(1);
    expect(data.exactRules[0].id).toBe(2);
  });
});

describe("fuzzy rules", () => {
  it("adds and removes fuzzy rules", () => {
    const rule = addFuzzyRule(configPath, "复杂推理用 claude");
    expect(rule.id).toBe(1);

    const data = loadConfigSync(configPath);
    expect(data.fuzzyRules).toHaveLength(1);

    expect(removeFuzzyRule(configPath, 1)).toBe(true);
    expect(loadConfigSync(configPath).fuzzyRules).toHaveLength(0);
  });
});

describe("aliases", () => {
  it("sets and removes aliases", () => {
    setAlias(configPath, "coder", { provider: "bailian", model: "qwen3-coder-plus" });

    const data = loadConfigSync(configPath);
    expect(data.aliases["coder"]).toEqual({ provider: "bailian", model: "qwen3-coder-plus" });

    expect(removeAlias(configPath, "coder")).toBe(true);
    expect(removeAlias(configPath, "coder")).toBe(false);
    expect(loadConfigSync(configPath).aliases).toEqual({});
  });

  it("normalizes alias names to lowercase", () => {
    setAlias(configPath, "Coder", { provider: "bailian", model: "qwen3-coder-plus" });
    const data = loadConfigSync(configPath);
    expect(data.aliases["coder"]).toBeDefined();
  });
});

describe("clearAll", () => {
  it("clears everything", () => {
    addExactRule(configPath, ["a"], "x");
    addFuzzyRule(configPath, "test");
    setAlias(configPath, "c", { provider: "p", model: "m" });

    clearAll(configPath);
    const data = loadConfigSync(configPath);
    expect(data.exactRules).toEqual([]);
    expect(data.fuzzyRules).toEqual([]);
    expect(data.aliases).toEqual({});
  });
});

describe("resolveTarget", () => {
  const aliases = {
    coder: { provider: "bailian", model: "qwen3-coder-plus" },
    claude: { provider: "anthropic", model: "claude-sonnet-4-6" },
  };

  it("resolves alias", () => {
    expect(resolveTarget("coder", aliases)).toEqual({ provider: "bailian", model: "qwen3-coder-plus" });
  });

  it("resolves alias case-insensitively", () => {
    expect(resolveTarget("Coder", aliases)).toEqual({ provider: "bailian", model: "qwen3-coder-plus" });
  });

  it("resolves provider/model format", () => {
    expect(resolveTarget("ollama/llama3:8b", aliases)).toEqual({ provider: "ollama", model: "llama3:8b" });
  });

  it("returns null for unresolvable target", () => {
    expect(resolveTarget("unknown", aliases)).toBeNull();
    expect(resolveTarget("", aliases)).toBeNull();
  });
});

describe("getDisplayLabel", () => {
  const aliases = {
    coder: { provider: "bailian", model: "qwen3-coder-plus" },
  };

  it("returns alias name when matching", () => {
    expect(getDisplayLabel({ provider: "bailian", model: "qwen3-coder-plus" }, aliases)).toBe("coder");
  });

  it("returns model name when no alias matches", () => {
    expect(getDisplayLabel({ provider: "anthropic", model: "claude-sonnet-4-6" }, aliases)).toBe("claude-sonnet-4-6");
  });
});
