/**
 * C-1 · `.kojo` 补全**装配 seam**（`installKojoCompletion` + `KOJO_COMPLETION_SOURCES`）单测。
 *
 * Monaco 绑定刻意薄：本文件用**桩 monaco**（只记录注册调用与 `CompletionItemKind`）喂
 * provider，不引入真实 monaco-editor 运行时；候选来自静态词表 source（纯数据）。
 * 覆盖：(a) provider 确为 kojo 语言注册、triggerCharacters 含 `{` / `：`；
 * (b) 静态 source 在固定位置产出预期成员（别名 / `如果` / 系统函数 `(` 插入形态 / 前缀精确置顶）；
 * (c) `tables` 为空时不崩、且不产生任何非 adapter 候选（空表与满表候选集一致）；
 * (d) **匹配面**：词表四组 + 本文件声明名每条候选都显式带 `filterText` = 中文主形原文
 *     （真实 Monaco 按 `filterText ?? label` 过滤，隐式兜底不许依赖）；
 * (e) **中英不对等守卫**（规范 §2 原则 2 / §4.1）：英文隐藏别名与原生函数名一律不进上屏三面
 *     （label / detail / filterText）；
 * (f) 词表系统函数的参数槽 = **自带 tabstop 模板**，调用协议表不插手（`callForm` 名单不含
 *     `kojo-lexicon`，见该常量的头注）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type {
  KojoCallSlot,
  KojoCounterTable,
  KojoFaceTable,
  KojoInstructionTable,
  KojoLibraryTable,
  VariableSchema,
} from '@kojo/plugin-api';
import { SYSTEM_FUNCTION_ALIASES, sugarEditorLexicon } from '@kojo/plugin-kojo-sugar';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { ERB_COMPLETION_SOURCES } from '../src/monaco/erb-completion';
import {
  KOJO_COMPLETION_ASSEMBLY,
  KOJO_COMPLETION_SOURCES,
  installKojoCompletion,
  kojoCompletionRange,
  type CompletionDegrade,
  type CompletionTables,
} from '../src/monaco/kojo-completion';

interface Registered {
  languageId: string;
  provider: Monaco.languages.CompletionItemProvider;
}

/** 桩 monaco：只实现补全注册链所需的最薄面 */
function stubMonaco(): { monaco: typeof Monaco; registered: Registered[] } {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: { Variable: 1, Keyword: 2, Operator: 3, Function: 4, EnumMember: 5, Snippet: 15 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
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

/** 桩 model：`getValue`（别名扫描）+ `getWordUntilPosition`（已输入词）+ `getLineContent`（KC-1/KC-2 上下文解析） */
function modelOf(text: string, word = ''): Monaco.editor.ITextModel {
  const lines = text.split('\n');
  return {
    getValue: () => text,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
    getWordUntilPosition: () => ({ word, startColumn: 1, endColumn: 1 + word.length }),
  } as unknown as Monaco.editor.ITextModel;
}

function labelText(label: Monaco.languages.CompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

/** 走 provider 取一轮候选（同步实现 → 桩里直接读建议数组） */
function provide(
  provider: Monaco.languages.CompletionItemProvider,
  text: string,
  word = '',
  column = 1,
): Monaco.languages.CompletionItem[] {
  const out = provider.provideCompletionItems(
    modelOf(text, word),
    { lineNumber: 1, column } as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as unknown as Monaco.languages.CompletionList;
  return out.suggestions;
}

/** 桩 adapter 表（形状与 `CompletionTables` 同构；用于验证「空表也不崩」） */
const fullTables: CompletionTables = {
  dictionary: { resolveFamily: () => undefined, resolve: () => undefined },
  faceTable: { faces: { 初见: { template: 'M_KOJO_K{n}_HATSUMI' } } },
  libraryTable: { hasTable: true, lookupByName: () => undefined },
  instructionTable: { hasTable: true, lookupByName: () => undefined, lookupByNo: () => undefined },
};

const SAMPLE = '别名 心 = 角色 3\n如果\n';

describe('C-1 · .kojo 补全装配（provider 注册）', () => {
  it('只注册一个 provider，且落在 kojo 语言上（.erb 无本模块 provider）', () => {
    const { monaco, registered } = stubMonaco();
    const dispose = installKojoCompletion(monaco, () => ({}));
    expect(registered).toHaveLength(1);
    expect(registered[0]!.languageId).toBe(KOJO_LANGUAGE_ID);
    dispose.dispose();
  });

  it('triggerCharacters 保守且含 `{` 与 `：`', () => {
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({}));
    const tc = registered[0]!.provider.triggerCharacters ?? [];
    expect(tc).toContain('{');
    expect(tc).toContain('：');
  });

  it('扩展点稳定：KOJO_COMPLETION_SOURCES 是可追加数组，含静态词表 source', () => {
    expect(Array.isArray(KOJO_COMPLETION_SOURCES)).toBe(true);
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-lexicon')).toBe(true);
  });

  it('KC-1 / KC-2 已接入扩展点：变量与分野 source 在册', () => {
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-variable')).toBe(true);
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-face')).toBe(true);
  });

  it('KC-3 / KC-4 已接入扩展点：指令名与库函数名 source 在册', () => {
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-instruction')).toBe(true);
    expect(KOJO_COMPLETION_SOURCES.some((s) => s.id === 'kojo-library')).toBe(true);
  });

  it('COMPL-SHARED 已接入扩展点：项目函数名 source 在册（与 `.erb` 同一份表、同一个 requires 键）', () => {
    const source = KOJO_COMPLETION_SOURCES.find((s) => s.id === 'kojo-functions');
    expect(source).toBeDefined();
    expect(source!.requires).toBe('erbFunctionNames');
    expect(ERB_COMPLETION_SOURCES.find((s) => s.id === 'erb-functions')!.requires).toBe('erbFunctionNames');
  });
});

describe('C-1 · 静态词表 source 产出', () => {
  const { monaco, registered } = stubMonaco();
  installKojoCompletion(monaco, () => ({}));
  const provider = registered[0]!.provider;

  it('中文主形关键字在列：行首命中 R4 块头模板（snippet 优先于纯文本），英文隐藏别名不进列表', () => {
    const items = provide(provider, SAMPLE, '如');
    const ifItem = items.find((i) => labelText(i.label) === '如果');
    expect(ifItem).toBeDefined();
    // 行首位置 snippet 与纯文本同 label，去重先注册者胜 ⇒ 只留块头模板（R4 设计意图）
    expect(/模板/.test(ifItem!.detail as string)).toBe(true);
    expect(ifItem!.insertTextRules).toBe(4);
    expect(items.some((i) => labelText(i.label) === 'if')).toBe(false);
  });

  it('系统函数名以 snippet 调用形态插入（R4）：`获取标记` → `获取标记($1)$0`，光标落括号内', () => {
    // 位置判据后行首空位（col0=0）词表不供 ⇒ 光标落在行首 token `别名` 内取词表那一路
    const items = provide(provider, SAMPLE, '获', 2);
    const fn = items.find((i) => labelText(i.label) === '获取标记');
    expect(fn).toBeDefined();
    expect(fn!.insertText).toBe('获取标记($1)$0');
    expect(fn!.insertTextRules).toBe(4); // InsertAsSnippet
    expect(fn!.detail).toBe('系统函数');
  });

  it('本文件 `别名` 名在列（`心`），保留代词 `她` 在列', () => {
    // 同上：词表合法位 = 行首 token 内（col0=1，tokenStart=0）
    const items = provide(provider, SAMPLE, '别', 2);
    expect(items.find((i) => labelText(i.label) === '心')!.detail).toBe('别名（本文件）');
    expect(items.find((i) => labelText(i.label) === '她')!.detail).toBe('保留代词');
  });

  it('排序：前缀精确命中置顶（已输入 `如果` → `如果` 排第一）', () => {
    const items = provide(provider, SAMPLE, '如果');
    expect(labelText(items[0]!.label)).toBe('如果');
  });
});

describe('C-1 · tables 缺席（fail-visible，不崩不猜）', () => {
  const emptyTables = stubMonaco();
  installKojoCompletion(emptyTables.monaco, () => ({}));
  const withTables = stubMonaco();
  installKojoCompletion(withTables.monaco, () => fullTables);

  it('空 tables 不崩，且与满 tables 候选逐字一致（静态 source 不消费 adapter 表）', () => {
    const emptyProvider = emptyTables.registered[0]!.provider;
    const fullProvider = withTables.registered[0]!.provider;
    // 位置取行首 token 内（词表合法位）：行首空位现在只有 R4 模板出货，词表已被位置判据收住
    expect(() => provide(emptyProvider, SAMPLE, '别', 2)).not.toThrow();
    const emptyItems = provide(emptyProvider, SAMPLE, '别', 2).map((i) => labelText(i.label));
    const fullItems = provide(fullProvider, SAMPLE, '别', 2).map((i) => labelText(i.label));
    expect(emptyItems.length).toBeGreaterThan(0);
    expect(fullItems).toEqual(emptyItems);
    // 静态 source 仅产语言/文件层候选：detail 全在固定集合内（词表五组 + 声明名）
    const details = new Set(provide(emptyProvider, SAMPLE, '别', 2).map((i) => i.detail));
    for (const d of details) {
      expect(
        ['别名（本文件）', '保留代词', '运算符', '系统函数', '头部声明', '块关键字', '行内关键字', '别名右值'].includes(d as string) ||
          /模板|分支头/.test(d as string),
      ).toBe(true);
    }
  });

  it('KC-2 分野 source 经 provider 出货：行首 `时机 初` → 命中 `初见`（表驱动，零硬编码）', () => {
    const provider = withTables.registered[0]!.provider;
    const items = provide(provider, '时机 初', '初', 5);
    const hit = items.find((i) => labelText(i.label) === '初见');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('M_KOJO_K{n}_HATSUMI');
  });
});

/* ============================== SH-4 · 失效与不静默（三态可复跑） ============================== */

/** 合成变量 schema X / Y（内容不同 ⇒ 切表可辨）；族 `CFLAG` 各出一条名字 */
const schemaX: VariableSchema = {
  version: 'x',
  lookup: () => undefined,
  names: (family) => (family === 'CFLAG' ? [{ name: '甲旗', index: 1, resolvedIndex: 1, source: 'primary' }] : []),
};
const schemaY: VariableSchema = {
  version: 'y',
  lookup: () => undefined,
  names: (family) => (family === 'CFLAG' ? [{ name: '乙旗', index: 2, resolvedIndex: 2, source: 'primary' }] : []),
};
const faceX: KojoFaceTable = { faces: { 初见: { template: 'M_FACE_X' } } };
// KC-3 / KC-4 / IX-1 三源的表（本 helper 不测它们，但「满表」态须喂上，否则会各首发一次降级）
const instructionX: KojoInstructionTable = { hasTable: true, lookupByName: () => undefined, lookupByNo: () => undefined };
const libraryX: KojoLibraryTable = { hasTable: true, lookupByName: () => undefined };
const counterX: KojoCounterTable = { hasTable: true, lookupByName: () => undefined, lookupByNumber: () => undefined };

/**
 * 在同一**已装配句柄**上连续跑三态（满分 → 缺表 → 切表 → 再缺），断言：
 * - 态 A 满表：`kojo-variable` / `kojo-face` 各路出货，零降级；
 * - 态 B 缺表（`tables = {}`）：该路**零候选** + 降级信号可见；
 * - 态 C 切表：候选**随新表变化**（证明现取、无缓存旧表）；再切空 ⇒ 零候选。
 *
 * 去重口径（装配核 `completion-core.ts`：去重表**随装配轮**创建，见 `completion-shared.test.ts` ⑧）：
 * 同一 `(来源, 缺表键)` 在**一轮内只报一次**（不刷屏），**跨轮还会再报**（首轮之后永久无声
 * 正是"静默失效"陷阱，旧句柄级口径已换掉）⇒ 下面的期望值按"缺表轮数"逐轮 +1。
 */
function threeStatesKojo(
  provider: Monaco.languages.CompletionItemProvider,
  setTables: (t: CompletionTables) => void,
  degrades: CompletionDegrade[],
): void {
  const has = (text: string, word: string, col: number, label: string): boolean =>
    provide(provider, text, word, col).some((i) => labelText(i.label) === label);
  const countOf = (id: string, key: string): number =>
    degrades.filter((d) => d.sourceId === id && d.missing === key).length;

  // 态 A：满表 ⇒ 变量 / 分野各路出货，零降级信号
  // （COMPL-SHARED 起 `kojo-functions` 也吃表：项目函数名提供者缺席会首发一次降级，故喂上）
  setTables({
    variableSchema: schemaX,
    faceTable: faceX,
    instructionTable: instructionX,
    counterTable: counterX,
    libraryTable: libraryX,
    erbFunctionNames: () => [],
  });
  expect(has('{她的', '', 4, '甲旗')).toBe(true);
  expect(has('时机 初', '初', 5, '初见')).toBe(true);
  expect(degrades).toEqual([]);

  // 态 B：缺表 ⇒ 该路零候选 + 信号可见（首轮各报一次）
  setTables({});
  expect(has('{她的', '', 4, '甲旗')).toBe(false);
  expect(countOf('kojo-variable', 'variableSchema')).toBe(1);
  expect(countOf('kojo-face', 'faceTable')).toBe(1);
  // 第二轮：每键仍**只加一份**（一轮内不刷屏），但不会被上一轮的记录吞掉（不静默）
  provide(provider, '{她的', '', 4);
  expect(countOf('kojo-variable', 'variableSchema')).toBe(2);
  expect(countOf('kojo-face', 'faceTable')).toBe(2);
  provide(provider, '时机 初', '初', 5);
  expect(countOf('kojo-variable', 'variableSchema')).toBe(3);
  expect(countOf('kojo-face', 'faceTable')).toBe(3);

  // 态 C：切表 ⇒ 候选随新表变化（无缓存旧表）
  setTables({ variableSchema: schemaY });
  expect(has('{她的', '', 4, '乙旗')).toBe(true);
  expect(has('{她的', '', 4, '甲旗')).toBe(false);
  setTables({ variableSchema: schemaX });
  expect(has('{她的', '', 4, '甲旗')).toBe(true);
  expect(has('{她的', '', 4, '乙旗')).toBe(false);
  // 表在位的那两轮**不新增**变量路降级（`variableSchema` 在场 ⇒ 一份也不报）
  expect(countOf('kojo-variable', 'variableSchema')).toBe(3);
  // 再切空 ⇒ 零候选，并且这一轮照旧再报一次（缺表始终可见）
  setTables({});
  expect(has('{她的', '', 4, '甲旗')).toBe(false);
  expect(countOf('kojo-variable', 'variableSchema')).toBe(4);
}

describe('SH-4 · 依赖表缺席 = 降级不静默（三态可复跑）', () => {
  it('同一装配句柄内连续跑：满分 → 缺表 → 切表 → 再缺', () => {
    let tables: CompletionTables = {};
    const degrades: CompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => tables, (d) => degrades.push(d));
    threeStatesKojo(registered[0]!.provider, (t) => (tables = t), degrades);
  });

  it('重新 install 一遍 → 同一结论（去重表随装配轮创建，既每轮可见也不每候选刷屏）', () => {
    let tables: CompletionTables = {};
    const degrades: CompletionDegrade[] = [];
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => tables, (d) => degrades.push(d));
    threeStatesKojo(registered[0]!.provider, (t) => (tables = t), degrades);
  });

  it('requires 声明在册：kojo-variable→variableSchema、kojo-face→faceTable（additive 可选字段）', () => {
    const byId = new Map(KOJO_COMPLETION_SOURCES.map((s) => [s.id, s.requires]));
    expect(byId.get('kojo-variable')).toBe('variableSchema');
    expect(byId.get('kojo-face')).toBe('faceTable');
    expect(byId.get('kojo-instruction')).toBe('instructionTable');
    expect(byId.get('kojo-counter')).toBe('counterTable');
    expect(byId.get('kojo-library')).toBe('libraryTable');
    expect(byId.get('kojo-lexicon')).toBeUndefined();
  });
});

/* ============================== CP-2 / CP-3 · 匹配面（filterText）与词表调用形态口径 ============================== */

/**
 * 只取**词表那一路**的候选（不经装配的 label 去重）：行首的 `如果` 会被先注册的 R4 块头模板
 * 盖掉（那是 snippet 源的地盘，属 C3 文件），本批的两处缺陷都在词表源里 ⇒ 直接问那一枚 source。
 *
 * `column` 可显式给（POS-LEX 起词表有位置判据：`text` 里的光标位必须落在**合法位**上——
 * 行首 token 内 / 关键字锚内 / 插值内……，见 `kojoLexiconAvailableAt` 头注）。
 */
function lexiconItems(text: string, word = '', column = 1 + word.length): Monaco.languages.CompletionItem[] {
  const source = KOJO_COMPLETION_SOURCES.find((s) => s.id === 'kojo-lexicon');
  if (source === undefined) throw new Error('词表 source 不在册');
  const { monaco } = stubMonaco();
  const model = modelOf(text, word);
  const position = { lineNumber: 1, column } as Monaco.Position;
  const ctx = { monaco, model, position, range: kojoCompletionRange(model, position), tables: {} as CompletionTables };
  return source.provide(ctx);
}

describe('CP-2 · 中文候选的匹配面：filterText = 中文主形原文（显式声明，不留隐式兜底）', () => {
  it('词表四组 + 本文件声明名：每条候选都带字符串 `filterText`，且逐字等于 label 原文', () => {
    // POS-LEX 起词表只在合法位出货 ⇒ 取行首 token `别名` 内（col0=2，tokenStart=0）
    const items = lexiconItems(SAMPLE, '别名');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.filterText).toBe('string');
      expect(item.filterText).toBe(labelText(item.label));
    }
  });

  it('钉值（五组各取一枚）：代词 / 关键字 / 运算符 / 系统函数 / 本文件 `别名` 声明名', () => {
    const byLabel = new Map(lexiconItems(SAMPLE, '如').map((i) => [labelText(i.label), i]));
    expect(byLabel.get('她')?.filterText).toBe('她');
    expect(byLabel.get('如果')?.filterText).toBe('如果');
    expect(byLabel.get('不在')?.filterText).toBe('不在');
    expect(byLabel.get('获取标记')?.filterText).toBe('获取标记');
    expect(byLabel.get('心')?.filterText).toBe('心');
  });

  it('系统函数候选的匹配面是**中文名**，不是原生名（filterText 不承载隐藏面）', () => {
    const native = SYSTEM_FUNCTION_ALIASES.get('获取标记');
    expect(typeof native).toBe('string');
    const item = lexiconItems(SAMPLE, '获').find((i) => labelText(i.label) === '获取标记');
    expect(item?.filterText).toBe('获取标记');
    expect(item?.filterText).not.toBe(native);
  });
});

