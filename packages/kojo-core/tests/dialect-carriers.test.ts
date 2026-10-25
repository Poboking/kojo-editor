/**
 * LAU-D1 · 方言载体契约验收（`ARCH-language-unification.md` §5.2 ③ / §5.3 / §5.5 的契约片）。
 *
 * 钉六件事：
 * 1. `GameAdapter.carriers?` 是 **additive**：缺省（既有适配器全部如此）⇒ `validateGameAdapter`
 *    零诊断——**绝不把"没声明"判成不合格**；给了才校验形状。
 * 2. `EventDispatchModel` additive 扩 `'metadata'` 后**参与校验**（合法值放行、非法值照报），
 *    而 `LayerMode` / `LayerTarget` / `LayerPolicy` 一个字没动（spec §10.5 三者不混）。
 * 3. 六枚新码在 core 闭集里、严重度按声明落位（两枚 warning / 四枚 error）。
 * 4. `resolveDialectBinding`：**未绑定 ⇒ 空事实 + `core/dialect/unbound`**，无默认方言可回落；
 *    覆盖与识别链冲突 ⇒ `core/dialect/mismatch`（error）**且以覆盖为准**；
 *    断言与解析结果一致 ⇒ 静默通过；断言与解析结果不符 ⇒ error 且**不改变**解析结果。
 * 5. 载体归属：`carriers` 的 glob 命中 ⇒ `binding.carrier`；声明了却没命中 ⇒
 *    `core/carrier/unowned`；**没声明 carriers ⇒ 不报归属**（没问就不判）。
 * 6. `EditorDocumentIdentity.dialect?`（plugin-api）纯 additive：core 的 `DialectBinding`
 *    结构上即可赋给 `DialectContext`（**plugin-api 不 import kojo-core，没有环**）。
 */
import { describe, expect, it } from 'vitest';

import type { CarrierBinding, DialectBinding, GameAdapter } from '../src/adapter';
import { ADAPTER_VALIDATION_CODES, freezeAdapter, validateGameAdapter } from '../src/adapter';
import type { CoreDiagnosticCode } from '../src/diagnostics';
import { CORE_WARNING_CODES, severityOf } from '../src/diagnostics';
import {
  carrierGlobMatches,
  factKindsOf,
  findCarrierBinding,
  resolveDialectBinding,
} from '../src/dialect-resolver';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter';
import type { DialectContext, EditorCompletionRequest } from '@kojo/plugin-api';

/* ============================== 夹具：在 fixture 上做浅改写 ============================== */

function fixtureWith(overrides: Partial<GameAdapter>): GameAdapter {
  return { ...FIXTURE_ADAPTER, ...overrides };
}

const codesOf = (adapter: GameAdapter): string[] => validateGameAdapter(adapter).map((d) => String(d.code));
const messagesOf = (adapter: GameAdapter): string[] => validateGameAdapter(adapter).map((d) => d.message);

/** 一枚"口上写在 XML 里"的方言：只改 carriers 与事件 dispatch，其余沿用 fixture */
function xmlDialect(extra: Partial<GameAdapter> = {}): GameAdapter {
  return fixtureWith({
    carriers: [
      { carrier: 'xml', glob: 'kojo/**/dialog_*.xml' },
      { carrier: 'erb', glob: 'kojo/*.erb', validates: ['symbol', 'storage'] },
    ],
    ...extra,
  });
}

/* ============================== 1. carriers：缺省不报错 / 给了才校验形状 ============================== */

