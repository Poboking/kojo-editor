/**
 * eraAV 2.0 存储期落点（游戏事实 —— 只住本包）。
 *
 * 三族都是 Emuera 引擎机制。使用实证（2026-10-26 全树受管 `.ERB` 裸写）：
 * - `LOCAL` 全树 5,831（口上域 **0**——本作口上不写局部变量）
 * - `SAVEDATA` 全树 **0**——机制保留（引擎存档区），但本作语料零使用，
 *   描述里照实写"零实证"，不冒充在用
 * - `TCVAR` 全树 547（口上域 **0**）
 *
 * 槽位 `project-stable`：跨构建不搬槽（改名 / 新增不改变既有槽位，否则读旧档串值）。
 * 前缀 `__kojo_eraav_*`：与作者名字空间隔离，且各作独立（同一引擎命名空间只装一作，
 * 前缀仍按作分开，避免将来多盘并存的账本混淆）。
 */
import type { StorageClasses } from '@kojo/kojo-core';

export const ERAAV_STORAGE_CLASSES: StorageClasses = Object.freeze({
  classes: Object.freeze([
    Object.freeze({
      period: 'scene' as const,
      engine: 'LOCAL',
      init: 'on-entry' as const,
      persisted: false,
      slotPrefix: '__kojo_eraav_scene_',
      description: '生成函数内的局部槽；进入事件按初值初始化，退出即丢弃（全树 5,831 处，口上域暂 0）',
    }),
    Object.freeze({
      period: 'save' as const,
      engine: 'SAVEDATA',
      init: 'on-new-game' as const,
      persisted: true,
      slotPrefix: '__kojo_eraav_save_',
      description: '随存档保存 / 恢复；本作语料 0 处使用（机制保留），stable 槽位，换盘 / 换汉化由指纹检测',
    }),
    Object.freeze({
      period: 'session' as const,
      engine: 'TCVAR',
      init: 'on-process-start' as const,
      persisted: false,
      slotPrefix: '__kojo_eraav_session_',
      description: '进程内保留、读档不恢复；新游戏 / 重启清零（全树 547 处，口上域暂 0）',
    }),
  ]),
  slotStability: 'project-stable',
});
