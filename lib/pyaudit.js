/**
 * Python 模块"公共性"评分。
 * 作者：nuoyis/dsh-norms
 *
 * 公共性 = 这段源码有多少是可以直接搬到另一个项目复用的公共能力：
 *   1. 顶层单元里公开 API 的占比（api）
 *   2. 公开单元有 docstring 的占比（doc）
 *   3. 不写死本机路径/用户名/工作区名的程度（portability）
 *   4. 公开函数是靠参数而不是靠改源码适配的程度（param）
 *   5. 顶层没有导入即执行的副作用（sideEffect）
 *
 * 纯文本启发式：不执行源码，不依赖第三方包，读一遍就能给出分数和扣分行。
 */

/** 各分项权重，合计 1。 */
export const WEIGHTS = Object.freeze({
  api: 0.30,
  doc: 0.25,
  portability: 0.25,
  param: 0.10,
  sideEffect: 0.10,
})

/** 本机特征：命中即说明这段代码搬到别的机器就断。 */
const PORTABILITY_RULES = [
  { code: 'absolute-path', re: /(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/ },
  { code: 'user-home', re: /(?:\/Users\/|\/home\/|\/root\/)/ },
  { code: 'workspace-literal', re: /deepseek-harness|default-workspace|会话归档|\.dsh[\\/]profiles|nuoyi/i },
]

const MAIN_BLOCK = /^if\s+__name__\s*==\s*['\u0022]__main__['\u0022]/

/** 顶层允许出现、不算副作用的语句。 */
const ALLOWED_TOP_LEVEL = [
  /^(?:async\s+)?def\s+/,
  /^class\s+/,
  /^@/,
  /^(?:import|from)\s+/,
  /^if\s+__name__\s*==/,
  /^if\s+TYPE_CHECKING\b/,
  /^try\s*:/,
  /^except\b/,
  /^else\s*:/,
  /^finally\s*:/,
  /^(?:[A-Za-z_]\w*|__all__)(?:\s*:\s*[^=]+)?\s*=(?!=)/,
]

/** 把源码切成行，统一换行，去掉 BOM。 */
function splitLines(source) {
  return String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
}

/** 统计一行里未闭合的小括号增量（用于跨行签名）。 */
function parenDepth(line) {
  let depth = 0
  for (const ch of line) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
  }
  return depth
}

/**
 * 标出三引号字符串内部的行。
 * 只按每行奇偶个三引号翻转，足够避开 docstring 里的假代码。
 */
function markStringLines(lines) {
  const inside = new Array(lines.length).fill(false)
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const wasInside = open !== null
    inside[i] = wasInside || /^\s*(?:"""|''')/.test(lines[i])
    for (const quote of ['"""', "'''"]) {
      let count = 0
      for (let at = lines[i].indexOf(quote); at >= 0; at = lines[i].indexOf(quote, at + 3)) count++
      if (count % 2 === 1) open = open === quote ? null : (open === null ? quote : open)
    }
  }
  return inside
}

/** 从签名行往下收拢，直到括号配平，并截到定义冒号为止。 */
function collectSignature(lines, start) {
  let text = lines[start].trim()
  let depth = parenDepth(text)
  let end = start
  while (end + 1 < lines.length && depth > 0) {
    end++
    const next = lines[end].trim()
    if (next === '') break
    text += ` ${next}`
    depth += parenDepth(next)
  }
  const colon = text.lastIndexOf(':')
  if (colon > 0 && /:\s*$/.test(text.slice(colon))) text = text.slice(0, colon + 1)
  return { signature: text.replace(/\s+/g, ' '), end }
}

/** 括号内的参数文本；类没有括号时返回空串。 */
function paramsOf(signature) {
  const open = signature.indexOf('(')
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '(') depth++
    else if (signature[i] === ')') {
      depth--
      if (depth === 0) return signature.slice(open + 1, i).trim()
    }
  }
  return signature.slice(open + 1).trim()
}

/** 判断签名后紧跟的第一条正文是不是 docstring。 */
function hasDocstring(lines, nextLine, signature) {
  if (/"""|'''/.test(signature.slice(signature.lastIndexOf(':') + 1))) return true
  for (let i = nextLine; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '') continue
    if (!lines[i].startsWith(' ') && !lines[i].startsWith('\t')) return false
    return trimmed.startsWith('"""') || trimmed.startsWith("'''")
  }
  return false
}

