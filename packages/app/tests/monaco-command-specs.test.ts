/**
 * 内核动作清单单测（1026 编辑器内核批）。
 *
 * 这一批把 Monaco 内建动作接进命令面板与键位面，风险全在**接错线**：
 * id 重复会让命令面板一个身份两行、分类漏登记会让键位页顺序漂、有内建键的误登记宿主键会抢键。
 * 这里逐条钉住：清单形状唯一、与宿主键位表接得上、合并后命令面板可见、additive（旧两参调用零变化）。
 *
 * monacoActionId / keybinding 的 **vendor 取证对账**住在 `monaco-builtin-keybindings.test.ts`
 * （回 `monaco-editor@0.57.0` 源码逐条核），本文件只管「接线正确」。
 */
import { describe, expect, it } from 'vitest';
import type { EditorCommandContribution } from '@kojo/plugin-api';
import {
  MONACO_COMMAND_CATEGORY,
  MONACO_COMMAND_SPECS,
  MONACO_COMMAND_SPEC_COUNT,
  monacoCommandsWithBuiltinKey,
  monacoCommandsWithoutBuiltinKey,
} from '../src/ui/monaco-command-specs';
import { buildCommandRegistry, filterCommands } from '../src/ui/commands';
import { KEYBINDING_CATEGORY_ORDER, KEYBINDING_SPECS, keybindingSpecOf } from '../src/ui/keybindings';
import { monacoBuiltinRows } from '../src/ui/monaco-builtin-keybindings';

describe('内核动作清单 · 形状与唯一性', () => {
  it('每条都有 id/title/category/monacoActionId/vendorFile，id 前缀 editor.builtin.、动作 id 非空', () => {
    expect(MONACO_COMMAND_SPECS).toHaveLength(MONACO_COMMAND_SPEC_COUNT);
    for (const s of MONACO_COMMAND_SPECS) {
      expect(s.id.startsWith('editor.builtin.'), s.id).toBe(true);
      expect(s.title, s.id).not.toBe('');
      expect(s.monacoActionId, s.id).not.toBe('');
      expect(s.category, s.id).not.toBe('');
      expect(s.vendorFile, s.id).not.toBe('');
      expect(typeof s.requiresFile, s.id).toBe('boolean');
    }
  });

  it('id 与 monacoActionId 都唯一（同一条动作不许长成两行）', () => {
    expect(new Set(MONACO_COMMAND_SPECS.map((s) => s.id)).size).toBe(MONACO_COMMAND_SPECS.length);
    expect(new Set(MONACO_COMMAND_SPECS.map((s) => s.monacoActionId)).size).toBe(MONACO_COMMAND_SPECS.length);
  });

  it('分类只取 6 个中文族，且都在键位页序表里登记（新增分类必须同步 KEYBINDING_CATEGORY_ORDER）', () => {
    const allowed: Set<string> = new Set(Object.values(MONACO_COMMAND_CATEGORY));
    for (const s of MONACO_COMMAND_SPECS) expect(allowed.has(s.category), s.category).toBe(true);
    for (const cat of allowed) expect(KEYBINDING_CATEGORY_ORDER, cat).toContain(cat);
  });

  it('有缺省键 / 无缺省键两族互斥，并集 = 全表', () => {
    expect(monacoCommandsWithBuiltinKey().length + monacoCommandsWithoutBuiltinKey().length).toBe(
      MONACO_COMMAND_SPEC_COUNT,
    );
    for (const s of monacoCommandsWithBuiltinKey()) expect(s.keybinding, s.id).toBeDefined();
    for (const s of monacoCommandsWithoutBuiltinKey()) expect(s.keybinding, s.id).toBeUndefined();
  });
});

describe('与宿主键位表接得上', () => {
  it('每条都登记进 KEYBINDING_SPECS（命令面板可见、键位页看得见）', () => {
    for (const s of MONACO_COMMAND_SPECS) expect(keybindingSpecOf(s.id), s.id).toBeDefined();
  });

  it('宿主键位表里 id 唯一——内核动作不是第二份身份', () => {
    const ids = KEYBINDING_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('一律不占宿主缺省键（内建键归 Monaco，宿主不覆写、不劫持）；无缺省键的那些登记为可改键', () => {
    for (const s of monacoCommandsWithBuiltinKey()) {
      expect(keybindingSpecOf(s.id)?.keys, s.id).toBeUndefined();
    }
    for (const s of monacoCommandsWithoutBuiltinKey()) {
      const spec = keybindingSpecOf(s.id)!;
      expect(spec.rebindable, s.id).toBe(true);
      expect(spec.keys, s.id).toBeUndefined();
    }
  });

  it('有 Monaco 缺省键的核进只读页（id = monaco. + monacoActionId），无缺省键的不进', () => {
    const rowIds = new Set(monacoBuiltinRows().map((r) => r.id));
    for (const s of monacoCommandsWithBuiltinKey()) {
      expect(rowIds.has(`monaco.${s.monacoActionId}`), s.id).toBe(true);
    }
    for (const s of monacoCommandsWithoutBuiltinKey()) {
      expect(rowIds.has(`monaco.${s.monacoActionId}`), s.id).toBe(false);
    }
  });
});

describe('合并进注册表 · 命令面板可见', () => {
  const editorActions: EditorCommandContribution[] = MONACO_COMMAND_SPECS.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    run: () => undefined,
  }));

  it('第三参并入注册表；旧两参调用不掺内核动作（additive：旧调用方零改动）', () => {
    expect(buildCommandRegistry([], [])).toHaveLength(0);
    const reg = buildCommandRegistry([], [], editorActions);
    expect(reg).toHaveLength(MONACO_COMMAND_SPEC_COUNT);
    for (const s of MONACO_COMMAND_SPECS) expect(reg.some((c) => c.id === s.id), s.id).toBe(true);
  });

  it('面板按中文分组名 / 标题搜得到（分类与标题都进过滤）', () => {
    const reg = buildCommandRegistry([], [], editorActions);
    const byCategory = filterCommands(reg, MONACO_COMMAND_CATEGORY.fold);
    expect(byCategory.some((c) => c.id === 'editor.builtin.foldAll')).toBe(true);
    expect(filterCommands(reg, '折叠到第 3 层').some((c) => c.id === 'editor.builtin.foldLevel3')).toBe(true);
  });

  it('槽贡献仍最高优先（同 id 插件可覆盖内核动作）', () => {
    const reg = buildCommandRegistry(
      [],
      [{ id: 'editor.builtin.foldAll', title: '插件版全部折叠', run: () => undefined }],
      editorActions,
    );
    expect(reg.find((c) => c.id === 'editor.builtin.foldAll')?.title).toBe('插件版全部折叠');
  });
});