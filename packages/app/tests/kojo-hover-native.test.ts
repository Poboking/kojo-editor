/**
 * ZH-D3 · 悬停**原生形态**反查（中文 → 原文）。
 *
 * 三件判据各自钉死：
 * ①**改得动**：`.kojo` 里的中文族头 / 中文函数名 / 时机块头（分野、中文指令名、命名参数取值）
 *   悬停都能拿到原生 ERB 形态（真表：adapter 的族头别名表 / 基础库表 / 分野表 / 计数器表 +
 *   kojo-sugar 的系统函数表）；
 * ②**不漂移**：正向表与反向表**互为反函数**（闭集全过，同名多写法的碰撞进显式台账并逐条自证）；
 *   时机函数名一律由**转译器的 `buildFunctionName`** 拼出——断言与直接调用该函数的结果逐字相等，
 *   杜绝宿主侧存在第二条拼法；
 * ③**只读**：provider 只碰模型的读接口，零 IO / 零事件 / 零编辑；正向命中的输出与改前逐字一致。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { KojoFaceTable, VariableInfo, VariableSchema } from '@kojo/plugin-api';
import {
  createEratwCounterTable,
  createEratwFaceTable,
  createEratwInstructionTable,
  createEratwLibraryTable,
  ERATW_COUNTER_ENTRIES,
  ERATW_LIBRARY_FUNCTIONS,
  FAMILY_ALIASES,
  FAMILY_ALIASES_REVERSE,
  parseTrainCsv,
} from '@kojo/plugin-eratw-adapter';
import type { DictionaryLookup } from '@kojo/plugin-kojo-sugar';
import { buildFunctionName, SYSTEM_FUNCTION_ALIASES, SYSTEM_FUNCTION_REVERSE } from '@kojo/plugin-kojo-sugar';
import { type HoverTables, installHover, resolveHoverName } from '../src/monaco/kojo-hover';
import { type KojoDocHeader, docHeaderOf, resolveNativeHover } from '../src/monaco/kojo-hover-native';

/* ============================ 真表装配（零手抄镜像） ============================ */

/** 真基础库表（由 `ERATW_LIBRARY_FUNCTIONS` 建表 ⇒ 反查走同一条 `lookupByName`） */
const libraryTable = createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS);

/** 真计数器表（由 `ERATW_COUNTER_ENTRIES` 建表） */
const counterTable = createEratwCounterTable(ERATW_COUNTER_ENTRIES);

/** 真分野表（附录 C 全量调用面，模板逐字来自 adapter） */
const faceTable: KojoFaceTable = createEratwFaceTable();

/** 指令表：真解析器 + 最小 CSV 行（CSV 本体要工程目录 ⇒ 这里只喂两行证明查表这一路） */
const instructionTable = createEratwInstructionTable(parseTrainCsv('310,亲吻\n270,自定甲\n'));

/** 字典桩：族头别名直通真表；`nameAt` 只服务正向路（确保反向路不抢它的道） */
const dictionary: DictionaryLookup = {
  resolveFamily: () => undefined,
  resolve: () => undefined,
  nameAt: (family, index) => (family === 'CFLAG' && index === '1088' ? '好感度' : undefined),
  familyAlias: (name) => FAMILY_ALIASES[name],
  familyAliasReverse: (family) => FAMILY_ALIASES_REVERSE[family.toUpperCase()],
};

/** 变量 schema 桩：族级说明 + 具名索引 → 编号（只有 `NOWEX:噴乳 = 193` 是"表里真有"的两条） */
const variableSchema: VariableSchema = {
  version: 'stub',
  lookup(variableName: string, index?: number | string): VariableInfo | undefined {
    const key = variableName.toUpperCase();
    if (index === undefined) return key === 'NOWEX' ? { name: key, description: '现在状态' } : undefined;
    if (key === 'NOWEX' && index === '噴乳') return { name: key, index, resolvedIndex: 193 };
    return undefined;
  },
};

const tables: HoverTables = {
  dictionary,
  libraryTable,
  instructionTable,
  counterTable,
  faceTable,
  variableSchema,
};

/** 文件头事实（`角色: 12` ⇒ `{n}` = 12；标准版 ⇒ `{t}` = 空串） */
const K12: KojoDocHeader = { charNo: '12' };
/** 没有文件头（未写 `角色:`）⇒ 反向路只给模板 */
const NO_HEADER: KojoDocHeader = {};

