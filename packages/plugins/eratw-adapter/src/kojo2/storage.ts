/**
 * eraTW 2.0 存储期落点（游戏事实 —— 只住本包）。
 *
 * 权威依据：设计稿 §10.3 / 附录 B.3。三个存储期：
 * - `场景`：生成函数内的局部槽（唯一前缀），入口按声明初值初始化，退出即丢；
 * - `存档`：随存档保存/恢复，新游戏初始化；
 * - `会话`：进程内保留，读档不恢复，新游戏/重启清零。
 *
 * 槽位稳定性：`project-stable` —— 跨构建不搬槽（改名/新增变量不改变既有槽位，
 * 否则读旧档会串值）。槽位前缀 `__` 开头，与作者名字空间隔离。
 */
import type { StorageClasses } from '../../../../kojo-core/src/adapter.js';

export const ERATW_STORAGE_CLASSES: StorageClasses = Object.freeze({
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
