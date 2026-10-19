/**
 * G 批 · 补全候选源的**两条缺腿**端到端自证：
 * ① `[[ … ]]`（引擎 rename 写形 / TALENT·CHARA 属性）在 `.kojo` 面上没有任何源供给；
 * ② `#DIM` 声明名被 `.kojo` 与 `.ERB` 两条 seam 同时明写"先不要求"（`dimsOf → undefined`
 *    旧口径 = 零候选不回退）。
 *
 * 验收口径（不是建议）：候选源 / 触发链的改动一律过**真实 Monaco 过滤层**自证——
 * vendored `monaco-editor@0.57.0` 的 `contrib/suggest/browser/completionModel.js` 是弹层
 * 真正跑的那套过滤数学（`filterText` 无匹配即 `continue` 丢候选），桩单测只算半证。
 * widget 已开时继续打字**只对已取回候选重过滤、不重新问 provider**
 * （复刻 `suggestModel.js:690-697` 的 `lineContext` 赋值路径，先例见
 * `kojo-variable-suggest-chain.test.ts` / `kojo-native-completion.test.ts`）。
 *
 * 名槽收口按**候选源 sourceId 白名单**（`KOJO_RENAME_SLOT_SOURCES` /
 * `ERB_GATE_SOURCE_WHITELIST`），不按 kind：同为 `Variable` 的词表声明名、族头、属性名
 * 按 kind 分不开。反面用例两枚各自钉住：`.kojo` 的 `[[` 位里词表整表与 `#DIM` 名一律不出货；
 * `.ERB` 的 `CFLAG:` 变量名槽里 `#DIM` 名不出货（`erb-dim-navigation.ts` 既定：成员访问里的
 * 名字不是 `#DIM` 引用）。
 *
 * 分词也取真实件：桩 model 的 `getWordUntilPosition` 用 vendored `getWordAtText` ×
 * 生产语言配置的 `CJK_WORD_PATTERN`（中文候选的匹配面全靠这一枚词法，自己手搓 ASCII 词法
 * 会把 `[[好` 切错、测出假绿）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { VariableInfo, VariableSchema } from '@kojo/plugin-api';
// vendored 内部模块没有 .d.ts（`monaco.d.ts` 只覆盖公开面）⇒ 类型面无，运行时直吃 ESM 源
// @ts-expect-error TS7016 —— 真实过滤层
import { CompletionModel, LineContext } from 'monaco-editor/editor/contrib/suggest/browser/completionModel.js';
// @ts-expect-error TS7016 —— 真实分词层
import { getWordAtText } from 'monaco-editor/editor/common/core/wordHelper.js';
import {
  KOJO_RENAME_SLOT_SOURCES,
  installKojoCompletion,
  kojoRenameBracketSlotAt,
  type CompletionDegrade,
  type CompletionTables,
} from '../src/monaco/kojo-completion';
import { installErbCompletion } from '../src/monaco/erb-completion';
import { CJK_WORD_PATTERN } from '../src/monaco/word-separators';

/* ============================== 桩（monaco 面 + model 面 + 表） ============================== */

interface Registered {
  provider: Monaco.languages.CompletionItemProvider;
}

