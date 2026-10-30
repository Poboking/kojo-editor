/**
 * LAU-4 补全腿第三批 · **候选逐字对拍**（2026-10-31）。
 *
 * ## 这一格钉的是什么
 *
 * 判据搬到常驻插件 `@kojo/plugin-erb-parser` 之后，`.erb` 的候选取自插件的
 * `provideErbCompletion`（经槽 `ui.editor.languageService` 作答）而不是宿主自装配的那一册。
 * 本文件把**两本册**放在同一张桌上：左边 = 搬前的宿主装配（`ERB_COMPLETION_ASSEMBLY`，
 * 仍为 `.kojo1` 原生区服务，所以搬前实现原地可对拍），右边 = 插件供方 + 宿主翻译层
 * （`toMonacoCompletionItems`，与共享槽腿同一枚）——同一文本 / 位置 / 事实输入下，
 * **label / insertText / kind / sortText / filterText / 条数**必须逐条相等（顺序即排名）。
 *
 * ## 覆盖
 *
 * 标签 `$` / `#DIM` 声明名 / 变量族与三段式末段 / 成员位 / 系统函数 / 指令词表（行首与行中）/
 * 文档词 / 项目函数（定义位与调用位）/ 括号调用骨架；**上下文抑制**：注释行、字符串内、
 * 未闭合插值；以及前缀收窄、去重（同名先见者胜）与截断后的相对次序。
 *
 * 假 Monaco 只给补全用到的那几格（图标枚举按 0.57 的真实数值，两侧同表 ⇒ 图标可比）。
 */
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  EditorCompletionItem,
  EditorCompletionFacts,
  KojoCallProtocol,
  KojoInstructionTable,
  VariableSchema,
} from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { provideErbCompletion } from '@kojo/plugin-erb-parser';
import { ERB_COMPLETION_ASSEMBLY } from '../src/monaco/erb-completion';
import { ERB_DIRECTIVES } from '../src/monaco/erb-directives';
import { mergeDirectiveWords } from '../src/monaco/erb-language';
import { createCompletionProvider, type CompletionTables } from '../src/monaco/completion-core';
import { toMonacoCompletionItems } from '../src/monaco/slot-service-providers';

/* ============================== 桩 ============================== */

/** Monaco 0.57 的 `CompletionItemKind` 数值（两侧读同一张表；只列会出现的档） */
const KINDS = {
  Function: 1,
  Field: 3,
  Variable: 4,
  Struct: 6,
  Module: 8,
  Event: 10,
  Operator: 11,
  Value: 13,
  Constant: 14,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Text: 18,
  Reference: 21,
  Snippet: 27,
};

function stubMonaco(): typeof Monaco {
  const monaco = {
    languages: {
      CompletionItemKind: { ...KINDS },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: () => ({ dispose: () => undefined }),
    },
  };
  return monaco as unknown as typeof Monaco;
}

const MONACO = stubMonaco();

/**
 * 桩 model：Monaco 默认词法的薄复刻，**词字符 = 字母数字下划线 + CJK**
 * （宿主的 `erb-language.ts` 把 `CJK_WORD_PATTERN` 装进了 Monaco 的 word pattern，
 * 所以 `X = 好` 处的词就是 `好`，不是空串——桩必须同口径，否则对拍记的是桩的账）。
 */
function modelOf(text: string): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getLineCount: () => lines.length,
    getWordUntilPosition: (pos: Monaco.Position) => {
      const line = lines[pos.lineNumber - 1] ?? '';
      const m = /[A-Za-z0-9_\u3040-\u30ff\u3400-\u9fff]*$/.exec(line.slice(0, pos.column - 1));
      const word = m ? m[0] : '';
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
    getLanguageId: () => 'kojo-erb',
  } as unknown as Monaco.editor.ITextModel;
}

const PATH = 'D:/proj/erb/场景.erb';
const FUNCTIONS: readonly string[] = ['M_KOJO_A', 'M_KOJO_B', 'y_あいさつ', 'y_わかれ'];

