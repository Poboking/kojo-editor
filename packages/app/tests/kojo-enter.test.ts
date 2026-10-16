/**
 * ZH-D4 回车层级与区间格式化 · 宿主接线单测。
 *
 * 桩 monaco 口径同 `kojo-format.test.ts`（只记录注册与 dispose，不引真实运行时）。
 * 覆盖三条硬判据在宿主面的落点：
 * - ①幂等：provider 连续回车 3 次，新行缩进停在 1 级不漂移；
 * - ②往返：逐次回车得到的文档再走整篇格式化 ⇒ 零 edits（负责口径：formatter 的
 *   「缩进归一」只重排**非规范单位**；回车层恒产 4 空格/TAB 规范单位 ⇒ 两侧无差）；
 * - ③不回退：`onEnterRules`/`indentationRules` 之外零语言配置改动；`保存整理空白` 与
 *   format-on-save 走的 `computeFormatEdits`/`formatText` 不经过本文件任何代码路径；
 * - 大文件：on-type 单次代价只读两行（O(1)），5000 行档实测均值随读数打印。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, sugarEnterIndentAfter, sugarEnterRulePatterns } from '@kojo/plugin-kojo-sugar';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID, registerKojoLanguage } from '../src/monaco/kojo-language';
import { installEnterIndenter, installRangeFormatter } from '../src/monaco/kojo-format';
import { LARGE_FILE_LINES } from '../src/ui/editor-options';

interface Recording {
  range: Array<{ languageId: string; provider: Monaco.languages.DocumentRangeFormattingEditProvider }>;
  onType: Array<{ languageId: string; provider: Monaco.languages.OnTypeFormattingEditProvider }>;
  languageConfig: Record<string, unknown>;
}

function stubMonaco(): { monaco: typeof Monaco; rec: Recording; disposed: string[] } {
  const disposed: string[] = [];
  const rec: Recording = { range: [], onType: [], languageConfig: {} };
  const keep = (id: string) => ({
    dispose: () => {
      disposed.push(id);
    },
  });
  const monaco = {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    languages: {
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: () => [],
      register: () => undefined,
      setMonarchTokensProvider: () => keep('monarch'),
      setLanguageConfiguration: (_id: string, config: Record<string, unknown>) => {
        rec.languageConfig = config;
        return keep('config');
      },
      registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
        rec.range.push({ languageId, provider: provider as Monaco.languages.DocumentRangeFormattingEditProvider });
        return keep(`range:${languageId}`);
      },
      registerOnTypeFormattingEditProvider(languageId: string, provider: unknown) {
        rec.onType.push({ languageId, provider: provider as Monaco.languages.OnTypeFormattingEditProvider });
        return keep(`ontype:${languageId}`);
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, rec, disposed };
}

/** 可编辑假 model：provider 只用到语言、全文与单行读数 */
function stubModel(lines: string[], languageId: string) {
  return {
    lines,
    getLanguageId: () => languageId,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  };
}
const asModel = (m: ReturnType<typeof stubModel>) => m as unknown as Monaco.editor.ITextModel;

