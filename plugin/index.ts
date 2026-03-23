import { join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync } from "node:fs";

const DBG_PATH = join(homedir(), ".openclaw", "plugins", "smart-model-router", "debug.log");
function dbg(msg: string) {
  try {
    mkdirSync(join(homedir(), ".openclaw", "plugins", "smart-model-router"), { recursive: true });
    appendFileSync(DBG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
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
} from "./src/config-store.js";
import type { ConfigData, ModelRef } from "./src/config-store.js";
import { resolveFromPrompt } from "./src/exact-match.js";
import type { MatchResult } from "./src/exact-match.js";
import { buildFuzzyPrompt } from "./src/fuzzy-inject.js";

type SessionState = {
  currentMatchResult: MatchResult | null;
  delegatedThisRound: boolean;
  delegatedModelName: string;
};

const SESSION_FALLBACK_KEY = "__global__";
const sessionStateMap = new Map<string, SessionState>();
let pendingDelegatedLabel = "";
let pendingDelegatedUntil = 0;

const CONFIG_PATH = join(
  homedir(),
  ".openclaw",
  "plugins",
  "smart-model-router",
  "config.json",
);

// ── Parse Separator ─────────────────────────────────────────────────────────

/** Split a string by "=" or "->" separator. Returns [left, right] or null. */
function splitBySeparator(text: string): [string, string] | null {
  // Try -> first (longer match)
  const arrowIdx = text.indexOf("->");
  if (arrowIdx !== -1) {
    return [text.slice(0, arrowIdx).trim(), text.slice(arrowIdx + 2).trim()];
  }
  // Then =
  const eqIdx = text.indexOf("=");
  if (eqIdx !== -1) {
    return [text.slice(0, eqIdx).trim(), text.slice(eqIdx + 1).trim()];
  }
  return null;
}

// ── Format Helpers ──────────────────────────────────────────────────────────

function formatExactRule(rule: { id: number; keywords: string[]; target: string }): string {
  return `  ${rule.id}. [${rule.keywords.join(", ")}] = ${rule.target}`;
}

function formatFuzzyRule(rule: { id: number; text: string }): string {
  return `  ${rule.id}. ${rule.text}`;
}

function formatAlias(name: string, ref: ModelRef): string {
  return `  ${name} = ${ref.provider}/${ref.model}`;
}

// ── Command Handler ─────────────────────────────────────────────────────────

function handleRouteCommand(
  args: string,
  cache: { data: ConfigData; fuzzyPrompt: string },
  getModels?: () => string[],
): { text: string } {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (sub.toLowerCase()) {
    // ── /route models ───────────────────────────────────────────────
    case "models": {
      if (!getModels) return { text: "无法获取模型列表" };
      const models = getModels();
      if (models.length === 0) return { text: "未找到可用模型。请检查 openclaw.json 的 models.providers 配置。" };
      return { text: `可用模型：\n${models.map((m) => `  ${m}`).join("\n")}` };
    }

    // ── /route add <keywords> = <target> ────────────────────────────
    case "add": {
      if (!rest) {
        return { text: "用法: /route add 关键词1,关键词2 = 模型别名\n示例: /route add 代码,code,bug = coder" };
      }
      const parts = splitBySeparator(rest);
      if (!parts || !parts[0] || !parts[1]) {
        return { text: "格式错误，需要用 = 或 -> 分隔关键词和目标模型\n示例: /route add 代码,code = coder" };
      }
      const keywords = parts[0].split(",").map((k) => k.trim()).filter(Boolean);
      if (keywords.length === 0) {
        return { text: "至少需要一个关键词" };
      }
      const target = parts[1];
      const rule = addExactRule(CONFIG_PATH, keywords, target);
      refreshCache(cache);
      return { text: `已添加精确规则 #${rule.id}: [${keywords.join(", ")}] = ${target}` };
    }

    // ── /route ai <text> ────────────────────────────────────────────
    case "ai": {
      if (!rest) {
        return { text: "用法: /route ai 规则描述\n示例: /route ai 复杂推理任务用 claude" };
      }
      const rule = addFuzzyRule(CONFIG_PATH, rest);
      refreshCache(cache);
      return { text: `已添加模糊规则 #${rule.id}: ${rest}` };
    }

    // ── /route as <alias>=<provider/model> ──────────────────────────
    case "as": {
      if (!rest) {
        return { text: "用法: /route as 别名=provider/model\n示例: /route as coder=bailian/qwen3-coder-plus" };
      }
      const parts = splitBySeparator(rest);
      if (!parts || !parts[0] || !parts[1]) {
        return { text: "格式错误，需要用 = 或 -> 分隔别名和模型\n示例: /route as coder=bailian/qwen3-coder-plus" };
      }
      const aliasName = parts[0].toLowerCase();
      const modelStr = parts[1];
      if (!modelStr.includes("/")) {
        return { text: "模型 ID 需要包含 provider 前缀\n格式: provider/model\n示例: bailian/qwen3-coder-plus" };
      }
      const slashIdx = modelStr.indexOf("/");
      const ref: ModelRef = {
        provider: modelStr.slice(0, slashIdx).trim(),
        model: modelStr.slice(slashIdx + 1).trim(),
      };
      setAlias(CONFIG_PATH, aliasName, ref);
      refreshCache(cache);
      return { text: `已设置别名: ${aliasName} = ${ref.provider}/${ref.model}` };
    }

    // ── /route ls ───────────────────────────────────────────────────
    case "ls":
    case "list": {
      const lines: string[] = [];
      if (cache.data.exactRules.length > 0) {
        lines.push("精确规则：");
        cache.data.exactRules.forEach((r) => lines.push(formatExactRule(r)));
      }
      if (cache.data.fuzzyRules.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("模糊规则（AI 判断）：");
        cache.data.fuzzyRules.forEach((r) => lines.push(formatFuzzyRule(r)));
      }
      if (Object.keys(cache.data.aliases).length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("别名：");
        for (const [name, ref] of Object.entries(cache.data.aliases)) {
          lines.push(formatAlias(name, ref));
        }
      }
      if (lines.length === 0) {
        return { text: "暂无规则和别名。\n用 /route add 添加精确规则\n用 /route as 设置别名\n用 /route ai 添加模糊规则" };
      }
      return { text: lines.join("\n") };
    }

    // ── /route rm ───────────────────────────────────────────────────
    case "rm":
    case "remove": {
      if (!rest) {
        return { text: "用法:\n  /route rm <编号>        删除精确规则\n  /route rm ai <编号>     删除模糊规则\n  /route rm as <别名>     删除别名" };
      }
      const rmParts = rest.split(/\s+/);
      // /route rm ai <id>
      if (rmParts[0] === "ai") {
        const id = parseInt(rmParts[1], 10);
        if (isNaN(id)) return { text: "用法: /route rm ai <编号>" };
        const removed = removeFuzzyRule(CONFIG_PATH, id);
        if (removed) refreshCache(cache);
        return { text: removed ? `已删除模糊规则 #${id}` : `未找到模糊规则 #${id}` };
      }
      // /route rm as <name>
      if (rmParts[0] === "as") {
        const name = rmParts[1];
        if (!name) return { text: "用法: /route rm as <别名>" };
        const removed = removeAlias(CONFIG_PATH, name);
        if (removed) refreshCache(cache);
        return { text: removed ? `已删除别名: ${name}` : `未找到别名: ${name}` };
      }
      // /route rm <id> (exact rule)
      const id = parseInt(rmParts[0], 10);
      if (isNaN(id)) return { text: "用法: /route rm <编号>" };
      const removed = removeExactRule(CONFIG_PATH, id);
      if (removed) refreshCache(cache);
      return { text: removed ? `已删除精确规则 #${id}` : `未找到精确规则 #${id}` };
    }

    // ── /route clear ────────────────────────────────────────────────
    case "clear": {
      clearAll(CONFIG_PATH);
      refreshCache(cache);
      return { text: "已清空所有规则和别名" };
    }

    // ── /route help (default) ───────────────────────────────────────
    case "help":
    default:
      return {
        text: [
          "Smart Model Router 命令：",
          "  /route models                 列出可用模型",
          "  /route add 关键词 = 模型       添加精确规则",
          "  /route ai 规则描述             添加模糊规则",
          "  /route as 别名=provider/model  设置别名",
          "  /route ls                     查看所有规则",
          "  /route rm <编号>              删除精确规则",
          "  /route rm ai <编号>           删除模糊规则",
          "  /route rm as <别名>           删除别名",
          "  /route clear                  清空所有",
          "",
          "示例：",
          "  /route as coder=bailian/qwen3-coder-plus",
          "  /route add 代码,code,bug = coder",
          "  /route ai 复杂推理任务用 anthropic/claude-sonnet-4-6",
        ].join("\n"),
      };
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

function refreshCache(cache: { data: ConfigData; fuzzyPrompt: string }): void {
  cache.data = loadConfigSync(CONFIG_PATH);
  cache.fuzzyPrompt = buildFuzzyPrompt(cache.data.fuzzyRules);
}

function getSessionKey(ctx: any): string {
  const raw = String(ctx?.sessionKey ?? "").trim().toLowerCase();
  return raw || SESSION_FALLBACK_KEY;
}

function getSessionState(ctx: any): SessionState {
  const key = getSessionKey(ctx);
  const existed = sessionStateMap.get(key);
  if (existed) return existed;
  const created: SessionState = {
    currentMatchResult: null,
    delegatedThisRound: false,
    delegatedModelName: "",
  };
  sessionStateMap.set(key, created);
  return created;
}

function clearSessionState(key: string): void {
  if (key === SESSION_FALLBACK_KEY) {
    const state = sessionStateMap.get(key);
    if (state) {
      state.currentMatchResult = null;
      state.delegatedThisRound = false;
      state.delegatedModelName = "";
    }
    return;
  }
  sessionStateMap.delete(key);
}

function getDefaultLabel(api: any, aliases: Record<string, ModelRef>): string {
  try {
    const primary = api.config?.agents?.defaults?.model?.primary;
    if (primary && typeof primary === "string") {
      const slashIdx = primary.indexOf("/");
      const defaultRef: ModelRef = slashIdx !== -1
        ? { provider: primary.slice(0, slashIdx), model: primary.slice(slashIdx + 1) }
        : { provider: "", model: primary };
      return getDisplayLabel(defaultRef, aliases);
    }
  } catch {}
  return "default";
}

// ── Plugin Entry ────────────────────────────────────────────────────────────

export default {
  id: "smart-model-router",
  name: "Smart Model Router",
  description: "Intelligent model routing via keywords, aliases, and natural language rules",

  register(api: any) {
    // In-memory cache
    const cache = {
      data: loadConfigSync(CONFIG_PATH),
      fuzzyPrompt: "",
    };
    cache.fuzzyPrompt = buildFuzzyPrompt(cache.data.fuzzyRules);

    // ── Helper: get available models from config ────────────────────
    function getModels(): string[] {
      try {
        const cfg = api.config;
        const providers = cfg?.models?.providers;
        if (!providers || typeof providers !== "object") return [];
        const models: string[] = [];
        for (const [providerName, providerCfg] of Object.entries(providers)) {
          const p = providerCfg as any;
          if (Array.isArray(p?.models)) {
            for (const m of p.models) {
              if (m?.id) models.push(`${providerName}/${m.id}`);
            }
          }
        }
        return models;
      } catch {
        return [];
      }
    }

    // ── /route command ──────────────────────────────────────────────
    api.registerCommand({
      name: "route",
      description: "Smart Model Router: /route help",
      acceptsArgs: true,
      handler(ctx: any) {
        return handleRouteCommand(ctx.args ?? "", cache, getModels);
      },
    });

    // ── Hook 1: before_model_resolve (deterministic routing) ────────
    api.on(
      "before_model_resolve",
      (event: any, ctx: any) => {
        const key = getSessionKey(ctx);
        const state = getSessionState(ctx);
        state.currentMatchResult = null;
        state.delegatedThisRound = false;
        state.delegatedModelName = "";

        const prompt = event?.prompt ?? "";
        if (!prompt) return undefined;

        const match = resolveFromPrompt(
          prompt,
          cache.data.exactRules,
          cache.data.aliases,
        );
        if (!match) return undefined;

        state.currentMatchResult = match;
        dbg(`before_model_resolve: session=${key} model=${match.ref.provider}/${match.ref.model}`);
        return {
          providerOverride: match.ref.provider,
          modelOverride: match.ref.model,
        };
      },
      { priority: 100 },
    );

    // ── Hook 2: before_prompt_build (label + fuzzy rules) ─────
    api.on(
      "before_prompt_build",
      (_event: any, ctx: any) => {
        const sessionKey = getSessionKey(ctx);
        const state = getSessionState(ctx);
        const isSubagent = sessionKey.includes("subagent:");
        const fallbackDelegatedLabel = Date.now() <= pendingDelegatedUntil ? pendingDelegatedLabel : "";

        // Model label
        const label = state.delegatedModelName
          || fallbackDelegatedLabel
          || (state.currentMatchResult
          ? getDisplayLabel(state.currentMatchResult.ref, cache.data.aliases)
          : getDefaultLabel(api, cache.data.aliases));

        dbg(`before_prompt_build: session=${sessionKey} isSubagent=${isSubagent} delegated=${state.delegatedThisRound} pending=${fallbackDelegatedLabel || "none"} label=${label}`);

        if (isSubagent) {
          dbg("→ subagent: pass through");
          return undefined;
        }

        if (state.delegatedThisRound) {
          state.delegatedThisRound = false;
          dbg(`→ forwarding: skip`);
          return undefined;
        }

        if (fallbackDelegatedLabel) {
          dbg(`→ forwarding by pending label: inject (via ⚙️ ${fallbackDelegatedLabel})`);
          return {
            prependContext: `在回复最末尾加 (via ⚙️ ${fallbackDelegatedLabel})`,
          };
        }

        // Normal: prependContext with label (will pollute task for subagent — intended)
        dbg(`→ normal: inject (via ⚙️ ${label})`);
        const result: any = {
          prependContext: `在回复最末尾加 (via ⚙️ ${label})`,
        };
        if (!state.currentMatchResult && cache.fuzzyPrompt) {
          result.appendSystemContext = cache.fuzzyPrompt;
        }
        return result;
      },
      { priority: 0 },
    );

    // ── Hook 3: before_tool_call (capture delegation model) ─────────────
    api.on(
      "before_tool_call",
      (event: any, ctx: any) => {
        const sessionKey = getSessionKey(ctx);
        const state = getSessionState(ctx);
        dbg(`before_tool_call: session=${sessionKey} toolName=${event?.toolName} model=${event?.params?.model ?? "none"}`);
        if (event?.toolName === "sessions_spawn" && event?.params?.model) {
          const model = String(event.params.model);
          const slashIdx = model.indexOf("/");
          const ref: ModelRef = slashIdx !== -1
            ? { provider: model.slice(0, slashIdx), model: model.slice(slashIdx + 1) }
            : { provider: "", model };
          state.delegatedModelName = getDisplayLabel(ref, cache.data.aliases);
          state.delegatedThisRound = true;
          pendingDelegatedLabel = state.delegatedModelName;
          pendingDelegatedUntil = Date.now() + 2 * 60 * 1000;
          dbg(`→ captured model: ${state.delegatedModelName}`);
        }
        return undefined;
      },
      { priority: 0 },
    );

    // ── Hook 4: message_sending (model label for non-feishu channels) ───
    api.on(
      "message_sending",
      (event: any, ctx: any) => {
        const sessionKey = getSessionKey(ctx);
        const state = getSessionState(ctx);

        const content = event?.content;
        if (!content || typeof content !== "string") {
          return undefined;
        }

        const hasTag = /\(via ⚙️ [^)]+\)\s*$/.test(content.trim());
        if (hasTag) {
          pendingDelegatedLabel = "";
          pendingDelegatedUntil = 0;
          clearSessionState(sessionKey);
          return undefined;
        }

        const fallbackDelegatedLabel = Date.now() <= pendingDelegatedUntil ? pendingDelegatedLabel : "";
        const label = state.delegatedModelName
          || fallbackDelegatedLabel
          || (state.currentMatchResult
            ? getDisplayLabel(state.currentMatchResult.ref, cache.data.aliases)
            : getDefaultLabel(api, cache.data.aliases));

        pendingDelegatedLabel = "";
        pendingDelegatedUntil = 0;
        clearSessionState(sessionKey);
        return { content: `${content}\n\n(via ⚙️ ${label})` };
      },
      { priority: -100 },
    );
  },
};

export { handleRouteCommand };
