/**
 * KW-38：`missing-var` 与 `call-context` 两族的**作者文案分档**判据（真语料逐枚归族见提交信息）。
 *
 * 这一格补的是"屏上那句话说的是不是事实"：
 * - `missing-var` 一枚码底下是四种事实（KW-34 归族 42 / 30 / 9 / 已收 2；本车按**当场拿得到的**
 *   形状重新数成 A 调用参数别名 34 / B 本函数正文 `#DIM` 声明 6 / C 底座 41），旧那句
 *   「存档里没有这个变量」对 C 里最大的一族是假话（那种量从不落盘，不是"这个档缺它"）、
 *   对 A 是误导（把人推向一个并不存在的"补存档 / 填场景参数"入口）；
 * - `call-context` 三处发点说的是三种事实（846 未提供 / 12 未覆盖 / 0 槽号不合），
 *   旧文案只给因果不给出口。
 *
 * **硬红线**：本文件每一枚都只盯文案与"结果形状不许变"（`kind` / `code` / 条数 / 同一对象返回），
 * 判定口径的逐码对拍归 `packages/kernel/tests/integration-plugins.test.ts` 的打印。
 */
import { describe, expect, it } from 'vitest';
import type {
  ArchiveCharacterBlock,
  ArchiveVariable,
  BranchChainOutcome,
  FunctionReplay,
  PredicateReplay,
  ReplayValue,
  SnapshotArchive,
  VariableRef,
} from '@kojo/plugin-api';
import { createStateView, type SchemaLookup } from '../src/state-view';
import {
  UNKNOWN_NAME_LEAD,
  annotateMissingVar,
  dimDeclarationLine,
  hasUnknownNameSite,
  headerArgAliasNames,
  unknownNameFromMessage,
} from '../src/missing-var-facts';
import { createFunctionOverlay } from '../src/locals';
import type { FunctionPredicates } from '@kojo/plugin-api';

function scalarInt(key: string, value: number): ArchiveVariable {
  return { type: 'int', key, value, offset: 0 };
}
function int1d(key: string, saveLen: number, cells: [number, number][]): ArchiveVariable {
  return {
    type: 'int-array-1d',
    key,
    saveLen: [saveLen],
    cursor: [saveLen],
    nonEmpty: cells.length,
    cells: cells.map(([i, v]) => ({ index: [i], value: v })),
    offset: 0,
  };
}
function block(index: number, vars: ArchiveVariable[]): ArchiveCharacterBlock {
  return { index, dimSepIndex: null, vars };
}
function archive(): SnapshotArchive {
  return {
    path: 'D:/fake/sav/save01.sav',
    fileName: 'save01.sav',
    size: 0,
    format: 'gzip',
    version: 1808,
    fileType: 'normal',
    uniqueCode: '7153',
    gameVersion: '0',
    saveMes: '',
    charCount: 1,
    decompressedSize: 0,
    bodySize: 0,
    consumed: 0,
    remaining: 0,
    chars: [block(0, [scalarInt('NO', 49), int1d('CFLAG', 100, [[2, 800]]), int1d('DISH_DRG', 1, [])])],
    vars: [int1d('DAY', 1000, [[0, 47]]), int1d('MAGIC_DLC', 1, [])],
  };
}
const ref = (name: string, indices: string[] = []): VariableRef => ({
  name,
  indices,
  text: indices.length > 0 ? `${name}:${indices.join(':')}` : name,
});
const dict: SchemaLookup = (name, index) =>
  name === 'FLAG' ? { name, index, description: '有名表但此名不在表内' } : undefined;
const viewWithDict = () => createStateView({ archive: archive(), characterNo: 49, lookup: dict });
const viewNoDict = () => createStateView({ archive: archive(), characterNo: 49 });

/** 取 unknown 的 message（非 unknown 直接判红——本文件不许拿值结果凑数） */
function messageOf(v: ReplayValue): string {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(v)}`);
  return v.unknown.message;
}
function codeOf(v: ReplayValue): string {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(v)}`);
  return v.unknown.code;
}

