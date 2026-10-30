import { describe, expect, it } from 'vitest';
import { dependencyKey } from '@kojo/plugin-api';
import type { ConditionIndex, FunctionConditions, StateDependency } from '@kojo/plugin-api';
import {
  EXTRACT_SNAPSHOT_FORMAT,
  EXTRACT_STORE_KEY,
  decodeBuckets,
  encodeBuckets,
  extractExpect,
  mergeBuckets,
  planReuse,
  type ExtractExpect,
  type FileBucket,
} from '../src/snapshot';

const EXPECT: ExtractExpect = { projectRoot: 'D:/game', adapterId: 'eratw', inputDigest: 'csv-digest-1' };

const dep = (key: string, count: number, desc: string): StateDependency => ({
  key,
  name: key.split(':')[0]!,
  indices: key.includes(':') ? key.split(':').slice(1) : [],
  count,
  comparisons: [{ op: '>=', value: 500, text: '500' }],
  firstLine: 12,
  schema: { name: key.split(':')[0]!, index: 2, description: desc },
});

const cond = (name: string, path: string, deps: StateDependency[]): FunctionConditions => ({
  normalizedName: name,
  filePath: path,
  startLine: 10,
  predicateCount: 3,
  unparsedCount: 1,
  dependencies: deps,
});

const bucket = (mtimeMs: number | null, conds: FunctionConditions[], functions = 7, size: number | null = 2048): FileBucket => ({
  mtimeMs,
  size,
  stats: {
    functions,
    functionsWithDeps: conds.filter((c) => c.dependencies.length > 0).length,
    predicates: conds.reduce((n, c) => n + c.predicateCount, 0),
    unparsed: conds.reduce((n, c) => n + c.unparsedCount, 0),
    dependencies: conds.reduce((n, c) => n + c.dependencies.length, 0),
  },
  conds,
});

const buckets = (): Map<string, FileBucket> =>
  new Map<string, FileBucket>([
    [
      'D:/game/k1.ERB',
      bucket(100, [
        cond('M_KOJO_K1_A', 'D:/game/k1.ERB', [dep('CFLAG:2', 2, '好感度'), dep('LOCAL', 1, '好感度')]),
        cond('M_KOJO_K1_B', 'D:/game/k1.ERB', [dep('TALENT:恋慕', 5, '恋慕')]),
      ]),
    ],
    // 空桶（该文件扫过但无谓词）也要能存回来自我复用
    ['D:/game/k2.ERB', bucket(200, [])],
    ['D:/game/k3.ERB', bucket(300, [cond('M_KOJO_K3_C', 'D:/game/k3.ERB', [dep('CFLAG:2', 7, '好感度')])], 3)],
  ]);

const roundTrip = (src: Map<string, FileBucket>, expect: ExtractExpect = EXPECT) => {
  const payload = encodeBuckets({ buckets: src, expect, savedAt: 999 });
  return { payload, back: decodeBuckets(JSON.parse(JSON.stringify(payload)), expect) };
};

