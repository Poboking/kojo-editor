# ADR-0012：Kojo 2.0 M3 Runtime Matcher 第一阶段

- 状态：已接受（2026-11-03）
- 范围：location/time 原始字面匹配、特异性比较、唯一选择、NoMatch/Ambiguous/NotLinked
- 不包含：地点/时间别名、区间、继承、最终 dispatch ERB

## 决策

1. `selectRuntimeTheater` 输入 `linkedProject`、`canonicalId`、`location`、`time`。
2. 只读取 `LinkedProject.groups` 中 `canonicalId` 完全相同的组；duplicate 组拒绝选择。
3. `unrestricted` 地点/时间匹配任意运行时值；`exact` / `named` 必须非 null 且与 raw 逐字相等。
4. 不做 trim、大小写折叠、别名、区间或继承。
5. 特异性固定：exact location = 2，unrestricted location = 0；named time = 1，unrestricted time = 0。
6. 最高分唯一才 selected；并列 ambiguous，不按 fileId / 源文件顺序 / ordinal 决胜；无匹配 no-match。
7. 候选列表只用于诊断排序，不表示运行时优先级。
8. 不生成最终 dispatch ERB；不回写 canonical target、Registry 版本或 exact duplicate 键。

## Additive 事实

M2 `ResolvedTheater` 增加只读 `location` / `time`，由 linker 从 `ProjectTheaterIR.theater` 原样复制。
这是 M3 读取 parser facts 所需的最小 additive 变更；M2 匹配语义与 exact duplicate 键不变。
