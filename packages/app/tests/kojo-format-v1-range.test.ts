/**
 * `.kojo` 区间格式化（`Ctrl+Shift+I`）· 规则开关 / 宿主判据 / 降级上报（批次十三）。
 *
 * 批次十二留下了这个口子：`monaco/entry.ts` 的装配点调用的是**无参**版
 * `installRangeFormatter(monaco)`——没有 `resolve` 判据、规则开关恒为全开（`computeFormatEdits`
 * 第三参缺省）、也没有 `onDegraded` 出口。本文件钉四件事：
 * ① **规则开关与整篇同源**：`request.rules` 两条规则各自关掉后，区间结果 = 插件算整篇后裁行；
 * ② **只改选区行**：整篇判定 + 行区间过滤，选区外一条 edit 都不给；
 * ③ **`resolve` 返回 `null` ⇒ 不应答**（与整篇 `Shift+Alt+F` 同一判据）；
 * ④ **两处让路都不许静默**：`resolve` / `compute` 各自的 `onDegraded` 都收到完整 `notice`。
 *
 * 桩 monaco 口径同 `kojo-enter.test.ts`（只记录注册，不引 Monaco 运行时）。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { computeFormatEdits, type FormatEdit } from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  installRangeFormatter,
  type FormatRuleSwitches,
} from '../src/monaco/kojo-format';
import type { FormatDegradationNotice } from '../src/monaco/kojo-format-range';

const FW = '\u3000';

/**
 * 夹具自证（见 `夹具自证` 用例）：
 * - 第 2 行 4 空格缩进是缩进单位的证据（探测到 SPACE_UNIT）；
 * - 第 3 行两个全角空格缩进 + 台词：**只受 `fullWidthSpace` 影响**（折算成 4 空格；缩进重排
 *   得到同一结果，关掉全角折算则原样保留）；
 * - 第 4 行 2 空格缩进 + 块头：**只受 `indent` 影响**（按单位重排成 4 空格；关掉缩进则一字不动）。
 */
const DOC_LINES = [
  '角色: 12',
  '    时机 指令 310：',
  `${FW}${FW}「呀。」`,
  '  如果 X：',
];
const DOC = DOC_LINES.join('\n');

interface Registered {
  languageId: string;
  provider: Monaco.languages.DocumentRangeFormattingEditProvider;
}

function stubMonaco() {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      registerDocumentRangeFormattingEditProvider(languageId: string, provider: unknown) {
        registered.push({
          languageId,
          provider: provider as Monaco.languages.DocumentRangeFormattingEditProvider,
        });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, registered };
}

/** 可编辑假 model：provider 只用得到语言、全文、行数与最大列 */
function stubModel(lines: readonly string[], languageId = KOJO_LANGUAGE_ID) {
  return {
    getLanguageId: () => languageId,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
  } as unknown as Monaco.editor.ITextModel;
}

const formatOpts = {} as Monaco.languages.FormattingOptions;
const token = {} as Monaco.CancellationToken;
const range = (start: number, end: number) =>
  ({ startLineNumber: start, endLineNumber: end }) as unknown as Monaco.Range;

/** 插件口径的"整篇算 + 按行裁剪"（对照的唯一真源，与 `formatRangeEdits` 对 `.kojo` 等价） */
const wholeClipped = (
  startLine: number,
  endLine: number,
  rules?: FormatRuleSwitches,
): FormatEdit[] =>
  computeFormatEdits(DOC, 'kojo', rules).filter((e) => e.line >= startLine && e.line <= endLine);

const key = (edits: readonly FormatEdit[]): string[] =>
  edits.map((e) => `${e.line}:${e.startColumn}:${e.endColumn}:${e.text}`);

const asEdits = (out: readonly Monaco.languages.TextEdit[]): FormatEdit[] =>
  out.map((e) => ({
    line: e.range.startLineNumber,
    startColumn: e.range.startColumn,
    endColumn: e.range.endColumn,
    text: e.text,
  }));

/** 装一枚 `.kojo` 区间 provider；`rules` 由宿主组请求时填入（与生产 `formatResolve` 同形） */
function install(
  rules?: FormatRuleSwitches,
  extra: { onDegraded?: (n: FormatDegradationNotice) => void } = {},
) {
  const { monaco, registered } = stubMonaco();
  installRangeFormatter(monaco, {
    resolve: (m) => ({ text: m.getValue(), dialect: 'kojo' as const, rules }),
    ...(extra.onDegraded ? { onDegraded: extra.onDegraded } : {}),
  });
  return { provider: registered[0]!.provider, registered };
}

const formatRange = (
  provider: Monaco.languages.DocumentRangeFormattingEditProvider,
  model: Monaco.editor.ITextModel,
  startLine: number,
  endLine: number,
): Monaco.languages.TextEdit[] =>
  provider.provideDocumentRangeFormattingEdits(model, range(startLine, endLine), formatOpts, token) as
    Monaco.languages.TextEdit[];