function stubMonaco(): { monaco: typeof Monaco; sink: Registered[] } {
  const sink: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: {
        Variable: 1,
        Keyword: 2,
        Operator: 3,
        Function: 4,
        Field: 5,
        Reference: 6,
        EnumMember: 7,
        Property: 8,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (
        _languageId: string,
        provider: Monaco.languages.CompletionItemProvider,
      ): Monaco.IDisposable => {
        sink.push({ provider });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, sink };
}

/** 装一枚生产 `.kojo` provider（`installKojoCompletion` → 装配核唯一实现） */
function kojoProviderOf(
  tables: CompletionTables,
  onDegrade?: (degrade: CompletionDegrade) => void,
): Monaco.languages.CompletionItemProvider {
  const { monaco, sink } = stubMonaco();
  installKojoCompletion(monaco, () => tables, onDegrade);
  return sink[0]!.provider;
}

/** 装一枚生产 `.erb` provider（同一枚装配核、另一本候选册） */
function erbProviderOf(tables: CompletionTables): Monaco.languages.CompletionItemProvider {
  const { monaco, sink } = stubMonaco();
  installErbCompletion(monaco, () => tables);
  return sink[0]!.provider;
}

/**
 * 桩 model：`getValue` / `getLineContent` / `getVersionId`（记忆化判据）+ **真分词**的
 * `getWordUntilPosition`（`TextModel.getWordUntilPosition` 同式：`getWordAtText` ×
 * 语言 `wordPattern`，词尾夹到光标列）。
 */
function modelOf(text: string, fsPath = 'C:/proj/x.kojo'): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  const wordDefinition = () => new RegExp(CJK_WORD_PATTERN.source, 'g');
  return {
    getValue: () => text,
    getVersionId: () => 1,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const word = getWordAtText(pos.column, wordDefinition(), line, 0) as
        | { word: string; startColumn: number; endColumn: number }
        | null;
      if (word === null) return { word: '', startColumn: pos.column, endColumn: pos.column };
      return {
        word: line.slice(word.startColumn - 1, pos.column - 1),
        startColumn: word.startColumn,
        endColumn: pos.column,
      };
    },
    uri: { fsPath },
  } as unknown as Monaco.editor.ITextModel;
}

/** 属性名通道桩：`names(族)` 枚举（主名表 + 追加名表两档；其余族空表 = 不猜） */
const NAMES: Record<string, VariableInfo[]> = {
  CFLAG: [
    { name: '好感度', index: 1088, resolvedIndex: 1088, source: 'primary', description: '角色好感度' },
    { name: '恶意', index: 999, source: 'append' },
  ],
  TALENT: [{ name: '恋慕', index: 10, source: 'primary' }],
};

const schema: VariableSchema = {
  version: 'g-batch',
  lookup: () => undefined,
  names: (family: string) => NAMES[family] ?? [],
} as unknown as VariableSchema;

/** `.kojo` 表桩：属性名通道在手，其余源缺表（缺表 ⇒ 该路零候选 + 可见降级，不影响本批判据） */
const KOJO_TABLES: CompletionTables = {
  variableSchema: schema,
  erbFunctionNames: () => ['M_KOJO_A'],
  wordBasedSuggestions: () => true,
};

const labelText = (label: Monaco.languages.CompletionItem['label']): string =>
  typeof label === 'string' ? label : label.label;
const labels = (items: readonly Monaco.languages.CompletionItem[]): string[] => items.map((i) => labelText(i.label));

