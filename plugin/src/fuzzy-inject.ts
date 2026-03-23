import type { FuzzyRule } from "./config-store.js";

/**
 * Build the system prompt injection for fuzzy routing rules.
 * Written in Chinese to match the primary model language.
 * Uses strict wording so fuzzy rule hits reliably trigger delegation.
 */
export function buildFuzzyPrompt(rules: FuzzyRule[]): string {
  if (rules.length === 0) return "";

  const rulesList = rules.map((r) => `${r.id}. ${r.text}`).join("\n");

  return `## 模型路由规则（必须执行）

以下规则描述了哪些任务必须委派给指定模型处理。当用户的任务匹配任何一条规则时，你必须使用 sessions_spawn 工具委派，禁止自己回答。

规则：
${rulesList}

匹配时的执行步骤：
1. 先回复用户："已委派给 [模型名] 处理，等待结果返回..."
2. 调用 sessions_spawn(model="<规则中指定的模型>", runtime="subagent", task="<用户的原始消息>")
3. 将子 agent 返回的结果转发给用户

不匹配任何规则时，你自己回答。`;
}
