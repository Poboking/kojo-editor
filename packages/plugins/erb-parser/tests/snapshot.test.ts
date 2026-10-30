import { describe, expect, it } from 'vitest';
import type { ErbFile } from '@kojo/plugin-api';
import { parseErbText } from '../src/scanner';
import {
  SNAPSHOT_VERSION,
  aggregateIndex,
  candidateHashesFromTokens,
  coerceSnapshot,
  decodeCandidateHashes,
  decodeEntries,
  diffSnapshot,
  encodeCandidateHashes,
  encodeEntries,
  hashToken,
  mergeEntries,
  pruneSnapshotKeys,
  refsProvableUnchanged,
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

function entry(path: string, mtimeMs: number | null, names: readonly string[], size: number | null = 4096): SnapshotEntry {
  // v4 起 decode 恒回填 refs（缺 = 结构不符）；v11 起候选集键恒在（空数组 = 已知没有候选）；
  // 夹具同形，round-trip 判据才不空转。v12 起内存形态是 `Uint32Array`（哈希集）
  return { mtimeMs, size, textLength: 1000, file: file(path, names), refs: [], candidateHashes: new Uint32Array(0) };
}

/** 盘上形态：v5 起 entries 是位置元组（第 2 位 size、第 8 位引用流水），内存形状只在加载后存在 */
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

  it('快照懒外壳（未经还原）与直出 ErbFile 混装聚合，byName 逐项相同', () => {
    const parsed = parseErbText('@FOO\n;doc\nEND\n@BAR\nEND\n', '/p/a.ERB');
    const encoded = encodeEntries({ '/p/a.ERB': { mtimeMs: 1, size: 9, textLength: 9, file: parsed } });
    const decoded = decodeEntries(JSON.parse(JSON.stringify(encoded)))!;
    const viaSnapshot = aggregateIndex([decoded['/p/a.ERB']!.file]);
    const direct = aggregateIndex([parsed]);
    expect([...viaSnapshot.byName.keys()]).toEqual([...direct.byName.keys()]);
    expect(viaSnapshot.byName.get('FOO')).toEqual(direct.byName.get('FOO'));
    // 聚合不消费 functions ⇒ 懒字段仍是 accessor（100k 函数对象的构造留给真正要读的人）
    const view = decoded['/p/a.ERB']!.file;
    expect(Object.getOwnPropertyDescriptor(view, 'functions')?.get).toBeTypeOf('function');
  });
});

describe('diffSnapshot（保守失效，mtime + size 双判据）', () => {
  const snap = coerceSnapshot(
    snapshot({
      '/a.ERB': entry('/a.ERB', 100, ['FOO'], 4000),
      '/b.ERB': entry('/b.ERB', null, ['BAR']), // 平台未提供 mtime
      '/c.ERB': entry('/c.ERB', 100, ['BAZ'], null), // 构建时取不到 size
    }),
    ROOT,
  )!;

  it('mtime 与 size 都一致 → 复用；缺失 / 变了 / 任一侧 null → 过期', () => {
    const stats = new Map([
      ['/a.ERB', { mtimeMs: 100, size: 4000 }],
      ['/b.ERB', { mtimeMs: 100, size: 4000 }],
      ['/c.ERB', { mtimeMs: 100, size: 4000 }],
      ['/d.ERB', { mtimeMs: 100, size: 4000 }], // 快照里没有
      ['/e.ERB', null], // stat 失败
    ]);
    const d = diffSnapshot(snap, ['/a.ERB', '/b.ERB', '/c.ERB', '/d.ERB', '/e.ERB'], stats as never);
    expect(d.reusable).toEqual(['/a.ERB']);
    expect(d.stale).toEqual(['/b.ERB', '/c.ERB', '/d.ERB', '/e.ERB']);
  });

  it('mtime 同值但 size 变了 → 判过期（保留时间戳的替换被 size 兜住）', () => {
    const stats = new Map([['/a.ERB', { mtimeMs: 100, size: 4001 }]]);
    expect(diffSnapshot(snap, ['/a.ERB'], stats as never).stale).toEqual(['/a.ERB']);
  });

  it('mtime 或 size 是浮点也必须逐位相等（同源口径才可比）', () => {
    const floatMtime = new Map([['/a.ERB', { mtimeMs: 100.5, size: 4000 }]]);
    expect(diffSnapshot(snap, ['/a.ERB'], floatMtime as never).reusable).toEqual([]);
    const floatSize = new Map([['/a.ERB', { mtimeMs: 100, size: 4000.5 }]]);
    expect(diffSnapshot(snap, ['/a.ERB'], floatSize as never).reusable).toEqual([]);
  });
});

