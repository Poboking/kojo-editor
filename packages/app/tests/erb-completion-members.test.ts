/**
 * ERB-COMPLETE-MEMBER · `.erb` 补全的「成员 / 属性 / 函数族」启发式扩展
 * （`erb-completion-members.ts`）单测。
 *
 * 覆盖五块：
 * (a) 成员位判据 `erbMemberSlotAt`：点号成员 / `族:` 字段位 / 裸族头位，以及
 *     `1.5` 小数点、`..`、`(x).`、串内 / 注释内、非法列等一票负例；
 * (b) 候选与**确定度**：族头 = `certain`（`ENGINE_VARIABLE_FAMILIES` 派生，**逐条等于**那张表）、
 *     点号成员 = `heuristic`（两本既有名录：项目函数族 `receiver_*` + 系统函数族 `receiver*`），
 *     模糊排序复用装配核的排名键（前缀精确 > 前缀命中 > 子序列）；
 * (c) **不猜**：字段 / 属性位（`CFLAG:` / `CSTR:` / `TFLAG:`）与查不到成员的族位一律
 *     `items: []` + `uncertain: true` + `ERB_MEMBER_UNCERTAIN_HINT`（"动态语言，仅供参考"）；
 * (d) **装配接线（additive）**：`erb-members` 追加在候选册末尾、`triggerCharacters` 末尾追加 `.`
 *     （不重复）、端到端出货、与既有族头源**合并不重复**（先注册者胜）；
 * (e) **v1 语言面**：`.kojo` model 整轮零动作；性能：**10 万名录热调用** < 1ms（口径见用例）。
 *
 * 桩 monaco / 桩 model 口径照抄 `erb-completion.test.ts`（只实现被走到的面）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { ENGINE_VARIABLE_FAMILIES } from '@kojo/plugin-kojo-sugar';
import type { VariableSchema } from '@kojo/plugin-api';
import type { CompletionTables } from '../src/monaco/completion-core';
import {
  ERB_MEMBER_UNCERTAIN_HINT,
  erbMemberCompletion,
  erbMemberCompletionItems,
  erbMemberSlotAt,
  type ErbMemberCompletionItem,
  type ErbMemberCompletionResult,
} from '../src/monaco/erb-completion-members';
import { ERB_COMPLETION_ASSEMBLY, ERB_COMPLETION_SOURCES, installErbCompletion } from '../src/monaco/erb-completion';
import { erbVariableReferenceSlotAt, erbVariableSlotAt } from '../src/monaco/erb-completion-variables';

/* ============================== 桩 ============================== */

const MONACO = {
  languages: {
    CompletionItemKind: {
      Variable: 4,
      Keyword: 2,
      Operator: 3,
      Function: 1,
      Field: 5,
      Reference: 21,
      EnumMember: 7,
    },
  },
} as unknown as typeof Monaco;

