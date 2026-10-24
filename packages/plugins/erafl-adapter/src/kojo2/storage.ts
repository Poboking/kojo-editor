/**
 * eraFL 2.0 存储期落点（游戏事实 —— 只住本包）。
 *
 * 三个存储期（契约 §10.3）：
 * - `场景`：生成函数内的局部槽（唯一前缀），入口按声明初值初始化，退出即丢；
 * - `存档`：随存档保存/恢复，新游戏初始化；
 * - `会话`：进程内保留，读档不恢复，新游戏/重启清零。
 *
 * 依据：Emuera 引擎存储期语义（eraFL = Emuera 变体，根目录
 * `EmueraFL_v1.45-preview.exe`）——LOCAL / SAVEDATA / TCVAR 三个引擎落点与
 * eraTW 逐字相同（同引擎事实，不是照抄游戏词表）。eraFL 侧佐证：引擎变量表
 * `ERB/VARIABLE.ERH` / `VARIABLE_RELATION.ERH` 与 `CSV/CFLAG.CSV` 同机同格式
 * （v1 `constants.ts` 检测特征三件套之一）。
 *
 * 槽位稳定性：`project-stable` —— 跨构建不搬槽（改名/新增变量不改变既有槽位，
 * 否则读旧档会串值）。槽位前缀 `__` 开头，与作者名字空间隔离。
 */
import type { StorageClasses } from '@kojo/kojo-core';

export const ERAFL_STORAGE_CLASSES: StorageClasses = Object.freeze({
  classes: Object.freeze([
    Object.freeze({
      period: 'scene' as const,
      // 局部区：每个事件/监听调用独立一份
      engine: 'LOCAL',
      init: 'on-entry' as const,
      persisted: false,
      slotPrefix: '__kojo_scene_',
      description: '生成函数内的局部槽；进入事件按初值初始化，退出即丢弃',
    }),
    Object.freeze({
      period: 'save' as const,
      // 存档区：随存档保存/恢复；槽位稳定，换盘由 gameFingerprint 检测
      engine: 'SAVEDATA',
      init: 'on-new-game' as const,
      persisted: true,
      slotPrefix: '__kojo_save_',
      description: '随存档保存/恢复；stable 槽位，换盘/换汉化由指纹检测',
    }),
    Object.freeze({
      period: 'session' as const,
      // 会话区：进程内保留，读档不恢复（临时变量区）
      engine: 'TCVAR',
      init: 'on-process-start' as const,
      persisted: false,
      slotPrefix: '__kojo_session_',
      description: '进程内保留、读档不恢复；新游戏/重启清零',
    }),
  ]),
  slotStability: 'project-stable',
});