/** 最小 FunctionReplay 夹具（上妆 pass 只认 predicates / branches 这两处引用） */
function replayWith(
  entries: { readonly line: number; readonly value: ReplayValue }[],
  branchOf?: number,
): { replay: FunctionReplay; predicates: PredicateReplay[]; branch: BranchChainOutcome | null } {
  const predicates: PredicateReplay[] = entries.map((e) => ({
    kind: 'IF',
    text: `${e.line}`,
    line: e.line,
    outcome: e.value.kind === 'unknown' ? { kind: 'unknown', unknown: e.value.unknown } : e.value,
    expr: { kind: 'literal', value: 1, text: '1' },
  }));
  const branch: BranchChainOutcome | null =
    branchOf === undefined
      ? null
      : {
          kind: 'if-chain',
          headLine: entries[branchOf]!.line,
          depth: 0,
          members: [],
          takenLine: null,
          outcome: 'unknown',
          // 分支链引用**同一个 unknown 对象**（branches.ts 就是直接取谓词的 outcome.unknown）
          ...(predicates[branchOf]!.outcome.kind === 'unknown'
            ? { unknown: predicates[branchOf]!.outcome.unknown }
            : {}),
        };
  const replay: FunctionReplay = {
    normalizedName: 'F_TEST',
    filePath: 'D:/fake/M_KOJO_K49_TEST.ERB',
    startLine: 5,
    predicates,
    branches: branch ? [branch] : [],
    stats: { total: predicates.length, hit: 0, miss: 0, unknown: predicates.length },
    confidence: 'unknown',
  };
  return { replay, predicates, branch };
}

describe('KW-38 C 档底座句——未知名发点只说自己查过的东西', () => {
  const msg = messageOf(viewWithDict().read(ref('ACTIVITY_TYPE')));

  it('机器码与结果形状不变（只换文案），起手就是 C 档标记', () => {
    const v = viewWithDict().read(ref('ACTIVITY_TYPE'));
    expect(v.kind).toBe('unknown');
    expect(codeOf(v)).toBe('missing-var');
    expect(msg.startsWith(UNKNOWN_NAME_LEAD)).toBe(true);
  });

  it('说出查过的两本帐与逐字口径（不再是一句"存档里没有这个变量"）', () => {
    expect(msg.includes('全局变量区 2 格')).toBe(true);
    expect(msg.includes('这个角色块 3 格')).toBe(true);
    expect(msg.includes('逐字没有同名的一格')).toBe(true);
    expect(msg.includes('引擎的内置变量清单里也没有它')).toBe(true);
  });

  it('说出"分不出两种、因为不读声明表"——不许对从不落盘那一族假称"这个档缺它"', () => {
    expect(msg.includes('SAVEDATA')).toBe(true);
    expect(msg.includes('不读别的文件里的声明表')).toBe(true);
    expect(msg.includes('说不出')).toBe(true);
    expect(msg.includes('不拿 0 或别的档的值凑')).toBe(true);
    expect(msg.includes('存档里没有这个变量')).toBe(false);
  });

  it('名字表在位与不在位是两句不同的话（拿不到就照实说拿不到）', () => {
    expect(msg.includes('名字表也没答出它是写死的常量')).toBe(true);
    const absent = messageOf(viewNoDict().read(ref('ACTIVITY_TYPE')));
    expect(absent.includes('没有变量名字表可问')).toBe(true);
    expect(absent.includes('名字表也没答出')).toBe(false);
  });

  it('底座句里的名字能被解析回来（文案与解析单一真源，改文案不会静默失妆）', () => {
    expect(unknownNameFromMessage(msg)).toBe('ACTIVITY_TYPE');
    expect(unknownNameFromMessage('角色块中无变量：X')).toBe(null);
  });
});

