import { describe, expect, it } from 'vitest';
import type { ErbFile } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  coerceSnapshot,
  decodeEntries,
  diffSnapshot,
  encodeEntries,
  mergeEntries,
  pruneSnapshotKeys,
  snapshotKeyFor,
  type IndexSnapshot,
  type SnapshotEntry,
} from '../src/snapshot';

const ROOT = 'D:/proj/eratw';

function file(path: string, names: readonly string[]): ErbFile {
  return {
    path,
    functions: names.map((name, i) => ({
      name,
      normalizedName: name.toUpperCase(),
      filePath: path,
      startLine: 1 + i * 10,
      endLine: 10 + i * 10,
      params: [],
      // scanner 对每个函数都显式写这个布尔，测试夹具保持同形
      isExpressionFunction: false,
    })),
    dims: [],
    hasFunctionDirective: false,
    lineCount: 100,
  };
}

function entry(path: string, mtimeMs: number | null, names: readonly string[]): SnapshotEntry {
  return { mtimeMs, textLength: 1000, file: file(path, names) };
}

/** 盘上形态：v3 起 entries 是位置元组，内存形状只在加载后存在 */
function snapshot(entries: Record<string, SnapshotEntry>, rootDir = ROOT): IndexSnapshot & { entries: unknown } {
  return { version: SNAPSHOT_VERSION, rootDir, savedAt: 1234, entries: encodeEntries(entries) } as never;
}

describe('snapshotKeyFor（存储键安全）', () => {
  it('产出安全段且确定', () => {
    const k = snapshotKeyFor(ROOT);
    expect(k).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
    expect(k).toBe(snapshotKeyFor(ROOT));
  });

  it('不同项目根 → 不同键（不串项目）', () => {
    expect(snapshotKeyFor('D:/a')).not.toBe(snapshotKeyFor('D:/b'));
  });

  it('键里带格式版本（升级格式时天然换键）', () => {
    expect(snapshotKeyFor(ROOT)).toContain(`v${SNAPSHOT_VERSION}`);
  });
});

describe('aggregateIndex（聚合必须与全量重建同源同序）', () => {
  it('按传入顺序聚合 byName；同名函数跨文件累积', () => {
    const { files, byName } = aggregateIndex([file('/a.ERB', ['FOO', 'BAR']), file('/b.ERB', ['FOO'])]);
    expect([...files.keys()]).toEqual(['/a.ERB', '/b.ERB']);
    expect(byName.get('FOO')!.map((r) => r.filePath)).toEqual(['/a.ERB', '/b.ERB']);
    expect(byName.get('BAR')).toHaveLength(1);
    expect(byName.get('BAR')![0]).toMatchObject({ name: 'BAR', filePath: '/a.ERB', startLine: 11, endLine: 20 });
  });
});

describe('diffSnapshot（保守失效）', () => {
  const snap = coerceSnapshot(
    snapshot({
      '/a.ERB': entry('/a.ERB', 100, ['FOO']),
      '/b.ERB': entry('/b.ERB', null, ['BAR']), // 平台未提供 mtime
    }),
    ROOT,
  )!;

  it('mtime 一致 → 复用；缺失 / 变了 / 任一侧 null → 过期', () => {
    const stats = new Map<string, { mtimeMs: number } | null>([
      ['/a.ERB', { mtimeMs: 100 }],
      ['/b.ERB', { mtimeMs: 100 }],
      ['/c.ERB', { mtimeMs: 100 }], // 快照里没有
      ['/d.ERB', null], // stat 失败
    ]);
    const d = diffSnapshot(snap, ['/a.ERB', '/b.ERB', '/c.ERB', '/d.ERB'], stats as never);
    expect(d.reusable).toEqual(['/a.ERB']);
    expect(d.stale).toEqual(['/b.ERB', '/c.ERB', '/d.ERB']);
  });

  it('mtime 是浮点也必须逐位相等（同源口径才可比）', () => {
    const stats = new Map<string, { mtimeMs: number } | null>([['/a.ERB', { mtimeMs: 100.5 }]]);
    expect(diffSnapshot(snap, ['/a.ERB'], stats as never).reusable).toEqual([]);
  });
});