describe('夹具自证 · 两条规则各自都能改变这一段的结果', () => {
  it('全开时第 3、4 行都改；两个开关各自关掉后都有不同（否则下面的断言不成立）', () => {
    const allOn = wholeClipped(2, 4);
    expect(allOn.map((e) => e.line)).toEqual([3, 4]);
    const noFw = wholeClipped(2, 4, { fullWidthSpace: false });
    const noIndent = wholeClipped(2, 4, { indent: false });
    expect(noFw).not.toEqual(allOn);
    expect(noIndent).not.toEqual(allOn);
    expect(noFw.map((e) => e.line)).toEqual([4]);
    expect(noIndent.map((e) => e.line)).toEqual([3]);
  });
});

describe('① 规则开关与整篇同源', () => {
  it('只注册 `.kojo` 一枚区间 provider', () => {
    const { registered } = install();
    expect(registered.map((r) => r.languageId)).toEqual([KOJO_LANGUAGE_ID]);
  });

  it('关全角折算：区间结果 ≡ 插件算整篇后裁行，且与全开不同', () => {
    const rules: FormatRuleSwitches = { fullWidthSpace: false };
    const { provider } = install(rules);
    const host = key(asEdits(formatRange(provider, stubModel(DOC_LINES), 2, 4)));
    expect(host).toEqual(key(wholeClipped(2, 4, rules)));
    expect(host).not.toEqual(key(wholeClipped(2, 4)));
  });

  it('关缩进：区间结果 ≡ 插件算整篇后裁行，且与全开不同', () => {
    const rules: FormatRuleSwitches = { indent: false };
    const { provider } = install(rules);
    const host = key(asEdits(formatRange(provider, stubModel(DOC_LINES), 2, 4)));
    expect(host).toEqual(key(wholeClipped(2, 4, rules)));
    expect(host).not.toEqual(key(wholeClipped(2, 4)));
  });

  it('两条全关 ⇒ 零 edit（规则开关真的把改写关掉了）', () => {
    const { provider } = install({ fullWidthSpace: false, indent: false });
    expect(formatRange(provider, stubModel(DOC_LINES), 2, 4)).toEqual([]);
  });
});

describe('② 只改选区行', () => {
  it('选区 2–4：结果只含第 3、4 行；选区 2–2 零 edit；返回不带 eol', () => {
    const { provider } = install();
    const model = stubModel(DOC_LINES);
    const out = formatRange(provider, model, 2, 4);
    expect(asEdits(out).map((e) => e.line)).toEqual([3, 4]);
    for (const e of out) expect(e.eol).toBeUndefined();
    expect(formatRange(provider, model, 2, 2)).toEqual([]);
    // 区间倒置按旧口径取 min/max（陈旧坐标不许让命令炸掉）
    expect(asEdits(formatRange(provider, model, 4, 3)).map((e) => e.line)).toEqual([3, 4]);
  });
});

describe('③ resolve 返回 null ⇒ 不应答', () => {
  it('宿主判据说"这份 model 不归我管"：零 edit，规则层不进', () => {
    const { monaco, registered } = stubMonaco();
    const degrade = vi.fn();
    installRangeFormatter(monaco, { resolve: () => null, onDegraded: degrade });
    expect(
      formatRange(registered[0]!.provider, stubModel(DOC_LINES), 2, 4),
    ).toEqual([]);
    expect(degrade).not.toHaveBeenCalled();
  });
});

describe('④ 降级回调被调用（两类让路都不许静默）', () => {
  it('resolve 抛错 ⇒ 空数组 + `where=resolve` 的 notice（回调抛错也不打断编辑）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: FormatDegradationNotice[] = [];
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => {
        throw new Error('judge boom');
      },
      onDegraded: (n) => {
        seen.push(n);
        throw new Error('presentation boom'); // 呈现面抛错不许打断编辑
      },
    });
    expect(
      formatRange(registered[0]!.provider, stubModel(DOC_LINES), 2, 4),
    ).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ where: 'resolve', stage: 'range', startLine: 1, endLine: DOC_LINES.length });
    expect(seen[0]!.reason).toContain('judge boom');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('computeFormatEdits 抛错 ⇒ 空数组 + `where=compute` 的 notice（区间坐标原样带上）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const seen: FormatDegradationNotice[] = [];
    // 字符串接口拿到的是会抛错的文本（`splitPhysical` 的第一趟 ToString 就炸）
    const evil = { toString: () => { throw new Error('text boom'); } } as unknown as string;
    const { monaco, registered } = stubMonaco();
    installRangeFormatter(monaco, {
      resolve: () => ({ text: evil, dialect: 'kojo' as const }),
      onDegraded: (n) => seen.push(n),
    });
    expect(
      formatRange(registered[0]!.provider, stubModel(DOC_LINES), 2, 4),
    ).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ where: 'compute', stage: 'range', startLine: 2, endLine: 4 });
    expect(seen[0]!.reason).toContain('text boom');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
