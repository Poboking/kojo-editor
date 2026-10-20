/**
 * `ui/editor-pane/pane-helpers.ts` 的纯函数单测（REF-FRONT-PERF，2026-10-20）。
 *
 * 为什么要这一份：这批把 7 个纯函数从 2,700 行组件搬出（只搬家、不改判据），
 * 既有测试大多读**源码形状**（钉接线在不在）。行为面补一份直接调函数的单测，
 * 搬迁前后同一个输入必须同一个输出——以后谁再动这些判据，先红在这里。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErbFile, ErbIndex, EditorSaveHandlerContribution } from '@kojo/plugin-api';
import type { Kernel } from '@kojo/kernel';
import type * as Monaco from '../src/monaco/entry';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';
import {
  applyEditabilityAndSuggest,
  baseNameOf,
  erbFileInIndex,
  minimapCtxForPath,
  pickSaveHandler,
  sugarStampOf,
  tierOverrides,
} from '../src/ui/editor-pane/pane-helpers';

afterEach(() => vi.restoreAllMocks());

/* ───────────────────────── sugarStampOf：判据不全就不缓存 ───────────────────────── */

describe('sugarStampOf（PS-5 投影缓存键的项目侧摘要）', () => {
  it('无项目 / 缺 inputDigest 各给一个永不与可缓存条目相等的键', () => {
    expect(sugarStampOf(null)).toBe('\u0000no-project');
    expect(sugarStampOf({ adapterId: 'a', rootDir: 'C:\\g' })).toBe('\u0000no-digest');
    // 两个"不缓存"键互不相等（同一条纪律：判据不全不许彼此命中）
    expect(sugarStampOf(null)).not.toBe(sugarStampOf({ adapterId: 'a', rootDir: 'C:\\g' }));
  });

  it('三要素齐全才出摘要：adapterId / rootDir / inputDigest 任一变，键就变', () => {
    const base = { adapterId: 'eratw', rootDir: 'C:\\game', inputDigest: 'd1' };
    const key = sugarStampOf(base);
    expect(key).toContain('eratw');
    expect(key).toContain('C:\\game');
    expect(key).toContain('d1');
    expect(sugarStampOf({ ...base, adapterId: 'other' })).not.toBe(key);
    expect(sugarStampOf({ ...base, rootDir: 'C:\\game2' })).not.toBe(key);
    expect(sugarStampOf({ ...base, inputDigest: 'd2' })).not.toBe(key);
    expect(sugarStampOf({ ...base })).toBe(key);
  });
});

/* ───────────────────── erbFileInIndex：路径归一是宿主的活 ───────────────────── */

const erbFile = (path: string, lineCount = 12): ErbFile => ({
  path,
  functions: [],
  dims: [],
  hasFunctionDirective: false,
  lineCount,
});

const indexOf = (entries: Array<[string, ErbFile]>): ErbIndex =>
  ({ files: new Map(entries), byName: new Map(), fingerprint: 'fp' }) as unknown as ErbIndex;

describe('erbFileInIndex（HK-7：裸字符串比会静默判不上）', () => {
  it('索引缺席 / 找不到 ⇒ null（调用方退回解析全文）', () => {
    expect(erbFileInIndex(null, 'C:\\game\\a.erb')).toBeNull();
    expect(erbFileInIndex(indexOf([]), 'C:\\game\\a.erb')).toBeNull();
  });

  it('Windows 分隔符与大小写不一致时仍能命中（pathKey 归一，不靠裸比）', () => {
    const file = erbFile('C:\\Game\\Chara\\A.ERB');
    const index = indexOf([['C:\\Game\\Chara\\A.ERB', file]]);
    expect(erbFileInIndex(index, 'c:/game/chara/a.erb')).toBe(file);
    expect(erbFileInIndex(index, 'C:\\Game\\Chara\\A.ERB')).toBe(file);
  });

  it('命中返回索引里的那一份（不是按入参另造一个壳）', () => {
    const a = erbFile('C:\\game\\a.erb', 3);
    const b = erbFile('C:\\game\\b.erb', 9);
    const index = indexOf([
      ['C:\\game\\a.erb', a],
      ['C:\\game\\b.erb', b],
    ]);
    expect(erbFileInIndex(index, 'C:\\game\\b.erb')).toBe(b);
    expect(erbFileInIndex(index, 'C:\\game\\b.erb')?.lineCount).toBe(9);
  });
});

/* ─────────────────── minimapCtxForPath / baseNameOf：小纯函数 ─────────────────── */

describe('minimapCtxForPath（缩略图「跟随」档的文件侧判据）', () => {
  it('按语言判：.kojo 正文 true，ERB / 其它文件 false', () => {
    expect(minimapCtxForPath('C:\\game\\chara\\a.kojo')).toEqual({ kojoText: true });
    expect(minimapCtxForPath('C:\\game\\chara\\a.erb')).toEqual({ kojoText: false });
    expect(minimapCtxForPath('C:\\game\\readme.md')).toEqual({ kojoText: false });
  });
});

