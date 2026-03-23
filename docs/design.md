# Smart Model Router 设计方案

> 日期：2026-03-23
> 状态：设计阶段
> 目标平台：OpenClaw v2026.3.2+，Raspberry Pi 4B

## 一、背景与动机

### 当前痛点

OpenClaw 上配置了多个模型（百炼的 glm-5、qwen3-coder-plus、kimi-k2.5 等），但缺乏按任务智能选择模型的能力。用户只能：

- 手动告诉小派"/models switch xxx"切换模型
- 或全局固定一个默认模型处理所有任务

不同任务对模型能力的要求不同：代码任务适合 coder 模型，翻译适合多语言模型，简单闲聊用便宜模型就够。手动切换繁琐，且切换后容易忘记切回来。

### 期望效果

用户正常发消息，系统自动选择最合适的模型。用户也可以显式指定"用xxx模型"。每条回复标注使用的模型名称，让用户清楚知道当前在用什么。

## 二、需求

### 核心需求

| 编号 | 需求 | 优先级 |
|------|------|--------|
| R1 | 用户显式指定模型（"用 coder 模型帮我看代码"） | 高 |
| R2 | 关键词精确匹配自动路由（代码→coder，翻译→多语言模型） | 高 |
| R3 | 自然语言模糊规则兜底（AI 判断是否匹配） | 中 |
| R4 | 模型别名管理（"coder"→"bailian/qwen3-coder-plus"） | 高 |
| R5 | 规则动态管理（通过斜杠命令增删改查） | 高 |
| R6 | 每条回复标注使用的模型名称 | 中 |
| R7 | 规则持久化（重启不丢失） | 高 |

### 非功能需求

| 编号 | 需求 |
|------|------|
| NF1 | 不依赖主模型的判断能力（精确规则部分） |
| NF2 | 零外部依赖 |
| NF3 | 热路径零磁盘 I/O（规则缓存在内存） |
| NF4 | 兼容百炼等非主流 provider |

## 三、既有方案分析

### 方案 A：model-router 插件（已有项目 `openclaw_modleRouterPlugin`）

**机制**：`api.registerCommand("route")` + `api.on("before_prompt_build")`

把自然语言规则注入 system prompt，主 agent 判断是否匹配，匹配则 `sessions_spawn(model=...)` 创建子 agent 执行。

**优点**：
- 自然语言规则灵活，"复杂推理任务"能匹配到各种表述
- 主模型不切换，子 agent 只带一条 task 消息，省 token

**缺点**：
- 完全依赖主模型的判断能力，弱模型可能误判
- 子 agent 没有对话历史上下文
- 需要 `allowPromptInjection: true` 权限
- 主模型必须正确调用 `sessions_spawn` 工具
- 提示词是英文，中文模型遵循度可能不够

### 方案 B：`before_model_resolve` 钩子 + 关键词匹配

**机制**：`api.on("before_model_resolve")` 在模型解析前用代码做关键词匹配，直接返回 `{ providerOverride, modelOverride }`。

**优点**：
- 100% 确定性，不依赖任何 AI 判断
- 保持完整对话上下文（不创建子 agent）
- 不需要 `allowPromptInjection` 权限
- 不需要主模型会调工具

**缺点**：
- 关键词匹配不够灵活
- 切换模型后完整上下文发给新模型，如果新模型更贵则费用更高
- （但注意：OpenClaw 每条消息本来就重新发完整上下文，不存在"额外"开销）

### 方案 C：两者结合（本设计方案）

取方案 A 的灵活性 + 方案 B 的稳定性，分层互补。

## 四、设计方案

### 架构总览

```
用户发消息
  ↓
┌─────────────────────────────────────────┐
│ before_model_resolve 钩子（代码层，确定性） │
│                                         │
│ ① 用户显式指定（"用xxx模型"）→ 切模型     │
│    ↓ 没指定                              │
│ ② 关键词精确匹配 → 切模型                │
│    ↓ 没命中                              │
│ ③ 返回 undefined（不干预）               │
└─────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────┐
│ before_prompt_build 钩子（AI 层）         │
│                                         │
│ ④ 注入模型标注指令（prependContext）      │
│ ⑤ 注入模糊规则到 system prompt（仅精确   │
│    匹配未命中时）                        │
│   → AI 自行判断是否匹配                  │
│   → 匹配则 sessions_spawn 子 agent       │
│   → 不匹配则默认模型回答                 │
└─────────────────────────────────────────┘
```

