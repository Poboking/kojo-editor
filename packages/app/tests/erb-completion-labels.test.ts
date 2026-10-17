/**
 * EC-4 · `.erb` 的 `$标签` 补全（`erbLabelCompletionItems`）单测。
 *
 * 合成 model（无需语料、不引入 Monaco 运行时）：`getValue` 供全文扫标签（未索引时的回退路）、
 * `getLineContent` 供跳转上下文解析。覆盖：`GOTO ` → 本文件全量标签；前缀过滤（含大小写
 * 不敏感）；跳转家族四词 / 全角空白分隔；解析器事实通道（`labelsAt` 数组 ⇒ 作用域收窄、
 * `undefined` ⇒ 全文回退、`[]` ⇒ 零候选）；普通行 / 条件行 / 无标签文件 / 空 model → `[]`
 * （不抛）；`$` 已敲则保留（`insertText` 不重复补 `$`）；替换范围**只覆盖标签名那一段**；
 * `kind` = Reference、排序前缀精确优先。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbFileFactsProvider } from '../src/monaco/completion-core';
import { erbLabelCompletionItems } from '../src/monaco/erb-completion-labels';

/** 合成 Monaco：本纯函数只用到 CompletionItemKind.Reference */
const monaco = { languages: { CompletionItemKind: { Reference: 21 } } } as unknown as typeof Monaco;

function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 全文末尾。`|` 可落在文件任意行。 */
function at(marked: string, facts?: ErbFileFactsProvider): Monaco.languages.CompletionItem[] {
  const marker = marked.indexOf('|');
  const hasCaret = marker >= 0;
  const text = hasCaret ? marked.replace('|', '') : marked;
  const caret = hasCaret ? marker : text.length;
  const before = text.slice(0, caret);
  const lineNumber = before.split('\n').length;
  const lineStart = before.lastIndexOf('\n') + 1;
  const column = caret - lineStart + 1;
  return erbLabelCompletionItems(monaco, modelOf(text), { lineNumber, column } as Monaco.Position, facts);
}

const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] =>
  items.map((i) => i.label as string);

/** facts 桩：只驱动标签三态（数组 / `undefined` / `[]`）；`dimsOf` 与标签补全无关。 */
function factsOf(labelsAt: (path: string, line: number) => readonly string[] | undefined): ErbFileFactsProvider {
  return { dimsOf: () => undefined, labelsAt };
}

/** 三标签样本文件（定义保序：开始 → 招待 → 招架） */
const FILE = '@TEST\n$开始\n\tPRINTL 你好\n\tGOTO 招\n$招待\n\tPRINTL 招待\n$招架\n\tPRINTL 招架';

describe('EC-4 标签补全 · 跳转上下文产出', () => {
  it('`GOTO `（空前缀）→ 本文件全量标签，定义序保持', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tGOTO |')))).toEqual(['开始', '招待', '招架']);
  });

  it('`GOTO 招` → 只留以「招」起头的标签（前缀过滤）', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tGOTO 招|')))).toEqual(['招待', '招架']);
  });

  it('缩进行首 + 别名 `JUMP` 同样出货', () => {
    expect(labels(at(FILE.replace('\tGOTO 招', '\tJUMP 招|')))).toEqual(['招待', '招架']);
  });

  it('替换范围只覆盖标签名段：光标在名字中间 → 吃满整段名字', () => {
    const items = at('@TEST\n$招待\n$招架\nGOTO 招|待');
    expect(labels(items)).toEqual(['招待', '招架']);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 4, endLineNumber: 4, startColumn: 6, endColumn: 8 });
    }
  });
});

describe('EC-4 标签补全 · 跳转家族与空白 / 大小写口径（context 单源判据）', () => {
  it('家族四词（`JUMP` / `GOTO` / `TRYJUMP` / `TRYGOTO`）后都出货', () => {
    for (const kw of ['JUMP', 'GOTO', 'TRYJUMP', 'TRYGOTO']) {
      expect(labels(at(`@TEST\n$甲\n$乙\n\t${kw} 甲|`))).toEqual(['甲']);
    }
  });

  it('全角空白作关键字后分隔（`JUMP\u3000$la|`）同样出货', () => {
    expect(labels(at('@TEST\n$LA\n$lb\n\tJUMP\u3000$la|'))).toEqual(['LA']);
  });

  it('前缀过滤大小写不敏感：小写残片命中大写标签（展示保留原文）', () => {
    expect(labels(at('@TEST\n$Alpha\n$beta\n\tGOTO al|'))).toEqual(['Alpha']);
    expect(labels(at('@TEST\n$Alpha\n$beta\n\tGOTO BE|'))).toEqual(['beta']);
  });

  it('关键字大小写敏感（承接 erbLabelSlot 单源现状）：`goto ` 不产出', () => {
    expect(at('@TEST\n$甲\n\tgoto 甲|')).toEqual([]);
  });
});

