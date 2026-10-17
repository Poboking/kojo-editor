/**
 * 缺陷① 触发链**过滤自证**（`.kojo` 插值 `{` → 她 → 的 转场）。
 *
 * 用 vendored monaco 0.57 的**真实过滤数学**——`CompletionModel`
 * （`monaco-editor/esm/vs/editor/contrib/suggest/browser/completionModel.js`，包 exports
 * `"./*.js" → "./esm/vs/*.js"` 直引）——复刻 `suggestModel.js:690-697` 的打字重过滤路径：
 * widget 已开时 Monaco 只做 `lineContext = { leadingLineContent, characterCountDelta }`，
 * **不重取词**（新 items 只在 `trigger()` 时经 provider 产出，`suggestModel.js:496`）。
 *
 * (a) **修复前语义**：`{` 当拍供词（名字段 range 起点 = `{` 之后，与真 provider 同形）后，
 *     按 Monaco 口径喂 她 → 的 的 filter 文本流，可见数实测 **2 → 0 → 0**——Incr 重过滤在
 *     空集上原地打转，widget 零候选即关闭 ⇒ 不重触发就是死的；
 * (b) **修复后链路**：`{她的` 当拍由宿主重触发（`shouldTriggerContextSuggest` 在 `的` 上
 *     === true），provider 重新供词（range 起点过 `的` = 名字段起点 col 4）⇒ 变量全量
 *     恢复可见；继续输入 `好`，同一 CompletionModel 的过滤数学仍能滤出候选。
 *
 * provider 轮 = `kojo-completion-variables.ts` 的 `variableCompletionItems`
 * （`kojo-completion.ts:428` 消费的同一枚函数）真实产出；产物只包成**最小 SuggestItem**
 * （字段照 `suggest.js:36-81` 的 `CompletionItem`：`completion / position / editStart /
 * textLabel / labelLow / filterTextLow / isInvalid / provider`），不另造过滤逻辑。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
// vendored contrib 内部模块没有 .d.ts（`monaco.d.ts` 只覆盖公开面）⇒ 类型面无，运行时直吃 ESM 源
// @ts-expect-error TS7016 —— 见上注
import { CompletionModel, LineContext } from 'monaco-editor/editor/contrib/suggest/browser/completionModel.js';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { variableCompletionItems } from '../src/monaco/kojo-completion-variables';
import { shouldTriggerContextSuggest } from '../src/monaco/suggest-context-trigger';

/* ============================== 桩：两枚变量的 schema + 真 provider 轮 ============================== */

/** 合成字典：两枚变量（真名样张：词首都不含 她 / 的——这就是"被过滤光"的复现底料） */
const NAMES: Record<string, VariableInfo[]> = {
  CFLAG: [
    { name: '好感度', index: 2, resolvedIndex: 2, source: 'primary' },
    { name: '泥酔', index: 145, resolvedIndex: 145, source: 'append' },
  ],
};

const schema: VariableSchema = {
  version: '1',
  lookup: () => undefined,
  names: (family) => NAMES[family] ?? [],
};

/** 合成 Monaco：provider 只用到 `CompletionItemKind.Variable`（与 KC-1 单测同款桩） */
const monacoStub = { languages: { CompletionItemKind: { Variable: 4 } } } as unknown as typeof Monaco;

/** kojo 源真实 provide：光标 `column`（1 基）处的插值变量候选轮 */
function provideRound(line: string, column: number): Monaco.languages.CompletionItem[] {
  return variableCompletionItems(
    monacoStub,
    { getLineContent: () => line } as unknown as Monaco.editor.ITextModel,
    { lineNumber: 1, column } as Monaco.Position,
    schema,
  );
}

/** 最小 SuggestItem（形状 = vendor `suggest.js` 的 `CompletionItem` 里被 CompletionModel 读到的字段） */
interface MinimalSuggestItem {
  completion: Monaco.languages.CompletionItem;
  container: { incomplete: boolean };
  provider: object;
  position: { lineNumber: number; column: number };
  editStart: { lineNumber: number; column: number };
  editInsertEnd: { lineNumber: number; column: number };
  editReplaceEnd: { lineNumber: number; column: number };
  isInvalid: boolean;
  textLabel: string;
  labelLow: string;
  filterTextLow: string | undefined;
  sortTextLow: string | undefined;
  score: number[];
  distance: number;
  idx: number;
}

const PROVIDER = { _debugDisplayName: 'kojo-变量', provideCompletionItems: variableCompletionItems };