describe('v3 元组编解码（瘦身不改语义）', () => {
  /** 含全部可选形态的真实感样本：表达式函数、带默认值形参、多行注释块、#DIM 声明 */
  const SRC = [
    ';==================================================',
    ';660,読書',
    ';TFLAG:193(選択肢文学(1=忍殺(文学？) 2=失敗 3=文学),…)',
    ';==================================================',
    '@M_KOJO_MESSAGE_COM_K1_30',
    'PRINTFORMW 文本',
    'END',
    '#FUNCTION',
    '@AUTO_AEGI',
    'END',
    '@M_KOJO_K1_恋慕',
    'END',
    '#DIM STATUS[10]',
    '',
  ].join('\n');

  it('与 parseErbText 直出结果逐字段相同（经 JSON 一趟）', () => {
    const parsed = parseErbText(SRC, '/p/M_KOJO_K1_MESSAGE.ERB');
    const entries: Record<string, SnapshotEntry> = {
      '/p/M_KOJO_K1_MESSAGE.ERB': { mtimeMs: 123.5, textLength: SRC.length, file: parsed },
    };
    const restored = decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))!;
    const back = restored['/p/M_KOJO_K1_MESSAGE.ERB']!;

    expect(back.mtimeMs).toBe(123.5);
    expect(back.textLength).toBe(SRC.length);
    expect(back.file).toEqual(parsed); // 深相等：含 name/normalizedName/params/行号/flags/docComment/dims
    expect(back.file.functions.length).toBe(parsed.functions.length);
    expect(back.file.functions.some((f) => f.isExpressionFunction)).toBe(true);
    expect(back.file.functions.some((f) => f.docComment !== undefined)).toBe(true);
  });

  it('聚合结果也必须与直出一致（byName 顺序、引用等价语义）', () => {
    const parsed = parseErbText(SRC, '/p/a.ERB');
    const restored = decodeEntries(
      JSON.parse(JSON.stringify(encodeEntries({ '/p/a.ERB': { mtimeMs: 1, textLength: 1, file: parsed } }))),
    )!;
    const direct = aggregateIndex([parsed]);
    const viaSnapshot = aggregateIndex([restored['/p/a.ERB']!.file]);
    expect([...viaSnapshot.byName.keys()]).toEqual([...direct.byName.keys()]);
    expect(viaSnapshot.byName.get('M_KOJO_MESSAGE_COM_K1_30')).toEqual(direct.byName.get('M_KOJO_MESSAGE_COM_K1_30'));
  });

  it('体积确实降下来（可派生字段与键名不再上盘）', () => {
    const entries: Record<string, SnapshotEntry> = {};
    for (let i = 0; i < 200; i++) entries[`/p/dir/file${i}.ERB`] = entry(`/p/dir/file${i}.ERB`, i, [`M_KOJO_K${i}_NAME`]);
    const slim = JSON.stringify(encodeEntries(entries)).length;
    const fat = JSON.stringify(entries).length;
    expect(slim).toBeLessThan(fat * 0.75);
    // 剥掉的必须正是可派生数据，而不是任何语义信息
    expect(decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))).toEqual(entries);
  });

  it('结构损坏一律 null（fail-closed，绝不"修"快照）', () => {
    const good = encodeEntries({ '/a.ERB': entry('/a.ERB', 1, ['FOO']) });
    const bad = (mut: (e: Record<string, unknown>) => void) => {
      const clone = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      mut(clone);
      return decodeEntries(clone);
    };
    expect(decodeEntries(undefined)).toBeNull();
    expect(decodeEntries('nope')).toBeNull();
    expect(decodeEntries({ '/a.ERB': [1, 1, 1, 0, [], []].slice(0, 5) })).toBeNull(); // 元数不对
    expect(bad((e) => (e['/a.ERB'] as unknown[])[3] = 2)).toBeNull(); // hasDirective 非 0|1
    expect(bad((e) => (e['/a.ERB'] as unknown[])[1] = 'x')).toBeNull(); // textLength 非数
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[4] = [[['FOO', 1]]]))).toBeNull(); // 函数元组元数
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[4] = [['FOO', 1, 2, [[['A', 3]]], 0]]))).toBeNull(); // 形参标记非 0|1
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[4] = [['FOO', 1, 2, [], 0, 5]]))).toBeNull(); // 注释非字符串
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[5] = [['X']]))).toBeNull(); // dims 元数
  });

  it('mtime 为 null 必须能原样往返（保守失效判据不能编造成数字）', () => {
    const entries = { '/a.ERB': entry('/a.ERB', null, ['FOO']) };
    expect(decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))).toEqual(entries);
  });

  /**
   * 哨兵：元组编码是**位置契约**，ErbFile / ErbFunction 增删字段时这里会红——
   * 提醒同步改编解码并 bump SNAPSHOT_VERSION（漏改的后果是快照静默丢字段）。
   */
  it('字段清单哨兵（新增字段必须同步编解码并升版本）', () => {
    const parsed = parseErbText('@FOO\n;doc\nEND\n', '/a.ERB');
    expect(Object.keys(parsed).sort()).toEqual(['dims', 'functions', 'hasFunctionDirective', 'lineCount', 'path']);
    const fn = parsed.functions[0]!;
    expect(
      Object.keys({
        ...fn,
        isExpressionFunction: false,
        docComment: '',
      }).sort(),
    ).toEqual(['docComment', 'endLine', 'filePath', 'isExpressionFunction', 'name', 'normalizedName', 'params', 'startLine']);
    expect(Object.keys(parsed.dims[0] ?? { name: '', directive: '', line: 0 }).sort()).toEqual([
      'directive',
      'line',
      'name',
    ]);
  });
});

