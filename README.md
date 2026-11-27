# 工作区规范化（dsh-norms）

> 作者：nuoyis/dsh-norms · 许可证：MIT

把「用户重点强调的总规则」和「公共 Python 的能力参数」沉淀到工作区根 `AGENTS.md`，
并让每次模型的系统提示先看到规则链。

- 规则链：根 `AGENTS.md` → 指定目录区域 → 公共区 `README.md` → 本次会话 `ROOT.md`
- 强调规则：`norms_rule` 或 `/rule <文本>` 直接写进 `AGENTS.md` 托管区块
- 会话根文档：`会话归档/<会话名>/ROOT.md`
- 公共 Python：`norms_py_audit` 评分，严格大于 85 才允许 `norms_py_register`，登记时把 API、参数、评分写回 `AGENTS.md`

## 安装

从 npm：

```text
plugin_manager action=install_bundle target=dsh-norms@1.0.0
```

从本目录（开发时）：

```text
plugin_manager action=install_bundle target=<插件目录的绝对路径>
```

安装后新开一个会话生效；源码改动后要 `remove_bundle` 再 `install_bundle`。

## 目录

```text
dsh-norms/
├── index.js            Host 入口：prompt section、6 个工具、/rule 命令
├── lib/pyaudit.js      Python 公共性评分
├── lib/agentsmd.js     AGENTS.md 托管区块、备份、原子写
├── tests/              本地自测
├── market/index.example.json   插件市场索引模板（format 1）
├── package.json
├── cordis.patch.yml
├── locale/{en,zh}.json
├── icon.svg
├── docs/DETAIL.md      完整说明
├── LICENSE
└── README.md
```

## 自测

```bash
node tests/test-lib.mjs
node tests/test-apply.mjs
node --check index.js
```

## 发布

1. **npm**（包名 `dsh-norms`，2026-11-27 查询时未被占用）：

   ```bash
   npm login
   npm publish
   ```

   首次发布若要求 2FA，按提示输入一次性验证码；发布后确认
   `https://registry.npmjs.org/dsh-norms` 能返回版本信息。

2. **GitHub**：建 `github.com/nuoyis/dsh-norms`，`git push`，加 topic
   `dsh-plugin`（社区目录与自动扫描靠这个 topic 发现插件）。

3. **插件市场索引**：把 `market/index.example.json` 复制成
   `market/index.json`，按实际发布时间改 `publishTimestamp`（Unix 秒），
   提交到仓库；DSH 的 Discover 支持添加一个 http(s) JSON 索引地址：

   ```text
   https://raw.githubusercontent.com/nuoyis/dsh-norms/main/market/index.json
   ```

   在 DSH「插件 → 发现 → 管理索引源」添加该地址，即可搜索并安装。
   索引必须是最终地址（DSH 拒绝重定向），版本带 `engines.dsh`。

4. 可选：向 dsh.so、dsh.works、DSH Plugin Hub 等社区目录提交仓库地址；
   它们多数按 GitHub 的 `dsh-plugin` topic 自动收录，少数需要在其提交页登记。

完整功能、配置与评分规则见 [docs/DETAIL.md](docs/DETAIL.md)。