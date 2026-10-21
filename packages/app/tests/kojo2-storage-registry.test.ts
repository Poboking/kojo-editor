/**
 * K2-STORAGE-HOST 的判据闸：`# 表 / # 池 / # 变量 / # 常量` 注册表 + 诊断桥。
 *
 * 全部走**真 core**（`lex` / `parse` / `planStorageSlots` / `validateTable`），不 mock：
 * - 多文件 `.kojo2` fixture（≥2 文件；表/池/变量/常量跨文件同名、跨文件引用）；
 * - symbol 数与类型、冲突判别、按位置命中、补全前缀过滤、诊断 code/消息/区间保真；
 * - 边界：空工程、同名不同类型、`# 常量` 不可变 flag、换盘指纹失败（项目级落点）、
 *   改型 fail-closed（旧槽不搬）、运行时冻结。
 */
import { describe, expect, it } from 'vitest';
import {
  SLOT_SNAPSHOT_VERSION,
  collectIntegerConstants,
  lex,
  parse,
  validateTable,
} from '@kojo/kojo-core';
import type { KojoConstDecl, SlotRegistrySnapshot } from '@kojo/kojo-core';
import {
  KOJO2_STORAGE_DEFAULT_FINGERPRINT,
  KOJO2_STORAGE_DEFAULT_PROJECT_URI,
  createKojo2StorageRegistry,
  kojo2StorageDiagnosticRange,
  toKojo2HostDiagnostic,
  type Kojo2HostDiagnostic,
  type Kojo2StorageRegistry,
} from '../src/ui/kojo2-storage-registry';

/* ============================== 多文件 fixture（真语法） ============================== */

const A_URI = 'D:/proj/chara/me.kojo2';
const B_URI = 'D:/proj/chara/you.kojo2';

/** A：常量 + 存档变量 + 场景变量 + 表 + 池；正文里引用 B 的池（跨文件调用） */
const FILE_A = [
  '# 机 开场',
  '# 视 我',
  '# 常量 上限 整数 = 100',
  '# 变量 好感 整数 = 0 存档',
  '# 变量 心情强度 整数 = 40 场景',
  '# 表 心情 由 心情强度',
  '    0..29 低落',
  '    30..69 平静',
  '    否 高涨',
  '# 池 早安',
  '    ? 心情强度 > 60',
  '        我：「今天也要加油。」',
  '    ? 否',
  '        我：「……早。」',
  '',
  '# 幕 早上',
  '> 今天的心情是{心情}。',
  '! 晚安',
  '',
].join('\n');

/** B：常量 + 池；池条件引用 A 的变量，正文插值引用 A 的表（跨文件引用） */
const FILE_B = [
  '# 机 收场',
  '# 视 我',
  '# 常量 问候语 字符串 = "早安"',
  '# 池 晚安',
  '    ? 好感 > 60',
  '        我：「今天很开心。」',
  '    ? 否',
  '        我：「早点睡。」',
  '',
  '# 幕 夜里',
  '> {问候语}，{心情}。',
  '',
].join('\n');

function multiFileRegistry(): Kojo2StorageRegistry {
  return createKojo2StorageRegistry({
    documents: [
      { uri: A_URI, source: FILE_A },
      { uri: B_URI, source: FILE_B },
    ],
  });
}

function symbolNamed(registry: Kojo2StorageRegistry, name: string) {
  const declaration = registry.findDeclaration(name);
  if (declaration.symbol === null) throw new Error(`fixture 里没有声明「${name}」`);
  return declaration.symbol;
}

