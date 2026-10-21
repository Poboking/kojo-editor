/**
 * eraTW 2.0 adapter 数据测试。
 *
 * 两类断言：
 * 1) **契约自洽**：`ERATW_GAME_ADAPTER` 过 `validateGameAdapter` 全绿、深冻结、
 *    能力面与 §10/§B 的口径逐条对上；
 * 2) **不抄第二份数据**：presentation 的引擎函数名、名字函数表必须能追回既有
 *    `ERATW_LIBRARY_FUNCTIONS` 单一真源；事件数/事件名对齐附录 B.1。
 */
import { describe, expect, it } from 'vitest';

import type { GameAdapter } from '../../../../kojo-core/src/adapter.js';
import {
  checkEvent,
  checkEventArgs,
  checkPresentation,
  checkProgramFeature,
  checkSpeaker,
  checkStoragePeriod,
  checkSymbol,
  checkWeavePriority,
  eventNames,
  validateGameAdapter,
} from '../../../../kojo-core/src/adapter.js';
import { createEratwFaceTable } from '../../src/face-templates.js';
import { ERATW_LIBRARY_FUNCTIONS } from '../../src/library-table.js';
import {
  ERATW_DOMAIN_SYMBOLS,
  ERATW_EVENT_CATALOG,
  ERATW_EVENT_NAMES,
  ERATW_FOREACH_COLLECTIONS,
  ERATW_FOREACH_DECLARATIONS,
  ERATW_GAME_ADAPTER,
  ERATW_GAME_FINGERPRINT,
  ERATW_PRESENTATION,
  ERATW_PROFILE,
  ERATW_PROGRAM_FEATURES,
  ERATW_STORAGE_CLASSES,
} from '../../src/kojo2/index.js';

/** 附录 B.1 的九事件（中文名 → 引擎事件）——测试侧独立抄一份**期望值**，防数据侧漂移 */
const EXPECTED_EVENTS: readonly (readonly [string, string])[] = [
  ['初见', 'EVENTFIRST'],
  ['训练', 'EVENTTRAIN'],
  ['读档', 'EVENTLOAD'],
  ['商店', 'EVENTSHOP'],
  ['购买', 'EVENTBUY'],
  ['指令', 'EVENTCOM'],
  ['训练结束', 'EVENTEND'],
  ['回合末', 'EVENTTURNEND'],
  ['指令结束', 'EVENTCOMEND'],
];

/** 附录 B.1 的强制事件（引擎保证触发） */
const FORCED_EVENTS: readonly string[] = ['初见', '训练结束', '回合末'];

describe('eraTW adapter：契约自检', () => {
  it('validateGameAdapter 全绿（零诊断）', () => {
    expect(validateGameAdapter(ERATW_GAME_ADAPTER)).toEqual([]);
  });

  it('深冻结：根与各能力面都不可写', () => {
    expect(Object.isFrozen(ERATW_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.eventCatalog.events)).toBe(true);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.eventCatalog.events[0])).toBe(true);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.domainSymbols.pronouns)).toBe(true);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.storageClasses.classes)).toBe(true);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.presentation.heart)).toBe(true);
  });

  it('标识与指纹：id/version 稳定，指纹四段齐全', () => {
    expect(ERATW_GAME_ADAPTER.id).toBe('eratw');
    expect(ERATW_GAME_ADAPTER.version).toBe('2.0.0');
    expect(ERATW_GAME_FINGERPRINT.digest.length).toBeGreaterThan(0);
    expect(ERATW_GAME_FINGERPRINT.entries.map((entry) => entry.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
  });
});