function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  lineNumber: number,
  column: number,
  fsPath = 'C:/proj/x.kojo',
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, fsPath),
    { lineNumber, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/* ============================== 真实 CompletionModel 最小件（先例同构） ============================== */

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

const SUGGEST_PROVIDER = { provideCompletionItems: () => undefined };

function asSuggestItems(items: readonly Monaco.languages.CompletionItem[], atColumn: number): MinimalSuggestItem[] {
  return items.map((completion) => {
    const label = labelText(completion.label);
    const range = completion.range as Monaco.IRange;
    return {
      completion,
      container: { incomplete: false },
      provider: SUGGEST_PROVIDER,
      position: { lineNumber: 1, column: atColumn },
      editStart: { lineNumber: 1, column: range.startColumn },
      editInsertEnd: { lineNumber: 1, column: range.endColumn },
      editReplaceEnd: { lineNumber: 1, column: range.endColumn },
      isInvalid: false,
      textLabel: label,
      labelLow: label.toLowerCase(),
      filterTextLow: typeof completion.filterText === 'string' ? completion.filterText.toLowerCase() : undefined,
      sortTextLow: completion.sortText?.toLowerCase(),
      score: [-100, 0],
      distance: 0,
      idx: 0,
    };
  });
}

/** 生产口径的构造参数（`suggestModel.js:496-499`；先例同款） */
function completionModelOf(items: MinimalSuggestItem[], triggerColumn: number, line: string): {
  items: readonly { textLabel: string }[];
  lineContext: unknown;
} {
  return new CompletionModel(
    items,
    triggerColumn,
    new LineContext(line, 0),
    { distance: () => 0 },
    { filterGraceful: true },
    'inline',
    { boostFullMatch: true, firstMatchCanBeWeak: false },
  ) as unknown as { items: readonly { textLabel: string }[]; lineContext: unknown };
}

const visibleLabels = (model: { items: readonly { textLabel: string }[] }): string[] =>
  model.items.map((i) => i.textLabel);

/* ============================== ① `[[` 属性名：位置判据 ============================== */

describe('G① · `[[ … ]]` 名字段判据（纯函数，正反例）', () => {
  // 列（0 基）：如0 果1 空2 T3 A4 L5 E6 N7 T8 :9 [10 [11 好12
  const LINE = '如果 TALENT:[[好';
  it('命中：名字段紧贴 `[[`，range 只覆盖名字段（右侧 `]]` 不被吞）', () => {
    expect(kojoRenameBracketSlotAt(LINE, 13)).toEqual({ start: 12, end: 13, prefix: '好' });
    // 刚敲完 `[[`（空段）也算在位：这一拍正是要看名单的瞬间
    expect(kojoRenameBracketSlotAt('如果 TALENT:[[', 12)).toEqual({ start: 12, end: 12, prefix: '' });
    // 已闭合的 `[[好]]` 里改名 ⇒ 段界仍是名字段
    expect(kojoRenameBracketSlotAt('如果 TALENT:[[好]]', 13)).toEqual({ start: 12, end: 13, prefix: '好' });
  });

  it('不命中：字符串 / 注释 / 单括号 / 括号挂在名字上 / 名字段以数字起（一律不猜）', () => {
    expect(kojoRenameBracketSlotAt('调用 X, "[[好', 11)).toBeNull(); // 串内
    expect(kojoRenameBracketSlotAt('; [[好', 5)).toBeNull(); // 行注释
    expect(kojoRenameBracketSlotAt('如果 TA:[好', 10)).toBeNull(); // 一枚 `[` = 下标不是 rename
    expect(kojoRenameBracketSlotAt('A[[好', 4)).toBeNull(); // `[[` 挂在名字后 = 二维下标写法
    expect(kojoRenameBracketSlotAt('[[[好', 5)).toBeNull(); // 三枚 `[` 不是 rename 形
    expect(kojoRenameBracketSlotAt('[[0]]', 3)).toBeNull(); // 数字起 = 编号，不是属性名
  });
});

/* ============================== ② `[[` 属性名：装配 seam + sourceId 白名单收口 ============================== */

describe('G② · `[[` 位走真实 `.kojo` 装配：属性名出货、名槽按 sourceId 收口', () => {
  const kojo = kojoProviderOf(KOJO_TABLES);
  const OPEN = '如果 TALENT:[[';
  const at = (column: number, text = OPEN) => provide(kojo, text, 1, column);

  it('`如果 TALENT:[[|` ⇒ 属性名全量（与 `{她的…}` 同一枚 `variableSchema.names` 通道）', () => {
    const items = at(OPEN.length + 1);
    // 排序按 UTF-16 码位（`好` < `恋` < `恶`）：主名表两枚 + 追加名表一枚，分层不重名
    expect([...labels(items)].sort()).toEqual(['好感度', '恋慕', '恶意']);
    const hit = items.find((i) => labelText(i.label) === '好感度')!;
    expect(hit.insertText).toBe('好感度');
    // 源侧把匹配面钉在原文（`filterText = 名字`），装配核再补拼音键 ⇒ 交出去的键 = `原文 全拼 首字母`
    expect(hit.filterText).toMatch(/^好感度 /);
    expect(String(hit.filterText)).toContain('hgd');
    expect(hit.detail).toBe('CFLAG:1088'); // 族头原文进 detail：resolve 的回表键就是它
    expect((hit.range as Monaco.IRange).startColumn).toBe(13); // 名字段起点 = `[[` 之后
    expect((hit.range as Monaco.IRange).endColumn).toBe(13);
    expect(hit.kind).toBe(1); // Variable
  });

  it('名槽收口：白名单只有 `kojo-variable`，词表整表 / `#DIM` 名 / 项目函数一条不进 `[[`', () => {
    expect([...KOJO_RENAME_SLOT_SOURCES]).toEqual(['kojo-variable']);
    const text = '#DIM LOCAL_CNT\n如果 LOCAL:[[好';
    const items = provide(kojo, text, 2, 18);
    expect(labels(items)).toContain('好感度');
    // 词表那一路（`如果` 是行首块关键字，本来在 `如果 X` 位整表照供）被本名槽白名单挡下
    expect(labels(items)).not.toContain('如果');
    expect(labels(items)).not.toContain('GETBIT');
    expect(labels(items)).not.toContain('她');
    // 同文件的 `#DIM` 声明名也不进 rename 位（它是"本文件声明名"，不是属性名）
    expect(labels(items)).not.toContain('LOCAL_CNT');
  });

  it('resolve 沿 `kojo-variable` 出处回表：详情带编号 / 说明 / 来源层', () => {
    const items = at(OPEN.length + 1);
    const hit = items.find((i) => labelText(i.label) === '好感度')!;
    const resolved = kojo.resolveCompletionItem!(hit, {} as Monaco.CancellationToken) as Monaco.languages.CompletionItem;
    const doc = (resolved.documentation as { value: string } | undefined)?.value ?? '';
    expect(doc).toContain('编号 `1088`');
    expect(doc).toContain('角色好感度');
    expect(doc).toContain('来源 主名表');
  });

  it('缺通道（无 `variableSchema`）⇒ `[[` 位零候选 + 一次可见降级（不猜名字）', () => {
    const degrades: string[] = [];
    const provider = kojoProviderOf({}, (d) => degrades.push(`${d.sourceId}:${String(d.missing)}`));
    expect(provide(provider, OPEN, 1, OPEN.length + 1)).toEqual([]);
    expect(degrades).toContain('kojo-variable:variableSchema');
  });
});

/* ============================== ③ `[[` 属性名：真实过滤层（继续打字） ============================== */

describe('G③ · `[[` 候选过真实 CompletionModel：打开弹层后继续打字只重过滤', () => {
  const OPEN = '如果 TALENT:[[';
  const column = OPEN.length + 1;
  const provider = kojoProviderOf(KOJO_TABLES);

  function renameModel(): { items: readonly { textLabel: string }[]; lineContext: unknown } {
    return completionModelOf(asSuggestItems(provide(provider, OPEN, 1, column), column), column, OPEN);
  }

  it('触发当拍全量可见；敲下 `好` ⇒ 真实过滤数学只留 好感度（恶意 / 恋慕 出局）', () => {
    const model = renameModel();
    expect([...visibleLabels(model)].sort()).toEqual(['好感度', '恋慕', '恶意']);
    model.lineContext = new LineContext(`${OPEN}好`, 1);
    expect(visibleLabels(model)).toEqual(['好感度']);
    model.lineContext = new LineContext(`${OPEN}好感`, 2);
    expect(visibleLabels(model)).toEqual(['好感度']);
  });

  it('拼音键可用（装配核把 `原文 全拼 首字母` 补进 filterText）：`hg` 滤出 好感度、`lm` 滤出 恋慕', () => {
    const model = renameModel();
    model.lineContext = new LineContext(`${OPEN}hg`, 2);
    expect(visibleLabels(model)).toEqual(['好感度']);
    const again = renameModel();
    again.lineContext = new LineContext(`${OPEN}lm`, 2);
    expect(visibleLabels(again)).toEqual(['恋慕']);
  });

  it('反面：filterText 无匹配 ⇒ Monaco `continue` 丢候选（`zz` 一条不剩，不是"留在弹层里"）', () => {
    const model = renameModel();
    model.lineContext = new LineContext(`${OPEN}zz`, 2);
    expect(visibleLabels(model)).toEqual([]);
  });
});

/* ============================== ④ 反面：台词 / 旁白 / 注释 / 字符串位不弹 ============================== */

describe('G④ · 台词 / 旁白 / 注释 / 字符串位（`.kojo`）两条新腿都不弹', () => {
  const provider = kojoProviderOf(KOJO_TABLES);

  it('注释行 / 纯台词行上的 `[[`：整轮零候选（quickSuggestions 全开也不弹）', () => {
    expect(provide(provider, '; [[好感度', 1, 7)).toEqual([]);
    expect(labels(provide(provider, '如果 TALENT:[[好', 1, 14)).length).toBeGreaterThan(0); // 同文对照：代码位有货
    expect(provide(provider, '[[好', 1, 4)).toEqual([]); // 行首不是语句关键字 ⇒ 台词位
    expect(provide(provider, '灵梦：「[[好', 1, 8)).toEqual([]); // 台词信封行
  });

  it('字符串里的 `[[`：属性名一条不进（同一条代码行、串内判据挡下）', () => {
    const items = provide(provider, '调用 M_KOJO_A, "[[好', 1, 18);
    expect(items.some((i) => ['好感度', '恋慕', '恶意'].includes(labelText(i.label)))).toBe(false);
  });

  it('`#DIM` 名同样守这条门：注释 / 台词位不弹', () => {
    const text = '#DIM LOCAL_CNT\n; 如果 LOCAL';
    expect(provide(provider, text, 2, 12).some((i) => labelText(i.label) === 'LOCAL_CNT')).toBe(false);
    const speech = ['#DIM LOCAL_CNT', '好感度很高 LOCAL'].join('\n');
    expect(provide(provider, speech, 2, 17).some((i) => labelText(i.label) === 'LOCAL_CNT')).toBe(false);
  });
});

/* ============================== ⑤ `#DIM` 声明名：`.kojo` 糖面 ============================== */

describe('G⑤ · `#DIM` 声明名进 `.kojo` 变量候选源（糖面走本文件声明名那一路）', () => {
  const provider = kojoProviderOf(KOJO_TABLES);

  const TEXT = ['#DIM LOCAL_CNT', '#DIM LOCAL_FLAG', '如果 LOC'].join('\n');

  it('引用位弹声明名：前缀命中的那枚置顶，detail 说清是本文件 `#DIM`', () => {
    const items = provide(provider, TEXT, 3, 7);
    expect(labelText(items[0]!.label)).toBe('LOCAL_CNT');
    const hit = items.find((i) => labelText(i.label) === 'LOCAL_FLAG')!;
    expect(hit.detail).toBe('#DIM 声明（本文件）');
    expect(hit.kind).toBe(1); // Variable —— 变量候选源就是这一路
    expect(hit.insertText).toBe('LOCAL_FLAG');
  });

  it('`别名` 在前、`#DIM` 补漏，同名只留一条（先注册者胜，不重复出条目）', () => {
    const text = ['#DIM 心', '#DIM LOCAL_CNT', '别名 心 = 角色 3', '如果 '].join('\n');
    const items = provide(provider, text, 4, 5);
    const 心 = items.filter((i) => labelText(i.label) === '心');
    expect(心).toHaveLength(1);
    expect(心[0]!.detail).toBe('别名（本文件）');
  });

  it('.kojo 原生区（`@` 块内）走 ERB 册同一条腿：`IF CNT` 弹同文件声明名', () => {
    const text = ['@M_KOJO_TEST', '#DIM CNT_B', '    IF CNT'].join('\n');
    const items = provide(provider, text, 3, 13);
    const hit = items.find((i) => labelText(i.label) === 'CNT_B');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('#DIM 声明（本文件）');
  });

  it('真实过滤层：`LOC` 当拍两枚可见，继续打 `AL_CNT` 只留 LOCAL_CNT（不重新问 provider）', () => {
    const column = 7; // `如果 LOC` 之后：词段 `LOC` 起于列 4（真实分词）
    const items = provide(provider, TEXT, 3, column);
    const model = completionModelOf(
      asSuggestItems(items.filter((i) => labelText(i.label).startsWith('LOCAL')), column),
      column,
      '如果 LOC',
    );
    expect([...visibleLabels(model)].sort()).toEqual(['LOCAL_CNT', 'LOCAL_FLAG']);
    model.lineContext = new LineContext('如果 LOCAL_CNT', 6); // 继续敲 6 枚：A L _ C N T
    expect(visibleLabels(model)).toEqual(['LOCAL_CNT']);
  });
});

/* ============================== ⑥ `#DIM` 声明名：`.ERB` seam ============================== */

describe('G⑥ · `#DIM` 声明名在 `.ERB`：未索引 ⇒ 缓冲区；名槽收口不破', () => {
  const provider = erbProviderOf({ variableSchema: schema });
  const erb = (text: string, lineNumber: number, column: number) =>
    provide(provider, text, lineNumber, column, 'C:/proj/ERB/DIM.ERB');

  it('索引没意见（宿主未注入通道）⇒ 缓冲区声明名出货，前缀过滤与置顶按声明原形', () => {
    const text = ['#DIM 心情', '#DIM LOCAL_CNT', 'IF LOC'].join('\n');
    const items = erb(text, 3, 7);
    expect(labelText(items[0]!.label)).toBe('LOCAL_CNT');
    expect(items.some((i) => labelText(i.label) === '心情')).toBe(false); // 前缀不命中 ⇒ 本源不硬塞
    const cjk = erb(['#DIM 心情', '#DIM LOCAL_CNT', 'IF 心'].join('\n'), 3, 5);
    const hit = cjk.find((i) => labelText(i.label) === '心情')!;
    expect(hit.detail).toBe('#DIM 声明（本文件）');
    expect(hit.kind).toBe(1); // Variable —— 变量候选源就是这一路
  });

  it('名槽收口（sourceId 白名单）：`CFLAG:` 变量名槽只认 `erb-variables`，声明名不进', () => {
    const items = erb(['#DIM 心情', 'CFLAG:'].join('\n'), 2, 8);
    expect(labels(items)).toContain('好感度'); // 属性名通道（schema.names）在变量槽出货
    expect(labels(items)).not.toContain('心情'); // 成员访问里的名字不是 `#DIM` 引用（erb-dim-navigation 同口径）
  });

  it('反面：串内 / `;` 注释里的 `#DIM` 名不弹', () => {
    const text = ['#DIM 心情', 'PRINT "心情"'].join('\n');
    expect(erb(text, 2, 9)).toEqual([]); // 列 9 = 引号内（in-string ⇒ 整轮零候选）
    expect(erb(['#DIM 心情', '; 心情'].join('\n'), 2, 3)).toEqual([]); // 注释起头之后
  });

  it('真实过滤层：`LOC` 当拍可见两枚，继续打 `AL_CNT` 只剩 LOCAL_CNT', () => {
    const column = 7; // `IF LOC`：词段 `LOC` 起于列 4
    const items = erb(['#DIM LOCAL_CNT', '#DIM LOCAL_FLAG', 'IF LOC'].join('\n'), 3, column);
    const model = completionModelOf(
      asSuggestItems(items.filter((i) => labelText(i.label).startsWith('LOCAL')), column),
      column,
      'IF LOC',
    );
    expect([...visibleLabels(model)].sort()).toEqual(['LOCAL_CNT', 'LOCAL_FLAG']);
    model.lineContext = new LineContext('IF LOCAL_CNT', 6); // 继续敲 6 枚：A L _ C N T
    expect(visibleLabels(model)).toEqual(['LOCAL_CNT']);
  });
});
