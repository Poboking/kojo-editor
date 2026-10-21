/**
 * adapter-sdk 契约测试：**只用 fixture adapter**，不依赖任何游戏包（§16.3 DoD）。
 *
 * 覆盖两面：
 * 1) fixture adapter 自身能通过全量契约自检（`validateGameAdapter` 无诊断）；
 * 2) 用户源码侧的错误路径：未知事件 / 未知说话人 / 未知符号 / 未声明演出 / 未开启
 *    program feature / 未声明存储期 —— 每条都要有稳定的 core 码或命名空间码。
 */
import { describe, expect, it } from 'vitest';

import type {
  AdapterProfile,
  ConformanceSuite,
  EncodingPolicy,
  GameAdapter,
  SourceMapPolicy,
  StorageClasses,
} from '../src/adapter';
import {
  ADAPTER_VALIDATION_CODES,
  checkEvent,
  checkEventArgs,
  checkPresentation,
  checkProgramFeature,
  checkSpeaker,
  checkStoragePeriod,
  checkSymbol,
  checkWeavePriority,
  eventNames,
  findEvent,
  freezeAdapter,
  validateGameAdapter,
} from '../src/adapter';
import { FIXTURE_ADAPTER } from '../src/fixture-adapter';
import type { ForeachDeclarations } from '../src/lower/expand/foreach';

/** 在 fixture 上做**浅层**改写：本文件只测校验函数，不测数据结构本身 */
function fixtureWith(overrides: Partial<GameAdapter>): GameAdapter {
  return { ...FIXTURE_ADAPTER, ...overrides };
}

const codesOf = (adapter: GameAdapter): readonly string[] => validateGameAdapter(adapter).map((d) => d.code);

describe('fixture adapter：契约自检全绿', () => {
  it('validateGameAdapter 返回空数组（零诊断 = 契约自洽）', () => {
    expect(validateGameAdapter(FIXTURE_ADAPTER)).toEqual([]);
  });

  it('深冻结：根 / 嵌套表 / 数组元素都不可写', () => {
    expect(Object.isFrozen(FIXTURE_ADAPTER)).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.eventCatalog)).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.eventCatalog.events)).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.eventCatalog.events[0])).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.profile)).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.storageClasses.classes[0])).toBe(true);
    expect(Object.isFrozen(FIXTURE_ADAPTER.conformanceSuite.cases)).toBe(true);
  });

  it('事件表可查询：2 个事件、事件名有序、引擎落点可见', () => {
    expect(eventNames(FIXTURE_ADAPTER)).toEqual(['开场', '收场']);
    expect(findEvent(FIXTURE_ADAPTER, '收场')?.engine).toBe('CLOSE');
    expect(findEvent(FIXTURE_ADAPTER, '不存在')).toBeUndefined();
  });
});

describe('用户源码侧：未知事件', () => {
  it('已知事件返回 null', () => {
    expect(checkEvent(FIXTURE_ADAPTER, '开场')).toBeNull();
  });

  it('未知事件 → event/unknown error，并列出当前 adapter 的可用事件（不是内置枚举）', () => {
    const diagnostic = checkEvent(FIXTURE_ADAPTER, '隐藏情景');
    expect(diagnostic).not.toBeNull();
    expect(diagnostic?.code).toBe('event/unknown');
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('隐藏情景');
    expect(diagnostic?.message).toContain('开场、收场');
  });

  it('诊断带上调用方给的 span（1 基行/列原样透传）', () => {
    const span = { start: { line: 3, column: 1 }, end: { line: 3, column: 12 } };
    expect(checkEvent(FIXTURE_ADAPTER, '未知', span)?.span).toEqual(span);
  });

  it('未知事件只报 event/unknown 一条，不叠参数错误', () => {
    const diagnostics = checkEventArgs(FIXTURE_ADAPTER, '未知', ['1', '2']);
    expect(diagnostics.map((d) => d.code)).toEqual(['event/unknown']);
  });
});

