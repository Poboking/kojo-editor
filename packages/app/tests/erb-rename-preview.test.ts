/**
 * KW-12 · ERB 改名腿的**改动清单上屏**判据（`monaco/erb-rename.ts` 的两个新拍点）。
 *
 * 判据转给解析器插件（`provideRenameTarget` / `provideRename`）⇒ 测的是**真判据**下的清单，
 * 不是第二套假实现。钉六件事：
 * ① 预览拍（`resolveRenameLocation` 命中之后、输入框弹出之前）真的递出逐文件清单，
 *    且**一次盘都不写**（预览是只问不写的一拍）；
 * ② 预览只覆盖方言面 ⇒ `deferred` 为真（糖源腿要读全项目 `.kojo1`，不在这一拍跑）；
 *    标签腿是单文件事实 ⇒ `deferred` 为假（预览就是全表）；
 * ③ 预览面炸了不许带走 F2（抛错 → 一条 warn，求值照旧给原词与区间）；
 * ④ 只读落点的拒绝回执从此**逐条点名**「哪个文件 · 几处」，旧前缀逐字保留；
 * ⑤ 落地拍的读数（闭文件实写 / 编辑器内待应用 / 陈旧 / 散文 / 写失败）与两通道对齐；
 * ⑥ 「已落盘就不再整批取消」这条 W8b 纪律零改动，只是失败从此屏上看得见。
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { EditorSymbolLocation, ErbIndex, ErbReference } from '@kojo/plugin-api';
import { installErbRename, type ErbRenameHandlers } from '../src/monaco/erb-rename';
import { provideRename, provideRenameTarget } from '@kojo/plugin-erb-parser';
import type { RenameLandedInput, RenamePreviewInput } from '../src/ui/rename-preview';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';

const A = 'C:/p/ERB/a.ERB';
const B = 'C:/p/ERB/b.ERB';
const RO = 'D:/game/ERB/c.ERB';
const KOJO1 = 'D:/p/ERH/a.kojo1';

const isDialect = (path: string): boolean => /\.(?:erb|erh|erd)$/i.test(path);

/** 出现点（`kind` 可省：跨语言腿的位置不带分类，进台账的 `unclassified` 桶） */
const ref = (path: string, line: number, column: number, endColumn: number, kind?: ErbReference['kind']): ErbReference =>
  ({ filePath: path, line, column, endColumn, ...(kind === undefined ? {} : { kind }) }) as ErbReference;

const AT = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position;

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

function modelOf(uriPath: string, ...lines: string[]): Monaco.editor.ITextModel {
  return {
    uri: { scheme: 'file', fsPath: uriPath, path: uriPath, toString: () => `file:///${uriPath}` },
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

function installWith(handlers: ErbRenameHandlers): Monaco.languages.RenameProvider {
  const registered: Monaco.languages.RenameProvider[] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (_id: string, provider: Monaco.languages.RenameProvider) => {
        registered.push(provider);
        return { dispose: () => undefined };
      },
    },
    editor: { getModels: () => [] as Monaco.editor.ITextModel[] },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }) },
  } as unknown as typeof Monaco;
  installErbRename(monaco, handlers);
  return registered[0]!;
}

/**
 * 真判据下的 handlers：索引 / 引用集 / 写权限 / 已开标签 / io 通道换成测试数据。
 * `refs: []` + 空 `byName` = 只有 `$` 标签腿能应答（函数索引缺席）。
 */
function realHandlers(opts: {
  refs?: readonly ErbReference[];
  writable: ReadonlySet<string>;
  open?: ReadonlyMap<string, Monaco.editor.ITextModel>;
  kojoLocations?: readonly EditorSymbolLocation[];
  closedWrite?: (path: string) => { applied: number; stale: number; skippedProse?: number };
}): ErbRenameHandlers & { readonly applyToClosedFile: ReturnType<typeof vi.fn> } {
  const index = {
    byName: opts.refs === undefined ? new Map() : new Map([['M_KOJO_A', []]]),
    references: { bySymbol: new Map([['M_KOJO_A', opts.refs ?? []]]) },
  } as unknown as ErbIndex;
  const applyToClosedFile = vi.fn(
    async (path: string): Promise<{ applied: number; stale: number; skippedProse?: number }> =>
      opts.closedWrite?.(path) ?? { applied: 1, stale: 0 },
  );
  return {
    canAnswer: (): boolean => true,
    resolveTarget: (request: Parameters<typeof provideRenameTarget>[1]) =>
      provideRenameTarget(index, request, isDialect),
    resolveRename: (request: Parameters<typeof provideRename>[1]) => provideRename(index, request, isDialect),
    isWritable: (path: string): boolean => opts.writable.has(path),
    openModelFor: (path: string) => opts.open?.get(path),
    applyToClosedFile,
    currentProject: () => null,
    kojoSources: () => (opts.kojoLocations === undefined ? [] : [{ filePath: KOJO1, text: 'CALL M_KOJO_A\n' }]),
    kojoReferences: () => opts.kojoLocations ?? [],
    describeUnwritable: (path: string) => (path === RO ? '落在游戏目录（口上区）' : '写权限未批准'),
  } as unknown as ErbRenameHandlers & { readonly applyToClosedFile: ReturnType<typeof vi.fn> };
}