/** 桩 monaco（provider 注册链 + 各 kind 常量；与 `erb-completion.test.ts` 同款） */
function stubMonaco(): {
  monaco: typeof Monaco;
  registered: Array<{ languageId: string; provider: Monaco.languages.CompletionItemProvider }>;
} {
  const registered: Array<{ languageId: string; provider: Monaco.languages.CompletionItemProvider }> = [];
  const monaco = {
    languages: {
      CompletionItemKind: MONACO.languages.CompletionItemKind,
      registerCompletionItemProvider: (
        languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/** 桩 model：`getLineContent` +（可选）`getLanguageId`；`getLanguageId` 可抛错 */
function modelOf(
  line: string,
  languageId?: string | (() => string),
): Monaco.editor.ITextModel {
  const stub: Record<string, unknown> = { getLineContent: () => line };
  if (typeof languageId === 'string') stub.getLanguageId = () => languageId;
  else if (typeof languageId === 'function') stub.getLanguageId = languageId;
  return stub as unknown as Monaco.editor.ITextModel;
}

/** 桩 model（provider 链路：额外复刻 Monaco 默认词法 `getWordUntilPosition`） */
function providerModelOf(line: string, languageId?: string): Monaco.editor.ITextModel {
  const stub: Record<string, unknown> = {
    getLineContent: () => line,
    getValue: () => line,
    getWordUntilPosition: (pos: Monaco.Position) => {
      const m = /[A-Za-z0-9_]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  };
  if (languageId !== undefined) stub.getLanguageId = () => languageId;
  return stub as unknown as Monaco.editor.ITextModel;
}

/** 用 `|` 标记光标（1 基列 = 标记前字符数 + 1）；无标记 = 光标在行尾 */
function run(marked: string, tables: CompletionTables = {}, languageId?: string): ErbMemberCompletionResult {
  const marker = marked.indexOf('|');
  const line = marked.replace('|', '');
  const column = (marker >= 0 ? marker : line.length) + 1;
  return erbMemberCompletion(MONACO, modelOf(line, languageId), { lineNumber: 1, column } as Monaco.Position, tables);
}

const candidates = (marked: string, tables: CompletionTables = {}, languageId?: string): ErbMemberCompletionItem[] =>
  run(marked, tables, languageId).items;

const labelsOf = (items: readonly ErbMemberCompletionItem[]): string[] =>
  items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));

/** 名录桩（同一数组引用 ⇒ 族索引按身份记忆化命中） */
const directoryOf = (names: readonly string[]): CompletionTables => ({ erbFunctionNames: () => names });

/* ============================== (a) 成员位判据 ============================== */

describe('ERB-MEMBER · 点号成员位判据（erbMemberSlotAt）', () => {
  it('`x = y.|` ⇒ member 位：接收者 `y`、片段空、区间 = 点号之后那一段', () => {
    expect(erbMemberSlotAt('x = y.', 7)).toEqual({
      kind: 'member',
      start: 6,
      end: 6,
      prefix: '',
      receiver: 'y',
      receiverStart: 4,
    });
  });

  it('多段接收者（`M_KOJO_K1.|`）照样认出（接收者取点号前整段名字字符）', () => {
    const slot = erbMemberSlotAt('M_KOJO_K1.', 11);
    expect(slot).toMatchObject({ kind: 'member', receiver: 'M_KOJO_K1', receiverStart: 0, prefix: '' });
  });

  it('成员段内（`M_KOJO.K12|`）⇒ 片段 = `K12`，替换范围右界吃满成员段', () => {
    expect(erbMemberSlotAt('M_KOJO.K12', 11)).toMatchObject({ kind: 'member', start: 7, end: 10, prefix: 'K12' });
  });

  it('光标夹在成员段中（`M_KOJO.K|12`）⇒ 片段 = `K`，右界 = 段尾', () => {
    expect(erbMemberSlotAt('M_KOJO.K12', 9)).toMatchObject({ kind: 'member', start: 7, end: 10, prefix: 'K' });
  });

  it('`1.5|` / `12.` ⇒ null（小数点是数值字面量的一部分，不是成员位）', () => {
    expect(erbMemberSlotAt('1.5', 4)).toBeNull();
    expect(erbMemberSlotAt('12.', 4)).toBeNull();
  });

  it('`a..b|` 不是成员位（双点号）；`(x).|` ⇒ null（接收者为空 ⇒ 说不清是哪个族）', () => {
    expect(erbMemberSlotAt('a..b', 5)?.kind).not.toBe('member');
    expect(erbMemberSlotAt('(x).', 5)).toBeNull();
  });

  it('接收者被 sigil 领起（`$TA.|` / `@FOO.|`）⇒ 不是成员位（归标签位 / 定义位）', () => {
    expect(erbMemberSlotAt('GOTO $TA.', 11)).toBeNull();
    expect(erbMemberSlotAt('@FOO.', 6)).toBeNull();
  });

  it('`y|.`（光标在点号之前）⇒ null（成员位在点号之后）', () => {
    expect(erbMemberSlotAt('y.', 2)).toBeNull();
  });

  it('字符串内 / `;` 注释内 ⇒ null（判据 = 位置门的 `in-string`，不另数引号）', () => {
    // 光标停在 `"a.b"` 的串内（`b` 与收尾引号之间）
    expect(erbMemberSlotAt('PRINTL "a.b"', 11)).toBeNull();
    expect(erbMemberSlotAt('; a.b', 6)).toBeNull();
  });

  it('`CFLAG:好|` ⇒ field 位（`族:` 名字段，判据来自 `erbVariableReferenceSlotAt`）', () => {
    expect(erbMemberSlotAt('CFLAG:好', 8)).toMatchObject({ kind: 'field', family: 'CFLAG', prefix: '好' });
  });

  it('`CSTR:名|` / `TFLAG:|` ⇒ field 位（结构层族引用；`CSTR` 不在降糖白名单里也认）', () => {
    expect(erbMemberSlotAt('CSTR:名', 7)).toMatchObject({ kind: 'field', family: 'CSTR', prefix: '名' });
    expect(erbMemberSlotAt('TFLAG:', 7)).toMatchObject({ kind: 'field', family: 'TFLAG', prefix: '' });
  });

  it('`CF|LAG:` ⇒ variable-family 位（光标在族头里；片段 = 已打的 `CF`）', () => {
    expect(erbMemberSlotAt('CFLAG:好', 3)).toMatchObject({ kind: 'variable-family', prefix: 'CF' });
  });

  it('`TFL|` ⇒ variable-family 位；`ZZZ|` ⇒ null（前缀不命中任何引擎族，不认）', () => {
    expect(erbMemberSlotAt('TFL', 4)).toMatchObject({ kind: 'variable-family', prefix: 'TFL' });
    expect(erbMemberSlotAt('ZZZ', 4)).toBeNull();
  });

  it('`@CF|` / `#CF|` ⇒ null（sigil 位归各自的源）', () => {
    expect(erbMemberSlotAt('@CF', 4)).toBeNull();
    expect(erbMemberSlotAt('#CF', 4)).toBeNull();
  });

  it('非法列 / 越界列（0 / NaN / 超长）⇒ null 或夹进线内，不抛', () => {
    expect(erbMemberSlotAt('CF', 0)).toBeNull();
    expect(erbMemberSlotAt('CF', Number.NaN)).toBeNull();
    expect(erbMemberSlotAt('CF', 999)).toMatchObject({ kind: 'variable-family' });
  });
});

/* ============================== (b) 族头候选（certain） ============================== */

describe('ERB-MEMBER · 族头候选（certain，派生自引擎族表）', () => {
  it('`x = CF|` ⇒ CFLAG：confidence=certain / kind=Variable / detail=引擎变量族', () => {
    const [item] = candidates('x = CF|');
    expect(item?.label).toBe('CFLAG');
    expect(item?.insertText).toBe('CFLAG');
    expect(item?.filterText).toBe('CFLAG');
    expect(item?.kind).toBe(MONACO.languages.CompletionItemKind.Variable);
    expect(item?.detail).toBe('引擎变量族');
    expect(item?.confidence).toBe('certain');
  });

  it('`TFL|` ⇒ TFLAG（前缀过滤大小写不敏感）', () => {
    expect(labelsOf(candidates('tfl|'))).toEqual(['TFLAG']);
  });

  it('全表派生：空片段位（`|CF`）⇒ 候选逐条等于 `ENGINE_VARIABLE_FAMILIES`（不手抄第二张表）', () => {
    const all = labelsOf(candidates('|CF'));
    expect(all).toEqual([...ENGINE_VARIABLE_FAMILIES]);
    expect(all.every((l) => ENGINE_VARIABLE_FAMILIES.includes(l))).toBe(true);
  });

  it('排序受控：前缀精确优先（`cflag|` ⇒ `0_` 档；`C|` 的命中项 ⇒ `1_` 档）', () => {
    expect(candidates('cflag|')[0]?.sortText).toBe('0_CFLAG');
    const byLabel = new Map(candidates('C|').map((i) => [i.label as string, i]));
    expect(byLabel.get('CFLAG')?.sortText).toBe('1_CFLAG');
    expect(byLabel.get('CALLNAME')?.sortText).toBe('1_CALLNAME');
  });

  it('替换范围只覆盖族头名字段（`PRINTFORML CF|LAG` ⇒ 列 12..17）', () => {
    const items = candidates('PRINTFORML CF|LAG');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 12, endColumn: 17 });
    }
  });

  it('`ZZZ|` ⇒ 空结果 + `uncertain: false`（不是成员位就没有"不确定"可言）', () => {
    expect(run('ZZZ|')).toEqual({ items: [], slot: null, uncertain: false });
  });
});

