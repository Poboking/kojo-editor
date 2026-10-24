/**
 * eraFL 2.0 adapter 数据测试（入口 B）。
 *
 * 两类断言：
 * 1) **契约自洽**：`ERAFL_GAME_ADAPTER` 过 `validateGameAdapter` 全绿、深冻结；
 * 2) **不照抄 eraTW**：事件目录只有真盘存在的 4 条（另 5 条被 `@FL_*` / `@QST_*`
 *    流程函数取代 ⇒ 报 `event/unknown`）、属性编号是 eraFL CSV 自己的槽
 *    （不是 eraTW 的 TALENT:3/7/184）、代词落点追回 v1 interpolate 记号表、
 *    编码是 UTF-8 BOM + CRLF（不是 eraTW 的 UTF-16LE）。
 *
 * 期望值侧的判据全部来自 2026-10-24 真盘复测（D:/Game/erafl）或本树单一真源，
 * 逐条写在对应 it 的注释里。
 */
import { describe, expect, it } from 'vitest';
import {
  checkEvent,
  checkPresentation,
  checkProgramFeature,
  checkSpeaker,
  checkStoragePeriod,
  checkSymbol,
  eventNames,
  validateGameAdapter,
} from '@kojo/kojo-core';
import {
  ERAFL_ABSENT_EVENTS,
  ERAFL_DOMAIN_SYMBOLS,
  ERAFL_EVENT_CATALOG,
  ERAFL_EVENT_NAMES,
  ERAFL_FOREACH_DECLARATIONS,
  ERAFL_GAME_ADAPTER,
  ERAFL_GAME_FINGERPRINT,
  ERAFL_PRESENTATION,
  ERAFL_PROFILE,
  ERAFL_PROGRAM_FEATURES,
  ERAFL_STORAGE_CLASSES,
} from '../../src/kojo2/index.js';