describe('eraTW adapter：事件目录（附录 B.1）', () => {
  it('恰好九个事件，事件名与引擎事件逐条对齐', () => {
    expect(ERATW_EVENT_CATALOG.events).toHaveLength(9);
    expect(ERATW_EVENT_NAMES).toEqual(EXPECTED_EVENTS.map(([name]) => name));
    expect(eventNames(ERATW_GAME_ADAPTER)).toEqual(EXPECTED_EVENTS.map(([name]) => name));
    for (const [name, engine] of EXPECTED_EVENTS) {
      const spec = ERATW_EVENT_CATALOG.events.find((item) => item.event === name);
      expect(spec?.engine).toBe(engine);
    }
  });

  it('全部走 engine-dispatch + emuera-buckets，且都可 @织 监听', () => {
    for (const spec of ERATW_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
    }
  });

  it('强制事件只有初见 / 训练结束 / 回合末', () => {
    const forced = ERATW_EVENT_CATALOG.events.filter((spec) => spec.forced).map((spec) => spec.event);
    expect(forced).toEqual(FORCED_EVENTS);
  });

  it('指令带可选整数编号参数（`# 机 指令 310`）', () => {
    const command = ERATW_EVENT_CATALOG.events.find((spec) => spec.event === '指令');
    expect(command?.args).toHaveLength(1);
    expect(command?.args[0]).toEqual({ name: '编号', kind: 'int', required: false });
  });

  it('`# 机 指令 310` 参数形状：整数放行、缺省放行、非整数/未知事件走错误路径', () => {
    expect(checkEventArgs(ERATW_GAME_ADAPTER, '指令', ['310'])).toEqual([]);
    expect(checkEventArgs(ERATW_GAME_ADAPTER, '指令', [])).toEqual([]);
    expect(checkEventArgs(ERATW_GAME_ADAPTER, '指令', ['310号']).map((d) => d.code)).toEqual(['event/argument']);
    expect(checkEventArgs(ERATW_GAME_ADAPTER, '隐藏情景', ['1']).map((d) => d.code)).toEqual(['event/unknown']);
  });

  it('用户源码侧：未知事件报 event/unknown，可用事件列的是本表而不是内置枚举', () => {
    const diagnostic = checkEvent(ERATW_GAME_ADAPTER, '隐藏情景');
    expect(diagnostic?.code).toBe('event/unknown');
    expect(diagnostic?.message).toContain(EXPECTED_EVENTS.map(([name]) => name).join('、'));
  });

  it('@织 修饰词：emuera-buckets 事件放行', () => {
    for (const [name] of EXPECTED_EVENTS) {
      expect(checkWeavePriority(ERATW_GAME_ADAPTER, name)).toBeNull();
    }
  });
});

describe('eraTW adapter：域符号', () => {
  it('三个代词齐全，落点沿用 v1 CALLNAME 口径', () => {
    const byRole = new Map(ERATW_DOMAIN_SYMBOLS.pronouns.map((item) => [item.role, item]));
    expect(byRole.get('me')?.pronoun).toBe('我');
    expect(byRole.get('you')?.pronoun).toBe('你');
    expect(byRole.get('her')?.pronoun).toBe('她');
    // v1 PRONOUN_MAP：{她}/{我} → %CALLNAME:TARGET%，{你} → %CALLNAME:MASTER%
    expect(byRole.get('me')?.engineRef).toBe('%CALLNAME:TARGET%');
    expect(byRole.get('her')?.engineRef).toBe('%CALLNAME:TARGET%');
    expect(byRole.get('you')?.engineRef).toBe('%CALLNAME:MASTER%');
    expect(byRole.get('you')?.requiresView).toBe(false);
    expect(byRole.get('me')?.requiresView).toBe(true);
    for (const item of ERATW_DOMAIN_SYMBOLS.pronouns) expect(item.family).toBe('CALLNAME');
  });

  it('角色属性：好感度/恋慕/恋人/爱欲，编号与既有状态线口径一致', () => {
    const attributes = new Map(ERATW_DOMAIN_SYMBOLS.attributes.map((item) => [item.name, item]));
    expect([...attributes.keys()]).toEqual(['好感度', '恋慕', '恋人', '爱欲']);
    expect(attributes.get('好感度')).toMatchObject({ family: 'CFLAG', index: 2, readonly: false });
    expect(attributes.get('恋慕')).toMatchObject({ family: 'TALENT', index: 3, readonly: true });
    expect(attributes.get('恋人')).toMatchObject({ family: 'TALENT', index: 7, readonly: true });
    expect(attributes.get('爱欲')).toMatchObject({ family: 'TALENT', index: 184, readonly: true });
  });

  it('名字函数从既有库表派生（不抄第二份词表，逐条能追回单一真源）', () => {
    expect(ERATW_DOMAIN_SYMBOLS.nameFunctions.length).toBeGreaterThan(0);
    const engines = [...ERATW_LIBRARY_FUNCTIONS.values()];
    for (const fn of ERATW_DOMAIN_SYMBOLS.nameFunctions) {
      expect(ERATW_LIBRARY_FUNCTIONS.get(fn.name)).toBe(fn.engine);
      expect(engines).toContain(fn.engine);
      expect(fn.returns).toBe('string');
    }
    // 三条名字族的引擎函数在既有表里都必须存在，否则派生会静默变空
    for (const engine of ['CHARA_TEXT', 'PRINT_MALE_CN', 'HE_SHE_CN']) {
      expect([...ERATW_LIBRARY_FUNCTIONS.values()]).toContain(engine);
    }
  });

  it('说话人是开放名表（project / CHARA / CALLNAME），SDK 层按要求不猜', () => {
    expect(ERATW_DOMAIN_SYMBOLS.speakers).toEqual({ kind: 'project', table: 'CHARA', key: 'CALLNAME' });
    expect(checkSpeaker(ERATW_GAME_ADAPTER, '任意角色名')).toBeNull();
    expect(checkSpeaker(ERATW_GAME_ADAPTER, '我')).toBeNull();
  });

  it('用户源码侧：已声明属性可解析，未知符号仍报错', () => {
    expect(checkSymbol(ERATW_GAME_ADAPTER, '好感度')).toBeNull();
    expect(checkSymbol(ERATW_GAME_ADAPTER, '角色文本')).toBeNull();
    expect(checkSymbol(ERATW_GAME_ADAPTER, '不存在的属性')?.code).toBe('core/expr/unknown-symbol');
  });
});