describe('CP-2 · 中英不对等（规范 §2 原则 2 / §4.1）：上屏三面零英文别名', () => {
  it('label / detail / filterText 三面不含任何 ASCII 字母 ⇒ 面板只有中文一面', () => {
    const items = lexiconItems(SAMPLE, '别名');
    expect(items.length).toBeGreaterThan(0);
    const faces: string[] = [];
    for (const item of items) {
      expect(typeof item.detail).toBe('string');
      expect(typeof item.filterText).toBe('string');
      faces.push(labelText(item.label), item.detail as string, item.filterText as string);
    }
    expect(faces.filter((f) => /[A-Za-z]/.test(f))).toEqual([]);
  });

  it('反向钉：词表的英文隐藏别名（关键字别名 / `notin` / 原生函数名）一条都不进候选 label', () => {
    const lex = sugarEditorLexicon();
    const aliases = [
      ...new Set([
        ...lex.words.filter((w) => !w.primary).map((w) => w.word),
        ...lex.notin.filter((w) => /[A-Za-z]/.test(w)),
        ...[...SYSTEM_FUNCTION_ALIASES.values()],
      ]),
    ];
    expect(aliases.length).toBeGreaterThan(10); // 别名单为空 = 本守卫失去对象（假绿），先钉住它非空
    const labels = new Set(lexiconItems(SAMPLE, '别名').map((i) => labelText(i.label)));
    expect(aliases.filter((a) => labels.has(a))).toEqual([]);
  });
});

