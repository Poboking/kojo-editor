/**
 * B3g 行上注解那一条腿的**供方闸**（`src/codelens.ts` + `plugin.ts` 接线）。
 *
 * 判据本体在 `packages/kojo-lang/tests/codelens.test.ts`；本文件只钉**供方那一层**：
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——混成空结果会把那门语言自己的 code lens
 *    供方顶掉；不是 `codeLens` 的请求同样弃权；
 * 2. **形状**：包的三档事实 → 契约的 `EditorCodeLens`（`line` / `label` / `target`），
 *    `target.filePath` 取自请求的 `path`（包不碰路径）；
 * 3. **无文件身份 ⇒ 不给 `target`**（契约口径「省略 = 这条注解不可点」，宿主据此交空参数）；
 * 4. **快照**：`projectFiles` 给了就交下去，`projectFilesComplete === false` ⇒ 标题如实写
 *    「未看全」；缺席 ⇒ 同文件口径（与 B3g 之前逐字相同）；
 * 5. **零游戏事实**：不取 adapter（`project: null` 照给），`order` 与既有供方相同。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import { createKojoLangPlugin, provideCodeLenses } from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo2';
const OTHER = 'D:/proj/口上/2_共用.kojo2';

/** 三类注解都有的请求文件 */
const SOURCE = [
  '# 机 指令 310', // 1 → 事件 指令 · 参数 1
  '@织 回合末 之后', // 2 → 监听 回合末 · 之后
  '@函 增加羁绊(目标)', // 3 → 本文件 N 处用到
  '    ! 增加羁绊(1)',
  '    结果 = 增加羁绊(2)',
  '    @返 结果',
].join('\n');

function codeLensRequest(over: Record<string, unknown> = {}) {
  return {
    kind: 'codeLens' as const,
    path: PATH,
    text: SOURCE,
    project: null,
    languageId: 'kojo2',
    lineCount: 6,
    ...over,
  } as never;
}

function activate(): Map<string, EditorLanguageServiceContribution> {
  const contributions = new Map<string, EditorLanguageServiceContribution>();
  const ctx = {
    pluginId: 'kojo-lang',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    slots: {
      register: (slot: string, item: EditorLanguageServiceContribution) => {
        if (slot === 'ui.editor.languageService') contributions.set(item.id, item);
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  createKojoLangPlugin().activate(ctx);
  return contributions;
}

/* ============================== ① 语言过滤 ============================== */

describe('①弃权：不是 codeLens / 不是 kojo2 ⇒ undefined', () => {
  it('别的 kind ⇒ undefined（不抢别人的槽位）', () => {
    expect(provideCodeLenses(codeLensRequest({ kind: 'hover' }))).toBeUndefined();
    expect(provideCodeLenses(codeLensRequest({ kind: 'references' }))).toBeUndefined();
  });

  it('别的语言 ⇒ undefined（混成空结果会顶掉那门语言自己的 code lens 供方）', () => {
    expect(provideCodeLenses(codeLensRequest({ languageId: 'kojo-erb' }))).toBeUndefined();
    expect(
      provideCodeLenses(codeLensRequest({ languageId: undefined, path: 'D:/p/a.erb' })),
    ).toBeUndefined();
  });

  it('认这门语言 ⇒ 总是作答（哪怕整篇没有注解：空表是作答，不是弃权）', () => {
    const result = provideCodeLenses(codeLensRequest({ text: '> 只有旁白\n' }));
    expect(result).toEqual({ kind: 'codeLens', lenses: [] });
  });
});

/* ============================== ② 形状 ============================== */

describe('②契约形状：line / label / target', () => {
  it('三档注解按源码行升序、标题原样、target 带请求的文件身份', () => {
    const result = provideCodeLenses(codeLensRequest())!;
    expect(result.kind).toBe('codeLens');
    expect(result.lenses.map((lens) => [lens.line, lens.label])).toEqual([
      [1, '事件 指令 · 参数 1'],
      [2, '监听 回合末 · 之后'],
      [3, '本文件 2 处用到'],
    ]);
    for (const lens of result.lenses) {
      expect(lens.target).toBeDefined();
      expect(lens.target!.filePath).toBe(PATH);
      expect(lens.target!.line).toBe(lens.line);
    }
    // `@函` 的落点在名字那一段（列 + 区间），宿主据此亮出精确落点。
    expect(result.lenses[2]!.target!.column).toBe(4);
    expect(result.lenses[2]!.target!.span).toEqual({ columnStart: 4, columnEnd: 8 });
  });

  it('无文件身份（path 为空）⇒ 不给 target（契约口径：省略 = 不可点）', () => {
    const result = provideCodeLenses(codeLensRequest({ path: '' }))!;
    expect(result.lenses).toHaveLength(3);
    for (const lens of result.lenses) expect(lens.target).toBeUndefined();
  });

  it('坏输入不抛：判据抛错 ⇒ 空结果（"这一篇没有注解"是作者能读懂的退化）', () => {
    // `text` 不是字符串时包内 `typeof` 门会回空表；这里直接构造一个病态请求再确认不抛。
    let result: ReturnType<typeof provideCodeLenses> = undefined;
    expect(() => {
      result = provideCodeLenses(codeLensRequest({ text: 42 }));
    }).not.toThrow();
    expect(result).toEqual({ kind: 'codeLens', lenses: [] });
  });
});

/* ============================== ③ 项目快照 ============================== */

describe('③快照：缺席复刻本文件口径，在场改口并如实降级', () => {
  const otherFile = { path: OTHER, text: '# 幕 夜晚\n! 增加羁绊(3)\n> 她笑了。\n' };

  it('快照缺席 ⇒ 「本文件 N 处用到」（与 B3g 之前逐字相同）', () => {
    const result = provideCodeLenses(codeLensRequest({ lineCount: 6 }))!;
    expect(result.lenses[2]!.label).toBe('本文件 2 处用到');
  });

  it('快照在场 ⇒ 数到项目级并改口「共 N 处用到」', () => {
    const result = provideCodeLenses(
      codeLensRequest({ projectFiles: [otherFile], projectFilesComplete: true }),
    )!;
    expect(result.lenses[2]!.label).toBe('共 3 处用到');
  });

  it('快照不完整 ⇒ 标题如实写「未看全」（照答，不静默少给）', () => {
    const result = provideCodeLenses(
      codeLensRequest({ projectFiles: [otherFile], projectFilesComplete: false }),
    )!;
    expect(result.lenses[2]!.label).toBe('共 3 处用到（未看全）');
  });
});

/* ============================== ④ 接线 ============================== */

describe('④接线：槽里有一枚 `kojo2-codeLens`，order 与既有供方相同', () => {
  it('注册到 `ui.editor.languageService`，单答型（同一 kind 只答一次）', () => {
    const contributions = activate();
    const contribution = contributions.get('kojo2-codeLens');
    expect(contribution).toBeDefined();
    expect(contribution!.order).toBe(10);
    const result = contribution!.provide(codeLensRequest());
    expect(result).toEqual(provideCodeLenses(codeLensRequest()));
  });

  it('不靠项目 / adapter 事实（`project: null` 照给，判据只读源码与快照）', () => {
    const contributions = activate();
    const contribution = contributions.get('kojo2-codeLens')!;
    const result = contribution.provide(codeLensRequest({ project: null })) as {
      lenses: readonly unknown[];
    };
    expect(result.lenses).toHaveLength(3);
  });
});
