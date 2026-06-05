import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  isCodexRefreshFailureCoolingDown,
  readCodexCredentials,
  type CodexCredentialBlob,
} from '../../utils/codexCredentials.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  asTrimmedString,
  parseChatgptAccountId,
} from './codexOAuthShared.js'
import {
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
} from 'src/utils/providerProfile.js'
import {
  openAIShimSupportsApiFormatForModel,
  resolveOpenAIShimRuntimeContext,
} from '../../integrations/runtimeMetadata.js'

// 各 LLM 提供商的默认 API 基础 URL
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
export const DEFAULT_OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
export const DEFAULT_OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1'
/** 用户选择 copilot / github:copilot 时的默认 GitHub Copilot API 模型 */
export const DEFAULT_GITHUB_MODELS_API_MODEL = 'gpt-4o'
// 记录已警告过的环境变量名，避免重复输出日志
const warnedUndefinedEnvNames = new Set<string>()

/**
 * 规范化 Gitlawb OpenGateway 的基础 URL。
 * 将旧路径（/v1/xiaomi-mimo、/v1/gmi-cloud）重写为统一的 /v1 端点，
 * 因为这些模型已迁移到网关根路径下。
 */
function normalizeGitlawbOpengatewayBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'opengateway.gitlawb.com' && hostname !== 'opengateway.fly.dev') {
      return baseUrl
    }
    const path = parsed.pathname.replace(/\/+$/, '').toLowerCase()
    if (path === '/v1/xiaomi-mimo' || path === '/v1/gmi-cloud') {
      parsed.pathname = '/v1'
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString().replace(/\/+$/, '')
    }
  } catch {
    return baseUrl
  }
  return baseUrl
}

// Codex 模型别名映射表：将用户友好的别名（如 codexplan、codexspark）
// 解析为实际的模型 ID 和推理努力级别。
// 例如：codexplan → gpt-5.5 (high), codexspark → gpt-5.3-codex-spark (默认)
const CODEX_ALIAS_MODELS: Record<
  string,
  {
    model: string
    reasoningEffort?: ReasoningEffort
  }
> = {
  codexplan: {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  },
  'gpt-5.5': {
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  },
  'gpt-5.4': {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  },
  'gpt-5.3-codex': {
    model: 'gpt-5.3-codex',
    reasoningEffort: 'high',
  },
  'gpt-5.3-codex-spark': {
    model: 'gpt-5.3-codex-spark',
  },
  codexspark: {
    model: 'gpt-5.3-codex-spark',
  },
  'gpt-5.2-codex': {
    model: 'gpt-5.2-codex',
    reasoningEffort: 'high',
  },
  'gpt-5.1-codex-max': {
    model: 'gpt-5.1-codex-max',
    reasoningEffort: 'high',
  },
  'gpt-5.1-codex-mini': {
    model: 'gpt-5.1-codex-mini',
  },
  'gpt-5.5-mini': {
    model: 'gpt-5.5-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.4-mini': {
    model: 'gpt-5.4-mini',
    reasoningEffort: 'medium',
  },
  'gpt-5.2': {
    model: 'gpt-5.2',
    reasoningEffort: 'medium',
  },
} as const

// Codex 别名类型，用于类型安全的别名查找
type CodexAlias = keyof typeof CODEX_ALIAS_MODELS
// 推理努力级别：控制模型在推理时投入的计算量
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

// OpenAI Codex 快捷别名集合（codexplan 和 codexspark）
const OPENAI_CODEX_SHORTCUT_ALIASES = new Set(['codexplan', 'codexspark'])

// 提供商传输协议类型：
// - chat_completions: 标准 OpenAI Chat Completions API
// - responses: OpenAI Responses API（较新的 API 格式）
// - codex_responses: Codex 专用的 Responses API
export type ProviderTransport = 'chat_completions' | 'responses' | 'codex_responses'
// OpenAI 兼容的 API 格式类型
export type OpenAICompatibleApiFormat = 'chat_completions' | 'responses'

// 解析后的提供商请求配置，包含传输协议、模型信息和基础 URL
export type ResolvedProviderRequest = {
  transport: ProviderTransport
  requestedModel: string
  resolvedModel: string
  baseUrl: string
  reasoning?: {
    effort: ReasoningEffort
  }
}

// 解析后的 Codex 凭证，包含 API 密钥、账户 ID 和凭证来源
export type ResolvedCodexCredentials = {
  apiKey: string
  accountId?: string
  authPath?: string
  source: 'env' | 'secure-storage' | 'auth.json' | 'none'
}

// 模型描述符：解析模型字符串后的结构化表示
type ModelDescriptor = {
  raw: string
  baseModel: string
  reasoning?: {
    effort: ReasoningEffort
  }
}

// 本地主机名集合，用于判断 URL 是否指向本地服务
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

// 对缓存作用域分区值进行哈希，生成 16 字符的 SHA-256 前缀
function hashCacheScopePartition(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 16)
}

