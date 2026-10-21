/**
 * `@织` 项目级层分析（`project/weave-layers.ts`）单测——按任务契约逐条钉：
 *
 * 1) 分桶：`之前` / 普通 / `之后` / `接管`，以及逐块判定表（units）；
 * 2) 同事件同层多 `接管` ⇒ error；layerPolicy 数据驱动（unique / shared-hook / overlay 跨层）；
 * 3) `priorityModel` 非 `emuera-buckets` 时写修饰词、未知事件、不可监听 ⇒ 冲突；
 * 4) 被压监听（含 A 压 B、B 压 C 的链）与"被谁压"；
 * 5) 纯数据确定性：两次调用逐字节相等、打乱文件/声明顺序结果不变、不修改输入。
 */
import { describe, expect, it } from 'vitest';

import type { KojoDecl, KojoFile, KojoSpan, KojoWeaveDecl, KojoWeaveModifier } from '../src/ast';
import type { LayerPolicyMode } from '../src/project/analysis';
import {
  analyzeWeaveLayers,
  weaveBucketOf,
  type WeaveLayerAdapterFacts,
  type WeaveLayerDocument,
  type WeaveLayerEventFact,
  type WeaveLayerLayerPolicyFacts,
} from '../src/project/weave-layers';

/* ============================== 输入构造器 ============================== */

const sp = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

const weave = (event: string, modifiers: readonly KojoWeaveModifier[] = [], line = 1): KojoWeaveDecl => ({
  kind: 'weave',
  event,
  args: [],
  modifiers,
  body: [],
  span: sp(line),
});

const fileOf = (decls: readonly KojoDecl[]): KojoFile => ({ decls, scenes: [], diagnostics: [] });

const doc = (filePath: string, decls: readonly KojoWeaveDecl[], layerId?: string): WeaveLayerDocument => ({
  filePath,
  file: fileOf(decls),
  ...(layerId === undefined ? {} : { layerId }),
});

const EVENTS: readonly WeaveLayerEventFact[] = [
  { event: '回合末', priority: 'emuera-buckets' },
  { event: '清晨', priority: 'emuera-buckets' },
];

const policyOf = (base: LayerPolicyMode, overlay: LayerPolicyMode = base): WeaveLayerLayerPolicyFacts => ({
  defaultMode: 'unique',
  rules: [
    { target: 'event-hook', mode: base },
    { target: 'kojo-overlay', mode: overlay },
  ],
});

const adapter = (
  input: {
    events?: readonly WeaveLayerEventFact[];
    layerPolicy?: WeaveLayerLayerPolicyFacts;
  } = {},
): WeaveLayerAdapterFacts => ({
  eventCatalog: { events: input.events ?? EVENTS },
  layerPolicy: input.layerPolicy ?? policyOf('unique'),
});

const filesOf = (items: readonly { readonly filePath: string }[]): string[] => items.map((item) => item.filePath);

/** 逐块读数的定位串（事件:文件:行） */
const unitKey = (unit: { readonly listener: { readonly event: string; readonly filePath: string; readonly span: KojoSpan | null } }): string =>
  `${unit.listener.event}:${unit.listener.filePath}:${unit.listener.span?.start.line}`;

/* ============================== 1. 空输入与分桶正例 ============================== */

