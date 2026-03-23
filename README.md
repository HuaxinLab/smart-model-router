# Smart Model Router

[English](#english) | [简体中文](#简体中文)

---

<a id="简体中文"></a>

## 简体中文

一个 OpenClaw 插件，根据消息内容自动选择最合适的模型。支持关键词精确匹配、用户显式指定、自然语言模糊规则三种路由方式，每条回复自动标注使用的模型名称。

### 工作原理

```
用户: /route as coder=bailian/qwen3-coder-plus
用户: /route add 代码,code,bug = coder

用户: 这段代码有 bug
  → 关键词命中 "代码" → 自动切换到 qwen3-coder-plus
  → 回复末尾标注 (via ⚙️ coder)

用户: 今天天气怎么样
  → 没命中任何规则 → 使用默认模型
  → 回复末尾标注 (via ⚙️ glm-5)

用户: [发图片] 帮我识别这张图里的文字
  → 模糊规则命中，委派给 kimi-k2.5
  → 回复末尾标注 (via ⚙️ kimi-k2.5 -> glm-5)
```

主模型不切换，任务完成后自动恢复。每条消息独立路由。

### 三种路由方式

| 方式 | 触发 | 上下文 | 依赖 AI |
|------|------|--------|---------|
| 用户显式指定 | "用 coder 模型帮我看代码" | 完整保留 | 否 |
| 关键词精确匹配 | 消息包含预设关键词 | 完整保留 | 否 |
| 模糊规则 | AI 判断任务是否匹配规则 | 子 agent（无历史） | 是 |

优先级：用户显式 > 关键词 > 模糊规则 > 默认模型

### 安装

```bash
# 从本地安装
git clone https://github.com/yourname/smart-model-router.git
openclaw plugins install smart-model-router/plugin

# 启用 prompt 注入（仅模糊规则需要）
openclaw config set plugins.entries.smart-model-router.hooks.allowPromptInjection true

# 重启网关
openclaw gateway restart
```

**要求**：
- OpenClaw v2026.3.10+（`allowPromptInjection` 支持）
- 至少配置了一个模型 Provider

### 命令

```
/route help                                # 显示帮助
/route models                              # 列出所有可用模型
/route as coder=bailian/qwen3-coder-plus   # 设置模型别名
/route add 代码,code,bug = coder           # 添加精确规则
/route ai 复杂推理任务用 claude             # 添加模糊规则
/route ls                                  # 查看所有规则和别名
/route rm 1                                # 删除精确规则
/route rm ai 1                             # 删除模糊规则
/route rm as coder                         # 删除别名
/route clear                               # 清空所有
```

`=` 和 `->` 都可以作为分隔符，`=` 更方便（不用切英文输入法）。

### 典型配置流程

```
# 1. 查看可用模型
/route models

# 2. 设置常用别名（复制粘贴模型 ID）
/route as coder=bailian/qwen3-coder-plus
/route as kimi=bailian/kimi-k2.5

# 3. 添加路由规则
/route add 代码,code,bug,debug = coder
/route add 翻译,translate = kimi

# 4. 确认
/route ls
```

之后正常聊天即可，插件自动路由。

### 显式指定模型

在消息中直接说明使用哪个模型：

```
用 coder 模型帮我看看这段代码
用 kimi 模型翻译这篇文章
切换到 coder
@coder 这是什么意思
use kimi model
```

支持别名和完整模型 ID（如 `bailian/qwen3-coder-plus`）。

### 模型标注

每条回复末尾自动标注模型：

```
AI 回复内容...

(via ⚙️ coder)
```

- 精确匹配/默认回复：`(via ⚙️ <当前模型>)`
- 子 agent 委派后回复：`(via ⚙️ <子模型> -> <主模型>)`
- 有别名显示别名，无别名显示模型名
- 默认模型也标注
- 由 `message_sending` 钩子在代码层强制改写，避免依赖模型遵循指令
- 仅模糊规则依赖 prompt 注入（`appendSystemContext`），因此仅模糊规则需要 `allowPromptInjection: true`
- 内置委派失败防静默 watchdog：子任务 `error/timeout/killed/reset` 时，主会话会自动补一条失败回执

### 技术架构

| 组件 | 机制 | 用途 |
|------|------|------|
| `/route` 命令 | `api.registerCommand()` | 规则管理，绕过 AI，零 token |
| 精确路由 | `before_model_resolve` 钩子（priority 100） | 关键词匹配 + 用户显式指定 |
| 模型标注 | `before_tool_call` + `message_sending` | 捕获委派模型并在发送前强制改写标注 |
| 模糊规则 | `before_prompt_build` + `appendSystemContext` | 注入模糊规则让 AI 判断 |
| 内存缓存 | 模块级状态 + 短时 pending 缓存 | 热路径零磁盘 I/O |

零外部依赖，约 350 行 TypeScript。

### 文件结构

```
smart-model-router/
├── plugin/                    # 插件本体（部署时只需这个目录）
│   ├── package.json
│   ├── openclaw.plugin.json
│   ├── index.ts               # 入口：命令 + 钩子
│   └── src/
│       ├── config-store.ts    # 规则/别名 CRUD + 持久化
│       ├── exact-match.ts     # 关键词匹配 + 显式指定
│       └── fuzzy-inject.ts    # 模糊规则 prompt 构建
├── tests/                     # 单元测试（30 个）
├── docs/
│   └── design.md              # 详细设计文档
└── README.md
```

规则存储位置：`~/.openclaw/plugins/smart-model-router/config.json`

### 测试

```bash
cd smart-model-router
npm install
npm test
# 30 个测试：config-store (16) + exact-match (11) + fuzzy-inject (3)
```

### 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `/route` 命令无响应 | 插件未加载 | `openclaw plugins list` 检查，确认 `plugins.allow` 包含 `smart-model-router` |
| 规则命中但没切模型 | `currentMatchResult` 闭包问题 | 确认使用最新版本（模块级变量） |
| 模糊规则不生效 | `allowPromptInjection` 未设置 | `openclaw config set plugins.entries.smart-model-router.hooks.allowPromptInjection true` |
| 委派后标注仍是主模型 | 使用旧插件版本 | 更新到最新版本（`message_sending` 强制改写标签） |
| 委派后无任何后续消息 | 子任务中断/超时 | 更新到最新版本（`subagent_ended` watchdog 会自动补失败回执） |
| 标注不显示（旧版本） | OpenClaw 版本过低 | 升级到 2026.3.10+ |
| 模型切换报错 | 目标 Provider 未配置 | `/route models` 确认模型可用 |

### 委派失败验证（watchdog）

可用以下流程验证“防静默”：

```bash
# 1) 先触发一次委派（看到“已委派给 ... 处理”）
# 2) 立刻发送 /abort 中断
```

预期会收到两条后续消息：
- 中断确认（如“已中止子代理任务”）
- 自动失败回执（如“抱歉，子任务执行失败（subagent-killed）...”）

### 许可证

MIT

---

<a id="english"></a>

## English

An OpenClaw plugin that automatically selects the best model based on message content. Supports keyword-based exact matching, explicit user requests, and natural language fuzzy rules. Every reply is labeled with model routing info.

### How It Works

```
User: /route as coder=bailian/qwen3-coder-plus
User: /route add code,bug,debug = coder

User: This code has a bug
  → Keyword "code" matched → switches to qwen3-coder-plus
  → Reply labeled (via ⚙️ coder)

User: What's the weather today?
  → No rule matched → uses default model
  → Reply labeled (via ⚙️ glm-5)

User: [send image] OCR this screenshot
  → Fuzzy rule matched, delegated to kimi-k2.5
  → Reply labeled (via ⚙️ kimi-k2.5 -> glm-5)
```

### Three Routing Modes

| Mode | Trigger | Context | Needs AI |
|------|---------|---------|----------|
| Explicit | "use coder model to check this" | Full history | No |
| Keyword match | Message contains preset keywords | Full history | No |
| Fuzzy rules | AI decides if task matches a rule | Subagent (no history) | Yes |

Priority: Explicit > Keyword > Fuzzy > Default

### Installation

```bash
git clone https://github.com/yourname/smart-model-router.git
openclaw plugins install smart-model-router/plugin
openclaw config set plugins.entries.smart-model-router.hooks.allowPromptInjection true
openclaw gateway restart
```

**Requirements**: OpenClaw v2026.3.10+, at least one model provider configured.

### Commands

```
/route help                                # Show help
/route models                              # List available models
/route as coder=bailian/qwen3-coder-plus   # Set model alias
/route add code,bug,debug = coder          # Add exact rule
/route ai complex reasoning use claude      # Add fuzzy rule
/route ls                                  # List all rules and aliases
/route rm 1                                # Remove exact rule
/route rm ai 1                             # Remove fuzzy rule
/route rm as coder                         # Remove alias
/route clear                               # Clear all
```

Both `=` and `->` work as separators.

### Model Label

Every reply is automatically labeled:

```
AI response...

(via ⚙️ coder)
```

- Direct/default reply: `(via ⚙️ <model>)`
- Delegated reply: `(via ⚙️ <subagent-model> -> <requester-model>)`
- Implemented via `before_tool_call` + `message_sending` with forced tail-label rewrite.
- `allowPromptInjection: true` is only required for fuzzy rules, not for labeling itself.

### Testing

```bash
cd smart-model-router && npm install && npm test
```

### License

MIT