// 规范化缓存作用域头值，去除首尾空白
function normalizeCacheScopeHeaderValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

// 判断是否为 RFC1918 私有 IPv4 地址（10.x、172.16-31.x、192.168.x）
function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split('.').map(part => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some(octet => Number.isNaN(octet))) {
    return false
  }

  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  )
}

// 判断是否为私有 IPv6 地址（ULA fc00::/7 或链路本地 fe80::/10）
function isPrivateIpv6Address(hostname: string): boolean {
  const firstHextet = hostname.split(':', 1)[0]
  if (!firstHextet) return false

  const prefix = Number.parseInt(firstHextet, 16)
  if (Number.isNaN(prefix)) return false

  return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80
}

// 读取一个环境变量风格的字符串（用作 URL 或路径），拒绝空字符串
// 以及 Windows shell 在变量未设置但无引号引用时可能写入的字面量
// "undefined"（issue #336）。
function asEnvUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === 'undefined') {
    return undefined
  }
  return trimmed
}

// 带命名的环境 URL 读取：与 asEnvUrl 类似，但对字面量 "undefined" 值
// 输出调试日志（仅首次），帮助用户发现环境变量配置错误。
function asNamedEnvUrl(
  value: string | undefined,
  envName: string,
): string | undefined {
  if (!value) return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (trimmed === 'undefined') {
    if (!warnedUndefinedEnvNames.has(envName)) {
      warnedUndefinedEnvNames.add(envName)
      logForDebugging(
        `[provider-config] Environment variable ${envName} is the literal string "undefined"; ignoring it.`,
        { level: 'warn' },
      )
    }
    return undefined
  }

  return trimmed
}

// 从嵌套对象中按路径读取字符串值，支持多种可能的路径格式
function readNestedString(
  value: unknown,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let current = value
    let valid = true
    for (const key of path) {
      if (!current || typeof current !== 'object' || !(key in current)) {
        valid = false
        break
      }
      current = (current as Record<string, unknown>)[key]
    }
    if (!valid) continue
    const stringValue = asTrimmedString(current)
    if (stringValue) return stringValue
  }
  return undefined
}

// 解析推理努力级别字符串，不合法值返回 undefined
function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized
  }
  return undefined
}

// 解析 OpenAI 兼容的 API 格式字符串，支持多种别名写法
export function parseOpenAICompatibleApiFormat(
  value: string | undefined,
): OpenAICompatibleApiFormat | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase().replace(/[- ]+/g, '_')
  if (
    normalized === 'responses' ||
    normalized === 'response' ||
    normalized === 'responses_api'
  ) {
    return 'responses'
  }
  if (
    normalized === 'chat_completions' ||
    normalized === 'chat_completion' ||
    normalized === 'completions' ||
    normalized === 'completion' ||
    normalized === 'chat'
  ) {
    return 'chat_completions'
  }
  return undefined
}

// 解析模型描述符：将模型字符串（可能含查询参数如 ?reasoning=high）
// 解析为结构化的 ModelDescriptor，支持 Codex 别名解析
function parseModelDescriptor(model: string): ModelDescriptor {
  const trimmed = model.trim()
  const queryIndex = trimmed.indexOf('?')
  if (queryIndex === -1) {
    const alias = trimmed.toLowerCase() as CodexAlias
    const aliasConfig = CODEX_ALIAS_MODELS[alias]
    if (aliasConfig) {
      return {
        raw: trimmed,
        baseModel: aliasConfig.model,
        reasoning: aliasConfig.reasoningEffort
          ? { effort: aliasConfig.reasoningEffort }
          : undefined,
      }
    }
    return {
      raw: trimmed,
      baseModel: trimmed,
    }
  }

  const baseModel = trimmed.slice(0, queryIndex).trim()
  const params = new URLSearchParams(trimmed.slice(queryIndex + 1))
  const alias = baseModel.toLowerCase() as CodexAlias
  const aliasConfig = CODEX_ALIAS_MODELS[alias]
  const resolvedBaseModel = aliasConfig?.model ?? baseModel
  const reasoning =
    parseReasoningEffort(params.get('reasoning') ?? undefined) ??
    (aliasConfig?.reasoningEffort
      ? { effort: aliasConfig.reasoningEffort }
      : undefined)

  return {
    raw: trimmed,
    baseModel: resolvedBaseModel,
    reasoning: typeof reasoning === 'string' ? { effort: reasoning } : reasoning,
  }
}