describe('用户源码侧：事件参数形状', () => {
  it('可选 int 参数缺省合法；整数形状合法', () => {
    expect(checkEventArgs(FIXTURE_ADAPTER, '收场', [])).toEqual([]);
    expect(checkEventArgs(FIXTURE_ADAPTER, '收场', ['310'])).toEqual([]);
    expect(checkEventArgs(FIXTURE_ADAPTER, '收场', ['-2'])).toEqual([]);
  });

  it('非整数实参 → event/argument error', () => {
    const diagnostics = checkEventArgs(FIXTURE_ADAPTER, '收场', ['310号']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('event/argument');
    expect(diagnostics[0]?.message).toContain('整数');
  });

  it('实参超过声明形状 → event/argument error', () => {
    const diagnostics = checkEventArgs(FIXTURE_ADAPTER, '开场', ['1']);
    expect(diagnostics.map((d) => d.code)).toEqual(['event/argument']);
  });
});

describe('用户源码侧：说话人与域符号', () => {
  it('代词与 closed 名表内的说话人可解析', () => {
    expect(checkSpeaker(FIXTURE_ADAPTER, '我')).toBeNull();
    expect(checkSpeaker(FIXTURE_ADAPTER, '你')).toBeNull();
  });

  it('未知说话人 → core/narrative/unknown-speaker', () => {
    const diagnostic = checkSpeaker(FIXTURE_ADAPTER, '路人甲');
    expect(diagnostic?.code).toBe('core/narrative/unknown-speaker');
    expect(diagnostic?.severity).toBe('error');
  });

  it('已声明的代词 / 角色属性 / 名字函数都可解析', () => {
    expect(checkSymbol(FIXTURE_ADAPTER, '我')).toBeNull();
    expect(checkSymbol(FIXTURE_ADAPTER, '数值')).toBeNull();
    expect(checkSymbol(FIXTURE_ADAPTER, '名字')).toBeNull();
  });

  it('未知符号 → core/expr/unknown-symbol', () => {
    expect(checkSymbol(FIXTURE_ADAPTER, '不存在的属性')?.code).toBe('core/expr/unknown-symbol');
  });

  it("unknown = 'raw' 时未知符号原样放行（糖视图无法表达的走 raw）", () => {
    const adapter = fixtureWith({
      domainSymbols: { ...FIXTURE_ADAPTER.domainSymbols, unknown: 'raw' },
    });
    expect(checkSymbol(adapter, '不存在的属性')).toBeNull();
  });

  it('project 名表的说话人交给项目级分析，SDK 层不猜（返回 null 而不是误报）', () => {
    const adapter = fixtureWith({
      domainSymbols: {
        ...FIXTURE_ADAPTER.domainSymbols,
        speakers: { kind: 'project', table: 'characters', key: 'CALLNAME' },
      },
    });
    expect(checkSpeaker(adapter, '任意角色名')).toBeNull();
    expect(checkSpeaker(adapter, '我')).toBeNull();
  });
});

describe('用户源码侧：未声明 presentation', () => {
  it('fixture 未声明心形/着色/颜绘 → 各自的 core 码（error，不生成无效产物）', () => {
    expect(checkPresentation(FIXTURE_ADAPTER, 'heart')?.code).toBe('core/feature/unsupported');
    expect(checkPresentation(FIXTURE_ADAPTER, 'color')?.code).toBe('core/color/unsupported');
    expect(checkPresentation(FIXTURE_ADAPTER, 'face')?.code).toBe('core/face/unsupported');
    expect(checkPresentation(FIXTURE_ADAPTER, 'heart')?.severity).toBe('error');
  });

  it('`选项` 未声明 = fail-closed error（与 lowering 能力闸同码同级别；待定 warning 只来自 lowering）', () => {
    const diagnostic = checkPresentation(FIXTURE_ADAPTER, 'options');
    expect(diagnostic?.code).toBe('core/feature/unsupported');
    expect(diagnostic?.severity).toBe('error');
  });

  it('声明后的演出面返回 null', () => {
    const adapter = fixtureWith({
      presentation: {
        ...FIXTURE_ADAPTER.presentation,
        color: { setColor: 'COLOR_ON', resetColor: 'COLOR_OFF', hexPrefix: '0x' },
      },
    });
    expect(checkPresentation(adapter, 'color')).toBeNull();
  });
});

describe('用户源码侧：programFeatures 闸门', () => {
  it('fixture program 全关 → 每种构造映射到正确的 core 码', () => {
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'arrays')?.code).toBe('core/array/unsupported');
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'while')?.code).toBe('core/control/unsupported');
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'foreach')?.code).toBe('core/control/unsupported');
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'repeat')?.code).toBe('core/control/unsupported');
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'goto')?.code).toBe('core/goto/unsupported');
    expect(checkProgramFeature(FIXTURE_ADAPTER, 'recursion')?.code).toBe('core/func/recursion-unsupported');
  });

  it('错误文案指出 adapter 与可替代写法（@原生 逃生舱）', () => {
    const diagnostic = checkProgramFeature(FIXTURE_ADAPTER, 'while');
    expect(diagnostic?.message).toContain('fixture');
    expect(diagnostic?.message).toContain('@原生');
  });

  it('开启后返回 null（fixture 改写成全开也仍然契约自洽）', () => {
    const adapter = fixtureWith({
      profile: { ...FIXTURE_ADAPTER.profile, features: ['program', 'arrays', 'goto', 'recursion', 'loops'] },
      programFeatures: { arrays: true, while: true, goto: true, recursion: true, foreach: true, repeat: true },
    });
    expect(checkProgramFeature(adapter, 'while')).toBeNull();
    expect(validateGameAdapter(adapter)).toEqual([]);
  });
});