describe('空输入 · 分桶 · 正例', () => {
  it('空 documents ⇒ conflicts / shadowed / units 全空', () => {
    expect(analyzeWeaveLayers([], adapter())).toEqual({ conflicts: [], shadowed: [], units: [] });
  });

  it('同一事件多枚普通监听合法（§8.6：多个 @织 全部执行；桶内按装载顺序）', () => {
    const result = analyzeWeaveLayers(
      [doc('b.kojo', [weave('回合末', [], 7)]), doc('a.kojo', [weave('回合末', [], 3)])],
      adapter(),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.shadowed).toEqual([]);
    expect(result.units.map(unitKey)).toEqual(['回合末:a.kojo:3', '回合末:b.kojo:7']);
    expect(result.units.every((unit) => unit.bucket === 'plain')).toBe(true);
    expect(result.units.every((unit) => unit.verdict === 'effective')).toBe(true);
    expect(result.units.every((unit) => unit.priorityModel === 'emuera-buckets')).toBe(true);
    expect(result.units.every((unit) => unit.layerMode === 'unique')).toBe(true);
  });

  it('之前 / 之后 / 接管 三桶齐备；单接管把其余三桶全部压掉', () => {
    const result = analyzeWeaveLayers(
      [
        doc('a.kojo', [
          weave('回合末', ['later'], 5),
          weave('回合末', ['only'], 2),
          weave('回合末', [], 3),
          weave('回合末', ['pri'], 4),
        ]),
      ],
      adapter(),
    );
    expect(result.conflicts).toEqual([]);
    // 逐块读数按（事件 → 文件 → 行号）排序，桶/结论一一对应
    expect(result.units.map((unit) => `${unit.bucket}:${unit.verdict}`)).toEqual([
      'only:takeover',
      'plain:shadowed',
      'pri:shadowed',
      'later:shadowed',
    ]);
    // 被压事实按被压监听自身的落点排序（普通 3 → 之前 4 → 之后 5）
    expect(result.shadowed.map((entry) => entry.bucket)).toEqual(['plain', 'pri', 'later']);
    for (const entry of result.shadowed) {
      expect(entry.code).toBe('core/weave/shadowed-listener');
      expect(entry.severity).toBe('warning');
      expect(filesOf(entry.suppressors)).toEqual(['a.kojo']);
    }
  });

  it('weaveBucketOf：修饰词映射到桶；并用/重复返回 null（语义未定义）', () => {
    expect(weaveBucketOf([])).toBe('plain');
    expect(weaveBucketOf(['pri'])).toBe('pri');
    expect(weaveBucketOf(['later'])).toBe('later');
    expect(weaveBucketOf(['only'])).toBe('only');
    expect(weaveBucketOf(['only', 'later'])).toBeNull();
    expect(weaveBucketOf(['only', 'only'])).toBeNull();
  });

  it('units 逐块一行：同一文件多个监听块各成一条；基座层与覆盖层各读各的 layerMode', () => {
    const result = analyzeWeaveLayers(
      [
        doc('base.kojo', [weave('回合末', [], 1)]),
        doc('zh.kojo', [weave('回合末', [], 2)], 'zh'),
        doc('zh.kojo', [weave('回合末', ['later'], 3)], 'zh'),
      ],
      adapter({ layerPolicy: policyOf('unique', 'overlay') }),
    );
    expect(result.units).toHaveLength(3);
    expect(result.units.map((unit) => unit.listener.layerId ?? null)).toEqual([null, 'zh', 'zh']);
    expect(result.units.map((unit) => unit.layerMode)).toEqual(['unique', 'overlay', 'overlay']);
    expect(result.units.map((unit) => unit.bucket)).toEqual(['plain', 'plain', 'later']);
    expect(result.units.every((unit) => unit.verdict === 'effective')).toBe(true);
  });

  it('units 按事件名（码元序）稳定排序', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('清晨', [], 2), weave('回合末', [], 1)])],
      adapter(),
    );
    expect(result.units.map((unit) => unit.listener.event)).toEqual(['回合末', '清晨']);
  });
});

/* ============================== 2. 同事件多接管 · layerPolicy 数据驱动 ============================== */