// 判断模型是否为 Codex 别名（如 codexplan、gpt-5.5 等）
export function isCodexAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return base in CODEX_ALIAS_MODELS
}

function isOpenAICodexShortcutAlias(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  return OPENAI_CODEX_SHORTCUT_ALIASES.has(base)
}

// 判断是否应使用 Codex 传输协议：
// 当 base URL 指向 Codex 端点，或未指定 base URL 且模型为 Codex 别名时返回 true
export function shouldUseCodexTransport(
  model: string,
  baseUrl: string | undefined,
): boolean {
  const explicitBaseUrl = asEnvUrl(baseUrl)
  return isCodexBaseUrl(explicitBaseUrl) || (!explicitBaseUrl && isCodexAlias(model))
}

// 判断 GitHub 模型是否应使用 Responses API：
// Codex 品牌模型和 GPT-5+ 模型（gpt-5-mini 除外）使用 /responses 端点
function shouldUseGithubResponsesApi(model: string): boolean {
  const normalized = model.trim().toLowerCase()

  // Codex-branded models require /responses.
  if (normalized.includes('codex')) return true

  // GPT-5+ models use /responses, except gpt-5-mini.
  const match = /^gpt-(\d+)/.exec(normalized)
  if (!match) return false
  const major = Number(match[1])
  if (major < 5) return false
  if (normalized.startsWith('gpt-5-mini')) return false
  return true
}

/**
 * 判断 URL 是否指向本地提供商（环回地址、RFC1918 私有地址、.local 域名、ULA/链路本地 IPv6）。
 * 用于决定是否启用本地快速路径优化。
 */
export function isLocalProviderUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    let hostname = new URL(baseUrl).hostname.toLowerCase()

    // Strip IPv6 brackets added by the URL parser (e.g. "[::1]" -> "::1")
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1)
    }

    // Strip RFC6874 IPv6 zone identifiers (e.g. "fe80::1%25en0" -> "fe80::1")
    const zoneIdIndex = hostname.indexOf('%25')
    if (zoneIdIndex !== -1) {
      hostname = hostname.slice(0, zoneIdIndex)
    }

    if (LOCALHOST_HOSTNAMES.has(hostname) || hostname === '0.0.0.0') {
      return true
    }
    if (hostname.endsWith('.local')) {
      return true
    }

    const ipVersion = isIP(hostname)
    if (ipVersion === 4) {
      // Treat the full 127.0.0.0/8 loopback range as local
      const firstOctet = Number.parseInt(hostname.split('.', 1)[0] ?? '', 10)
      return firstOctet === 127 || isPrivateIpv4Address(hostname)
    }
    if (ipVersion === 6) {
      return isPrivateIpv6Address(hostname)
    }

    return false
  } catch {
    return false
  }
}

// 当提供商是本地 OpenAI 兼容端点时，可安全（且有益）的快速路径跳过。
// 这些功能是为云服务行为设计的，在本地后端不存在：
//   - 字节稳定序列化（`stableStringify`）针对 OpenAI/Kimi/DeepSeek/Codex
//     的隐式前缀缓存；本地后端不会哈希请求前缀，深度键排序纯属 CPU 开销。
//   - 严格工具模式规范化将 Anthropic schema 重写为 Groq/Azure 要求的
//     `additionalProperties: false` 形式；本地 llama.cpp/vLLM 接受两种形式，
//     递归遍历是浪费。
//   - 工具结果压缩为无状态云提供商分层 tool_result 块；在单用户本地机器上，
//     对话存于 RAM 中，分层遍历是浪费的，除非用户选择重新启用。
//
// Issue #1016 追踪到累积的客户端开销是 v0.5+ 相对 ~45 tok/s 本地模型
// 性能退化的主因：在 200ms 云 API 前这些层不可见，但在多秒本地往返中
// 它们会逐调用叠加。
//
// 设置 `OPENCLAUDE_LOCAL_FAST_PATH=1` 强制开启，`=0` 强制关闭，
// 或不设置让 `isLocalProviderUrl` 决定。此跳过设计为保守策略：
// 如果环境变量显式设置，调用者可审计退化；否则行为仅对已被现有检测器
// （环回、RFC1918、.local、ULA/LL）分类为本地的主机生效。
const LOCAL_FAST_PATH_ENV = 'OPENCLAUDE_LOCAL_FAST_PATH'