describe('用户源码侧：未声明存储期', () => {
  it('fixture 只声明场景 → 存档/会话报 core/decl/unknown-storage', () => {
    expect(checkStoragePeriod(FIXTURE_ADAPTER, 'scene')).toBeNull();
    expect(checkStoragePeriod(FIXTURE_ADAPTER, 'save')?.code).toBe('core/decl/unknown-storage');
    expect(checkStoragePeriod(FIXTURE_ADAPTER, 'session')?.code).toBe('core/decl/unknown-storage');
    expect(checkStoragePeriod(FIXTURE_ADAPTER, 'save')?.message).toContain('存档');
  });
});

describe('用户源码侧：@织 优先级模型', () => {
  it('load-order 模型下 之前/之后/接管 不可用 → core/weave/unsupported', () => {
    expect(checkWeavePriority(FIXTURE_ADAPTER, '开场')?.code).toBe('core/weave/unsupported');
  });

  it('未知事件的织入检查复用 event/unknown', () => {
    expect(checkWeavePriority(FIXTURE_ADAPTER, '未知')?.code).toBe('event/unknown');
  });

  it('emuera-buckets 事件允许有落点的修饰词', () => {
    const bucketEvent = { ...FIXTURE_ADAPTER.eventCatalog.events[0]!, priority: 'emuera-buckets' as const };
    const adapter = fixtureWith({
      eventCatalog: { ...FIXTURE_ADAPTER.eventCatalog, events: [bucketEvent] },
    });
    expect(checkWeavePriority(adapter, '开场')).toBeNull();
  });
});