describe('CP-3 · 词表系统函数的参数槽 = 自带模板（协议表不插手）', () => {
  it('装配声明的调用形态名单不含 kojo-lexicon（死分支已摘），仍含 kojo-library', () => {
    expect(KOJO_COMPLETION_ASSEMBLY.callForm.sourceIds.has('kojo-lexicon')).toBe(false);
    expect(KOJO_COMPLETION_ASSEMBLY.callForm.sourceIds.has('kojo-library')).toBe(true);
  });

  it('协议表即便认得系统函数的**原生名**，词表候选也保持自带 tabstop `名($1)$0`（不被改写、不退化成半个左括号）', () => {
    const slots: readonly KojoCallSlot[] = [{ index: 0, kind: 'int', label: '标记号' }];
    const native = SYSTEM_FUNCTION_ALIASES.get('获取标记');
    let probed = 0;
    const { monaco, registered } = stubMonaco();
    installKojoCompletion(monaco, () => ({
      callProtocol: {
        slotsFor: (name: string) => {
          probed += 1;
          return name === native ? slots : null;
        },
      },
    }));
    const fn = provide(registered[0]!.provider, SAMPLE, '获', 2).find((i) => labelText(i.label) === '获取标记');
    expect(fn).toBeDefined();
    expect(fn!.insertText).toBe('获取标记($1)$0');
    expect(fn!.insertTextRules).toBe(4); // InsertAsSnippet：自带模板照旧按 snippet 解析
    expect(probed).toBe(0); // 词表候选根本不进协议表问槽（名单外 ⇒ 连问都不问）
  });
});