export type LocalFastPathConfig = {
  enabled: boolean
  skipStableStringify: boolean
  skipStrictTools: boolean
  skipToolHistoryCompression: boolean
}

const LOCAL_FAST_PATH_OFF: LocalFastPathConfig = {
  enabled: false,
  skipStableStringify: false,
  skipStrictTools: false,
  skipToolHistoryCompression: false,
}

const LOCAL_FAST_PATH_ON: LocalFastPathConfig = {
  enabled: true,
  skipStableStringify: true,
  skipStrictTools: true,
  skipToolHistoryCompression: true,
}

function parseLocalFastPathOverride(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'auto') return undefined
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  return undefined
}

export function getLocalFastPathConfig(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LocalFastPathConfig {
  const override = parseLocalFastPathOverride(env[LOCAL_FAST_PATH_ENV])
  const enabled = override ?? isLocalProviderUrl(baseUrl)
  return enabled ? LOCAL_FAST_PATH_ON : LOCAL_FAST_PATH_OFF
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePathWithV1(pathname: string): string {
  const trimmed = trimTrailingSlash(pathname)
  if (!trimmed || trimmed === '/') {
    return '/v1'
  }

  if (trimmed.toLowerCase().endsWith('/v1')) {
    return trimmed
  }

  return `${trimmed}/v1`
}

export function isLikelyOllamaEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()

    if (parsed.port === '11434') {
      return true
    }

    return (
      hostname.includes('ollama') ||
      pathname.includes('ollama')
    )
  } catch {
    return false
  }
}

export function getLocalProviderRetryBaseUrls(baseUrl: string): string[] {
  if (!isLocalProviderUrl(baseUrl)) {
    return []
  }

  try {
    const parsed = new URL(baseUrl)
    const original = trimTrailingSlash(parsed.toString())
    const seen = new Set<string>([original])
    const candidates: string[] = []

    const addCandidate = (hostname: string, pathname: string): void => {
      const next = new URL(parsed.toString())
      next.hostname = hostname
      next.pathname = pathname
      next.search = ''
      next.hash = ''

      const normalized = trimTrailingSlash(next.toString())
      if (seen.has(normalized)) {
        return
      }

      seen.add(normalized)
      candidates.push(normalized)
    }

    const v1Pathname = normalizePathWithV1(parsed.pathname)
    if (v1Pathname !== trimTrailingSlash(parsed.pathname)) {
      addCandidate(parsed.hostname, v1Pathname)
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') {
      addCandidate('127.0.0.1', parsed.pathname || '/')
      addCandidate('127.0.0.1', v1Pathname)
    }

    return candidates
  } catch {
    return []
  }
}

export function shouldAttemptLocalToollessRetry(options: {
  baseUrl: string
  hasTools: boolean
}): boolean {
  if (!options.hasTools) {
    return false
  }

  if (!isLocalProviderUrl(options.baseUrl)) {
    return false
  }

  return isLikelyOllamaEndpoint(options.baseUrl)
}

export function isCodexBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(baseUrl)
    return (
      parsed.hostname === 'chatgpt.com' &&
      parsed.pathname.replace(/\/+$/, '') === '/backend-api/codex'
    )
  } catch {
    return false
  }
}

/**
 * Normalize user model string for GitHub Copilot API inference.
 * Mirrors how Copilot resolves model IDs internally.
 */
export function normalizeGithubCopilotModel(requestedModel: string): string {
  const noQuery = requestedModel.split('?', 1)[0] ?? requestedModel
  const segment =
    noQuery.includes(':') ? noQuery.split(':', 2)[1]!.trim() : noQuery.trim()
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Strip provider prefix if present (e.g., "openai/gpt-4o" -> "gpt-4o")
  const slashIndex = segment.indexOf('/')
  if (slashIndex !== -1) {
    return segment.slice(slashIndex + 1)
  }
  return segment
}

