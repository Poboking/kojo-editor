/**
 * K2-LSP-CALLHIER · `kojo2` 调用层级（同文件 `@函` / `# 模`）行为闸。
 *
 * 覆盖面（按 describe 分组）：
 * - **prepare 声明位**：`@函` / `# 模` 的名字段与声明头都交回同一枚 item（真 span + 名字段）；
 * - **prepare 调用位**：`! 名(…)` 调用行、表达式里的 `名(…)`、台词插值里的 `{名(…)}`、
 *   场景里的 `! 模名(…)` 都落到**声明**；
 * - **prepare 拒答**：变量 / 幕 / 池不是可调用声明；`@原生` 体内、字符串字面量、注释、
 *   越界行列、非字符串源文一律 `null`；本地没有声明的调用位显式 `[]`（wiring 的跨文件请求）；
 * - **入边 / 出边**：同文件调用者 ↔ 被调者、精确的 `fromRanges`（`!` 行取词法名字偏移，
 *   表达式取表达式 span）、自递归 / 互递归各一条边、字符串里的同名文本不产边、未解析的
 *   外部名跳过；
 * - **上限**：调用点 / 返回组数封顶 {@link KOJO2_CALL_HIERARCHY_LIMIT}（200）；
 * - **provider 形状 / 异常回空**：三条腿齐全；与纯函数同结果；Monaco 0.57 没有 CallHierarchy
 *   API（PITFALLS §83）⇒ 本模块不注册任何东西，宿主面板直接拿 provider；取文抛错回空
 *   （prepare ⇒ `null`，边 ⇒ `[]`）；
 * - **确定性 / 卫生**：同输入逐字相等、CRLF 同结果、坏输入不抛；Monaco 只 type-only、
 *   不碰插件包。
 *
 * 夹具 `fixtures/kojo2/callhierarchy.kojo2` 刻意同时包含：自递归、互递归、显式 `!` 调用、
 * 表达式调用、插值调用、字符串里的同名文本、`@原生` 围栏、场景级调用（无调用者 item）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  KOJO2_CALL_HIERARCHY_LIMIT,
  createKojo2CallHierarchyProvider,
  kojo2IncomingCalls,
  kojo2OutgoingCalls,
  kojo2PrepareCallHierarchy,
  type Kojo2CallHierarchyItem,
  type Kojo2CallHierarchyPosition,
} from '../src/monaco/kojo2-callhierarchy';
import { kojo2DocumentOf, type Kojo2DeclarationKind } from '@kojo/kojo-lang';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang';

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'kojo2', 'callhierarchy.kojo2'),
  'utf8',
);
const DOCUMENT = kojo2DocumentOf(FIXTURE);

/* ============================== 小工具：坐标 ============================== */

/** 0 基偏移 → 1 基行列（夹具内） */
function positionAt(source: string, offset: number): Kojo2CallHierarchyPosition {
  const before = source.slice(0, offset);
  const lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}

/** 在 `source` 里找 `needle`（可指定命中的第几枚字符），返回 1 基行列 */
function positionAtNeedle(
  source: string,
  needle: string,
  offsetInNeedle = 0,
  from = 0,
): Kojo2CallHierarchyPosition {
  const at = source.indexOf(needle, from);
  if (at < 0) throw new Error(`源文里找不到 ${needle}`);
  return positionAt(source, at + offsetInNeedle);
}

/** 声明名字段的位置（声明索引给的列口径，不另算） */
function declarationPosition(
  kind: Kojo2DeclarationKind,
  name: string,
  source: string = FIXTURE,
): Kojo2CallHierarchyPosition {
  const declaration = kojo2DocumentOf(source).declarations.find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  if (declaration === undefined) throw new Error(`夹具缺少 ${kind}:${name}`);
  return { line: declaration.line, column: declaration.nameStart };
}

/** 声明处 prepare，必须恰好一枚 item */
function itemAtDeclaration(
  kind: Kojo2DeclarationKind,
  name: string,
  source: string = FIXTURE,
): Kojo2CallHierarchyItem {
  const result = kojo2PrepareCallHierarchy(source, declarationPosition(kind, name, source));
  expect(result, `${kind}:${name} 没有 call hierarchy item`).not.toBeNull();
  expect(result).toHaveLength(1);
  return result![0]!;
}