### 三层路由策略对比

| 层 | 钩子 | 匹配方式 | 执行方式 | 上下文 | 依赖 AI | 适用场景 |
|----|------|---------|---------|--------|---------|---------|
| ① 用户显式指定 | `before_model_resolve` | 正则提取模型名 | 切模型 | 完整 | 否 | "用 coder 模型看代码" |
| ② 关键词精确 | `before_model_resolve` | 关键词匹配 | 切模型 | 完整 | 否 | 日常高频场景 |
| ③ 模糊兜底 | `before_prompt_build` | AI 自然语言理解 | spawn 子 agent | 无 | 是 | 偶尔的复杂场景 |

### 路由优先级

```
① > ② > ③ > 默认模型
```

高层命中后低层不执行。`before_model_resolve`（优先级 100）在 `before_prompt_build`（优先级 0）之前执行。

## 五、功能设计

### 5.1 斜杠命令

```
/route help                                    # 显示帮助
/route models                                  # 列出所有可用模型（从配置读取）
/route add 代码,code,bug = coder              # 添加精确规则（关键词 → 别名或模型ID）
/route ai 复杂推理任务用 claude                 # 添加模糊规则（交给 AI 判断）
/route as coder=bailian/qwen3-coder-plus       # 设置模型别名（等号前后空格可选）
/route ls                                      # 列出所有规则和别名
/route rm 1                                    # 删除精确规则
/route rm ai 1                                 # 删除模糊规则
/route rm as coder                             # 删除别名
/route clear                                   # 清空所有
```

命令设计原则：
- `add` / `ai` / `as` — 三个核心动作，都是两个字母，好记
- `ls` / `rm` — 沿用 Linux 习惯
- `models` — 列出可用模型，方便复制粘贴设置别名
- `add` 默认就是精确规则（最常用），`ai` 是模糊规则（表示交给 AI 判断）
- `as` 设置别名，等号前后空格可选（`coder=xxx` 和 `coder = xxx` 都行）
- `=` 和 `->` 都可以作为分隔符（`add` 和 `as` 命令中均适用），`=` 更方便（不用切英文输入法）

典型工作流：先 `/route models` 查看可用模型 → `/route as` 设置常用别名 → `/route add` 用别名配规则

所有命令通过 `api.registerCommand()` 注册，绕过 AI，不消耗 token。

### 5.2 数据结构

```json
{
  "exactRules": [
    {
      "id": 1,
      "keywords": ["代码", "code", "bug", "debug", "重构"],
      "target": "coder"
    },
    {
      "id": 2,
      "keywords": ["翻译", "translate"],
      "target": "bailian/kimi-k2.5"
    }
  ],
  "fuzzyRules": [
    {
      "id": 1,
      "text": "复杂推理和深度分析任务用 anthropic/claude-sonnet-4-6"
    }
  ],
  "aliases": {
    "coder": { "provider": "bailian", "model": "qwen3-coder-plus" },
    "kimi": { "provider": "bailian", "model": "kimi-k2.5" },
    "claude": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
    "glm": { "provider": "bailian", "model": "glm-5" }
  }
}
```

存储位置：`~/.openclaw/plugins/smart-model-router/config.json`

### 5.3 用户显式指定模型

从用户消息中提取模型指定：

```
支持的表达方式：
- "用 coder 模型帮我看代码"
- "用 bailian/qwen3-coder-plus 分析一下"
- "切换到 claude"
- "use kimi model"
- "@coder 这段代码什么意思"
```

匹配逻辑：

```
1. 正则提取：/用\s*([\w/.:-]+)\s*模型|切换到?\s*([\w/.:-]+)|use\s+([\w/.:-]+)|@([\w/.:-]+)/
2. 提取到的值先查别名表
3. 别名命中 → 用别名对应的 provider/model
4. 别名未命中 → 当作完整模型 ID 使用（需包含 provider/ 前缀）
```

### 5.4 关键词精确匹配

```
1. 遍历 exactRules
2. 检查用户消息是否包含任一关键词（不区分大小写）
3. 首条命中的规则生效
4. target 值先查别名表，再解析为 provider/model
```

