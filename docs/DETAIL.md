# 工作区规范化（dsh-norms）

> 作者：nuoyis/dsh-norms · 许可证：MIT

这个插件解决四件事：

1. 每次装配系统提示时，先给出**规则链**：工作区 `AGENTS.md` 第一，用户指定目录区域第二，公共区第三，本次会话根文档第四。
2. 用户重点强调、要求长期生效的**总规则**，直接写进根 `AGENTS.md` 的托管区块，不靠对话记忆。
3. 每个会话在 `会话归档/<会话名>/ROOT.md` 有独立根文档，记目标、决定和进展。
4. 公共 Python 先做**公共性审计**，严格大于阈值（默认 85）才允许登记，登记时把路径、API、参数、评分写回根 `AGENTS.md`。

## 规则链

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `<工作区>/AGENTS.md` | 最高优先级；DSH 本身已把它作为持久用户消息注入 |
| 2 | `Config.ruleDirs` | 每项可以是目录（读其中 `AGENTS.md`）或 `.md` 文件；默认 `python-public` |
| 3 | `<publicDir>/` | 公共 Python 模块与 `mcp/` 共享文件；读 `README.md` |
| 4 | `<sessionRootDir>/<会话名>/ROOT.md` | 本次会话的根文档，由 `norms_session_root` 维护 |

注入的 section 名为 `norms:index`，`order: 950`，位于文件引用（900）之后、Bash 工具说明（1000）之前。文件读失败时只降级成一行提示，不影响装配。

## 工具

| 工具 | 作用 |
| --- | --- |
| `norms_read` | 按优先级读规则链；可指定单个路径或会话名。只读 |
| `norms_rule` | 把一条总规则追加到根 `AGENTS.md`，归一化空白、去重、备份 |
| `norms_status` | 规则/模块数、公共区与 MCP 目录、会话根目录、根目录散落文件、未登记模块 |
| `norms_py_audit` | 给单个 Python 文件打公共性分并列出扣分行。只读 |
| `norms_py_register` | 审计通过（严格大于阈值）才登记，并把 API/参数写回 `AGENTS.md` |
| `norms_session_root` | `ensure` / `read` / `append` 本次会话的 `ROOT.md` |

命令：`/rule <文本>` 是 `norms_rule` 的最短入口。

## AGENTS.md 托管区块

插件只改两个带 marker 的区块，区块外的内容一个字不动：

```md
## 追加总规则（norms 维护）
<!-- norms:rules:start -->
- [2026-11-27 16:00] 用户强调的总规则正文
<!-- norms:rules:end -->

## 公共 Python 模块索引（norms 维护）
<!-- norms:modules:start -->
### `python-public/pypub/docx.py` · 公共性 99.4
...
### 最近写入（norms 维护）
- 2026-11-27 16:00 `python-public/pypub/docx.py` → 公共性 99.4
<!-- norms:modules:end -->
```

- 区块不存在时追加到文件末尾；已存在时原位更新。
- 每次写入前把原文件复制到 `<工作区>/.norms/backups/`，保留最近 20 份。
- 写入走临时文件 + rename，避免半截文件。
- 规则去重按“归一化空白后的正文”判断；模块按路径原位更新，不重复堆条目。

## 公共性评分

满分 100，阈值默认 85，**严格大于**才通过：

| 分项 | 权重 | 规则 |
| --- | --- | --- |
| api | 0.30 | 有公开 `def`/`class` 或公开全大写常量即 100 |
| doc | 0.25 | 公开函数/类有 docstring 的比例 |
| portability | 0.25 | 绝对路径、用户目录、工作区字面量每处扣 12；`if __name__` 扣 10 |
| param | 0.10 | 公开函数带非 `self` 参数的比例 |
| sideEffect | 0.10 | 顶层副作用语句每条扣 15 |

这是文本启发式，不执行代码、不做类型推断；它衡量“能不能被第二个项目直接拿去用”，不衡量代码对不对。阈值可在 `threshold` 调，但调低只影响登记门槛，不改变评分。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `ruleDirs` | `["python-public"]` | 第二优先级区域；目录或 `.md` 文件，相对工作区或绝对路径 |
| `publicDir` | `python-public` | 公共代码区；登记只允许此目录内的文件 |
| `mcpDir` | `python-public/mcp` | MCP 共享文件区（只建目录提示，不存凭据） |
| `sessionRootDir` | `会话归档` | 会话根文档目录 |
| `threshold` | `85` | 公共性门槛，严格大于 |
| `maxExtraChars` | `4000` | 注入系统提示的额外区域内容预算 |
| `maxRuleChars` | `500` | 单条规则上限 |
| `logKeep` | `20` | “最近写入”保留条数 |
| `injectPrompt` | `true` | 是否注入规则链摘要 |
| `tool` | `true` | 是否注册工具 |
| `command` | `true` | 是否注册 `/rule` |
| `maxScanBytes` | `400000` | 单文件审计上限 |

## 安装

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后确认 bundle 的 application 状态为 applied，再用 `cordis_inspect_query` 看 `norms` 行和六个工具是否挂上。修改 `index.js` 后需要重新安装同一目录（或按 DSH 的插件重载流程）才会生效。

## 边界

- 不把 MCP 凭据、token 写进工作区；`mcpDir` 只放共享文件。
- 不扫描 `python-public/archive/` 的大量项目副本；只统计 `pypub/` 与 `mcp/` 下的 `.py`。
- `norms_py_register` 拒绝 `__init__.py`，请登记它引用的具体模块。
- 根目录散落文件只在 `norms_status` 报告，不自动搬动；归置仍用 `python-public/tools/organize_by_session.py`。