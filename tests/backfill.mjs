// 作者：nuoyis/dsh-norms。一次性回填：审计 python-public/pypub 下的模块，通过的登记进根 AGENTS.md。
// 用法：node tests/backfill.mjs
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditPython } from '../lib/pyaudit.js'
import { registerModule } from '../lib/agentsmd.js'

const WORKSPACE = resolve(import.meta.dirname, '../../..')
const AGENTS = join(WORKSPACE, 'AGENTS.md')
const PUB = join(WORKSPACE, 'python-public', 'pypub')

const NOTES = {
  docx: 'Word 报告排版、表格图片、模板占位符替换',
  filetext: '任意文件取文本：编码识别，Word/Excel/PPT/PDF 通吃',
  officecom: '本机 Office 转老格式、导 PDF、刷域（需 pywin32）',
  paths: '路径与文件安全操作：out_dir、safe_name、backup',
  pdftext: 'PDF 取文字、提词、转 txt（PyMuPDF）',
  pptx: 'PPT 版面、形状、图片与色板',
  pyindex: 'Python 源码盘点、查重、找函数',
  sessionlog: '读 DSH 会话日志：会话名称与写过的路径',
  sessionorg: '按会话名称归置散落产出',
  shell: '跑子进程、编译运行 C++',
  textw: '中英混排宽度、折行与排版小工具',
  xlsx: 'Excel 建表、样式、读回与体检',
  canvas: 'Pillow 画流程图、示意图与代码截图',
}

const rows = []
for (const [name, summary] of Object.entries(NOTES)) {
  const path = join(PUB, `${name}.py`)
  const report = auditPython(readFileSync(path, 'utf8'), { threshold: 85 })
  if (!report.pass) {
    rows.push([name, report.score, '跳过'])
    continue
  }
  const result = registerModule(AGENTS, {
    path: `python-public/pypub/${name}.py`,
    score: report.score,
    threshold: report.threshold,
    api: report.api,
    constants: report.constants,
    summary,
  })
  rows.push([name, report.score, result.added ? '新增' : '更新'])
}

for (const row of rows) console.log(row.join('\t'))
const passed = rows.filter(row => row[2] !== '跳过').length
console.log(`\n已登记 ${passed} / ${rows.length} 个模块`)