/* ============================== POS-LEX · 词表 source 的位置判据（`：` 触发噪声缺陷） ============================== */

/**
 * 缺陷：`：` 是触发字符而词表 source 曾**无条件供货** ⇒ ①写完 `时机 初见：`（分野源因块头已
 * 收尾返回空、其余槽源也不命中）弹窗里只剩整张代词/关键字/运算符/系统函数表；②台词 / 普通文本
 * 行里输入 `：` 同样弹；③字符串里输入 `：` 拦不住。修法 = `kojoLexiconAvailableAt`（顺序 a–h
 * 的位置判据）；词表 content / 触发字符 / 装配核零改动。
 *
 * 满覆盖表（`posTables`）：六个 `requires` 键全部在场 ⇒ 一轮装配里**每个 source 都真的跑**，
 * 「零候选」只能来自各源自己的位置判据，而不是被缺表跳过（配合零降级断言一起钉住这一点）。
 */
const posSchema: VariableSchema = {
  version: 'pos',
  lookup: () => undefined,
  names: (family) => (family === 'CFLAG' ? [{ name: '甲旗', index: 1, resolvedIndex: 1, source: 'primary' }] : []),
};

const posTables: CompletionTables = {
  variableSchema: posSchema,
  faceTable: { faces: { 初见: { template: 'M_KOJO_K{n}_HATSUMI' } } },
  instructionTable: { hasTable: true, lookupByName: () => undefined, lookupByNo: () => undefined },
  counterTable: { hasTable: true, lookupByName: () => undefined, lookupByNumber: () => undefined },
  libraryTable: { hasTable: true, lookupByName: () => undefined },
  erbFunctionNames: () => [],
};