function namesOfIncoming(
  source: string,
  item: Kojo2CallHierarchyItem,
): readonly string[] {
  return (kojo2IncomingCalls(source, item) ?? []).map((call) => call.from.name);
}

function namesOfOutgoing(
  source: string,
  item: Kojo2CallHierarchyItem,
): readonly string[] {
  return (kojo2OutgoingCalls(source, item) ?? []).map((call) => call.to.name);
}

/* ============================== 假 model ============================== */

interface FakeModel {
  readonly model: Monaco.editor.ITextModel;
  readonly breakModel: () => void;
}

function fakeModel(text: string): FakeModel {
  let broken = false;
  const model = {
    getValue: () => {
      if (broken) throw new Error('桩：模型已释放');
      return text;
    },
    getLineCount: () => text.split(/\r\n|\r|\n/).length,
    isDisposed: () => broken,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
  } as unknown as Monaco.editor.ITextModel;
  return { model, breakModel: () => void (broken = true) };
}

/** 纯模型的 1 基行列 → Monaco `Position`（provider 面只认 `lineNumber` / `column`） */
function monacoPosition(position: Kojo2CallHierarchyPosition): Monaco.Position {
  return { lineNumber: position.line, column: position.column } as Monaco.Position;
}

/* ============================== ① prepare：声明位 ============================== */

describe('prepare：`@函` / `# 模` 声明位交回同一枚 item', () => {
  it('`@函` 名字段 → item（真 span + 名字段 + data）', () => {
    const item = itemAtDeclaration('function', '阶乘');
    expect(item).toEqual({
      name: '阶乘',
      kind: 'function',
      range: { startLine: 2, startColumn: 1, endLine: 6, endColumn: 25 },
      selectionRange: { startLine: 2, startColumn: 4, endLine: 2, endColumn: 6 },
      data: { name: '阶乘', declarationKind: 'function', line: 2, nameStart: 4, nameEnd: 6 },
    });
  });

  it('`@函` 声明头（光标在 `@函` 词上）也认同一枚 item', () => {
    const header = kojo2PrepareCallHierarchy(FIXTURE, { line: 2, column: 1 });
    expect(header).toEqual(kojo2PrepareCallHierarchy(FIXTURE, declarationPosition('function', '阶乘')));
  });

  it('`# 模` 名字段 → item（kind 仍是 function，真种类在 data.declarationKind）', () => {
    const item = itemAtDeclaration('template', '问候');
    expect(item.kind).toBe('function');
    expect(item.data.declarationKind).toBe('template');
    expect(item.range).toEqual({ startLine: 26, startColumn: 1, endLine: 29, endColumn: 12 });
    expect(item.selectionRange).toEqual({
      startLine: 26,
      startColumn: 5,
      endLine: 26,
      endColumn: 7,
    });
  });

  it('`# 模` 声明头也认', () => {
    const header = kojo2PrepareCallHierarchy(FIXTURE, { line: 26, column: 1 });
    expect(header?.[0]?.name).toBe('问候');
    expect(header?.[0]?.data.declarationKind).toBe('template');
  });

  it('每枚 item 的 range 都完整包住 selectionRange', () => {
    const item = itemAtDeclaration('template', '无人问津');
    const startsBefore =
      item.range.startLine < item.selectionRange.startLine ||
      (item.range.startLine === item.selectionRange.startLine &&
        item.range.startColumn <= item.selectionRange.startColumn);
    const endsAfter =
      item.range.endLine > item.selectionRange.endLine ||
      (item.range.endLine === item.selectionRange.endLine &&
        item.range.endColumn >= item.selectionRange.endColumn);
    expect(startsBefore).toBe(true);
    expect(endsAfter).toBe(true);
  });

  it('非可调用声明 → null（常量 / 幕 / 注释）', () => {
    expect(kojo2PrepareCallHierarchy(FIXTURE, declarationPosition('constant', '计数'))).toBeNull();
    expect(kojo2PrepareCallHierarchy(FIXTURE, declarationPosition('scene', '问候场景'))).toBeNull();
    expect(kojo2PrepareCallHierarchy(FIXTURE, { line: 1, column: 5 })).toBeNull();
  });
});