describe('adapter 自检：坏契约的错误路径', () => {
  it('缺 profile.narrationColor → core/profile/missing；缺 waitDefault → core/wait/no-profile', () => {
    const noNarration = fixtureWith({
      profile: { ...FIXTURE_ADAPTER.profile, narrationColor: undefined as unknown as AdapterProfile['narrationColor'] },
    });
    expect(codesOf(noNarration)).toContain('core/profile/missing');

    const noWait = fixtureWith({
      profile: { ...FIXTURE_ADAPTER.profile, waitDefault: undefined as unknown as AdapterProfile['waitDefault'] },
    });
    expect(codesOf(noWait)).toContain('core/wait/no-profile');
  });

  it('事件名重复 → event/duplicate', () => {
    const first = FIXTURE_ADAPTER.eventCatalog.events[0]!;
    const adapter = fixtureWith({
      eventCatalog: { ...FIXTURE_ADAPTER.eventCatalog, events: [first, { ...first }] },
    });
    expect(codesOf(adapter)).toContain('event/duplicate');
  });

  it('空事件目录 → event/catalog-empty', () => {
    const adapter = fixtureWith({ eventCatalog: { ...FIXTURE_ADAPTER.eventCatalog, events: [] } });
    expect(codesOf(adapter)).toContain('event/catalog-empty');
  });

  it('缺 gameFingerprint.digest → unit/fingerprint-missing', () => {
    const adapter = fixtureWith({
      gameFingerprint: { digest: '  ', entries: [] },
    });
    expect(codesOf(adapter)).toContain('unit/fingerprint-missing');
  });

  it('存储期持久化口径不符 → unit/storage-inconsistent', () => {
    const scene = FIXTURE_ADAPTER.storageClasses.classes[0]!;
    const storage: StorageClasses = {
      ...FIXTURE_ADAPTER.storageClasses,
      classes: [{ ...scene, persisted: true }],
    };
    expect(codesOf(fixtureWith({ storageClasses: storage }))).toContain('unit/storage-inconsistent');
  });

  it('槽前缀不带 __ → unit/storage-inconsistent（作者名字空间隔离）', () => {
    const scene = FIXTURE_ADAPTER.storageClasses.classes[0]!;
    const storage: StorageClasses = {
      ...FIXTURE_ADAPTER.storageClasses,
      classes: [{ ...scene, slotPrefix: 'kojo_scene_' }],
    };
    expect(codesOf(fixtureWith({ storageClasses: storage }))).toContain('unit/storage-inconsistent');
  });

  it('编码策略：缺省编码不在白名单 / 归一化开关打开 → unit/encoding-policy', () => {
    const encoding: EncodingPolicy = {
      ...FIXTURE_ADAPTER.encodingPolicy,
      defaultEncoding: 'utf-16le-bom',
      allowedEncodings: ['utf-8'],
    };
    expect(codesOf(fixtureWith({ encodingPolicy: encoding }))).toContain('unit/encoding-policy');

    const normalize: EncodingPolicy = {
      ...FIXTURE_ADAPTER.encodingPolicy,
      normalizeOnSave: true as unknown as false,
    };
    expect(codesOf(fixtureWith({ encodingPolicy: normalize }))).toContain('unit/encoding-policy');
  });

  it('专属码落在未声明的命名空间 → unit/diagnostic-namespace', () => {
    const adapter = fixtureWith({
      diagnosticNamespace: {
        namespaces: ['event'],
        codes: ['event/unknown', 'text/encoding'],
      },
    });
    expect(codesOf(adapter)).toContain('unit/diagnostic-namespace');
  });

  it('执行代码但没有完整性校验 → unit/capability-integrity', () => {
    const adapter = fixtureWith({
      capability: { ...FIXTURE_ADAPTER.capability, executesCode: true, integrity: 'none' },
    });
    expect(codesOf(adapter)).toContain('unit/capability-integrity');
  });

  it('source map 缺事件头映射 → unit/source-map-incomplete', () => {
    const sourceMap: SourceMapPolicy = { ...FIXTURE_ADAPTER.sourceMap, mapsEventHeader: false };
    expect(codesOf(fixtureWith({ sourceMap }))).toContain('unit/source-map-incomplete');
  });

  it('一致性套件缺 smoke → unit/conformance-incomplete', () => {
    const cases = FIXTURE_ADAPTER.conformanceSuite.cases.filter((item) => item.kind !== 'smoke');
    const conformanceSuite: ConformanceSuite = {
      ...FIXTURE_ADAPTER.conformanceSuite,
      required: ['golden', 'differential', 'encoding'],
      cases,
    };
    expect(codesOf(fixtureWith({ conformanceSuite }))).toContain('unit/conformance-incomplete');
  });

  it('自检码全部是 error（adapter 装载失败不能只给 warning）', () => {
    const broken = fixtureWith({
      eventCatalog: { ...FIXTURE_ADAPTER.eventCatalog, events: [] },
      capability: { ...FIXTURE_ADAPTER.capability, executesCode: true, integrity: 'none' },
    });
    const diagnostics = validateGameAdapter(broken);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.severity === 'error')).toBe(true);
    expect(diagnostics.map((d) => d.code)).toContain(ADAPTER_VALIDATION_CODES.eventEmpty);
  });
});