describe('v3 元组编解码（瘦身不改语义；v5：+size、懒还原）', () => {
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
      '/p/M_KOJO_K1_MESSAGE.ERB': { mtimeMs: 123.5, size: 2048, textLength: SRC.length, file: parsed },
    };
    const restored = decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))!;
    const back = restored['/p/M_KOJO_K1_MESSAGE.ERB']!;

    expect(back.mtimeMs).toBe(123.5);
    expect(back.size).toBe(2048);
    expect(back.textLength).toBe(SRC.length);
    expect(back.file).toEqual(parsed); // 深相等：含 name/normalizedName/params/行号/flags/docComment/dims
    expect(back.file.functions.length).toBe(parsed.functions.length);
    expect(back.file.functions.some((f) => f.isExpressionFunction)).toBe(true);
    expect(back.file.functions.some((f) => f.docComment !== undefined)).toBe(true);
  });

  it('聚合结果也必须与直出一致（byName 顺序、引用等价语义）', () => {
    const parsed = parseErbText(SRC, '/p/a.ERB');
    const restored = decodeEntries(
      JSON.parse(JSON.stringify(encodeEntries({ '/p/a.ERB': { mtimeMs: 1, size: 1, textLength: 1, file: parsed } }))),
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

  it('结构损坏一律 null（fail-closed，绝不"修"快照；懒还原不打折校验）', () => {
    const good = encodeEntries({ '/a.ERB': entry('/a.ERB', 1, ['FOO']) });
    const bad = (mut: (e: Record<string, unknown>) => void) => {
      const clone = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
      mut(clone);
      return decodeEntries(clone);
    };
    expect(decodeEntries(undefined)).toBeNull();
    expect(decodeEntries('nope')).toBeNull();
    expect(decodeEntries({ '/a.ERB': [1, 1, 1, 1, 0, [], [], []].slice(0, 7) })).toBeNull(); // 元数不对
    expect(bad((e) => (e['/a.ERB'] as unknown[])[4] = 2)).toBeNull(); // hasDirective 非 0|1
    expect(bad((e) => (e['/a.ERB'] as unknown[])[1] = 'x')).toBeNull(); // size 非数非 null
    expect(bad((e) => (e['/a.ERB'] as unknown[])[2] = 'x')).toBeNull(); // textLength 非数
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[5] = [[['FOO', 1]]]))).toBeNull(); // 函数元组元数
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[5] = [['FOO', 1, 2, [[['A', 3]]], 0]]))).toBeNull(); // 形参标记非 0|1
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[5] = [['FOO', 1, 2, [], 0, 5]]))).toBeNull(); // 注释非字符串
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[6] = [['X']]))).toBeNull(); // dims 元数
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[7] = [['FOO', 1, 2]]))).toBeNull(); // refs 元数（v4 新增位）
    expect(bad((e) => ((e['/a.ERB'] as unknown[])[7] = [['FOO', 1, 2, 3]]))).toBeNull(); // refs 种类旗标非 0|1|2
    expect(bad((e) => ((e['/a.ERB'] as unknown[]).length = 7))).toBeNull(); // refs 位缺失（v4 形态整弃）
    // 深层损坏也要在 decode 时被查掉（懒还原不许把 fail-closed 推迟到消费方）
    const twoEntries = encodeEntries({
      '/a.ERB': entry('/a.ERB', 1, ['FOO']),
      '/b.ERB': entry('/b.ERB', 2, ['BAR']),
    });
    (twoEntries['/b.ERB']![7] as unknown[])[0] = ['BAR', 1, 2, 9];
    expect(decodeEntries(twoEntries)).toBeNull();
  });

  it('refs 流水非空也必须原样往返（反向索引热复用的判据来源）', () => {
    const src: SnapshotEntry = {
      mtimeMs: 5,
      size: 128,
      textLength: 42,
      file: file('/a.ERB', ['FOO']),
      refs: [['FOO', 1, 1, 0], ['FOO', 3, 6, 1], ['BAR', 9, 2, 2]],
    };
    const back = decodeEntries(JSON.parse(JSON.stringify(encodeEntries({ '/a.ERB': src }))))!;
    expect(back['/a.ERB']!.refs).toEqual(src.refs);
  });

  it('mtime / size 为 null 必须能原样往返（保守失效判据不能编造成数字）', () => {
    const entries = { '/a.ERB': entry('/a.ERB', null, ['FOO'], null) };
    expect(decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))).toEqual(entries);
  });

  it('懒还原两段：decode 后 functions/dims 是 getter，读一次换值属性；refs 零拷贝别名元组', () => {
    const parsed = parseErbText(SRC, '/p/a.ERB');
    const entries = { '/p/a.ERB': { mtimeMs: 1, size: 10, textLength: 10, file: parsed, refs: [['FOO', 1, 1, 0]] as never } };
    const payload = JSON.parse(JSON.stringify(encodeEntries(entries))) as Record<string, unknown>;
    const decoded = decodeEntries(payload)!;
    const e = decoded['/p/a.ERB']!;

    // 装载只建轻外壳：重字段未建对象（accessor 在位、Enumerable 保持）
    const fDesc = Object.getOwnPropertyDescriptor(e.file, 'functions')!;
    expect(fDesc.get).toBeTypeOf('function');
    expect(fDesc.enumerable).toBe(true);
    expect(Object.keys(e.file)).toContain('functions');
    // refs 直接别名盘上元组（零拷贝）
    expect(e.refs).toBe((payload['/p/a.ERB'] as unknown[])[7]);
    // 首次消费才还原，且与直出等值；再次读取零开销
    expect(e.file.functions).toEqual(parsed.functions);
    expect(Object.getOwnPropertyDescriptor(e.file, 'functions')!.get).toBeUndefined();
    const first = e.file.functions;
    expect(e.file.functions).toBe(first);
    expect(e.file.dims).toEqual(parsed.dims);
  });

  it('未经消费的懒条目落盘复用盘上元组（存盘不做无谓重建）', () => {
    const entries = { '/a.ERB': entry('/a.ERB', 7, ['FOO', 'BAR']) };
    const payload = JSON.parse(JSON.stringify(encodeEntries(entries))) as Record<string, unknown>;
    // 解码会**就地**把元组第 11 位翻成 `Uint32Array`（零拷贝别名）⇒ 先留一份原样做对照
    const original = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const decoded = decodeEntries(payload)!;
    const re = encodeEntries(decoded);
    const before = original['/a.ERB'] as unknown[];
    const after = re['/a.ERB'] as unknown[];
    expect(after).toEqual(before); // 内容逐位相同（含候选位的 base64 往返）
    // v12 起候选位在内存里是 `Uint32Array`、盘上要 base64 ⇒ 快路径得**浅拷一层**元组换形态，
    // 整枚数组的身份因此保不住。要省的从来是"重建 10 万级函数元组"，判据落在那几位上：
    const live = payload['/a.ERB'] as unknown[];
    expect(after[5]).toBe(live[5]); // 函数元组数组：零重建（同一枚对象）
    expect(after[7]).toBe(live[7]); // 引用流水：零拷贝别名
    expect(after[6]).toBe(live[6]); // 声明变量
    // 消费过的条目走重建路径，内容仍逐字段等值
    void decoded['/a.ERB']!.file.functions;
    expect(encodeEntries(decoded)['/a.ERB']).toEqual(before);
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
        nameColumn: 1,
      }).sort(),
    ).toEqual([
      'docComment',
      'endLine',
      'filePath',
      'isExpressionFunction',
      'name',
      'nameColumn',
      'normalizedName',
      'params',
      'startLine',
    ]);
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