/* ============================== ② prepare：调用位 ============================== */

describe('prepare：调用位落到**声明**（不是调用行）', () => {
  it('`! 名(…)` 调用行的名字 → 被调函数声明', () => {
    const position = positionAtNeedle(FIXTURE, '! 阶乘(n)', 2);
    const result = kojo2PrepareCallHierarchy(FIXTURE, position);
    expect(result?.[0]?.name).toBe('阶乘');
    expect(result?.[0]?.selectionRange).toEqual({
      startLine: 2,
      startColumn: 4,
      endLine: 2,
      endColumn: 6,
    });
  });

  it('表达式里的 `名(…)`（`@返` 里的递归调用）→ 声明', () => {
    const position = positionAtNeedle(FIXTURE, '阶乘(n - 1)');
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)?.[0]?.name).toBe('阶乘');
  });

  it('台词 / 旁白 `{…}` 插值里的调用 → 声明', () => {
    const position = positionAtNeedle(FIXTURE, '共{阶乘(2)}', 2);
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)?.[0]?.name).toBe('阶乘');
  });

  it('场景里的 `! 模名(…)` 调用 → 模声明（`# 模` 也进调用层级）', () => {
    const position = positionAtNeedle(FIXTURE, '! 问候(灵梦)', 2);
    const result = kojo2PrepareCallHierarchy(FIXTURE, position);
    expect(result?.[0]?.name).toBe('问候');
    expect(result?.[0]?.data.declarationKind).toBe('template');
  });

  it('模体内的 `! 函名(…)` 调用 → 函声明', () => {
    const position = positionAtNeedle(FIXTURE, '! 入口(1)', 2);
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)?.[0]?.name).toBe('入口');
  });
});

/* ============================== ③ prepare：拒答与显式空 ============================== */

describe('prepare：字符串 / `@原生` / 外部名 / 坏输入', () => {
  it('字符串字面量里的同名文本 → null（不是调用）', () => {
    const position = positionAtNeedle(FIXTURE, '阶乘(1)"');
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)).toBeNull();
  });

  it('`@原生` 围栏体内（即使写着 `! 入口(1)`）→ null', () => {
    const from = FIXTURE.indexOf('@原生');
    const position = positionAtNeedle(FIXTURE, '! 入口(1)', 2, from);
    expect(position.line).toBeGreaterThan(36);
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)).toBeNull();
  });

  it('本文件没有声明的调用位 → 显式 `[]`（跨文件 / adapter 基础库的 wiring 请求）', () => {
    const position = positionAtNeedle(FIXTURE, '! 外部函数(n)', 2);
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)).toEqual([]);
  });

  it('普通叙事正文（不是调用）→ null', () => {
    const position = positionAtNeedle(FIXTURE, '> 正文', 2);
    expect(kojo2PrepareCallHierarchy(FIXTURE, position)).toBeNull();
  });

  it('越界行列 / 非法位点 / 非字符串源文 → null（运行时兜底，不抛）', () => {
    expect(kojo2PrepareCallHierarchy(FIXTURE, { line: 9_999, column: 1 })).toBeNull();
    expect(kojo2PrepareCallHierarchy(FIXTURE, { line: 0, column: 1 })).toBeNull();
    expect(kojo2PrepareCallHierarchy(FIXTURE, { line: 2, column: 0 })).toBeNull();
    expect(kojo2PrepareCallHierarchy(FIXTURE, { line: Number.NaN, column: 1 })).toBeNull();
    expect(kojo2PrepareCallHierarchy('', { line: 1, column: 1 })).toBeNull();
    expect(
      kojo2PrepareCallHierarchy(null as unknown as string, { line: 1, column: 1 }),
    ).toBeNull();
  });
});

/* ============================== ④ 入边 ============================== */