describe('KW-12 · 预览拍（按下回车之前就有清单）', () => {
  it('求值命中 ⇒ 递出逐文件「几处 / 可不可写 / 开没开标签」，且一次盘都不写', async () => {
    const open = new Map([[A, modelOf(A, '@M_KOJO_A(1)', 'CALL M_KOJO_A')]]);
    const handlers = realHandlers({
      refs: [ref(A, 2, 6, 14), ref(B, 5, 1, 9), ref(RO, 8, 3, 11)],
      writable: new Set([A, B]),
      open,
    });
    const previews: RenamePreviewInput[] = [];
    const provider = installWith({ ...handlers, onRenamePreview: (summary) => previews.push(summary) });
    const prepared = await provider.resolveRenameLocation!(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), TOKEN);
    expect(prepared && 'text' in prepared ? prepared.text : '').toBe('M_KOJO_A');
    expect(previews).toHaveLength(1);
    const summary = previews[0]!;
    expect(summary.oldName).toBe('M_KOJO_A');
    expect(summary.deferred, '函数腿的糖源面没跑，预览必须标 deferred').toBe(true);
    expect(summary.files.map((file) => [file.path, file.occurrences, file.writable, file.opened])).toEqual([
      [A, 1, true, true],
      [B, 1, true, false],
      [RO, 1, false, false],
    ]);
    expect(summary.files.find((file) => file.path === RO)?.reason).toContain('游戏目录');
    expect(handlers.applyToClosedFile, '预览拍写盘 = 把"看得见"变成"已经改了"').not.toHaveBeenCalled();
  });

  it('`$` 标签腿是单文件、函数局部事实 ⇒ 预览就是全表（deferred 为假）', async () => {
    const text = '@F\n$Next\n\tGOTO next\n@G\n$Next\n\tGOTO NEXT\n';
    const handlers = realHandlers({ writable: new Set([A]) });
    const previews: RenamePreviewInput[] = [];
    const provider = installWith({ ...handlers, onRenamePreview: (summary) => previews.push(summary) });
    const prepared = await provider.resolveRenameLocation!(modelOf(A, text), AT(2, 2), TOKEN);
    expect(prepared && 'text' in prepared ? prepared.text : '').toBe('Next');
    expect(previews).toHaveLength(1);
    expect(previews[0]!.deferred, '标签腿没跑糖源判读，但落点本来就只有这一份文件').toBe(false);
    expect(previews[0]!.files.map((file) => [file.path, file.occurrences])).toEqual([[A, 2]]);
  });

  it('预览面抛错 / 无人应答都不许带走 F2', async () => {
    const handlers = realHandlers({ refs: [ref(A, 2, 6, 14)], writable: new Set([A]) });
    const boom = installWith({
      ...handlers,
      onRenamePreview: () => {
        throw new Error('通知中心炸了');
      },
    });
    const prepared = await boom.resolveRenameLocation!(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), TOKEN);
    expect(prepared && 'text' in prepared ? prepared.text : '').toBe('M_KOJO_A');

    const quiet: RenamePreviewInput[] = [];
    const noTarget = installWith({
      ...handlers,
      resolveTarget: () => undefined,
      onRenamePreview: (summary) => quiet.push(summary),
    });
    expect(await noTarget.resolveRenameLocation!(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), TOKEN)).toBeUndefined();
    expect(quiet, '没什么可列的就不发清单（不发空表糊人）').toEqual([]);
  });

  it('没接清单（旧装配 / 桩 handlers）⇒ 行为与改前逐字相同，一次额外问槽都不发生', async () => {
    const handlers = realHandlers({ refs: [ref(A, 2, 6, 14)], writable: new Set([A]) });
    const spy = vi.fn(handlers.resolveRename);
    const provider = installWith({ ...handlers, resolveRename: spy });
    await provider.resolveRenameLocation!(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), TOKEN);
    expect(spy, '没订阅清单就不该为清单多问一趟槽').not.toHaveBeenCalled();
  });
});

describe('KW-12 · 只读落点逐条出声', () => {
  it('拒绝回执点名「哪个文件 · 几处」，旧前缀「n 个文件只读未纳入」逐字保留', async () => {
    const handlers = realHandlers({
      refs: [ref(A, 2, 6, 14), ref(RO, 8, 3, 11), ref(RO, 9, 3, 11)],
      writable: new Set([A]),
    });
    const provider = installWith(handlers);
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(result?.edits).toEqual([]);
    const reason = result && 'rejectReason' in result ? result.rejectReason : '';
    expect(reason).toContain('1 个文件只读未纳入');
    expect(reason).toContain(`'${RO}'（2 处）`);
  });

  it('全或无照旧：只读存在时一次盘都不写（旧纪律零改动）', async () => {
    const handlers = realHandlers({ refs: [ref(A, 2, 6, 14), ref(RO, 8, 3, 11)], writable: new Set([A]) });
    const provider = installWith(handlers);
    await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(handlers.applyToClosedFile).not.toHaveBeenCalled();
  });

  it('糖源面不可写 ⇒ 并进同一个只读计数，并标明它是糖源侧', async () => {
    const handlers = realHandlers({
      refs: [ref(A, 2, 6, 14)],
      writable: new Set([A]),
      kojoLocations: [{ filePath: KOJO1, line: 1, column: 6 }],
    });
    const provider = installWith(handlers);
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(result && 'rejectReason' in result ? result.rejectReason : '').toContain(`'${KOJO1}'（1 处）`);
  });
});

