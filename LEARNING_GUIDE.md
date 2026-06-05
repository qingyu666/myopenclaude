# OpenClaude 项目学习指南

## 第 1 步：跑起来

1. **安装依赖并构建**

   ```bash
   bun install && bun run build
   ```

2. **启动 CLI**，用 `/provider` 配置一个后端（推荐先用 Ollama 本地模型）

3. **体验核心功能**：对话、文件编辑、Bash 执行、斜杠命令

---

## 第 2 步：理解入口和启动流程

按顺序阅读以下文件，理解从命令行到交互式 REPL 的完整链路：

| 顺序 | 文件 | 作用 |
|------|------|------|
| 1 | `bin/openclaude` | Shell 入口脚本 |
| 2 | `src/entrypoints/cli.tsx` | CLI 主入口，解析参数、初始化 |
| 3 | `src/entrypoints/init.ts` | 初始化流程 |
| 4 | `src/components/App.tsx` | React 根组件，理解 UI 渲染循环 |

---

## 第 3 步：理解核心抽象（3 个关键概念）

### 3.1 Tool 系统 — Agent 如何调用工具

- `src/Tool.ts` — Tool 基类定义
- `src/tools/BashTool/BashTool.tsx` — 最常用的工具，理解工具的完整生命周期
- `src/tools/FileEditTool/FileEditTool.ts` — 文件编辑工具

### 3.2 Provider 适配 — 如何对接不同 LLM

- `src/services/api/providerConfig.ts` — Provider 配置核心，理解多模型路由
- `src/services/api/openaiShim.ts` — OpenAI 兼容层，理解如何将不同 API 统一
- `src/services/api/client.ts` — API 客户端

### 3.3 Command 系统 — 斜杠命令如何工作

- `src/commands.ts` — 命令注册表
- 挑一个简单命令看，比如 `src/commands/version.ts`

---

## 第 4 步：深入子系统（按兴趣选读）

| 方向 | 关键文件 |
|------|----------|
| MCP 协议 | `src/services/mcp/client.ts` → `src/tools/MCPTool/MCPTool.ts` |
| 上下文压缩 | `src/services/compact/compact.ts` |
| Agent 子代理 | `src/tools/AgentTool/AgentTool.tsx` → `src/tools/AgentTool/runAgent.ts` |
| 远程会话 | `src/bridge/bridgeMain.ts` → `src/remote/RemoteSessionManager.ts` |
| 任务调度 | `src/tools/TaskCreateTool/TaskCreateTool.ts` → `src/utils/cron.ts` |
| 终端 UI | `src/ink/` 目录，自定义 Ink 渲染层 |

---

## 第 5 步：动手实践

### 加一个简单的斜杠命令

参考 `src/commands/version.ts` 的模式，在 `src/commands/` 下新建命令。

### 加一个自定义 Tool

参考 `src/tools/GlobTool/` 的结构（Tool.ts + UI.tsx + prompt.ts）。

### 接入一个新的 Provider

参考 `src/services/api/openaiShim.ts` 的适配模式。

---

## 总结

```
跑起来 → 入口链路 → Tool/Provider/Command 三大核心 → 选子系统深入 → 动手改代码
```

最重要的是**先跑起来用起来**，有了体感再读代码会事半功倍。