describe('EC-4 标签补全 · 作用域收窄（解析器事实通道）', () => {
  // `$B` 在其他函数里：全文扫描可见、解析器事实（函数局部）不应收
  const SCOPED = '@TEST\n$A\n\tPRINTL x\n$B\n\tGOTO |';

  it('`labelsAt` 返回数组 ⇒ 以解析器事实为准（其他函数的 `$B` 不出）', () => {
    expect(labels(at(SCOPED, factsOf(() => ['A'])))).toEqual(['A']);
  });

  it('`labelsAt` 返回 undefined（未索引）⇒ 回退全文扫描（`$B` 可见）', () => {
    expect(labels(at(SCOPED, factsOf(() => undefined)))).toEqual(['A', 'B']);
  });

  it('`labelsAt` 返回 []（已索引确无该项）⇒ 零候选，不回退', () => {
    expect(at(SCOPED, factsOf(() => []))).toEqual([]);
  });

  it('`labelsAt` 收到 model 的 fsPath（回落 `uri.path`）与光标行号', () => {
    const calls: Array<[string, number]> = [];
    const model = {
      ...(modelOf('@TEST\n$A\n\tGOTO ') as unknown as Record<string, unknown>),
      uri: { fsPath: 'C:\\game\\a.ERB', path: '/game/a.ERB' },
    } as unknown as Monaco.editor.ITextModel;
    const items = erbLabelCompletionItems(
      monaco,
      model,
      { lineNumber: 3, column: 7 } as Monaco.Position,
      factsOf((path, line) => {
        calls.push([path, line]);
        return ['A'];
      }),
    );
    expect(labels(items)).toEqual(['A']);
    expect(calls).toEqual([['C:\\game\\a.ERB', 3]]);
  });

  it('path 回落口径：fsPath 缺 / 空 ⇒ `uri.path` ⇒ 无 uri ⇒ 空串', () => {
    const seen: string[] = [];
    const pos = { lineNumber: 3, column: 7 } as Monaco.Position;
    const facts = factsOf((path) => {
      seen.push(path);
      return ['A'];
    });
    const withUri = (uri?: unknown): Monaco.editor.ITextModel =>
      ({
        ...(modelOf('@TEST\n$A\n\tGOTO ') as unknown as Record<string, unknown>),
        ...(uri === undefined ? {} : { uri }),
      }) as unknown as Monaco.editor.ITextModel;
    erbLabelCompletionItems(monaco, withUri({ path: '/game/b.ERB' }), pos, facts);
    erbLabelCompletionItems(monaco, withUri({ fsPath: '', path: '/game/c.ERB' }), pos, facts);
    erbLabelCompletionItems(monaco, withUri(undefined), pos, facts);
    expect(seen).toEqual(['/game/b.ERB', '/game/c.ERB', '']);
  });
});

describe('EC-4 标签补全 · 条目形态', () => {
  it('`kind` = Reference；`insertText` = 名字（不重复补 `$`）；`detail` = 标签（本文件）', () => {
    const [first] = at(FILE.replace('\tGOTO 招', '\tGOTO |'));
    expect(first?.kind).toBe(21);
    expect(first?.insertText).toBe('开始');
    expect(first?.detail).toBe('标签（本文件）');
  });

  it('排序受控：前缀精确匹配优先（同前缀下 `招待` 排 `招待券` 前）', () => {
    const items = at('@TEST\n$招待\n$招待券\nGOTO 招待');
    const byLabel = new Map(items.map((i) => [i.label as string, i]));
    expect(byLabel.get('招待')?.sortText).toBe('0_招待');
    expect(byLabel.get('招待券')?.sortText).toBe('1_招待券');
  });

  it('作者已敲 `$` → `$` 留在替换范围之外（并存不重复）', () => {
    const items = at('@TEST\n$招待\n$招架\nGOTO $招|待');
    expect(labels(items)).toEqual(['招待', '招架']);
    // `GOTO $招待`：`$` 在 0 基 5、名字在 [6,8)；范围只盖名字段（1 基 7→9），`$` 不动
    expect(items[0]?.range).toEqual({ startLineNumber: 4, endLineNumber: 4, startColumn: 7, endColumn: 9 });
    expect(items[0]?.insertText).toBe('招待');
  });
});

