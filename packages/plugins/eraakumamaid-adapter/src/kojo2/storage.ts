/**
 * eraAkumaMaid 2.0 存储期落点（游戏事实 —— 只住本包）。
 *
 * **无真盘 · 证据等级 B**：2026-10-26 实测 `C:/game/eraAkumaMaid` 与
 * `D:/Game/eraAkumaMaid` 均不存在，本文件**不含任何真盘计数**；依据 = v1 源码
 * 的 `file:line` 与测试夹具。三族齐备（scene / save / session），逐族证据：
 *
 * - `LOCAL` / `scene`：`call-protocol.ts:65-67` `, LOCALS` 整数组透传
 *   （被调方以 `@F, LOCALS` 接收局部区）⇒ 局部区在用；进入事件按初值初始化。
 * - `SAVEDATA` / `save`：`tests/variable-schema.test.ts:127` 夹具
 *   `#DIMS SAVEDATA K15_MainStory`；`variable-schema.ts` 头注的 ERH 前置关键字含
 *   `SAVEDATA`（源码 `ERH_DECL_KEYWORDS`，:512）⇒ 存档区是作者可见落点。
 * - `TCVAR` / `session`：`library-table.ts:76` `TCVAR:対象:(GETNUM(EX,…)+900)`
 *   （`PREVEX` 真实落点）、`library-table.ts:75` `TCVAR:…+200`（`EXP_GAIN`）⇒
 *   进程内保留的角色级会话槽。
 *
 * 槽位 `project-stable`：跨构建不搬槽（改名 / 新增不改变既有槽位，否则读旧档串值）。
 * 前缀 `__kojo_akumamaid_*`：与作者名字空间隔离，且各作独立。
 */
import type { StorageClasses } from '@kojo/kojo-core';

export const ERAAKUMAMAID_STORAGE_CLASSES: StorageClasses = Object.freeze({
  classes: Object.freeze([
    Object.freeze({
      period: 'scene' as const,
      engine: 'LOCAL',
      init: 'on-entry' as const,
      persisted: false,
      slotPrefix: '__kojo_akumamaid_scene_',
      description: '生成函数内的局部槽；进入事件按初值初始化，退出即丢弃（`, LOCALS` 透传实证）',
    }),
    Object.freeze({
      period: 'save' as const,
      engine: 'SAVEDATA',
      init: 'on-new-game' as const,
      persisted: true,
      slotPrefix: '__kojo_akumamaid_save_',
      description: '引擎存档区；开新游戏清零、随存档持久化（`#DIMS SAVEDATA` 夹具实证）',
    }),
    Object.freeze({
      period: 'session' as const,
      engine: 'TCVAR',
      init: 'on-process-start' as const,
      persisted: false,
      slotPrefix: '__kojo_akumamaid_session_',
      description: '进程内保留、读档不恢复；新游戏 / 重启清零（`TCVAR` 读写真语料实证）',
    }),
  ]),
  slotStability: 'project-stable',
});