/* ============================== (b) 点号成员候选（heuristic） ============================== */

const M_KOJO = ['M_KOJO_A', 'M_KOJO_B', 'OTHER_FN'] as const;

describe('ERB-MEMBER · 点号成员候选（heuristic，名录同族 + 模糊排序）', () => {
  it('`M_KOJO.|` ⇒ 项目函数族 `M_KOJO_*` 的两名成员（OTHER_FN 不进面）', () => {
    expect(labelsOf(candidates('M_KOJO.|', directoryOf(M_KOJO)))).toEqual(['M_KOJO_A', 'M_KOJO_B']);
  });

  it('条目形态：confidence=heuristic / kind=Function / insertText=完整名 / filterText=族后缀', () => {
    const [first] = candidates('M_KOJO.|', directoryOf(M_KOJO));
    expect(first?.confidence).toBe('heuristic');
    expect(first?.kind).toBe(MONACO.languages.CompletionItemKind.Function);
    expect(first?.insertText).toBe('M_KOJO_A');
    expect(first?.filterText).toBe('A'); // 作者在点号之后继续打的是这一段
    expect(first?.detail).toBe('函数族成员（M_KOJO）');
    expect((first?.documentation as { value: string } | undefined)?.value).toContain('点号成员推断');
  });

  it('替换范围连接收者一起覆盖：`M_KOJO.|` ⇒ 列 1..8（落字为完整函数名，不留点号语法）', () => {
    const items = candidates('M_KOJO.|', directoryOf(M_KOJO));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.range).toEqual({ startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 8 });
    }
  });

  it('多段接收者按最长族键查：`M_KOJO_K1.|` 只出 K1 那一支', () => {
    const names = ['M_KOJO_K1_HATSUMI', 'M_KOJO_K2_HATSUMI', 'M_KOJO_K1_TAIDO'];
    expect(labelsOf(candidates('M_KOJO_K1.|', directoryOf(names)))).toEqual(['M_KOJO_K1_HATSUMI', 'M_KOJO_K1_TAIDO']);
  });

  it('系统函数族（既有反向表）同法：`GET.|` ⇒ `GET*` 成员（含 GETBIT / GETTIME），confidence 仍 heuristic', () => {
    const items = candidates('GET.|');
    const labels = labelsOf(items);
    expect(labels).toContain('GETBIT');
    expect(labels).toContain('GETTIME');
    expect(items.every((i) => i.confidence === 'heuristic')).toBe(true);
    expect(items.every((i) => i.kind === MONACO.languages.CompletionItemKind.Function)).toBe(true);
  });

  it('单字母接收者不认系统函数族（`G.|` 不把整张系统函数表抖进候选）⇒ uncertain', () => {
    const result = run('G.|');
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
  });

  it('模糊排序：族后缀精确 > 前缀命中 > 子序列（排名键与装配核同一份）', () => {
    const names = ['M_KOJO_KJ', 'M_KOJO_KOJO', 'M_KOJO_A1'];
    const items = candidates('M_KOJO.KJ|', directoryOf(names));
    expect(labelsOf(items)).toEqual(['M_KOJO_KJ', 'M_KOJO_KOJO']);
    expect(items[0]?.sortText?.startsWith('0|')).toBe(true); // 后缀精确
    expect(items[1]?.sortText?.startsWith('2a|')).toBe(true); // 原文子序列（K…J）
  });

  it('前缀命中（非精确）排在子序列之前：`M_KOJO.K|` ⇒ `KJ` 先于 `KOJO`', () => {
    const names = ['M_KOJO_KOJO', 'M_KOJO_KJ'];
    const items = candidates('M_KOJO.K|', directoryOf(names));
    expect(labelsOf(items)[0]).toBe('M_KOJO_KJ'); // 两条都是前缀命中，按名序 KJ < KOJO
    expect(items.every((i) => i.sortText?.startsWith('1|'))).toBe(true);
  });

  it('与已输入片段无关的族成员不进面（片段 `ZZ` ⇒ 零候选 + uncertain）', () => {
    const result = run('M_KOJO.ZZ|', directoryOf(M_KOJO));
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
  });

  it('成员即接收者本身不算成员（`GETBIT.|` ⇒ 不把 GETBIT 自己当成员）', () => {
    expect(labelsOf(candidates('GETBIT.|'))).toEqual([]);
  });
});

