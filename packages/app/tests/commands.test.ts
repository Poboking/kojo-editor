import { describe, expect, it } from 'vitest';
import type { EditorCommandContribution } from '@kojo/plugin-api';
import {
  buildCommandRegistry,
  chordEquals,
  chordFromEvent,
  commandEnabled,
  filterCommands,
  formatKeybinding,
  parseKeybinding,
  type CommandEntry,
  type KeyChord,
} from '../src/ui/commands';
import { rankFiles } from '../src/ui/palette-search';

/** 判据住在 palette-search（`Ctrl+P` 文件模式的真身）；测试要的是「只含路径」那条投影 */
const filterFileCandidates = (
  paths: readonly string[],
  q: string,
  cap?: number,
): string[] => rankFiles(paths, q, cap === undefined ? {} : { cap }).map((h) => h.path);

/**
 * 命令体系纯逻辑单测（2026-10-12 审阅补测批）。
 *
 * 覆盖 P2 引入的契约面：keybinding 解析/匹配（壳层快捷键与命令面板共用同一真源）、
 * 注册表合并（**同 id 槽贡献覆盖壳层默认**）、when 求值异常不炸交互、快速打开的
 * 「文件名命中优先于目录命中」（含 Windows `\` 路径——此处曾漏判）。
 */

const chord = (partial: Partial<KeyChord>): KeyChord => ({
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
  key: '',
  ...partial,
});

function keyEvent(e: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...e,
  } as KeyboardEvent;
}

describe('keybinding 解析', () => {
  it('修饰键顺序无关，主键取最后一个非修饰段', () => {
    expect(parseKeybinding('ctrl+shift+p')).toEqual(chord({ ctrl: true, shift: true, key: 'p' }));
    expect(parseKeybinding('shift+ctrl+p')).toEqual(parseKeybinding('ctrl+shift+p'));
    expect(parseKeybinding('f1')).toEqual(chord({ key: 'f1' }));
    expect(parseKeybinding('ctrl+alt+b')).toEqual(chord({ ctrl: true, alt: true, key: 'b' }));
  });

  it('大小写与空白容忍（作者手写与契约常量混用时不该炸）', () => {
    expect(parseKeybinding(' Ctrl + N ')).toEqual(chord({ ctrl: true, key: 'n' }));
  });

  it('别名：control/meta/cmd/super 归一', () => {
    expect(parseKeybinding('control+n')).toEqual(parseKeybinding('ctrl+n'));
    expect(parseKeybinding('cmd+n')).toEqual(chord({ meta: true, key: 'n' }));
    expect(parseKeybinding('super+n')).toEqual(parseKeybinding('cmd+n'));
  });

  it('非法输入 → null（空串 / 只有修饰键）', () => {
    expect(parseKeybinding('')).toBeNull();
    expect(parseKeybinding('   ')).toBeNull();
    expect(parseKeybinding('ctrl')).toBeNull();
  });
});

