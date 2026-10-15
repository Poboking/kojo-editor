import type { BackupVersion } from '@kojo/plugin-api';

/**
 * 本地时间线（F2）的宿主纯逻辑（2026-10-15 历史批）。
 *
 * 版本数据是内核 io 的既有写前自动备份（`listBackups` 读回来），本层只做
 * 展示口径（时间/大小格式化）与"这次要看哪个文件的历史"的状态单源
 * （照 `diff-view.ts` 同款：模块级 store + 订阅；意图经 editor.command 进来）。
 * 刻意不发明第二套备份目录约定。
 */

/** ui.overlay 贡献 id（宿主注册；命令 run 里发 `ui.overlay.open`） */
export const FILE_HISTORY_OVERLAY_ID = 'kojo.fileHistory';

/** editor.command 贡献 id（命令面板条目：「显示当前文件的历史版本」） */
export const SHOW_FILE_HISTORY_COMMAND_ID = 'kojo.showFileHistory';

/** 版本时刻的人读文本（文件名时间戳优先——mtime 会被复制/同步改写，文件名不会说谎） */
export function formatVersionTime(v: Pick<BackupVersion, 'takenAtMs' | 'mtimeMs'>): string {
  const ms = v.takenAtMs ?? v.mtimeMs;
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数人读（阈值 1024，一档到位；历史列表不需要三位小数） */
export function formatVersionSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ------------------------------ 状态单源 ------------------------------ */

let target: string | null = null;
const listeners = new Set<() => void>();

export function getFileHistoryTarget(): string | null {
  return target;
}

export function setFileHistoryTarget(next: string | null): void {
  target = next;
  for (const cb of [...listeners]) cb();
}

export function subscribeFileHistory(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
