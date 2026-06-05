import { feature } from 'bun:bundle'; // Bun 构建时特性标志
import {
  applyProfileEnvToProcessEnv, // 将 Provider 配置文件的环境变量应用到 process.env
  buildStartupEnvFromProfile, // 从保存的 Provider 配置构建启动环境变量
  isDefaultStartupProviderEnv, // 检查是否为默认启动 Provider 环境
} from '../utils/providerProfile.js'
import {
  getProviderValidationError, // 获取 Provider 验证错误
  validateProviderEnvForStartupOrExit, // 验证 Provider 环境变量，失败则退出
} from '../utils/providerValidation.js'

// OpenClaude: 为 Node < 20 填充 globalThis.File。
// undici v7 在模块求值时引用 `File`（webidl 类型断言）。
// Node 18 缺少此全局变量，导致在打包的 __commonJS require 链中
// 出现 ReferenceError，当配置了代理时会死锁进程
// （configureGlobalAgents → require_undici）。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
if (typeof globalThis.File === 'undefined') {
  try {
    // Node 18.13+ 在 node:buffer 中暴露了 File，但不是全局变量。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { File: NodeFile } = require('node:buffer')
    // @ts-expect-error -- polyfilling missing global
    globalThis.File = NodeFile
  } catch {
    // 绝对回退：创建存根使 `MakeTypeAssertion(File)` 不抛出异常。
    // @ts-expect-error -- minimal polyfill
    globalThis.File = class File extends Blob {
      name: string
      lastModified: number
      constructor(parts: BlobPart[], name: string, opts?: FilePropertyBag) {
        super(parts, opts)
        this.name = name
        this.lastModified = opts?.lastModified ?? Date.now()
      }
    }
  }
}

// OpenClaude: 默认禁用实验性 API beta。
// 工具搜索（defer_loading）、全局缓存范围和上下文管理
// 需要外部账户不可用的内部 API 支持 → 返回 500。
// 用户可以通过 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=false 选择启用。
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= 'true'

// 修复 corepack 自动固定的问题，它会将 yarnpkg 添加到用户的 package.json 中
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 为子进程设置最大堆大小。当前 CLI 进程此时已在运行；
// 包启动器在导入 dist/cli.mjs 之前已提高了堆限制。
// 在此保留 NODE_OPTIONS 可为启动后生成的工具或子进程
// 维持更大的上限，而不会覆盖用户提供的限制。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || ''
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192'
}

