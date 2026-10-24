/**
 * K2-CALLHIER-XFILE · `kojo2` 调用层级**跨文件解析口**行为闸。
 *
 * 覆盖面（按 describe 分组）：
 * - **契约与路径形状**：`prepare` 的 `path` 进 `data.path`、不给就保持 batch-8 形状；
 *   XFile 入 / 出边的 `from` / `to` 都带 `path`，坐标仍是 1 基半开区间；
 * - **跨文件出边**：本地声明优先、本地落不下再问 `resolveDeclaration`、按 `readSource` 取回
 *   源文重解析真声明（索引坐标不采信）、索引文件里没有该声明 ⇒ 不产边；
 * - **跨文件入边**：同文件 + `listCallers` 候选文件合并、按文件键排序、模板调用者、
 *   无 `listCallers` 时只有声明文件这一路（已知缺口）；
 * - **回退（零回归）**：resolvers 缺失 / 缺腿 ⇒ 与同文件两函数逐字相同；任一条腿抛错 ⇒
 *   丢弃整轮跨文件扩展、交回同文件结果；无源文可读 ⇒ `null`；
 * - **上限 / 防环 / visited**：文件数封顶 64、单组调用点与边数封顶 200、重复候选路径只读一次、
 *   跨文件环只展开一层；
 * - **确定性**：同输入两次逐字相同、CRLF 同结果。
 *
 * 夹具三文件构成一个跨文件环：`a:入口 → b:远端 → c:问候 → a:入口`。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  KOJO2_CALL_HIERARCHY_FILE_LIMIT,
  KOJO2_CALL_HIERARCHY_LIMIT,
  kojo2IncomingCalls,
  kojo2IncomingCallsXFile,
  kojo2OutgoingCalls,
  kojo2OutgoingCallsXFile,
  kojo2PrepareCallHierarchy,
  type Kojo2CallHierarchyCallerCandidate,
  type Kojo2CallHierarchyDeclarationTarget,
  type Kojo2CallHierarchyItem,
  type Kojo2CallHierarchyResolvers,
  type Kojo2CallableDeclarationKind,
  type Kojo2IncomingCall,
  type Kojo2OutgoingCall,
} from '../src/monaco/kojo2-callhierarchy';
import { kojo2DocumentOf, type Kojo2DeclarationKind } from '@kojo/kojo-lang';

/* ============================== 夹具：三个文件一个环 ============================== */

const A_PATH = 'a.kojo2';
const B_PATH = 'b.kojo2';
const C_PATH = 'c.kojo2';

/** `入口`：调 `远端`（B）+ `本地`（A）+ `外部函数`（无声明） */
const SOURCE_A = [
  '@函 入口(n)',
  '    ! 远端(n)',
  '    ! 本地(n)',
  '    ! 外部函数(n)',
  '    @返 0',
  '@函 本地(n)',
  '    @返 n',
].join('\n');

/** `远端`：自递归 + 调 `问候`（C，`# 模`） */
const SOURCE_B = [
  '@函 远端(n)',
  '    ! 远端(n - 1)',
  '    ! 问候(1)',
  '    @返 0',
].join('\n');

/** `问候`（`# 模`）：调 `入口`（A）+ `远端`（B） */
const SOURCE_C = [
  '# 模 问候()',
  '    > 早安。',
  '    ! 入口(1)',
  '    ! 远端(1)',
].join('\n');

const SOURCES: Readonly<Record<string, string>> = {
  [A_PATH]: SOURCE_A,
  [B_PATH]: SOURCE_B,
  [C_PATH]: SOURCE_C,
};

const DECLARATION_OF_REMOTE: Kojo2CallHierarchyDeclarationTarget = {
  path: B_PATH,
  line: 1,
  column: 4,
  kind: 'function',
};
const DECLARATION_OF_GREETING: Kojo2CallHierarchyDeclarationTarget = {
  path: C_PATH,
  line: 1,
  column: 5,
  kind: 'template',
};
const DECLARATION_OF_ENTRY: Kojo2CallHierarchyDeclarationTarget = {
  path: A_PATH,
  line: 1,
  column: 4,
  kind: 'function',
};