describe('同事件多接管 · layerPolicy', () => {
  it('缺省 unique：同事件双接管 ⇒ multiple-only error（spans 含两处、files 两者）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 1)]), doc('b.kojo', [weave('回合末', ['only'], 2)])],
      adapter(),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('multiple-takeover');
    expect(conflict.code).toBe('core/weave/multiple-only');
    expect(conflict.severity).toBe('error');
    expect(conflict.bucket).toBe('only');
    expect(conflict.layerId).toBeNull();
    expect(conflict.spans).toHaveLength(2);
    expect(filesOf(conflict.spans)).toEqual(['a.kojo', 'b.kojo']);
    expect(conflict.files).toEqual(['a.kojo', 'b.kojo']);
    expect(conflict.message).toContain('a.kojo:1:1');
    expect(conflict.message).toContain('b.kojo:2:1');
    // 逐块读数：两个接管都被阻断（blocked 优先于 shadowed）
    expect(result.units.every((unit) => unit.verdict === 'blocked')).toBe(true);
    expect(result.units.every((unit) => unit.codes.includes('core/weave/multiple-only'))).toBe(true);
  });

  it('冲突 spans 按（文件路径 → 行号）稳定排序，同文件也不乱', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 9), weave('回合末', ['only'], 3)])],
      adapter(),
    );
    const conflict = result.conflicts[0]!;
    expect(conflict.spans.map((span) => span.span?.start.line)).toEqual([3, 9]);
    expect(conflict.files).toEqual(['a.kojo']);
  });

  it('layerPolicy=overlay：不同覆盖层各一个接管合法（跨层豁免），两块都判 takeover', () => {
    const result = analyzeWeaveLayers(
      [doc('base.kojo', [weave('回合末', ['only'], 1)]), doc('zh.kojo', [weave('回合末', ['only'], 1)], 'zh')],
      adapter({ layerPolicy: policyOf('unique', 'overlay') }),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.units.map((unit) => unit.verdict)).toEqual(['takeover', 'takeover']);
    expect(result.units.map((unit) => unit.layerMode)).toEqual(['unique', 'overlay']);
  });

  it('layerPolicy=overlay：同一覆盖层两个接管仍是 error（layerId 落点）', () => {
    const result = analyzeWeaveLayers(
      [
        doc('zh1.kojo', [weave('回合末', ['only'], 1)], 'zh'),
        doc('zh2.kojo', [weave('回合末', ['only'], 2)], 'zh'),
      ],
      adapter({ layerPolicy: policyOf('unique', 'overlay') }),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('multiple-takeover');
    expect(conflict.layerId).toBe('zh');
    expect(conflict.message).toContain('覆盖层「zh」');
  });

  it('layerPolicy=unique：不同覆盖层的两个接管照样 error（非 overlay 政策不豁免）', () => {
    const result = analyzeWeaveLayers(
      [
        doc('zh.kojo', [weave('回合末', ['only'], 1)], 'zh'),
        doc('en.kojo', [weave('回合末', ['only'], 2)], 'en'),
      ],
      adapter({ layerPolicy: policyOf('unique') }),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('multiple-takeover');
    expect(conflict.layerId).toBeNull();
    expect(conflict.message).toContain('layerPolicy');
  });

  it('overlay 政策下跨覆盖层互不压盖：各层普通监听只被本层接管压', () => {
    const result = analyzeWeaveLayers(
      [
        doc('base-take.kojo', [weave('回合末', ['only'], 1)]),
        doc('base-listen.kojo', [weave('回合末', [], 2)]),
        doc('zh-take.kojo', [weave('回合末', ['only'], 1)], 'zh'),
        doc('zh-listen.kojo', [weave('回合末', [], 2)], 'zh'),
      ],
      adapter({ layerPolicy: policyOf('unique', 'overlay') }),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.shadowed).toHaveLength(2);
    for (const entry of result.shadowed) {
      const listenerLayer = entry.listener.layerId ?? '';
      expect(entry.suppressors.every((fact) => (fact.layerId ?? '') === listenerLayer)).toBe(true);
    }
    expect(
      filesOf(result.shadowed.find((entry) => entry.listener.filePath === 'base-listen.kojo')!.suppressors),
    ).toEqual(['base-take.kojo']);
    expect(
      filesOf(result.shadowed.find((entry) => entry.listener.filePath === 'zh-listen.kojo')!.suppressors),
    ).toEqual(['zh-take.kojo']);
  });

  it('shared-hook 不放行多个接管（接管是独占语义）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 1)]), doc('b.kojo', [weave('回合末', ['only'], 2)])],
      adapter({ layerPolicy: policyOf('shared-hook', 'shared-hook') }),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe('multiple-takeover');
  });

  it('同一份事实换 layerPolicy ⇒ 判定不同（读数据、不写死）', () => {
    const documents = [
      doc('base.kojo', [weave('回合末', ['only'], 1)]),
      doc('zh.kojo', [weave('回合末', ['only'], 1)], 'zh'),
    ];
    expect(analyzeWeaveLayers(documents, adapter({ layerPolicy: policyOf('unique') })).conflicts).toHaveLength(1);
    expect(
      analyzeWeaveLayers(documents, adapter({ layerPolicy: policyOf('unique', 'overlay') })).conflicts,
    ).toHaveLength(0);
  });
});

/* ============================== 3. 被压监听 ============================== */