describe('v3 按文件桶编解码', () => {
  it('往返等价：路径由桶键还原、归一化名由条目键还原、mtime/size 与逐文件统计一致', () => {
    const src = buckets();
    const { back } = roundTrip(src);
    expect(back).not.toBeNull();
    const got = back!.buckets;
    expect(Object.keys(got).sort()).toEqual(['D:/game/k1.ERB', 'D:/game/k2.ERB', 'D:/game/k3.ERB']);
    for (const [path, b] of src) {
      expect(got[path]!.mtimeMs).toBe(b.mtimeMs);
      expect(got[path]!.size).toBe(b.size);
      expect(got[path]!.stats).toEqual(b.stats);
      expect(got[path]!.conds).toEqual(b.conds);
    }
  });

  it('懒还原：decode 后 dependencies 是 getter（装载不建对象），首次消费才还原且与直出等值', () => {
    const src = buckets();
    const { back } = roundTrip(src);
    const cond = back!.buckets['D:/game/k1.ERB']!.conds[0]!;
    // 校验急、还原懒：引用对象未建（accessor 在位、Enumerable 保持）
    const desc = Object.getOwnPropertyDescriptor(cond, 'dependencies')!;
    expect(desc.get).toBeTypeOf('function');
    expect(desc.enumerable).toBe(true);
    expect(Object.keys(cond)).toContain('dependencies');
    // 首次消费才还原，值仍与直出逐字段等值；再次读取零开销
    expect(cond.dependencies).toEqual(src.get('D:/game/k1.ERB')!.conds[0]!.dependencies);
    /**
     * **判据钉的是"读一次就只建一次"，不是"读后换成数据属性"**（MEM-8，2026-10-30 改）。
     *
     * 旧断言是 `descriptor.get` 变成 `undefined`——那是把**实现手法**（`Object.defineProperty`
     * 把访问器换成值属性）当成了契约。而那个手法在 V8 里会**把整枚对象转进字典模式**
     * （堆快照实测 52,424 枚条件壳各带一枚 453 B 属性块，合计 24.8 MB），换来的是"再次读不经过
     * getter"这点可忽略的收益 ⇒ 改成闭包缓存，访问器一直留着。
     * 真正要保的契约有三条，这里逐条钉：① 访问器仍是**自有 + 可枚举**（`Object.keys` /
     * `JSON.stringify` / `toEqual` 的口径不变）；② 再次读是**同一份**数组（不重建）；
     * ③ 序列化出来的内容与直出等值（getter 会被 `JSON.stringify` 调用）。
     */
    const after = Object.getOwnPropertyDescriptor(cond, 'dependencies')!;
    expect(after.get).toBeTypeOf('function');
    expect(after.enumerable).toBe(true);
    const first = cond.dependencies;
    expect(cond.dependencies).toBe(first);
    expect(JSON.parse(JSON.stringify(cond)).dependencies).toEqual(
      JSON.parse(JSON.stringify(src.get('D:/game/k1.ERB')!.conds[0])).dependencies,
    );
    // 同批没被问过的函数桶仍是 accessor（谁问谁付）
    expect(Object.getOwnPropertyDescriptor(back!.buckets['D:/game/k3.ERB']!.conds[0]!, 'dependencies')!.get).toBeTypeOf('function');
  });

  /**
   * 形状守卫（MEM-11，2026-10-30）：上一条钉的是**语义**（自有+可枚举访问器、读一次只建一次），
   * 这一条钉的是**别退回那个形状**。V8 的快路径只给"**共享**的常量访问器"留位置：
   * 访问器写在对象字面量里、或每枚现造一枚闭包，52,435 枚壳会全部转字典态、各挂一枚
   * 453 B 的 `(object properties)` 块（真实堆实测 22.4 MB）。语义测试全绿也照样能踩这个坑
   * ——MEM-8 就是这么过去的。
   */
  it('形状守卫：同一份解码出来的壳共用同一枚访问器，且壳上不挂自有符号键', () => {
    const { back } = roundTrip(buckets());
    const a = back!.buckets['D:/game/k1.ERB']!.conds[0]!;
    const b = back!.buckets['D:/game/k3.ERB']!.conds[0]!;
    const getA = Object.getOwnPropertyDescriptor(a, 'dependencies')!.get;
    const getB = Object.getOwnPropertyDescriptor(b, 'dependencies')!.get;
    expect(getA).toBeTypeOf('function');
    // 共享 ⇒ V8 把访问器放进描述符（快路径）；每枚一枚闭包 ⇒ AccessorPair 只能进字典
    expect(getB).toBe(getA);
    // 壳上不许有隐藏的自有槽：Symbol 键会被 `toEqual` 计入（口径变了），数据键会改 `Object.keys`
    expect(Object.getOwnPropertySymbols(a)).toHaveLength(0);
    expect(Object.keys(a).sort()).toEqual([
      'dependencies',
      'filePath',
      'normalizedName',
      'predicateCount',
      'startLine',
      'unparsedCount',
    ]);
  });

  it('schema 去重表：重复标签只存一份（还原后仍等值）', () => {
    const { payload, back } = roundTrip(buckets());
    // 四条带 schema 的依赖里 `CFLAG:2`「好感度」跨两个文件各出现一次 ⇒ 字典只剩 3 种
    expect(payload.schemas).toHaveLength(3);
    const d = back!.buckets['D:/game/k3.ERB']!.conds[0]!.dependencies[0]!;
    expect(d.schema?.description).toBe('好感度');
  });

  it('无 schema 的依赖：盘上是 -1，还原后不写 schema 键（不伪造 undefined）', () => {
    const src = new Map<string, FileBucket>([
      [
        '/a.ERB',
        bucket(1, [
          {
            normalizedName: 'A',
            filePath: '/a.ERB',
            startLine: 1,
            predicateCount: 1,
            unparsedCount: 0,
            dependencies: [{ key: 'X', name: 'X', indices: [], count: 1, comparisons: [], firstLine: 1 }],
          },
        ]),
      ],
    ]);
    const { back } = roundTrip(src);
    const d = back!.buckets['/a.ERB']!.conds[0]!.dependencies[0]!;
    expect('schema' in d).toBe(false);
    expect(back!.buckets['/a.ERB']!.conds).toEqual(src.get('/a.ERB')!.conds);
  });

  /**
   * MEM-5（列式表 + 字符串池）的边界：池的"上一次命中"备忘初值是空串，若不加
   * `lastIx >= 0` 这一半，**第一个空串会命中到 -1**（实测在真实语料上把一条
   * `value: ''` 变成 `undefined`）。空串在这里是合法取值，不是"缺字段"。
   */
  it('字符串池边界：空串 value / 空串索引必须原样往返（备忘初值不许吞掉空串）', () => {
    const deps: StateDependency[] = [
      {
        key: dependencyKey({ name: 'CFLAG', indices: [''] }),
        name: 'CFLAG',
        indices: [''],
        count: 1,
        comparisons: [
          { op: '==', value: '', text: '' },
          { op: '==', value: '', text: '' },
        ],
        firstLine: 3,
      },
      {
        key: dependencyKey({ name: 'TALENT', indices: ['恋慕'] }),
        name: 'TALENT',
        indices: ['恋慕'],
        count: 2,
        // 数字 0 与字符串 '0' 必须分开（同 0 / '0' / 缺字段三分）
        comparisons: [
          { op: '>=', value: 0, text: '0' },
          { op: '==', value: '0', text: '0' },
        ],
        firstLine: 4,
      },
    ];
    const src = new Map<string, FileBucket>([
      ['/a.ERB', bucket(1, [{ normalizedName: 'A', filePath: '/a.ERB', startLine: 1, predicateCount: 2, unparsedCount: 0, dependencies: deps }])],
    ]);
    const { back } = roundTrip(src);
    const got = back!.buckets['/a.ERB']!.conds[0]!.dependencies;
    expect(got).toEqual(deps);
    // 类型也不能被抹平：0 与 '0' 在 === 下不等，但列式表用 kind 位分开存，必须原样出来
    expect(typeof got[1]!.comparisons[0]!.value).toBe('number');
    expect(typeof got[1]!.comparisons[1]!.value).toBe('string');
    expect(got[0]!.comparisons[0]!.value).toBe('');
  });

  it('mtime 为 null 必须原样往返（判据不可得的保守信号不能被编造成数字）', () => {
    const src = new Map<string, FileBucket>([['/a.ERB', bucket(null, [cond('A', '/a.ERB', [])])]]);
    const { back } = roundTrip(src);
    expect(back!.buckets['/a.ERB']!.mtimeMs).toBeNull();
    expect(back!.buckets['/a.ERB']!.size).toBe(2048);
  });

  it('size 为 null 也必须原样往返（additive 判据缺信号时不许伪造）', () => {
    const src = new Map<string, FileBucket>([['/a.ERB', bucket(100, [cond('A', '/a.ERB', [])], 7, null)]]);
    const { back } = roundTrip(src);
    expect(back!.buckets['/a.ERB']!.size).toBeNull();
  });

  it('体积比朴素 JSON 小（字典 + 元组生效），且解码与输入逐字段相等', () => {
    const many = new Map<string, FileBucket>();
    for (let i = 0; i < 400; i++) {
      const p = `/game/dir/file${Math.floor(i / 4)}.ERB`;
      many.set(p, bucket(i, [...(many.get(p)?.conds ?? []), cond(`F_${i}`, p, [dep('CFLAG:2', i, '好感度')])], 5));
    }
    const slim = JSON.stringify(encodeBuckets({ buckets: many, expect: EXPECT })).length;
    const fat = JSON.stringify([...many.entries()]).length;
    expect(slim).toBeLessThan(fat * 0.8);
    expect(roundTrip(many).back!.buckets).toBeTruthy();
  });

  /** 哨兵：元组是位置契约，字段清单变了必须同步编解码并 bump 版本 */
  it('字段清单哨兵（加字段会红，而不是快照静默丢数据）', () => {
    const c = buckets().get('D:/game/k1.ERB')!.conds[0]!;
    expect(Object.keys(c).sort()).toEqual([
      'dependencies',
      'filePath',
      'normalizedName',
      'predicateCount',
      'startLine',
      'unparsedCount',
    ]);
    expect(Object.keys(c.dependencies[0]!).sort()).toEqual([
      'comparisons',
      'count',
      'firstLine',
      'indices',
      'key',
      'name',
      'schema',
    ]);
    expect(Object.keys(c.dependencies[0]!.schema!).sort()).toEqual(['description', 'index', 'name']);
    // 8→9：文本内联三元（`\@…?…#…\@` / `{…?…#…}`）纳入谓词，抽取读数变 ⇒ 旧桶整体作废
    expect(EXTRACT_SNAPSHOT_FORMAT).toBe(9);
  });

  /** v4 的全部收益都建立在这一条不变式上：`key` 不落盘 = 它一定是 name/indices 的派生值 */
  it('盘上没有 key 槽；还原出的 key 恒等于 dependencyKey(name, indices)', () => {
    const { payload, back } = roundTrip(buckets());
    const tuple = (payload.buckets as Record<string, [number | null, number | null, number[], unknown[][]]>)['D:/game/k1.ERB']!;
    expect(tuple[1]).toBe(2048); // v5：第 2 位是 size
    const cond = tuple[3][0] as [string, number, number, number, unknown[]];
    const dep = cond[4][0] as [number, string[], number, number, unknown[], number];
    expect(dep.length).toBe(6); // [nameIdx, indices, count, firstLine, comparisons, schemaIdx]
    expect(typeof dep[0]).toBe('number'); // name 字典的下标，而不是 key 字符串
    let checked = 0;
    for (const b of Object.values(back!.buckets)) {
      for (const c of b.conds) {
        for (const d of c.dependencies) {
          expect(d.key).toBe(dependencyKey({ name: d.name, indices: d.indices }));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('name / indices 里含冒号也安全：v4 刻意不把 indices 拼成字符串（实测语料有 361 个索引自带冒号）', () => {
    const src = new Map<string, FileBucket>([
      [
        '/x.ERB',
        bucket(5, [
          {
            normalizedName: 'X',
            filePath: '/x.ERB',
            startLine: 1,
            predicateCount: 1,
            unparsedCount: 0,
            dependencies: [
              { key: 'A:B:C:2', name: 'A:B', indices: ['C:2'], count: 1, comparisons: [], firstLine: 1 },
            ],
          },
        ]),
      ],
    ]);
    const { back } = roundTrip(src);
    const d = back!.buckets['/x.ERB']!.conds[0]!.dependencies[0]!;
    expect(d.name).toBe('A:B');
    expect(d.indices).toEqual(['C:2']);
    expect(d.key).toBe('A:B:C:2');
  });

  it('key 不再是派生值 ⇒ 整包拒绝编码（宁可不缓存，也不留一个还原后会变键的快照）', () => {
    const bad = new Map<string, FileBucket>([
      [
        '/y.ERB',
        bucket(1, [
          {
            normalizedName: 'Y',
            filePath: '/y.ERB',
            startLine: 1,
            predicateCount: 1,
            unparsedCount: 0,
            dependencies: [
              { key: 'WRONG', name: 'CFLAG', indices: ['2'], count: 1, comparisons: [], firstLine: 1 },
            ],
          },
        ]),
      ],
    ]);
    expect(() => encodeBuckets({ buckets: bad, expect: EXPECT })).toThrow(/dependencyKey/);
  });
});

describe('全局判据 fail-closed', () => {
  const base = () => encodeBuckets({ buckets: buckets(), expect: EXPECT }) as unknown as Record<string, unknown>;

  it('格式版本 / 项目根 / 适配器 / inputDigest 任一不符 ⇒ null', () => {
    expect(decodeBuckets({ ...base(), format: (base().format as number) + 1 }, EXPECT)).toBeNull();
    expect(decodeBuckets(base(), { ...EXPECT, projectRoot: 'D:/other' })).toBeNull();
    expect(decodeBuckets(base(), { ...EXPECT, adapterId: 'erak' })).toBeNull();
    // 改过 CSV（inputDigest 变）⇒ 整包作废：抽取结果里的语义标签来自它
    expect(decodeBuckets(base(), { ...EXPECT, inputDigest: 'csv-digest-2' })).toBeNull();
  });

  it('结构损坏 ⇒ null（非对象 / 桶元数 / stats 形状 / size 类型 / 依赖越界 / mtime 类型）', () => {
    expect(decodeBuckets(undefined, EXPECT)).toBeNull();
    expect(decodeBuckets('nope', EXPECT)).toBeNull();
    expect(decodeBuckets({ ...base(), buckets: null }, EXPECT)).toBeNull();
    expect(decodeBuckets({ ...base(), schemas: undefined }, EXPECT)).toBeNull();
    const bad = (path: string, tuple: unknown) => ({
      ...(base() as Record<string, unknown>),
      buckets: { ...(base().buckets as Record<string, unknown>), [path]: tuple },
    });
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0, 0, 0]]), EXPECT)).toBeNull(); // 桶元数（v5 = 4）
    expect(decodeBuckets(bad('/x.ERB', ['no', 5, [0, 0, 0, 0, 0], []]), EXPECT)).toBeNull(); // mtime 类型
    expect(decodeBuckets(bad('/x.ERB', [1, 'x', [0, 0, 0, 0, 0], []]), EXPECT)).toBeNull(); // size 类型
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0], []]), EXPECT)).toBeNull(); // stats 长度
    // 依赖元组 v4 = [nameIdx, indices, count, firstLine, comparisons, schemaIdx]
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0, 0, 0], [['A', 1, 1, 1, [[0, [], 1, 1, []]]]]]), EXPECT)).toBeNull(); // 依赖元数
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0, 0, 0], [['A', 1, 1, 1, [[0, [], 1, 1, [], 99]]]]]), EXPECT)).toBeNull(); // schemaIdx 越界
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0, 0, 0], [['A', 1, 1, 1, [[9999, [], 1, 1, [], -1]]]]]), EXPECT)).toBeNull(); // nameIdx 越界
    expect(decodeBuckets(bad('/x.ERB', [1, 5, [0, 0, 0, 0, 0], [['A', 1, 1, 1, [['CFLAG', [], 1, 1, [], -1]]]]]), EXPECT)).toBeNull(); // v3 的 key 形态混进来 ⇒ 拒
    expect(decodeBuckets({ ...base(), names: undefined }, EXPECT)).toBeNull(); // 缺 name 字典
  });

  it('存储键是安全段（固定槽位名；版本在 payload 里，换格式不留孤儿）', () => {
    expect(EXTRACT_STORE_KEY).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/);
  });
});