describe('coerceSnapshot（fail-closed）', () => {
  it('合法快照 round-trip 后可还原（含派生字段回填）', () => {
    const entries = { '/a.ERB': entry('/a.ERB', 100, ['FOO']) };
    const back = coerceSnapshot(JSON.parse(JSON.stringify(snapshot(entries))), ROOT);
    expect(back).not.toBeNull();
    expect(back!.entries).toEqual(entries);
    expect(back!.entries['/a.ERB']!.file.functions[0]!.normalizedName).toBe('FOO');
  });

  it('版本 / 项目根 / savedAt / 条目结构任一不符 → null（整体弃用）', () => {
    const snap = snapshot({ '/a.ERB': entry('/a.ERB', 100, ['FOO']) }) as unknown as Record<string, unknown>;
    expect(coerceSnapshot({ ...snap, version: SNAPSHOT_VERSION + 1 }, ROOT)).toBeNull();
    expect(coerceSnapshot(snap, 'D:/other')).toBeNull();
    expect(coerceSnapshot({ ...snap, savedAt: 'x' }, ROOT)).toBeNull();
    expect(coerceSnapshot({ ...snap, entries: { '/x.ERB': { mtimeMs: 1 } } }, ROOT)).toBeNull();
    expect(coerceSnapshot({ ...snap, entries: null }, ROOT)).toBeNull();
    expect(coerceSnapshot('garbage', ROOT)).toBeNull();
    expect(coerceSnapshot(null, ROOT)).toBeNull();
  });
});

describe('pruneSnapshotKeys（索引快照统一单文件语义）', () => {
  const KEEP = snapshotKeyFor(ROOT);

  it('只留当前项目的键，删掉其它项目的快照', () => {
    const keys = [KEEP, snapshotKeyFor('D:/other'), snapshotKeyFor('D:/third')];
    expect(pruneSnapshotKeys(keys, KEEP).sort()).toEqual([snapshotKeyFor('D:/other'), snapshotKeyFor('D:/third')].sort());
  });

  it('格式升级遗留的旧版本键也清掉（v1/v2 孤儿不再永远躺着）', () => {
    expect(pruneSnapshotKeys(['index-v1-aabbccdd', 'index-v2-11223344', KEEP], KEEP)).toEqual([
      'index-v1-aabbccdd',
      'index-v2-11223344',
    ]);
  });

  it('非快照形态的键一律不碰（不越权删别人的东西）', () => {
    const others = ['registry', 'notes.json', 'index-vX-zzzz', 'index-v3-abc'];
    expect(pruneSnapshotKeys([...others, KEEP], KEEP)).toEqual([]);
  });

  it('keepKey 不在列表里也照常清理（当前项目还没落盘的场景）', () => {
    expect(pruneSnapshotKeys(['index-v2-aabbccdd'], KEEP)).toEqual(['index-v2-aabbccdd']);
  });

  it('空列表 ⇒ 空操作', () => {
    expect(pruneSnapshotKeys([], KEEP)).toEqual([]);
  });
});

describe('mergeEntries（收尸 + 沿用）', () => {
  it('本次重扫的用新结果；其余沿用旧条目；消失的文件不保留', () => {
    const prev = coerceSnapshot(
      snapshot({
        '/a.ERB': entry('/a.ERB', 100, ['FOO']),
        '/gone.ERB': entry('/gone.ERB', 100, ['GONE']),
      }),
      ROOT,
    )!;
    const fresh = new Map<string, SnapshotEntry>([['/b.ERB', entry('/b.ERB', 200, ['NEW'])]]);
    const merged = mergeEntries(prev, ['/a.ERB', '/b.ERB'], fresh);
    expect(Object.keys(merged).sort()).toEqual(['/a.ERB', '/b.ERB']);
    expect(merged['/b.ERB']!.file.functions[0]!.name).toBe('NEW');
    expect(merged['/a.ERB']).toEqual(prev.entries['/a.ERB']);
    expect(merged['/gone.ERB']).toBeUndefined();
  });
});