describe('入边：本文件里谁调用了它（含自递归 / 互递归 / 模板调用者）', () => {
  it('阶乘的四条入边按源码序：自递归 + 入口 + 插值陷阱 + 问候（模）', () => {
    const incoming = kojo2IncomingCalls(FIXTURE, itemAtDeclaration('function', '阶乘'));
    expect(incoming?.map((call) => call.from.name)).toEqual([
      '阶乘',
      '入口',
      '插值陷阱',
      '问候',
    ]);
    expect(incoming?.[3]?.from.data.declarationKind).toBe('template');
  });

  it('`!` 调用点的 fromRanges 是**精确名字段**；表达式调用取表达式 span', () => {
    const incoming = kojo2IncomingCalls(FIXTURE, itemAtDeclaration('function', '阶乘'));
    const fromSelf = incoming?.find((call) => call.from.name === '阶乘');
    expect(fromSelf?.fromRanges).toEqual([
      { startLine: 6, startColumn: 12, endLine: 6, endColumn: 25 },
    ]);
    const fromEntry = incoming?.find((call) => call.from.name === '入口');
    expect(fromEntry?.fromRanges).toEqual([
      { startLine: 15, startColumn: 7, endLine: 15, endColumn: 9 },
    ]);
    const fromTemplate = incoming?.find((call) => call.from.name === '问候');
    expect(fromTemplate?.fromRanges).toEqual([
      { startLine: 28, startColumn: 7, endLine: 28, endColumn: 9 },
    ]);
  });

  it('互递归：甲的入边 = 乙 + 入口（各一条）', () => {
    expect(namesOfIncoming(FIXTURE, itemAtDeclaration('function', '甲'))).toEqual(['乙', '入口']);
  });

  it('场景级调用没有可调用的调用者 ⇒ 模的入边显式 `[]`（不伪造场景 item）', () => {
    expect(kojo2IncomingCalls(FIXTURE, itemAtDeclaration('template', '问候'))).toEqual([]);
  });

  it('没有入边的声明 ⇒ `[]`', () => {
    expect(kojo2IncomingCalls(FIXTURE, itemAtDeclaration('template', '无人问津'))).toEqual([]);
  });

  it('认不出的 item ⇒ `null`（无 data / 行号漂了 / 真种类不符）', () => {
    const real = itemAtDeclaration('function', '阶乘');
    expect(kojo2IncomingCalls(FIXTURE, null as unknown as Kojo2CallHierarchyItem)).toBeNull();
    expect(
      kojo2IncomingCalls(FIXTURE, { ...real, data: undefined } as unknown as Kojo2CallHierarchyItem),
    ).toBeNull();
    expect(
      kojo2IncomingCalls(FIXTURE, { ...real, data: { ...real.data, line: 999 } }),
    ).toBeNull();
    expect(
      kojo2IncomingCalls(FIXTURE, {
        ...real,
        data: { ...real.data, declarationKind: 'template' },
      }),
    ).toBeNull();
    expect(
      kojo2IncomingCalls(FIXTURE, {
        ...real,
        data: { ...real.data, name: '不存在' },
      }),
    ).toBeNull();
  });
});

/* ============================== ⑤ 出边 ============================== */

describe('出边：它调用了谁（自递归 / 互递归 / 外部名跳过）', () => {
  it('自递归：阶乘只调自己（一条边，不展开成环）', () => {
    const outgoing = kojo2OutgoingCalls(FIXTURE, itemAtDeclaration('function', '阶乘'));
    expect(outgoing?.map((call) => call.to.name)).toEqual(['阶乘']);
    expect(outgoing?.[0]?.fromRanges).toEqual([
      { startLine: 6, startColumn: 12, endLine: 6, endColumn: 25 },
    ]);
  });

  it('互递归：甲 → 乙、乙 → 甲（各一条，调用即止）', () => {
    const mutual = [
      namesOfOutgoing(FIXTURE, itemAtDeclaration('function', '甲')),
      namesOfOutgoing(FIXTURE, itemAtDeclaration('function', '乙')),
    ];
    expect(mutual).toEqual([['乙'], ['甲']]);
  });

  it('模板的出边：阶乘 + 入口（按被调声明行排序）', () => {
    const outgoing = kojo2OutgoingCalls(FIXTURE, itemAtDeclaration('template', '问候'));
    expect(outgoing?.map((call) => call.to.name)).toEqual(['阶乘', '入口']);
    expect(outgoing?.[1]?.to.selectionRange.startLine).toBe(14);
  });

  it('外部名（本文件没有声明）不进边，其余照常', () => {
    expect(namesOfOutgoing(FIXTURE, itemAtDeclaration('function', '入口'))).toEqual([
      '阶乘',
      '甲',
    ]);
  });

  it('字符串里的同名文本不产边；插值里的表达式产边', () => {
    expect(namesOfOutgoing(FIXTURE, itemAtDeclaration('function', '字符串陷阱'))).toEqual([]);
    expect(namesOfOutgoing(FIXTURE, itemAtDeclaration('function', '插值陷阱'))).toEqual([
      '阶乘',
    ]);
  });

  it('没有出边的声明 ⇒ `[]`；认不出的 item ⇒ `null`', () => {
    const quiet = itemAtDeclaration('template', '无人问津');
    expect(kojo2OutgoingCalls(FIXTURE, quiet)).toEqual([]);
    expect(
      kojo2OutgoingCalls(FIXTURE, {
        ...quiet,
        data: { ...quiet.data, line: 999 },
      }),
    ).toBeNull();
  });
});