/**
 * Normalize user model string for GitHub Models API inference.
 * Only normalizes the default alias, preserves provider-qualified models.
 */
export function normalizeGithubModelsApiModel(requestedModel: string): string {
  const noQuery = requestedModel.split('?', 1)[0] ?? requestedModel
  const segment =
    noQuery.includes(':') ? noQuery.split(':', 2)[1]!.trim() : noQuery.trim()
  // Only normalize the default alias for GitHub Models
  if (!segment || segment.toLowerCase() === 'copilot') {
    return DEFAULT_GITHUB_MODELS_API_MODEL
  }
  // Preserve provider prefix for GitHub Models (e.g., "openai/gpt-4.1" stays as-is)
  return segment
}

export const GITHUB_COPILOT_BASE_URL = 'https://api.githubcopilot.com'
export const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference'

export function getGithubEndpointType(
  baseUrl: string | undefined,
): 'copilot' | 'models' | 'custom' {
  if (!baseUrl) return 'copilot'
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'api.githubcopilot.com') {
      return 'copilot'
    }
    if (hostname === 'models.github.ai' || hostname.endsWith('.github.ai')) {
      return 'models'
    }
    return 'custom'
  } catch {
    return 'copilot'
  }
}

/**
 * 核心函数：解析并确定提供商请求配置。
 *
 * 根据环境变量和选项参数，确定：
 * 1. 使用哪个模型（支持别名解析、查询参数、提供商特定默认值）
 * 2. 使用哪个 base URL（优先级：显式参数 > 环境变量 > 默认值）
 * 3. 使用哪种传输协议（chat_completions / responses / codex_responses）
 * 4. 推理努力级别
 *
 * 提供商模式优先级：GitHub > Mistral > Gemini > 默认（OpenAI/Codex）
 */
