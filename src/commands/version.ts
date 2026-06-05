import type { Command, LocalCommandCall } from '../types/command.js'

// 版本命令的处理函数：返回当前版本号，如果有构建时间则一并显示
const call: LocalCommandCall = async () => {
  return {
    type: 'text',
    value: MACRO.BUILD_TIME
      ? `${MACRO.VERSION} (built ${MACRO.BUILD_TIME})` // 有构建时间时显示版本号和构建时间
      : MACRO.VERSION, // 否则只显示版本号
  }
}

// 版本命令定义
const version = {
  type: 'local', // 本地命令，不需要 LLM 处理
  name: 'version',
  description:
    'Print the version this session is running (not what autoupdate downloaded)', // 打印当前会话运行的版本（非自动更新下载的版本）
  isEnabled: () => process.env.USER_TYPE === 'ant', // 仅对内部用户启用
  supportsNonInteractive: true, // 支持非交互模式
  load: () => Promise.resolve({ call }), // 延迟加载处理函数
} satisfies Command

export default version
