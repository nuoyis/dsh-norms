/**
 * 根 AGENTS.md 的托管区块读写。
 * 作者：nuoyis/dsh-norms
 *
 * 只改两个带 marker 的区块，区块外的用户内容一律不碰：
 *   <!-- norms:rules:start --> ... <!-- norms:rules:end -->    追加总规则
 *   <!-- norms:modules:start --> ... <!-- norms:modules:end --> 公共 Python 模块索引
 *
 * 每次写之前先备份到 <workspace>/.norms/backups/，再原子替换。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const RULES_TITLE = '追加总规则（norms 维护）'
export const MODULES_TITLE = '公共 Python 模块索引（norms 维护）'
export const RULES_START = '<!-- norms:rules:start -->'
export const RULES_END = '<!-- norms:rules:end -->'
export const MODULES_START = '<!-- norms:modules:start -->'
export const MODULES_END = '<!-- norms:modules:end -->'
const LOG_TITLE = '### 最近写入（norms 维护）'

/** 本地时间戳 yyyy-mm-dd hh:mm。 */
export function stamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 文件名用的时间戳 yyyyMMdd-HHmmss-SSS。 */
function fileStamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`
}

/** 读文本；文件不存在时返回空串。 */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

/** 备份 AGENTS.md，只保留最近 keep 份。 */
export function backupFile(file, backupDir, keep = 20) {
  if (!existsSync(file)) return undefined
  mkdirSync(backupDir, { recursive: true })
  const target = join(backupDir, `${basename(file)}.${fileStamp()}.bak`)
  copyFileSync(file, target)
  const prefix = `${basename(file)}.`
  const backups = readdirSync(backupDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.bak'))
    .map(name => ({ name, time: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
  for (const stale of backups.slice(Math.max(1, keep))) {
    try {
      unlinkSync(join(backupDir, stale.name))
    } catch {
      // 清理失败不影响本次写入
    }
  }
  return target
}

/** 原子写：同目录临时文件 + rename。 */
export function writeTextAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.norms-tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 在文本中查找托管区块的内文；缺任一 marker 返回 undefined。 */
function readRegion(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start < 0 || end < 0 || end < start) return undefined
  return text.slice(start + startMarker.length, end)
}

/**
 * 保证托管区块存在。已存在但缺 marker 的同名小节会被整节重写（该小节归插件所有）。
 * @returns 带区块的完整文本。
 */
function ensureRegion(text, title, startMarker, endMarker, seed = '') {
  if (readRegion(text, startMarker, endMarker) !== undefined) return text
  const heading = `## ${title}`
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.trim() === heading)
  const block = [startMarker, ...(seed === '' ? [] : ['', seed]), '', endMarker].join('\n')
  if (at >= 0) {
    let stop = at + 1
    while (stop < lines.length && !/^##\s+/.test(lines[stop])) stop++
    const before = lines.slice(0, at + 1)
    const after = lines.slice(stop)
    return [...before, '', block, '', ...after].join('\n')
  }
  const trimmed = text.replace(/\s+$/, '')
  return `${trimmed === '' ? '# 工作区约定（AGENTS.md）\n' : `${trimmed}\n`}\n${heading}\n\n${block}\n`
}

/** 把一行追加到区块末尾（end marker 之前）。 */
function appendToRegion(text, startMarker, endMarker, line) {
  const region = readRegion(text, startMarker, endMarker) ?? ''
  const body = region.replace(/\s+$/, '')
  const next = `${startMarker}\n${body === '' ? '' : `${body}\n`}${line}\n${endMarker}`
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker) + endMarker.length
  return text.slice(0, start) + next + text.slice(end)
}

/** 把整段区块内文替换掉。 */
function replaceRegion(text, startMarker, endMarker, body) {
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker) + endMarker.length
  const inner = body.replace(/\s+$/, '')
  const next = `${startMarker}\n${inner === '' ? '' : `${inner}\n`}${endMarker}`
  return text.slice(0, start) + next + text.slice(end)
}

/** 解析规则行。 */
export function parseRules(text) {
  const region = readRegion(text, RULES_START, RULES_END) ?? ''
  const rules = []
  for (const line of region.split('\n')) {
    const match = /^\s*-\s*\[([^\]]+)\]\s*(.+)$/.exec(line)
    if (match !== null) rules.push({ time: match[1], text: match[2].trim() })
  }
  return rules
}

/** 解析模块条目。 */
export function parseModules(text) {
  const region = readRegion(text, MODULES_START, MODULES_END) ?? ''
  const modules = []
  for (const line of region.split('\n')) {
    const match = /^###\s+`([^`]+)`\s*·\s*公共性\s*([\d.]+)/.exec(line.trim())
    if (match !== null) modules.push({ path: match[1], score: Number(match[2]) })
  }
  return modules
}

/** 归一化规则文本：压空白、去掉用户手写的列表前缀。 */
export function normalizeRule(rule) {
  return String(rule ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*]\s+/, '')
}

/**
 * 追加一条总规则。
 * @returns {{added:boolean,duplicate:boolean,count:number,path:string,backup?:string}}
 */