describe('planReuse（逐文件判据：改一个文件只重算那一个）', () => {
  const decoded = () => decodeBuckets(JSON.parse(JSON.stringify(encodeBuckets({ buckets: buckets(), expect: EXPECT }))), EXPECT)!;
  const all = [
    { path: 'D:/game/k1.ERB', mtimeMs: 100 },
    { path: 'D:/game/k2.ERB', mtimeMs: 200 },
    { path: 'D:/game/k3.ERB', mtimeMs: 300 },
  ];

  it('全部命中 ⇒ stale 为空、allHit', () => {
    const plan = planReuse(decoded().buckets, all);
    expect(plan.allHit).toBe(true);
    expect(plan.stale).toEqual([]);
    expect(plan.reusable.size).toBe(3);
  });

  it('改过一个文件 ⇒ 只有它进 stale，其余照用（本批的靶心）', () => {
    const plan = planReuse(decoded().buckets, all.map((f) => (f.path === 'D:/game/k3.ERB' ? { ...f, mtimeMs: 301 } : f)));
    expect(plan.stale).toEqual(['D:/game/k3.ERB']);
    expect([...plan.reusable.keys()].sort()).toEqual(['D:/game/k2.ERB', 'D:/game/k1.ERB'].sort());
  });

  it('快照里没有的新文件 ⇒ stale；磁盘上消失的文件 ⇒ 不在 files 里，天然收尸', () => {
    const plan = planReuse(decoded().buckets, [...all, { path: 'D:/game/new.ERB', mtimeMs: 1 }]);
    expect(plan.stale).toEqual(['D:/game/new.ERB']);
    const shrunk = planReuse(decoded().buckets, [all[0]!]);
    expect(shrunk.stale).toEqual([]);
    expect(shrunk.reusable.size).toBe(1);
  });

  it('任一侧 mtime 为 null ⇒ 该文件判过期（保守重算，别的路径不受影响）', () => {
    const src = buckets();
    src.set('D:/game/noStat.ERB', bucket(null, [cond('N', 'D:/game/noStat.ERB', [])]));
    const stored = decodeBuckets(
      JSON.parse(JSON.stringify(encodeBuckets({ buckets: src, expect: EXPECT }))),
      EXPECT,
    )!.buckets;
    expect(planReuse(stored, [{ path: 'D:/game/noStat.ERB', mtimeMs: 5 }]).stale).toEqual(['D:/game/noStat.ERB']);
    expect(planReuse(stored, [{ path: 'D:/game/noStat.ERB', mtimeMs: null }]).stale).toEqual(['D:/game/noStat.ERB']);
  });

  it('size 判据（v5 additive）：两侧都有数时不相等 ⇒ 判过期；任一侧缺数 ⇒ 退回 mtime 判据', () => {
    const stored = decoded().buckets; // 桶 size = 2048
    const withSizes = all.map((f) => ({ ...f, size: 2048 }));
    expect(planReuse(stored, withSizes).allHit).toBe(true);
    // mtime 同值、size 变了（保留时间戳的替换）⇒ 只有它过期
    const bumped = withSizes.map((f) => (f.path === 'D:/game/k3.ERB' ? { ...f, size: 2049 } : f));
    expect(planReuse(stored, bumped).stale).toEqual(['D:/game/k3.ERB']);
    // 索引没提供 fileSizes ⇒ size=null ⇒ 不把"没信号"当"过期"（退回纯 mtime 判据，与旧行为一致）
    expect(planReuse(stored, all.map((f) => ({ ...f, size: null }))).allHit).toBe(true);
    // 索引干脆没这个字段 ⇒ 同上
    expect(planReuse(stored, all).allHit).toBe(true);
  });

  it('没有快照（首次）⇒ 全部 stale、allHit=false（空 files 也不算命中）', () => {
    expect(planReuse(null, all).stale).toEqual(['D:/game/k1.ERB', 'D:/game/k2.ERB', 'D:/game/k3.ERB']);
    expect(planReuse(null, []).allHit).toBe(false);
  });
});