describe('eraTW adapter：profile / 程序层', () => {
  it('profile：作者色 / 等待 / D 系 / IF 池 / PRINTDATA 随机，program 白名单在列', () => {
    expect(ERATW_PROFILE).toMatchObject({
      narrationColor: 'author',
      dialogueColor: 'author',
      waitDefault: 'wait',
      colorMode: 'D',
      poolStyle: 'if',
      randStyle: 'printdata',
    });
    expect(ERATW_PROFILE.features).toContain('program');
  });

  it('programFeatures 六项全开，用户源码侧每种构造都放行', () => {
    expect(ERATW_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: true,
      foreach: true,
      repeat: true,
    });
    for (const feature of ['arrays', 'while', 'goto', 'recursion', 'foreach', 'repeat'] as const) {
      expect(checkProgramFeature(ERATW_GAME_ADAPTER, feature)).toBeNull();
    }
  });

  it('存储期三项齐全，持久化口径正确，用户源码侧三种都能声明', () => {
    expect(ERATW_STORAGE_CLASSES.classes.map((spec) => spec.period)).toEqual(['scene', 'save', 'session']);
    expect(ERATW_STORAGE_CLASSES.classes.map((spec) => spec.persisted)).toEqual([false, true, false]);
    for (const period of ['scene', 'save', 'session'] as const) {
      expect(checkStoragePeriod(ERATW_GAME_ADAPTER, period)).toBeNull();
    }
  });
});