/* ============================== (c) 不猜：字段 / 属性位 ============================== */

describe('ERB-MEMBER · 字段 / 属性位无静态数据 ⇒ 零候选 + uncertain', () => {
  it('`CFLAG:|` ⇒ field 位、零候选、uncertain=true、提示文案含「动态语言，仅供参考」', () => {
    const result = run('CFLAG:|');
    expect(result.slot).toMatchObject({ kind: 'field', family: 'CFLAG' });
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
    expect(result.uncertainHint).toBe(ERB_MEMBER_UNCERTAIN_HINT);
    expect(ERB_MEMBER_UNCERTAIN_HINT).toContain('动态语言，仅供参考');
  });

  it('`CFLAG:好感|` / `TFLAG:|`（引擎族）同样是动态名字段 ⇒ uncertain', () => {
    expect(run('CFLAG:好感|').uncertain).toBe(true);
    expect(run('TFLAG:|').uncertain).toBe(true);
  });

  it('`CSTR:名|`（不在降糖白名单里的引擎族）⇒ 结构层照样认出字段位 ⇒ uncertain', () => {
    const result = run('CSTR:名|');
    expect(result.slot).toMatchObject({ kind: 'field', family: 'CSTR' });
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
  });

  it('点号成员位查不到族成员（`y.|` 无名录）⇒ 零候选 + uncertain（不编字段名）', () => {
    const result = run('y.|');
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
  });

  it('接收者是引擎族（`CFLAG.|`）⇒ 索引名是 adapter 动态数据 ⇒ 不猜', () => {
    const result = run('CFLAG.|', directoryOf(M_KOJO));
    expect(result.items).toEqual([]);
    expect(result.uncertain).toBe(true);
  });

  it('族头必须是标识符形：`PRINTFORML 1:|` ⇒ 不是族引用（编号 / 表达式尾部不猜）', () => {
    expect(erbMemberSlotAt('PRINTFORML 1:', 14)).toBeNull();
  });

  it('名录缺席 / 空数组 / 提供者抛错 ⇒ 零候选 + uncertain，且不抛', () => {
    expect(run('M_KOJO.|').items).toEqual([]);
    expect(run('M_KOJO.|', directoryOf([])).uncertain).toBe(true);
    const throwing: CompletionTables = {
      erbFunctionNames: () => {
        throw new Error('索引在途');
      },
    };
    expect(() => run('M_KOJO.|', throwing)).not.toThrow();
    expect(run('M_KOJO.|', throwing).uncertain).toBe(true);
  });
});