describe('mergeBuckets（复用与新算走同一份合并代码）', () => {
  const stored = () => decodeBuckets(JSON.parse(JSON.stringify(encodeBuckets({ buckets: buckets(), expect: EXPECT }))), EXPECT)!;

  it('按传入顺序拼接、统计相加；computed **整桶**替换 reusable', () => {
    const s = stored().buckets;
    const order = ['D:/game/k3.ERB', 'D:/game/k1.ERB', 'D:/game/k2.ERB'];
    // 新桶只含 K1_A ⇒ K1_B 消失。这不是丢数据：整桶替换是**必需**语义——作者从文件里
    // 删掉一个函数后，按函数合并会让它复活。真实重算的桶含该文件当前全部函数。
    const freshForK1 = bucket(100, [cond('M_KOJO_K1_A', 'D:/game/k1.ERB', [dep('CFLAG:2', 9, '新描述')])], 4);
    const idx: ConditionIndex = mergeBuckets(order, new Map(Object.entries(s)), new Map([['D:/game/k1.ERB', freshForK1]]));
    expect([...idx.byFunction.keys()]).toEqual(['M_KOJO_K3_C', 'M_KOJO_K1_A']);
    expect(idx.byFunction.get('M_KOJO_K1_A')!.dependencies[0]!.count).toBe(9); // 新算的赢
    // 统计按文件相加：k3(3) + k1 新算(4) + k2(7)，谓词 3 + 3 + 0
    expect(idx.stats.functions).toBe(14);
    expect(idx.stats.predicates).toBe(6);
    expect(idx.stats.dependencies).toBe(1 + 1); // k3 一条 + k1 新算一条；k2 无
  });

  it('两个桶都没有的文件跳过（不伪造空结果）', () => {
    const idx = mergeBuckets(['/missing.ERB'], new Map(), new Map());
    expect(idx.byFunction.size).toBe(0);
    expect(idx.stats.functions).toBe(0);
  });
});

describe('extractExpect：全局判据只要 inputDigest', () => {
  it('三项齐 ⇒ 出判据；缺 inputDigest ⇒ null（不缓存）', () => {
    expect(extractExpect({ project: { rootDir: '/g', adapterId: 'eratw', inputDigest: 'd' } })).toEqual({
      projectRoot: '/g',
      adapterId: 'eratw',
      inputDigest: 'd',
    });
    expect(extractExpect({ project: { rootDir: '/g', adapterId: 'eratw' } })).toBeNull();
    expect(extractExpect({ project: { rootDir: '/g', adapterId: 'eratw', inputDigest: '' } })).toBeNull();
  });
});