describe('KW-12 · 落地拍的读数', () => {
  it('糖源落点并进同一张表、读数对齐两通道，deferred 转假', async () => {
    const open = new Map([[A, modelOf(A, '@M_KOJO_A(1)', 'CALL M_KOJO_A')]]);
    const handlers = realHandlers({
      refs: [ref(A, 2, 6, 14), ref(B, 5, 1, 9)],
      writable: new Set([A, B, KOJO1]),
      open,
      kojoLocations: [{ filePath: KOJO1, line: 1, column: 6 }],
    });
    const landed: RenameLandedInput[] = [];
    const provider = installWith({ ...handlers, onRenameLanded: (report) => landed.push(report) });
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(result?.rejectReason, landed[0]?.files.map((file) => file.path).join(',')).toBeUndefined();
    expect(landed).toHaveLength(1);
    const report = landed[0]!;
    expect(report.deferred).toBe(false);
    expect(report.newName).toBe('M_KOJO_B');
    expect(report.files.map((file) => file.path)).toEqual([A, B, KOJO1]);
    expect(report.files.map((file) => file.language)).toEqual(['erb', 'erb', 'kojo']);
    // A 在标签里（编辑器内 2 处：定义位 + CALL 位），B 与糖源走 io（各 1 个文件写盘）
    expect(report.tabEdits).toBe((result?.edits ?? []).length);
    expect(report.landedClosedFiles).toBe(2);
    expect(handlers.applyToClosedFile).toHaveBeenCalledTimes(2);
  });

  it('陈旧 / 散文 / 写失败三样从 console 抬到屏上：读数进报告，落地行为一字不动', async () => {
    const open = new Map([[A, modelOf(A, '@M_KOJO_A(1)', 'PRINTFORML M_KOJO_A。')]]);
    const handlers = realHandlers({
      refs: [ref(A, 2, 12, 20, 'mention'), ref(B, 5, 1, 9), ref(B, 6, 1, 9)],
      writable: new Set([A, B]),
      open,
      closedWrite: () => ({ applied: 1, stale: 1, skippedProse: 2 }),
    });
    const landed: RenameLandedInput[] = [];
    const provider = installWith({ ...handlers, onRenameLanded: (report) => landed.push(report) });
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(landed, result && 'rejectReason' in result ? result.rejectReason : '未发报告').toHaveLength(1);
    const report = landed[0]!;
    expect(result?.rejectReason).toBeUndefined();
    expect(report.stale).toBe(1);
    expect(report.proseSkipped).toBe(3); // 标签腿 1 处散文 + 闭文件腿 2 处
    expect(report.failures).toEqual([]);
    // 散文位不落编辑器（台词不是引用）——旧判据零改动
    expect(result?.edits).toHaveLength(0);
  });

  it('闭文件写失败：已有落点 ⇒ 不整批取消（W8b 纪律）但失败逐条进报告', async () => {
    const C = 'D:/game/c.ERB';
    const handlers = realHandlers({
      refs: [ref(B, 5, 1, 9), ref(C, 8, 3, 11)],
      writable: new Set([B, C]),
      closedWrite: (path) => {
        if (path === B) return { applied: 1, stale: 0 };
        throw new Error('写允许域未批准');
      },
    });
    const landed: RenameLandedInput[] = [];
    const provider = installWith({ ...handlers, onRenameLanded: (report) => landed.push(report) });
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(result?.rejectReason).toBeUndefined();
    expect(landed[0]?.failures).toHaveLength(1);
    expect(landed[0]?.failures[0]).toContain('写允许域未批准');
    expect(landed[0]?.landedClosedFiles).toBe(1);
  });

  it('一个都没落 ⇒ 整次拒绝（不静默改一半），此时不发"已落地"报告', async () => {
    const handlers = realHandlers({
      refs: [ref(B, 5, 1, 9)],
      writable: new Set([B]),
      closedWrite: () => {
        throw new Error('写允许域未批准');
      },
    });
    const landed: RenameLandedInput[] = [];
    const provider = installWith({ ...handlers, onRenameLanded: (report) => landed.push(report) });
    const result = await provider.provideRenameEdits(modelOf(A, '@M_KOJO_A(1)'), AT(1, 3), 'M_KOJO_B', TOKEN);
    expect(result?.rejectReason).toContain('未打开文件写入失败');
    expect(landed).toEqual([]);
  });
});