/* ============================== 小工具 ============================== */

/** 文件名声明位 → item（可带 path；`kojo2DocumentOf` 给列，不另算） */
function prepareItem(
  source: string,
  kind: Kojo2DeclarationKind,
  name: string,
  path?: string,
): Kojo2CallHierarchyItem {
  const declaration = kojo2DocumentOf(source).declarations.find(
    (candidate) => candidate.kind === kind && candidate.name === name,
  );
  if (declaration === undefined) throw new Error(`夹具缺少 ${kind}:${name}`);
  const result = kojo2PrepareCallHierarchy(
    source,
    { line: declaration.line, column: declaration.nameStart },
    path,
  );
  expect(result, `${kind}:${name} 没有 call hierarchy item`).not.toBeNull();
  expect(result).toHaveLength(1);
  return result![0]!;
}

function itemOfEntry(): Kojo2CallHierarchyItem {
  return prepareItem(SOURCE_A, 'function', '入口', A_PATH);
}

function itemOfLocal(): Kojo2CallHierarchyItem {
  return prepareItem(SOURCE_A, 'function', '本地', A_PATH);
}

function itemOfRemoteInB(): Kojo2CallHierarchyItem {
  return prepareItem(SOURCE_B, 'function', '远端', B_PATH);
}

/** 入边 → `路径:名字`（排序断言用） */
function incomingPairs(calls: readonly Kojo2IncomingCall[] | null): readonly string[] {
  return (calls ?? []).map((call) => `${call.from.data.path ?? ''}:${call.from.name}`);
}

/** 出边 → `路径:名字`（排序断言用） */
function outgoingPairs(calls: readonly Kojo2OutgoingCall[] | null): readonly string[] {
  return (calls ?? []).map((call) => `${call.to.data.path ?? ''}:${call.to.name}`);
}

interface FakeIndexInput {
  readonly sources?: Readonly<Record<string, string>>;
  readonly declarations?: Readonly<
    Record<string, Kojo2CallHierarchyDeclarationTarget | null | undefined>
  >;
  readonly callers?: Readonly<Record<string, readonly string[]>>;
  readonly failResolve?: boolean;
  readonly failRead?: boolean;
  readonly failList?: boolean;
}

/** 假项目索引：三只 spy + 内存表（故意不引 `kojo2-project-index.ts`，这里只测契约）。 */
function fakeIndex(input: FakeIndexInput) {
  const sources = input.sources ?? {};
  const resolveDeclaration = vi.fn(
    (name: string, _kind?: Kojo2CallableDeclarationKind): Kojo2CallHierarchyDeclarationTarget | null => {
      if (input.failResolve === true) throw new Error('桩：resolveDeclaration 抛错');
      return input.declarations?.[name] ?? null;
    },
  );
  const readSource = vi.fn((path: string): string | null => {
    if (input.failRead === true) throw new Error('桩：readSource 抛错');
    return sources[path] ?? null;
  });
  const listCallers = vi.fn(
    (
      name: string,
      _kind?: Kojo2CallableDeclarationKind,
    ): readonly Kojo2CallHierarchyCallerCandidate[] | null => {
      if (input.failList === true) throw new Error('桩：listCallers 抛错');
      const listed = input.callers?.[name];
      return listed === undefined ? [] : listed.map((path) => ({ path }));
    },
  );
  const useListCallers = input.callers !== undefined || input.failList === true;
  const resolvers: Kojo2CallHierarchyResolvers = useListCallers
    ? { resolveDeclaration, readSource, listCallers }
    : { resolveDeclaration, readSource };
  return { resolvers, resolveDeclaration, readSource, listCallers };
}

/* ============================== ① 契约与路径形状 ============================== */

