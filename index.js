/**
 * 工作区规范化（dsh-norms）。
 * 作者：nuoyis/dsh-norms
 *
 * 把“用户重点强调的总规则”和“公共 Python 的能力参数”沉淀到根 AGENTS.md，
 * 并让每次模型的系统提示都先看到规则链：
 *   1. <工作区>/AGENTS.md（最高优先级）
 *   2. Config.ruleDirs 指定的目录区域
 *   3. <公共区>/（Python 模块与 MCP 共享文件）
 *   4. 会话归档/<会话名>/ROOT.md（本次会话的根文档）
 *
 * 插件装在 profile 里，只能 import node 内置模块；工具用普通对象注册，
 * 与已装的 context-slim 插件保持同一套写法。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { appendRule, parseModules, parseRules, readText, registerModule } from './lib/agentsmd.js'
import { auditPython, formatReport } from './lib/pyaudit.js'

export const name = 'dsh-norms'
/** 工具服务必须就绪；其它服务在内部按需取，缺了也不阻塞插件加载。 */
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  /** 用户指定的目录区域（相对工作区或绝对路径）；目录取其中的 AGENTS.md，文件则直接读。 */
  ruleDirs: ['python-public'],
  /** 公共代码区（相对工作区）。 */
  publicDir: 'python-public',
  /** MCP 共享文件区（相对工作区）。 */
  mcpDir: 'python-public/mcp',
  /** 会话根文档目录（相对工作区）。 */
  sessionRootDir: '会话归档',
  /** Python 公共性门槛：必须严格大于此值才允许登记。 */
  threshold: 85,
  /** 注入系统提示的额外区域内容总预算（字符）。 */
  maxExtraChars: 4000,
  /** 单条规则最大字符数。 */
  maxRuleChars: 500,
  /** “最近写入”保留条数。 */
  logKeep: 20,
  /** 是否把规则链摘要注入系统提示。 */
  injectPrompt: true,
  /** 是否注册工具。 */
  tool: true,
  /** 是否注册 /rule 命令。 */
  command: true,
  /** 单文件审计上限（字节），超过拒绝读入。 */
  maxScanBytes: 400000,
}

const PROMPT_SECTION = 'norms:index'
const PROMPT_ORDER = 950

function resolveConfig(config = {}) {
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (config[key] !== undefined && config[key] !== null) cfg[key] = config[key]
  }
  if (!Array.isArray(cfg.ruleDirs)) cfg.ruleDirs = [...DEFAULTS.ruleDirs]
  cfg.ruleDirs = cfg.ruleDirs.filter(item => typeof item === 'string' && item.trim() !== '')
  if (!Number.isFinite(cfg.threshold)) cfg.threshold = DEFAULTS.threshold
  if (!Number.isFinite(cfg.maxExtraChars) || cfg.maxExtraChars < 200) cfg.maxExtraChars = DEFAULTS.maxExtraChars
  if (!Number.isFinite(cfg.maxRuleChars) || cfg.maxRuleChars < 20) cfg.maxRuleChars = DEFAULTS.maxRuleChars
  if (!Number.isFinite(cfg.logKeep) || cfg.logKeep < 1) cfg.logKeep = DEFAULTS.logKeep
  if (!Number.isFinite(cfg.maxScanBytes) || cfg.maxScanBytes < 1000) cfg.maxScanBytes = DEFAULTS.maxScanBytes
  return cfg
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** 相对工作区的路径；在工作区外则保留绝对路径。 */
function displayPath(cwd, absolute) {
  const rel = relative(cwd, absolute)
  if (rel === '') return '.'
  return rel.startsWith('..') || rel.includes(':') ? normalizePath(absolute) : normalizePath(rel)
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
}