describe('键盘事件 → chord', () => {
  it('修饰键本身按下不产 chord（否则 Ctrl 一按就命中 Ctrl+X 类命令）', () => {
    expect(chordFromEvent(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(chordFromEvent(keyEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(chordFromEvent(keyEvent({ key: 'Meta', metaKey: true }))).toBeNull();
  });

  it('大写字母（Shift 组合）经小写归一后与声明式 keybinding 相等', () => {
    const ev = keyEvent({ key: 'P', ctrlKey: true, shiftKey: true });
    expect(chordEquals(chordFromEvent(ev)!, chord({ ctrl: true, shift: true, key: 'p' }))).toBe(true);
  });

  it('多按一个修饰键即不相等（不误触）', () => {
    const ev = keyEvent({ key: 'b', ctrlKey: true, altKey: false });
    expect(chordEquals(chordFromEvent(ev)!, chord({ ctrl: true, alt: true, key: 'b' }))).toBe(false);
  });
});

describe('keybinding 展示', () => {
  it('修饰键顺序固定为 Ctrl+Shift+Alt+Meta，单字符主键大写', () => {
    expect(formatKeybinding('shift+ctrl+p')).toBe('Ctrl+Shift+P');
    expect(formatKeybinding('f1')).toBe('F1');
  });

  it('与 parseKeybinding 互补：无法解析时原样回显（面板不至于空白）', () => {
    expect(formatKeybinding('ctrl')).toBe('ctrl');
  });
});

describe('命令注册表合并', () => {
  const shell = [
    { id: 'layout.toggleSidebar', title: '切换主侧栏', keybinding: 'ctrl+b', run: () => undefined },
    { id: 'workbench.commandPalette', title: '命令面板', keybinding: 'ctrl+shift+p', run: () => undefined },
  ];

  it('壳层命令归入「布局」类目，槽贡献带自身 category', () => {
    const slot: EditorCommandContribution[] = [
      { id: 'kojo.newKojoFile', title: '新建口上文件', category: '文件', run: () => undefined },
    ];
    const reg = buildCommandRegistry(shell, slot);
    expect(reg).toHaveLength(3);
    expect(reg.find((c) => c.id === 'layout.toggleSidebar')?.category).toBe('布局');
    expect(reg.find((c) => c.id === 'kojo.newKojoFile')?.category).toBe('文件');
  });

  it('同 id 时槽贡献覆盖壳层默认（插件可替换宿主命令）', () => {
    let ran = '';
    const slot: EditorCommandContribution[] = [
      { id: 'layout.toggleSidebar', title: '插件版切换', run: () => { ran = 'slot'; } },
    ];
    const reg = buildCommandRegistry(shell, slot);
    const entry = reg.find((c) => c.id === 'layout.toggleSidebar');
    expect(reg).toHaveLength(2);
    expect(entry?.title).toBe('插件版切换');
    // 覆盖后壳层原 keybinding 不再保留（键位归属随实现一起移交）
    expect(entry?.keybinding).toBeUndefined();
    entry?.run({ project: null });
    expect(ran).toBe('slot');
  });

  it('壳层命令不接收 ctx（run 形参缺省）——包装后调用不抛', () => {
    const reg = buildCommandRegistry(shell, []);
    expect(() => reg[0]!.run({ project: null })).not.toThrow();
  });
});

describe('when 求值', () => {
  const entry = (when?: CommandEntry['when']): CommandEntry => ({
    id: 'x',
    title: 'x',
    ...(when ? { when } : {}),
    run: () => undefined,
  });

  it('无 when → 恒可用；when=false → 不可用', () => {
    expect(commandEnabled(entry(), { project: null })).toBe(true);
    expect(commandEnabled(entry(() => false), { project: null })).toBe(false);
  });

  it('when 抛错 → 视为不可用（不炸面板渲染）', () => {
    const boom = entry(() => {
      throw new Error('boom');
    });
    expect(commandEnabled(boom, { project: null })).toBe(false);
  });
});

describe('命令面板过滤', () => {
  const commands: CommandEntry[] = [
    { id: 'kojo.newKojoFile', title: '新建口上文件', category: '文件', run: () => undefined },
    { id: 'layout.reset', title: '重置布局', category: '布局', run: () => undefined },
    { id: 'sugar.lift', title: '升糖建议', run: () => undefined },
  ];

  it('空查询返回全部，按 category 分组（无类目排最前）', () => {
    const out = filterCommands(commands, '');
    expect(out).toHaveLength(3);
    // 无类目项（'' 字典序恒最小）排最前；两个带类目项的相对次序交给 locale 排序
    expect(out[0]!.id).toBe('sugar.lift');
    expect(new Set(out.slice(1).map((c) => c.id))).toEqual(new Set(['layout.reset', 'kojo.newKojoFile']));
  });

  it('大小写不敏感，且 id 也参与匹配（作者记得命令名而非标题时仍可搜到）', () => {
    expect(filterCommands(commands, 'NEWKOJO').map((c) => c.id)).toEqual(['kojo.newKojoFile']);
    expect(filterCommands(commands, '布局').map((c) => c.id)).toEqual(['layout.reset']);
  });

  it('无匹配 → 空数组（面板据此显示空态）', () => {
    expect(filterCommands(commands, '不存在的命令')).toEqual([]);
  });
});

describe('快速打开候选过滤', () => {
  const paths = [
    'D:\\Game\\eratw\\ERB\\口上\\M_KOJO_K1_日常.kojo',
    'D:\\Game\\eratw\\ERB\\口上\\M_KOJO_K12_日常.kojo',
    'D:\\Game\\eratw\\ERB\\别的目录\\日常补丁.ERB',
  ];

  it('文件名命中优先于仅目录命中（Windows `\\` 路径下同样成立）', () => {
    const out = filterFileCandidates(paths, '日常补丁');
    // 只有第三个文件的**文件名**命中「日常补丁」
    expect(out[0]).toBe(paths[2]);
  });

  it('同一查询下文件名命中整体排在目录命中之前', () => {
    const out = filterFileCandidates(paths, '口上');
    // 「口上」只是前两个文件的**目录**段命中 → 仍应全部返回，且不丢项
    expect(out).toHaveLength(2);
  });

  it('空查询返回前 cap 条（面板初始态不铺满百万行）', () => {
    expect(filterFileCandidates(paths, '', 2)).toHaveLength(2);
    expect(filterFileCandidates([], '', 2)).toEqual([]);
  });

  it('大小写不敏感（查询小写、路径含大写仍命中）', () => {
    expect(filterFileCandidates(paths, 'm_kojo_k12_日常')).toEqual([paths[1]]);
  });
});