/**
 * 收集顶层 def/class 单元。
 * 方法（缩进行）不算顶层，避免把类内部实现当成公共 API。
 */
function collectUnits(lines, stringLines) {
  const units = []
  for (let i = 0; i < lines.length; i++) {
    if (stringLines[i]) continue
    const line = lines[i]
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    const fn = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line)
    const cls = /^class\s+([A-Za-z_]\w*)\s*(?:\(|:|$)/.exec(line)
    if (fn === null && cls === null) continue
    const kind = fn !== null ? 'function' : 'class'
    const name = fn !== null ? fn[1] : cls[1]
    const { signature, end } = collectSignature(lines, i)
    const params = kind === 'function' ? paramsOf(signature) : ''
    units.push({
      kind,
      name,
      line: i + 1,
      signature,
      params,
      hasDoc: hasDocstring(lines, end + 1, signature),
      isPublic: !name.startsWith('_'),
    })
    i = end
  }
  return units
}

/** 顶层公开常量（如 API 表、默认值），也算模块对外暴露的能力。 */
function collectPublicConstants(lines, stringLines) {
  const found = []
  for (let i = 0; i < lines.length; i++) {
    if (stringLines[i] || lines[i].startsWith(' ') || lines[i].startsWith('\t')) continue
    const match = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(lines[i])
    if (match === null) continue
    const name = match[1]
    if (name === '__all__' || name.startsWith('_')) continue
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue
    found.push({ kind: 'constant', name, line: i + 1, signature: lines[i].trim(), params: '', hasDoc: false })
  }
  return found
}

/** 公共性评分与扣分清单。 */
export function auditPython(source, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 85
  const lines = splitLines(source)
  const stringLines = markStringLines(lines)
  const units = collectUnits(lines, stringLines)
  const moduleDoc = (() => {
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      return trimmed.startsWith('"""') || trimmed.startsWith("'''")
    }
    return false
  })()

  const publicUnits = units.filter(unit => unit.isPublic)
  const publicConstants = collectPublicConstants(lines, stringLines)
  const publicFunctions = publicUnits.filter(unit => unit.kind === 'function')
  const codeLines = lines.filter((line, i) => !stringLines[i] && line.trim() !== '' && !line.trim().startsWith('#'))

  // 私有 helper 不算“不公共”：只要模块对外有公开入口，内部怎么拆是作者的自由。
  // 一个公开入口都没有（整文件只有 main/私有函数）才会判 0。
  const scoreApi = (publicUnits.length > 0 || publicConstants.length > 0) ? 100 : 0
  const scoreDoc = publicUnits.length === 0 ? (publicConstants.length > 0 ? 100 : 0) : (publicUnits.filter(unit => unit.hasDoc).length / publicUnits.length) * 100
  const genericFunctions = publicFunctions.filter((unit) => {
    const params = unit.params
    if (params === '') return false
    return params.split(',').map(part => part.trim()).filter(Boolean).some((part) => {
      const name = part.replace(/^\*+/, '').split(/[:=]/)[0].trim()
      return name !== '' && name !== 'self' && name !== 'cls'
    })
  })
  const scoreParam = publicFunctions.length === 0 ? 100 : (genericFunctions.length / publicFunctions.length) * 100

  const flags = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of PORTABILITY_RULES) {
      if (rule.re.test(line)) flags.push({ code: rule.code, line: i + 1, text: line.trim().slice(0, 160) })
    }
  }
  const hasMainBlock = lines.some(line => MAIN_BLOCK.test(line))
  const pathHits = flags.filter(flag => flag.code !== 'main-block').length
  const scorePortability = Math.max(0, 100 - pathHits * 12 - (hasMainBlock ? 10 : 0))
  if (hasMainBlock) {
    flags.push({ code: 'main-block', line: lines.findIndex(line => MAIN_BLOCK.test(line)) + 1, text: 'if __name__ == "__main__" 块（自测入口，权重较轻）' })
  }

  const sideEffects = []
  let inMain = false
  let bracketDepth = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (stringLines[i]) continue
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    // 多行 dict/list/调用的续行（) ] } 或括号未配平）不是顶层新语句。
    const depthBefore = bracketDepth
    let delta = 0
    for (const ch of line) {
      if (ch === '(' || ch === '[' || ch === '{') delta++
      else if (ch === ')' || ch === ']' || ch === '}') delta--
    }
    bracketDepth = Math.max(0, bracketDepth + delta)
    if (depthBefore > 0 || /^[)\]}]/.test(trimmed)) continue
    if (line.startsWith(' ') || line.startsWith('\t')) {
      continue
    }
    if (MAIN_BLOCK.test(line)) {
      inMain = true
      continue
    }
    if (inMain) {
      if (trimmed.startsWith('#')) continue
      if (line.startsWith(' ') || line.startsWith('\t')) continue
      inMain = false
    }
    if (ALLOWED_TOP_LEVEL.some(re => re.test(line))) continue
    if (ALLOWED_TOP_LEVEL.some(re => re.test(trimmed))) continue
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) continue
    sideEffects.push({ line: i + 1, text: trimmed.slice(0, 160) })
  }
  const scoreSide = Math.max(0, 100 - sideEffects.length * 15)
  for (const effect of sideEffects) flags.push({ code: 'side-effect', ...effect })

  const score = Math.round((
    scoreApi * WEIGHTS.api
    + scoreDoc * WEIGHTS.doc
    + scorePortability * WEIGHTS.portability
    + scoreParam * WEIGHTS.param
    + scoreSide * WEIGHTS.sideEffect
  ) * 10) / 10

  return {
    score,
    pass: score > threshold,
    threshold,
    metrics: {
      api: round1(scoreApi),
      doc: round1(scoreDoc),
      portability: round1(scorePortability),
      param: round1(scoreParam),
      sideEffect: round1(scoreSide),
    },
    counts: {
      lines: lines.length,
      codeLines: codeLines.length,
      units: units.length,
      publicUnits: publicUnits.length,
      publicFunctions: publicFunctions.length,
      docstrings: publicUnits.filter(unit => unit.hasDoc).length,
      sideEffects: sideEffects.length,
      pathHits,
      hasMainBlock,
    },
    moduleDoc,
    api: publicUnits.map(unit => ({
      kind: unit.kind,
      name: unit.name,
      line: unit.line,
      signature: unit.signature,
      params: unit.params,
      hasDoc: unit.hasDoc,
    })),
    constants: publicConstants,
    flags,
    empty: codeLines.length === 0,
  }
}

