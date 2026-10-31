/**
 * LAU-B11 · kojo2 **引用事实查询面单源台账**（项目索引 additive 车）。
 *
 * 钉死三件事（断言一律不许放宽）：
 *
 * 1. **一处提供**：「按名字取声明数 + 取引用位点」这类查询的规则实现只有一条
 *    （`@kojo/kojo-lang/references` 的 `createKojo2ReferenceFactsQueryIndex`）。宿主常驻
 *    缓存索引（`createKojo2ProjectIndex`）与插件侧快照临时索引
 *    （`createKojo2ReferenceSnapshotIndex`）都是它的入口——同一份文件事实，三条入口的
 *    `refsOf` / `declsOf` / `symbolAt` 必须逐字段相同；哪天有人抄回第二份口径，这里的
 *    对拍立刻红。
 * 2. **上限只有一个值**：宿主导出的 `KOJO2_PROJECT_REF_LIMIT` 即包那枚（转发，不再
 *    第二次定义 2000）。
 * 3. **「名录未建 ⇒ 不答」与「真没有 ⇒ 答空」不许混**（铁律 4，与 ERB 侧
 *    `erb-workspace-symbols` / `erb-usage-lens` 的 `undefined` 判据同形）：
 *    - 索引缺席 ⇒ `projectFilesSnapshotOf` 回 `undefined`（请求里不出现 `projectFiles`）；
 *    - 名录在场但空 ⇒ 回 `{ files: [], complete: true }`（作答"这一项目没有别的文件"）；
 *    - 查询面对交到手的名录**总是作答**（空 `refs` / 空 `decls` / `null`），"不答"永远
 *      归取数腿的 `undefined`，不在查询面里冒充。
 *
 * 期望值全部从夹具原文位置推，不在测试里复写行号。
 */
import { describe, expect, it } from 'vitest';
import {
  createKojo2ReferenceFactsQueryIndex,
  createKojo2ReferenceSnapshotIndex,
  KOJO2_PROJECT_REF_LIMIT as PACKAGE_REF_LIMIT,
  type Kojo2ReferenceFactsEntry,
} from '@kojo/kojo-lang/references';
import {
  createKojo2ProjectIndex,
  KOJO2_PROJECT_REF_LIMIT as HOST_REF_LIMIT,
  type Kojo2ProjectIndex,
} from '../src/monaco/kojo2-project-index';
import { projectFilesSnapshotOf } from '../src/monaco/kojo-language-service-legs';

const PATH_A = 'D:/proj/a.kojo2';
const PATH_B = 'D:/proj/b.kojo2';
const PATH_C = 'D:/proj/c.kojo2';

/* ============================== 夹具（与索引行为闸同一族的形态） ============================== */

/** A 文件：声明面（设 / 对照表 / 函 / 机）+ 本文件引用。 */
const MAIN = [
  '# 幕 神社 清晨',
  '# 设 亲近线 整数 = 500',
  '# 对照表 心情 依据 亲近线',
  '    0..99 -> 疏远',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 目标 + 亲近线',
  '# 机 指令 310',
  '> 晨光透过鸟居，{亲近线} 高。',
].join('\n');

/** B 文件：没有声明，只有可证引用位（候选位；跨文件归属的主形态）。 */
const LIB = [
  '# 幕 书院 午后',
  '> 书院里，{心情} 摆在案上。',
  '旅人：「{亲近线} 很高。」',
  '! 增加羁绊(目标, 2)',
].join('\n');

/** C 文件：`心情` 在这里是变量（与 A 的表同名不同家族——家族隔离的关键形态）。 */
const VARIABLE_HEART = [
  '# 幕 街角',
  '# 设 心情 整数 = 0 场景',
  '@算',
  '    心情 = 3',
].join('\n');

const FILES = [
  { path: PATH_A, text: MAIN },
  { path: PATH_B, text: LIB },
  { path: PATH_C, text: VARIABLE_HEART },
];

/* ============================== 三条入口，同一份事实 ============================== */

/** ① 宿主常驻缓存索引（喂进来的那份）。 */
function hostIndex(): Kojo2ProjectIndex {
  const index = createKojo2ProjectIndex();
  for (const file of FILES) index.updateFile(file);
  return index;
}

/** ② 包侧事实查询面（LAU-B11 的单源本体）：用宿主已缓存的逐文件事实直接建。 */
function factsEntries(index: Kojo2ProjectIndex): readonly Kojo2ReferenceFactsEntry[] {
  return FILES.map((file) => {
    const entry = index.getFile(file.path);
    if (entry === undefined) throw new Error(`夹具文件没进索引：${file.path}`);
    return { path: entry.path, symbols: entry.symbols, candidates: entry.candidates };
  });
}

/** ③ 插件侧快照临时索引（供方今天读的那一枚）。 */
const snapshotIndex = () => createKojo2ReferenceSnapshotIndex(FILES);

/* ============================== ① 三入口对拍：一处提供 ============================== */