### 5.5 模糊规则（AI 判断）

当精确匹配未命中时，通过 `before_prompt_build` 将模糊规则注入 system prompt：

```
## 模型路由规则（可选委派）

如果当前任务匹配以下任何规则，你可以使用 sessions_spawn 委派给子 agent。
不确定是否匹配时，直接回答即可。

规则：
1. 复杂推理和深度分析任务用 anthropic/claude-sonnet-4-6
```

与 model-router 插件的提示词区别：
- 语气从"MUST"改为"可以"——降低弱模型的误判率
- 中文提示词——适配中文模型
- 不匹配时直接回答——减少不必要的委派

### 5.6 模型标注

格式（兼容飞书/微信/Telegram 等纯文本平台）：

```
AI 回复内容...

(via ⚙️ coder)
```

- 括号包裹，视觉上与正文明确分隔
- `via` 表示"经由"，语义清晰
- ⚙️ 齿轮 emoji 表示模型/引擎，各平台均支持
- 显示别名（如 `coder`）而非完整 ID（`bailian/qwen3-coder-plus`），简洁易读
- 没有别名时显示模型名（不含 provider 前缀）

#### 实现方式（实测确定）

最初设计使用 `message_sending` 钩子在代码层面强制追加标注（零 token、100% 可靠）。但实测发现 `message_sending` 钩子在飞书渠道不触发。

最终采用 **双保险** 方案：

1. **`before_prompt_build` + `prependContext`**（主方案，已验证有效）
   - 通过 `prependContext` 将标注指令注入到用户消息前面
   - 指令包含插件动态计算的具体模型名，AI 只需照搬格式
   - `prependContext` 比 `appendSystemContext` 遵循度高得多（加在用户消息前 vs 系统提示末尾）
   - 代价：每条消息多消耗约 30 个 token
   - 需要 `allowPromptInjection: true`（OpenClaw 2026.3.10+）

2. **`message_sending` 钩子**（备选，代码中保留）
   - 在消息发出前代码层面追加标注
   - 零 token 消耗、100% 可靠
   - 当前飞书渠道不触发；其他渠道（Telegram/微信等）可能有效
   - 两个方案同时存在不冲突——如果 `message_sending` 触发了会追加一次，`prependContext` 让 AI 也追加一次，内容一致

#### 实测踩坑记录

| 尝试 | 结果 | 原因 |
|------|------|------|
| `message_sending` 钩子修改 `event.content` | 钩子没触发 | 飞书渠道的出站路径不调用此钩子 |
| `before_prompt_build` + `appendSystemContext` | AI 忽略了指令 | 弱模型对 system prompt 末尾追加的指令遵循度不够 |
| `before_prompt_build` + `prependContext` | ✅ 有效 | 指令加在用户消息前面，模型遵循度高 |

#### 关键实现细节

`currentMatchResult` 必须声明为**模块级变量**，不能放在 `register()` 闭包里。因为 OpenClaw 会多次调用 `register()`，每次创建新闭包。如果是闭包变量，`before_model_resolve`（闭包 A）设的值在 `before_prompt_build`（闭包 C）里读不到。

## 六、配置要求

### 必须的配置

```bash
# 安装插件
openclaw plugins install /path/to/smart-model-router

# 重启网关
openclaw gateway restart
```

### 仅使用模糊规则时需要

```bash
# 允许 prompt 注入（模糊规则需要注入 system prompt）
openclaw config set plugins.entries.smart-model-router.hooks.allowPromptInjection true
```

如果只使用精确规则和用户显式指定，**不需要** `allowPromptInjection`。

### 目标模型的 Provider 必须已配置

规则里用到的模型（如 `anthropic/claude-sonnet-4-6`）需要在 `openclaw.json` 的 `models.providers` 里有对应的配置和 API key。

## 七、与 model-router 插件的对比

| | model-router（已有） | smart-model-router（本方案） |
|---|---|---|
| 匹配方式 | 仅 AI 判断 | 关键词 + AI 判断（双层） |
| 用户显式指定 | 不支持 | 支持（"用xxx模型"） |
| 模型别名 | 不支持 | 支持 |
| 精确匹配 | 不支持 | 支持（不依赖 AI） |
| 上下文保持 | 子 agent 无上下文 | 精确匹配保持完整上下文 |
| 模型标注 | 不支持 | 支持 |
| 需要 allowPromptInjection | 是（始终） | 仅模糊规则需要 |
| 提示词语言 | 英文 | 中文 |
| 对主模型能力的要求 | 高 | 低（精确匹配不依赖 AI） |
| 代码量 | ~140 行 | 预估 ~300 行 |

