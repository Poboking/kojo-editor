/**
 * 窗口标题的唯一算法（视觉批十四）。
 *
 * 三处出口共用（自绘标题栏 / `document.title` / Tauri 系统标题），所以这里钉的是**算法**
 * 而不是源码里出现过某个字符串：目录名怎么取、尾部斜杠怎么归一、取不出名字时退回什么。
 */
import { describe, expect, it } from 'vitest';
import { APP_WINDOW_TITLE, projectDirName, windowTitleFor } from '../src/ui/window-title';

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