describe('eraFL adapter：契约自检', () => {
  it('validateGameAdapter 全绿（零诊断）', () => {
    expect(validateGameAdapter(ERAFL_GAME_ADAPTER)).toEqual([]);
  });

  it('深冻结：根与各能力面都不可写', () => {
    expect(Object.isFrozen(ERAFL_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERAFL_GAME_ADAPTER.eventCatalog.events)).toBe(true);
    expect(Object.isFrozen(ERAFL_GAME_ADAPTER.eventCatalog.events[0])).toBe(true);
    expect(Object.isFrozen(ERAFL_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERAFL_STORAGE_CLASSES.classes)).toBe(true);
  });

  it('标识与指纹：id/version 稳定，指纹四段齐全', () => {
    expect(ERAFL_GAME_ADAPTER.id).toBe('erafl'); // = v1 ERAFL.gameId（constants.ts:14）
    expect(ERAFL_GAME_ADAPTER.version).toBe('2.0.0');
    expect(ERAFL_GAME_FINGERPRINT.digest.length).toBeGreaterThan(0);
    expect(ERAFL_GAME_FINGERPRINT.entries.map((entry) => entry.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
  });
});

describe('eraFL adapter：事件目录（真盘只有 4 个引擎事件）', () => {
  it('恰好四条，源端名与引擎事件逐条对齐（NEWGAME:76 / SAVELOAD:441 / SHOP:6 / SHOP:113）', () => {
    expect(ERAFL_EVENT_CATALOG.events).toHaveLength(4);
    expect(ERAFL_EVENT_NAMES).toEqual(['初见', '读档', '商店', '购买']);
    expect(eventNames(ERAFL_GAME_ADAPTER)).toEqual(['初见', '读档', '商店', '购买']);
    const engines = ERAFL_EVENT_CATALOG.events.map((spec) => spec.engine);
    expect(engines).toEqual(['EVENTFIRST', 'EVENTLOAD', 'EVENTSHOP', 'EVENTBUY']);
  });

  it('全部走 engine-dispatch + emuera-buckets，且都可 @织 监听（树内零 CALL 站点佐证）', () => {
    for (const spec of ERAFL_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      expect(spec.args).toEqual([]);
    }
  });

  it('强制事件只有初见（eraFL 没有 EVENTEND/EVENTTURNEND 引擎事件，标 forced 是撒谎）', () => {
    const forced = ERAFL_EVENT_CATALOG.events.filter((spec) => spec.forced).map((spec) => spec.event);
    expect(forced).toEqual(['初见']);
  });

  it('eraTW 有而 eraFL 没有的 5 个引擎事件：写出来一律报 event/unknown', () => {
    // 这 5 个在 eraFL 真盘无定义（被 @FL_* / @QST_* 流程函数取代）——正是"不能照抄
    // 九事件"的落点：声明了它们，补全就会给出作者根本挂不上的候选。
    expect(ERAFL_ABSENT_EVENTS).toEqual([
      'EVENTTRAIN',
      'EVENTCOM',
      'EVENTEND',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]);
    for (const engine of ERAFL_ABSENT_EVENTS) {
      const diagnostic = checkEvent(ERAFL_GAME_ADAPTER, engine);
      expect(diagnostic?.code).toBe('event/unknown');
      expect(diagnostic?.message).toContain('初见');
    }
  });
});

describe('eraFL adapter：域符号', () => {
  it('三个代词齐全，落点追回 v1 interpolate 记号表（%CNAME% / %CALLNAME:MASTER% / %CALLNAME:<角色号>）', () => {
    const byRole = new Map(ERAFL_DOMAIN_SYMBOLS.pronouns.map((item) => [item.role, item]));
    expect(byRole.get('me')?.pronoun).toBe('我');
    expect(byRole.get('you')?.pronoun).toBe('你');
    expect(byRole.get('her')?.pronoun).toBe('她');
    expect(byRole.get('me')?.engineRef).toBe('%CNAME%');
    expect(byRole.get('you')?.engineRef).toBe('%CALLNAME:MASTER%');
    expect(byRole.get('her')?.engineRef).toBe('%CALLNAME:<角色号>');
    // eraFL 没有 # 视（视点是 XML 文件级事实）⇒ 三个代词都不要求视点声明
    for (const item of ERAFL_DOMAIN_SYMBOLS.pronouns) {
      expect(item.requiresView).toBe(false);
      expect(item.viewBound).toBe(false);
    }
  });

  it('角色属性编号是 eraFL CSV 自己的槽（CFLAG.CSV:2 / Talent.csv:101,103,104）——不是 eraTW 的 3/7/184', () => {
    const attributes = new Map(ERAFL_DOMAIN_SYMBOLS.attributes.map((item) => [item.name, item]));
    expect([...attributes.keys()]).toEqual(['好感度', '恋慕', '親愛', '恋人']);
    expect(attributes.get('好感度')).toMatchObject({ family: 'CFLAG', index: 2, readonly: false });
    expect(attributes.get('恋慕')).toMatchObject({ family: 'TALENT', index: 150, readonly: true });
    expect(attributes.get('親愛')).toMatchObject({ family: 'TALENT', index: 152, readonly: true });
    expect(attributes.get('恋人')).toMatchObject({ family: 'TALENT', index: 153, readonly: true });
    // eraFL Talent.csv 没有愛欲（实测 grep 空）⇒ 不收第四条爱欲，收戀慕上位親愛
    expect(attributes.has('爱欲')).toBe(false);
  });

  it('名字函数暂空（library-table 是入口 C 的活，没有真源就不派生）', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('说话人是开放名表（project / CSV/Chara / 呼び名），SDK 层不猜', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.speakers).toEqual({ kind: 'project', table: 'CSV/Chara', key: '呼び名' });
    expect(checkSpeaker(ERAFL_GAME_ADAPTER, '任意角色名')).toBeNull();
  });

  it('用户源码侧：已声明属性可解析，未知符号仍报错', () => {
    expect(checkSymbol(ERAFL_GAME_ADAPTER, '好感度')).toBeNull();
    expect(checkSymbol(ERAFL_GAME_ADAPTER, '不存在的属性')?.code).toBe('core/expr/unknown-symbol');
  });
});

describe('eraFL adapter：profile / 程序层', () => {
  it('profile：作者色 / 等待 / D 系 / IF 池 / PRINTDATA 随机', () => {
    expect(ERAFL_PROFILE).toMatchObject({
      narrationColor: 'author',
      dialogueColor: 'author',
      waitDefault: 'wait',
      colorMode: 'D',
      poolStyle: 'if',
      randStyle: 'printdata',
    });
    expect(ERAFL_PROFILE.features).toContain('program');
    // 与 programFeatures 自洽：foreach 关 ⇒ features 不列
    expect(ERAFL_PROFILE.features).not.toContain('foreach');
  });

  it('programFeatures：五项开（数组 154 / WHILE 123 / GOTO 77 / CALLF+TRYCALLF 288 / REPEAT+REND 4+4），foreach 关', () => {
    expect(ERAFL_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: true,
      foreach: false,
      repeat: true,
    });
    // 关掉的那项在用户源码侧 fail-visible，而不是静默落成别的东西
    expect(checkProgramFeature(ERAFL_GAME_ADAPTER, 'foreach')?.code).toBe('core/control/unsupported');
    for (const feature of ['arrays', 'while', 'goto', 'recursion', 'repeat'] as const) {
      expect(checkProgramFeature(ERAFL_GAME_ADAPTER, feature)).toBeNull();
    }
  });

  it('存储期三项齐全，持久化口径正确', () => {
    expect(ERAFL_STORAGE_CLASSES.classes.map((spec) => spec.period)).toEqual(['scene', 'save', 'session']);
    expect(ERAFL_STORAGE_CLASSES.classes.map((spec) => spec.persisted)).toEqual([false, true, false]);
    for (const period of ['scene', 'save', 'session'] as const) {
      expect(checkStoragePeriod(ERAFL_GAME_ADAPTER, period)).toBeNull();
    }
  });

  it('`@巡` 不声明（null = 不支持；eraFL 无集合语料）', () => {
    expect(ERAFL_FOREACH_DECLARATIONS).toBeNull();
    expect(ERAFL_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eraFL adapter：演出面（eraFL 的演出在 XML 属性里，ERB 指令面四项全不声明）', () => {
  it('四项全 null ⇒ 用户源码侧逐个报"当前 adapter 不支持"（fail-visible，不借 eraTW 落点）', () => {
    expect(ERAFL_PRESENTATION).toEqual({ heart: null, color: null, face: null, options: null });
    expect(checkPresentation(ERAFL_GAME_ADAPTER, 'heart')?.code).toBe('core/feature/unsupported');
    expect(checkPresentation(ERAFL_GAME_ADAPTER, 'color')?.code).toBe('core/color/unsupported');
    expect(checkPresentation(ERAFL_GAME_ADAPTER, 'face')?.code).toBe('core/face/unsupported');
    expect(checkPresentation(ERAFL_GAME_ADAPTER, 'options')?.code).toBe('core/feature/unsupported');
  });
});

describe('eraFL adapter：非功能性面', () => {
  it('layerPolicy 三类定义面一律 unique', () => {
    expect(ERAFL_GAME_ADAPTER.layerPolicy.defaultMode).toBe('unique');
    expect(ERAFL_GAME_ADAPTER.layerPolicy.rules.map((rule) => rule.target)).toEqual([
      'function',
      'event-hook',
      'kojo-overlay',
    ]);
    for (const rule of ERAFL_GAME_ADAPTER.layerPolicy.rules) expect(rule.mode).toBe('unique');
  });

  it('编码：UTF-8 BOM 缺省 + CRLF，UTF-16LE 仍允许读（真盘 9 份 XML），保存不归一化', () => {
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.defaultEncoding).toBe('utf-8-bom');
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.allowedEncodings).toContain('utf-16le-bom');
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.allowedEncodings).toContain('utf-8');
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.eol).toBe('crlf');
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.preserveBom).toBe(true);
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.normalizeOnSave).toBe(false);
    expect(ERAFL_GAME_ADAPTER.encodingPolicy.fingerprintMismatch).toBe('error');
  });

  it('capability：纯数据 adapter（不执行代码、不联网、写盘需用户批准）', () => {
    expect(ERAFL_GAME_ADAPTER.capability).toEqual({
      executesCode: false,
      fileAccess: 'read-project',
      networkAccess: 'none',
      writablePaths: 'user-approved',
      integrity: 'none',
    });
  });

  it('sourceMap：行级 + 事件头映射（注册壳是包装函数）；模板/池/原生/随机槽不映射（无此类构造）', () => {
    expect(ERAFL_GAME_ADAPTER.sourceMap.granularity).toBe('line');
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsEventHeader).toBe(true);
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsTemplateExpansion).toBe(false);
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsPoolExpansion).toBe(false);
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsNativeLines).toBe(false);
    expect(ERAFL_GAME_ADAPTER.sourceMap.mapsRandomSlots).toBe(false);
  });

  it('conformanceSuite：golden/differential/smoke/encoding 四面都有产物声明', () => {
    expect(ERAFL_GAME_ADAPTER.conformanceSuite.required).toEqual([
      'golden',
      'differential',
      'smoke',
      'encoding',
    ]);
    const kinds = ERAFL_GAME_ADAPTER.conformanceSuite.cases.map((item) => item.kind);
    for (const kind of ERAFL_GAME_ADAPTER.conformanceSuite.required) expect(kinds).toContain(kind);
  });

  it('diagnosticNamespace：专属码全部落在已声明的命名空间里', () => {
    const namespaces = new Set(ERAFL_GAME_ADAPTER.diagnosticNamespace.namespaces);
    expect(namespaces.size).toBeGreaterThan(0);
    for (const code of ERAFL_GAME_ADAPTER.diagnosticNamespace.codes) {
      const prefix = code.split('/', 1)[0];
      expect(namespaces.has(prefix as never)).toBe(true);
    }
    // 现在只声明 event 面两码（作者写未声明的 5 个引擎事件时必然出现）；
    // symbol/text 面的码等入口 C / 入口 E 落地，不预埋。
    expect([...ERAFL_GAME_ADAPTER.diagnosticNamespace.codes]).toEqual(['event/unknown', 'event/argument']);
  });
});
