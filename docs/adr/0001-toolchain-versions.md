# ADR-0001: 工具链版本决策（TypeScript 7 / Vitest 4 / Vite 7）

- **日期**：2026-10-09
- **状态**：已接受

## 背景

v0.1 搭建时环境为：Node 22.22（managed）、pnpm 11.22、TypeScript 7.0.2（最新）、Vitest 5.0.3（最新）、Vite 8.3.4（rolldown 版）。

首次运行测试时全部测试文件报 `Cannot find module '<相对路径>.ts'`。排查过程：

1. 排除 vitest 5 独有回归：降到 vitest 4.1.11 现象相同；
2. 排除 Vite 8 / rolldown 特有问题：降到 Vite 7.3.7 现象相同；
3. 最小复现实验（独立 `mini/` 目录，同构的两层相对导入）**全部通过**；
4. 最终定位：**是测试代码自身的相对路径写错**（`tests/foo.test.ts` 中误写 `../../src/`，正确为 `../src/`），与工具链版本无关。

## 决策

- 保持 **Vitest 4.1.11 + Vite 7.3.7**（稳定线）作为当前测试栈；不回滚到 Vitest 5 / Vite 8。
- TypeScript 采用 7.0.2。
- 相对导入统一**不带扩展名**（bundler resolution；vitest/vite 对 `.ts` 后缀显式导入的解析行为有版本差异，无后缀是最稳形态）。

## 后果

- 版本落后最新一个大版本，但两线均为成熟稳定版；待 Vitest 5 / Vite 8 生态稳定后可一次性升级。
- 教训入账：**"模块找不到"类报错先怀疑自己的路径**，再做版本对照实验；最小复现（mini 目录）是最高效的定位手段。
- pnpm 11 供应链安全策略会拦截 esbuild 等构建脚本（`ERR_PNPM_IGNORED_BUILDS`），已在 `pnpm-workspace.yaml` 用 `allowBuilds` 显式批准。