// Harness-science L0 消融基线。在此内联（而非 init.ts）是因为
// BashTool/AgentTool/PowerShellTool 在导入时将 DISABLE_BACKGROUND_TASKS
// 捕获为模块级常量 —— init() 运行太晚。feature() 门控
// 会在外部构建中通过死代码消除移除整个代码块。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * 引导入口点 —— 在加载完整 CLI 之前检查特殊标志。
 * 所有导入都是动态的，以最小化快速路径的模块求值。
 * --version 的快速路径除了此文件外零导入。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // --version/-v 的快速路径：无需加载任何模块
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建时内联
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.DISPLAY_VERSION ?? MACRO.VERSION} (OpenClaude)`);
    return;
  }

  // --provider: 尽早设置 Provider 环境变量，使保存的配置文件解析、
  // 验证和启动横幅都能看到预期的 Provider/模型。
  if (args.includes('--provider')) {
    const { applyProviderFlagFromArgs } = await import('../utils/providerFlag.js');
    const result = applyProviderFlagFromArgs(args, {
      rememberForSettingsEnv: true,
    });
    if (result?.error) {
      // biome-ignore lint/suspicious/noConsole:: intentional error output
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  }

  // 首先启用配置，以便读取设置
  {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
  }

  // 从用户设置中应用 settings.env（包括来自 /onboard-github 的 GitHub Provider 设置）
  {
    const { applySafeConfigEnvironmentVariables } = await import('../utils/managedEnv.js')
    applySafeConfigEnvironmentVariables()
  }

  const hasConfiguredProviderProfile = await (async () => {
    const { getActiveProviderProfile } = await import('../utils/providerProfiles.js')
    return getActiveProviderProfile() !== undefined
  })()

  const startupEnv = await buildStartupEnvFromProfile({
    processEnv: process.env,
    hasConfiguredProviderProfile,
  })
  if (startupEnv !== process.env) {
    const startupProfileError = await getProviderValidationError(startupEnv)
    if (startupProfileError && !isDefaultStartupProviderEnv(startupEnv)) {
      console.error(
        `Warning: ignoring saved provider profile. ${startupProfileError}`,
      )
    } else {
      applyProfileEnvToProcessEnv(process.env, startupEnv)
    }
  }

  // 面板/窗口队友作为全新的 CLI 进程启动。如果父进程
  // 选择了已配置的 agentModels 键，在 Provider 验证和
  // --model 环境路由在此子进程中运行之前应用该路由。
  {
    const { eagerLoadSettingsFromArgs } = await import(
      '../utils/settings/flagSettings.js'
    )
    const settingsLoadResult = eagerLoadSettingsFromArgs(args)
    if (!settingsLoadResult.ok) {
      if (settingsLoadResult.cause instanceof Error) {
        const { logError } = await import('../utils/log.js')
        logError(settingsLoadResult.cause)
      }
      const { default: chalk } = await import('chalk')
      process.stderr.write(chalk.red(`${settingsLoadResult.message}\n`))
      process.exit(1)
    }

    const {
      applyAgentProviderOverrideToEnv,
      resolveOutOfProcessTeammateProviderFromCliArgs,
    } = await import('../services/api/agentRouting.js')
    const { getInitialSettings } = await import('../utils/settings/settings.js')
    const providerOverride = resolveOutOfProcessTeammateProviderFromCliArgs(
      args,
      getInitialSettings(),
    )
    if (providerOverride) {
      applyAgentProviderOverrideToEnv(providerOverride)
    }
  }

  // 在应用配置文件后补充 GitHub 凭证，以便配置文件中的 CLAUDE_CODE_USE_GITHUB 可用
  {
    const {
      hydrateGithubModelsTokenFromSecureStorage,
      refreshGithubModelsTokenIfNeeded,
    } = await import('../utils/githubModelsCredentials.js')
    await refreshGithubModelsTokenIfNeeded()
    hydrateGithubModelsTokenFromSecureStorage()
  }

  await validateProviderEnvForStartupOrExit()

  // #808: 仅 --model（无 --provider）—— 在横幅打印前路由到
  // 活跃 Provider 对应的环境变量，使覆盖可见。
  if (args.includes('--model')) {
    const { applyModelFlagFromArgs } = await import('../utils/providerFlag.js')
    applyModelFlagFromArgs(args)
  }

  // 尽早解析 --model，使启动屏幕可以显示覆盖值
  const { eagerParseCliFlag } = await import('../utils/cliArgs.js')
  const earlyModelFlag = eagerParseCliFlag('--model')

  // 在 Ink UI 加载之前打印渐变启动屏幕
  const { printStartupScreen } = await import('../components/StartupScreen.js')
  printStartupScreen(earlyModelFlag)

  // 对于所有其他路径，加载启动性能分析器
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // --dump-system-prompt 的快速路径：输出渲染后的系统提示并退出。
  // 用于提示敏感度评估，以提取特定提交的系统提示。
  // 仅限内部：通过特性标志从外部构建中移除。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const {
      runClaudeInChromeMcpServer
    } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const {
      runChromeNativeHost
    } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // `--daemon-worker=<kind>` 的快速路径（内部 —— 由监控进程生成）。
  // 必须在 daemon 子命令检查之前：按 worker 生成，因此对性能敏感。
  // 此层不需要 enableConfigs() 和分析接收器 —— worker 很轻量。
  // 如果 worker 类型需要配置/认证（assistant 会），它在自己的
  // run() 函数内调用。
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // `claude remote-control` 的快速路径（也接受旧版 `claude remote` / `claude sync` / `claude bridge`）：
  // 将本地机器作为桥接环境提供服务。
  // feature() 必须保持内联以便构建时死代码消除；
  // isBridgeEnabled() 检查运行时 GrowthBook 门控。
  if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc' || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
    profileCheckpoint('cli_bridge_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getBridgeDisabledReason,
      checkBridgeMinVersion
    } = await import('../bridge/bridgeEnabled.js');
    const {
      BRIDGE_LOGIN_ERROR
    } = await import('../bridge/types.js');
    const {
      bridgeMain
    } = await import('../bridge/bridgeMain.js');
    const {
      exitWithError
    } = await import('../utils/process.js');

    // 认证检查必须在 GrowthBook 门控检查之前 —— 没有认证，
    // GrowthBook 没有用户上下文，会返回过时的/默认的 false。
    // getBridgeDisabledReason 等待 GB 初始化，所以返回的值是新的
    // （不是过时的磁盘缓存），但初始化仍需要认证头才能工作。
    const {
      getClaudeAIOAuthTokens
    } = await import('../utils/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge 是远程控制功能 —— 检查策略限制
    const {
      waitForPolicyLimitsToLoad,
      isPolicyAllowed
    } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    await bridgeMain(args.slice(1));
    return;
  }

  // `claude daemon [subcommand]` 的快速路径：长时间运行的监控进程。
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // `claude ps|logs|attach|kill` 和 `--bg`/`--background` 的快速路径。
  // 基于 ~/.claude/sessions/ 注册表的会话管理。标志字面量
  // 内联以便 bg.js 仅在实际分发时加载。
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        await bg.killHandler(args[1]);
        break;
      default:
        await bg.handleBgFlag(args);
    }
    return;
  }

  // 模板作业命令的快速路径。
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // 使用 process.exit（而非 return）—— mountFleetView 的 Ink TUI
    // 可能留下阻止自然退出的事件循环句柄。
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // `claude environment-runner` 的快速路径：无头 BYOC 运行器。
  // feature() 必须保持内联以便构建时死代码消除。
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // `claude self-hosted-runner` 的快速路径：无头自托管运行器，
  // 目标是 SelfHostedRunnerWorkerService API（注册 + 轮询；轮询即心跳）。
  // feature() 必须保持内联以便构建时死代码消除。
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // --worktree --tmux 的快速路径：在加载完整 CLI 之前 exec 进入 tmux
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // 如果未处理（例如出错），回退到正常 CLI
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // 将常见的更新标志误用重定向到 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: 尽早设置 SIMPLE，使门控在模块求值/commander 选项构建时
  // 触发（而不仅是在 action 处理器内部）。
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // 未检测到特殊标志，加载并运行完整 CLI
  if (process.env.OPENCLAUDE_DISABLE_EARLY_INPUT !== '1') {
    const {
      startCapturingEarlyInput
    } = await import('../utils/earlyInput.js');
    startCapturingEarlyInput();
  }
  profileCheckpoint('cli_before_main_import');
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
