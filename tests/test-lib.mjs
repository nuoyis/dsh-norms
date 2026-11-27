/** 作者：nuoyis/dsh-norms。本地自测：把 AGENTS.md 复制到 out/，验证规则去重、模块原位更新、备份与幂等。 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendRule, parseModules, parseRules, registerModule } from '../lib/agentsmd.js'

const workspace = 'C:/Users/nuoyi/Documents/deepseek-harness/default-workspace'
const dir = join(workspace, '会话归档', '规范化插件', 'out')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'AGENTS.test.md')
copyFileSync(join(workspace, 'AGENTS.md'), file)

const first = appendRule(file, '所有会话的产出必须放进会话归档/<会话名>/。')
const second = appendRule(file, '所有会话的产出必须放进会话归档/<会话名>/。')
console.log('rule-1', first.added, first.duplicate, first.count)
console.log('rule-2', second.added, second.duplicate, second.count)

const entry = {
  path: 'python-public/pypub/canvas.py',
  score: 89.2,
  threshold: 85,
  api: [
    { signature: 'def is_cjk(ch: str) -> bool:', params: 'ch: str' },
    { signature: 'class Canvas:', params: '' },
    { signature: 'def code_image(out_path, lines, lang="c++", size=15):', params: 'out_path, lines, lang, size' },
  ],
  constants: [],
  summary: 'Pillow 超采样画流程图与代码截图',
}
console.log('mod-1', registerModule(file, entry).added)
console.log('mod-2', registerModule(file, { ...entry, score: 90.1 }).updated)
console.log('modules', JSON.stringify(parseModules(readFileSync(file, 'utf8'))))
console.log('rules', parseRules(readFileSync(file, 'utf8')).length)
const backups = readdirSync(join(dir, '.norms', 'backups')).filter(name => name.startsWith('AGENTS.test.md.'))
console.log('backups', backups.length, backups[0])
console.log('agents-bytes', readFileSync(file).length, existsSync(file))
console.log('--- tail ---')
console.log(readFileSync(file, 'utf8').split('\n').slice(-40).join('\n'))