export function resolveProviderRequest(options?: {
  model?: string
  baseUrl?: string
  fallbackModel?: string
  reasoningEffortOverride?: ReasoningEffort
  apiFormat?: OpenAICompatibleApiFormat | string
}): ResolvedProviderRequest {
  const isGithubMode = isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB)
  const isMistralMode = isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL)
  const isGeminiMode = isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI)
  const requestedModel =
    options?.model?.trim() ||
    (isMistralMode
      ? process.env.MISTRAL_MODEL?.trim()
      : process.env.OPENAI_MODEL?.trim()) ||
    (isGeminiMode
      ? process.env.GEMINI_MODEL?.trim()
      : process.env.OPENAI_MODEL?.trim()) ||
    options?.fallbackModel?.trim() ||
    (isGeminiMode ? DEFAULT_GEMINI_MODEL : undefined) ||
    (isGithubMode ? 'github:copilot' : 'codexplan')
  const descriptor = parseModelDescriptor(requestedModel)
  const explicitBaseUrl = asEnvUrl(options?.baseUrl)

  const normalizedMistralEnvBaseUrl = asNamedEnvUrl(
    process.env.MISTRAL_BASE_URL,
    'MISTRAL_BASE_URL',
  )

  const normalizedGeminiEnvBaseUrl = asNamedEnvUrl(
    process.env.GEMINI_BASE_URL,
    'GEMINI_BASE_URL',
  )

  const primaryEnvBaseUrl = isMistralMode
    ? normalizedMistralEnvBaseUrl
    : isGeminiMode
    ? normalizedGeminiEnvBaseUrl
    : asNamedEnvUrl(process.env.OPENAI_BASE_URL, 'OPENAI_BASE_URL')

  // In Mistral mode, a literal "undefined" MISTRAL_BASE_URL is treated as
  // misconfiguration and falls back to OPENAI_API_BASE, then
  // DEFAULT_MISTRAL_BASE_URL for a safe default endpoint.
  const fallbackEnvBaseUrl = isMistralMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_MISTRAL_BASE_URL
      : undefined)
    : isGeminiMode
    ? (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE') ?? DEFAULT_GEMINI_BASE_URL
      : undefined)
    : (primaryEnvBaseUrl === undefined
      ? asNamedEnvUrl(process.env.OPENAI_API_BASE, 'OPENAI_API_BASE')
      : undefined)

  const envBaseUrlRaw =
    explicitBaseUrl ??
    primaryEnvBaseUrl ??
    fallbackEnvBaseUrl

  const isCodexModelForGithub = isGithubMode && isCodexAlias(requestedModel)
  const envBaseUrl =
    isCodexModelForGithub && envBaseUrlRaw && getGithubEndpointType(envBaseUrlRaw) === 'custom'
      ? undefined
      : envBaseUrlRaw

  const rawBaseUrl = explicitBaseUrl ?? envBaseUrl

  const shellModel = process.env.OPENAI_MODEL?.trim() ?? ''
  const envIsCodexShortcut = isOpenAICodexShortcutAlias(shellModel)
  const envResolvedCodexModel = envIsCodexShortcut
    ? parseModelDescriptor(shellModel).baseModel
    : null
  const requestedMatchesEnvCodexShortcut =
    Boolean(options?.model) &&
    Boolean(envResolvedCodexModel) &&
    descriptor.baseModel === envResolvedCodexModel
  const isCodexAliasModel =
    isOpenAICodexShortcutAlias(requestedModel) || requestedMatchesEnvCodexShortcut
  const hasUserSetBaseUrl = rawBaseUrl && rawBaseUrl !== DEFAULT_OPENAI_BASE_URL
  const finalBaseUrlRaw =
    !isGithubMode && isCodexAliasModel && !hasUserSetBaseUrl
      ? DEFAULT_CODEX_BASE_URL
      : rawBaseUrl
  const finalBaseUrl = normalizeGitlawbOpengatewayBaseUrl(finalBaseUrlRaw)

  const githubEndpointType = isGithubMode
    ? getGithubEndpointType(rawBaseUrl)
    : 'custom'
  const isGithubCopilot = isGithubMode && githubEndpointType === 'copilot'
  const isGithubModels = isGithubMode && githubEndpointType === 'models'
  const isGithubCustom = isGithubMode && githubEndpointType === 'custom'

  const githubResolvedModel = isGithubMode
    ? normalizeGithubModelsApiModel(requestedModel)
    : requestedModel

  const requestedApiFormat =
    isGithubMode
      ? undefined
      : parseOpenAICompatibleApiFormat(options?.apiFormat) ??
        parseOpenAICompatibleApiFormat(process.env.OPENAI_API_FORMAT)
  const supportsRequestedApiFormat =
    requestedApiFormat !== 'responses' ||
    (() => {
      const runtimeShimContext = resolveOpenAIShimRuntimeContext({
        processEnv: process.env,
        baseUrl: finalBaseUrl,
        model: descriptor.baseModel,
        treatAsLocal: finalBaseUrl ? isLocalProviderUrl(finalBaseUrl) : false,
      })

      return openAIShimSupportsApiFormatForModel(
        runtimeShimContext.openaiShimConfig,
        'responses',
        descriptor.baseModel,
      )
    })()
  const transport: ProviderTransport =
    shouldUseCodexTransport(requestedModel, finalBaseUrl) ||
      (isGithubCopilot && shouldUseGithubResponsesApi(githubResolvedModel))
      ? 'codex_responses'
      : requestedApiFormat === 'responses' && supportsRequestedApiFormat
        ? 'responses'
        : 'chat_completions'

  // For GitHub Copilot API, normalize to real model ID (e.g., "github:copilot" -> "gpt-4o")
  // For GitHub Models/custom endpoints:
  //   - Normalize default alias (github:copilot -> gpt-4o)
  //   - Preserve provider-qualified models (openai/gpt-4.1 stays as-is)
  const resolvedModel = isGithubCopilot
    ? normalizeGithubCopilotModel(descriptor.baseModel)
    : (isGithubModels || isGithubCustom
      ? normalizeGithubModelsApiModel(descriptor.baseModel)
      : descriptor.baseModel)

  const reasoning = options?.reasoningEffortOverride
    ? { effort: options.reasoningEffortOverride }
    : descriptor.reasoning

  return {
    transport,
    requestedModel,
    resolvedModel,
    baseUrl:
      (finalBaseUrl ??
        (isGithubCopilot && transport === 'codex_responses'
          ? GITHUB_COPILOT_BASE_URL
          : (isGithubMode
            ? GITHUB_COPILOT_BASE_URL
            : DEFAULT_OPENAI_BASE_URL))
      ).replace(/\/+$/, ''),
    reasoning,
  }
}