/** 用 `|` 标记光标处（1 基列 = 标记前字符数 + 1）走**反向**解析 */
const at = (marked: string, t: HoverTables = tables, header = K12) =>
  resolveNativeHover(marked.replace('|', ''), marked.indexOf('|') + 1, t, header);

/** 正向 + 反向的完整入口（`resolveHoverName`）同口径 */
const atFull = (marked: string, t: HoverTables = tables, header = K12) =>
  resolveHoverName(marked.replace('|', ''), marked.indexOf('|') + 1, t, header);

/* ============================ ① 中文 → 原生形态 ============================ */

describe('悬停反查 · 族头中文别名', () => {
  it('`现在:噴乳` → 原生族头 NOWEX，并带出原生引用 / 索引编号 / 含义三行', () => {
    const hit = at('IF |现在:噴乳 > 0：');
    expect(hit?.name).toBe('NOWEX');
    expect(hit?.kind).toContain('原生族头');
    expect(hit?.lines).toContain('原生引用：`NOWEX:噴乳`');
    expect(hit?.lines).toContain('索引编号：`193`');
    expect(hit?.lines).toContain('含义：现在状态');
    expect(hit?.startColumn).toBe(4);
    expect(hit?.endColumn).toBe(6);
  });

  it('裸族头（冒号收尾、无索引段）只给原生族头一行', () => {
    const hit = at('IF |标记: > 0');
    expect(hit?.name).toBe('FLAG');
    expect(hit?.lines).toBeUndefined();
  });

  it('数字索引同样带出原生引用（`时标:193` → `TFLAG:193`）', () => {
    expect(at('IF |时标:193 == 0')?.lines).toContain('原生引用：`TFLAG:193`');
  });

  it('长别名整段命中（`角色字符串:` 不被切成 `字符串:`）', () => {
    expect(at('IF |角色字符串:2 = ""')?.name).toBe('CSTR');
  });

  it('负例：未登记的中文词 / 繁体写法 / 台词里的同形词 ⇒ 不显示（不猜）', () => {
    expect(at('IF |現在:噴乳 > 0')).toBeUndefined();
    expect(at('IF |装备品:1 > 0')).toBeUndefined();
    expect(at('「|现在」很好')).toBeUndefined();
  });
});

describe('悬停反查 · 中文函数名', () => {
  it('系统函数表（跨游戏语言层）：`获取标记(X,0)` → `GETBIT()`', () => {
    const hit = at('IF |获取标记(X,0) > 0');
    expect(hit?.name).toBe('GETBIT()');
    expect(hit?.kind).toContain('原生函数名');
    expect(hit?.lines).toBeUndefined(); // 表里没有说明字段 ⇒ 不编一行
  });

  it('adapter 基础库表：`意识清醒(1)` → `SHIRAHU()`', () => {
    expect(at('IF |意识清醒(1)')?.name).toBe('SHIRAHU()');
  });

  it('高频库函数 `心形(@"文本","W")` → `HPH_PRINT()`', () => {
    expect(at('CALL |心形(@"文本","W")')?.name).toBe('HPH_PRINT()');
  });

  it('名字与括号之间有空白同样认（与降糖同一口径）', () => {
    expect(at('IF |最大值 (A,B) > 0')?.name).toBe('MAX()');
  });

  it('语句形白名单：`设置标记 TFLAG:193, 0` → `SETBIT`', () => {
    const hit = at('|设置标记 TFLAG:193, 0');
    expect(hit?.name).toBe('SETBIT');
    expect(hit?.kind).toContain('原生语句形');
  });

  it('负例：无调用形态（裸词）/ 未收录的中文名 ⇒ 不显示', () => {
    expect(at('IF |获取标记 > 0')).toBeUndefined();
    expect(at('CALL |我的私有函数(1)')).toBeUndefined();
    expect(at('台词：|现在 很好')).toBeUndefined();
  });

  it('摘掉 adapter 表后系统表照常（语言层与项目无关）', () => {
    expect(at('IF |获取标记(X,0) > 0', {})?.name).toBe('GETBIT()');
    expect(at('IF |意识清醒(1)', {})).toBeUndefined();
  });
});