function schema(): VariableSchema {
  return {
    version: 'parity',
    lookup: () => undefined,
    names: (family: string) =>
      family === 'CFLAG'
        ? [
            {
              name: '好感度',
              index: 1088,
              description: '角色好感度',
              bits: [
                { bit: 0, label: '处' },
                { bit: 1, label: '恋' },
              ],
            },
            { name: '警戒', index: 1090 },
          ]
        : family === 'TALENT'
          ? [{ name: '恋慕', index: 3 }]
          : [],
  } as unknown as VariableSchema;
}

function instructionTable(): KojoInstructionTable {
  return {
    hasTable: true,
    lookupByName: (name: string) => (name === '印刷' ? 10 : undefined),
    lookupByNo: () => '印刷',
    names: () => ['印刷', '表示'],
  } as unknown as KojoInstructionTable;
}

function callProtocol(): KojoCallProtocol {
  return {
    slotsFor: (key: string) =>
      key === 'GETBIT' || key === 'SETBIT'
        ? [
            { kind: 'num', index: 0, label: '变量' },
            { kind: 'num', index: 1, label: '位' },
          ]
        : undefined,
  } as unknown as KojoCallProtocol;
}

const DIRECTIVE_WORDS: readonly string[] = [...mergeDirectiveWords(ERB_DIRECTIVES, ['印刷', '表示'])];

/** 搬前那本册吃的一张表（与事实袋同源：同一 schema / 同一函数表 / 同一词表） */
function tables(): CompletionTables {
  return {
    variableSchema: schema(),
    dictionary: {
      resolve: (name: string) => (name === '好感度' ? 'CFLAG:1088' : undefined),
      resolveFamily: () => undefined,
    },
    instructionTable: instructionTable(),
    callProtocol: callProtocol(),
    erbFunctionNames: () => FUNCTIONS,
    erbFileFacts: {
      dimsOf: () => ['好感度', '警戒'],
      labelsAt: () => ['LOOP'],
    },
    wordBasedSuggestions: () => true,
  };
}

/** 同一批事实经请求递下去（插件读不到槽 / 索引 / 设置） */
function facts(): EditorCompletionFacts {
  return {
    variableSchema: schema(),
    dictionary: {
      resolve: (name: string) => (name === '好感度' ? 'CFLAG:1088' : undefined),
      resolveFamily: () => undefined,
    },
    callProtocol: callProtocol(),
    directiveWords: DIRECTIVE_WORDS,
    systemFunctionAliases: [],
    wordBasedSuggestions: true,
    dimNames: ['好感度', '警戒'],
    labelNames: ['LOOP'],
    functionNames: FUNCTIONS,
  };
}

/* ============================== 两本册 ============================== */

const HOST_PROVIDER = createCompletionProvider(MONACO, ERB_COMPLETION_ASSEMBLY, tables);

interface Row {
  readonly label: string;
  readonly insertText: string;
  readonly kind: number;
  readonly sortText: string;
  readonly filterText: string | undefined;
  readonly insertTextRules: number | undefined;
}

function rowOf(item: Monaco.languages.CompletionItem): Row {
  return {
    label: typeof item.label === 'string' ? item.label : item.label.label,
    insertText: typeof item.insertText === 'string' ? item.insertText : '',
    kind: item.kind,
    sortText: item.sortText ?? '',
    filterText: item.filterText,
    insertTextRules: item.insertTextRules,
  };
}

