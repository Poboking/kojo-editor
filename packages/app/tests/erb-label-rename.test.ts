/**
 * `$` 标签重命名（W-2，2026-10-19）：纯判定 + provider 接线。
 *
 * 纪律：标签是**单文件、函数局部**事实，不依赖项目索引；改名必须
 * - 只改本函数内的定义与跳转（跨函数同名不动）；
 * - 全或无：名字非法 / 撞同函数标签 / 只读 / `.kojo` 源里有同名标签写法 ⇒ 整次取消；
 * - 跳转目标绝不落函数名腿（`GOTO ALPHA` 不是调用 ALPHA）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbIndex } from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { installErbRename, type ErbRenameHandlers } from '../src/monaco/erb-rename';
// 判据本体（LAU-4 改名腿）：标签守卫与改名编排在解析器插件，宿主只翻 Monaco 形状
import { kojoLabelMentions, labelRenameRejection, provideRename, provideRenameTarget } from '@kojo/plugin-erb-parser';

const PATH = 'C:/p/ERB/label.ERB';
const KOJO = 'C:/p/kojo/a.kojo1';

function modelOf(path: string, text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    uri: { scheme: 'file', fsPath: path, path, toString: () => `file:///${path.replace(/\\/g, '/')}` },
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    getValue: () => text,
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLineMaxColumn: (n: number) => (lines[n - 1]?.length ?? 0) + 1,
  } as unknown as Monaco.editor.ITextModel;
}

function kojoModelOf(path: string, text: string): Monaco.editor.ITextModel {
  return {
    ...(modelOf(path, text) as unknown as Record<string, unknown>),
    getLanguageId: () => KOJO_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
}

interface Stub {
  monaco: typeof Monaco;
  provider: () => Monaco.languages.RenameProvider;
}

function stubMonaco(models: Monaco.editor.ITextModel[] = []): Stub {
  const registered: { languageId: string; provider: Monaco.languages.RenameProvider }[] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (languageId: string, provider: Monaco.languages.RenameProvider) => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: { getModels: () => models },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file:///${p}` }) },
  } as unknown as typeof Monaco;
  return { monaco, provider: () => registered[0]!.provider };
}

const AT = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

function handlersOf(opts: {
  writable?: boolean;
  kojoSources?: ErbRenameHandlers['kojoSources'];
  byName?: Map<string, never[]>;
  refs?: null;
} = {}): ErbRenameHandlers {
  // 判据桩：索引只给 `byName`（标签腿不依赖索引；函数腿回归用例要它）
  const index =
    opts.byName === undefined
      ? null
      : ({ byName: opts.byName, references: { bySymbol: new Map() } } as unknown as ErbIndex);
  const isDialect = (path: string): boolean => /\.(?:erb|erh|erd)$/i.test(path);
  return {
    canAnswer: () => true,
    resolveTarget: (request) => provideRenameTarget(index, request, isDialect),
    resolveRename: (request) => provideRename(index, request, isDialect),
    isWritable: () => opts.writable ?? true,
    openModelFor: () => undefined,
    applyToClosedFile: async () => ({ applied: 0, stale: 0 }),
    ...(opts.kojoSources ? { kojoSources: opts.kojoSources } : {}),
  };
}

/**
 * 装配：`openModelFor` 从传入的 model 表里按路径找回（生产等价——改名只发生在**已打开的
 * 标签**上；标签腿的编辑必须走 WorkspaceEdit 通道，不能掉进闭文件 io）。
 */
function install(handlers: ErbRenameHandlers, models: Monaco.editor.ITextModel[] = []) {
  const stub = stubMonaco(models);
  installErbRename(stub.monaco, {
    ...handlers,
    openModelFor: (path: string) =>
      models.find((model) => {
        const uri = (model as unknown as { uri?: { fsPath?: string } }).uri;
        return uri?.fsPath === path;
      }),
  });
  return stub.provider();
}

const TEXT = '@F\n$Next\n\tGOTO next\n@G\n$Next\n\tGOTO NEXT\n';