describe('被压监听', () => {
  it('单接管压普通监听：warning + 被谁压 + 两处落点', () => {
    const result = analyzeWeaveLayers(
      [doc('take.kojo', [weave('回合末', ['only'], 5)]), doc('listen.kojo', [weave('回合末', [], 9)])],
      adapter(),
    );
    expect(result.shadowed).toHaveLength(1);
    const entry = result.shadowed[0]!;
    expect(entry.code).toBe('core/weave/shadowed-listener');
    expect(entry.severity).toBe('warning');
    expect(entry.bucket).toBe('plain');
    expect(entry.listener.filePath).toBe('listen.kojo');
    expect(filesOf(entry.suppressors)).toEqual(['take.kojo']);
    expect(entry.spans).toHaveLength(2);
    expect(entry.files).toEqual(['listen.kojo', 'take.kojo']);
    expect(entry.message).toContain('take.kojo:5:1');
    expect(entry.message).toContain('listen.kojo:9:1');
    // 唯一接管者不把自己记成被压
    expect(entry.listener.filePath).not.toBe('take.kojo');
    // 逐块读数：普通监听 shadowed、接管 takeover
    expect(result.units.map((unit) => unit.verdict)).toEqual(['shadowed', 'takeover']);
  });

  it('被压链：A 压 B、B 压 C（多个接管并存时彼此互压，且都压普通监听）', () => {
    const result = analyzeWeaveLayers(
      [
        doc('a.kojo', [weave('回合末', ['only'], 1)]),
        doc('b.kojo', [weave('回合末', ['only'], 2)]),
        doc('c.kojo', [weave('回合末', [], 3)]),
      ],
      adapter(),
    );
    expect(result.conflicts).toHaveLength(1); // 多个接管本身已报冲突
    const shadowedFor = (filePath: string) => result.shadowed.find((entry) => entry.listener.filePath === filePath)!;
    // A 压 B
    expect(filesOf(shadowedFor('b.kojo').suppressors)).toEqual(['a.kojo']);
    // B 压 C（C 同时被 A 压 ⇒ A→B→C 的链在"被谁压"里可见）
    expect(filesOf(shadowedFor('c.kojo').suppressors)).toEqual(['a.kojo', 'b.kojo']);
    // 接管之间互压：B 也压住 A——只能有一个执行
    expect(filesOf(shadowedFor('a.kojo').suppressors)).toEqual(['b.kojo']);
    expect(shadowedFor('b.kojo').bucket).toBe('only');
  });

  it('被压事实按（事件名 → 监听落点）稳定排序', () => {
    const result = analyzeWeaveLayers(
      [
        doc('b-take.kojo', [weave('清晨', ['only'], 1)]),
        doc('b-listen.kojo', [weave('清晨', [], 2)]),
        doc('a-take.kojo', [weave('回合末', ['only'], 1)]),
        doc('a-listen.kojo', [weave('回合末', [], 9)]),
      ],
      adapter(),
    );
    expect(result.shadowed.map((entry) => entry.event)).toEqual(['回合末', '清晨']);
    expect(result.shadowed.map((entry) => entry.listener.span?.start.line)).toEqual([9, 2]);
  });

  it('每条事实的 files 与 spans 一致（去重 + 码元序）', () => {
    const result = analyzeWeaveLayers(
      [
        doc('b.kojo', [weave('回合末', ['only'], 1)]),
        doc('b.kojo', [weave('回合末', [], 2)]),
        doc('a.kojo', [weave('回合末', ['only'], 3)]),
      ],
      adapter(),
    );
    for (const fact of [...result.conflicts, ...result.shadowed]) {
      const expected = [...new Set(filesOf(fact.spans))].sort();
      expect(fact.files).toEqual(expected);
    }
  });
});

/* ============================== 4. 优先级模型与修饰词 ============================== */