/* ============================== (b) 确定度契约 ============================== */

describe('ERB-MEMBER · 确定度标注（additive 可选字段）', () => {
  it('每条候选都带 confidence ∈ {certain, heuristic}；族头恒 certain、成员恒 heuristic', () => {
    const family = candidates('CF|');
    const members = candidates('M_KOJO.|', directoryOf(M_KOJO));
    expect(family.length).toBeGreaterThan(0);
    expect(members.length).toBeGreaterThan(0);
    expect(family.every((i) => i.confidence === 'certain')).toBe(true);
    expect(members.every((i) => i.confidence === 'heuristic')).toBe(true);
  });

  it('旧消费方零改动：候选仍是结构完整的 `CompletionItem`（label/kind/insertText/range/sortText）', () => {
    const [item] = candidates('CF|');
    const asCompletionItem: Monaco.languages.CompletionItem = item!;
    expect(asCompletionItem.label).toBe('CFLAG');
    expect(asCompletionItem.kind).toBeDefined();
    expect(asCompletionItem.insertText).toBe('CFLAG');
    expect(asCompletionItem.range).toBeDefined();
    expect(asCompletionItem.sortText).toBeDefined();
  });

  it('`erbMemberCompletionItems` = 纯 API 的 `items`（薄翻译，uncertain 留在纯 API 面）', () => {
    const viaItems = erbMemberCompletionItems(MONACO, modelOf('CF'), { lineNumber: 1, column: 3 } as Monaco.Position, {});
    expect(labelsOf(viaItems)).toEqual(['CFLAG']);
    expect(viaItems[0]?.confidence).toBe('certain');
  });
});