describe('eraTW adapter：演出面（与既有库表对齐）', () => {
  it('心形演出的引擎函数 = 库表里的「心形」', () => {
    expect(ERATW_PRESENTATION.heart?.engine).toBe(ERATW_LIBRARY_FUNCTIONS.get('心形'));
    expect(ERATW_PRESENTATION.heart?.engine).toBe('HPH_PRINT');
  });

  it('心形四象限：台词 w/l、旁白 dw/dl', () => {
    expect(ERATW_PRESENTATION.heart).toMatchObject({
      dialogue: { wait: 'w', continue: 'l' },
      narration: { wait: 'dw', continue: 'dl' },
    });
  });

  it('着色：SETCOLOR … RESETCOLOR，0x 前缀', () => {
    expect(ERATW_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
  });

  it('颜绘：我 → PRINT_FACE/TARGET（库表派生），你 → PRINT_FACE_PLAYER/MASTER，默认表情 通常', () => {
    const face = ERATW_PRESENTATION.face;
    expect(face?.defaultExpression).toBe('通常');
    const calls = new Map(face?.calls.map((call) => [call.object, call]));
    expect(calls.get('me')).toEqual({
      object: 'me',
      call: ERATW_LIBRARY_FUNCTIONS.get('显示表情'),
      receiverArg: 'TARGET',
    });
    expect(calls.get('me')?.call).toBe('PRINT_FACE');
    expect(calls.get('you')).toEqual({ object: 'you', call: 'PRINT_FACE_PLAYER', receiverArg: 'MASTER' });
    expect(face?.maxArgs).toBe(4);
  });

  it('选项：待定 API，落 PRINTBUTTON + INPUTS + RESULTS，单场景一个', () => {
    expect(ERATW_PRESENTATION.options).toEqual({
      status: 'pending',
      button: 'PRINTBUTTON',
      input: 'INPUTS',
      result: 'RESULTS',
      maxPerScene: 1,
    });
  });

  it('四个演出面全声明，用户源码侧不报"不支持"', () => {
    expect(checkPresentation(ERATW_GAME_ADAPTER, 'heart')).toBeNull();
    expect(checkPresentation(ERATW_GAME_ADAPTER, 'color')).toBeNull();
    expect(checkPresentation(ERATW_GAME_ADAPTER, 'face')).toBeNull();
    expect(checkPresentation(ERATW_GAME_ADAPTER, 'options')).toBeNull();
  });

  it('去掉声明后立刻走"当前 adapter 不支持"错误路径（不静默）', () => {
    const bare: GameAdapter = {
      ...ERATW_GAME_ADAPTER,
      presentation: { heart: null, color: null, face: null, options: null },
    };
    expect(checkPresentation(bare, 'heart')?.code).toBe('core/feature/unsupported');
    expect(checkPresentation(bare, 'face')?.code).toBe('core/face/unsupported');
  });

  it('既有分野模板表仍在（本次只加数据目录，不改既有 adapter 表）', () => {
    const faceTable = createEratwFaceTable();
    expect(Object.keys(faceTable.faces).length).toBeGreaterThan(0);
    expect(faceTable.playerColor).toBeTruthy();
  });
});

describe('eraTW adapter：`@巡` 集合声明（K2-FOREACH，additive）', () => {
  it('契约字段 `foreachCollections` 挂的就是 ERA 数据冻结件（同一引用，不复制）', () => {
    expect(ERATW_GAME_ADAPTER.foreachCollections).toBe(ERATW_FOREACH_DECLARATIONS);
    expect(ERATW_FOREACH_COLLECTIONS).toBe(ERATW_FOREACH_DECLARATIONS.collections);
    expect(Object.isFrozen(ERATW_GAME_ADAPTER.foreachCollections)).toBe(true);
  });

  it('角色集合 `队伍` 与数组规则都在契约里；全量自检仍零诊断', () => {
    const collections = ERATW_GAME_ADAPTER.foreachCollections?.collections ?? [];
    expect(collections.map((collection) => collection.name)).toEqual(['队伍']);
    expect(ERATW_GAME_ADAPTER.foreachCollections?.arrayRule).toEqual({ base: 0, bindings: ['值', '下标'] });
    expect(validateGameAdapter(ERATW_GAME_ADAPTER)).toEqual([]);
  });

  it('programFeatures.foreach 开启 + 集合声明齐备 = `@巡` 可用（能力闸与数据面自洽）', () => {
    expect(checkProgramFeature(ERATW_GAME_ADAPTER, 'foreach')).toBeNull();
    expect(ERATW_GAME_ADAPTER.foreachCollections).not.toBeNull();
  });
});

describe('eraTW adapter：非功能性面', () => {
  it('layerPolicy 三类定义面一律 unique', () => {
    expect(ERATW_GAME_ADAPTER.layerPolicy.defaultMode).toBe('unique');
    for (const rule of ERATW_GAME_ADAPTER.layerPolicy.rules) expect(rule.mode).toBe('unique');
    expect(ERATW_GAME_ADAPTER.layerPolicy.rules.map((rule) => rule.target)).toEqual([
      'function',
      'event-hook',
      'kojo-overlay',
    ]);
  });

  it('编码：UTF-16LE 缺省、四种编码都允许读、保存不归一化', () => {
    expect(ERATW_GAME_ADAPTER.encodingPolicy.defaultEncoding).toBe('utf-16le-bom');
    expect(ERATW_GAME_ADAPTER.encodingPolicy.allowedEncodings).toEqual([
      'utf-16le-bom',
      'utf-8-bom',
      'utf-8',
    ]);
    expect(ERATW_GAME_ADAPTER.encodingPolicy.normalizeOnSave).toBe(false);
    expect(ERATW_GAME_ADAPTER.encodingPolicy.eol).toBe('mixed');
  });

  it('capability：纯数据 adapter（不执行代码、不联网、写盘需用户批准）', () => {
    expect(ERATW_GAME_ADAPTER.capability).toEqual({
      executesCode: false,
      fileAccess: 'read-project',
      networkAccess: 'none',
      writablePaths: 'user-approved',
      integrity: 'none',
    });
  });

  it('sourceMap：行级、事件头与模板/池/原生/随机槽全映射', () => {
    expect(ERATW_GAME_ADAPTER.sourceMap.granularity).toBe('line');
    expect(ERATW_GAME_ADAPTER.sourceMap.mapsEventHeader).toBe(true);
    expect(ERATW_GAME_ADAPTER.sourceMap.mapsTemplateExpansion).toBe(true);
    expect(ERATW_GAME_ADAPTER.sourceMap.mapsPoolExpansion).toBe(true);
    expect(ERATW_GAME_ADAPTER.sourceMap.mapsNativeLines).toBe(true);
    expect(ERATW_GAME_ADAPTER.sourceMap.mapsRandomSlots).toBe(true);
  });

  it('conformanceSuite：golden/differential/smoke/encoding 四面都有产物声明', () => {
    expect(ERATW_GAME_ADAPTER.conformanceSuite.required).toEqual([
      'golden',
      'differential',
      'smoke',
      'encoding',
    ]);
    const kinds = ERATW_GAME_ADAPTER.conformanceSuite.cases.map((item) => item.kind);
    for (const kind of ERATW_GAME_ADAPTER.conformanceSuite.required) expect(kinds).toContain(kind);
  });

  it('diagnosticNamespace：专属码全部落在已声明的命名空间里', () => {
    const namespaces = new Set(ERATW_GAME_ADAPTER.diagnosticNamespace.namespaces);
    for (const code of ERATW_GAME_ADAPTER.diagnosticNamespace.codes) {
      const prefix = code.split('/', 1)[0];
      expect(namespaces.has(prefix as never)).toBe(true);
    }
  });
});
