/**
 * 键位规格表下沉 + 右键菜单的键位注入缝（1023 开机图减重批）。
 *
 * 背景：`main.tsx → tutorial-context-menu.ts → context-menu-model.ts → keybindings.ts`
 * 这条静态链把整包键位**运行期**（localStorage 覆盖表、持久化、订阅、React 钩子）拖进了
 * 开机图，只为给菜单供两根展示字符串。本批把纯数据下沉成 `keybinding-specs.ts`（零 import
 * 的叶子），生效键位改由壳层注入。
 *
 * 钉五件事：
 * 1. **表只有一份**：`KEYBINDING_SPECS` 定义在 specs 模块，`keybindings` 只是再导出
 *    （同一个数组引用，不是第二份副本）；
 * 2. **减重的那根线断了**：`context-menu-model` 对 `./keybindings` 无值导入；
 * 3. 未注册 lookup：菜单显示规格表里的**缺省键位**（首屏极早期也不空白、不抛错）；
 * 4. 注册 lookup：菜单显示**作者改过的键**，且与真按下去的那条是同一个读数；
 * 5. 注销 → 回缺省；注册态下作者**解绑** → 不画右列（注入方的答案即权威）。
 */
import { afterEach, describe, expect, it } from 'vitest';
// 源码原文（`?raw` 直读，不执行）：守门判据看的是"写了什么 import"，跑起来看不出差别
import modelSource from '../src/ui/context-menu-model.ts?raw';
import keybindingsSource from '../src/ui/keybindings.ts?raw';
import specsSource from '../src/ui/keybinding-specs.ts?raw';
import { formatKeybinding } from '../src/ui/commands';
import { menuItemFromCommand, registerMenuKeybindingLookup } from '../src/ui/context-menu-model';
import {
  KEYBINDING_SPECS as SPECS_FROM_SPECS,
  keybindingSpecOf as specOfFromSpecs,
} from '../src/ui/keybinding-specs';
import {
  KEYBINDING_SPECS,
  effectiveKeybindingOf,
  keybindingSpecOf,
  resetAllKeybindings,
  setKeybindingOverride,
} from '../src/ui/keybindings';

/** 静态 import 的"有值"依赖（与 `ps10-eager-graph.test.ts` 同一套判据：`import type` 会被擦除） */
function valueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1]!;
    if (/^\s*type\b/.test(clause)) continue; // import type { X } from '...'
    const hasValue = clause
      .split(',')
      .some((part) => part.trim() !== '' && !/^\s*type\b/.test(part.trim()));
    if (hasValue) out.push(m[2]!);
  }
  return out;
}

/** 全部静态 import 指向（含 `import type` / 花括号里的 `type`）——比走图口径更严的"一个字都不许提" */
function importSpecs(src: string): string[] {
  return [...src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\s*from\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1]!,
  );
}

