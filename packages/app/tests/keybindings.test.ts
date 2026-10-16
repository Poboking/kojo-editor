import { afterEach, describe, expect, it } from 'vitest';
import {
  chordToBinding,
  defaultKeybindingOf,
  effectiveKeybindingOf,
  hasKeybindingOverride,
  keybindingConflictWith,
  keybindingSpecOf,
  KEYBINDING_SPECS,
  setKeybindingOverride,
} from '../src/ui/keybindings';
import { parseKeybinding } from '../src/ui/commands';

/**
 * 键位注册表单测（R8 快捷键批）。
 *
 * 钉的是三件事：①注册表自身的完整性（id 唯一、可改键的条目有据可查）；
 * ②覆盖的语义（设置/复原/幂等、非法键位串拒绝、不可改键的条目拒绝）；
 * ③chord ↔ 键位串往返（捕获改键的落库格式与解析器互逆）。
 */

describe('KEYBINDING_SPECS 完整性', () => {
  it('id 唯一（同 id 会让键位表出现两行说不清的真相）', () => {
    const ids = KEYBINDING_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条有缺省键位的条目都能被 parseKeybinding 解析（含和弦）', () => {
    for (const s of KEYBINDING_SPECS) {
      if (s.keys === undefined) continue;
      expect(parseKeybinding(s.keys), s.id).not.toBeNull();
    }
  });

  it('标题一律中文（英文标题 = 面板里混进生肉）', () => {
    for (const s of KEYBINDING_SPECS) {
      expect(/[\u4e00-\u9fff]/.test(s.title), s.id).toBe(true);
    }
  });

  it('已知锚点：命令面板缺省 Ctrl+Shift+P，写作模式不可改键', () => {
    expect(defaultKeybindingOf('workbench.commandPalette')).toBe('ctrl+shift+p');
    const zen = keybindingSpecOf('layout.toggleZen');
    expect(zen?.rebindable).toBe(false);
  });
});

describe('覆盖表（改键）', () => {
  afterEach(() => {
    setKeybindingOverride('workbench.problems', null);
    setKeybindingOverride('layout.toggleZen', null);
  });

  it('设置生效 → 生效键位随覆盖走，复原回缺省', () => {
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+shift+m');
    expect(setKeybindingOverride('workbench.problems', 'ctrl+alt+p')).toBe(true);
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+alt+p');
    expect(hasKeybindingOverride('workbench.problems')).toBe(true);
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
    expect(effectiveKeybindingOf('workbench.problems')).toBe('ctrl+shift+m');
    expect(hasKeybindingOverride('workbench.problems')).toBe(false);
  });

  it('复原幂等（无覆盖时复原仍算成功——重复点「复原」不该报错）', () => {
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
    expect(setKeybindingOverride('workbench.problems', null)).toBe(true);
  });

  it('非法键位串拒绝（坏数据不进持久化）', () => {
    expect(setKeybindingOverride('workbench.problems', 'not a chord')).toBe(false);
    expect(hasKeybindingOverride('workbench.problems')).toBe(false);
  });

  it('不可改键的条目（和弦 / 编辑器内部键）拒绝', () => {
    expect(setKeybindingOverride('layout.toggleZen', 'ctrl+alt+z')).toBe(false);
    expect(setKeybindingOverride('editor.internal.save', 'ctrl+return')).toBe(false);
  });

  it('不在注册表的 id 拒绝（改键只对登记过的键位开放）', () => {
    expect(setKeybindingOverride('made.up.command', 'ctrl+1')).toBe(false);
  });
});

describe('冲突检测', () => {
  it('同 chord 的其它命令被点名（展示但不阻止——分发先到先得）', () => {
    const chord = parseKeybinding('ctrl+shift+m')!;
    expect(keybindingConflictWith(chord, 'workbench.problems')).toBeNull();
    expect(keybindingConflictWith(chord, 'layout.reset')).toBe('问题面板');
  });
});

describe('chordToBinding ↔ parseKeybinding 往返', () => {
  it('修饰键顺序归一（捕获落库格式与解析器互逆）', () => {
    for (const binding of ['ctrl+shift+p', 'ctrl+alt+b', 'f1', 'ctrl+k']) {
      const chord = parseKeybinding(binding)!;
      expect(parseKeybinding(chordToBinding(chord))).toEqual(chord);
    }
  });
});