describe('KW-38 A 档——函数声明行的参数别名（真语料 34 枚）', () => {
  const lines = [
    ';注释',
    '@M_KOJO_MESSAGE_COM_K49_DANMAKU(ARGS, 对方残机, ARG:1)',
    '#DIM 对方残机',
    'IF 对方残机 >= 3',
  ];

  it('参数表里列着它 ⇒ 换成"这次调用带进来的参数"，并指到那一行', () => {
    const c = viewNoDict().read(ref('对方残机'));
    const { replay, predicates } = replayWith([{ line: 4, value: c }]);
    const out = annotateMissingVar(replay, { lines, startLine: 2, endLine: 4 });
    const o = out.predicates[0]!.outcome;
    expect(o.kind === 'unknown' ? o.unknown.code : 'FLIPPED').toBe('missing-var');
    const text = o.kind === 'unknown' ? o.unknown.message : '';
    expect(text.includes('这次调用带进来的参数')).toBe(true);
    expect(text.includes('第 2 行')).toBe(true);
    expect(text.includes('不猜')).toBe(true);
    expect(predicates.length).toBe(1);
  });

  it('不许把别名说成能填的槽：明说「场景参数」只认 ARG/ARGS 原名（旧文案的误导就在这一格）', () => {
    const c = viewNoDict().read(ref('对方残机'));
    const { replay } = replayWith([{ line: 4, value: c }]);
    const text = messageOfResult(annotateMissingVar(replay, { lines, startLine: 2, endLine: 4 }).predicates[0]!.outcome);
    expect(text.includes('只认 ARG / ARGS 的原名')).toBe(true);
    expect(text.includes('没有能填的入口')).toBe(true);
  });

  it('槽位本身（ARG / ARGS）不算别名——它走 call-context 那一族的话', () => {
    const alias = headerArgAliasNames(['@F(ARG, ARGS, LOCAL:1, 0, "文字列", 名字)'], 1);
    expect(alias).not.toBeNull();
    expect([...alias!.names]).toEqual(['名字']);
  });

  it('没有 `@名(参数表)` 形状就不上妆（宁可不多说）', () => {
    expect(headerArgAliasNames(['#FUNCTION'], 1)).toBe(null);
    expect(headerArgAliasNames(['@F'], 1)).toBe(null);
    expect(headerArgAliasNames(['; @F(名字)'], 1)).toBe(null);
  });

  it('分支链引用的同一条 unknown 一起换（屏上两处不许读到两种说法）', () => {
    const c = viewNoDict().read(ref('对方残机'));
    const { replay } = replayWith([{ line: 4, value: c }], 0);
    const out = annotateMissingVar(replay, { lines, startLine: 2, endLine: 4 });
    expect(out.branches[0]!.unknown!.message).toBe(out.predicates[0]!.outcome.kind === 'unknown' ? out.predicates[0]!.outcome.unknown.message : '');
    expect(out.branches[0]!.outcome).toBe('unknown');
  });
});

describe('KW-38 B 档——本函数正文里的 #DIM 声明（真语料 6 枚）', () => {
  const lines = ['@F(ARG,ARG:1)', '#DIM  LAST_LOVEPOINT', ';别的函数的事', 'IF LAST_LOVEPOINT > 5'];

  it('声明行在正文区间内 ⇒ 说"本函数自己开的"，并给出那一行，但不冒充知道作用域', () => {
    const c = viewNoDict().read(ref('LAST_LOVEPOINT'));
    const { replay } = replayWith([{ line: 4, value: c }]);
    const text = messageOfResult(annotateMissingVar(replay, { lines, startLine: 1, endLine: 4 }).predicates[0]!.outcome);
    expect(text.includes('本函数自己用 #DIM 开出来的')).toBe(true);
    expect(text.includes('第 2 行的声明')).toBe(true);
    expect(text.includes('跟不到 #DIM 开的量')).toBe(true);
    // 不许编：Emuera 的 #DIM 作用域口径本编辑器没有实证
    expect(text.includes('私有变量')).toBe(false);
    expect(text.includes('每次调用清零')).toBe(false);
  });

  it('A 优先于 B（参数表里列着就按"调用实参"说，那是更硬的事实）', () => {
    const both = ['@F(前戯１, ARG:1)', '#DIM 前戯１', 'IF 前戯１ > 1'];
    const c = viewNoDict().read(ref('前戯１'));
    const { replay } = replayWith([{ line: 3, value: c }]);
    const text = messageOfResult(annotateMissingVar(replay, { lines: both, startLine: 1, endLine: 3 }).predicates[0]!.outcome);
    expect(text.includes('这次调用带进来的参数')).toBe(true);
  });

  it('声明行判定的形状：`;` 注释形态不算、关键字要跳过、越过 endLine 不算', () => {
    const ls = ['@F', ';#DIM X', '#DIM DYNAMIC Y', 'IF X'];
    expect(dimDeclarationLine(ls, 'X', 1, 4)).toBe(null);
    expect(dimDeclarationLine(ls, 'Y', 1, 4)).toBe(3);
    expect(dimDeclarationLine(['#DIM X', '@F'], 'X', 2, 2)).toBe(null);
  });
});