describe('键位规格表 · 单一真源', () => {
  it('specs 模块里表只定义一次；keybindings 只再导出，不留字面量', () => {
    expect(specsSource.match(/export const KEYBINDING_SPECS\b/g)).toHaveLength(1);
    expect(keybindingsSource).not.toMatch(/export const KEYBINDING_SPECS\b/);
    // keybindings 里一条表项都不许留（有表项 = 悄悄养了第二份真相）
    expect(keybindingsSource).not.toMatch(/\{\s*id:\s*'/);
    // 表项数 = 表长：specs 里的字面量与导出面一一对应（没漏在注释里/没多写一行脏数据）
    expect(specsSource.match(/\{\s*id:\s*'/g)).toHaveLength(SPECS_FROM_SPECS.length);
  });

  it('再导出的是同一个东西（数组同引用、函数同引用），不是复制出来的第二份', () => {
    expect(KEYBINDING_SPECS).toBe(SPECS_FROM_SPECS);
    expect(keybindingSpecOf).toBe(specOfFromSpecs);
    // 锚点：查表结果仍是同一条规格（标题/缺省键没在搬运中掉包）
    expect(keybindingSpecOf('workbench.commandPalette')?.title).toBe('命令面板');
    expect(keybindingSpecOf('workbench.commandPalette')?.keys).toBe('ctrl+shift+p');
  });

  it('specs 是零 import 的叶子（谁都能安全 import，不牵出 storage / React）', () => {
    // 判据看 import 语句本身，不看注释里提到的路径（文档里会引用 `./keybindings`）
    expect(importSpecs(specsSource)).toEqual([]);
    expect(valueImports(specsSource)).toEqual([]);
    expect(specsSource).not.toMatch(/(?:^|\n)\s*import\s*['"]/); // 无副作用裸 import
    expect(specsSource).not.toMatch(/(?:^|\n)\s*export\s+(?:\*|\{[\s\S]*?\})\s*from\s*['"]/);
  });
});

describe('开机图守门 · 菜单数据面不再值导入键位运行期', () => {
  it('context-menu-model 对 ./keybindings 无值导入，纯件只走 ./keybinding-specs', () => {
    const specs = valueImports(modelSource);
    expect(specs).toContain('./keybinding-specs');
    expect(specs).not.toContain('./keybindings');
    // 更严一档：连 `import type` 都不必留——本模块不需要键位运行期的任何类型
    expect(importSpecs(modelSource)).not.toContain('./keybindings');
  });

  it('守门不空转：同一个解析器认得旧写法，也认得 type-only（否则上一条恒真）', () => {
    expect(valueImports("import { effectiveKeybindingOf } from './keybindings';")).toContain(
      './keybindings',
    );
    // `import type` 会被擦除 ⇒ 不算有值依赖；花括号里的 type 走图口径保守地仍算一条边
    expect(valueImports("import type { KeybindingRow } from './keybindings';")).toEqual([]);
    expect(valueImports("import { type KeybindingRow } from './keybindings';")).toContain(
      './keybindings',
    );
    expect(importSpecs("import type { KeybindingRow } from './keybindings';")).toContain(
      './keybindings',
    );
  });
});

describe('菜单键位注入缝（registerMenuKeybindingLookup）', () => {
  afterEach(() => {
    registerMenuKeybindingLookup(null);
    resetAllKeybindings();
  });

  it('未注册：显示规格表里的缺省键位（不空白、不抛错）', () => {
    registerMenuKeybindingLookup(null);
    expect(menuItemFromCommand('workbench.commandPalette')).toEqual({
      id: 'workbench.commandPalette',
      label: '命令面板',
      shortcut: 'Ctrl+Shift+P',
    });
  });

  it('注册后：显示作者改过的键，且与真按下去的那条同源', () => {
    registerMenuKeybindingLookup(effectiveKeybindingOf);
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    const item = menuItemFromCommand('workbench.problems');
    expect(item?.shortcut).toBe('Ctrl+Alt+P');
    // 同一个读数：菜单画的就是分发读的那条键（两处各算一次 = 迟早两个词）
    expect(item?.shortcut).toBe(formatKeybinding(effectiveKeybindingOf('workbench.problems')!));
  });

  it('注销后：回到缺省键位（不记住上一次的答案）', () => {
    registerMenuKeybindingLookup(effectiveKeybindingOf);
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    registerMenuKeybindingLookup(null);
    expect(menuItemFromCommand('workbench.problems')?.shortcut).toBe('Ctrl+Shift+M');
  });

  it('注册态下作者解绑：不画右列（注入方的答案即权威，不回落缺省）', () => {
    registerMenuKeybindingLookup(effectiveKeybindingOf);
    expect(setKeybindingOverride('workbench.problems', '')).toBe(true);
    expect(menuItemFromCommand('workbench.problems')?.shortcut).toBeUndefined();
  });

  it('标题不受注入影响（文案只认规格表，改键改不动它）', () => {
    registerMenuKeybindingLookup(effectiveKeybindingOf);
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(menuItemFromCommand('workbench.problems')?.label).toBe('问题面板');
  });
});