/* ============================== (e) v1 语言面 ============================== */

describe('ERB-MEMBER · v1 语言面（只认 `.erb`；`.kojo` 整轮零动作）', () => {
  it('`.kojo` model 在点号成员位 ⇒ 零动作（items 空 / slot null / uncertain false）', () => {
    expect(run('M_KOJO.|', directoryOf(M_KOJO), 'kojo')).toEqual({ items: [], slot: null, uncertain: false });
  });

  it('`.kojo` model 在族头位同样零动作（v1 不跨语言面）', () => {
    expect(run('CF|', {}, 'kojo')).toEqual({ items: [], slot: null, uncertain: false });
  });

  it('`.erb` 语言面（`kojo-erb`）照常出货；桩 model 无 `getLanguageId` 时也不拦（纯函数可单测）', () => {
    expect(labelsOf(candidates('CF|', {}, 'kojo-erb'))).toEqual(['CFLAG']);
    expect(labelsOf(candidates('CF|'))).toEqual(['CFLAG']);
  });

  it('`getLanguageId` 抛错的脏 model ⇒ 不抛、按 `.erb` 处理（脏取值不该让补全整条沉默）', () => {
    const dirty = modelOf(
      'CF',
      () => {
        throw new Error('坏编辑器');
      },
    );
    const result = erbMemberCompletion(MONACO, dirty, { lineNumber: 1, column: 3 } as Monaco.Position, {});
    expect(labelsOf(result.items)).toEqual(['CFLAG']);
  });
});

/* ============================== (d) 装配接线（additive） ============================== */