describe('优先级模型 · 修饰词', () => {
  it('priorityModel=none + 之前 ⇒ priority-unsupported（#PRI 无落点）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['pri'], 4)])],
      adapter({ events: [{ event: '回合末', priority: 'none' }] }),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('priority-unsupported');
    expect(conflict.code).toBe('core/weave/unsupported');
    expect(conflict.severity).toBe('error');
    expect(conflict.bucket).toBe('pri');
    expect(conflict.message).toContain('emuera-buckets');
    expect(conflict.message).toContain('之前');
    // 无落点的修饰词不参与推理，逐块判 blocked
    expect(result.shadowed).toEqual([]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.verdict).toBe('blocked');
    expect(result.units[0]!.bucket).toBe('pri');
    expect(result.units[0]!.codes).toEqual(['core/weave/unsupported']);
  });

  it('priorityModel=none + 普通监听 ⇒ 无冲突（只有修饰词需要落点）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', [], 1)])],
      adapter({ events: [{ event: '回合末', priority: 'none' }] }),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.units[0]!.priorityModel).toBe('none');
    expect(result.units[0]!.bucket).toBe('plain');
    expect(result.units[0]!.verdict).toBe('effective');
  });

  it('priorityModel=load-order + 接管 ⇒ 同样 unsupported（非 emuera 分桶一律不支持）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 1)])],
      adapter({ events: [{ event: '回合末', priority: 'load-order' }] }),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe('priority-unsupported');
    expect(result.conflicts[0]!.message).toContain('load-order');
  });

  it('修饰词并用（接管 + 之后）⇒ modifier-conflict，不进推理、不压普通监听', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only', 'later'], 1), weave('回合末', [], 2)])],
      adapter(),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('modifier-conflict');
    expect(conflict.code).toBe('core/weave/modifier-conflict');
    expect(conflict.bucket).toBeNull();
    expect(result.shadowed).toEqual([]); // 非法接管不压普通监听
    expect(result.units.map((unit) => unit.bucket)).toEqual([null, 'plain']);
    expect(result.units.map((unit) => unit.verdict)).toEqual(['blocked', 'effective']);
  });

  it('修饰词重复（接管 + 接管）⇒ modifier-conflict', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only', 'only'], 1)])],
      adapter(),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.kind).toBe('modifier-conflict');
  });
});

/* ============================== 5. 能力检查（S5.4） ============================== */

describe('适配器能力检查', () => {
  it('未知事件 ⇒ unknown-event（priorityModel = null，不猜形状），且不参与压盖推理', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('不存在的事件', ['only'], 1)]), doc('b.kojo', [weave('不存在的事件', [], 2)])],
      adapter(),
    );
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((conflict) => conflict.kind === 'unknown-event')).toBe(true);
    expect(result.conflicts.every((conflict) => conflict.code === 'core/weave/unsupported')).toBe(true);
    expect(result.shadowed).toEqual([]);
    expect(result.units).toHaveLength(2);
    expect(result.units.every((unit) => unit.priorityModel === null)).toBe(true);
    expect(result.units.every((unit) => unit.verdict === 'blocked')).toBe(true);
  });

  it('weavable=false ⇒ not-weavable（挂上去运行期不会执行），逐块 blocked', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', [], 1)])],
      adapter({ events: [{ event: '回合末', priority: 'emuera-buckets', weavable: false }] }),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('not-weavable');
    expect(conflict.code).toBe('core/weave/not-weavable');
    expect(result.shadowed).toEqual([]);
    expect(result.units[0]!.bucket).toBe('plain');
    expect(result.units[0]!.verdict).toBe('blocked');
  });

  it('weavable 缺省 = 可监听（additive 端口：老事实不带这一格）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 1)])],
      adapter({ events: [{ event: '回合末', priority: 'emuera-buckets' }] }),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.units[0]!.bucket).toBe('only');
    expect(result.units[0]!.verdict).toBe('takeover');
  });
});

/* ============================== 6. 确定性 / 排序 / 不修改输入 ============================== */