describe('悬停反查 · 时机块头（分野 → 拼出来的函数名）', () => {
  it('`时机 指令 310：` → `M_KOJO_MESSAGE_COM_K12_310`（`类型:` 未写 = 缺省段 COM）', () => {
    const hit = at('时机 |指令 310：');
    expect(hit?.name).toBe('M_KOJO_MESSAGE_COM_K12_310');
    expect(hit?.kind).toBe('时机分野 · 指令');
    expect(hit?.lines).toContain('函数名模板：`M_KOJO{t}_MESSAGE_${com}_K{n}_{i}`');
  });

  it('拼名结果与**直接调用转译器的 `buildFunctionName`** 逐字相等（不存在第二条拼法）', () => {
    const spec = faceTable.faces['指令']!;
    const com = buildFunctionName(spec.template.replace('${com}', 'COM'), '', '12', '310', true);
    expect(com).toBe('M_KOJO_MESSAGE_COM_K12_310');
    expect(at('时机 |指令 310：')?.name).toBe(com);
    const scom = buildFunctionName(spec.template.replace('${com}', 'SCOM'), '', '12', '310', true);
    expect(at('时机 |指令 310 类型: 副指令：')?.name).toBe(scom);
  });

  it('无编号面（`初见`）走同一条链：`M_KOJO_ENCOUNTER_K12`', () => {
    expect(at('时机 |初见：')?.name).toBe('M_KOJO_ENCOUNTER_K12');
  });

  it('家族段位置随模板而变（`房间描述` = `K{n}{t}_ROOM_DESCRIPTION`）', () => {
    const hit = at('时机 |房间描述：', tables, { charNo: '12', familySeg: '_破空' });
    expect(hit?.name).toBe('K12_破空_ROOM_DESCRIPTION');
  });

  it('`类型: 副指令` 的取值反查 → 原生段文本 `SCOM`', () => {
    const hit = at('时机 指令 310 类型: |副指令：');
    expect(hit?.name).toBe('SCOM');
    expect(hit?.kind).toContain('原生段值');
  });

  it('写了 `成否:` 才多出成否函数名一行', () => {
    const hit = at('时机 |指令 310 成否: 游戏判定：');
    expect(hit?.lines).toContain('成否函数名：`M_KOJO_SUCCESS_COM_K12_310`');
    expect(at('时机 |指令 310：')?.lines).not.toContain('成否函数名：`M_KOJO_SUCCESS_COM_K12_310`');
  });

  it('中文指令名 → 原生编号 + 函数名（`时机 指令 亲吻：` → `310`）', () => {
    const hit = at('时机 指令 |亲吻：');
    expect(hit?.name).toBe('310');
    expect(hit?.kind).toContain('原生编号 · 指令');
    expect(hit?.lines).toContain('函数名：`M_KOJO_MESSAGE_COM_K12_310`');
  });

  it('计数器面走真计数器表（在表的计数器名 → 其原生编号）', () => {
    const label = ERATW_COUNTER_ENTRIES.find((e) => counterTable.lookupByName(e.label) === e.counter)?.label;
    expect(label, '计数器表里有名可查').toBeDefined();
    const hit = at(`时机 计数器 |${label}：`);
    expect(hit?.name).toBe(String(counterTable.lookupByName(label!)));
    expect(hit?.kind).toContain('原生编号 · 计数器');
    expect(hit?.lines).toContain('函数名：`M_KOJO_MESSAGE_COUNTER_K12_' + counterTable.lookupByName(label!) + '`');
  });

  it('`indexKind: literal` 的形态名原样进函数名尾段（`时机 图像 特殊服装：`）', () => {
    expect(at('时机 图像 |特殊服装：')?.name).toBe('M_KOJO_IMAGE_K12_特殊服装');
  });

  it('缺角色号 ⇒ 只给模板，绝不给半个函数名', () => {
    const hit = at('时机 |指令 310：', tables, NO_HEADER);
    expect(hit?.name).toBe(faceTable.faces['指令']!.template);
    expect(hit?.kind).toBe('时机分野 · 函数名模板');
    expect(hit?.lines).toBeUndefined();
  });

  it('模板要 `{i}` 而块头省略编号 ⇒ 不拼（自动分配的号无从得知）', () => {
    const hit = at('时机 |事件：');
    expect(hit?.name).toBe(faceTable.faces['事件']!.template);
    expect(hit?.kind).toBe('时机分野 · 函数名模板');
  });

  it('负例：分野不在表 / 未登记的中文指令名 / 表缺席 ⇒ 不显示', () => {
    expect(at('时机 |不存在面 1：')).toBeUndefined();
    expect(at('时机 指令 |不存在的指令名：')).toBeUndefined();
    expect(at('时机 |指令 310：', {})).toBeUndefined();
  });

  it('闭包：真分野表的每一面都能拼出**不留占位符**的函数名（有编号 + 有角色号时）', () => {
    const faces = Object.keys(faceTable.faces);
    expect(faces.length).toBeGreaterThan(30);
    const bad: string[] = [];
    for (const face of faces) {
      const hit = resolveNativeHover(`时机 ${face} 310：`, 4, tables, K12);
      if (hit === undefined) bad.push(`${face}：无命中`);
      else if (hit.name.includes('{') || hit.name.includes('}')) bad.push(`${face}：${hit.name}`);
    }
    expect(bad, `拼不出的分野：\n${bad.join('\n')}`).toEqual([]);
  });

  it('块头之外的中文词不走分野路（别处的 `指令` 二字不敢认）', () => {
    expect(at('「|指令」是什么')).toBeUndefined();
    expect(at('如果 |指令 310')).toBeUndefined();
  });
});

