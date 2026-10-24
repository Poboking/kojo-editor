/**
 * 窗口标题的**唯一算法**（视觉批十四）：自绘标题栏、`document.title`、Tauri 系统窗口标题
 * 三处都从这里取，免得"壳里改了、任务栏还是旧名"。
 *
 * 只吃 `rootDir` 的 basename——内核/宿主零游戏名词（audit A）：标题里不出现适配器 id、
 * 不拼任何游戏名，项目目录叫什么就显示什么。无项目态退回产品名。
 */

/** 产品名（无项目时的窗口标题；也是带项目时 `—` 后面那半） */
export const APP_WINDOW_TITLE = 'kojo-editor';

/** `rootDir` 的目录名（尾部斜杠归一；空串 / 根目录这类取不出名字的形态给 null） */
export function projectDirName(rootDir: string | null | undefined): string | null {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') return null;
  const trimmed = rootDir.replace(/[\\/]+$/, '');
  if (trimmed === '' || /^[A-Za-z]:$/.test(trimmed)) return null;
  const name = trimmed.split(/[\\/]/).pop() ?? '';
  return name === '' ? null : name;
}

/** 带项目的窗口标题：`<目录名> — kojo-editor`；取不出目录名时退回产品名 */
export function windowTitleFor(rootDir: string | null | undefined): string {
  const name = projectDirName(rootDir);
  return name === null ? APP_WINDOW_TITLE : `${name} — ${APP_WINDOW_TITLE}`;
}