describe('契约：`data.path` 与跨文件坐标形状', () => {
  it('prepare 给了 `path` ⇒ `data.path` 是它；不给 / 空串 ⇒ 保持 batch-8 形状（无该键）', () => {
    expect(itemOfEntry().data.path).toBe(A_PATH);
    expect('path' in prepareItem(SOURCE_A, 'function', '入口').data).toBe(false);
    expect('path' in prepareItem(SOURCE_A, 'function', '入口', '').data).toBe(false);
  });

  it('XFile 入 / 出边的 `from` / `to` 都带 path，名字段坐标仍是 1 基半开区间', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE, 问候: DECLARATION_OF_GREETING },
      callers: { 远端: [A_PATH, C_PATH] },
    });
    const incoming = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers) ?? [];
    const outgoing = kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers) ?? [];
    for (const item of [
      ...incoming.map((call) => call.from),
      ...outgoing.map((call) => call.to),
    ]) {
      expect(typeof item.data.path).toBe('string');
      expect((item.data.path ?? '').length).toBeGreaterThan(0);
      expect(item.data.line).toBe(item.selectionRange.startLine);
      expect(item.data.nameStart).toBe(item.selectionRange.startColumn);
      expect(item.data.nameEnd).toBe(item.selectionRange.endColumn);
      expect(item.selectionRange.startLine).toBeGreaterThanOrEqual(1);
      expect(item.selectionRange.startColumn).toBeGreaterThanOrEqual(1);
    }
    for (const call of incoming) {
      for (const range of call.fromRanges) {
        expect(range.startLine).toBeGreaterThanOrEqual(1);
        expect(range.startColumn).toBeGreaterThanOrEqual(1);
        expect(range.endColumn).toBeGreaterThan(range.startColumn);
      }
    }
  });

  it('`resolveDeclaration` / `listCallers` 收到 `(名字, 种类)` 提示（索引可据此挑对声明）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE, 问候: DECLARATION_OF_GREETING },
      callers: { 远端: [A_PATH] },
    });
    // 定位"item 自己不在当前源文里"时种类已知 ⇒ 带上提示
    kojo2OutgoingCallsXFile(prepareItem(SOURCE_B, 'function', '远端'), fake.resolvers);
    expect(fake.resolveDeclaration.mock.calls[0]).toEqual(['远端', 'function']);
    // 出边的被调名只用名字查（种类由取回源文后判定）
    kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers);
    expect(fake.resolveDeclaration.mock.calls[2]).toEqual(['远端', undefined]);
    // 入边查询带 item 的真种类
    kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    expect(fake.listCallers).toHaveBeenCalledWith('远端', 'function');
  });
});

/* ============================== ② 跨文件出边 ============================== */

