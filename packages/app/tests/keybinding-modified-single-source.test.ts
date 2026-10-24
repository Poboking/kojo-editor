/**
 * 「已改」判据单源（视觉批十一 · 收尾路 R2 · 债一）。
 *
 * 立论：快捷键页的范围档「已改」与右键菜单里「重置键位」能不能点，问的是**同一件事**
 * （这一行的键位还是不是缺省那一份）。改前两处各抄了一遍同样的比较——口径漂移在语法上
 * 完全合法，谁都不会报错，只有读代码的人能发现，正是 `problem-truth-single-source`
 * 那一类事故的形状。现在判据只住 `ui/keybindings.ts` 的 `isKeybindingRowModified`。
 *
 * 两把尺（照本仓「单源」闸的既有形态：运行时同值 + 源码只有一处定义）：
 *  ① 运行时：三态下菜单面的 `hasOverride` 与谓词逐字相等，且菜单的禁用态由它推出；
 *  ② 静态：这枚比较（`.state … 'default'`）全仓**恰有一处**，就在 keybindings.ts；
 *     两个消费面必须引那一枚谓词，不许自带同名的第二份定义。
 *
 * 本文件待在默认 node 环境（只在模块顶层 readFileSync，见 PITFALLS 183）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isKeybindingRowModified, type BindingState, type KeybindingRow } from '../src/ui/keybindings';
import {
  KEYBINDING_ACTION,
  buildKeybindingRowMenu,
  keybindingMenuStateOf,
} from '../src/ui/settings-menu';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.ts$/.test(e)) acc.push(p);
  }
  return acc;
}

/** 注释里的字样不算代码（否则「不许再抄某某」这种规约注释自己就把闸撞红） */
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const sourceFiles = walk(SRC);
const relOf = (p: string): string => path.relative(SRC, p).split(path.sep).join('/');

function row(state: BindingState, over: Partial<KeybindingRow> = {}): KeybindingRow {
  return {
    id: 'editor.test',
    title: '测试命令',
    category: '编辑器',
    keys: 'ctrl+s',
    display: 'Ctrl+S',
    rebindable: true,
    note: null,
    state,
    conflictWith: null,
    ...over,
  };
}

const STATES: readonly BindingState[] = ['default', 'overridden', 'unbound'];

describe('判据① · 两个消费面同吃一枚谓词', () => {
  it('三态下菜单面的 hasOverride 与谓词逐字相等（菜单侧不再自己算）', () => {
    for (const s of STATES) {
      const r = row(s);
      expect(keybindingMenuStateOf(r).hasOverride, s).toBe(isKeybindingRowModified(r));
    }
  });

  it('谓词本身：原样 = 没改过；改键与解绑都算「动过」（解绑是作者明确表达过的改动）', () => {
    expect(isKeybindingRowModified(row('default'))).toBe(false);
    expect(isKeybindingRowModified(row('overridden'))).toBe(true);
    expect(isKeybindingRowModified(row('unbound'))).toBe(true);
  });

  it('「重置键位」的可用态由这枚谓词决定：原样灰着并说人话，改过/解绑过才可点', () => {
    const input = (state: BindingState) => ({
      ...keybindingMenuStateOf(row(state)),
      conflictCount: 0,
      canCopy: true,
    });
    const disabled = buildKeybindingRowMenu(input('default')).find(
      (i) => i.id === KEYBINDING_ACTION.reset,
    );
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.disabledReason).toBe('这一条还是默认键位');
    for (const state of ['overridden', 'unbound'] as const) {
      const on = buildKeybindingRowMenu(input(state)).find((i) => i.id === KEYBINDING_ACTION.reset);
      expect(on?.disabled, state).toBeFalsy();
    }
  });
});

describe('判据② · 静态：这一判据全仓只有一处定义', () => {
  /** 比较本体（`row.state !== 'default'` 那一类写法）的容匹配：空白与引号形态一律抓 */
  const COMPARISON = /\.state\s*[!=]==\s*['"]default['"]/g;
  /** 同义改写（把「已改」拆成两态各自比较）也算第二处定义 */
  const REWRITE = /\.state\s*===\s*['"](?:overridden|unbound)['"]/g;

  it('对 default 那枚状态位的比较全仓恰有一处，且就在 keybindings.ts', () => {
    const hits: string[] = [];
    for (const p of sourceFiles) {
      const body = stripComments(readFileSync(p, 'utf8'));
      const n = (body.match(COMPARISON) ?? []).length;
      if (n > 0) hits.push(`${relOf(p)}×${n}`);
    }
    expect(hits, `「已改」判据又出现第二处写法：${hits.join(', ')}`).toEqual(['ui/keybindings.ts×1']);
  });

  it('展示级三态分色只住在页面那一处三元：它回答「画哪枚徽标」，不是「算不算改过」', () => {
    const sites: string[] = [];
    for (const p of sourceFiles) {
      const body = stripComments(readFileSync(p, 'utf8'));
      const n = (body.match(REWRITE) ?? []).length;
      if (n > 0) sites.push(`${relOf(p)}×${n}`);
    }
    // 名单即口径：谁要把「已改」拆成 overridden / unbound 两次比较，这里当场红
    expect(sites, '「已改」判据被拆成两态各自比较 = 第二处定义').toEqual(['ui/KeybindingsPage.tsx×2']);
  });

  it('谓词的定义只有一枚 export，且两个消费面都是引用它而不是复制它', () => {
    const defs: string[] = [];
    for (const p of sourceFiles) {
      const body = stripComments(readFileSync(p, 'utf8'));
      if (/function isKeybindingRowModified/.test(body) || /isKeybindingRowModified\s*[:=]\s*\(/.test(body)) {
        defs.push(relOf(p));
      }
    }
    expect(defs, 'isKeybindingRowModified 的定义处不止一枚').toEqual(['ui/keybindings.ts']);

    const page = read('../src/ui/KeybindingsPage.tsx');
    const menu = read('../src/ui/settings-menu.ts');
    for (const [name, src] of [
      ['KeybindingsPage.tsx', page],
      ['settings-menu.ts', menu],
    ] as const) {
      expect(src, `${name}: 没再引那枚谓词`).toMatch(/isKeybindingRowModified/);
      expect(src, `${name}: 仍从 './keybindings' 引（判据只有一个家）`).toMatch(
        /from '\.\/keybindings'/,
      );
    }
    // 页内不许再留一枚同义局部常量（改前的 `const isRowModified = ...`）
    expect(page.match(/const isRowModified/g) ?? [], '页面里又抄了一份局部判据').toHaveLength(0);
  });

  it('对外契约零改动：hasOverride 这一格仍在（消费方按原样读）', () => {
    expect(Object.keys(keybindingMenuStateOf(row('default'))).sort()).toEqual([
      'conflictWith',
      'hasKeys',
      'hasOverride',
      'id',
      'rebindable',
      'title',
    ]);
  });
});
