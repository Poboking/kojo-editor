/**
 * 文档格式化 · 宿主接线（`dialectForLanguage` / `toTextEdits` / `installDocumentFormatter`）单测。
 *
 * 桩 monaco（同 `kojo-definition.test.ts` 口径）：只记录注册与 dispose，不引入真实运行时。
 * 覆盖：(a) 旧桥只挂**没点名 `formatting` 槽腿**的语言（G2 后今天 = `.kojo` 一枚）、dispose 全回收；(b) 语言认不出 / 宿主不应答 ⇒ 零 edits；
 * (c) resolve 抛错 ⇒ 不炸命令；(d) 行号列号过期 ⇒ 夹取；(e) **返回的 edit 一律不带 `eol`**
 * （Monaco 见到 `eol` 就 `model.pushEOL()` 整篇改行尾 —— 这一条是"行尾不许被改"的最后一道闸）。
 */

import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import {
  dialectForLanguage,
  installDocumentFormatter,
  toTextEdits,
  type FormatRequest,
} from '../src/monaco/kojo-format';

interface Registered {
  languageId: string;
  provider: Monaco.languages.DocumentFormattingEditProvider;
}

function stubMonaco() {
  const registered: Registered[] = [];
  const disposed: string[] = [];
  const monaco = {
    languages: {
      registerDocumentFormattingEditProvider(languageId: string, provider: unknown) {
        registered.push({ languageId, provider: provider as Monaco.languages.DocumentFormattingEditProvider });
        return {
          dispose: () => {
            disposed.push(languageId);
          },
        };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, registered, disposed };
}

/** 假 model：够 provider 用（文本 + 语言 + 行列读数），行数由内容算 */
function stubModel(text: string, languageId: string) {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    text,
    languageId,
    getValue: () => text,
    getLanguageId: () => languageId,
    getLineCount: () => lines.length,
    getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
  };
}

const asModel = (m: ReturnType<typeof stubModel>) => m as unknown as Monaco.editor.ITextModel;

describe('dialectForLanguage · 认不认这个语言', () => {
  it('两个受支持的语言 id 各归一种方言', () => {
    expect(dialectForLanguage(KOJO_LANGUAGE_ID)).toBe('kojo');
    expect(dialectForLanguage(ERB_LANGUAGE_ID)).toBe('erb');
  });

  it('其它语言 id ⇒ null（不应答，而不是猜一种规则）', () => {
    expect(dialectForLanguage('plaintext')).toBeNull();
    expect(dialectForLanguage('')).toBeNull();
  });
});

describe('toTextEdits · 形状与陈旧坐标', () => {
  const model = stubModel('甲\n乙丙\n', KOJO_LANGUAGE_ID);

  it('整行替换：range 起止同行、列覆盖全行；不产出 eol 字段', () => {
    const out = toTextEdits(model, [{ line: 2, startColumn: 1, endColumn: 3, text: 'X' }]);
    expect(out).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 3 }, text: 'X' }]);
    expect(out[0]!.eol).toBeUndefined();
  });

  it('行号越界夹进范围内；endColumn 夹到该行的最大列（文本已变短也不越界）', () => {
    const out = toTextEdits(model, [
      { line: 99, startColumn: 1, endColumn: 999, text: 'A' },
      { line: 0, startColumn: 1, endColumn: 999, text: 'B' },
      { line: 2, startColumn: 40, endColumn: 999, text: 'C' },
    ]);
    expect(out.map((e) => [e.range.startLineNumber, e.range.endLineNumber, e.range.endColumn])).toEqual([
      [3, 3, 1],
      [1, 1, 2],
      [2, 2, 3],
    ]);
    // 起点不会跑过终点（Monaco 的 `replaceMove` 拿到倒置区间会静默错位）
    for (const e of out) expect(e.range.startColumn).toBeLessThanOrEqual(e.range.endColumn);
  });

  it('空 edits ⇒ 空数组（无变化就是无变化，不返回一条"整篇重写"）', () => {
    expect(toTextEdits(model, [])).toEqual([]);
  });
});

describe('installDocumentFormatter · 装配与隔离', () => {
  it('旧桥只挂没点名 `formatting` 槽腿的语言（今天 = `.kojo` 一枚）；dispose 全回收', () => {
    // ERB-PARITY G2（2026-10-31）：ERB 的整篇格式化改由**槽腿工厂**挂（descriptor 点名
    // `formatting`），本安装器按 `excludeNamed` 让开——"一门语言一枚 provider"这条判据没变，
    // 变的只是 ERB 那一枚的注册者。ERB 整篇/区间的行为面钉在
    // `erb-format-range-prefix.test.ts`（区间）与 `format-notice-ledger.test.ts`（降级出口），
    // 注册序与枚数钉在 `kojo2-providers.test.ts` 的「注册顺序」组。
    const { monaco, registered, disposed } = stubMonaco();
    const handle = installDocumentFormatter(monaco, { resolve: () => null });
    expect(registered.map((r) => r.languageId)).toEqual([KOJO_LANGUAGE_ID]);
    handle.dispose();
    expect(disposed).toEqual([KOJO_LANGUAGE_ID]);
  });

  it('宿主应答 ⇒ 返回规则层算出的 edits（缩进折半角真的落进 range）', () => {
    const { monaco, registered } = stubMonaco();
    const model = stubModel(`${'　'}甲\n`, KOJO_LANGUAGE_ID);
    installDocumentFormatter(monaco, {
      resolve: (m) => ({ text: m.getValue(), dialect: 'kojo' }) satisfies FormatRequest,
    });
    const out = registered[0]!.provider.provideDocumentFormattingEdits(
      asModel(model),
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.TextEdit[];
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('  甲');
    expect(out[0]!.eol).toBeUndefined();
  });

  it('宿主不应答（null）⇒ 零 edits，连规则层都不进', () => {
    const { monaco, registered } = stubMonaco();
    const model = stubModel('　甲\n', KOJO_LANGUAGE_ID);
    installDocumentFormatter(monaco, { resolve: () => null });
    const out = registered[0]!.provider.provideDocumentFormattingEdits(
      asModel(model),
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    );
    expect(out).toEqual([]);
  });

  it('宿主 resolve 抛错 ⇒ 返回空、只 warn（格式化不许掀桌子）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { monaco, registered } = stubMonaco();
    const model = stubModel('甲\n', ERB_LANGUAGE_ID);
    installDocumentFormatter(monaco, {
      resolve: () => {
        throw new Error('boom');
      },
    });
    const out = registered[0]!.provider.provideDocumentFormattingEdits(
      asModel(model),
      {} as Monaco.languages.FormattingOptions,
      {} as Monaco.CancellationToken,
    );
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
