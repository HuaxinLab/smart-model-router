import type { ExactRule, ModelRef } from "./config-store.js";
import { resolveTarget } from "./config-store.js";

// ── Extract User Message ────────────────────────────────────────────────────

/**
 * Extract the user's actual message from the full prompt.
 * The prompt format is: system prefix + metadata + user message at the end.
 * User message starts after the last double-newline following the metadata block.
 */
export function extractUserMessage(prompt: string): string {
  // The prompt contains "```json\n{...}\n```\n\n" blocks for metadata,
  // then the user message at the very end.
  // Find the last ``` block end, then take everything after the next \n\n
  const lastCodeBlockEnd = prompt.lastIndexOf("```");
  if (lastCodeBlockEnd !== -1) {
    const afterCodeBlock = prompt.slice(lastCodeBlockEnd + 3);
    const trimmed = afterCodeBlock.replace(/^\s*\n\n/, "");
    if (trimmed) return trimmed;
  }
  // Fallback: take the last paragraph
  const parts = prompt.split("\n\n");
  return parts[parts.length - 1] || prompt;
}

// ── User Explicit Model Request ─────────────────────────────────────────────

/**
 * Extract model name from user message when they explicitly request a model.
 * Supports: "用xxx模型", "切换到xxx", "use xxx model", "@xxx"
 */
const EXPLICIT_MODEL_RE =
  /用\s*([\w/.:-]+)\s*模型|切换到?\s*([\w/.:-]+)|use\s+([\w/.:-]+)\s*model?|@([\w/.:-]+)/i;

export function extractExplicitModel(prompt: string): string | null {
  const match = prompt.match(EXPLICIT_MODEL_RE);
  if (!match) return null;
  const raw = (match[1] || match[2] || match[3] || match[4] || "").trim();
  return raw || null;
}

// ── Keyword Exact Match ─────────────────────────────────────────────────────

/**
 * Find the first exact rule whose keywords match the prompt.
 * Case-insensitive matching.
 */
export function findExactMatch(
  prompt: string,
  rules: ExactRule[],
): ExactRule | null {
  const lower = prompt.toLowerCase();
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

// ── Combined Resolution ─────────────────────────────────────────────────────

export type MatchResult = {
  ref: ModelRef;
  label: string;
  source: "explicit" | "exact";
};

/**
 * Try to resolve a model from the prompt.
 * Priority: user explicit > keyword exact match.
 * Returns null if no match.
 */
export function resolveFromPrompt(
  prompt: string,
  rules: ExactRule[],
  aliases: Record<string, ModelRef>,
): MatchResult | null {
  // Extract only the user's message, not system metadata or subagent results
  const userMessage = extractUserMessage(prompt);

  // 1. User explicit: "用xxx模型"
  const explicit = extractExplicitModel(userMessage);
  if (explicit) {
    const ref = resolveTarget(explicit, aliases);
    if (ref) {
      return { ref, label: explicit, source: "explicit" };
    }
  }

  // 2. Keyword exact match
  const rule = findExactMatch(userMessage, rules);
  if (rule) {
    const ref = resolveTarget(rule.target, aliases);
    if (ref) {
      return { ref, label: rule.target, source: "exact" };
    }
  }

  return null;
}