/** 读一个文本文件；不存在或不可读返回 undefined。 */
function readIfExists(file, max = 200000) {
  try {
    const stat = statSync(file)
    if (!stat.isFile()) return undefined
    const text = readFileSync(file, 'utf8')
    return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断）`
  } catch {
    return undefined
  }
}

/** 工作区根：优先取 workingDirectory 的当前值，其次会话创建时的 cwd。 */
function workspaceOf(ctx, agent) {
  const wd = ctx.get?.('workingDirectory')
  try {
    if (wd !== undefined && agent?.session !== undefined) {
      const current = wd.get(agent.session)
      if (typeof current === 'string' && current !== '') return current
    }
  } catch {
    // 取不到就回退，不影响插件
  }
  const headerCwd = agent?.session?.header?.cwd
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  if (typeof wd?.defaultDirectory === 'string' && wd.defaultDirectory !== '') return wd.defaultDirectory
  return process.cwd()
}

/** 工具里取 cwd；有 agent 时走 ensure，保证 cd 后的目录正确。 */
async function cwdForTool(ctx, exec) {
  const wd = ctx.get?.('workingDirectory')
  if (exec?.agent !== undefined && wd?.ensure !== undefined) {
    return await wd.ensure(exec.agent, exec.signal)
  }
  return workspaceOf(ctx, exec?.agent)
}

/** 规则链里的一个区域。 */
function regionOf(cwd, spec) {
  const absolute = resolve(cwd, spec)
  if (/\.md$/i.test(absolute)) return { spec, absolute, file: absolute }
  const agents = join(absolute, 'AGENTS.md')
  const readme = join(absolute, 'README.md')
  const file = existsSync(agents) ? agents : existsSync(readme) ? readme : agents
  return { spec, absolute, file }
}

/** 系统提示里的规则链摘要；任何异常都降级成一行提示，绝不让装配失败。 */
function buildPromptIndex(ctx, cfg, agent) {
  try {
    const cwd = workspaceOf(ctx, agent)
    const agentsPath = join(cwd, 'AGENTS.md')
    const agentsText = readIfExists(agentsPath, 200000) ?? ''
    const rules = agentsText === '' ? [] : parseRules(agentsText)
    const modules = agentsText === '' ? [] : parseModules(agentsText)
    const extras = cfg.ruleDirs.map(spec => {
      const region = regionOf(cwd, spec)
      return { ...region, exists: existsSync(region.file) }
    })
    const sessionHint = `${normalizePath(cfg.sessionRootDir)}/<会话名>/ROOT.md`

    const lines = [
      '## 规范化入口（dsh-norms）',
      '规则链按优先级执行，冲突时靠前的优先：',
      `1. 工作区总规范：${normalizePath(agentsPath)}${existsSync(agentsPath) ? `（已加载 ${rules.length} 条追加规则）` : '（缺失）'}`,
      '2. 用户指定目录区域：',
    ]
    for (const extra of extras) {
      lines.push(`   - ${extra.spec} → ${normalizePath(extra.file)}${extra.exists ? '' : '（暂无）'}`)
    }
    lines.push(`3. 公共区：${normalizePath(cfg.publicDir)}/（通用 Python 模块，已登记 ${modules.length} 个）；MCP 共享文件：${normalizePath(cfg.mcpDir)}/`)
    lines.push(`4. 本次会话根文档：${sessionHint}`)
    lines.push('')
    lines.push('执行约束：')
    lines.push('- 用户重点强调、要求长期生效的总规则 → norms_rule（或让用户用 /rule）写入根 AGENTS.md；不要只记在对话里。')
    lines.push(`- 新写或改动公共 Python 前先 norms_py_audit；公共性严格大于 ${cfg.threshold} 才允许 norms_py_register，登记会把 API 与参数写回根 AGENTS.md。`)
    lines.push(`- 只服务本次会话的脚本留在 ${normalizePath(cfg.sessionRootDir)}/<会话名>/，不放进公共区。`)
    lines.push('- 一次性产物放会话目录的 out/；根目录只允许目录和 AGENTS.md。')

    let budget = cfg.maxExtraChars
    for (const extra of extras) {
      if (!extra.exists || budget <= 0) continue
      const text = readIfExists(extra.file, budget)
      if (text === undefined) continue
      const shown = text.length <= budget ? text : `${text.slice(0, Math.max(1, budget - 1))}…`
      budget -= shown.length
      lines.push('')
      lines.push(`### 区域规范（${extra.spec}）`)
      lines.push(shown.trim())
    }
    return lines.join('\n')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-norms: prompt section degraded: ${error?.message ?? error}`)
    return '## 规范化入口（dsh-norms）\n规则链：先读工作区 AGENTS.md，再读 Config.ruleDirs 指定目录；强调型规则用 norms_rule 写入。'
  }
}

/** 递归列 .py；只扫公共模块目录，避开 archive。 */
function listPython(cwd, cfg) {
  const roots = [join(cwd, cfg.publicDir, 'pypub'), join(cwd, cfg.publicDir, 'mcp')]
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || found.length > 800) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'out') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.py')) found.push(full)
    }
  }
  for (const root of roots) walk(root, 0)
  return found.sort()
}

function rootStray(cwd) {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name !== 'AGENTS.md')
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function sanitizeSessionName(name, agent) {
  const raw = String(name ?? '').trim() || `会话-${String(agent?.id ?? '').slice(0, 8) || '临时'}`
  return raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80) || '临时会话'
}

/** 会话根文档路径。 */
function sessionRootPath(cwd, cfg, agent, name) {
  const safe = sanitizeSessionName(name, agent)
  return { name: safe, dir: join(cwd, cfg.sessionRootDir, safe), file: join(cwd, cfg.sessionRootDir, safe, 'ROOT.md') }
}

const TEXT_BLOCK = text => [{ type: 'text', text }]

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const fibers = []
  const backupDir = cwd => join(cwd, '.norms', 'backups')

  if (cfg.injectPrompt) {
    try {
      const fiber = ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({
          name: PROMPT_SECTION,
          order: PROMPT_ORDER,
          interpolate: false,
          text: context => buildPromptIndex(ctx, cfg, context?.agent),
        })
      })
      fibers.push(fiber)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-norms: prompt injection unavailable: ${error?.message ?? error}`)
    }
  }

  if (cfg.command) {
    try {
      const fiber = ctx.inject(['commands'], (scope) => {
        scope.commands.register({
          name: 'rule',
          description: '把一条长期生效的总规则写入工作区根 AGENTS.md（norms 维护区块）',
          input: { hint: '<要长期生效的总规则>' },
          async handler(invocation) {
            const raw = String(invocation?.rawInput ?? '').trim()
            if (raw === '') return { kind: 'error', text: '用法：/rule <规则文本>' }
            try {
              const cwd = await cwdForTool(ctx, invocation)
              const agentsPath = join(cwd, 'AGENTS.md')
              const result = appendRule(agentsPath, raw, {
                maxRuleChars: cfg.maxRuleChars,
                backupDir: backupDir(cwd),
                keepBackups: 20,
              })
              return {
                kind: 'success',
                text: result.duplicate
                  ? `这条规则已经存在，没有重复写入。\n${normalizePath(agentsPath)}（共 ${result.count} 条追加规则）`
                  : `已写入根 AGENTS.md。\n${normalizePath(agentsPath)}（共 ${result.count} 条追加规则）`,
              }
            } catch (error) {
              return { kind: 'error', text: `写规则失败：${error?.message ?? error}` }
            }
          },
        })
      })
      fibers.push(fiber)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-norms: /rule command unavailable: ${error?.message ?? error}`)
    }
  }

  if (cfg.tool) {
    ctx.tools.register({
      name: 'norms_read',
      description: '按优先级读取工作区规范链：根 AGENTS.md → Config.ruleDirs 指定目录 → 公共区 README → 会话根文档。只读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '可选：只读这一个文件或目录（目录取其中 AGENTS.md）。' },
          session: { type: 'string', description: '可选：会话名，用于定位 会话归档/<会话名>/ROOT.md。' },
          full: { type: 'boolean', description: 'true 时不截断内容。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            sources: { type: 'array' },
            threshold: { type: 'number' },
            workspace: { type: 'string' },
          },
          required: ['sources', 'workspace'],
        },
        render: (_args, value) => {
          const parts = [`规范链（工作区 ${value.workspace}，Python 公共性阈值 ${value.threshold}）`]
          for (const source of value.sources) {
            parts.push('')
            parts.push(`### ${source.priority}. ${source.label}`)
            parts.push(`路径：${source.path}${source.exists ? `（${source.bytes} 字节）` : '（不存在）'}`)
            if (source.content !== undefined) parts.push(source.content.trim())
          }
          return TEXT_BLOCK(parts.join('\n'))
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(ctx, exec)
        const full = args?.full === true
        const limit = full ? 200000 : 6000
        const sources = []
        if (args?.path !== undefined) {
          const absolute = resolve(cwd, String(args.path))
          const file = existsSync(absolute) && statSync(absolute).isDirectory() ? join(absolute, 'AGENTS.md') : absolute
          const content = readIfExists(file, limit)
          sources.push({
            priority: 1,
            label: '指定路径',
            path: normalizePath(file),
            exists: content !== undefined,
            bytes: content === undefined ? 0 : Buffer.byteLength(content, 'utf8'),
            content,
          })
        } else {
          const agentsPath = join(cwd, 'AGENTS.md')
          const agentsText = readIfExists(agentsPath, limit)
          sources.push({
            priority: 1,
            label: '工作区总规范（最高优先级）',
            path: normalizePath(agentsPath),
            exists: agentsText !== undefined,
            bytes: agentsText === undefined ? 0 : Buffer.byteLength(agentsText, 'utf8'),
            content: agentsText,
          })
          let priority = 2
          for (const spec of cfg.ruleDirs) {
            const region = regionOf(cwd, spec)
            const text = readIfExists(region.file, limit)
            sources.push({
              priority: priority++,
              label: `用户指定区域：${spec}`,
              path: normalizePath(region.file),
              exists: text !== undefined,
              bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
              content: text,
            })
          }
          const readme = join(cwd, cfg.publicDir, 'README.md')
          const readmeText = readIfExists(readme, limit)
          sources.push({
            priority: priority++,
            label: '公共区说明',
            path: normalizePath(readme),
            exists: readmeText !== undefined,
            bytes: readmeText === undefined ? 0 : Buffer.byteLength(readmeText, 'utf8'),
            content: readmeText,
          })
          if (args?.session !== undefined) {
            const root = sessionRootPath(cwd, cfg, exec?.agent, args.session)
            const text = readIfExists(root.file, limit)
            sources.push({
              priority: priority++,
              label: '会话根文档',
              path: normalizePath(root.file),
              exists: text !== undefined,
              bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
              content: text,
            })
          }
        }
        return { sources, threshold: cfg.threshold, workspace: normalizePath(cwd) }
      },
    })

    ctx.tools.register({
      name: 'norms_rule',
      description: '把用户重点强调、要求长期生效的总规则追加到根 AGENTS.md（带 marker 的 norms 区块），自动去重并备份。',
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: '规则正文，一句话说清；不要带列表前缀。' },
        },
        required: ['rule'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            added: { type: 'boolean' },
            duplicate: { type: 'boolean' },
            count: { type: 'number' },
            path: { type: 'string' },
            backup: { type: 'string' },
          },
          required: ['added', 'duplicate', 'count', 'path'],
        },
        render: (_args, value) => TEXT_BLOCK(value.duplicate
          ? `规则已存在，未重复写入。\n${value.path}（共 ${value.count} 条追加规则）`
          : `已写入根 AGENTS.md。\n${value.path}（共 ${value.count} 条追加规则）${value.backup === undefined ? '' : `\n备份：${value.backup}`}`),
      },
      async execute(args, exec) {
        const rule = args?.rule
        if (typeof rule !== 'string' || rule.trim() === '') throw new Error('norms_rule 需要非空 rule')
        const cwd = await cwdForTool(ctx, exec)
        const agentsPath = join(cwd, 'AGENTS.md')
        return appendRule(agentsPath, rule, {
          maxRuleChars: cfg.maxRuleChars,
          backupDir: backupDir(cwd),
          keepBackups: 20,
        })
      },
    })

    ctx.tools.register({
      name: 'norms_status',
      description: '查看规范落盘现状：AGENTS.md 规则/模块数、公共区与 MCP 目录、会话根目录、根目录散落文件、未登记的公共 Python。只读。',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '可选：会话名，检查对应 ROOT.md 是否存在。' },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            workspace: { type: 'string' },
            threshold: { type: 'number' },
            agents: { type: 'object' },
            publicDir: { type: 'object' },
            mcpDir: { type: 'object' },
            sessionRoot: { type: 'object' },
            rootStray: { type: 'array' },
            ruleDirs: { type: 'array' },
          },
          required: ['workspace', 'threshold', 'agents'],
        },
        render: (_args, value) => {
          const lines = [
            `工作区：${value.workspace}`,
            `Python 公共性阈值：${value.threshold}（严格大于才可登记）`,
            `AGENTS.md：${value.agents.exists ? `${value.agents.bytes} 字节，追加规则 ${value.agents.rules} 条，模块 ${value.agents.modules} 个` : '不存在'}`,
            `公共区：${value.publicDir.path}（${value.publicDir.exists ? '存在' : '不存在'}，Python 模块 ${value.publicDir.modules} 个，未登记 ${value.publicDir.unregistered} 个）`,
            `MCP 共享区：${value.mcpDir.path}（${value.mcpDir.exists ? '存在' : '不存在'}）`,
            `会话根目录：${value.sessionRoot.path}（${value.sessionRoot.dirs} 个会话目录）`,
          ]
          if (value.sessionRoot.current !== undefined) {
            lines.push(`当前会话根文档：${value.sessionRoot.current.file}（${value.sessionRoot.current.exists ? '存在' : '尚未创建'}）`)
          }
          if (value.rootStray.length > 0) lines.push(`根目录散落文件：${value.rootStray.join('、')}（按规则应移入会话目录）`)
          if (value.ruleDirs.length > 0) {
            lines.push('指定区域：')
            for (const region of value.ruleDirs) lines.push(`- ${region.spec} → ${region.path}（${region.exists ? '存在' : '暂无'}）`)
          }
          return TEXT_BLOCK(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(ctx, exec)
        const agentsPath = join(cwd, 'AGENTS.md')
        const agentsText = readIfExists(agentsPath, 200000) ?? ''
        const modules = agentsText === '' ? [] : parseModules(agentsText)
        const moduleFiles = listPython(cwd, cfg)
        const moduleRel = moduleFiles.map(file => displayPath(cwd, file))
        const registered = new Set(modules.map(item => item.path))
        const unregistered = moduleRel.filter(item => !registered.has(item)).length
        const sessionRootDir = join(cwd, cfg.sessionRootDir)
        const sessionDirs = (() => {
          try {
            return readdirSync(sessionRootDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).length
          } catch {
            return 0
          }
        })()
        const currentRoot = args?.session === undefined ? undefined : sessionRootPath(cwd, cfg, exec?.agent, args.session)
        return {
          workspace: normalizePath(cwd),
          threshold: cfg.threshold,
          agents: {
            path: normalizePath(agentsPath),
            exists: existsSync(agentsPath),
            bytes: existsSync(agentsPath) ? statSync(agentsPath).size : 0,
            rules: agentsText === '' ? 0 : parseRules(agentsText).length,
            modules: modules.length,
          },
          publicDir: {
            path: normalizePath(join(cwd, cfg.publicDir)),
            exists: existsSync(join(cwd, cfg.publicDir)),
            modules: moduleFiles.length,
            unregistered,
          },
          mcpDir: {
            path: normalizePath(join(cwd, cfg.mcpDir)),
            exists: existsSync(join(cwd, cfg.mcpDir)),
          },
          sessionRoot: {
            path: normalizePath(sessionRootDir),
            dirs: sessionDirs,
            ...currentRoot === undefined ? {} : {
              current: { file: normalizePath(currentRoot.file), exists: existsSync(currentRoot.file) },
            },
          },
          rootStray: rootStray(cwd),
          ruleDirs: cfg.ruleDirs.map(spec => {
            const region = regionOf(cwd, spec)
            return { spec, path: normalizePath(region.file), exists: existsSync(region.file) }
          }),
        }
      },
    })

    ctx.tools.register({
      name: 'norms_py_audit',
      description: '给一个 Python 文件打“公共性”分：公开 API、docstring、可移植性、参数化、顶层副作用。只读，不写任何文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Python 文件路径，相对当前工作目录或绝对路径。' },
          threshold: { type: 'number', description: '可选：覆盖默认阈值。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            score: { type: 'number' },
            pass: { type: 'boolean' },
            threshold: { type: 'number' },
            report: { type: 'string' },
            metrics: { type: 'object' },
            flags: { type: 'array' },
          },
          required: ['path', 'score', 'pass', 'threshold', 'report'],
        },
        render: (_args, value) => TEXT_BLOCK(`文件：${value.path}\n\n${value.report}\n\n只读结果，未写盘。`),
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(ctx, exec)
        const absolute = resolve(cwd, String(args?.path ?? ''))
        if (!existsSync(absolute)) throw new Error(`文件不存在：${absolute}`)
        const size = statSync(absolute).size
        if (size > cfg.maxScanBytes) throw new Error(`文件过大（${size} 字节 > ${cfg.maxScanBytes}），拒绝审计`)
        const source = readFileSync(absolute, 'utf8')
        const threshold = Number.isFinite(args?.threshold) ? args.threshold : cfg.threshold
        const report = auditPython(source, { threshold })
        return {
          path: normalizePath(absolute),
          score: report.score,
          pass: report.pass,
          threshold,
          report: formatReport(report),
          metrics: report.metrics,
          flags: report.flags,
        }
      },
    })

    ctx.tools.register({
      name: 'norms_py_register',
      description: `审计一个公共 Python 模块；公共性严格大于 ${cfg.threshold} 才登记，并把模块路径、API 签名、参数、评分写回根 AGENTS.md。低于阈值时拒绝登记。`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '公共区内的 Python 文件，相对当前工作目录或绝对路径。' },
          summary: { type: 'string', description: '可选：一句话说明这个模块的通用能力。' },
          params: { type: 'string', description: '可选：参数摘要；不填则从公开函数签名提取。' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            registered: { type: 'boolean' },
            reason: { type: 'string' },
            path: { type: 'string' },
            agentsPath: { type: 'string' },
            score: { type: 'number' },
            threshold: { type: 'number' },
            report: { type: 'string' },
            backup: { type: 'string' },
          },
          required: ['registered', 'path', 'score', 'threshold', 'report'],
        },
        render: (_args, value) => {
          if (!value.registered) {
            return TEXT_BLOCK(`未登记：${value.reason}\n文件：${value.path}\n\n${value.report}`)
          }
          return TEXT_BLOCK(`已登记：${value.path}（公共性 ${value.score} > ${value.threshold}）\n根 AGENTS.md：${value.agentsPath}${value.backup === undefined ? '' : `\n备份：${value.backup}`}`)
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(ctx, exec)
        const absolute = resolve(cwd, String(args?.path ?? ''))
        if (!existsSync(absolute)) throw new Error(`文件不存在：${absolute}`)
        const rel = displayPath(cwd, absolute)
        const publicRoot = normalizePath(cfg.publicDir).replace(/\/$/, '')
        const insidePublic = publicRoot === '' || rel === publicRoot || rel.startsWith(`${publicRoot}/`)
        const source = readFileSync(absolute, 'utf8')
        const report = auditPython(source, { threshold: cfg.threshold })
        const base = {
          path: rel,
          score: report.score,
          threshold: cfg.threshold,
          report: formatReport(report),
        }
        if (!insidePublic) {
          return { ...base, registered: false, reason: `不在公共区 ${publicRoot}/ 内；会话专用代码不要登记为公共模块` }
        }
        if (basename(absolute) === '__init__.py') {
          return { ...base, registered: false, reason: '__init__.py 是索引入口，不单独登记；登记它引用的模块' }
        }
        if (!report.pass) {
          return { ...base, registered: false, reason: `公共性 ${report.score} 未严格大于 ${cfg.threshold}；按报告修正后再登记` }
        }
        const agentsPath = join(cwd, 'AGENTS.md')
        const result = registerModule(agentsPath, {
          path: rel,
          score: report.score,
          threshold: cfg.threshold,
          api: report.api,
          constants: report.constants,
          summary: args?.summary,
          params: args?.params,
        }, {
          backupDir: backupDir(cwd),
          keepBackups: 20,
          logKeep: cfg.logKeep,
        })
        return {
          ...base,
          registered: true,
          agentsPath: normalizePath(agentsPath),
          added: result.added,
          updated: result.updated,
          backup: result.backup,
        }
      },
    })

    ctx.tools.register({
      name: 'norms_session_root',
      description: '创建、读取或追加本次会话的根文档 会话归档/<会话名>/ROOT.md，用来记录本次会话的目标、决定与进展。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['ensure', 'read', 'append'], description: 'ensure 创建；read 读取；append 追加一段记录。' },
          name: { type: 'string', description: '会话名（取 DSH 会话标题）；不填则用 会话-<id 前 8 位>。' },
          text: { type: 'string', description: 'append 时写入的正文。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            name: { type: 'string' },
            path: { type: 'string' },
            exists: { type: 'boolean' },
            bytes: { type: 'number' },
            content: { type: 'string' },
          },
          required: ['action', 'path', 'exists'],
        },
        render: (_args, value) => {
          if (value.action === 'read') return TEXT_BLOCK(`${value.path}\n\n${value.content ?? '（文件不存在）'}`)
          const lines = [`${value.exists ? '已就绪' : '未创建'}：${value.path}`]
          if (value.content !== undefined) lines.push('', clip(value.content, 1200))
          return TEXT_BLOCK(lines.join('\n'))
        },
      },
      async execute(args, exec) {
        const cwd = await cwdForTool(ctx, exec)
        const action = args?.action
        if (action !== 'ensure' && action !== 'read' && action !== 'append') {
          throw new Error('action 只能是 ensure / read / append')
        }
        const root = sessionRootPath(cwd, cfg, exec?.agent, args?.name)
        const exists = existsSync(root.file)
        if (action === 'read') {
          const content = readIfExists(root.file, 200000)
          return {
            action,
            name: root.name,
            path: normalizePath(root.file),
            exists: content !== undefined,
            bytes: content === undefined ? 0 : statSync(root.file).size,
            content,
          }
        }
        if (!exists) {
          mkdirSync(root.dir, { recursive: true })
          const header = [
            `# 会话根文档 · ${root.name}`,
            '',
            `- 创建：${new Date().toISOString()}`,
            `- 工作区：${normalizePath(cwd)}`,
            `- 规范：先读根 AGENTS.md；强调型总规则用 norms_rule 落盘。`,
            '',
            '## 记录',
            '',
          ].join('\n')
          writeTextFile(root.file, header)
        }
        if (action === 'append') {
          const text = String(args?.text ?? '').trim()
          if (text === '') throw new Error('append 需要非空 text')
          const current = readIfExists(root.file, 1000000) ?? ''
          if (Buffer.byteLength(current, 'utf8') > 500000) throw new Error('ROOT.md 已超过 500KB，请先归档精简')
          const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
          writeTextFile(root.file, `${current.replace(/\s+$/, '')}\n\n### ${stamp}\n\n${text}\n`)
        }
        const content = readIfExists(root.file, 200000)
        return {
          action,
          name: root.name,
          path: normalizePath(root.file),
          exists: content !== undefined,
          bytes: content === undefined ? 0 : statSync(root.file).size,
          content,
        }
      },
    })
  }

  ctx.effect(() => () => {
    for (const fiber of fibers) {
      try {
        fiber?.dispose?.()
      } catch {
        // 卸载时忽略
      }
    }
    fibers.length = 0
  }, 'dsh-norms: registration cleanup')
}

/** 简单写文件（保证目录存在）。 */
function writeTextFile(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.norms-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export default apply