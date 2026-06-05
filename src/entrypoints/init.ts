import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js' // 引导状态模块，初始化全局状态
import '../utils/config.js' // 配置模块，初始化配置系统
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import { populateOAuthAccountInfoIfNeeded } from '../services/oauth/client.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policyLimits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remoteManagedSettings/index.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径中动态导入，避免在初始化时加载 React
import {
  gracefulShutdownSync,
  setupGracefulShutdown,
} from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import {
  ensureScratchpadDir,
  isScratchpadEnabled,
} from '../utils/permissions/filesystem.js'
import { configureGlobalAgents } from '../utils/proxy.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'


// 初始化函数（使用 memoize 确保只执行一次）
export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 验证配置是否有效并启用配置系统
  try {
    const configsStart = Date.now()
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在信任对话框之前只应用安全的环境变量
    // 完整的环境变量在信任建立后才会应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 在任何 TLS 连接之前，将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env。
    // Bun 在启动时通过 BoringSSL 缓存 TLS 证书存储，所以这必须在第一次 TLS 握手之前完成。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保退出时数据被刷新
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 第一方事件日志和 GrowthBook 初始化已移除（空操作存根）
    profileCheckpoint('init_after_1p_event_logging')

    // 如果 OAuth 账户信息尚未缓存在配置中，则填充它。
    // 这是必要的，因为通过 VSCode 扩展登录时可能不会填充 OAuth 账户信息。
    void populateOAuthAccountInfoIfNeeded()
    profileCheckpoint('init_after_oauth_populate')

    // 异步初始化 JetBrains IDE 检测（填充缓存供后续同步访问）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充缓存供 gitDiff PR 链接使用）
    void detectCurrentRepository()

    // 尽早初始化加载 Promise，以便其他系统（如插件钩子）
    // 可以等待远程设置加载。该 Promise 包含超时机制，防止
    // loadRemoteManagedSettings() 从未被调用时发生死锁（例如 Agent SDK 测试）。
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间
    recordFirstStartTime()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    logForDebugging('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    logForDebugging('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP 代理（代理和/或 mTLS）
    const proxyStart = Date.now()
    logForDebugging('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    logForDebugging('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接到 Anthropic API — 重叠 TCP+TLS 握手
    // （约 100-200ms）与 API 请求前约 100ms 的 action-handler 工作。
    // 在 CA 证书 + 代理配置之后执行，以便预热连接使用正确的传输。
    // 即发即忘；对于代理/mTLS/unix/云提供商跳过，
    // 因为 SDK 的调度器不会重用全局连接池。
    preconnectAnthropicApi()

    // CCR 上游代理：启动本地 CONNECT 中继，使代理子进程
    // 可以通过凭据注入访问组织配置的上游代理。
    // 受 CLAUDE_CODE_REMOTE + GrowthBook 控制；任何错误时失败开放。
    // 懒加载导入，非 CCR 启动不需要加载该模块。
    // getUpstreamProxyEnv 函数已注册到 subprocessEnv.ts，
    // 使子进程生成可以注入代理变量而无需静态导入 upstreamproxy 模块。
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import(
          '../utils/subprocessEnv.js'
        )
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        logForDebugging(
          `[init] upstreamproxy init failed: ${err instanceof Error ? err.message : String(err)}; continuing without proxy`,
          { level: 'warn' },
        )
      }
    }

    // 如果在 Windows 上，设置 git-bash
    setShellIfWindows()

    // 注册 LSP 管理器清理（初始化在 main.tsx 中 --plugin-dir 处理后进行）
    registerCleanup(shutdownLspServerManager)

    // gh-32730：由子代理（或没有显式 TeamDelete 的主代理）
    // 创建的团队会永远留在磁盘上。为本会话创建的所有团队
    // 注册清理。懒加载导入：swarm 代码受功能门控，大多数会话不会创建团队。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import(
        '../utils/swarm/teamHelpers.js'
      )
      await cleanupSessionTeams()
    })

    // 如果启用了 scratchpad，初始化其目录
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 当无法安全渲染交互式 Ink 对话框时跳过它。
      // 该对话框会破坏 JSON 消费者（例如在 VM 沙箱中运行
      // `plugin marketplace list --json` 的桌面市场插件管理器）。
      if (getIsNonInteractiveSession()) {
        process.stderr.write(
          `Configuration error in ${error.filePath}: ${error.message}\n`,
        )
        gracefulShutdownSync(1)
        return
      }

      // 显示无效配置对话框，等待其完成
      return import('../components/InvalidConfigDialog.js').then(m =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框本身处理 process.exit，所以这里不需要额外的清理
    } else {
      // 对于非配置错误，重新抛出
      throw error
    }
  }
})

/**
 * 空操作 — 遥测初始化已被移除。
 * 保留为空函数以保持与调用方的 API 兼容性。
 */
export function initializeTelemetryAfterTrust(): void {
  // 遥测不再初始化；这是一个空操作。
}