/* ============================ ② 正反表互为反函数 ============================ */

/** 中文名 → 原生名 的正表与"原生名 → 中文名"的反表逐条对账；碰撞必须进显式台账 */
function assertBijection(
  label: string,
  forward: ReadonlyMap<string, string>,
  reverse: (native: string) => string | undefined,
  ledger: readonly string[],
): void {
  const collisions: string[] = [];
  for (const [cn, native] of forward) {
    const back = reverse(native);
    if (back === cn) continue;
    collisions.push(cn);
    // 每一条"反函数不成立"都必须能被证明是**同一个原生名的多个中文名**（首条优先），
    // 而不是表本身坏了。
    expect(back, `${label}：${cn} → ${native} 的反查落空`).toBeDefined();
    expect(forward.get(back!), `${label}：反查到的 ${back} 又不在正表里`).toBe(native);
  }
  expect([...new Set(collisions)].sort(), `${label}：碰撞台账过期`).toEqual([...ledger].sort());
  expect(forward.size).toBeGreaterThan(0);
}

describe('正反表互为反函数（闭集全过 + 显式台账）', () => {
  /** 台账：同一原生名有多个中文写法时反表只留首条 ⇒ 这些名字的反函数不成立（逐条列明，不留白） */
  const SYSTEM_COLLISIONS: readonly string[] = [];
  const LIBRARY_COLLISIONS: readonly string[] = [];
  const FAMILY_COLLISIONS: readonly string[] = [];
  const COUNTER_COLLISIONS: readonly string[] = [];

  it('系统函数：SYSTEM_FUNCTION_ALIASES ↔ SYSTEM_FUNCTION_REVERSE 全闭包成立', () => {
    assertBijection('系统函数', SYSTEM_FUNCTION_ALIASES, (native) => SYSTEM_FUNCTION_REVERSE.get(native), SYSTEM_COLLISIONS);
  });

  it('基础库函数：ERATW_LIBRARY_FUNCTIONS ↔ lookupByFunction 全闭包成立', () => {
    const table = createEratwLibraryTable(ERATW_LIBRARY_FUNCTIONS);
    assertBijection('基础库', ERATW_LIBRARY_FUNCTIONS, (native) => table.lookupByFunction?.(native), LIBRARY_COLLISIONS);
  });

  it('族头：FAMILY_ALIASES ↔ FAMILY_ALIASES_REVERSE 全闭包成立', () => {
    assertBijection(
      '族头',
      new Map(Object.entries(FAMILY_ALIASES)),
      (native) => FAMILY_ALIASES_REVERSE[native.toUpperCase()],
      FAMILY_COLLISIONS,
    );
  });

  it('计数器：ERATW_COUNTER_ENTRIES 的名 ↔ 编号（首条口径）自证', () => {
    const table = createEratwCounterTable(ERATW_COUNTER_ENTRIES);
    const collisions: string[] = [];
    for (const entry of ERATW_COUNTER_ENTRIES) {
      const back = table.lookupByNumber(entry.counter);
      if (back === entry.label) continue;
      collisions.push(entry.label);
      expect(table.lookupByName(back!), '反查到的名又不在表里').toBe(entry.counter);
    }
    expect([...new Set(collisions)].sort(), '计数器碰撞台账过期').toEqual([...COUNTER_COLLISIONS].sort());
  });

  it('反查用的正是正向那几张表（宿主零镜像）', () => {
    for (const [cn, family] of Object.entries(FAMILY_ALIASES)) {
      expect(dictionary.familyAlias!(cn), cn).toBe(family);
      expect(dictionary.familyAliasReverse!(family), cn).toBe(cn);
    }
    for (const [cn, native] of ERATW_LIBRARY_FUNCTIONS) expect(libraryTable.lookupByName(cn), cn).toBe(native);
    for (const [cn, native] of SYSTEM_FUNCTION_ALIASES) expect(SYSTEM_FUNCTION_REVERSE.get(native), cn).toBeDefined();
  });

  it('指令表：名 → 编号 → 名（首条口径）自证', () => {
    expect(instructionTable.lookupByName('亲吻')).toBe(310);
    expect(instructionTable.lookupByNo(310)).toBe('亲吻');
  });
});