describe('输出确定性', () => {
  const documents: readonly WeaveLayerDocument[] = [
    doc('a.kojo', [weave('回合末', [], 3), weave('回合末', ['only'], 2)]),
    doc('b.kojo', [weave('回合末', ['pri'], 5), weave('清晨', ['only'], 1)]),
    doc('c.kojo', [weave('清晨', [], 2), weave('回合末', ['only'], 7)]),
  ];

  it('同一输入调用两次 ⇒ 结果逐字节相等', () => {
    const facts = adapter();
    expect(JSON.stringify(analyzeWeaveLayers(documents, facts))).toBe(
      JSON.stringify(analyzeWeaveLayers(documents, facts)),
    );
  });

  it('打乱文件顺序与声明顺序 ⇒ 结果逐字节相等', () => {
    const reversed: WeaveLayerDocument[] = [...documents].reverse().map((document) => ({
      ...document,
      file: fileOf([...document.file.decls].reverse()),
    }));
    const one = analyzeWeaveLayers(documents, adapter());
    const two = analyzeWeaveLayers(reversed, adapter());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });

  it('不修改输入（documents / file / decls 逐字节不变）', () => {
    const snapshot = JSON.stringify(documents);
    analyzeWeaveLayers(documents, adapter());
    expect(JSON.stringify(documents)).toBe(snapshot);
  });

  it('冲突全局按（事件名 → 文件路径 → 行号）排序', () => {
    const result = analyzeWeaveLayers(
      [
        doc('b.kojo', [weave('回合末', ['only', 'later'], 5)]),
        doc('a.kojo', [weave('回合末', ['only', 'later'], 2)]),
      ],
      adapter(),
    );
    expect(result.conflicts.map((conflict) => conflict.spans[0]!.filePath)).toEqual(['a.kojo', 'b.kojo']);
    expect(result.conflicts.map((conflict) => conflict.spans[0]!.span?.start.line)).toEqual([2, 5]);
  });

  it('units 逐块按（事件名 → 文件路径 → 行号）排序', () => {
    const result = analyzeWeaveLayers(
      [
        doc('z.kojo', [weave('回合末', [], 9)]),
        doc('a.kojo', [weave('回合末', [], 5), weave('回合末', [], 1)]),
        doc('b.kojo', [weave('清晨', [], 2)]),
      ],
      adapter(),
    );
    expect(result.units.map(unitKey)).toEqual([
      '回合末:a.kojo:1',
      '回合末:a.kojo:5',
      '回合末:z.kojo:9',
      '清晨:b.kojo:2',
    ]);
  });

  it('四态判定可一次读出：takeover / shadowed / effective / blocked', () => {
    const result = analyzeWeaveLayers(
      [
        doc('take.kojo', [weave('回合末', ['only'], 1)]),
        doc('listen.kojo', [weave('回合末', [], 2)]),
        doc('bad.kojo', [weave('回合末', ['only', 'later'], 3)]),
        doc('lone.kojo', [weave('清晨', [], 1)]),
      ],
      adapter(),
    );
    const verdictOf = (filePath: string) => result.units.find((unit) => unit.listener.filePath === filePath)!.verdict;
    expect(verdictOf('take.kojo')).toBe('takeover');
    expect(verdictOf('listen.kojo')).toBe('shadowed');
    expect(verdictOf('bad.kojo')).toBe('blocked');
    expect(verdictOf('lone.kojo')).toBe('effective');
    expect(result.units.find((unit) => unit.listener.filePath === 'bad.kojo')!.codes).toEqual([
      'core/weave/modifier-conflict',
    ]);
    expect(filesOf(result.units.find((unit) => unit.listener.filePath === 'listen.kojo')!.suppressors)).toEqual([
      'take.kojo',
    ]);
  });

  it('units 与冲突 / 被压引用同一批事实对象（不复制、不双报）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', ['only'], 1)]), doc('b.kojo', [weave('回合末', ['only'], 2)])],
      adapter(),
    );
    const unit = result.units.find((entry) => entry.listener.filePath === 'a.kojo')!;
    expect(unit.listener).toBe(result.conflicts[0]!.spans.find((span) => span.filePath === 'a.kojo'));
    expect(unit.codes).toEqual(['core/weave/multiple-only']);
    // 冲突中的接管同时被并存接管压住（"被谁压"仍如实填，结论由 blocked 优先表达）
    expect(filesOf(unit.suppressors)).toEqual(['b.kojo']);
    expect(unit.verdict).toBe('blocked');
  });

  it('severity 全部取自诊断码表：冲突 error、被压 warning', () => {
    const result = analyzeWeaveLayers(
      [
        doc('a.kojo', [weave('回合末', ['only'], 1)]),
        doc('b.kojo', [weave('回合末', ['only'], 2)]),
        doc('c.kojo', [weave('回合末', [], 3)]),
      ],
      adapter(),
    );
    expect(result.conflicts.every((conflict) => conflict.severity === 'error')).toBe(true);
    expect(result.shadowed.every((entry) => entry.severity === 'warning')).toBe(true);
  });
});
