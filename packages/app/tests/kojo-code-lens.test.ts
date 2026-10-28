/**
 * 行上内联注解 · 宿主接线（B8：`withinCodeLensBudget` / `collectCodeLenses` /
 * `toMonacoCodeLenses` / `installCodeLensProvider`）单测。
 *
 * 桩 monaco（只给注册面）+ 桩 model（只给行数），同 `kojo-folding.test.ts` 的口径。
 * 覆盖三件事：(a) **产出**两道护栏的界线（条数 / 密度——体量档 R2 已撤，见
 * `kojo-code-lens.ts` 头注读数）；(b) 合并的三态、抛错隔离与去重；
 * (c) 越界行**丢弃**（不夹取）与 Monaco 形状；(d) 点击只走 `editor.revealLocation` 那条
 * 既有通道、注册与回收成对。**宿主零判据**：这里没有一条断言认识「被引用」是什么意思。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorCodeLens,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  CODE_LENS_MAX_DENSITY,
  CODE_LENS_MAX_PER_DOCUMENT,
  collectCodeLenses,
  installCodeLensProvider,
  isCodeLensTarget,
  toMonacoCodeLenses,
  withinCodeLensBudget,
} from '../src/monaco/kojo-code-lens';

const REQUEST: EditorLanguageServiceRequest = {
  kind: 'codeLens',
  path: 'C:/p/a.ERB',
  text: '@A\nCALL A',
  project: null,
  lineCount: 2,
};

const lens = (line: number, label: string): EditorCodeLens => ({ line, label });

const contribution = (
  id: string,
  provide: EditorLanguageServiceContribution['provide'],
): EditorLanguageServiceContribution => ({ id, provide });

const modelWithLines = (lineCount: number): Monaco.editor.ITextModel =>
  ({ getLineCount: () => lineCount }) as unknown as Monaco.editor.ITextModel;

describe('withinCodeLensBudget · 全有或全无', () => {
  it('条数上限：顶到 `CODE_LENS_MAX_PER_DOCUMENT` 仍给，多一条整篇不给', () => {
    const lines = CODE_LENS_MAX_PER_DOCUMENT * CODE_LENS_MAX_DENSITY * 10; // 让密度档不先拦
    expect(withinCodeLensBudget(CODE_LENS_MAX_PER_DOCUMENT, lines)).toBe(true);
    expect(withinCodeLensBudget(CODE_LENS_MAX_PER_DOCUMENT + 1, lines)).toBe(false);
  });

  it('密度档：每 5 行正文最多 1 条（插满行 = 花屏，判整篇不给）', () => {
    expect(withinCodeLensBudget(4, 20)).toBe(true);
    expect(withinCodeLensBudget(5, 20)).toBe(false); // floor(20/5)=4 ⇒ 每 5 行 1 条
    expect(withinCodeLensBudget(5, 24)).toBe(false); // floor(24/5)=4
    expect(withinCodeLensBudget(1, 4)).toBe(false); // floor(4/5)=0 ⇒ 一行都不许插
    expect(withinCodeLensBudget(0, 1)).toBe(true); // 无注解永远不超预算
  });
});

describe('collectCodeLenses · 合并三态 / 抛错隔离 / 去重', () => {
  it('`undefined` 跳过、空数组不加、别的判别成员不打扰本面', () => {
    const out = collectCodeLenses(
      [
        contribution('nope', () => undefined),
        contribution('none', () => ({ kind: 'codeLens', lenses: [] })),
        contribution('other', () => ({ kind: 'foldingRange', ranges: [] })),
        contribution('hit', () => ({ kind: 'codeLens', lenses: [lens(7, '被 2 处用到')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([lens(7, '被 2 处用到')]);
  });

  it('单枚抛错只让它自己失声，其余照常出（呈现面不许带崩编辑器）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = collectCodeLenses(
      [
        contribution('boom', () => {
          throw new Error('索引炸了');
        }),
        contribution('hit', () => ({ kind: 'codeLens', lenses: [lens(3, '被 1 处用到')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([lens(3, '被 1 处用到')]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("'boom'"))).toBe(true);
    warn.mockRestore();
  });

  it('同行同文去重、同行异文都留（两句话不是一句话说了两遍）；输出按行升序', () => {
    const out = collectCodeLenses(
      [
        contribution('a', () => ({ kind: 'codeLens', lenses: [lens(9, '同一句'), lens(2, '别的'), lens(9, '同一句')] })),
        contribution('b', () => ({ kind: 'codeLens', lenses: [lens(9, '同一句'), lens(9, '另一句')] })),
      ],
      REQUEST,
    );
    expect(out).toEqual([lens(2, '别的'), lens(9, '同一句'), lens(9, '另一句')]);
  });
});

describe('toMonacoCodeLenses · 形状与越界', () => {
  it('越界行**丢弃**而非夹取；非有限行号丢弃', () => {
    const model = modelWithLines(10);
    const got = toMonacoCodeLenses(model, [
      lens(0, '零'),
      lens(1, '首'),
      lens(10, '尾'),
      lens(11, '越界'),
      { line: Number.NaN, label: 'nan' },
    ]);
    expect(got.map((c) => c.range.startLineNumber)).toEqual([1, 10]);
  });

  it('零宽区间挂行首 + 标签走 command.title + id 逐条唯一（同行两条也有身份）', () => {
    const got = toMonacoCodeLenses(modelWithLines(10), [lens(4, '甲'), lens(4, '乙')]);
    expect(got.map((c) => c.id)).toEqual(['b8:4:0', 'b8:4:1']);
    expect(got[0]!.range).toEqual({ startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 });
    expect(got[0]!.command).toEqual({ id: 'kojo.codeLens.execute', title: '甲', arguments: [] });
  });

  it('有落点才带参数（无落点的注解仍挂同一条命令，由处理端判掉——不给 Monaco 假按钮）', () => {
    const target = { filePath: 'C:/p/b.ERB', line: 5, column: 7 };
    const got = toMonacoCodeLenses(modelWithLines(10), [{ line: 2, label: '被 1 处用到', target }]);
    expect(got[0]!.command!.arguments).toEqual([target]);
  });
});

describe('isCodeLensTarget · 命令参数边界验证', () => {
  it('只认宿主发出去的那个形状', () => {
    expect(isCodeLensTarget({ filePath: '/a.ERB', line: 3 })).toBe(true);
    for (const bad of [undefined, null, 0, '/a.ERB', { filePath: '/a.ERB' }, { line: 3 }, { filePath: 1, line: 3 }]) {
      expect(isCodeLensTarget(bad)).toBe(false);
    }
  });
});

/** 桩 monaco：只给 code lens 需要的三个注册面，记录调用与 dispose */
function stubMonaco(): {
  monaco: typeof Monaco;
  registered: { languageId: string; provider: Monaco.languages.CodeLensProvider }[];
  disposed: string[];
  commands: { id: string; handler: (...args: unknown[]) => void }[];
} {
  const registered: { languageId: string; provider: Monaco.languages.CodeLensProvider }[] = [];
  const commands: { id: string; handler: (...args: unknown[]) => void }[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerCodeLensProvider: (
        languageId: string,
        provider: Monaco.languages.CodeLensProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => disposed.push(languageId) };
      },
    },
    editor: {
      registerCommand: (id: string, handler: (...args: unknown[]) => void): Monaco.IDisposable => {
        commands.push({ id, handler });
        return { dispose: () => disposed.push(`command:${id}`) };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered, disposed, commands };
}