/* ============================ ③ 只读与不回归 ============================ */

/** 假 Monaco：记录 provider 注册与模型上被碰过的接口（只读自证） */
function fakeMonaco(lines: readonly string[]) {
  const touched = new Set<string>();
  let editCalls = 0;
  const model = {
    getLineContent: (n: number) => {
      touched.add('getLineContent');
      return lines[n - 1] ?? '';
    },
    getLineCount: () => {
      touched.add('getLineCount');
      return lines.length;
    },
    getValue: () => {
      touched.add('getValue');
      return lines.join('\n');
    },
    setValue: () => {
      editCalls++;
    },
    applyEdits: () => {
      editCalls++;
    },
  } as unknown as Monaco.editor.ITextModel;
  const regs: { langId: string; provider: Monaco.languages.HoverProvider }[] = [];
  const monaco = {
    languages: {
      registerHoverProvider: (langId: string, provider: Monaco.languages.HoverProvider) => {
        regs.push({ langId, provider });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, model, regs, touched, editCalls: () => editCalls };
}

const noopToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

describe('悬停反查 · 只读与正向零回归', () => {
  it('反查命中时只读 `getLineContent` / `getLineCount`，零编辑、可重复（幂等）', () => {
    const lines = ['角色: 12', '', '时机 指令 310：'];
    const { monaco, model, regs, touched, editCalls } = fakeMonaco(lines);
    installHover(monaco, () => tables);
    const position = { lineNumber: 3, column: 6 } as Monaco.Position;
    const provider = regs[0]!.provider;
    const first = provider.provideHover(model, position, noopToken) as Monaco.languages.Hover;
    const second = provider.provideHover(model, position, noopToken) as Monaco.languages.Hover;
    expect(JSON.stringify(first.contents)).toBe(JSON.stringify(second.contents));
    expect(JSON.stringify(first.contents)).toContain('M_KOJO_MESSAGE_COM_K12_310');
    expect([...touched].sort()).toEqual(['getLineContent', 'getLineCount']);
    expect(editCalls()).toBe(0);
  });

  it('文件头逐行只读解析（注释与同行 `选择器:` 不误收；块头即终止扫描）', () => {
    const lines = ['角色: 12 ; 必填', '口上: 破空 选择器: 1', '开关:', '  眠姦: 是', '时机 指令 310：', '角色: 99'];
    expect(docHeaderOf((n) => lines[n - 1] ?? '', lines.length)).toEqual({ charNo: '12', familySeg: '_破空' });
    expect(docHeaderOf(() => '时机 初见：', 1)).toEqual({});
    expect(docHeaderOf(() => '简介: 没有角色号', 1)).toEqual({});
  });

  it('正向命中的输出与改前逐字一致（无附加行时 contents 只有一行主名）', () => {
    const { monaco, model, regs } = fakeMonaco(['SIF GETBIT(A,0)']);
    installHover(monaco, () => tables);
    const hover = regs[0]!.provider.provideHover(
      model,
      { lineNumber: 1, column: 5 } as Monaco.Position,
      noopToken,
    ) as Monaco.languages.Hover;
    expect(hover.contents).toEqual([{ value: '**获取标记**（函数 · GETBIT）' }]);
  });

  it('正向优先于反向（原生记号那一侧的答案不变）', () => {
    expect(atFull('|GETBIT(A,0)')?.name).toBe('获取标记');
    expect(atFull('IF CFLAG:TARGET:|1088 >= 1')?.name).toBe('好感度');
    expect(atFull('时机 指令 |310：')?.name).toBe('亲吻');
  });

  it('反向经**同一个入口**出货（`resolveHoverName` 是正向 + 反向的唯一装配点）', () => {
    expect(atFull('IF |现在:噴乳 > 0')?.name).toBe('NOWEX');
    expect(atFull('时机 |指令 310：')?.name).toContain('M_KOJO');
  });

  it('表全缺席（未打开项目）⇒ 反向一路不显示（不猜）', () => {
    expect(atFull('IF |现在:噴乳 > 0', {}, K12)).toBeUndefined();
    expect(atFull('时机 |指令 310：', {}, K12)).toBeUndefined();
  });
});