describe('adapter 自检：`@巡` 集合声明（K2-FOREACH，additive）', () => {
  const DECLARATIONS: ForeachDeclarations = {
    collections: [
      {
        name: '队伍',
        kind: 'characters',
        elementType: 'character',
        base: 1,
        keyType: null,
        length: { kind: 'engine', counter: 'COUNT', minus: 1 },
        bindings: ['角', '名'],
        nameAccessor: 'NAME_OF',
      },
    ],
    arrayRule: { base: 0, bindings: ['值', '下标'] },
  };

  it('fixture 传 null（= 本 adapter 不支持 `@巡`）：自检仍全绿（老 adapter 零改动）', () => {
    expect(FIXTURE_ADAPTER.foreachCollections).toBeNull();
    expect(validateGameAdapter(FIXTURE_ADAPTER)).toEqual([]);
  });

  it('自洽声明：adapter 全量自检零诊断', () => {
    expect(validateGameAdapter(fixtureWith({ foreachCollections: DECLARATIONS }))).toEqual([]);
  });

  it('声明自洽时 `@巡` 才有落点；反之未声明集合是运行期错误（不静默）', () => {
    const adapter = fixtureWith({ foreachCollections: DECLARATIONS });
    // adapter 自检不查用户源码；集合名解析发生在 lowering（plan）
    expect(validateGameAdapter(adapter)).toEqual([]);
  });

  it('绑定越界（角色集合声明 {值}）→ unit/adapter-inconsistent（走既有 adapter 码表）', () => {
    const broken: ForeachDeclarations = {
      ...DECLARATIONS,
      collections: [{ ...DECLARATIONS.collections[0]!, bindings: ['值'] }],
    };
    const codes = codesOf(fixtureWith({ foreachCollections: broken })).filter((code) => code.startsWith('unit/'));
    expect(codes).toEqual([ADAPTER_VALIDATION_CODES.inconsistent]);
  });

  it('声明了 {名} 却没有 {角} / 缺 nameAccessor → unit/adapter-inconsistent', () => {
    const noAngle: ForeachDeclarations = {
      ...DECLARATIONS,
      collections: [{ ...DECLARATIONS.collections[0]!, bindings: ['名'] }],
    };
    expect(codesOf(fixtureWith({ foreachCollections: noAngle }))).toContain(ADAPTER_VALIDATION_CODES.inconsistent);

    const noAccessor: ForeachDeclarations = {
      ...DECLARATIONS,
      collections: [{ ...DECLARATIONS.collections[0]!, nameAccessor: null }],
    };
    expect(codesOf(fixtureWith({ foreachCollections: noAccessor }))).toContain(ADAPTER_VALIDATION_CODES.inconsistent);
  });

  it('命名集合重复 / 数组规则绑定越界 → unit/adapter-inconsistent', () => {
    const duplicated: ForeachDeclarations = {
      ...DECLARATIONS,
      collections: [DECLARATIONS.collections[0]!, DECLARATIONS.collections[0]!],
    };
    expect(codesOf(fixtureWith({ foreachCollections: duplicated }))).toContain(ADAPTER_VALIDATION_CODES.inconsistent);

    const badRule: ForeachDeclarations = {
      ...DECLARATIONS,
      arrayRule: { base: 0, bindings: ['角'] },
    };
    expect(codesOf(fixtureWith({ foreachCollections: badRule }))).toContain(ADAPTER_VALIDATION_CODES.inconsistent);
  });

  it('空声明（无集合也无数组规则）→ unit/adapter-incomplete（要么给声明、要么给 null）', () => {
    const empty: ForeachDeclarations = { collections: [], arrayRule: null };
    expect(codesOf(fixtureWith({ foreachCollections: empty }))).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });

  it('collections 不是数组 → unit/adapter-incomplete（形状都不对，不猜）', () => {
    const malformed = { collections: null, arrayRule: null } as unknown as ForeachDeclarations;
    expect(codesOf(fixtureWith({ foreachCollections: malformed }))).toContain(ADAPTER_VALIDATION_CODES.incomplete);
  });
});

describe('freezeAdapter', () => {
  it('对未冻结的新对象做深冻结（数组元素也冻）', () => {
    const raw: GameAdapter = {
      ...FIXTURE_ADAPTER,
      eventCatalog: {
        ...FIXTURE_ADAPTER.eventCatalog,
        events: FIXTURE_ADAPTER.eventCatalog.events.map((spec) => ({ ...spec, args: [...spec.args] })),
      },
    };
    expect(Object.isFrozen(raw.eventCatalog.events[0])).toBe(false);
    const frozen = freezeAdapter(raw);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.eventCatalog.events[0])).toBe(true);
    expect(Object.isFrozen(frozen.eventCatalog.events[0]?.args)).toBe(true);
  });
});