describe('installCodeLensProvider · 协议翻译与回收', () => {
  it('两种语言都注册；dispose 把两枚 provider 与命令一起回收', () => {
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installCodeLensProvider(monaco, {
      resolve: () => [],
      navigate: () => undefined,
    });
    expect(registered.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    handle.dispose();
    expect(disposed).toHaveLength(3);
  });

  it('resolve 抛错 ⇒ 这一篇「没有注解」，编辑器输入链不被带崩', () => {
    const { monaco, registered } = stubMonaco();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installCodeLensProvider(monaco, {
      resolve: () => {
        throw new Error('供方炸了');
      },
      navigate: () => undefined,
    });
    const got = registered[0]!.provider.provideCodeLenses(modelWithLines(5), {
      isCancellationRequested: false,
    } as never) as Monaco.languages.CodeLensList;
    expect(got.lenses).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('点击：有落点才跳（走注入的 navigate，宿主不新造第二套跳转）；无落点与坏参数都原地不动', () => {
    const { monaco, commands } = stubMonaco();
    const navigated: unknown[] = [];
    installCodeLensProvider(monaco, {
      resolve: () => [],
      navigate: (target) => navigated.push(target),
    });
    const cmd = commands.find((c) => c.id === 'kojo.codeLens.execute')!;
    const target = { filePath: 'C:/p/b.ERB', line: 5, column: 7 };
    // Monaco 的注册命令回调第一个实参是 accessor，其余才是注解带过来的参数
    cmd.handler({}, target);
    cmd.handler({});
    cmd.handler({}, '不是对象');
    expect(navigated).toEqual([target]);
  });
});