/** 搬前：宿主自装配那一册（`.kojo1` 原生区用的就是它） */
function hostRows(text: string, line: number, column: number): Row[] {
  const out = HOST_PROVIDER.provideCompletionItems(
    modelOf(text),
    { lineNumber: line, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions.map(rowOf);
}

/** 搬后：插件供方 → 宿主翻译层（与共享槽腿 `toMonacoCompletionItems` 同一枚） */
function pluginRows(text: string, line: number, column: number): Row[] {
  const result = provideErbCompletion({
    kind: 'completion',
    languageId: 'kojo-erb',
    path: PATH,
    version: 1,
    text,
    line,
    column,
    project: null,
    facts: facts(),
  } as never);
  const items = (result?.items ?? []) as readonly EditorCompletionItem[];
  return toMonacoCompletionItems(MONACO, items, {
    startLineNumber: line,
    startColumn: column,
    endLineNumber: line,
    endColumn: column,
  }, { pinyinFilter: true }).map(rowOf);
}

/* ============================== 对拍用例 ============================== */

interface Case {
  readonly name: string;
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

const CASES: readonly Case[] = [
  /* 指令 / 预处理 / 标记行 */
  { name: '行首 `#D` → 预处理指令族', text: '#D', line: 1, column: 3 },
  { name: '行首 `[SKIP` → 标记行', text: '[SKIP', line: 1, column: 6 },
  { name: '行首 `PR` → 词表（含 adapter 指令名）', text: 'PR', line: 1, column: 3 },
  { name: '行中 `IF` → 关键字子集', text: 'IF A', line: 1, column: 5 },
  { name: '行首空白（空前缀整表）', text: '   ', line: 1, column: 4 },
  /* 名字位 */
  { name: '调用位 `CALL M_` → 项目函数', text: 'CALL M_', line: 1, column: 8 },
  { name: '定义位 `@y` → 项目函数', text: '@y', line: 1, column: 3 },
  { name: '跳转位 `GOTO ` → 本文件标签', text: 'GOTO ', line: 1, column: 6 },
  /* 变量 / 位 / 族 / 成员 */
  { name: '`CFLAG:` → 具名索引', text: 'CFLAG:', line: 1, column: 7 },
  { name: '`TALENT:` → 另一族', text: 'TALENT:', line: 1, column: 8 },
  { name: '`CF` → 族头', text: 'CF', line: 1, column: 3 },
  { name: '位坑 `SETBIT CFLAG:1088,`', text: 'SETBIT CFLAG:1088,', line: 1, column: 19 },
  { name: '成员位 `y.` → 同族函数', text: 'y.', line: 1, column: 3 },
  { name: '小数点位 `1.|` → 整轮零候选', text: 'X = 1.', line: 1, column: 7 },
  /* 系统函数 / 括号调用骨架 */
  { name: '系统函数 `A = GET`', text: 'A = GET', line: 1, column: 8 },
  { name: '括号调用 `A = GETBIT(`', text: 'A = GETBIT(', line: 1, column: 12 },
  /* `#DIM` 声明名 / 文档词 */
  { name: '`#DIM` 声明名（索引事实）', text: 'X = 好感', line: 1, column: 7 },
  { name: '文档词（同前缀本文件词）', text: '; 好感度\nX = 好感度', line: 2, column: 8 },
  /* 上下文抑制 */
  { name: '注释行 `;` → 零候选', text: '; A = GET', line: 1, column: 11 },
  { name: '行尾注释 `;` → 零候选', text: 'A = 1 ; GET', line: 1, column: 12 },
  { name: '字符串内（非插值）→ 零候选', text: 'A = "GET', line: 1, column: 10 },
  { name: '字符串内未闭合插值 → 零候选', text: 'A = "{GET', line: 1, column: 11 },
  { name: '字符串闭合插值区 → 放行表达式', text: 'A = "{GET}"', line: 1, column: 10 },
];

describe('LAU-4 补全腿第三批 · 候选逐字对拍（搬前宿主册 vs 搬后插件供方）', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(pluginRows(c.text, c.line, c.column)).toEqual(hostRows(c.text, c.line, c.column));
    });
  }

  it('同一份候选只出一次：按 label 去重后条数 = 装配条数（同名先见者胜）', () => {
    const rows = pluginRows('IF A', 1, 5);
    const labels = rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('排序档位：前缀精确 < 前缀命中 < 子序列 < 其它（sortText 的前导档位单调不减）', () => {
    const rows = pluginRows('CALL M_KOJO', 1, 12).filter((r) => r.label.startsWith('M_KOJO'));
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.sortText.startsWith('1|')).toBe(true);
    const exact = pluginRows('CALL M_KOJO_A', 1, 14).filter((r) => r.label === 'M_KOJO_A');
    expect(exact[0]!.sortText.startsWith('0|')).toBe(true);
  });

  it('拼音可检索键：中文候选的 filterText = `原文 全拼 首字母`（与搬前同一口径）', () => {
    const hit = pluginRows('CFLAG:', 1, 7).find((r) => r.label === '好感度');
    expect(hit).toBeDefined();
    expect(hit!.filterText).toBe('好感度 haogandu hgd');
  });

  /**
   * **一处有意的差异**（本批唯一一条，写在这里而不是让它藏在别处）：光标停在**记号中间**
   * （`X = 好感|度`）时，插件侧的替换区间 = **整记号**、排序前缀 = 记号左半；搬前那一册用的是
   * Monaco 的 `getWordUntilPosition`（右界 = 光标），于是接受候选会留下右半截（`好感度度`）。
   * 插件这一条是搬家前就已经在第二批 facet 上生效的口径（`erbTokenRange` 的记号语义），
   * 本批沿用不重写：一次替换整枚记号才是作者的意思。
   */
  it('光标在记号中间 ⇒ 替换区间覆盖整记号（搬前只到光标，会留下右半截）', () => {
    const text = 'X = 好感度';
    const at = (column: number) =>
      ((provideErbCompletion({
        kind: 'completion',
        languageId: 'kojo-erb',
        path: PATH,
        version: 1,
        text,
        line: 1,
        column,
        project: null,
        facts: facts(),
      } as never)?.items ?? []) as readonly EditorCompletionItem[]).find((item) => item.label === '好感度');
    expect(at(6)?.range).toEqual({ line: 1, startColumn: 5, endColumn: 8 });
    expect(at(8)?.range).toEqual({ line: 1, startColumn: 5, endColumn: 8 });
  });
});