describe('跨文件出边：本地优先、远端经索引落点、源文重解析', () => {
  it('本地 + 跨文件边合并，按文件键排序（a 本地 → b 远端）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE },
    });
    const calls = kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers);
    expect(outgoingPairs(calls)).toEqual([`${A_PATH}:本地`, `${B_PATH}:远端`]);
    expect(fake.readSource).toHaveBeenCalledTimes(2);
  });

  it('跨文件 `to` 的 item 坐标来自**源文**（不是索引的提示坐标），`fromRanges` 留在调用者文件', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      // 索引提示故意给错行 / 错种类：真答案仍应由源文解析给出
      declarations: {
        远端: { path: B_PATH, line: 999, column: 1, kind: 'template' },
      },
    });
    const remote = kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers)?.find(
      (call) => call.to.name === '远端',
    );
    expect(remote?.to.data).toEqual({
      name: '远端',
      declarationKind: 'function',
      line: 1,
      nameStart: 4,
      nameEnd: 6,
      path: B_PATH,
    });
    expect(remote?.to.selectionRange).toEqual({
      startLine: 1,
      startColumn: 4,
      endLine: 1,
      endColumn: 6,
    });
    expect(remote?.fromRanges).toEqual([
      { startLine: 2, startColumn: 7, endLine: 2, endColumn: 9 },
    ]);
  });

  it('本地已声明的名字不问索引；只有本地落不下的名字才查（远端 / 外部函数）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE },
    });
    kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers);
    expect(fake.resolveDeclaration.mock.calls.map((call) => call[0])).toEqual([
      '远端',
      '外部函数',
    ]);
  });

  it('`# 模` 的出边也跨文件（问候 → 入口 A + 远端 B）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: {
        入口: DECLARATION_OF_ENTRY,
        远端: DECLARATION_OF_REMOTE,
      },
    });
    expect(outgoingPairs(kojo2OutgoingCallsXFile(
      prepareItem(SOURCE_C, 'template', '问候', C_PATH),
      fake.resolvers,
    ))).toEqual([`${A_PATH}:入口`, `${B_PATH}:远端`]);
  });

  it('索引落点文件里没有该声明 ⇒ 不产边（不伪造坐标）', () => {
    const fake = fakeIndex({
      sources: { [A_PATH]: SOURCE_A, [C_PATH]: SOURCE_C },
      declarations: { 远端: { path: C_PATH, line: 1, column: 4, kind: 'function' } },
    });
    expect(outgoingPairs(kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers))).toEqual([
      `${A_PATH}:本地`,
    ]);
  });

  it('`readSource` 读不到落点文件 ⇒ 跳过该边、本地边保留（不抛）', () => {
    const fake = fakeIndex({
      sources: { [A_PATH]: SOURCE_A },
      declarations: { 远端: { path: 'missing.kojo2', line: 1, column: 4, kind: 'function' } },
    });
    expect(outgoingPairs(kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers))).toEqual([
      `${A_PATH}:本地`,
    ]);
  });

  it('item 无 path、无显式 source ⇒ 经 `resolveDeclaration` 定位声明文件后照常出边', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: {
        远端: DECLARATION_OF_REMOTE,
        问候: DECLARATION_OF_GREETING,
      },
    });
    const item = prepareItem(SOURCE_B, 'function', '远端'); // 无 path
    expect(outgoingPairs(kojo2OutgoingCallsXFile(item, fake.resolvers))).toEqual([
      `${B_PATH}:远端`,
      `${C_PATH}:问候`,
    ]);
    expect(fake.resolveDeclaration.mock.calls[0]).toEqual(['远端', 'function']);
  });
});

/* ============================== ③ 跨文件入边 ============================== */

describe('跨文件入边：同文件 + `listCallers` 候选文件合并', () => {
  it('三条入边按文件键排序：a 入口 + b 远端（自递归）+ c 问候（模板调用者）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      callers: { 远端: [C_PATH, A_PATH] }, // 刻意乱序喂候选
    });
    const calls = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    expect(incomingPairs(calls)).toEqual([
      `${A_PATH}:入口`,
      `${B_PATH}:远端`,
      `${C_PATH}:问候`,
    ]);
    expect(calls?.find((call) => call.from.name === '问候')?.from.data.declarationKind).toBe(
      'template',
    );
    expect(fake.readSource).toHaveBeenCalledTimes(3); // 当前文件 + 两个候选
  });

  it('每个 `fromRanges` 落在**调用者自己**的文件里（a 行 2 / b 行 2 / c 行 4）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      callers: { 远端: [A_PATH, C_PATH] },
    });
    const calls = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers) ?? [];
    const ranges = new Map(
      calls.map((call) => [call.from.name, call.fromRanges] as const),
    );
    expect(ranges.get('入口')).toEqual([
      { startLine: 2, startColumn: 7, endLine: 2, endColumn: 9 },
    ]);
    expect(ranges.get('远端')).toEqual([
      { startLine: 2, startColumn: 7, endLine: 2, endColumn: 9 },
    ]);
    expect(ranges.get('问候')).toEqual([
      { startLine: 4, startColumn: 7, endLine: 4, endColumn: 9 },
    ]);
  });

  it('没有 `listCallers` ⇒ 只有声明文件这一路（已知缺口，不猜别的文件）', () => {
    const fake = fakeIndex({ sources: SOURCES });
    expect(incomingPairs(kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers))).toEqual([
      `${B_PATH}:远端`,
    ]);
    expect(fake.readSource).toHaveBeenCalledTimes(1);
  });

  it('item 无 path ⇒ 经索引落点文件 + 候选文件照常出入边', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE },
      callers: { 远端: [A_PATH] },
    });
    const item = prepareItem(SOURCE_B, 'function', '远端'); // 无 path
    expect(incomingPairs(kojo2IncomingCallsXFile(item, fake.resolvers))).toEqual([
      `${A_PATH}:入口`,
      `${B_PATH}:远端`,
    ]);
  });

  it('显式 `options.path` 给同文件边盖章（item 自己没有 path 时）', () => {
    const fake = fakeIndex({ sources: SOURCES });
    const item = prepareItem(SOURCE_B, 'function', '远端'); // 无 path
    const calls = kojo2IncomingCallsXFile(item, fake.resolvers, {
      source: SOURCE_B,
      path: B_PATH,
    });
    expect(incomingPairs(calls)).toEqual([`${B_PATH}:远端`]);
    expect(fake.readSource).not.toHaveBeenCalled(); // 显式 source 不再读当前文件
  });
});