function codesOf(diagnostics: readonly Kojo2HostDiagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

/* ============================== 1. 多文件索引：数量 / 类型 / 归属 ============================== */

describe('kojo2 存储注册表 · 多文件索引', () => {
  it('两个文件 7 条声明全部登记；类型、初值、种类、归属都对', () => {
    const registry = multiFileRegistry();

    expect(registry.uris).toEqual([A_URI, B_URI].sort());
    expect(registry.symbols).toHaveLength(7);
    expect(registry.symbols.map((symbol) => `${symbol.uri}#${symbol.name}`)).toEqual([
      `${A_URI}#上限`,
      `${A_URI}#好感`,
      `${A_URI}#心情强度`,
      `${A_URI}#心情`,
      `${A_URI}#早安`,
      `${B_URI}#问候语`,
      `${B_URI}#晚安`,
    ]);

    const upper = symbolNamed(registry, '上限');
    expect(upper.kind).toBe('const');
    expect(upper.valueType).toBe('int');
    expect(upper.initialValue).toBe(100);
    expect(upper.mutability).toBe('immutable');
    expect(upper.uri).toBe(A_URI);

    const favor = symbolNamed(registry, '好感');
    expect(favor.kind).toBe('var');
    expect(favor.valueType).toBe('int');
    expect(favor.initialValue).toBe(0);
    expect(favor.mutability).toBe('mutable');
    expect(favor.variable?.storage).toBe('save');
    expect(favor.variable?.arraySize).toBeNull();
    expect(typeof favor.variable?.storageKey).toBe('string');
    expect(favor.variable?.storageKey.length).toBeGreaterThan(0);

    const mood = symbolNamed(registry, '心情');
    expect(mood.kind).toBe('table');
    expect(mood.valueType).toBe('string');
    expect(mood.initialValue).toBeNull();
    expect(mood.mutability).toBe('read-only');
    expect(mood.table).toEqual({ subject: '心情强度', rows: 3, hasDefault: true });

    const pool = symbolNamed(registry, '早安');
    expect(pool.kind).toBe('pool');
    expect(pool.valueType).toBeNull();
    expect(pool.pool).toEqual({ branches: 2, hasDefault: true });

    const greeting = symbolNamed(registry, '问候语');
    expect(greeting.kind).toBe('const');
    expect(greeting.valueType).toBe('string');
    expect(greeting.initialValue).toBe('早安');
  });

  it('按 kind / 按文件查询：只含本面，且返回稳定引用', () => {
    const registry = multiFileRegistry();
    const kinds = registry.symbols.reduce<Record<string, number>>((acc, symbol) => {
      acc[symbol.kind] = (acc[symbol.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds).toEqual({ var: 2, const: 2, table: 1, pool: 2 });

    expect(registry.getSymbolsByKind('table').map((symbol) => symbol.name)).toEqual(['心情']);
    expect(registry.getSymbolsByKind('pool').map((symbol) => symbol.name)).toEqual(['早安', '晚安']);
    expect(registry.getSymbolsByKind('var')).toBe(registry.getSymbolsByKind('var'));

    expect(registry.getSymbolsForDocument(B_URI).map((symbol) => symbol.name)).toEqual([
      '问候语',
      '晚安',
    ]);
    expect(registry.getSymbolsForDocument(A_URI)).toHaveLength(5);
    // 未索引过的 URI：稳定空表（同一引用，不给消费方每次新造数组）
    expect(registry.getSymbolsForDocument('D:/proj/nope.kojo2')).toBe(
      registry.getSymbolsForDocument('D:/proj/also-nope.kojo2'),
    );
    expect(registry.getSymbolsForDocument('D:/proj/nope.kojo2')).toHaveLength(0);
  });

  it('槽位：默认区段下存档变量 / 场景变量各得一个槽，场景按文件分单元', () => {
    const registry = multiFileRegistry();
    expect(registry.storagePlan.ok).toBe(true);
    expect(registry.storagePlan.stats.declarations).toBe(2);
    expect(symbolNamed(registry, '好感').variable?.slot).toBe(0);
    expect(symbolNamed(registry, '心情强度').variable?.slot).toBe(0);
    expect(registry.storagePlan.assignments).toHaveLength(2);
    expect(registry.storagePlan.nextSnapshot?.classes.save).toBeDefined();
  });

  it('数组长度端点走常量静态求值（`整数[上限]` → 100）', () => {
    const arraySource = ['# 常量 长度 整数 = 3', '# 变量 背包 整数[长度] 存档', ''].join('\n');
    const registry = createKojo2StorageRegistry({
      documents: [{ uri: 'D:/proj/array.kojo2', source: arraySource }],
    });
    const bag = symbolNamed(registry, '背包');
    expect(bag.valueType).toBe('int');
    expect(bag.variable?.arraySize).toBe('长度');
    const key = bag.variable?.storageKey ?? '';
    expect(registry.storagePlan.nextSnapshot?.classes.save?.[key]).toEqual({
      slot: 0,
      valueType: 'int',
      arraySize: 3,
    });
  });

  it('主 fixture 没有 error 级诊断（索引正确时不该刷红）', () => {
    const registry = multiFileRegistry();
    expect(registry.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});

/* ============================== 2. 冲突：不静默覆盖 ============================== */

describe('kojo2 存储注册表 · 同名冲突', () => {
  it('跨文件同名存档变量：core/storage/duplicate-name + 冲突组 + 歧义可见', () => {
    const registry = createKojo2StorageRegistry({
      documents: [
        { uri: 'D:/proj/dup-a.kojo2', source: ['# 变量 好感 整数 = 0 存档', ''].join('\n') },
        {
          uri: 'D:/proj/dup-b.kojo2',
          source: ['# 常量 占位 整数 = 1', '# 变量 好感 整数 = 5 存档', ''].join('\n'),
        },
      ],
    });

    const conflict = registry.getConflict('好感');
    expect(conflict).not.toBeNull();
    expect(conflict?.symbols).toHaveLength(2);
    expect(conflict?.reasons).toEqual(['duplicate-name']);
    expect(conflict?.codes).toContain('core/storage/duplicate-name');

    const diagnostics = registry.diagnostics.filter(
      (diagnostic) => diagnostic.code === 'core/storage/duplicate-name',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe('error');

    const declaration = registry.findDeclaration('好感');
    expect(declaration.ambiguous).toBe(true);
    expect(declaration.candidates).toHaveLength(2);
    expect(declaration.symbol).toBe(declaration.candidates[0]);
    expect(declaration.conflict?.name).toBe('好感');
    // 不静默覆盖：两条声明都在 symbols 里，各自的 storageKey 不同
    const keys = new Set(declaration.candidates.map((symbol) => symbol.variable?.storageKey));
    expect(keys.size).toBe(2);
  });

  it('同文件 `# 变量` 与 `# 表` 同名：core/decl/duplicate-name + 种类/类型冲突', () => {
    const source = [
      '# 变量 心情 整数 = 0 场景',
      '# 表 心情 由 心情',
      '    0..1 低',
      '    否 高',
      '',
    ].join('\n');
    const registry = createKojo2StorageRegistry({
      documents: [{ uri: 'D:/proj/clash.kojo2', source }],
    });

    const conflict = registry.getConflict('心情');
    expect(conflict?.symbols).toHaveLength(2);
    expect(conflict?.reasons).toContain('duplicate-name');
    expect(conflict?.reasons).toContain('kind-mismatch');
    expect(conflict?.reasons).toContain('type-mismatch');
    expect(conflict?.codes).toContain('core/decl/duplicate-name');
    expect(codesOf(registry.diagnostics)).toContain('core/decl/duplicate-name');
  });

  it('跨文件同名不同类型（core 不管的命名空间面）：冲突在，但不伪造诊断码', () => {
    const registry = createKojo2StorageRegistry({
      documents: [
        { uri: 'D:/proj/t-a.kojo2', source: ['# 常量 阈值 整数 = 10', ''].join('\n') },
        { uri: 'D:/proj/t-b.kojo2', source: ['# 常量 阈值 字符串 = "十"', ''].join('\n') },
      ],
    });

    const conflict = registry.getConflict('阈值');
    expect(conflict?.reasons).toEqual(['duplicate-name', 'type-mismatch']);
    expect(conflict?.codes).toEqual([]);
    expect(registry.diagnostics).toEqual([]);
    expect(registry.findDeclaration('阈值').ambiguous).toBe(true);
  });
});

/* ============================== 3. 位置查询 / 补全 ============================== */

describe('kojo2 存储注册表 · 编辑器联动', () => {
  it('按位置命中名字段（含尾列），表格体行退化到整条声明', () => {
    const registry = multiFileRegistry();
    const favor = symbolNamed(registry, '好感');

    expect(favor.nameSpan.startLine).toBe(4);
    expect(registry.findSymbolAt(A_URI, favor.nameSpan.startLine, favor.nameSpan.startColumn)).toBe(
      favor,
    );
    // 词尾（光标停在名字之后）也算命中
    expect(registry.findSymbolAt(A_URI, favor.nameSpan.startLine, favor.nameSpan.endColumn)).toBe(
      favor,
    );

    const mood = symbolNamed(registry, '心情');
    // 表体的第 2 行数据（声明 span 内、名字段外）：跳到表声明
    expect(registry.findSymbolAt(A_URI, mood.span.startLine + 2, 5)).toBe(mood);

    // 空行 / 别的文件 / 越界列：不命中
    expect(registry.findSymbolAt(A_URI, 15, 1)).toBeNull();
    expect(registry.findSymbolAt(B_URI, 9, 1)).toBeNull();
    expect(registry.findSymbolAt('D:/proj/nope.kojo2', 1, 1)).toBeNull();
  });

  it('补全：前缀过滤、副标题、冲突标记与稳定排序', () => {
    const registry = multiFileRegistry();

    expect(registry.getCompletionItems('心').map((item) => item.label)).toEqual([
      '心情强度',
      '心情',
    ]);
    const onlyPool = registry.getCompletionItems('早安');
    expect(onlyPool).toHaveLength(1);
    expect(onlyPool[0]?.kind).toBe('pool');
    expect(onlyPool[0]?.insertText).toBe('早安');
    expect(onlyPool[0]?.detail).toContain('池');

    expect(registry.getCompletionItems('')).toHaveLength(7);
    expect(registry.getCompletionItems('不存在')).toEqual([]);
    expect(registry.getCompletionItems('')).toBe(registry.getCompletionItems(''));

    const constItem = registry.getCompletionItems('上限')[0];
    expect(constItem?.kind).toBe('const');
    expect(constItem?.detail).toContain('只读');
    expect(constItem?.detail).toContain('整数');
    expect(constItem?.uri).toBe(A_URI);
    expect(constItem?.conflicted).toBe(false);
  });

  it('冲突名字在补全里只出一枚，并带 `conflicted` 与声明数', () => {
    const registry = createKojo2StorageRegistry({
      documents: [
        { uri: 'D:/proj/c-a.kojo2', source: ['# 常量 阈值 整数 = 10', ''].join('\n') },
        { uri: 'D:/proj/c-b.kojo2', source: ['# 常量 阈值 字符串 = "十"', ''].join('\n') },
      ],
    });
    const items = registry.getCompletionItems('阈');
    expect(items).toHaveLength(1);
    expect(items[0]?.conflicted).toBe(true);
    expect(items[0]?.detail).toContain('2 处声明');
  });

  it('按名字反查：未声明给 null（不抛），已声明给确定落点', () => {
    const registry = multiFileRegistry();
    expect(registry.findDeclaration('不存在')).toEqual({
      name: '不存在',
      symbol: null,
      candidates: [],
      ambiguous: false,
      conflict: null,
    });
    expect(registry.findDeclaration('晚安').symbol?.uri).toBe(B_URI);
    expect(registry.findDeclarations('晚安')).toHaveLength(1);
  });
});

/* ============================== 4. 诊断桥：code / 消息 / 区间保真 ============================== */

describe('kojo2 存储注册表 · 诊断桥', () => {
  it('表类型不符：code / message / 区间与 core `validateTable` 逐字一致', () => {
    const source = ['# 表 档位 由 好感', '    0..10 低', '    11..20 2', '    否 高', ''].join('\n');
    const registry = createKojo2StorageRegistry({
      documents: [{ uri: 'D:/proj/table.kojo2', source }],
    });

    const lexed = lex(source);
    const file = parse(lexed);
    const table = file.decls.find((decl) => decl.kind === 'table');
    if (table === undefined || table.kind !== 'table') throw new Error('fixture 里没有表');
    const constants: KojoConstDecl[] = [];
    for (const decl of file.decls) if (decl.kind === 'const') constants.push(decl);
    const direct = validateTable(table, {
      integerConstants: collectIntegerConstants(constants),
    });
    const expected = direct.diagnostics.find(
      (diagnostic) => diagnostic.code === 'core/table/type-mismatch',
    );
    expect(expected).toBeDefined();

    const bridged = registry.diagnostics.find(
      (diagnostic) => diagnostic.code === 'core/table/type-mismatch',
    );
    expect(bridged).toBeDefined();
    expect(bridged?.severity).toBe('error');
    expect(bridged?.message).toBe(expected?.message);
    expect(bridged?.uri).toBe('D:/proj/table.kojo2');
    expect(bridged?.range.startLine).toBe(expected?.span?.start.line);
    expect(bridged?.range.startColumn).toBe(expected?.span?.start.column);
    expect(bridged?.range.endColumn).toBe(expected?.span?.end.column);
  });

  it('池误用（池体不是 `?` 链）→ core/pool/no-default 原样桥接', () => {
    const source = ['# 视 我', '# 池 坏池', '    我：「嗯。」', ''].join('\n');
    const registry = createKojo2StorageRegistry({
      documents: [{ uri: 'D:/proj/pool.kojo2', source }],
    });
    const diagnostic = registry.diagnostics.find(
      (entry) => entry.code === 'core/pool/no-default',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.range.startLine).toBe(2);
    expect(registry.diagnosticsForDocument('D:/proj/pool.kojo2')).toContain(diagnostic);
    expect(registry.diagnosticsForDocument('D:/proj/nope.kojo2')).toHaveLength(0);
  });

  it('诊断桥是纯函数：零宽扩一格、越界夹回、缺 span 退到文件头', () => {
    const zero = toKojo2HostDiagnostic({
      uri: 'D:/proj/x.kojo2',
      source: '# 变量 好感 整数 存档',
      diagnostic: {
        code: 'core/decl/duplicate-name',
        severity: 'error',
        message: '零宽',
        span: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
      },
    });
    expect(zero.range).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 });

    const noSpan = toKojo2HostDiagnostic({
      uri: 'D:/proj/x.kojo2',
      source: '',
      diagnostic: {
        code: 'core/storage/fingerprint-mismatch',
        severity: 'error',
        message: '无落点',
        span: null,
      },
    });
    expect(noSpan.range).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 });

    const clamped = kojo2StorageDiagnosticRange(
      { start: { line: 9, column: 99 }, end: { line: 12, column: 120 } },
      'abc\ndef',
    );
    expect(clamped).toEqual({ startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 });
  });

  it('项目级失败（无 span）挂到虚拟项目 URI，code 不变', () => {
    const snapshot: SlotRegistrySnapshot = {
      version: SLOT_SNAPSHOT_VERSION,
      gameFingerprint: 'another-disc@9',
      classes: {},
    };
    const registry = createKojo2StorageRegistry({
      documents: [{ uri: A_URI, source: FILE_A }],
      previousSnapshot: snapshot,
    });

    expect(registry.storagePlan.ok).toBe(false);
    const diagnostic = registry.diagnostics.find(
      (entry) => entry.code === 'core/storage/fingerprint-mismatch',
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.uri).toBe(KOJO2_STORAGE_DEFAULT_PROJECT_URI);
    expect(diagnostic?.range.startLine).toBe(1);
  });

  it('改型 fail-closed：`core/storage/shape-changed`，旧槽不搬', () => {
    const first = createKojo2StorageRegistry({
      documents: [{ uri: A_URI, source: FILE_A }],
    });
    const key = symbolNamed(first, '好感').variable?.storageKey ?? '';
    expect(first.storagePlan.ok).toBe(true);

    const snapshot: SlotRegistrySnapshot = {
      version: SLOT_SNAPSHOT_VERSION,
      gameFingerprint: KOJO2_STORAGE_DEFAULT_FINGERPRINT,
      classes: { save: { [key]: { slot: 3, valueType: 'string', arraySize: null } } },
    };
    const second = createKojo2StorageRegistry({
      documents: [{ uri: A_URI, source: FILE_A }],
      previousSnapshot: snapshot,
    });

    expect(second.storagePlan.ok).toBe(false);
    expect(second.storagePlan.nextSnapshot).toBeNull();
    expect(codesOf(second.diagnostics)).toContain('core/storage/shape-changed');
    // 拒绝分配 ≠ 搬槽：既有槽号原样保留，作者能看见「这个槽属于旧存档」
    expect(symbolNamed(second, '好感').variable?.slot).toBe(3);
  });
});

/* ============================== 5. 边界：空工程 / 只读 / 冻结 ============================== */

describe('kojo2 存储注册表 · 边界', () => {
  it('空工程：零符号、零冲突、零诊断，规划仍然 ok', () => {
    const registry = createKojo2StorageRegistry();
    expect(registry.symbols).toEqual([]);
    expect(registry.conflicts).toEqual([]);
    expect(registry.diagnostics).toEqual([]);
    expect(registry.uris).toEqual([]);
    expect(registry.storagePlan.ok).toBe(true);
    expect(registry.storagePlan.stats.declarations).toBe(0);
    expect(registry.getSymbolsByKind('var')).toEqual([]);
    expect(registry.getCompletionItems('')).toEqual([]);
    expect(registry.findDeclaration('随便').symbol).toBeNull();
    expect(registry.findSymbolAt('D:/proj/x.kojo2', 1, 1)).toBeNull();
  });

  it('`# 常量` 只读 flag：immutable；表/池 read-only；变量 mutable', () => {
    const registry = multiFileRegistry();
    expect(symbolNamed(registry, '上限').mutability).toBe('immutable');
    expect(symbolNamed(registry, '问候语').mutability).toBe('immutable');
    expect(symbolNamed(registry, '心情').mutability).toBe('read-only');
    expect(symbolNamed(registry, '早安').mutability).toBe('read-only');
    expect(symbolNamed(registry, '好感').mutability).toBe('mutable');
  });

  it('返回结构运行时冻结（不只 TS readonly）：改一个字段就抛', () => {
    const registry = multiFileRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.symbols)).toBe(true);
    expect(Object.isFrozen(registry.conflicts)).toBe(true);
    expect(Object.isFrozen(registry.diagnostics)).toBe(true);
    expect(Object.isFrozen(registry.uris)).toBe(true);
    expect(Object.isFrozen(registry.storagePlan)).toBe(false); // core 的产物原样透传，不在本层冻结

    const symbol = symbolNamed(registry, '好感');
    expect(Object.isFrozen(symbol)).toBe(true);
    expect(Object.isFrozen(symbol.span)).toBe(true);
    expect(Object.isFrozen(symbol.nameSpan)).toBe(true);
    expect(Object.isFrozen(symbol.variable)).toBe(true);
    expect(() => {
      (symbol as { name: string }).name = '改不动';
    }).toThrow(TypeError);

    const declaration = registry.findDeclaration('好感');
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.candidates)).toBe(true);
    expect(Object.isFrozen(registry.getCompletionItems('')[0])).toBe(true);
  });

  it('坏输入 fail-closed：空 URI / 重复 URI / 声明键返回空串都抛 TypeError', () => {
    expect(() =>
      createKojo2StorageRegistry({ documents: [{ uri: '', source: '#' }] }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageRegistry({
        documents: [
          { uri: 'D:/proj/same.kojo2', source: '' },
          { uri: 'D:/proj/same.kojo2', source: '' },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      createKojo2StorageRegistry({
        documents: [{ uri: A_URI, source: FILE_A }],
        declarationKey: () => '',
      }),
    ).toThrow(TypeError);
  });

  it('声明键可注入（换账本键 → 槽位按键找旧槽），默认键稳定', () => {
    const ledger = (uri: string, name: string): string => `${uri}#${name}`;
    const build = (): Kojo2StorageRegistry =>
      createKojo2StorageRegistry({
        documents: [{ uri: A_URI, source: FILE_A }],
        declarationKey: (input) => ledger(input.uri, input.name),
      });
    const first = build();
    const second = build();
    expect(symbolNamed(first, '好感').variable?.storageKey).toBe(`${A_URI}#好感`);
    expect(symbolNamed(second, '好感').variable?.storageKey).toBe(`${A_URI}#好感`);
    expect(symbolNamed(second, '好感').variable?.slot).toBe(
      symbolNamed(first, '好感').variable?.slot,
    );
    // 默认键（无账本）与注入键是两套口径，别混着比槽位
    const defaultRegistry = multiFileRegistry();
    expect(symbolNamed(defaultRegistry, '好感').variable?.storageKey).not.toBe(`${A_URI}#好感`);
  });
});
