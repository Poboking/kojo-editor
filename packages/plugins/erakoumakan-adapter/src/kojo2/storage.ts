/**
 * era紅魔館 2.0 存储期落点（游戏事实 —— 只住本包）。
 *
 * **只两族**；证据 = 2026-10-26 `D:/Game/eraKoumakan` 真盘读数（全树 `.ERB` 裸写计数）：
 * - `LOCAL`：口上域 2,686 / 全树 11,293 —— 生成函数内的局部槽；
 * - `TCVAR`：口上域 266 / 全树 1,599 —— 进程内保留的角色级会话槽。
 *
 * **`SAVEDATA` 全树 0 次 ⇒ 不声明 `save` 族**。这不是「没找到」，是盘面事实：
 * 本作的持久状态落在引擎存档槽与角色 CSV 上，403 份 `.ERB` 里没有一处
 * `SAVEDATA` 引用；声明一个零落点的存档族只会让 2.0 的 `# 设 存档`
 * 产出无处安放的槽位。等真出现作者级 `SAVEDATA` 语料再补，不预埋。
 *
 * 槽位 `project-stable`：跨构建不搬槽（改名 / 新增不改变既有槽位，否则读旧档串值）。
 * 前缀 `__kojo_koumakan_*`：与作者名字空间隔离，且各作独立（同一引擎命名空间只装
 * 一作，前缀仍按作分开，避免将来多盘并存的账本混淆）。
 */
import type { StorageClasses } from '@kojo/kojo-core';

export const ERAKOUMAKAN_STORAGE_CLASSES: StorageClasses = Object.freeze({
  classes: Object.freeze([
    Object.freeze({
      period: 'scene' as const,
      engine: 'LOCAL',
      init: 'on-entry' as const,
      persisted: false,
      slotPrefix: '__kojo_koumakan_scene_',
      description: '生成函数内的局部槽；进入事件按初值初始化，退出即丢弃（口上域 2,686 处）',
    }),
    Object.freeze({
      period: 'session' as const,
      engine: 'TCVAR',
      init: 'on-process-start' as const,
      persisted: false,
      slotPrefix: '__kojo_koumakan_session_',
      description: '进程内保留、读档不恢复；新游戏 / 重启清零（口上域 266 处）',
    }),
  ]),
  slotStability: 'project-stable',
});