describe('POS-LEX · 词表位置判据：`：` 触发不再泼整张表', () => {
  const degrades: CompletionDegrade[] = [];
  const { monaco, registered } = stubMonaco();
  installKojoCompletion(monaco, () => posTables, (d) => degrades.push(d));
  const provider = registered[0]!.provider;

  it('块头已收口：`时机 初见：|` 一轮**全源零候选**（snippet 行首判据不命中，未动它）', () => {
    const items = provide(provider, '时机 初见：', '', 7);
    expect(items).toEqual([]);
    expect(degrades).toEqual([]); // 满覆盖表 ⇒ 无一源因缺表被跳过：零候选只能来自各自判据
    expect(lexiconItems('时机 初见：', '', 7)).toEqual([]); // 词表那一路直接问，亦零
  });

  it('对照位（块冒号之前）：`时机 初见|` 分野候选照旧、词表也在 ⇒ 上面不是假零', () => {
    const items = provide(provider, '时机 初见', '', 6);
    const hit = items.find((i) => labelText(i.label) === '初见');
    expect(hit).toBeDefined();
    expect(hit!.detail).toBe('M_KOJO_K{n}_HATSUMI'); // 分野源出货（词表没有 `初见` 这个名）
    expect(items.some((i) => labelText(i.label) === '她')).toBe(true); // 词表经锚（g）照常整表供
  });

  it('台词行 / 文本中段：`今天天气真好：|` 与 `好可爱|` 中段 ⇒ 词表零候选', () => {
    expect(lexiconItems('今天天气真好：', '', 8)).toEqual([]);
    expect(lexiconItems('今天天气真好，好可爱呀', '', 10)).toEqual([]); // 光标在 `可爱` 之后（两侧都有文本）
    expect(lexiconItems('好可爱', '', 4).length).toBeGreaterThan(0); // 同位行首 token（f）仍供——零非误伤
  });

  it('字符串内：`"好：|"` 零候选（字符串门 b 先于冒号门 e）', () => {
    expect(lexiconItems('"好："', '', 4)).toEqual([]);
  });

  it('时机命名参数区 / 块头收尾：`时机 指令 310 成否：|`（含半角 `:` 变体）零候选', () => {
    expect(lexiconItems('时机 指令 310 成否：', '', 14)).toEqual([]);
    expect(lexiconItems('时机 初见:', '', 7)).toEqual([]);
  });

  it('回归：`如果 好感度 大于 5：|` 行尾块冒号后词表不供，冒号之前照旧供（锚 g）', () => {
    expect(lexiconItems('如果 好感度 大于 5：', '', 13)).toEqual([]);
    expect(lexiconItems('如果 好感度 大于 5', '', 12).length).toBeGreaterThan(0);
  });

  it('空行 / 行首空位不供（新行只有 R4 模板的场子）', () => {
    expect(lexiconItems('', '', 1)).toEqual([]);
    expect(lexiconItems('    ', '', 5)).toEqual([]);
  });

  it('插值内（c）供：`{她的|` 词表可用，且变量源不受影响（另一路，非本文件）', () => {
    expect(lexiconItems('{她的', '', 4).length).toBeGreaterThan(0);
    const items = provide(provider, '{她的', '', 4);
    expect(items.some((i) => labelText(i.label) === '甲旗')).toBe(true); // 变量源照常出货
  });
});