describe('baseNameOf（弹窗里只给文件名）', () => {
  it('两种分隔符都取末段', () => {
    expect(baseNameOf('C:\\game\\chara\\a.erb')).toBe('a.erb');
    expect(baseNameOf('/game/chara/a.erb')).toBe('a.erb');
    expect(baseNameOf('a.erb')).toBe('a.erb');
  });
});

/* ─────────────────── tierOverrides：档位之后那一层只有这一处 ─────────────────── */

describe('tierOverrides（档位 + 语言感知 formatOnType + 显示偏好）', () => {
  it('formatOnType 按"屏幕上那份文档"分：.kojo 大文件关、ERB 大文件开、小文件都开', () => {
    expect(tierOverrides(100, true).formatOnType).toBe(true);
    expect(tierOverrides(100, false).formatOnType).toBe(true);
    expect(tierOverrides(LARGE_FILE_LINES, true).formatOnType).toBe(true);
    expect(tierOverrides(LARGE_FILE_LINES, false).formatOnType).toBe(false);
  });

  it('extra 盖在档位之后（可写态 / 快建议三键的位置），显示偏好一并带上', () => {
    const o = tierOverrides(100, true, { readOnly: true, quickSuggestions: false });
    expect(o.readOnly).toBe(true);
    expect(o.quickSuggestions).toBe(false);
    expect(o.lineNumbers).toBe('on');
    expect(o.minimap).toBeDefined();
  });

  it('缩略图上下文喂进「跟随」档：.kojo 正文不画，普通文件画', () => {
    expect(tierOverrides(100, true, undefined, { kojoText: true }).minimap).toMatchObject({ enabled: false });
    expect(tierOverrides(100, true, undefined, { kojoText: false }).minimap).toMatchObject({ enabled: true });
  });
});

/* ─────────────────── applyEditabilityAndSuggest：只读与快建议同拍 ─────────────────── */

describe('applyEditabilityAndSuggest（readOnly 不拦 suggest，所以要同拍关）', () => {
  const fakeEditor = () => {
    const current: Record<string, unknown> = {};
    const ed = {
      updateOptions: (o: Record<string, unknown>) => Object.assign(current, o),
    } as unknown as Monaco.editor.IStandaloneCodeEditor;
    return { ed, current };
  };

  it('只读 ⇒ quickSuggestions 整条 false；可写 ⇒ 跟随设置页开关', () => {
    const ro = fakeEditor();
    applyEditabilityAndSuggest(ro.ed, true);
    expect(ro.current.readOnly).toBe(true);
    expect(ro.current.quickSuggestions).toBe(false);

    const rw = fakeEditor();
    applyEditabilityAndSuggest(rw.ed, false);
    expect(rw.current.readOnly).toBe(false);
    expect(rw.current.quickSuggestions).not.toBe(false);
  });

  it('延迟同源（node 无 localStorage ⇒ 缺省 0ms）', () => {
    const { ed, current } = fakeEditor();
    applyEditabilityAndSuggest(ed, false);
    expect(current.quickSuggestionsDelay).toBe(0);
  });
});

/* ──────────────── pickSaveHandler：唯一接管、order 最小、坏贡献隔离 ──────────────── */

const contribution = (
  id: string,
  order: number | undefined,
  matches: (path: string) => boolean,
): EditorSaveHandlerContribution =>
  ({
    id,
    ...(order === undefined ? {} : { order }),
    matches,
    save: vi.fn(),
  }) as unknown as EditorSaveHandlerContribution;

const kernelWith = (list: readonly EditorSaveHandlerContribution[]): Kernel =>
  ({ slots: { query: () => list } }) as unknown as Kernel;

describe('pickSaveHandler（ui.editor.saveHandler 就近接管）', () => {
  it('无命中 ⇒ undefined（退回内核 io.writeText 缺省路径）', () => {
    expect(pickSaveHandler(kernelWith([]), 'C:\\game\\a.erb')).toBeUndefined();
    expect(pickSaveHandler(kernelWith([contribution('s', 0, () => false)]), 'C:\\game\\a.erb')).toBeUndefined();
  });

  it('order 最小者唯一接管（不做链式级联）；缺省 order = 0；同 order 保持注册顺序', () => {
    const late = contribution('late', 5, () => true);
    const early = contribution('early', 1, () => true);
    expect(pickSaveHandler(kernelWith([late, early]), 'C:\\game\\a.kojo')).toBe(early);

    // 缺省 order 按 0 算（既有排序口径：`a.order ?? 0`）——不是"排在最后"
    const noOrder = contribution('none', undefined, () => true);
    expect(pickSaveHandler(kernelWith([late, early, noOrder]), 'C:\\game\\a.kojo')).toBe(noOrder);

    const first = contribution('first', 2, () => true);
    const second = contribution('second', 2, () => true);
    expect(pickSaveHandler(kernelWith([first, second]), 'C:\\game\\a.kojo')).toBe(first);
  });

  it('单个贡献 matches 抛错不影响其余（退化可见：记一条 warn，仍选别的）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = contribution('bad', 0, () => {
      throw new Error('boom');
    });
    const good = contribution('good', 9, () => true);
    expect(pickSaveHandler(kernelWith([bad, good]), 'C:\\game\\a.kojo')).toBe(good);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('bad');
  });
});