function asSuggestItems(
  items: readonly Monaco.languages.CompletionItem[],
  atColumn: number,
): MinimalSuggestItem[] {
  return items.map((completion) => {
    const label = typeof completion.label === 'string' ? completion.label : completion.label.label;
    const range = completion.range as Monaco.IRange;
    return {
      completion,
      container: { incomplete: false },
      provider: PROVIDER,
      position: { lineNumber: 1, column: atColumn },
      editStart: { lineNumber: 1, column: range.startColumn },
      editInsertEnd: { lineNumber: 1, column: range.endColumn },
      editReplaceEnd: { lineNumber: 1, column: range.endColumn },
      isInvalid: false,
      textLabel: label,
      labelLow: label.toLowerCase(),
      filterTextLow: typeof completion.filterText === 'string' ? completion.filterText.toLowerCase() : undefined,
      sortTextLow: completion.sortText?.toLowerCase(),
      score: [-100, 0], // FuzzyScore.Default
      distance: 0,
      idx: 0,
    };
  });
}

/** 生产口径的构造参数（`suggestModel.js:496-499`：editor 默认 `filterGraceful` + `matchOnWordStartOnly`） */
function completionModelOf(items: MinimalSuggestItem[], triggerColumn: number, line: string): unknown {
  return new CompletionModel(
    items,
    triggerColumn,
    new LineContext(line, 0), // 触发当拍：delta = ctx.column - this._context.column = 0
    { distance: () => 0 },
    { filterGraceful: true },
    'inline',
    { boostFullMatch: true, firstMatchCanBeWeak: false },
  );
}

const visible = (model: unknown): readonly { textLabel: string }[] =>
  (model as { items: readonly { textLabel: string }[] }).items;

/* ============================== (a) 修复前：只重过滤不重取词 ⇒ 2 → 0 ============================== */

describe('链自证(a) · 旧轮（`{` 供词）被 她→的 过滤到零：不重触发就是死的', () => {
  it('`{|` 供词：range 起点在 `{` 之后（col 2），变量全量 2 枚可见', () => {
    const raw = provideRound('{', 2);
    expect(raw).toHaveLength(2);
    expect(raw.every((i) => (i.range as Monaco.IRange).startColumn === 2)).toBe(true);

    const model = completionModelOf(asSuggestItems(raw, 2), 2, '{');
    expect(visible(model).map((i) => i.textLabel)).toEqual(['好感度', '泥酔']); // 触发当拍不过滤
  });

  it('喂 她 → 的：可见数 2 → 0 → 0（Incr 重过滤在空集上原地打转）', () => {
    const model = completionModelOf(asSuggestItems(provideRound('{', 2), 2), 2, '{') as {
      items: readonly { textLabel: string }[];
      lineContext: unknown;
    };
    expect(model.items).toHaveLength(2);

    model.lineContext = new LineContext('{她', 1); // 模拟输入 `她`（suggestModel.js:694-697 同形）
    expect(model.items).toHaveLength(0);

    model.lineContext = new LineContext('{她的', 2); // 继续输入 `的`
    expect(model.items).toHaveLength(0); // 旧轮死透：range 起点仍钉在 `{` 之后，永远滤不出

    model.lineContext = new LineContext('{她的好', 3); // 就算再敲出一个合词首的 `好`，也回不来
    expect(model.items).toHaveLength(0);
  });
});

/* ============================== (b) 修复后：`{她的` 重触发供词 ⇒ 全量恢复且可过滤 ============================== */

describe('链自证(b) · 在 `{她的` 重触发一轮：变量全量恢复、range 过 `的`、仍可过滤', () => {
  it('重供词轮：range 起点 = 名字段 col 4（过 `的` 之后），2 枚变量全量可见', () => {
    const raw = provideRound('{她的', 4);
    expect(raw).toHaveLength(2);
    expect(raw.every((i) => (i.range as Monaco.IRange).startColumn === 4)).toBe(true);
    expect(raw.every((i) => (i.range as Monaco.IRange).endColumn === 4)).toBe(true);

    const model = completionModelOf(asSuggestItems(raw, 4), 4, '{她的');
    expect(visible(model).map((i) => i.textLabel)).toEqual(['好感度', '泥酔']);
  });

  it('继续输入 `好`：真实过滤数学滤出候选（好感度），泥酔 出局', () => {
    const model = completionModelOf(asSuggestItems(provideRound('{她的', 4), 4), 4, '{她的') as {
      items: readonly { textLabel: string }[];
      lineContext: unknown;
    };
    model.lineContext = new LineContext('{她的好', 1); // `好` 当拍：word = 名字段里的 `好`
    expect(model.items.map((i) => i.textLabel)).toEqual(['好感度']);
  });

  it('触发闸门：`的` 在 `{她的` 当拍 === true（宿主据此重开一轮）', () => {
    expect(
      shouldTriggerContextSuggest({
        languageId: KOJO_LANGUAGE_ID,
        line: '{她的',
        column: 4,
        typedChar: '的',
        hasPath: true,
        readOnly: false,
        derivedView: false,
        focused: true,
        multiCursor: false,
        selectionActive: false,
        widgetVisible: false, // widget 已在 `{她` 处被过滤死（旧轮零候选即关闭）
      }),
    ).toBe(true);
  });
});