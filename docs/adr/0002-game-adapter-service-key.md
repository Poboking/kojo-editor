# ADR-0002: `game.adapter` 服务键的多适配器语义

- **日期**：2026-10-09
- **状态**：已接受（v0.1 务实版），v0.2 复核

## 背景

架构文档把 `game.adapter` 定义为槽位（单激活语义），同时 §5.1 又暗示它可以作为服务键被消费者 `requires`。
v0.1 写内核测试"多适配器同时注册"时暴露矛盾：

- 若多个适配器插件各自 `provide('game.adapter', …)`，**第二个插件会因服务冲突进入 error 状态**；
- 而 onboarding 的 detect 轮询（多游戏自动识别）**要求多个适配器共存**。

## 决策（v0.1）

1. **适配器插件的必要职责 = 注册 `game.adapter` 槽位**（供内核 onboarding 轮询）；这条永远成立。
2. 服务键 `game.adapter` **不由适配器插件强制提供**。适配器如需暴露服务，使用自选专属键（如 `game.adapter.<id>`），或者在 v0.2 由内核在 `project.opened` 后提供"当前激活适配器"的桥接服务。
3. 内核 onboarding 完全走槽位轮询（`ProjectService.open`），不依赖任何服务键。

## 后果

- 多适配器共存 + detect 轮询正常工作（内核测试已覆盖，含多命中告警）。
- 消费者若要"当前游戏适配器"的强类型引用，v0.2 再定桥接服务形态（内核提供 vs 约定专属键），届时补 ADR 修订。
- 保持了"内核零游戏知识"：桥接服务即使由内核提供，也只是搬运适配器对象，不含领域逻辑。

## 修订（2026-10-10，v0.2 第十三批后）

**v0.2 的桥接形态已定为约定专属键**：消费者通过
`slots.query('game.adapter', project.adapterId)` 获取当前激活适配器的强类型引用
（family-index、state-replay 均为此模式）。

- 服务键 `game.adapter` 依然**不由任何插件提供**（`requires` 不含它）——
  提供即与多适配器 detect 轮询冲突（本 ADR v0.1 决策 2 不变）。
- `ARCHITECTURE.md` §6 曾把 state-replay 的 `requires` 误写为含
  `'game.adapter'`，与实现及本 ADR 矛盾，已修正（审阅
  `REVIEW-OPTIMIZATION-2026-10-10.md` A1）。
