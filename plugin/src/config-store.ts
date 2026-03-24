import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type ExactRule = {
  id: number;
  keywords: string[];
  target: string; // alias or "provider/model"
};

export type FuzzyRule = {
  id: number;
  text: string;
};

export type ModelRef = {
  provider: string;
  model: string;
};

export type ConfigData = {
  exactRules: ExactRule[];
  fuzzyRules: FuzzyRule[];
  aliases: Record<string, ModelRef>;
};

// ── Load / Save ─────────────────────────────────────────────────────────────

export function loadConfigSync(filePath: string): ConfigData {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return {
      exactRules: Array.isArray(data?.exactRules) ? data.exactRules : [],
      fuzzyRules: Array.isArray(data?.fuzzyRules) ? data.fuzzyRules : [],
      aliases: data?.aliases && typeof data.aliases === "object" ? data.aliases : {},
    };
  } catch {
    return { exactRules: [], fuzzyRules: [], aliases: {} };
  }
}

function save(filePath: string, data: ConfigData): void {
  // Keep rule IDs contiguous and aligned with list order so `/route ls`
  // numbering always matches subsequent `/route rm <id>` operations.
  data.exactRules = data.exactRules.map((rule, index) => ({ ...rule, id: index + 1 }));
  data.fuzzyRules = data.fuzzyRules.map((rule, index) => ({ ...rule, id: index + 1 }));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Next ID ─────────────────────────────────────────────────────────────────

function nextId(items: { id: number }[]): number {
  if (items.length === 0) return 1;
  return Math.max(...items.map((r) => r.id)) + 1;
}

// ── Exact Rules ─────────────────────────────────────────────────────────────

export function addExactRule(filePath: string, keywords: string[], target: string): ExactRule {
  const data = loadConfigSync(filePath);
  const rule: ExactRule = { id: nextId(data.exactRules), keywords, target };
  data.exactRules.push(rule);
  save(filePath, data);
  return rule;
}

export function removeExactRule(filePath: string, id: number): boolean {
  const data = loadConfigSync(filePath);
  const index = data.exactRules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  data.exactRules.splice(index, 1);
  save(filePath, data);
  return true;
}

// ── Fuzzy Rules ─────────────────────────────────────────────────────────────

export function addFuzzyRule(filePath: string, text: string): FuzzyRule {
  const data = loadConfigSync(filePath);
  const rule: FuzzyRule = { id: nextId(data.fuzzyRules), text };
  data.fuzzyRules.push(rule);
  save(filePath, data);
  return rule;
}

export function removeFuzzyRule(filePath: string, id: number): boolean {
  const data = loadConfigSync(filePath);
  const index = data.fuzzyRules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  data.fuzzyRules.splice(index, 1);
  save(filePath, data);
  return true;
}

// ── Aliases ─────────────────────────────────────────────────────────────────

export function setAlias(filePath: string, name: string, ref: ModelRef): void {
  const data = loadConfigSync(filePath);
  data.aliases[name.toLowerCase()] = ref;
  save(filePath, data);
}

export function removeAlias(filePath: string, name: string): boolean {
  const data = loadConfigSync(filePath);
  const key = name.toLowerCase();
  if (!(key in data.aliases)) return false;
  delete data.aliases[key];
  save(filePath, data);
  return true;
}

// ── Clear All ───────────────────────────────────────────────────────────────

export function clearAll(filePath: string): void {
  save(filePath, { exactRules: [], fuzzyRules: [], aliases: {} });
}

// ── Resolve Alias ───────────────────────────────────────────────────────────

/**
 * Resolve a target string to a ModelRef.
 * Checks aliases first, then parses "provider/model" format.
 * Returns null if unresolvable.
 */
export function resolveTarget(target: string, aliases: Record<string, ModelRef>): ModelRef | null {
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) return null;

  // Check alias
  if (trimmed in aliases) {
    return aliases[trimmed];
  }

  // Parse provider/model
  if (trimmed.includes("/")) {
    const slashIdx = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slashIdx).trim();
    const model = trimmed.slice(slashIdx + 1).trim();
    if (provider && model) return { provider, model };
  }

  return null;
}

/**
 * Get a display label for a model.
 * Returns the alias name if the target matches an alias, otherwise the model ID.
 */
export function getDisplayLabel(
  ref: ModelRef,
  aliases: Record<string, ModelRef>,
): string {
  for (const [name, aliasRef] of Object.entries(aliases)) {
    if (aliasRef.provider === ref.provider && aliasRef.model === ref.model) {
      return name;
    }
  }
  return ref.model;
}