describe('kojoLabelMentions · `.kojo` 同名标签写法', () => {
  it('糖写法与原生直通写法都命中（大小写不敏感、剥 `;` 注释、`$`/`*` 前缀）', () => {
    expect(kojoLabelMentions('标签 NEXT', 'NEXT')).toBe(true);
    expect(kojoLabelMentions('  跳到 $next ; 注释', 'NEXT')).toBe(true);
    expect(kojoLabelMentions('跳到 *Next', 'NEXT')).toBe(true);
    expect(kojoLabelMentions('$NEXT ; 注释', 'NEXT')).toBe(true);
    expect(kojoLabelMentions('GOTO next', 'NEXT')).toBe(true);
    expect(kojoLabelMentions('TRYJUMP NEXT', 'NEXT')).toBe(true);
  });

  it('不同名 / 非行首写法 / 函数调用都不算', () => {
    expect(kojoLabelMentions('标签 NEXT2', 'NEXT')).toBe(false);
    expect(kojoLabelMentions('; 标签 NEXT', 'NEXT')).toBe(false);
    expect(kojoLabelMentions('PRINT "标签 NEXT"', 'NEXT')).toBe(false);
    expect(kojoLabelMentions('CALL NEXT', 'NEXT')).toBe(false);
  });
});

describe('$ 标签重命名 · provider', () => {
  it('resolveRenameLocation：索引未建也能命中标签（返回原词与区间）', async () => {
    const model = modelOf(PATH, TEXT);
    const provider = install(handlersOf(), [model]);
    const hit = await provider.resolveRenameLocation!(model, AT(3, 7), null as never);
    expect(hit).toMatchObject({
      text: 'next',
      range: { startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 11 },
    });
  });

  it('改名只改本函数：定义 + 跳转两处，跨函数同名不动', async () => {
    const model = modelOf(PATH, TEXT);
    const provider = install(handlersOf(), [model]);
    const result = (await provider.provideRenameEdits(model, AT(2, 2), 'LOOP', null as never)) as {
      edits: Monaco.languages.IWorkspaceTextEdit[];
    };
    expect(result.edits).toHaveLength(2);
    expect(
      result.edits.map((e) => [
        e.textEdit.range.startLineNumber,
        e.textEdit.range.startColumn,
        e.textEdit.range.endColumn,
        e.textEdit.text,
      ]),
    ).toEqual([
      [2, 2, 6, 'LOOP'],
      [3, 7, 11, 'LOOP'],
    ]);
    expect(result.edits.every((e) => e.resource === model.uri)).toBe(true);
  });

  it('撞同函数已有标签 ⇒ 整次拒绝（大小写不敏感）', async () => {
    const model = modelOf(PATH, '@F\n$NEXT\n$OTHER\n\tGOTO NEXT\n');
    const provider = install(handlersOf(), [model]);
    const out = (await provider.provideRenameEdits(model, AT(4, 7), 'other', null as never)) as { rejectReason?: string };
    expect(out.rejectReason).toContain('OTHER');
  });

  it('非法名字 / 纯数字 ⇒ 拒绝；只改大小写 ⇒ 放行', async () => {
    const model = modelOf(PATH, TEXT);
    const provider = install(handlersOf(), [model]);
    const bad = (await provider.provideRenameEdits(model, AT(3, 7), 'A-B', null as never)) as { rejectReason?: string };
    expect(bad.rejectReason).toContain('只能用字母');
    const digits = (await provider.provideRenameEdits(model, AT(3, 7), '123', null as never)) as { rejectReason?: string };
    expect(digits.rejectReason).toContain('纯数字');
    const recase = (await provider.provideRenameEdits(model, AT(3, 7), 'NEXT', null as never)) as {
      edits?: unknown[];
    };
    expect(recase.edits).toHaveLength(2);
  });

  it('只读文件 ⇒ 整次拒绝', async () => {
    const model = modelOf(PATH, TEXT);
    const provider = install(handlersOf({ writable: false }), [model]);
    const out = (await provider.provideRenameEdits(model, AT(3, 7), 'LOOP', null as never)) as { rejectReason?: string };
    expect(out.rejectReason).toContain('只读');
  });

  it('.kojo1 糖源里有同名标签写法 ⇒ 整次拒绝（已开标签 / 宿主枚举，路径去重计一份）', async () => {
    const model = modelOf(PATH, TEXT);
    const kojo = kojoModelOf(KOJO, '标签 NEXT\n');
    const provider = install(
      handlersOf({
        kojoSources: async () => [
          { filePath: KOJO, text: '标签 NEXT\n' },
          { filePath: 'C:/p/kojo/b.kojo1', text: '跳到 $NEXT\n' },
        ],
      }),
      [model, kojo],
    );
    const out = (await provider.provideRenameEdits(model, AT(3, 7), 'LOOP', null as never)) as { rejectReason?: string };
    expect(out.rejectReason).toContain('2 份 .kojo 源');
    expect(out.rejectReason).toContain('请先在 .kojo 源里改名');
  });

  it('2.0 的 `.kojo` / `.kojo2` 不在候选里 ⇒ 同名标签写法不再拦下这次改名（ERB-PARITY G7）', async () => {
    const model = modelOf(PATH, TEXT);
    const kojo = kojoModelOf('C:/p/kojo/two.kojo', '标签 NEXT\n');
    const provider = install(
      handlersOf({
        kojoSources: async () => [
          { filePath: 'C:/p/kojo/two.kojo', text: '标签 NEXT\n' },
          { filePath: 'C:/p/kojo/two2.kojo2', text: '跳到 $NEXT\n' },
        ],
      }),
      [model, kojo],
    );
    const out = (await provider.provideRenameEdits(model, AT(3, 7), 'LOOP', null as never)) as {
      rejectReason?: string;
      edits?: unknown[];
    };
    expect(out.rejectReason).toBeUndefined();
    expect(out.edits).toHaveLength(2); // 定义 + 跳转两处照改
  });

  it('.kojo 枚举抛错 ⇒ 整次拒绝（看不见 ≠ 没有）', async () => {
    const model = modelOf(PATH, TEXT);
    const provider = install(
      handlersOf({
        kojoSources: async () => {
          throw new Error('walkDir failed');
        },
      }),
      [model],
    );
    const out = (await provider.provideRenameEdits(model, AT(3, 7), 'LOOP', null as never)) as { rejectReason?: string };
    expect(out.rejectReason).toContain('无法检查 .kojo 源');
  });

  it('跳转目标没有同名标签 / 动态目标 ⇒ 拒绝，绝不按函数名改', async () => {
    const model = modelOf(PATH, '@F\n\tGOTO ALPHA\n\tGOTO (ALPHA)\n');
    const provider = install(
      handlersOf({ byName: new Map([['ALPHA', []]]), refs: null }),
      [model],
    );
    const miss = (await provider.resolveRenameLocation!(model, AT(2, 7), null as never)) as { rejectReason?: string };
    expect(miss.rejectReason).toContain('跳转目标');
    const dynamic = (await provider.provideRenameEdits(model, AT(3, 8), 'BETA', null as never)) as {
      rejectReason?: string;
    };
    expect(dynamic.rejectReason).toContain('跳转目标');
  });

  it('非标签入口照旧走函数索引腿（回归：CALL FOO 能拿到函数改名位置）', async () => {
    const model = modelOf(PATH, '@F\n\tCALL FOO\n');
    const provider = install(handlersOf({ byName: new Map([['FOO', []]]) }), [model]);
    const hit = (await provider.resolveRenameLocation!(model, AT(2, 7), null as never)) as {
      text?: string;
      range?: { startColumn: number; endColumn: number };
    };
    expect(hit.text).toBe('FOO');
    expect(hit.range).toMatchObject({ startColumn: 7, endColumn: 10 });
  });
});

describe('labelRenameRejection · 纯判定', () => {
  const scope = {
    name: 'Next',
    normalizedName: 'NEXT',
    functionStartLine: 1,
    occurrences: [],
    siblingNames: ['OTHER'],
  };
  it('允许只改大小写；撞同函数其它标签（大小写不敏感）拒绝', () => {
    expect(labelRenameRejection(scope, 'NEXT')).toBeNull();
    expect(labelRenameRejection(scope, 'other')).toContain('OTHER');
    expect(labelRenameRejection(scope, '开始')).toBeNull();
  });
});