export function getAdditionalModelOptionsCacheScope(): string | null {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)) {
    if (!isEnvTruthy(process.env.CLAUDE_CODE_USE_GEMINI) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_MISTRAL) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_GITHUB) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) &&
        !isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
      return 'firstParty'
    }
    return null
  }

  const request = resolveProviderRequest()
  if (request.transport !== 'chat_completions') {
    return null
  }

  if (!isLocalProviderUrl(request.baseUrl)) {
    return null
  }

  const partition = hashCacheScopePartition({
    apiKey: normalizeCacheScopeHeaderValue(process.env.OPENAI_API_KEY),
    authHeader: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_HEADER).toLowerCase(),
    authScheme: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_SCHEME).toLowerCase(),
    authHeaderValue: normalizeCacheScopeHeaderValue(process.env.OPENAI_AUTH_HEADER_VALUE),
    customHeaders: normalizeCacheScopeHeaderValue(process.env.ANTHROPIC_CUSTOM_HEADERS),
  })

  return `openai:${request.baseUrl.toLowerCase()}:${partition}`
}

export function resolveCodexAuthPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = asTrimmedString(env.CODEX_AUTH_JSON_PATH)
  if (explicit) return explicit

  const codexHome = asTrimmedString(env.CODEX_HOME)
  if (codexHome) return join(codexHome, 'auth.json')

  return join(homedir(), '.codex', 'auth.json')
}