/* ============================== ⑥ 上限 ============================== */

/** 生成"驱动函数 + N 个空函数"的源文（每枚被调函数一条 `! 名()` 调用点）。 */
function generatedDriverSource(calleeCount: number): string {
  const lines = ['@函 驱动()'];
  for (let index = 0; index < calleeCount; index++) lines.push(`    ! 目标${index}()`);
  for (let index = 0; index < calleeCount; index++) {
    lines.push(`@函 目标${index}()`, '    @返 0');
  }
  return lines.join('\n');
}

/** 生成"热点函数 + 一个连调 N 次的调用者"的源文。 */
function generatedHotspotSource(callCount: number): string {
  const lines = ['@函 热点()', '    @返 1', '@函 驱动()'];
  for (let index = 0; index < callCount; index++) lines.push('    ! 热点()');
  return lines.join('\n');
}

describe('上限：调用点与返回组数封顶 200', () => {
  it('出边组数封顶 200（250 个可调用被调者只交前 200 组）', () => {
    const source = generatedDriverSource(250);
    const outgoing = kojo2OutgoingCalls(source, itemAtDeclaration('function', '驱动', source));
    expect(outgoing).toHaveLength(KOJO2_CALL_HIERARCHY_LIMIT);
    expect(outgoing?.[0]?.to.name).toBe('目标0');
    expect(outgoing?.[KOJO2_CALL_HIERARCHY_LIMIT - 1]?.to.name).toBe('目标199');
  });

  it('单组 fromRanges 封顶 200（250 个调用点只交前 200 个）', () => {
    const source = generatedHotspotSource(250);
    const incoming = kojo2IncomingCalls(source, itemAtDeclaration('function', '热点', source));
    expect(incoming).toHaveLength(1);
    expect(incoming?.[0]?.fromRanges).toHaveLength(KOJO2_CALL_HIERARCHY_LIMIT);
  });
});

/* ============================== ⑦ provider 形状 / 异常回空 ============================== */

describe('provider：形状、与纯函数一致、取文抛错回空', () => {
  it('provider 形状：displayName + 三条腿都是函数', () => {
    const provider = createKojo2CallHierarchyProvider();
    expect(provider.displayName).toBe('kojo2');
    expect(typeof provider.prepareCallHierarchy).toBe('function');
    expect(typeof provider.provideCallHierarchyIncomingCalls).toBe('function');
    expect(typeof provider.provideCallHierarchyOutgoingCalls).toBe('function');
  });

  it('provider 在同一枚 model 上给出与纯函数一致的 item / 入边 / 出边', () => {
    const provider = createKojo2CallHierarchyProvider();
    const model = fakeModel(FIXTURE).model;
    const position = monacoPosition(declarationPosition('function', '阶乘'));
    const items = provider.prepareCallHierarchy(model, position);
    expect(items?.[0]).toEqual(itemAtDeclaration('function', '阶乘'));
    expect(
      provider.provideCallHierarchyIncomingCalls(model, items![0]!)?.map((call) => call.from.name),
    ).toEqual(['阶乘', '入口', '插值陷阱', '问候']);
    expect(
      provider.provideCallHierarchyOutgoingCalls(model, items![0]!)?.map((call) => call.to.name),
    ).toEqual(['阶乘']);
  });

  it('取文抛错 / 模型已释放 ⇒ prepare `null`、入边 / 出边 `[]`（不抛进 Monaco）', () => {
    const provider = createKojo2CallHierarchyProvider();
    const broken = fakeModel(FIXTURE);
    broken.breakModel();
    const item = itemAtDeclaration('function', '阶乘');
    const position = monacoPosition(declarationPosition('function', '阶乘'));
    expect(provider.prepareCallHierarchy(broken.model, position)).toBeNull();
    expect(provider.provideCallHierarchyIncomingCalls(broken.model, item)).toEqual([]);
    expect(provider.provideCallHierarchyOutgoingCalls(broken.model, item)).toEqual([]);
  });
});