/**
 * 可变桩 model（带 `getVersionId`）：记录 `getValue` 调用次数，用于证明按版本记忆化
 * ——热路径（版本不变）**不再重扫全文**。
 */
function mutableModel(initial: string): {
  model: Monaco.editor.ITextModel;
  gets: () => number;
  setText: (t: string) => void;
  bump: () => void;
} {
  let text = initial;
  let version = 1;
  let gets = 0;
  const model = {
    getValue: () => {
      gets++;
      return text;
    },
    getLineContent: (lineNumber: number) => text.split('\n')[lineNumber - 1] ?? '',
    getVersionId: () => version,
  } as unknown as Monaco.editor.ITextModel;
  return { model, gets: () => gets, setText: (t) => (text = t), bump: () => (version += 1) };
}

/** 光标停在全文末尾（末行行尾）：`GOTO ` 末行即跳转上下文，空前缀出全量标签 */
function atEnd(model: Monaco.editor.ITextModel, text: string): Monaco.languages.CompletionItem[] {
  const lines = text.split('\n');
  const last = lines[lines.length - 1] ?? '';
  return erbLabelCompletionItems(monaco, model, {
    lineNumber: lines.length,
    column: last.length + 1,
  } as Monaco.Position);
}

describe('EC-4 标签补全 · 按 model 版本记忆化（SH-3）', () => {
  const V1 = '@TEST\n$甲\n$乙\nGOTO ';
  const V2 = '@TEST\n$甲\n$乙\n$丙\nGOTO ';

  it('版本不变 ⇒ 后续调用不再重扫全文（`getValue` 只调一次），结果一致', () => {
    const { model, gets } = mutableModel(V1);
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    const afterFirst = gets();
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    expect(gets()).toBe(afterFirst); // 缓存命中 ⇒ 未再取全文
  });

  it('版本变化 + 文本变化 ⇒ 重扫并取到新标签（编辑不失真）', () => {
    const { model, gets, setText, bump } = mutableModel(V1);
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    const afterFirst = gets();
    setText(V2);
    bump(); // 作者敲入一行 ⇒ 版本自增
    expect(labels(atEnd(model, V2))).toEqual(['甲', '乙', '丙']);
    expect(gets()).toBe(afterFirst + 1); // 版本变了 ⇒ 重扫一次
  });

  it('`getVersionId` 缺席 ⇒ 退化为每次重扫，结果仍正确（不假定字段存在）', () => {
    const { model, gets } = mutableModel(V1);
    // 抹掉版本号：桩 model 无 `getVersionId`
    delete (model as unknown as Record<string, unknown>).getVersionId;
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    expect(labels(atEnd(model, V1))).toEqual(['甲', '乙']);
    expect(gets()).toBe(2); // 无版本号 ⇒ 每次重扫，绝不误用旧标签
  });
});

describe('EC-4 标签补全 · fail-visible 负例（绝不猜、绝不抛）', () => {
  it('非跳转上下文（普通行 / 条件行）→ []', () => {
    expect(at(FILE.replace('\tPRINTL 你好', '\tPRINTL 你好|'))).toEqual([]);
    expect(at('@TEST\n$开始\n\tIF CFLAG:TARGET:2 >= 500|')).toEqual([]);
    expect(at('@TEST\n$开始\n\tSIF A = 1 : PRINTL x|')).toEqual([]);
  });

  it('无 `$` 标签定义的文件 → []', () => {
    expect(at('@TEST\n\tGOTO |')).toEqual([]);
  });

  it('空 model 的跳转位置 → [] 且不抛', () => {
    expect(() => at('|')).not.toThrow();
    expect(at('|')).toEqual([]);
  });

  it('前缀无命中 → []', () => {
    expect(at(FILE.replace('\tGOTO 招', '\tGOTO 不存在的标签|'))).toEqual([]);
  });

  it('该位置不在跳转后（`GOTO` 后无空白）→ []', () => {
    expect(at('@TEST\n$开始\n\tGOTO|')).toEqual([]);
  });
});