function loadCodexAuthJson(
  authPath: string,
): Record<string, unknown> | undefined {
  if (!existsSync(authPath)) return undefined
  try {
    const raw = readFileSync(authPath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function resolveCodexAuthJsonCredentials(options: {
  authJson: Record<string, unknown> | undefined
  authPath: string
  envAccountId?: string
  missingSource?: ResolvedCodexCredentials['source']
}): ResolvedCodexCredentials {
  const { authJson, authPath, envAccountId } = options

  if (!authJson) {
    return {
      apiKey: '',
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  const apiKey = readNestedString(authJson, [
    ['openai_api_key'],
    ['openaiApiKey'],
    ['access_token'],
    ['accessToken'],
    ['tokens', 'access_token'],
    ['tokens', 'accessToken'],
    ['auth', 'access_token'],
    ['auth', 'accessToken'],
    ['token', 'access_token'],
    ['token', 'accessToken'],
  ])
  // OIDC identity tokens can carry the ChatGPT account id, but they are not
  // valid bearer credentials for Codex API requests.
  const idToken = readNestedString(authJson, [
    ['id_token'],
    ['idToken'],
    ['tokens', 'id_token'],
    ['tokens', 'idToken'],
  ])
  const accountId =
    envAccountId ??
    readNestedString(authJson, [
      ['account_id'],
      ['accountId'],
      ['tokens', 'account_id'],
      ['tokens', 'accountId'],
      ['auth', 'account_id'],
      ['auth', 'accountId'],
    ]) ??
    parseChatgptAccountId(apiKey) ??
    parseChatgptAccountId(idToken)

  if (!apiKey) {
    return {
      apiKey: '',
      accountId,
      authPath,
      source: options.missingSource ?? 'none',
    }
  }

  return {
    apiKey,
    accountId,
    authPath,
    source: 'auth.json',
  }
}

export function resolveStoredCodexCredentials(options: {
  storedCredentials: Pick<
    CodexCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
  envAccountId?: string
}): ResolvedCodexCredentials {
  const { storedCredentials, envAccountId } = options

  return {
    apiKey: storedCredentials.apiKey ?? storedCredentials.accessToken,
    accountId:
      envAccountId ??
      storedCredentials.accountId ??
      parseChatgptAccountId(storedCredentials.idToken) ??
      parseChatgptAccountId(storedCredentials.accessToken),
    source: 'secure-storage',
  }
}

function resolveEnvOrAuthJsonCodexCredentials(
  env: NodeJS.ProcessEnv,
  options?: {
    explicitAuthPathOnly?: boolean
  },
): ResolvedCodexCredentials {
  const envApiKey = asTrimmedString(env.CODEX_API_KEY)
  const envAccountId =
    asTrimmedString(env.CODEX_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      accountId: envAccountId ?? parseChatgptAccountId(envApiKey),
      source: 'env',
    }
  }

  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.CODEX_AUTH_JSON_PATH) ?? asTrimmedString(env.CODEX_HOME),
  )

  if (!explicitAuthPathConfigured && options?.explicitAuthPathOnly) {
    return {
      apiKey: '',
      accountId: envAccountId,
      source: 'none',
    }
  }

  const authPath = resolveCodexAuthPath(env)
  const authJson = loadCodexAuthJson(authPath)
  return resolveCodexAuthJsonCredentials({
    authJson,
    authPath,
    envAccountId,
  })
}

export function resolveRuntimeCodexCredentials(options?: {
  env?: NodeJS.ProcessEnv
  storedCredentials?: Pick<
    CodexCredentialBlob,
    'apiKey' | 'accessToken' | 'idToken' | 'accountId'
  >
}): ResolvedCodexCredentials {
  const env = options?.env ?? process.env
  const explicitCredentials = resolveEnvOrAuthJsonCodexCredentials(env, {
    explicitAuthPathOnly: true,
  })
  const explicitAuthPathConfigured = Boolean(
    asTrimmedString(env.CODEX_AUTH_JSON_PATH) ?? asTrimmedString(env.CODEX_HOME),
  )
  const hasStoredCredentialsOption = Boolean(
    options &&
      Object.prototype.hasOwnProperty.call(options, 'storedCredentials'),
  )

  if (
    explicitAuthPathConfigured ||
    explicitCredentials.source === 'env' ||
    explicitCredentials.source === 'auth.json'
  ) {
    return explicitCredentials
  }

  if (options?.storedCredentials?.accessToken) {
    return resolveStoredCodexCredentials({
      storedCredentials: options.storedCredentials,
      envAccountId:
        asTrimmedString(env.CODEX_ACCOUNT_ID) ??
        asTrimmedString(env.CHATGPT_ACCOUNT_ID),
    })
  }

  if (hasStoredCredentialsOption) {
    return resolveEnvOrAuthJsonCodexCredentials(env)
  }

  return resolveCodexApiCredentials(env)
}

export function resolveCodexApiCredentials(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCodexCredentials {
  const envAccountId =
    asTrimmedString(env.CODEX_ACCOUNT_ID) ??
    asTrimmedString(env.CHATGPT_ACCOUNT_ID)
  const envOrExplicitAuthJsonCredentials = resolveEnvOrAuthJsonCodexCredentials(
    env,
    {
      explicitAuthPathOnly: true,
    },
  )

  if (
    envOrExplicitAuthJsonCredentials.source === 'env' ||
    envOrExplicitAuthJsonCredentials.source === 'auth.json' ||
    envOrExplicitAuthJsonCredentials.authPath
  ) {
    return envOrExplicitAuthJsonCredentials
  }

  const storedCredentials = readCodexCredentials()
  if (storedCredentials?.accessToken) {
    const resolvedStoredCredentials = resolveStoredCodexCredentials({
      storedCredentials,
      envAccountId,
    })

    const shouldCheckDefaultAuthJson =
      !resolvedStoredCredentials.accountId ||
      isCodexRefreshFailureCoolingDown(storedCredentials)

    if (!shouldCheckDefaultAuthJson) {
      return resolvedStoredCredentials
    }

    const authPath = resolveCodexAuthPath(env)
    const authJson = loadCodexAuthJson(authPath)
    const resolvedAuthJsonCredentials = resolveCodexAuthJsonCredentials({
      authJson,
      authPath,
      envAccountId,
    })

    if (resolvedAuthJsonCredentials.apiKey) {
      return {
        ...resolvedAuthJsonCredentials,
        accountId:
          resolvedAuthJsonCredentials.accountId ??
          resolvedStoredCredentials.accountId,
      }
    }

    return resolvedStoredCredentials
  }

  return resolveEnvOrAuthJsonCodexCredentials(env)
}

export function getReasoningEffortForModel(model: string): ReasoningEffort | undefined {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized
  const alias = base as CodexAlias
  const aliasConfig = CODEX_ALIAS_MODELS[alias]
  return aliasConfig?.reasoningEffort
}

export function supportsCodexReasoningEffort(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const base = normalized.split('?', 1)[0] ?? normalized

  if (base === 'gpt-5.3-codex-spark' || base === 'codexspark') {
    return false
  }

  if (getReasoningEffortForModel(base) !== undefined) {
    return true
  }

  return /^gpt-5(?:[.-]|$)/.test(base)
}