/* ============================== 事实缺席的降级（不猜、不抛） ============================== */

describe('LAU-4 补全腿第三批 · 事实缺席 ⇒ 该路零候选，其余照常', () => {
  const ask = (text: string, column: number, given: EditorCompletionFacts) =>
    ((provideErbCompletion({
      kind: 'completion',
      languageId: 'kojo-erb',
      path: PATH,
      version: 1,
      text,
      line: 1,
      column,
      project: null,
      facts: given,
    } as never)?.items ?? []) as readonly EditorCompletionItem[]).map((item) => item.label);

  it('无 `variableSchema` ⇒ `CFLAG:` 零候选（不猜名字）', () => {
    expect(ask('CFLAG:', 7, { directiveWords: DIRECTIVE_WORDS })).toEqual([]);
  });

  it('无 `functionNames` ⇒ `CALL M_` 零候选，但指令族照常', () => {
    const call = ask('CALL M_', 8, { directiveWords: DIRECTIVE_WORDS });
    expect(call).toEqual([]);
    const directive = ask('#D', 3, { directiveWords: DIRECTIVE_WORDS });
    expect(directive).toContain('#DIM');
  });

  it('无 `wordBasedSuggestions` ⇒ 文档词零候选', () => {
    const labels = ask('X = 好感度', 7, { directiveWords: DIRECTIVE_WORDS });
    expect(labels).not.toContain('好感度');
  });

  it('非 ERB 路径 ⇒ 整轮弃权（`undefined`，让下一家接手）', () => {
    const result = provideErbCompletion({
      kind: 'completion',
      languageId: 'kojo2',
      path: 'D:/proj/口上/12/场景.kojo',
      version: 1,
      text: 'CALL M_',
      line: 1,
      column: 8,
      project: null,
      facts: facts(),
    } as never);
    expect(result).toBeUndefined();
  });

  it('`#DIM` 名缺席（`dimNames: undefined`）⇒ 回退当前缓冲区扫描（索引无意见 ≠ 无名字）', () => {
    const labels = ask('#DIM 好感度\nX = 好感', 7, { ...facts(), dimNames: undefined });
    expect(labels).toContain('好感度');
  });

  it('索引有意见但确无该项（`dimNames: []`）⇒ 零候选，**不回退**（不回退假事实）', () => {
    const labels = ask('#DIM 好感度\nX = 好感', 7, { ...facts(), dimNames: [] });
    expect(labels).not.toContain('好感度');
  });
});