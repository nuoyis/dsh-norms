/**
 * 作者：nuoyis/dsh-norms
 * 用假 ctx 跑一遍 apply()：验证 prompt section、工具、/rule 命令都不炸。
 * 不连接真实 DSH，只在临时目录里建一个迷你工作区。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'norms-apply-'))
mkdirSync(join(root, 'python-public', 'pypub'), { recursive: true })
writeFileSync(join(root, 'AGENTS.md'), '# 测试工作区\n\n原有内容必须原样保留。\n', 'utf8')
writeFileSync(join(root, 'python-public', 'README.md'), '# 公共区\n\n放通用模块。\n', 'utf8')
writeFileSync(join(root, 'python-public', 'pypub', 'sample.py'), [
  '"""示例公共模块：只做一件通用的小事。"""',
  '',
  '',
  'def greet(name: str) -> str:',
  '    """返回问候语。"""',
  '    return f"你好，{name}"',
  '',
  '',
  'def add(left: int, right: int) -> int:',
  '    """相加。"""',
  '    return left + right',
  '',
].join('\n'), 'utf8')
writeFileSync(join(root, 'python-public', 'pypub', 'bad.py'), [
  'print("import 就有副作用")',
  '',
  '',
  'def f(x):',
  '    return x',
  '',
].join('\n'), 'utf8')

const sections = []
const tools = []
const commands = []
const ctx = {
  logger: { warn: (message) => console.warn('[warn]', message) },
  get(name) {
    if (name === 'workingDirectory') {
      return { defaultDirectory: root, get: () => root, ensure: async () => root }
    }
    return undefined
  },
  inject(_deps, callback) {
    callback({
      systemPrompt: { section: section => sections.push(section) },
      commands: { register: definition => commands.push(definition) },
    })
    return { dispose() { /* noop */ } }
  },
  tools: { register: definition => tools.push(definition) },
  effect(fn) { return fn() },
}

apply(ctx, { sessionRootDir: '会话归档' })

const agent = { id: 'test-agent-0001', session: { header: { cwd: root } } }
const findTool = name => tools.find(item => item.name === name)

let failures = 0
function check(label, condition, extra = '') {
  if (!condition) failures += 1
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition || extra === '' ? '' : ` — ${extra}`}`)
}

// prompt
check('注册 prompt section', sections.length === 1 && sections[0].name === 'norms:index' && sections[0].order === 950)
const prompt = sections[0].text({ agent })
console.log('--- prompt head ---')
console.log(prompt.split('\n').slice(0, 14).join('\n'))
check('prompt 提到 AGENTS.md', prompt.includes('AGENTS.md'))
check('prompt 提到 python-public', prompt.includes('python-public'))
check('prompt 带出区域 README 内容', prompt.includes('放通用模块'))

// tools registered
const names = tools.map(item => item.name).sort()
check('六个工具都注册', names.join(',') === 'norms_py_audit,norms_py_register,norms_read,norms_rule,norms_session_root,norms_status', names.join(','))

// read
const read = await findTool('norms_read').execute({}, { agent })
check('norms_read 返回规则链', read.sources.length >= 3 && read.sources[0].path.endsWith('AGENTS.md'))
check('norms_read 读到公共区 README', read.sources.some(source => source.path.endsWith('README.md') && source.exists))

// rule
const rule = await findTool('norms_rule').execute({ rule: '所有会话的产出放进会话归档目录。' }, { agent })
check('norms_rule 写入', rule.added === true && rule.count === 1)
const again = await findTool('norms_rule').execute({ rule: '  所有会话的产出放进会话归档目录。  ' }, { agent })
check('norms_rule 去重', again.duplicate === true && again.count === 1)

// audit pass + register
const audit = await findTool('norms_py_audit').execute({ path: 'python-public/pypub/sample.py' }, { agent })
check('audit 通过', audit.pass === true && audit.score > 85, `score=${audit.score}`)
const registered = await findTool('norms_py_register').execute({ path: 'python-public/pypub/sample.py', summary: '迷你示例' }, { agent })
check('register 通过', registered.registered === true, registered.reason)

// audit fail + register refusal
const badAudit = await findTool('norms_py_audit').execute({ path: 'python-public/pypub/bad.py' }, { agent })
check('低分文件不通过', badAudit.pass === false, `score=${badAudit.score}`)
const badRegister = await findTool('norms_py_register').execute({ path: 'python-public/pypub/bad.py' }, { agent })
check('低分文件拒绝登记', badRegister.registered === false && /未严格大于/.test(badRegister.reason), badRegister.reason)

// outside public dir refused
writeFileSync(join(root, 'local_only.py'), 'def helper():\n    """本地脚本。"""\n    return 1\n', 'utf8')
const outside = await findTool('norms_py_register').execute({ path: 'local_only.py' }, { agent })
check('公共区外拒绝登记', outside.registered === false && /不在公共区/.test(outside.reason), outside.reason)

// session root
const ensured = await findTool('norms_session_root').execute({ action: 'ensure', name: '应用测试' }, { agent })
check('会话根文档创建', ensured.exists === true && ensured.path.endsWith('ROOT.md'), ensured.path)
const appended = await findTool('norms_session_root').execute({ action: 'append', name: '应用测试', text: '完成插件自测。' }, { agent })
check('会话根文档追加', appended.exists === true && appended.content.includes('完成插件自测'))
const readRoot = await findTool('norms_session_root').execute({ action: 'read', name: '应用测试' }, { agent })
check('会话根文档读取', readRoot.exists === true && readRoot.content.includes('会话根文档'))

// status
const status = await findTool('norms_status').execute({ session: '应用测试' }, { agent })
console.log('--- status ---')
console.log(findTool('norms_status').output.render({}, status)[0].text)
check('status 统计模块', status.publicDir.modules >= 2 && status.publicDir.unregistered >= 1)
check('status 找到会话根文档', status.sessionRoot.current.exists === true)

// command
check('注册 /rule 命令', commands.length === 1 && commands[0].name === 'rule')
const commandResult = await commands[0].handler({ agent, rawInput: '命令入口也要能落盘。', signal: undefined })
check('/rule 成功', commandResult.kind === 'success', commandResult.text)

// AGENTS.md contents
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
check('AGENTS.md 保留原文', agents.includes('原有内容必须原样保留。'))
check('AGENTS.md 有规则区块', agents.includes('norms:rules:start') && agents.includes('命令入口也要能落盘。'))
check('AGENTS.md 有模块区块', agents.includes('norms:modules:start') && agents.includes('python-public/pypub/sample.py'))
check('模块条目带参数', agents.includes('name'))
check('最近写入有记录', agents.includes('### 最近写入（norms 维护）'))
console.log('--- AGENTS.md tail ---')
console.log(agents.split('\n').slice(-30).join('\n'))
console.log(`\nworkspace: ${root}`)
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1