/* ============================== ④ 回退：resolvers 缺失 / 抛错（零回归） ============================== */

describe('回退：resolvers 缺失 / 缺腿 / 抛错 ⇒ 同文件结果逐字相同', () => {
  it('无 resolvers + 显式 source ⇒ 入边与 `kojo2IncomingCalls` 逐字相同', () => {
    const item = itemOfLocal();
    expect(kojo2IncomingCallsXFile(item, undefined, { source: SOURCE_A })).toEqual(
      kojo2IncomingCalls(SOURCE_A, item),
    );
    expect(kojo2IncomingCallsXFile(item, null, { source: SOURCE_A })).toEqual(
      kojo2IncomingCalls(SOURCE_A, item),
    );
  });

  it('无 resolvers + 显式 source ⇒ 出边与 `kojo2OutgoingCalls` 逐字相同', () => {
    const item = itemOfEntry();
    expect(kojo2OutgoingCallsXFile(item, undefined, { source: SOURCE_A })).toEqual(
      kojo2OutgoingCalls(SOURCE_A, item),
    );
  });

  it('resolvers 缺 `readSource` ⇒ 当没接索引（同文件回退）', () => {
    const partial = {
      resolveDeclaration: () => DECLARATION_OF_REMOTE,
    } as unknown as Kojo2CallHierarchyResolvers;
    const item = itemOfEntry();
    expect(kojo2OutgoingCallsXFile(item, partial, { source: SOURCE_A })).toEqual(
      kojo2OutgoingCalls(SOURCE_A, item),
    );
  });

  it('`resolveDeclaration` 抛错 ⇒ 丢弃跨文件扩展、交回同文件出边', () => {
    const fake = fakeIndex({ sources: { [A_PATH]: SOURCE_A }, failResolve: true });
    const item = itemOfEntry();
    expect(kojo2OutgoingCallsXFile(item, fake.resolvers)).toEqual(
      kojo2OutgoingCalls(SOURCE_A, item),
    );
  });

  it('`readSource` 中途抛错 ⇒ 连已算好的本地边也原样交回同文件形状', () => {
    const fake = fakeIndex({
      sources: { [A_PATH]: SOURCE_A },
      declarations: { 远端: DECLARATION_OF_REMOTE },
      failRead: true,
    });
    const item = itemOfEntry();
    expect(kojo2OutgoingCallsXFile(item, fake.resolvers, { source: SOURCE_A })).toEqual(
      kojo2OutgoingCalls(SOURCE_A, item),
    );
    // 连当前源文都读不到 ⇒ 没有可回退的源文，交 null（不猜）
    expect(kojo2OutgoingCallsXFile(item, fake.resolvers)).toBeNull();
  });

  it('`listCallers` 抛错 ⇒ 交回同文件入边', () => {
    const fake = fakeIndex({ sources: {}, failList: true });
    const item = itemOfRemoteInB();
    expect(kojo2IncomingCallsXFile(item, fake.resolvers, { source: SOURCE_B })).toEqual(
      kojo2IncomingCalls(SOURCE_B, item),
    );
  });

  it('`resolveDeclaration` 抛错且无源文 ⇒ `null`（同文件也认不出）', () => {
    const fake = fakeIndex({ sources: {}, failResolve: true });
    expect(kojo2IncomingCallsXFile(prepareItem(SOURCE_B, 'function', '远端'), fake.resolvers)).toBeNull();
  });

  it('认不出的 item（无 data / null）⇒ `null`，resolvers 也救不回来', () => {
    const fake = fakeIndex({ sources: SOURCES });
    const broken = {
      ...itemOfRemoteInB(),
      data: undefined,
    } as unknown as Kojo2CallHierarchyItem;
    expect(kojo2IncomingCallsXFile(broken, fake.resolvers)).toBeNull();
    expect(kojo2OutgoingCallsXFile(broken, fake.resolvers)).toBeNull();
    expect(
      kojo2IncomingCallsXFile(null as unknown as Kojo2CallHierarchyItem, fake.resolvers),
    ).toBeNull();
  });
});

