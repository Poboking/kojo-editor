/**
 * WS-13 2a 车 · 会话剪贴板 + 运行时桥的判据（模块级状态，零 React）＋ 登记对表（源码扫描）。
 *
 * 三块各自要钉的东西：
 * 1. `file-clipboard.ts` 的模块级单例——归一去重、空集合的语义（等于清空且模式回落）、
 *    人话句、运行时桥的"没挂载要拿 false 说话"；每条都用 `resetFileClipboardForTest`
 *    隔离（模块状态跨用例活着，不清就是拿上一例的现场演下一例）；
 * 2. 四条 `explorer.*` 命令进了**懒半表**（开机图不涨字节）且刻意不带缺省键；
 * 3. 接线两头都在源码里（口径照 `ws-e-command-coverage.test.ts`：表配了但没接线同样是空命令）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearFileClipboard,
  fileClipSentence,
  getFileClipMode,
  getFileClipboard,
  hasFileClipboard,
  resetFileClipboardForTest,
  runExplorerOp,
  setExplorerOpsRuntime,
  setFileClipboard,
  type ExplorerOp,
} from '../src/ui/file-clipboard';
import { COMMAND_PANEL_KEYBINDING_SPECS } from '../src/ui/keybinding-specs-commands';
import { KEYBINDING_CATEGORY_ORDER, KEYBINDING_SPECS } from '../src/ui/keybinding-specs';
import {
  EXPLORER_COPY_COMMAND,
  EXPLORER_CUT_COMMAND,
  EXPLORER_DUPLICATE_COMMAND,
  EXPLORER_PASTE_COMMAND,
} from '../src/ui/file-tree-ops';

const readSrc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/ui/${name}`, import.meta.url)), 'utf8');

afterEach(() => {
  resetFileClipboardForTest();
});

describe('会话剪贴板 · 写入与归一', () => {
  it('按 pkey 式归一去重：分隔符 / 大小写两种写法不算两份；空路径丢掉；原样写法保留', () => {
    const n = setFileClipboard(
      [
        { path: 'C:/koa/001/a.ERB', isDir: false },
        { path: 'C:\\koa\\001\\A.erb', isDir: false }, // 同一份的第二种写法
        { path: '', isDir: false },
        { path: 'C:/koa/001/包A', isDir: true },
      ],
      'copy',
    );
    expect(n).toBe(2);
    expect(getFileClipboard()).toEqual([
      { path: 'C:/koa/001/a.ERB', isDir: false },
      { path: 'C:/koa/001/包A', isDir: true },
    ]);
  });

  it('空集合等于清空，且模式回落 copy（不给"剪贴板空着但仍标着剪切"的状态）', () => {
    setFileClipboard([{ path: 'C:/a.ERB', isDir: false }], 'cut');
    expect(getFileClipMode()).toBe('cut');
    const n = setFileClipboard([], 'cut');
    expect(n).toBe(0);
    expect(hasFileClipboard()).toBe(false);
    expect(getFileClipMode()).toBe('copy');
  });

  it('种类在写入那一刻定死（isDir 跟着快照走——粘贴时树可能已经变了）', () => {
    setFileClipboard([{ path: 'C:/koa/001/包A', isDir: true }], 'copy');
    expect(getFileClipboard()[0]).toEqual({ path: 'C:/koa/001/包A', isDir: true });
  });

  it('clearFileClipboard 两份字段一起复位', () => {
    setFileClipboard([{ path: 'C:/a.ERB', isDir: false }], 'cut');
    clearFileClipboard();
    expect(hasFileClipboard()).toBe(false);
    expect(getFileClipMode()).toBe('copy');
  });
});

describe('会话剪贴板 · 上屏人话', () => {
  it('空着说的是指引而不是"0 项"（读起来像 bug 的说法不是人话）', () => {
    expect(fileClipSentence()).toContain('剪贴板是空的');
  });

  it('非空按模式选动词、按条数说话', () => {
    setFileClipboard([{ path: 'C:/a.ERB', isDir: false }, { path: 'C:/b.ERB', isDir: false }], 'copy');
    expect(fileClipSentence()).toBe('已复制 2 项');
    setFileClipboard([{ path: 'C:/a.ERB', isDir: false }], 'cut');
    expect(fileClipSentence()).toBe('已剪切 1 项');
  });
});

describe('运行时桥 · 命令面板的那条腿', () => {
  it('树没挂载 ⇒ runExplorerOp 返回 false（调用侧必须说人话；桥自己不弹通知）', () => {
    const ops: ExplorerOp[] = [];
    expect(runExplorerOp('copy')).toBe(false);
    expect(ops).toEqual([]);
  });

  it('登记后动作打到运行时的 run；整体替换语义 = 打的是最新那份', () => {
    const seen: string[] = [];
    setExplorerOpsRuntime({ run: (op) => seen.push(op) });
    expect(runExplorerOp('paste')).toBe(true);
    setExplorerOpsRuntime({ run: (op) => seen.push(op === 'cut' ? 'cut' : `x:${op}`) });
    expect(runExplorerOp('copy')).toBe(true);
    expect(runExplorerOp('cut')).toBe(true);
    expect(seen).toEqual(['paste', 'x:copy', 'cut']);
  });

  it('卸载（登记 null）之后回到"没挂载"那一档', () => {
    setExplorerOpsRuntime({ run: () => { throw new Error('不该再被调用'); } });
    setExplorerOpsRuntime(null);
    expect(runExplorerOp('duplicate')).toBe(false);
  });
});

describe('登记对表 · 四条命令进了懒半表与分类序表', () => {
  const IDS = [EXPLORER_COPY_COMMAND, EXPLORER_CUT_COMMAND, EXPLORER_PASTE_COMMAND, EXPLORER_DUPLICATE_COMMAND];

  it('四条都在键位表里且标题/分类非空（快捷键页看不见 = 作者改不了键）', () => {
    for (const id of IDS) {
      const spec = [...KEYBINDING_SPECS, ...COMMAND_PANEL_KEYBINDING_SPECS].find((s) => s.id === id);
      expect(spec, `键位表里没有 ${id}`).not.toBeUndefined();
      expect(spec!.title).not.toBe('');
      expect(spec!.category, `${id} 没有分类`).not.toBe('');
    }
  });

  it('四条**都刻意不带缺省键**：Ctrl+C/X/V/D 只走树内白名单，全局认领会把编辑器的复制粘贴抢走', () => {
    for (const id of IDS) {
      const spec = COMMAND_PANEL_KEYBINDING_SPECS.find((s) => s.id === id);
      expect(spec, `${id} 应登记在懒半表（不进开机图）`).not.toBeUndefined();
      expect(spec!.keys, `${id} 不该有宿主缺省键`).toBeUndefined();
    }
  });

  it('「资源管理器」分类进了展示序表（漏登记的分类会被排到最后，显示漂移）', () => {
    expect(KEYBINDING_CATEGORY_ORDER).toContain('资源管理器');
  });

  it('接线源码两头都在：FileTree 交运行时桥、ProjectView 发四条命令（表配了没接线同样是空命令）', () => {
    const fileTree = readSrc('FileTree.tsx');
    const projectView = readSrc('ProjectView.tsx');
    expect(fileTree).toContain('setExplorerOpsRuntime');
    for (const constName of ['EXPLORER_COPY_COMMAND', 'EXPLORER_CUT_COMMAND', 'EXPLORER_PASTE_COMMAND', 'EXPLORER_DUPLICATE_COMMAND']) {
      expect(projectView, `ProjectView 没引 ${constName}`).toContain(`${constName}`);
    }
    for (const id of IDS) {
      expect(readSrc('file-tree-ops.ts'), `id 常量 ${id} 没在 file-tree-ops 定源`).toContain(`'${id}'`);
    }
    // 脏闸接的是会话脏态那份真源（判据住 disk-reconcile，树与执行层都不自造"脏"定义）
    expect(projectView).toContain('dirtyNamesIn');
    expect(projectView).toContain('dirtyPaths');
  });
});
