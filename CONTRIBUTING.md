# 开发说明（自用）

> 定位：本项目自 letta-code **v0.34.2** 起与原项目**彻底分家**——不合并上游、不做 cherry-pick、新功能自研；**整洁清晰与最小改动同等重要**。安全修复与模型兼容完全自持。

## 环境要求

- bun **1.3.14**（`engines` 要求 >= 1.3.2；CI 与 lockfile 以 1.3.14 为基线）
- Node **>= 22.19.0**
- 本机现状：bun 1.3.14（npm 渠道安装）、Node v22.19.0（`D:\nodejs`）

## 常用命令

```bash
bun install --frozen-lockfile    # 安装依赖（会执行 vendor 补丁 postinstall-patches）
bun run dev                      # 从 TypeScript 源码直接运行（改完即生效）
bun run dev -- -p "Hello"        # 带参数运行

bun run check                    # 本地护栏（13 项）：循环依赖 / 分层边界 / 导出风格 /
                                 # 文件命名 / 文件体积 / 模块归属 / 前缀冻结应用点 /
                                 # 测试隔离 / 测试覆盖 / skill frontmatter / 内置 skill
                                 # 脚本 / biome / tsc
bun run build                    # 构建：根目录 letta.js（已 gitignore）+ dist/app-server-client.*

bun test <file>                  # 单文件单测
node scripts/run-unit-tests.cjs  # 全量单测
```

## 纪律

1. **AI 不推送**：所有 `git push` 由本人手动执行（AI 只做本地提交）。
2. **变更登记**：每条改动/删除记录「文件 + 原因 + 对应需求编号 + 替代方案」。
3. **护栏保留**：`bun run check` 必须全绿；如自研代码触及 `file-size` 上限，允许在
   `scripts/source-file-size-baseline.json` 中按需上调（不删护栏本身）。
4. **依赖策略**：依赖钉死精确版本；需要改供应商适配行为时，用 `vendor/` +
   `scripts/postinstall-patches.js` 的既有补丁机制，而不是跟随上游升级。
5. **不接收上游补丁**：上游 release / 安全公告仅作参考，不做 cherry-pick。

## 架构与分层

详细的架构约束、模块归属与护栏说明见 [AGENTS.md](AGENTS.md)。