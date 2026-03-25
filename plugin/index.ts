import { join } from "node:path";
import { homedir } from "node:os";
import { appendFileSync, mkdirSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";

const DBG_PATH = join(homedir(), ".openclaw", "plugins", "smart-model-router", "debug.log");
const DBG_MAX_BYTES = 1024 * 1024;
const DBG_KEEP_BYTES = 256 * 1024;

function rotateDebugLogIfNeeded() {
  try {
    if (!existsSync(DBG_PATH)) return;
    const size = statSync(DBG_PATH).size;
    if (size <= DBG_MAX_BYTES) return;
    const text = readFileSync(DBG_PATH, "utf-8");
    const tail = text.slice(-DBG_KEEP_BYTES);
    writeFileSync(DBG_PATH, `[truncated ${new Date().toISOString()}]\n${tail}`, "utf-8");
  } catch {}
}

function dbg(msg: string) {
  try {
    mkdirSync(join(homedir(), ".openclaw", "plugins", "smart-model-router"), { recursive: true });
    rotateDebugLogIfNeeded();
    appendFileSync(DBG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
import {
  loadConfigSync,
  addExactRule,
  removeExactRule,
  updateExactRule,
  addFuzzyRule,
  removeFuzzyRule,
  updateFuzzyRule,
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
  requesterModelName: string;
};

const SESSION_FALLBACK_KEY = "__global__";
const sessionStateMap = new Map<string, SessionState>();
const subagentFailureNoticeBySession = new Map<string, string>();
let pendingDelegatedLabel = "";
let pendingRequesterLabel = "";
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

function parseKeywordsList(raw: string): string[] {
  return raw
    .replaceAll("，", ",")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
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
  helpers?: {
    getModels?: () => string[];
    getBuiltinAliases?: () => Record<string, ModelRef>;
  },
): { text: string } {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (sub.toLowerCase()) {
    // ── /route models ───────────────────────────────────────────────
    case "models": {
      if (!helpers?.getModels) return { text: "无法获取模型列表" };
      const models = helpers.getModels();
      if (models.length === 0) return { text: "未找到可用模型。请检查 openclaw.json 的 models.providers 配置。" };
      const pluginAliases = cache.data.aliases;
      const builtinAliases = helpers.getBuiltinAliases ? helpers.getBuiltinAliases() : {};

      const aliasByTarget = new Map<string, string[]>();
      const pushAlias = (target: string, alias: string) => {
        const list = aliasByTarget.get(target) ?? [];
        if (!list.includes(alias)) list.push(alias);
        aliasByTarget.set(target, list);
      };

      for (const [alias, ref] of Object.entries(builtinAliases)) {
        pushAlias(`${ref.provider}/${ref.model}`.toLowerCase(), `${alias}(openclaw)`);
      }
      for (const [alias, ref] of Object.entries(pluginAliases)) {
        pushAlias(`${ref.provider}/${ref.model}`.toLowerCase(), `${alias}(route)`);
      }

      const lines = models.map((m) => {
        const aliases = aliasByTarget.get(m.toLowerCase()) ?? [];
        if (aliases.length === 0) return `  ${m}`;
        return `  ${m}  [别名: ${aliases.join(", ")}]`;
      });
      return { text: `可用模型：\n${lines.join("\n")}` };
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
      const keywords = parseKeywordsList(parts[0]);
      if (keywords.length === 0) {
        return { text: "至少需要一个关键词" };
      }
      const target = parts[1];
      const rule = addExactRule(CONFIG_PATH, keywords, target);
      refreshCache(cache);
      return { text: `已添加精确规则 #${rule.id}: [${keywords.join(", ")}] = ${target}` };
    }

    // ── /route set <id> <keywords> = <target> ───────────────────────
    case "set": {
      if (!rest) {
        return {
          text:
            "用法: /route set <编号> 关键词1,关键词2 = 模型别名\n" +
            "示例: /route set 1 代码,code,bug,脚本,编程 = coder",
        };
      }
      const match = rest.match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) {
        return { text: "用法: /route set <编号> 关键词1,关键词2 = 模型别名" };
      }
      const id = Number.parseInt(match[1], 10);
      const payload = match[2].trim();
      const parts = splitBySeparator(payload);
      if (!parts || !parts[0] || !parts[1]) {
        return {
          text:
            "格式错误，需要用 = 或 -> 分隔关键词和目标模型\n" +
            "示例: /route set 1 代码,code,bug,脚本,编程 = coder",
        };
      }
      const keywords = parseKeywordsList(parts[0]);
      if (keywords.length === 0) {
        return { text: "至少需要一个关键词" };
      }
      const target = parts[1];
      const updated = updateExactRule(CONFIG_PATH, id, keywords, target);
      if (!updated) return { text: `未找到精确规则 #${id}` };
      refreshCache(cache);
      return { text: `已更新精确规则 #${id}: [${keywords.join(", ")}] = ${target}` };
    }

    // ── /route ai <text> / /route ai set <id> <text> ───────────────
    case "ai": {
      if (!rest) {
        return {
          text:
            "用法:\n" +
            "  /route ai 规则描述\n" +
            "  /route ai set <编号> 新规则描述\n" +
            "示例: /route ai set 2 处理图片相关任务用 bailian/kimi-k2.5",
        };
      }
      const setMatch = rest.match(/^set\s+(\d+)\s+([\s\S]+)$/i);
      if (setMatch) {
        const id = Number.parseInt(setMatch[1], 10);
        const text = setMatch[2].trim();
        if (!text) return { text: "用法: /route ai set <编号> 新规则描述" };
        const updated = updateFuzzyRule(CONFIG_PATH, id, text);
        if (!updated) return { text: `未找到模糊规则 #${id}` };
        refreshCache(cache);
        return { text: `已更新模糊规则 #${id}: ${text}` };
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
          "  /route models                 列出可用模型（含 openclaw/route 别名）",
          "  /route add 关键词 = 模型       添加精确规则（支持 , 和 ，）",
          "  /route set 编号 关键词 = 模型   修改精确规则（支持 , 和 ，）",
          "  /route ai 规则描述             添加模糊规则",
          "  /route ai set 编号 规则描述     修改模糊规则",
          "  /route as 别名=provider/model  设置 route 别名（可覆盖同名 openclaw 别名）",
          "  /route ls                     查看所有规则",
          "  /route rm <编号>              删除精确规则",
          "  /route rm ai <编号>           删除模糊规则",
          "  /route rm as <别名>           删除别名",
          "  /route clear                  清空所有",
          "",
          "示例：",
          "  /route as coder=bailian/qwen3-coder-plus",
          "  /route add 代码，code，bug = coder",
          "  /route set 1 代码,code,bug,脚本,编程 = coder",
          "  /route ai set 2 处理图片相关任务用 bailian/kimi-k2.5",
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
    requesterModelName: "",
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
      state.requesterModelName = "";
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

    function getBuiltinAliases(): Record<string, ModelRef> {
      try {
        const models = api.config?.agents?.defaults?.models;
        if (!models || typeof models !== "object") return {};
        const aliases: Record<string, ModelRef> = {};
        for (const [key, entry] of Object.entries(models as Record<string, any>)) {
          const alias = String(entry?.alias ?? "").trim().toLowerCase();
          if (!alias) continue;
          const slashIdx = key.indexOf("/");
          if (slashIdx === -1) continue;
          const provider = key.slice(0, slashIdx).trim();
          const model = key.slice(slashIdx + 1).trim();
          if (!provider || !model) continue;
          aliases[alias] = { provider, model };
        }
        return aliases;
      } catch {
        return {};
      }
    }

    function getMergedAliases(): Record<string, ModelRef> {
      // plugin aliases take precedence when names conflict.
      return { ...getBuiltinAliases(), ...cache.data.aliases };
    }

    // ── /route command ──────────────────────────────────────────────
    api.registerCommand({
      name: "route",
      description: "Smart Model Router: /route help",
      acceptsArgs: true,
      handler(ctx: any) {
        return handleRouteCommand(ctx.args ?? "", cache, {
          getModels,
          getBuiltinAliases,
        });
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
    state.requesterModelName = "";

        const prompt = event?.prompt ?? "";
        if (!prompt) return undefined;
        const mergedAliases = getMergedAliases();

        const match = resolveFromPrompt(
          prompt,
          cache.data.exactRules,
          mergedAliases,
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
        const failureNotice = subagentFailureNoticeBySession.get(sessionKey);

        if (!isSubagent && failureNotice) {
          subagentFailureNoticeBySession.delete(sessionKey);
          dbg(`before_prompt_build: session=${sessionKey} inject failure notice=${failureNotice}`);
          return {
            prependContext:
              `子任务执行失败（${failureNotice}）。请你立即直接回复用户：` +
              `"抱歉，子任务执行失败（${failureNotice}）。请重试，或明确指定模型后再试。"` +
              "不要调用任何工具，不要继续委派。",
          };
        }

        // Model label
        const mergedAliases = getMergedAliases();
        const label = state.delegatedModelName
          || fallbackDelegatedLabel
          || (state.currentMatchResult
          ? getDisplayLabel(state.currentMatchResult.ref, mergedAliases)
          : getDefaultLabel(api, mergedAliases));

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
          dbg(`→ forwarding by pending label: skip prompt label injection`);
          return undefined;
        }

        const labelInstruction =
          `输出约束（必须遵守）：你的最终回复最后一行必须是：(via ⚙️ ${label})。` +
          "不得缺失，不得改写该格式，不得重复添加多个 via。";
        dbg(`→ normal: inject prompt label fallback=${label}`);
        const result: any = {};
        result.prependContext = labelInstruction;
        if (!state.currentMatchResult && cache.fuzzyPrompt) {
          result.prependContext = `${labelInstruction}\n\n${cache.fuzzyPrompt}`;
        }
        return Object.keys(result).length > 0 ? result : undefined;
      },
      { priority: 0 },
    );

    // ── Hook 2.5: subagent_ended (failure watchdog, optional) ──────
    // Some OpenClaw versions may not expose this hook yet. Keep router
    // functionality (route + labeling) alive even when this hook is unavailable.
    try {
      api.on(
        "subagent_ended",
        (event: any, ctx: any) => {
          const requesterSessionKey = String(ctx?.requesterSessionKey ?? "").trim().toLowerCase();
          if (!requesterSessionKey) return;

          const outcome = String(event?.outcome ?? "").toLowerCase();
          if (!outcome || outcome === "ok") {
            subagentFailureNoticeBySession.delete(requesterSessionKey);
            dbg(`subagent_ended: requester=${requesterSessionKey} outcome=ok clear`);
            return;
          }

          if (
            outcome === "error" ||
            outcome === "timeout" ||
            outcome === "killed" ||
            outcome === "reset"
          ) {
            const reason = String(event?.reason ?? event?.error ?? outcome).slice(0, 80);
            subagentFailureNoticeBySession.set(requesterSessionKey, reason);
            dbg(
              `subagent_ended: requester=${requesterSessionKey} outcome=${outcome} reason=${reason}`,
            );
          }
        },
        { priority: 50 },
      );
    } catch (err) {
      dbg(
        `subagent_ended hook unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Hook 3: before_tool_call (capture delegation model) ─────────────
    api.on(
      "before_tool_call",
      (event: any, ctx: any) => {
        const sessionKey = getSessionKey(ctx);
        const state = getSessionState(ctx);
        dbg(`before_tool_call: session=${sessionKey} toolName=${event?.toolName} model=${event?.params?.model ?? "none"}`);
        if (event?.toolName === "sessions_spawn" && event?.params?.model) {
          const mergedAliases = getMergedAliases();
          const model = String(event.params.model);
          const slashIdx = model.indexOf("/");
          const ref: ModelRef = slashIdx !== -1
            ? { provider: model.slice(0, slashIdx), model: model.slice(slashIdx + 1) }
            : { provider: "", model };
          state.delegatedModelName = getDisplayLabel(ref, mergedAliases);
          state.requesterModelName = state.currentMatchResult
            ? getDisplayLabel(state.currentMatchResult.ref, mergedAliases)
            : getDefaultLabel(api, mergedAliases);
          state.delegatedThisRound = true;
          pendingDelegatedLabel = state.delegatedModelName;
          pendingRequesterLabel = state.requesterModelName;
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
        const mergedAliases = getMergedAliases();

        const fallbackDelegatedLabel = Date.now() <= pendingDelegatedUntil ? pendingDelegatedLabel : "";
        const fallbackRequesterLabel = Date.now() <= pendingDelegatedUntil ? pendingRequesterLabel : "";
        const requesterLabel = state.requesterModelName || fallbackRequesterLabel;
        const label = state.delegatedModelName
          || fallbackDelegatedLabel
          || (state.currentMatchResult
            ? getDisplayLabel(state.currentMatchResult.ref, mergedAliases)
            : getDefaultLabel(api, mergedAliases));
        const viaLabel = requesterLabel ? `${label} -> ${requesterLabel}` : label;

        const viaAnywherePattern = /\(via ⚙️ [^)]+\)/u;
        if (viaAnywherePattern.test(content)) {
          dbg(`message_sending: session=${sessionKey} keep existing via label, skip append`);
          pendingDelegatedLabel = "";
          pendingRequesterLabel = "";
          pendingDelegatedUntil = 0;
          clearSessionState(sessionKey);
          return undefined;
        }
        const normalizedContent = content.trimEnd();
        dbg(`message_sending: session=${sessionKey} force label=${viaLabel} delegated=${state.delegatedModelName || "none"} pending=${fallbackDelegatedLabel || "none"}`);
        pendingDelegatedLabel = "";
        pendingRequesterLabel = "";
        pendingDelegatedUntil = 0;
        clearSessionState(sessionKey);
        return { content: `${normalizedContent}\n\n(via ⚙️ ${viaLabel})` };
      },
      { priority: -100 },
    );
  },
};

export { handleRouteCommand };