describe('KW-38 上妆 pass 的零判定形状（一枚都不许多翻、许多改）', () => {
  const aliasLines = ['@F(对方残机)', '#DIM 对方残机', 'IF 对方残机 > 1'];

  it('没有 C 档点位 ⇒ 返回**同一个对象**（热路径零复制、零副作用）', () => {
    const v = viewWithDict().read(ref('CFLAG', ['2']));
    expect(v.kind).toBe('value');
    const { replay } = replayWith([{ line: 3, value: v }]);
    expect(annotateMissingVar(replay, { lines: aliasLines, startLine: 1, endLine: 3 })).toBe(replay);
    expect(hasUnknownNameSite(replay)).toBe(false);
  });

  it:'只换 message，kind / code / 谓词条数 / 未上妆的那几条原对象一概不动', () => {
    const c = viewNoDict().read(ref('对方残机'));
    const other = viewNoDict().read(ref('DAY', ['9'])); // index-oob：不该被碰
    const { replay, predicates } = replayWith([{ line: 3, value: c }, { line: 9, value: other }]);
    const out = annotateMissingVar(replay, { lines: aliasLines, startLine: 1, endLine: 3 });
    expect(out.predicates.length).toBe(2);
    expect(out.stats).toBe(replay.stats);
    expect(out.predicates[1]).toBe(predicates[1]);
    expect(codeOfResult(out.predicates[0]!.outcome)).toBe('missing-var');
    expect(out.predicates[0]!.outcome.kind).toBe('unknown');
    expect(out.predicates[1]!.outcome.kind).toBe('unknown');
  });

  it('另外三处 missing-var 发点的文案起手不是 C 档标记 ⇒ 上妆不会覆盖它们', () => {
    const noBlock = messageOf(viewNoDict().read(ref('CFLAG', ['120', '2'])));
    const noCharaVar = messageOf(viewNoDict().read(ref('CFLAG', ['0', '77'])));
    expect(noBlock.startsWith(UNKNOWN_NAME_LEAD)).toBe(false);
    expect(noCharaVar.startsWith(UNKNOWN_NAME_LEAD)).toBe(false);
    expect(codeOf(viewNoDict().read(ref('CFLAG', ['120', '2'])))).toBe('missing-var');
    expect(codeOf(viewNoDict().read(ref('CFLAG', ['0', '77'])))).toBe('missing-var');
  });
});

describe('KW-38 另外三处发点各说各的帐（真语料 0 枚，形状仍须说得出口）', () => {
  it('整块角色不在档里 ⇒ 说"缺的不是这一格"，并给本档块数', () => {
    const text = messageOf(viewNoDict().read(ref('CFLAG', ['120', '2'])));
    expect(text.includes('整个角色都不在这张档里')).toBe(true);
    expect(text.includes('本档共 1 个角色块')).toBe(true);
    expect(text.includes('换一张有它的存档')).toBe(true);
  });

  it('角色块里没这一格 ⇒ 明说"内置名缺格才按 0/空串，它不在那份清单里"，不许让人以为有默认值', () => {
    const text = messageOf(viewNoDict().read(ref('CFLAG', ['0', '77'])));
    expect(text.includes('引擎内置的角色变量清单')).toBe(true);
    expect(text.includes('不默认 0')).toBe(true);
    expect(text.includes('不拿别的角色的同名格顶上')).toBe(true);
  });

  it('全局区缺内置量 ⇒ 说的是"这张帐的口径不含它"，与"作者自开的量不落盘"分开', () => {
    // 夹具里没有真会走到这处的名字（内置全局缺格大多有 0 默认），用视图内部同款口径直取：
    // 取一个 `isKnownGlobalVariable` 不认、却以 global 形态解析到的名字不可得 ⇒ 断言该发点
    // 与 C 档起手不同即可（形状钉住，读数留仓内集成测试）。
    const text = messageOf(viewNoDict().read(ref('DAY', ['9'])));
    expect(codeOf(viewNoDict().read(ref('DAY', ['9'])))).toBe('index-oob');
    expect(text.startsWith(UNKNOWN_NAME_LEAD)).toBe(false);
  });
});

