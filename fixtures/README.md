# fixtures —— 合成样本（不含任何真实游戏数据）

本目录由 [`tools/gen-fixtures.mjs`](../tools/gen-fixtures.mjs) 生成，全部为**合成数据**，
目的是让**没有真实 eraTW 目录**的贡献者也能跑通集成冒烟（"迷你模式"）。
真实游戏语料不入库（验证矩阵见 `AGENTS.md` §三）。

## 目录

```
fixtures/
├── mini-game/                        # 合成 eraTW 目录骨架
│   ├── CSV/
│   │   ├── Chara/                    # 角色映射（Chara{n} {名前}.csv）
│   │   ├── CFLAG.csv                 # 设名称表（条件抽取的语义标注来源）
│   │   └── Talent.csv
│   └── ERB/口上・メッセージ関連/
│       ├── KOJO_MESSAGE.ERB          # 口上路由表（最小）
│       └── 個人口上/                  # 口上域（001 / 002 两个角色）
├── corpus-v1/                        # 可控"语料机"目录（手维，不由 gen-fixtures 生成）
│   ├── CSV/                          # 复制自 mini-game（满足语料内容条件）
│   └── ERB/                          # 复制自 mini-game + 作者口上/ 4 份 .kojo1
└── sugar/
    └── sample-310.kojo               # 合成 .kojo（规范 §6.1 形态）
```

`corpus-v1/` 供 `packages/kojo-conformance/tests/corpus.test.ts` 的语料机用例使用：
`作者口上/*.kojo1` 是 `fixtures/scaffold/*.kojo1` 逐字节复制、首行补 `角色: 12`
（片段没有文件头声明；与合成迁移语料的 `completion.prependChara` 同口径）。
它**不是作者语料**，只证明「发现 ≥1 份 v1 源 + 状态/原因分类可读」。

## 迷你模式冒烟

`packages/kernel/tests/fixtures-mini.test.ts` 直接指向 `fixtures/mini-game/`（无需环境变量）：

```bash
node node_modules/vitest/vitest.mjs run packages/kernel/tests/fixtures-mini.test.ts
```

覆盖：适配器 detect → CHARA 映射 → 口上索引 → 家族识别 → 口上调用协议 → 约定校验 → 条件抽取（含变量字典标注）。

## 重新生成

```bash
node tools/gen-fixtures.mjs            # 已存在则跳过
node tools/gen-fixtures.mjs --force    # 强制重写
```