/** 只取公共 API 签名（登记时写进 AGENTS.md）。 */
export function extractApi(source) {
  return auditPython(source).api
}

function round1(value) {
  return Math.round(value * 10) / 10
}

/** 文本报告：给工具输出和命令行共用。 */
export function formatReport(report) {
  const verdict = report.pass ? '通过' : '未通过'
  const lines = [
    `公共性 ${report.score} / 阈值 ${report.threshold}（严格高于才通过）→ ${verdict}`,
    `分项：api ${report.metrics.api} · doc ${report.metrics.doc} · portability ${report.metrics.portability} · param ${report.metrics.param} · sideEffect ${report.metrics.sideEffect}`,
    `单元：${report.counts.units} 个顶层单元，其中公开 ${report.counts.publicUnits} 个；docstring ${report.counts.docstrings} 个；副作用语句 ${report.counts.sideEffects} 条`,
  ]
  if (report.api.length > 0) {
    lines.push(`API：${report.api.map(unit => unit.signature).join('；')}`)
  }
  const issues = report.flags
  if (issues.length > 0) {
    lines.push('扣分项：')
    for (const flag of issues.slice(0, 20)) {
      lines.push(`- L${flag.line} [${flag.code}] ${flag.text}`)
    }
    if (issues.length > 20) lines.push(`- ……另有 ${issues.length - 20} 条`)
  }
  return lines.join('\n')
}

// 命令行自测：node lib/pyaudit.js <file.py> [threshold]
if (process.argv[1] !== undefined && /pyaudit\.js$/.test(process.argv[1])) {
  const { readFileSync } = await import('node:fs')
  const file = process.argv[2]
  if (file === undefined) {
    console.error('用法：node lib/pyaudit.js <file.py> [threshold]')
    process.exitCode = 2
  } else {
    const threshold = process.argv[3] === undefined ? 85 : Number(process.argv[3])
    const report = auditPython(readFileSync(file, 'utf8'), { threshold })
    console.log(JSON.stringify(report, null, 2))
    console.log(`\n${formatReport(report)}`)
  }
}