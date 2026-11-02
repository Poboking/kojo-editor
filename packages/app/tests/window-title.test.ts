/**
 * 窗口标题的唯一算法（视觉批十四）。
 *
 * 三处出口共用（自绘标题栏 / `document.title` / Tauri 系统标题），所以这里钉的是**算法**
 * 而不是源码里出现过某个字符串：目录名怎么取、尾部斜杠怎么归一、取不出名字时退回什么。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_WINDOW_TITLE,
  projectDirName,
  windowTitleFor,
  windowTitleForSession,
} from '../src/ui/window-title';

describe('窗口标题 · 项目身份', () => {
  it('取目录 basename：Windows 反斜杠 / POSIX 正斜杠 / 尾部斜杠都归一', () => {
    expect(projectDirName('D:\\Game\\eratw\\my-project\\')).toBe('my-project');
    expect(projectDirName('D:/Game/eratw/my-project')).toBe('my-project');
    expect(projectDirName('/home/u/proj/')).toBe('proj');
    expect(windowTitleFor('D:\\Game\\eratw\\my-project')).toBe('my-project — kojo-editor');
  });

  it('无项目 / 取不出名字 ⇒ 退回产品名（不显示空破折号）', () => {
    for (const bad of [null, undefined, '', '   ', 'D:/', 'C:\\']) {
      expect(windowTitleFor(bad)).toBe(APP_WINDOW_TITLE);
      expect(projectDirName(bad)).toBeNull();
    }
  });

  it('产品名是唯一常量（三处出口不许各写一份）', () => {
    expect(APP_WINDOW_TITLE).toBe('kojo-editor');
    expect(windowTitleFor(null)).toBe(APP_WINDOW_TITLE);
  });
});

/**
 * 会话两态的标题（KW-4E 段④，2026-11-03）。
 *
 * 钉的是这一格：作者进的是**某一枚作品**的会话，标题栏却报内核生成的作品 id
 * （实测 `pmvzgrrm7-bo4du6 — kojo-editor`）——目录末段本来就是 id，`windowTitleFor`
 * 那一族只会取末段，所以作品会话必须把**作品名**交进来。拼法仍只有 `composeWindowTitle`
 * 一处，标题里不出现第二套格式化。
 */
describe('窗口标题 · 会话两态（windowTitleForSession）', () => {
  const SESSION_DIR = 'C:/Users/dev/AppData/Roaming/dev.kojo.editor/workspaces/pmvzgrrm7-bo4du6';

  it('游戏会话：与 windowTitleFor 逐字相同（第二参缺席 ⇒ 取目录名，零行为变化）', () => {
    for (const root of ['D:\\Game\\eratw\\my-project', 'C:/Game/eraTW/', null, undefined, '', 'D:/']) {
      expect(windowTitleForSession(root)).toBe(windowTitleFor(root));
      expect(windowTitleForSession(root, null)).toBe(windowTitleFor(root));
    }
    expect(windowTitleForSession('D:\\Game\\eratw\\my-project')).toBe('my-project — kojo-editor');
  });

  it('作品会话：标题说作品名，不说 id', () => {
    expect(windowTitleForSession(SESSION_DIR, '组长验收作品')).toBe('组长验收作品 — kojo-editor');
  });

  it('作品名缺席 / 全空白 ⇒ 如实回落目录末段（不编一个名字），两头都取不出才退产品名', () => {
    expect(windowTitleForSession(SESSION_DIR, '')).toBe('pmvzgrrm7-bo4du6 — kojo-editor');
    expect(windowTitleForSession(SESSION_DIR, '   ')).toBe('pmvzgrrm7-bo4du6 — kojo-editor');
    expect(windowTitleForSession(null, '   ')).toBe(APP_WINDOW_TITLE);
    // 名字两侧空白不参与判空后的拼法（给什么名就用什么名，不吞字符也不留空格）
    expect(windowTitleForSession(SESSION_DIR, ' 我的作品 ')).toBe('我的作品 — kojo-editor');
  });

  it('接线单源：App 只问这一族，不在渲染侧另拼字符串', () => {
    const app = readFileSync(fileURLToPath(new URL('../src/ui/App.tsx', import.meta.url)), 'utf8');
    expect(app).toContain('windowTitleForSession(project?.rootDir, workspaceSession?.name)');
    // 旧那枚只认目录名的调用不得在标题这一格复活（游戏会话那格由第二参缺席保证同形）
    expect(app).not.toContain('windowTitleFor(sessionRoot)');
  });
});