describe('carriers · additive 缺省语义（既有适配器零改动）', () => {
  it('fixture（不声明 carriers）自检仍全绿', () => {
    expect(FIXTURE_ADAPTER.carriers).toBeUndefined();
    expect(validateGameAdapter(FIXTURE_ADAPTER)).toEqual([]);
  });

  it('显式 undefined 与"字段不存在"同义：零诊断', () => {
    expect(codesOf(fixtureWith({ carriers: undefined }))).toEqual([]);
  });

  it('空数组 = 声明了零条归属 ⇒ 同样合法（只有内联面的方言就是这么表达的）', () => {
    expect(codesOf(fixtureWith({ carriers: [] }))).toEqual([]);
  });

  it('合法声明 ⇒ 零诊断（三种载体、validates 省略或给全）', () => {
    const good: readonly CarrierBinding[] = [
      { carrier: 'erb', glob: 'a/*.erb' },
      { carrier: 'xml', glob: 'a/**/b_*.xml', validates: ['event'] },
      { carrier: 'inline', glob: 'a/**', validates: ['event', 'symbol', 'presentation', 'storage'] },
    ];
    expect(codesOf(fixtureWith({ carriers: good }))).toEqual([]);
  });

  it('坏载体名 / 空 glob / 非对象条目 / validates 越界 ⇒ unit/adapter-incomplete', () => {
    const cases: readonly { readonly binding: unknown; readonly hint: string }[] = [
      { binding: { carrier: 'txt', glob: 'a.erb' }, hint: '未知载体' },
      { binding: { carrier: 'xml', glob: '  ' }, hint: 'glob 为空' },
      { binding: null, hint: '非对象条目' },
      { binding: { carrier: 'erb', glob: 'a.erb', validates: ['narrative'] }, hint: '未知事实类' },
      { binding: { carrier: 'erb', glob: 'a.erb', validates: 'event' }, hint: 'validates 必须是数组' },
    ];
    for (const item of cases) {
      const adapter = fixtureWith({ carriers: [item.binding as unknown as CarrierBinding] });
      expect(codesOf(adapter), JSON.stringify(item.binding)).toContain(ADAPTER_VALIDATION_CODES.incomplete);
      expect(messagesOf(adapter).join('\n')).toContain(item.hint);
    }
  });

  it('同一 (carrier, glob) 重复声明 ⇒ unit/adapter-inconsistent（一条路径只能有一个归属）', () => {
    const adapter = fixtureWith({
      carriers: [
        { carrier: 'xml', glob: 'a/*.xml' },
        { carrier: 'xml', glob: 'a/*.xml' },
      ],
    });
    expect(codesOf(adapter)).toContain(ADAPTER_VALIDATION_CODES.inconsistent);
    expect(messagesOf(adapter).join('\n')).toContain('重复声明');
  });

  it('不同载体共用同一条 glob 不算重复（归属按 (载体, glob) 成对判）', () => {
    expect(
      codesOf(
        fixtureWith({
          carriers: [
            { carrier: 'xml', glob: 'a/*.xml' },
            { carrier: 'erb', glob: 'a/*.xml' },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('深冻结覆盖 carriers：数组与条目都不可写（`freezeAdapter` 走同一口径）', () => {
    const carriers: readonly CarrierBinding[] = [{ carrier: 'xml', glob: 'a/*.xml' }];
    const adapter = freezeAdapter({ ...FIXTURE_ADAPTER, carriers });
    expect(validateGameAdapter(adapter)).toEqual([]);
    expect(Object.isFrozen(adapter.carriers)).toBe(true);
    expect(Object.isFrozen(adapter.carriers?.[0])).toBe(true);
  });
});

/* ============================== 2. EventDispatchModel 扩 'metadata'（不碰 Layer 三型） ============================== */

describe('dispatch · metadata 参与校验', () => {
  it('事件声明 metadata ⇒ 契约自洽（不再报"dispatch 模型非法"）', () => {
    const adapter = fixtureWith({
      eventCatalog: {
        defaultEvent: null,
        events: [
          ...FIXTURE_ADAPTER.eventCatalog.events,
          {
            event: '元数据面',
            engine: 'META_TABLE',
            args: [],
            dispatch: 'metadata',
            priority: 'none',
            guard: null,
            forced: false,
            weavable: false,
          },
        ],
      },
    });
    expect(codesOf(adapter)).toEqual([]);
  });

  it('反例：非法 dispatch 仍被拦住（新增值不等于放开值域）', () => {
    const adapter = fixtureWith({
      eventCatalog: {
        defaultEvent: null,
        events: [
          {
            event: '甲',
            engine: 'A',
            args: [],
            dispatch: 'engine' as never,
            priority: 'none',
            guard: null,
            forced: false,
            weavable: false,
          },
        ],
      },
    });
    expect(codesOf(adapter)).toContain(ADAPTER_VALIDATION_CODES.inconsistent);
    expect(messagesOf(adapter).join('\n')).toContain('dispatch 模型非法');
  });

  it('分层三型不退化：LayerMode / LayerTarget 的合法值仍合法、非法值仍非法', () => {
    expect(
      codesOf(
        fixtureWith({
          layerPolicy: {
            defaultMode: 'overlay',
            rules: [
              { target: 'function', mode: 'unique' },
              { target: 'event-hook', mode: 'shared-hook' },
              { target: 'kojo-overlay', mode: 'overlay' },
            ],
          },
        }),
      ),
    ).toEqual([]);
    expect(
      codesOf(
        fixtureWith({
          layerPolicy: { defaultMode: 'metadata' as never, rules: [{ target: 'function', mode: 'unique' }] },
        }),
      ),
    ).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });
});

/* ============================== 3. 六枚新码：闭集 + 严重度 ============================== */

describe('诊断码 · LAU-D1 六枚', () => {
  const SIX: readonly CoreDiagnosticCode[] = [
    'core/dialect/unbound',
    'core/dialect/mismatch',
    'core/dialect/response-mismatch',
    'core/event/unknown',
    'core/event/wrong-carrier',
    'core/carrier/unowned',
  ];

  it('类型位置即编译期断言：六枚都在 CoreDiagnosticCode 联合里', () => {
    expect(SIX).toHaveLength(6);
    expect(new Set(SIX).size).toBe(6);
  });

  it('严重度：两枚降级 warning、四枚 error', () => {
    for (const code of SIX) {
      const warning = code === 'core/dialect/unbound' || code === 'core/carrier/unowned';
      expect(CORE_WARNING_CODES.has(code), `${code} 的 warning 归属`).toBe(warning);
      expect(severityOf(code), `${code} 的严重度`).toBe(warning ? 'warning' : 'error');
    }
  });
});

/* ============================== 4. resolveDialectBinding：解析链是唯一真源 ============================== */

/** 三枚"方言"：都从 fixture 派生，只改 id 与版本，避免引入任何真实游戏事实 */
const DIALECT_A = fixtureWith({ carriers: [{ carrier: 'erb', glob: 'kojo/*.erb' }] });
const DIALECT_B = xmlDialect();
/** 一枚**不声明 carriers** 的方言（今天所有既有适配器的形状）：归属问题一概不问 */
const DIALECT_PLAIN = FIXTURE_ADAPTER;
const REGISTRY: Readonly<Record<string, GameAdapter>> = Object.freeze({
  a: DIALECT_A,
  b: DIALECT_B,
  plain: DIALECT_PLAIN,
});
const factsFor = (dialect: string): GameAdapter | null => REGISTRY[dialect] ?? null;

const codes = (list: readonly { code: string }[]): string[] => list.map((item) => item.code);

describe('resolveDialectBinding · 未绑定 / 覆盖 / 断言', () => {
  it('识别链与工作区覆盖都没有 ⇒ unbound：binding=null + 空事实 + 一条 core/dialect/unbound（warning）', () => {
    const result = resolveDialectBinding({ detectedDialect: null, factsFor });
    expect(result.kind).toBe('unbound');
    expect(result.binding).toBeNull();
    expect(codes(result.diagnostics)).toEqual(['core/dialect/unbound']);
    expect(result.diagnostics[0]!.severity).toBe('warning');
    // 没有"半个事实"：不存在可被当成默认方言的返回物
    expect(Object.keys(result)).toEqual(['kind', 'binding', 'resolvedDialect', 'diagnostics']);
  });

  it('恰一命中 ⇒ bound：dialect 取识别链结论、factsVersion 取 GameAdapter.version', () => {
    const result = resolveDialectBinding({ detectedDialect: 'a', factsFor });
    expect(result.kind).toBe('bound');
    expect(result.diagnostics).toEqual([]);
    if (result.kind !== 'bound') throw new Error('unreachable');
    expect(result.binding.dialect).toBe('a');
    expect(result.binding.facts).toBe(DIALECT_A);
    expect(result.binding.factsVersion).toBe(DIALECT_A.version);
    expect(result.binding.carrier).toBeNull(); // 没给 filePath ⇒ 不做归属、也不报
  });

  it('覆盖 ≠ 识别链 ⇒ mismatch（error）且**以覆盖为准**', () => {
    const result = resolveDialectBinding({ detectedDialect: 'a', workspaceOverride: 'b', factsFor });
    expect(result.kind).toBe('mismatch');
    if (result.kind !== 'mismatch') throw new Error('unreachable');
    expect(result.resolvedDialect).toBe('b');
    expect(result.binding?.dialect).toBe('b');
    expect(result.binding?.facts).toBe(DIALECT_B);
    expect(codes(result.diagnostics)).toEqual(['core/dialect/mismatch']);
    expect(result.diagnostics[0]!.severity).toBe('error');
    expect(result.diagnostics[0]!.message).toContain('按覆盖');
  });

  it('断言与解析结果一致 ⇒ 静默通过（零诊断）', () => {
    const result = resolveDialectBinding({ detectedDialect: 'a', fileAssertion: 'a', factsFor });
    expect(result.kind).toBe('bound');
    expect(result.diagnostics).toEqual([]);
  });

  it('断言 ≠ 解析结果 ⇒ mismatch（error），且解析结果**不因断言而改变**', () => {
    const result = resolveDialectBinding({ detectedDialect: 'a', fileAssertion: 'b', factsFor });
    expect(result.kind).toBe('mismatch');
    if (result.kind !== 'mismatch') throw new Error('unreachable');
    expect(result.resolvedDialect).toBe('a');
    expect(result.binding?.dialect).toBe('a');
    expect(codes(result.diagnostics)).toEqual(['core/dialect/mismatch']);
    expect(result.diagnostics[0]!.message).toContain('断言只自证');
  });

  it('只有断言、没有解析结果 ⇒ 断言不产生绑定：mismatch + unbound 两条诊断', () => {
    const result = resolveDialectBinding({ detectedDialect: null, fileAssertion: 'b', factsFor });
    expect(result.kind).toBe('unbound');
    expect(result.binding).toBeNull();
    expect(codes(result.diagnostics)).toEqual(['core/dialect/mismatch', 'core/dialect/unbound']);
  });

  it('方言认下了但没有 2.0 事实面 ⇒ unbound（不借别方言的表，v1 面不受影响）', () => {
    const result = resolveDialectBinding({ detectedDialect: 'c', factsFor });
    expect(result.kind).toBe('unbound');
    expect(result.binding).toBeNull();
    expect(codes(result.diagnostics)).toEqual(['core/dialect/unbound']);
    expect(result.diagnostics[0]!.message).toContain('没有 2.0 事实面');
  });

  it('空白串 / null 的覆盖与断言一律当"没有这一格"，不认成方言名', () => {
    expect(codes(resolveDialectBinding({ detectedDialect: 'a', workspaceOverride: '   ', factsFor }).diagnostics)).toEqual([]);
    expect(codes(resolveDialectBinding({ detectedDialect: 'a', fileAssertion: null, factsFor }).diagnostics)).toEqual([]);
    expect(codes(resolveDialectBinding({ detectedDialect: '  ' as string, factsFor }).diagnostics)).toEqual([
      'core/dialect/unbound',
    ]);
  });

  it('结果深冻结：供方拿到也不许改', () => {
    const result = resolveDialectBinding({ detectedDialect: 'a', factsFor });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'bound') expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });
});

/* ============================== 5. 载体归属（"口上写在 XML 里"的方言面形状，数据驱动） ============================== */

describe('载体归属 · carriers 的 glob 决定"这份文件算哪个载体"', () => {
  it('命中 `**/dialog_*.xml` ⇒ carrier=xml；`*` 不跨段、`**` 跨段', () => {
    const result = resolveDialectBinding({ detectedDialect: 'b', filePath: 'kojo/sub/dialog_1.xml', factsFor });
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') throw new Error('unreachable');
    expect(result.binding.carrier).toBe('xml');
    expect(result.binding.validates).toBeUndefined(); // 省略 = 全部事实类
    expect(codes(result.diagnostics)).toEqual([]);
  });

  it('反斜杠路径与 `./` 前缀归一后同样命中；`*` 不吃分隔符', () => {
    expect(carrierGlobMatches('kojo/*.erb', 'kojo\\a.erb')).toBe(true);
    expect(carrierGlobMatches('./kojo/*.erb', './kojo/a.erb')).toBe(true);
    expect(carrierGlobMatches('kojo/*.erb', 'kojo/sub/a.erb')).toBe(false);
    expect(carrierGlobMatches('kojo/**', 'kojo/sub/a.erb')).toBe(true);
    expect(carrierGlobMatches('kojo/**', 'other/a.erb')).toBe(false);
    expect(carrierGlobMatches('kojo/dialog-1.erb', 'kojo/dialog-1.erb')).toBe(true); // 元字符已转义
    expect(carrierGlobMatches('kojo/a?.erb', 'kojo/aX.erb')).toBe(true);
    expect(carrierGlobMatches('kojo/a.erb', 'kojo/aXerb')).toBe(false);
    expect(carrierGlobMatches('kojo/?.erb', 'kojo/ab.erb')).toBe(false);
  });

  it('声明了 carriers 但 glob 都没命中 ⇒ binding 仍成立 + 一条 core/carrier/unowned（warning）', () => {
    const result = resolveDialectBinding({ detectedDialect: 'b', filePath: 'data/notes.txt', factsFor });
    expect(result.kind).toBe('bound');
    if (result.kind !== 'bound') throw new Error('unreachable');
    expect(result.binding.carrier).toBeNull();
    expect(codes(result.diagnostics)).toEqual(['core/carrier/unowned']);
    expect(result.diagnostics[0]!.severity).toBe('warning');
  });

  it('方言没声明 carriers ⇒ 归属问题一概不报（缺省 = 未声明，不猜）', () => {
    const result = resolveDialectBinding({ detectedDialect: 'plain', filePath: 'anything/else.txt', factsFor });
    expect(result.kind).toBe('bound');
    expect(result.diagnostics).toEqual([]);
  });

  it('validates 省略 = 四格全校验；显式给出时按给出的算', () => {
    const all = factKindsOf({ carrier: 'xml', glob: 'a/**' });
    expect(all.slice().sort()).toEqual(['event', 'presentation', 'storage', 'symbol']);
    expect(factKindsOf({ carrier: 'erb', glob: 'a.erb', validates: ['event'] })).toEqual(['event']);
    expect(factKindsOf({ carrier: 'erb', glob: 'a.erb', validates: [] })).toEqual([]);
  });

  it('声明顺序 = 优先顺序，第一条命中即返回', () => {
    const carriers: readonly CarrierBinding[] = [
      { carrier: 'inline', glob: 'kojo/**' },
      { carrier: 'erb', glob: 'kojo/a.erb' },
    ];
    const adapter = fixtureWith({ carriers });
    expect(findCarrierBinding(adapter, 'kojo/a.erb')?.carrier).toBe('inline');
    expect(findCarrierBinding(adapter, 'kojo/b.erb')?.carrier).toBe('inline');
    expect(findCarrierBinding(xmlDialect(), 'kojo/a.erb')?.validates).toEqual(['symbol', 'storage']);
    expect(findCarrierBinding(xmlDialect(), 'kojo/a.erb')?.validates).not.toContain('event');
    expect(findCarrierBinding(FIXTURE_ADAPTER, 'kojo/a.erb')).toBeUndefined(); // 未声明 ⇒ 不判
  });

  it('同一条冲突路径上，mismatch 与 unowned 各报一次（诊断可叠加、互不吞并）', () => {
    const result = resolveDialectBinding({
      detectedDialect: 'a',
      workspaceOverride: 'b',
      filePath: 'no/where.erb',
      factsFor,
    });
    expect(result.kind).toBe('mismatch');
    expect(codes(result.diagnostics)).toEqual(['core/dialect/mismatch', 'core/carrier/unowned']);
  });
});

/* ============================== 6. EditorDocumentIdentity.dialect?：additive 且不造环 ============================== */

describe('plugin-api · dialect 格是便利不是真源', () => {
  /** 结构兼容即成立：core 的 `DialectBinding`（多带 facts）可直接递给契约侧的 `DialectContext` */
  function asContext(binding: DialectBinding): DialectContext {
    return binding;
  }

  it('core 的 binding 结构上满足 DialectContext（字段名与值域逐字对齐）', () => {
    const result = resolveDialectBinding({ detectedDialect: 'b', filePath: 'kojo/dialog_1.xml', factsFor });
    if (result.kind !== 'bound') throw new Error('fixture 应绑定成功');
    const ctx = asContext(result.binding);
    expect(ctx.dialect).toBe('b');
    expect(ctx.carrier).toBe('xml');
    expect(typeof ctx.factsVersion).toBe('string');
    // 只有三格被契约侧看见：事实本体不下传到 plugin-api
    expect(Object.keys(ctx).sort()).toEqual(['carrier', 'dialect', 'facts', 'factsVersion']);
  });

  it('既有请求不写 dialect 仍然合法（13 处旧请求零改动）', () => {
    const legacy: EditorCompletionRequest = {
      kind: 'completion',
      path: 'a/kojo.erb',
      text: '',
      line: 1,
      column: 1,
      project: null,
    };
    expect(legacy.dialect).toBeUndefined();
  });

  it('新请求带上 dialect 也只多这一格', () => {
    const withDialect: EditorCompletionRequest = {
      kind: 'completion',
      path: 'a/kojo.erb',
      text: '',
      line: 1,
      column: 1,
      project: null,
      dialect: { dialect: 'b', factsVersion: FIXTURE_ADAPTER.version, carrier: 'erb' },
    };
    expect(withDialect.dialect?.dialect).toBe('b');
    expect(withDialect.dialect?.factsVersion).toBe(FIXTURE_ADAPTER.version);
  });
});