export function appendRule(agentsPath, rule, options = {}) {
  const text0 = ensureRegion(readText(agentsPath), RULES_TITLE, RULES_START, RULES_END)
  const normalized = normalizeRule(rule)
  const maxRuleChars = options.maxRuleChars ?? 500
  if (normalized === '') throw new Error('规则不能为空')
  if (normalized.length > maxRuleChars) throw new Error(`规则过长（${normalized.length} > ${maxRuleChars} 字符），请拆成几条`)
  const existing = parseRules(text0)
  if (existing.some(item => normalizeRule(item.text) === normalized)) {
    return { added: false, duplicate: true, count: existing.length, path: agentsPath }
  }
  const backup = backupFile(agentsPath, options.backupDir ?? join(dirname(agentsPath), '.norms', 'backups'), options.keepBackups ?? 20)
  const line = `- [${stamp()}] ${normalized}`
  const text = appendToRegion(text0, RULES_START, RULES_END, line)
  writeTextAtomic(agentsPath, text.endsWith('\n') ? text : `${text}\n`)
  return { added: true, duplicate: false, count: existing.length + 1, path: agentsPath, backup }
}

/** API 签名截断，避免 AGENTS.md 被超长签名撑爆。 */
function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** 生成一个模块条目。 */
function renderModuleEntry(entry) {
  const lines = [`### \`${entry.path}\` · 公共性 ${entry.score}`, '']
  const api = Array.isArray(entry.api) ? entry.api : []
  const constants = Array.isArray(entry.constants) ? entry.constants : []
  const shown = api.slice(0, 4).map(item => `\`${clip(item.signature, 180)}\``)
  if (shown.length === 0 && constants.length > 0) {
    for (const item of constants.slice(0, 6)) shown.push(`\`${item.name}\``)
  }
  if (shown.length > 0) {
    const more = api.length + constants.length - shown.length
    lines.push(`- API：${shown.join('、')}${more > 0 ? `，等 ${more} 个` : ''}`)
  }
  const params = entry.params !== undefined && String(entry.params).trim() !== ''
    ? String(entry.params)
    : [...new Set(api.flatMap(item => String(item.params ?? '').split(',').map(part => part.trim().split(/[:=]/)[0].trim()).filter(Boolean)))]
      .filter(name => name !== 'self' && name !== 'cls' && name !== '*')
      .slice(0, 24)
      .join('、')
  if (params !== '') lines.push(`- 参数：${params}`)
  if (entry.summary !== undefined && String(entry.summary).trim() !== '') lines.push(`- 概要：${clip(entry.summary, 300)}`)
  lines.push(`- 登记：${stamp()} · 阈值 ${entry.threshold}（严格大于）`)
  return lines.join('\n')
}

/** 把模块区块拆成“条目正文”和“最近写入条目”，便于整体重排。 */
function splitLog(region) {
  const lines = region.split('\n')
  const at = lines.findIndex(line => line.trim() === LOG_TITLE)
  if (at < 0) return { body: region, entries: [] }
  const entries = []
  let stop = at + 1
  while (stop < lines.length) {
    const trimmed = lines[stop].trim()
    if (/^###\s+/.test(trimmed) || /^<!--\s*norms:modules:end/.test(trimmed)) break
    if (/^-\s+/.test(trimmed)) entries.push(trimmed.slice(2).trim())
    stop++
  }
  const body = [...lines.slice(0, at), ...lines.slice(stop)].join('\n')
  return { body, entries }
}

/** 把已有条目原位替换，否则追加到条目末尾。 */
function upsertModuleBody(region, relativePath, entryText) {
  const lines = region.split('\n')
  const keyRe = new RegExp(`^###\\s+\`${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`\\s*·`)
  const at = lines.findIndex(line => keyRe.test(line.trim()))
  if (at >= 0) {
    let stop = at + 1
    while (stop < lines.length && !/^###\s+/.test(lines[stop])) stop++
    lines.splice(at, stop - at, ...entryText.split('\n'), ...(stop < lines.length ? [''] : []))
    return lines.join('\n')
  }
  const body = region.replace(/^\s+/, '').replace(/\s+$/, '')
  return `${body === '' ? '' : `${body}\n\n`}${entryText}`
}

/** 在条目末尾整体重建“最近写入”小节，只留最近 keep 条。 */
function rebuildLog(body, entries, line, keep) {
  const head = body.replace(/^\s+/, '').replace(/\s+$/, '')
  const kept = [line, ...entries].slice(0, keep)
  const log = `${LOG_TITLE}\n\n${kept.map(item => `- ${item}`).join('\n')}`
  return `${head === '' ? '' : `${head}\n\n`}${log}`
}

/**
 * 登记/更新一个公共 Python 模块条目，并写一条最近写入记录。
 * @returns {{added:boolean,updated:boolean,path:string,backup?:string}}
 */
export function registerModule(agentsPath, entry, options = {}) {
  const text0 = ensureRegion(readText(agentsPath), MODULES_TITLE, MODULES_START, MODULES_END)
  const relativePath = String(entry.path ?? '').replace(/\\/g, '/')
  if (relativePath === '') throw new Error('模块路径不能为空')
  const backup = backupFile(agentsPath, options.backupDir ?? join(dirname(agentsPath), '.norms', 'backups'), options.keepBackups ?? 20)
  const region = readRegion(text0, MODULES_START, MODULES_END) ?? ''
  const existed = parseModules(text0).some(item => item.path === relativePath)
  const { body: entriesBody, entries } = splitLog(region)
  let body = upsertModuleBody(entriesBody, relativePath, renderModuleEntry({ ...entry, path: relativePath }))
  body = rebuildLog(body, entries, `${stamp()} ${relativePath} → 公共性 ${entry.score}`, options.logKeep ?? 20)
  const text = replaceRegion(text0, MODULES_START, MODULES_END, body)
  writeTextAtomic(agentsPath, text.endsWith('\n') ? text : `${text}\n`)
  return { added: !existed, updated: existed, path: agentsPath, backup }
}