## 八、使用场景示例

### 场景 1：日常使用（精确匹配）

```
用户设置：
/route alias coder -> bailian/qwen3-coder-plus
/route add-exact 代码,code,bug,debug -> coder

用户: 这段代码有个 bug，帮我看看
→ 关键词命中 "bug" → 切换到 qwen3-coder-plus → 带完整上下文回复
→ 回复末尾标注 (via ⚙️ coder)

用户: 今天天气怎么样
→ 没命中任何规则 → 用默认模型 glm-5 回复
→ 回复末尾标注 (via ⚙️ glm-5)
```

### 场景 2：用户主动指定

```
用户设置：
/route alias claude -> anthropic/claude-sonnet-4-6

用户: 用 claude 模型帮我分析一下刚才的方案
→ 识别"用 claude 模型" → 查别名 → anthropic/claude-sonnet-4-6
→ 带完整上下文（知道"刚才的方案"是什么）
→ 回复末尾标注 (via ⚙️ claude)
```

### 场景 3：模糊兜底

```
用户设置：
/route add-fuzzy 需要深入推理的复杂问题用 anthropic/claude-sonnet-4-6

用户: 帮我从零设计一个分布式缓存系统的架构
→ 关键词未命中
→ 模糊规则注入 system prompt
→ AI 判断"设计分布式架构"属于"深入推理的复杂问题"
→ spawn 子 agent 用 claude 处理（无历史上下文，但这个任务本身是独立的）
```

## 九、开发计划

### 第一阶段：核心功能（MVP）

- [ ] 插件骨架（package.json、openclaw.plugin.json、index.ts）
- [ ] 规则存储（config.json 读写 + 内存缓存）
- [ ] 斜杠命令（/route add-exact、alias、list、remove、clear）
- [ ] `before_model_resolve` 钩子（用户显式指定 + 关键词精确匹配）
- [ ] 别名解析
- [ ] 单元测试

### 第二阶段：增强功能

- [ ] 模糊规则（/route add-fuzzy + before_prompt_build）
- [ ] 模型标注（message_sending 钩子）
- [ ] 中文模糊规则提示词优化

### 第三阶段：优化

- [ ] 正则表达式规则支持（除了关键词还能用正则）
- [ ] 规则优先级（多条精确规则命中时按优先级选）
- [ ] 使用统计（记录每个模型被路由了多少次）

## 十、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 弱模型不会调 sessions_spawn | 模糊规则失效 | 有精确规则兜底，模糊规则定位为可选增强 |
| 关键词误匹配 | 聊天提到"代码"但不是代码任务 | 关键词选择要具体，避免过于宽泛的词 |
| 目标模型 API 不可用 | 路由后调用失败 | OpenClaw 自带 fallback 链，路由失败自动回退默认模型 |
| message_sending 钩子无法获取当前模型 | 标注功能失效 | 需要验证钩子上下文中是否有模型信息，否则用闭包传递 |
| 别名冲突（别名跟正常聊天词汇重叠） | "用 kimi 模型"误匹配普通句子 | 显式指定要求"用xxx模型"的固定句式，不会误触 |

## 十一、文件结构（预期）

```
smart-model-router/
├── docs/
│   └── design.md              ← 本文件
├── plugin/                    ← 插件本体（部署时只需这个目录）
│   ├── package.json
│   ├── openclaw.plugin.json
│   ├── index.ts               ← 入口：命令注册 + 三个钩子
│   └── src/
│       ├── config-store.ts    ← 规则和别名的 CRUD + 持久化
│       ├── exact-match.ts     ← 关键词匹配 + 用户显式指定
│       ├── fuzzy-inject.ts    ← 模糊规则 prompt 构建
│       └── model-label.ts     ← 模型标注逻辑
└── tests/
    ├── exact-match.test.ts
    ├── config-store.test.ts
    └── fuzzy-inject.test.ts
```