/* ============================== ⑧ 确定性 / 坏输入 ============================== */

describe('确定性：同输入必同输出、CRLF 同结果、坏输入不抛', () => {
  it('两次调用逐字相等（item / 入边 / 出边）', () => {
    const item = itemAtDeclaration('function', '甲');
    expect(itemAtDeclaration('function', '甲')).toEqual(item);
    const calls = kojo2IncomingCalls(FIXTURE, item);
    expect(kojo2IncomingCalls(FIXTURE, item)).toEqual(calls);
    expect(kojo2OutgoingCalls(FIXTURE, item)).toEqual(kojo2OutgoingCalls(FIXTURE, item));
  });

  it('CRLF 与 LF 同结果（换行不是调用语义）', () => {
    const crlf = FIXTURE.replace(/\n/g, '\r\n');
    const lfItem = itemAtDeclaration('function', '阶乘');
    const crlfItem = itemAtDeclaration('function', '阶乘', crlf);
    expect(crlfItem).toEqual(lfItem);
    expect(kojo2IncomingCalls(crlf, crlfItem)).toEqual(kojo2IncomingCalls(FIXTURE, lfItem));
  });

  it('空 / 坏源文：prepare `null`、入边 / 出边 `null`（不猜）', () => {
    const item = itemAtDeclaration('function', '阶乘');
    for (const source of ['', '   \n\t\n', '这不是 Kojo 2.0\n???\n###\n']) {
      expect(kojo2PrepareCallHierarchy(source, { line: 1, column: 1 })).toBeNull();
      expect(kojo2IncomingCalls(source, item)).toBeNull();
      expect(kojo2OutgoingCalls(source, item)).toBeNull();
    }
  });

  it('坏输入永不抛（未闭合围栏 / 混合换行 / 超长行）', () => {
    const item = itemAtDeclaration('function', '阶乘');
    const sources = [
      '@原生\n    CALL X\n',
      '@函 甲(n)\n    @返 甲(\n',
      `@函 超长()\n    @返 ${'甲'.repeat(500)}(1)\n`,
      '# 幕 甲\r\n@函 乙()\r\n    ! 乙()\r\n',
    ];
    for (const source of sources) {
      expect(() => kojo2IncomingCalls(source, item)).not.toThrow();
      expect(() => kojo2OutgoingCalls(source, item)).not.toThrow();
    }
  });
});

/* ============================== ⑨ 源码卫生 ============================== */

describe('源码卫生：Monaco 只 type-only、不碰插件包、不自建注册器', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'monaco', 'kojo2-callhierarchy.ts'),
    'utf8',
  );

  it('Monaco 运行时只许 type-only 引入（node 池不把 monaco 拉进模块图）', () => {
    expect(source).toMatch(/import type \* as Monaco from '\.\/entry'/);
    expect(source).not.toMatch(/import \* as Monaco from/);
    expect(source).not.toMatch(/from 'monaco-editor'/);
  });

  it('不 import 任何插件包、不出现游戏名词', () => {
    expect(source).not.toMatch(/from\s+['"]@kojo\/plugin-/);
    expect(source).not.toMatch(/\b(eratw|eraK|eraSQN|eraNAS)\b/i);
  });

  it('不读切流开关（语言面），也不自建注册器（0.57 无 API ⇒ 只剩 provider 工厂）', () => {
    expect(source).not.toMatch(/isKojo2CutoverEnabled/);
    expect(source).not.toMatch(/export function installKojo2/);
    expect(source).not.toMatch(/registerCallHierarchyProvider\(/);
    expect(source).toMatch(/export function createKojo2CallHierarchyProvider\(/);
  });
});