describe('LAU-B11 · 查询面单源：宿主缓存索引 / 事实查询面 / 快照临时索引逐字段同答', () => {
  const host = hostIndex();
  const facts = createKojo2ReferenceFactsQueryIndex(factsEntries(host));
  const snapshot = snapshotIndex();

  const REF_QUERIES = [
    { label: '表引用（跨文件候选位 + 声明家族）', query: { name: '心情', kind: 'table' as const } },
    { label: '变量家族隔离（表名不当变量引用）', query: { name: '心情', kind: 'variable' as const } },
    { label: '函数调用位', query: { name: '增加羁绊', kind: 'function' as const } },
    { label: '常量插值位', query: { name: '亲近线', kind: 'constant' as const } },
    { label: '事件（只有挂点，不靠表达式）', query: { name: '指令', kind: 'event' as const } },
    { label: '幕标题', query: { name: '神社 清晨', kind: 'scene' as const } },
    {
      label: '排除本文件（大小写 / 反斜杠写法同键）',
      query: { name: '心情', kind: 'table' as const, excludePath: 'd:\\proj\\A.KOJO2' },
    },
    {
      label: '只查一份文件',
      query: { name: '心情', kind: 'variable' as const, onlyPath: 'D:\\proj\\c.kojo2' },
    },
    {
      label: 'onlyPath 与 excludePath 同时给出（only 优先）',
      query: {
        name: '心情',
        kind: 'table' as const,
        onlyPath: PATH_A,
        excludePath: PATH_A,
      },
    },
    { label: '查无此名（答：没有）', query: { name: '不存在', kind: 'table' as const } },
    { label: '非法种类（答：没有，不猜家族）', query: { name: '心情', kind: 'nope' as never } },
    { label: '空名字（作答为空，不抛）', query: { name: '', kind: 'table' as const } },
  ];

  for (const { label, query } of REF_QUERIES) {
    it(`refsOf 同答：${label}`, () => {
      const viaHost = host.refsOf(query);
      expect(facts.refsOf(query)).toEqual(viaHost);
      expect(snapshot.refsOf(query)).toEqual(viaHost);
    });
  }

  for (const name of ['心情', '亲近线', '增加羁绊', '指令', '不存在', '']) {
    it(`declsOf 同答（按名字取声明数）：${name || '空名'}`, () => {
      const viaHost = host.declsOf(name);
      expect(facts.declsOf(name)).toEqual(viaHost);
      expect(snapshot.declsOf(name)).toEqual(viaHost);
    });
  }

  /** 位置换算：取 `needle` 在原文里的 1 基行列（夹具备注：只含 LF）。 */
  function positionIn(source: string, needle: string): { line: number; column: number } {
    const at = source.indexOf(needle);
    if (at < 0) throw new Error(`夹具里找不到 ${needle}`);
    const before = source.slice(0, at);
    return { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') };
  }

  const SYMBOL_QUERIES = [
    {
      label: '跨文件引用位（表与变量同名多家族 ⇒ 不猜，null）',
      at: { path: PATH_B, ...positionIn(LIB, '心情') },
    },
    {
      label: '跨文件引用位（唯一家族：整数常量）',
      at: { path: PATH_B, ...positionIn(LIB, '亲近线') },
    },
    {
      label: '跨文件调用位（唯一家族：@函）',
      at: { path: PATH_B, ...positionIn(LIB, '增加羁绊') },
    },
    { label: '非引用位（幕标题行）⇒ null', at: { path: PATH_B, line: 1, column: 1 } },
    { label: '未索引路径 ⇒ null', at: { path: 'D:/proj/ghost.kojo2', line: 2, column: 8 } },
  ];

  for (const { label, at } of SYMBOL_QUERIES) {
    it(`symbolAt 同答：${label}`, () => {
      const viaHost = host.symbolAt(at);
      expect(facts.symbolAt(at)).toEqual(viaHost);
      expect(snapshot.symbolAt(at)).toEqual(viaHost);
    });
  }

  it('声明计数口径唯一：同名跨家族的 declsOf 条数三入口一致', () => {
    expect(host.declsOf('心情')).toHaveLength(2);
    expect(facts.declsOf('心情')).toHaveLength(2);
    expect(snapshot.declsOf('心情')).toHaveLength(2);
  });
});

/* ============================== ② 上限一枚值 ============================== */

describe('LAU-B11 · 上限常量转发（不再有两份 2000）', () => {
  it('宿主导出即包那枚', () => {
    expect(HOST_REF_LIMIT).toBe(PACKAGE_REF_LIMIT);
    expect(HOST_REF_LIMIT).toBe(2000);
  });
});

/* ============================== ③ 未建 vs 真没有 ============================== */

describe('LAU-B11 · 「名录未 ⇒ 不答」与「真没有 ⇒ 答空」两态不混', () => {
  it('索引缺席 ⇒ 快照 undefined（请求里不出现 projectFiles = 不答）', () => {
    expect(projectFilesSnapshotOf(null, PATH_A)).toBeUndefined();
    expect(projectFilesSnapshotOf(undefined, PATH_A)).toBeUndefined();
  });

  it('名录在场但空 ⇒ 答「这一项目没有别的文件」（不是不答）', () => {
    const empty = createKojo2ProjectIndex();
    expect(projectFilesSnapshotOf(empty, PATH_A)).toEqual({ files: [], complete: true });
  });

  it('空名录的查询面对交到手的名录作答（空列表），不冒充「不答」', () => {
    const facts = createKojo2ReferenceFactsQueryIndex([]);
    expect(facts.refsOf({ name: '心情', kind: 'table' })).toEqual({ refs: [], truncated: false });
    expect(facts.declsOf('心情')).toEqual([]);
    expect(facts.symbolAt({ path: PATH_A, line: 1, column: 1 })).toBeNull();
  });

  it('查无此名与名录为空同形（答：没有）；「不答」只归取数腿的 undefined', () => {
    const host = hostIndex();
    expect(host.refsOf({ name: '不存在', kind: 'table' })).toEqual({ refs: [], truncated: false });
  });
});