/** 走 provider 取一轮候选（桩 model 带 `getWordUntilPosition`） */
function provide(
  provider: Monaco.languages.CompletionItemProvider,
  line: string,
  column: number,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    providerModelOf(line),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

describe('ERB-MEMBER · 装配接线（追加一个源 + 追加一枚触发字符，零改动既有口径）', () => {
  it('`erb-members` 追加在候选册**最末**；既有十源顺序逐字未动', () => {
    expect(ERB_COMPLETION_SOURCES.map((s) => s.id)).toEqual([
      'erb-snippet',
      'erb-directives',
      'erb-variables',
      'erb-functions',
      'erb-labels',
      'erb-system-functions',
      'erb-bits',
      'erb-families',
      'erb-declared',
      'erb-words',
      'erb-members',
    ]);
    expect(ERB_COMPLETION_SOURCES[ERB_COMPLETION_SOURCES.length - 1]!.id).toBe('erb-members');
    expect(ERB_COMPLETION_SOURCES.find((s) => s.id === 'erb-members')!.requires).toBeUndefined();
  });

  it('`triggerCharacters` = 既有四枚 + 末尾一枚 `.`（不重复、既有次序不变）', () => {
    expect(ERB_COMPLETION_ASSEMBLY.triggerCharacters).toEqual(['#', '[', '@', '$', '.']);
    expect(ERB_COMPLETION_ASSEMBLY.triggerCharacters.filter((c) => c === '.')).toHaveLength(1);
  });

  it('端到端：provider 在 `M_KOJO.|` **只**出成员候选（点号位整轮只留成员源，系统函数整表不混入）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => directoryOf(M_KOJO));
    const items = provide(registered[0]!.provider, 'M_KOJO.', 8);
    const labels = items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    expect(labels.sort()).toEqual(['M_KOJO_A', 'M_KOJO_B']);
    const hit = items.find((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'M_KOJO_A');
    expect(hit).toBeDefined();
    expect((hit as ErbMemberCompletionItem).confidence).toBe('heuristic');
    expect(hit!.insertText).toBe('M_KOJO_A');
  });

  it('点号位若不在成员位（`1.|` 小数点）⇒ 整轮零候选（不弹系统函数整表）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    expect(provide(registered[0]!.provider, '1.', 3)).toEqual([]);
    expect(provide(registered[0]!.provider, 'PRINTFORML 1.', 14)).toEqual([]);
    // `$标签.` / `@函数.` 的接收者被 sigil 领起 ⇒ 不是成员位 ⇒ 同样零候选
    expect(provide(registered[0]!.provider, 'GOTO $TA.', 11)).toEqual([]);
    expect(provide(registered[0]!.provider, '@FOO.', 6)).toEqual([]);
  });

  it('端到端：`CFLAG:|` 仍归 `erb-variables`（位置门白名单把成员源整路滤掉，字段位不抢候选）', () => {
    const schema = {
      version: 't',
      lookup: () => undefined,
      names: (family: string) => (family === 'CFLAG' ? [{ name: '好感度', index: 1088 }] : []),
    } as unknown as VariableSchema;
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({ variableSchema: schema }));
    const labels = provide(registered[0]!.provider, 'CFLAG:', 7).map((i) =>
      typeof i.label === 'string' ? i.label : i.label.label,
    );
    expect(labels).toEqual(['好感度']);
  });

  it('与既有族头源**合并不重复**：行中 `CF|` 只留一条 CFLAG，出处仍是 `erb-families`（先注册者胜）', () => {
    const { monaco, registered } = stubMonaco();
    installErbCompletion(monaco, () => ({}));
    // 行中位（`PRINTFORML CF`）：行首位先由 `erb-directives` 的 `CFLAG` 指令词占住先注册位，
    // 那里比的是另一条既有语义；本源与 `erb-families` 的重合要在族头位上看
    const items = provide(registered[0]!.provider, 'PRINTFORML CF', 14);
    const hits = items.filter((i) => (typeof i.label === 'string' ? i.label : i.label.label) === 'CFLAG');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.detail).toBe('引擎族头');
  });
});

/* ============================== 结构层探针导出（字段位判据的单源） ============================== */

describe('ERB-MEMBER · 字段位判据单源（`erbVariableReferenceSlotAt` = 同一个段解析器）', () => {
  it('结构层认任何 `族:名`（不核对白名单）：`CSTR:` / `EX:` 有意见，白名单探针则 null', () => {
    expect(erbVariableReferenceSlotAt('CSTR:名', 7)).toMatchObject({ family: 'CSTR', prefix: '名' });
    expect(erbVariableReferenceSlotAt('CFLAG:', 7)).toMatchObject({ family: 'CFLAG', prefix: '' });
    expect(erbVariableSlotAt('CSTR:名', 7)).toBeNull(); // 候选侧仍只补白名单族（未改动）
  });

  it('结构层同样不认：无冒号 / 数字开头 / 四段式 / 非法列', () => {
    expect(erbVariableReferenceSlotAt('CFLAG', 6)).toBeNull();
    expect(erbVariableReferenceSlotAt('CFLAG:12', 9)).toBeNull();
    expect(erbVariableReferenceSlotAt('CFLAG:TARGET:ABL:', 18)).toBeNull();
    expect(erbVariableReferenceSlotAt('CFLAG:', 0)).toBeNull();
  });
});