describe('pruneSnapshotKeys（保留集 = 传入的键集合，其余快照键回收）', () => {
  const KEEP = snapshotKeyFor(ROOT);

  it('只留传入的键，删掉其它项目的快照', () => {
    const keys = [KEEP, snapshotKeyFor('D:/other'), snapshotKeyFor('D:/third')];
    expect(pruneSnapshotKeys(keys, KEEP).sort()).toEqual([snapshotKeyFor('D:/other'), snapshotKeyFor('D:/third')].sort());
  });

  it('保留集可含多个键（本会话工作集：交替开项目不互删）', () => {
    const other = snapshotKeyFor('D:/other');
    const third = snapshotKeyFor('D:/third');
    expect(pruneSnapshotKeys([KEEP, other, third], [KEEP, other])).toEqual([third]);
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

/**
 * 候选记号哈希集（v12 / MEM-6）：编解码往返 + 免扫判据的保守性。
 *
 * 这一组是**为两个真实抓到的洞**写的：
 * 1. base64 解码用"逐字符累积 `buf`"时，`bits` 到 30 再 `<< 6` 变成 36 位，而 JS 的 `<<`
 *    是 int32 运算 ⇒ 高位静默丢失。表现是**哈希全变、免扫判据把一切判成"可证不变"**
 *    （少扫文件、不报错）。所以这里逐个长度钉往返，且把 `0xFFFFFFFF` 这种全 1 值单列。
 * 2. 免扫判据必须**只可能多扫、不可能漏扫**：碰撞方向上不能反过来。
 */
describe('候选记号哈希集（v12：从 17M 字符的串换成哈希）', () => {
  it('hashToken：跨调用稳定、同串同值、不同串基本不同', () => {
    expect(hashToken('FOO_C')).toBe(hashToken('FOO_C'));
    expect(hashToken('')).toBe(hashToken(''));
    expect(hashToken('FOO_C')).not.toBe(hashToken('FOO_D'));
    // 32 位无符号（落盘要 base64，负数会被 `>>> 0` 与位运算的差异坑到）
    for (const s of ['', 'A', 'M_KOJO_K1_300', 'あいう', 'x'.repeat(200)]) {
      const h = hashToken(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('encodeCandidateHashes / decodeCandidateHashes：0..9 枚逐个往返（含全 1 值）', () => {
    const cases = [
      0x00000000, 0xffffffff, 0x00000001, 0x80000000, 0x7fffffff, 0x01020304, 0xdeadbeef, 0x0000ffff, 0xff000000,
    ];
    for (let n = 0; n <= cases.length; n++) {
      const src = Uint32Array.from(cases.slice(0, n));
      const text = encodeCandidateHashes(src);
      if (n === 0) expect(text).toBe('');
      else expect(text.length % 4).toBe(0); // base64 长度恒为 4 的倍数
      const back = decodeCandidateHashes(text);
      expect(back).not.toBeNull();
      expect(Array.from(back!)).toEqual(Array.from(src));
    }
  });

  it('decodeCandidateHashes：长度/字符非法 ⇒ null（fail-closed，不许猜）', () => {
    expect(decodeCandidateHashes('AAA')).toBeNull(); // 不是 4 的倍数
    expect(decodeCandidateHashes('AA*A')).toBeNull(); // 字母表外
    expect(decodeCandidateHashes('AAAA')).toBeNull(); // 3 字节 < 一枚哈希的 4 B ⇒ 元数不符
    expect(decodeCandidateHashes('AAAAA')).toBeNull();
    expect(decodeCandidateHashes('')).toEqual(new Uint32Array(0)); // 空集是合法事实（已知没有候选）
  });

  it('candidateHashesFromTokens：v11 的记号串就地哈希（v11 → v12 的免费迁移）', () => {
    const tokens = ['FOO_A', 'M_KOJO_K1_300', 'BAR_B'];
    const hashes = candidateHashesFromTokens(tokens.join('\n'));
    expect(Array.from(hashes)).toEqual(tokens.map(hashToken));
    expect(candidateHashesFromTokens('').length).toBe(0); // 空串 = 已知没有候选
  });

  it('refsProvableUnchanged：命中即重扫、未命中即可证；候选未知一律重扫', () => {
    const e = {
      mtimeMs: 1,
      size: 2,
      textLength: 3,
      file: file('/a.ERB', ['FOO_A']),
      refs: [],
      candidateHashes: candidateHashesFromTokens('FOO_A\nBAR_B'),
    } as unknown as SnapshotEntry;
    // 差集里没有本文件的候选 ⇒ 可证 refs 不变（免扫）
    expect(refsProvableUnchanged(e, new Set([hashToken('OTHER')]))).toBe(true);
    // 差集里有 ⇒ 嫌疑坐实（重扫）
    expect(refsProvableUnchanged(e, new Set([hashToken('BAR_B')]))).toBe(false);
    // 空差集（名录没变）⇒ 当然可证
    expect(refsProvableUnchanged(e, new Set())).toBe(true);
    // 候选未知（v10 迁移条目）⇒ 保守侧重扫，绝不猜
    expect(refsProvableUnchanged({ ...e, candidateHashes: undefined } as unknown as SnapshotEntry, new Set())).toBe(false);
    // refs 缺失 ⇒ 谈不上"refs 不变"
    expect(refsProvableUnchanged({ ...e, refs: undefined } as unknown as SnapshotEntry, new Set())).toBe(false);
    // 已知空集 ⇒ 任何名录变化都碰不到它
    expect(
      refsProvableUnchanged({ ...e, candidateHashes: new Uint32Array(0) } as unknown as SnapshotEntry, new Set([hashToken('X')])),
    ).toBe(true);
  });

  it('落盘往返：候选位 base64 → Uint32Array → base64 逐字节相同', () => {
    const hashes = candidateHashesFromTokens('A\nB\nC\nD\nE');
    const entries = {
      '/a.ERB': {
        mtimeMs: 7,
        size: 4096,
        textLength: 1000,
        file: file('/a.ERB', ['A']),
        refs: [],
        candidateHashes: hashes,
      } as unknown as SnapshotEntry,
    };
    const payload = JSON.parse(JSON.stringify(encodeEntries(entries))) as Record<string, unknown[]>;
    expect(typeof payload['/a.ERB']![10]).toBe('string'); // 盘上是 base64
    // 解码会**就地**把元组第 11 位翻成 `Uint32Array` ⇒ 先把盘上串留一份再解
    const disk = payload['/a.ERB']![10] as string;
    const decoded = decodeEntries(payload)!;
    expect(Array.from(decoded['/a.ERB']!.candidateHashes!)).toEqual(Array.from(hashes));
    // 再编一次：与第一次的盘上串逐字节相同（幂等）
    expect(encodeEntries(decoded)['/a.ERB']![10]).toBe(disk);
  });
});