describe('KW-38 call-context 三处发点各带自己的出口（846 / 12 / 0 枚）', () => {
  const detail = (assignments: FunctionPredicates['assignments']): FunctionPredicates => ({
    normalizedName: 'F_TEST',
    filePath: 'D:/fake/M_KOJO_K49_TEST.ERB',
    startLine: 1,
    endLine: 10,
    statements: [],
    predicates: [],
    assignments,
    returns: [],
  });
  const argRef = (indices: string[] = []): VariableRef => ({
    name: 'ARG',
    indices,
    text: indices.length > 0 ? `ARG:${indices.join(':')}` : 'ARG',
  });
  const at = { line: 5, context: [] };

  it('未注入上下文 ⇒ 因果之后要点名"填哪一格"（槽号是当场算出来的事实）', () => {
    const overlay = createFunctionOverlay({ detail: detail([{ name: 'LOCAL', index: 0, line: 2, context: [], expr: { kind: 'literal', value: 1, text: '1' } }]), baseRead: () => ({ kind: 'value', value: 0 }) });
    expect(overlay).not.toBeNull();
    const text = messageOfResult(overlay!(argRef(['1']), at)!);
    expect(text.includes('这一格的值由本次调用的实参决定')).toBe(true);
    expect(text.includes('ARG:1 填一个你假设的值')).toBe(true);
    expect(codeOfResult(overlay!(argRef(), at)!)).toBe('call-context');
  });

  it('注入了但这一槽空着 ⇒ 明说"面板里 ARG:n 现在空着，填它才有解"，且不借邻槽', () => {
    const overlay = createFunctionOverlay({
      detail: detail([{ name: 'LOCAL', index: 0, line: 2, context: [], expr: { kind: 'literal', value: 1, text: '1' } }]),
      callContext: { ints: [3, undefined] },
      baseRead: () => ({ kind: 'value', value: 0 }),
    });
    const v = overlay!(argRef(['1']), at)!;
    expect(codeOfResult(v)).toBe('call-context');
    const text = messageOfResult(v);
    expect(text.includes('ARG:1 这一格现在空着')).toBe(true);
    expect(text.includes('不借用相邻槽位的值')).toBe(true);
    expect(overlay!(argRef(['0']), at)!.kind).toBe('value');
  });

  it('下标不是槽号 ⇒ 说清"只认写死的整数槽"，不许与上面两种混成一句', () => {
    const overlay = createFunctionOverlay({ detail: detail([{ name: 'LOCAL', index: 0, line: 2, context: [], expr: { kind: 'literal', value: 1, text: '1' } }]), baseRead: () => ({ kind: 'value', value: 0 }) });
    const v = overlay!(argRef(['LOCAL']), at)!;
    expect(codeOfResult(v)).toBe('call-context');
    const text = messageOfResult(v);
    expect(text.includes('下标不是槽号')).toBe(true);
    expect(text.includes('只认写死的整数槽')).toBe(true);
  });
});

/** 结果取文案（unknown 才有 message；值结果判红） */
function messageOfResult(v: ReplayValue): string {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(v)}`);
  return v.unknown.message;
}
function codeOfResult(v: ReplayValue): string {
  if (v.kind !== 'unknown') throw new Error(`expected unknown, got ${JSON.stringify(v)}`);
  return v.unknown.code;
}