/* ============================== ⑤ 上限 / 防环 / visited ============================== */

describe('上限 / 防环 / visited', () => {
  it('文件数封顶 64：100 个候选文件只读 64 个（含当前文件），边数随之截止', () => {
    const sources: Record<string, string> = { [B_PATH]: SOURCE_B };
    const callers: string[] = [];
    for (let index = 0; index < 100; index++) {
      const path = `caller-${String(index).padStart(3, '0')}.kojo2`;
      sources[path] = `@函 调用者${index}()\n    ! 远端(1)\n`;
      callers.push(path);
    }
    const fake = fakeIndex({ sources, callers: { 远端: callers } });
    const calls = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    expect(fake.readSource).toHaveBeenCalledTimes(KOJO2_CALL_HIERARCHY_FILE_LIMIT);
    expect(calls).toHaveLength(KOJO2_CALL_HIERARCHY_FILE_LIMIT);
    expect(calls?.[0]?.from.data.path).toBe(B_PATH);
  });

  it('边数封顶 200：63 个文件 × 4 个调用者 + 自递归也只交 200 组', () => {
    const sources: Record<string, string> = { [B_PATH]: SOURCE_B };
    const callers: string[] = [];
    for (let index = 0; index < 63; index++) {
      const path = `caller-${String(index).padStart(3, '0')}.kojo2`;
      const lines: string[] = [];
      for (let slot = 0; slot < 4; slot++) {
        lines.push(`@函 甲${slot}()`, '    ! 远端(1)');
      }
      sources[path] = lines.join('\n');
      callers.push(path);
    }
    const fake = fakeIndex({ sources, callers: { 远端: callers } });
    const calls = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    expect(calls).toHaveLength(KOJO2_CALL_HIERARCHY_LIMIT);
  });

  it('单组调用点封顶 200：250 个调用点只交前 200 个', () => {
    const noise = ['@函 噪音()'];
    for (let index = 0; index < 250; index++) noise.push('    ! 远端()');
    const fake = fakeIndex({
      sources: { [B_PATH]: SOURCE_B, 'noise.kojo2': noise.join('\n') },
      callers: { 远端: ['noise.kojo2'] },
    });
    const calls = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    const noiseGroup = calls?.find((call) => call.from.name === '噪音');
    expect(noiseGroup?.fromRanges).toHaveLength(KOJO2_CALL_HIERARCHY_LIMIT);
  });

  it('visited：`listCallers` 重复同一路径只读一次、只产一组边', () => {
    const fake = fakeIndex({
      sources: { [B_PATH]: SOURCE_B },
      declarations: { 远端: DECLARATION_OF_REMOTE },
      callers: { 远端: [B_PATH, B_PATH, B_PATH] },
    });
    const calls = kojo2IncomingCallsXFile(
      prepareItem(SOURCE_B, 'function', '远端'), // 无 path
      fake.resolvers,
    );
    expect(fake.readSource).toHaveBeenCalledTimes(1);
    expect(fake.readSource).toHaveBeenCalledWith(B_PATH);
    expect(calls).toHaveLength(1);
    expect(calls?.[0]?.from.data.path).toBe(B_PATH);
  });

  it('跨文件环（a 入口 → b 远端 → c 问候 → a 入口）每次只展开一层，不成环', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: {
        远端: DECLARATION_OF_REMOTE,
        问候: DECLARATION_OF_GREETING,
        入口: DECLARATION_OF_ENTRY,
      },
      callers: { 远端: [A_PATH, C_PATH] },
    });
    expect(outgoingPairs(kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers))).toEqual([
      `${A_PATH}:本地`,
      `${B_PATH}:远端`,
    ]);
    expect(outgoingPairs(kojo2OutgoingCallsXFile(itemOfRemoteInB(), fake.resolvers))).toEqual([
      `${B_PATH}:远端`,
      `${C_PATH}:问候`,
    ]);
    expect(
      outgoingPairs(
        kojo2OutgoingCallsXFile(prepareItem(SOURCE_C, 'template', '问候', C_PATH), fake.resolvers),
      ),
    ).toEqual([`${A_PATH}:入口`, `${B_PATH}:远端`]);
  });
});

