/**
 * 窗口标题的**唯一算法**（视觉批十四）：自绘标题栏、`document.title`、Tauri 系统窗口标题
 * 三处都从这里取，免得"壳里改了、任务栏还是旧名"。
 *
 * 两态同一族（KW-4E 段④，2026-11-03）：游戏会话取 `rootDir` 的 basename（逐字不变）；
 * 作品会话取**作品名**（同一族里多给一枚可读名，拼法仍只有这一处）。
 * 内核/宿主零游戏名词（audit A）：标题里不出现适配器 id、不拼任何游戏名。无会话态退回产品名。
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
  return composeWindowTitle(projectDirName(rootDir));
}

/**
 * **会话**的窗口标题（KW-4E 段④，2026-11-03）：两态一把尺子，判据只在这一枚函数里。
 *
 * - 游戏会话 ⇒ 与 {@link windowTitleFor} 逐字相同（目录名 — kojo-editor）；
 * - 作品会话 ⇒ 用**作品名**。作品目录的末段是内核生成的作品 id（实测
 *   `pmvzgrrm7-bo4du6 — kojo-editor`），标题栏报工号不报名字，作者看不出自己在哪。
 *
 * `sessionName` 的唯一来源是 `WorkspaceSession.name`（内核现读的那份名字）；给了空串 /
 * 没给 ⇒ 如实回落到目录末段，不编一个名字出来。名字与根都归会话事实，本函数只做拼法。
 */
export function windowTitleForSession(
  projectRoot: string | null | undefined,
  sessionName?: string | null,
): string {
  const name = typeof sessionName === 'string' ? sessionName.trim() : '';
  return composeWindowTitle(name !== '' ? name : projectDirName(projectRoot));
}

/** 那一族的唯一拼法：拿得出可读名就 `<名> — kojo-editor`，否则退回产品名 */
function composeWindowTitle(name: string | null): string {
  return name === null || name === '' ? APP_WINDOW_TITLE : `${name} — ${APP_WINDOW_TITLE}`;
}