/** 走一遍 provider 协议：回车落在 `lineNumber`（1 基）行首 ⇒ 返回编辑后的行首空白 */
function enterOnce(lines: string[], lineNumber: number, languageId = KOJO_LANGUAGE_ID): string[] {
  const { monaco, rec } = stubMonaco();
  installEnterIndenter(monaco);
  const edits = rec.onType[0]!.provider.provideOnTypeFormattingEdits(
    asModel(stubModel(lines, languageId)),
    { lineNumber, column: 1 } as Monaco.Position,
    '\n',
    {} as Monaco.languages.FormattingOptions,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.TextEdit[];
  if (!edits || edits.length === 0) return lines;
  const next = [...lines];
  for (const e of edits) {
    const l = e.range.startLineNumber;
    next[l - 1] = e.text + (next[l - 1] ?? '').slice(e.range.endColumn - 1);
  }
  return next;
}

/**
 * 一次完整回车 = Monaco 先按前行行首空白开新行（keep 行为），provider 再精确归一。
 * 判据①测的是这条**合成链**的不动点，不是 provider 单独的输出。
 */
function pressEnter(lines: string[]): string[] {
  const prev = lines[lines.length - 1] ?? '';
  const kept = prev.match(/^[ \t\u3000]*/)?.[0] ?? '';
  const next = [...lines, kept];
  return enterOnce(next, next.length);
}

describe('语言配置（ZH-D4 增量）', () => {
  it('onEnterRules 已装配且全为 Indent 动作；indentationRules 双向齐备', () => {
    const { monaco, rec } = stubMonaco();
    registerKojoLanguage(monaco);
    const rules = rec.languageConfig['onEnterRules'] as ReadonlyArray<{ beforeText: RegExp; action: { indentAction: number } }>;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThanOrEqual(6);
    for (const r of rules) {
      expect(r.beforeText).toBeInstanceOf(RegExp);
      expect(r.action.indentAction).toBe(1 /* Indent */);
    }
    const ind = rec.languageConfig['indentationRules'] as { increaseIndentPattern: RegExp; decreaseIndentPattern: RegExp };
    expect(ind.increaseIndentPattern.test('时机 指令 310：')).toBe(true);
    expect(ind.decreaseIndentPattern.test('        否则：')).toBe(true);
    // 既有配置零回退：注释符与括号对仍在
    expect(rec.languageConfig['comments']).toEqual({ lineComment: ';' });
    expect(rec.languageConfig['brackets']).toBeTruthy();
  });
});

describe('installRangeFormatter · 选一段只重排那一段', () => {
  it('两个语言 id 各注册一枚；dispose 全回收', () => {
    const { monaco, rec, disposed } = stubMonaco();
    installRangeFormatter(monaco).dispose();
    expect(rec.range.map((r) => r.languageId).sort()).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID].sort());
    expect(disposed.sort()).toEqual([`range:${ERB_LANGUAGE_ID}`, `range:${KOJO_LANGUAGE_ID}`].sort());
  });

  it('整篇判据、区间出手：选区外的行一条 edit 都不给；返回一律不带 eol', () => {
    const { monaco, rec } = stubMonaco();
    installRangeFormatter(monaco);
    const model = stubModel(['角色: 12', '　时机 指令 310：', '　　「呀。」'], KOJO_LANGUAGE_ID);
    const out = rec.range[1]!.provider.provideDocumentRangeFormattingEdits(
      asModel(model),
      { startLineNumber: 3, endLineNumber: 3 } as Monaco.Range,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];
    expect(out.every((e) => e.eol === undefined)).toBe(true);
    expect(out.map((e) => e.range.startLineNumber)).toEqual([3]);
    // 整篇同判据 ⇒ 选全篇时 line2+3 都给
    const all = rec.range[1]!.provider.provideDocumentRangeFormattingEdits(
      asModel(model),
      { startLineNumber: 1, endLineNumber: 3 } as Monaco.Range,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];
    expect(all.map((e) => e.range.startLineNumber)).toEqual([2, 3]);
  });

  it('认不出的语言 ⇒ 零 edits；computeFormatEdits 抛错 ⇒ 空数组 + warn（不掀桌）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, rec } = stubMonaco();
    installRangeFormatter(monaco);
    const provider = rec.range[1]!.provider;
    const foreign = provider.provideDocumentRangeFormattingEdits(
      asModel(stubModel(['x'], 'plaintext')),
      { startLineNumber: 1, endLineNumber: 1 } as Monaco.Range,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    );
    expect(foreign).toEqual([]);
    const boom = {
      getLanguageId: () => KOJO_LANGUAGE_ID,
      getValue: () => {
        throw new Error('boom');
      },
      getLineCount: () => 1,
      getLineMaxColumn: () => 2,
    } as unknown as Monaco.editor.ITextModel;
    expect(provider.provideDocumentRangeFormattingEdits(
      boom,
      { startLineNumber: 1, endLineNumber: 1 } as Monaco.Range,
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    )).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('installEnterIndenter · 判据①幂等 / 判据②往返 / 兜底层缺口', () => {
  it('只给 kojo 语言 id 注册；触发字符 = 回车', () => {
    const { monaco, rec, disposed } = stubMonaco();
    installEnterIndenter(monaco).dispose();
    expect(rec.onType.map((r) => r.languageId)).toEqual([KOJO_LANGUAGE_ID]);
    expect(rec.onType[0]!.provider.autoFormatTriggerCharacters).toEqual(['\n']);
    expect(disposed).toEqual([`ontype:${KOJO_LANGUAGE_ID}`]);
  });

  it('块头回车 ⇒ 行首空白补一个规范单位；非块头 ⇒ 零 edits', () => {
    expect(enterOnce(['时机 指令 310：', ''], 2)).toEqual(['时机 指令 310：', '    ']);
    expect(enterOnce(['    「呀。」', ''], 2)).toEqual(['    「呀。」', '']);
    expect(enterOnce(['如果 X 则 空行：', ''], 2)).toEqual(['如果 X 则 空行：', '']);
    expect(enterOnce(['时机 X：', '「半截正文」'], 2)).toEqual(['时机 X：', '「半截正文」']);
    expect(enterOnce(['时机 X：', ''], 2, ERB_LANGUAGE_ID)).toEqual(['时机 X：', '']);
    expect(enterOnce(['', ''], 1)).toEqual(['', '']);
  });

  it('兜底层补上正则层的已知缺口：块头行尾带 `;` 注释（classifyLine 先剥注释）', () => {
    const line = '时机 指令 310： ;说明';
    expect(sugarEnterRulePatterns().increaseIndentPattern.test(line)).toBe(false); // 同步近似层看不见注释后的冒号
    expect(sugarEnterIndentAfter(line)).toBe('    '); // 精确判定层照常跟进
    expect(enterOnce([line, ''], 2)).toEqual([line, '    ']);
  });

  it('判据①：新建空「时机 …：」连回车 3 次，缩进停在 1 级不漂移', () => {
    let doc = ['时机 指令 310：'];
    for (let i = 0; i < 3; i++) doc = pressEnter(doc);
    expect(doc).toEqual(['时机 指令 310：', '    ', '    ', '    ']);
  });

  it('判据②：逐次回车组装两层块 ⇒ 整篇格式化零 edits（往返逐字节一致）', () => {
    let doc = pressEnter(['时机 指令 310：']);
    doc[doc.length - 1] = '    如果 心情 > 50：';
    doc = pressEnter(doc);
    doc[doc.length - 1] = '        「呀。」';
    expect(doc).toEqual(['时机 指令 310：', '    如果 心情 > 50：', '        「呀。」']);
    // 负责口径：回车恒产规范单位（4 空格/TAB）；formatter「缩进归一」只重排非规范写法
    // ⇒ 对回车产物应零改动（全角折算口径由 formatter 头注第 1 条负责，产物里此处无全角）。
    expect(computeFormatEdits(doc.join('\n'), 'kojo')).toEqual([]);
  });

  it('大文件不击穿（LARGE_FILE_LINES 档）：on-type 单次只读两行，代价与行数无关', () => {
    const lines: string[] = [];
    for (let i = 0; i < LARGE_FILE_LINES; i++) lines.push(i % 7 === 0 ? '时机 指令 310：' : `    「台词${i}」`);
    const model = asModel(stubModel(lines, KOJO_LANGUAGE_ID));
    const { monaco, rec } = stubMonaco();
    installEnterIndenter(monaco);
    const provider = rec.onType[0]!.provider;
    const opts = {} as Monaco.languages.FormattingOptions;
    // 预热 + 1000 次取均值（计时类假红：环境抖动时重跑一次即可）
    for (let i = 0; i < 50; i++) provider.provideOnTypeFormattingEdits(model, { lineNumber: 100, column: 1 } as Monaco.Position, '\n', opts, {} as Monaco.CancellationToken);
    const t0 = performance.now();
    const N = 1000;
    for (let i = 0; i < N; i++) {
      provider.provideOnTypeFormattingEdits(model, { lineNumber: 97 + (i % 6), column: 1 } as Monaco.Position, '\n', opts, {} as Monaco.CancellationToken);
    }
    const avgMs = (performance.now() - t0) / N;
    console.info(`[ZH-D4] on-type 单次均值（${LARGE_FILE_LINES} 行文档）= ${avgMs.toFixed(4)} ms`);
    expect(avgMs).toBeLessThan(1);
  });
});