/* ============================== (e) 性能：10 万名录热调用 ============================== */

/**
 * 口径（写清，别照着抄数字）：
 * - **名录**：10 万条合成名，200 个族 × 每族 500 条（`FAM000_M000` 形态；族 = 首个 `_` 之前 + `_`），
 *   总量与 `completion-perf.test.ts` 的 99k 档同一量级，族规模与真实项目同量级；
 * - **热调用**：同一声明录**数组引用**上（生产侧 = `memoizedErbFunctionNames` 按指纹返回同一数组）
 *   的单次 `erbMemberCompletion`；位置 = `FAM007.M1|`。
 *
 * 本文件**刻意不量墙钟**（墙钟预算用例由 `tools/perf-suite.mjs` 自动分池到串行静默池，
 * `pnpm test:perf` 才跑）：这里钉**与总量无关**的三条算法性质，毫秒读数在同批的
 * `erb-completion-members.perf.test.ts`（口径同上，读 10 万名录热调用 < 1ms）。
 */
describe('ERB-MEMBER · 10 万名录：与总量无关的三条算法性质（墙钟读数在 .perf 同批文件）', () => {
  /** 200 族 × 500 条的合成名录（`FAM000_M000` … `FAM199_M499`） */
  function bigDirectory(families = 200, perFamily = 500): string[] {
    const out: string[] = [];
    for (let f = 0; f < families; f++) {
      for (let m = 0; m < perFamily; m++) {
        out.push(`FAM${String(f).padStart(3, '0')}_M${String(m).padStart(3, '0')}`);
      }
    }
    return out;
  }

  it('族键查找只看族规模：同族成员在 10 万名录里照样一次点到，且不越族', () => {
    const names = bigDirectory();
    expect(names).toHaveLength(100_000);
    const items = run('FAM007.M1|', directoryOf(names)).items;
    expect(items.length).toBeGreaterThan(0);
    const labels = labelsOf(items);
    expect(labels.every((l) => l.startsWith('FAM007_'))).toBe(true);
    expect(labels).toContain('FAM007_M100');
    expect(labels).not.toContain('FAM008_M100');
  });

  it('族索引按**数组身份**记忆化（与前缀索引同一纪律）：同一数组追加内容不重建，换新数组才重建', () => {
    const names = bigDirectory();
    expect(labelsOf(run('FAM007.|', directoryOf(names)).items)).not.toContain('FAM007_M999');
    names.push('FAM007_M999'); // 原地改：数组身份不变 ⇒ 族索引不重建（保守复用）
    expect(labelsOf(run('FAM007.|', directoryOf(names)).items)).not.toContain('FAM007_M999');
    expect(labelsOf(run('FAM007.|', directoryOf([...names])).items)).toContain('FAM007_M999');
  });

  it('单源上限护栏 = `MAX_NAME_CANDIDATES`（族再大也不逐条造对象；与 erb-functions 同一口径）', () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `FAM007_M${String(i).padStart(4, '0')}`);
    const items = run('FAM007.|', directoryOf(huge)).items;
    expect(items).toHaveLength(1000);
  });

  it('候选与名录**总量**无关：同族、不同总量的两本名录给出同一份结果', () => {
    const small = ['FAM007_M000', 'FAM007_M001', 'FAM007_M002'];
    const big = [...small, ...Array.from({ length: 5000 }, (_, i) => `FAM999_X${String(i).padStart(4, '0')}`)];
    const smallLabels = labelsOf(run('FAM007.M|', directoryOf(small)).items);
    const bigLabels = labelsOf(run('FAM007.M|', directoryOf(big)).items);
    expect(smallLabels).toHaveLength(3);
    expect(bigLabels).toEqual(smallLabels);
  });
});