/* ============================== ⑥ 确定性 / CRLF ============================== */

describe('确定性：同输入逐字相等、CRLF 同结果', () => {
  it('两次查询结果逐字相等（入边 / 出边）', () => {
    const fake = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE, 问候: DECLARATION_OF_GREETING },
      callers: { 远端: [A_PATH, C_PATH] },
    });
    const outgoing = kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers);
    expect(kojo2OutgoingCallsXFile(itemOfEntry(), fake.resolvers)).toEqual(outgoing);
    const incoming = kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers);
    expect(kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers)).toEqual(incoming);
    expect(JSON.stringify(incoming)).toBe(
      JSON.stringify(kojo2IncomingCallsXFile(itemOfRemoteInB(), fake.resolvers)),
    );
  });

  it('CRLF 与 LF 同结果（跨文件边也一样）', () => {
    const crlfSources: Record<string, string> = {};
    for (const [path, text] of Object.entries(SOURCES)) {
      crlfSources[path] = text.replace(/\n/g, '\r\n');
    }
    const lf = fakeIndex({
      sources: SOURCES,
      declarations: { 远端: DECLARATION_OF_REMOTE, 问候: DECLARATION_OF_GREETING },
      callers: { 远端: [A_PATH, C_PATH] },
    });
    const crlf = fakeIndex({
      sources: crlfSources,
      declarations: { 远端: DECLARATION_OF_REMOTE, 问候: DECLARATION_OF_GREETING },
      callers: { 远端: [A_PATH, C_PATH] },
    });
    const crlfEntry = prepareItem(crlfSources[A_PATH]!, 'function', '入口', A_PATH);
    const crlfRemote = prepareItem(crlfSources[B_PATH]!, 'function', '远端', B_PATH);
    expect(kojo2OutgoingCallsXFile(crlfEntry, crlf.resolvers)).toEqual(
      kojo2OutgoingCallsXFile(itemOfEntry(), lf.resolvers),
    );
    expect(kojo2IncomingCallsXFile(crlfRemote, crlf.resolvers)).toEqual(
      kojo2IncomingCallsXFile(itemOfRemoteInB(), lf.resolvers),
    );
  });
});
