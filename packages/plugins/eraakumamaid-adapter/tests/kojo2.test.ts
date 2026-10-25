import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERAAKUMAMAID_CAPABILITY,
  ERAAKUMAMAID_CONFORMANCE_SUITE,
  ERAAKUMAMAID_DOMAIN_SYMBOLS,
  ERAAKUMAMAID_ENCODING_POLICY,
  ERAAKUMAMAID_EVENT_CATALOG,
  ERAAKUMAMAID_EVENT_NAMES,
  ERAAKUMAMAID_GAME_ADAPTER,
  ERAAKUMAMAID_GAME_FINGERPRINT,
  ERAAKUMAMAID_LAYER_POLICY,
  ERAAKUMAMAID_PRESENTATION,
  ERAAKUMAMAID_PROFILE,
  ERAAKUMAMAID_PROGRAM_FEATURES,
  ERAAKUMAMAID_SOURCE_MAP,
  ERAAKUMAMAID_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERAAKUMA_MAID } from '../src/constants';
import { ERAAKUMAMAID_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * eraAkumaMaid 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * **无真盘 · 证据等级 B**：本文件**不设真盘段、不读环境变量、不做文件 IO**；
 * 只钉契约自洽与 v1 源码裁决出来的静态事实（事件三条 / 三代词 / 八属性 /
 * 三存储期 / 编码 CRLF / 层策略 shared-hook / 着色面声明 / 其余演出面 null）。
 */

describe('eraAkumaMaid 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERAAKUMAMAID_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERAAKUMAMAID_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns[0])).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_DOMAIN_SYMBOLS.attributes[0])).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_DOMAIN_SYMBOLS.nameFunctions)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_PROFILE.features)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_PRESENTATION.color)).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_CONFORMANCE_SUITE.cases[0])).toBe(true);
    expect(Object.isFrozen(ERAAKUMAMAID_GAME_FINGERPRINT.entries[0])).toBe(true);
    expect(freezeAdapter(ERAAKUMAMAID_GAME_ADAPTER)).toBe(ERAAKUMAMAID_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERAAKUMAMAID_GAME_ADAPTER.id).toBe('eraakumamaid');
    expect(ERAAKUMAMAID_GAME_ADAPTER.id).toBe(ERAAKUMA_MAID.gameId);
    expect(ERAAKUMAMAID_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERAAKUMAMAID_GAME_ADAPTER);
  });

  it('指纹四段齐、固定序、digest 非空', () => {
    expect(ERAAKUMAMAID_GAME_FINGERPRINT.digest).toBe('eraakumamaid-emuera1824-v18-ja');
    expect(ERAAKUMAMAID_GAME_FINGERPRINT.entries.map((entry) => entry.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERAAKUMAMAID_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eraAkumaMaid 2.0 adapter：事件目录（三条，其余未声明即降级）', () => {
  it('三条事件与中文名固定序、defaultEvent = null', () => {
    expect(ERAAKUMAMAID_EVENT_NAMES).toEqual(['训练', '指令', '训练结束']);
    expect(ERAAKUMAMAID_EVENT_CATALOG.events).toHaveLength(3);
    expect(ERAAKUMAMAID_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎映射：EVENTTRAIN / EVENTCOM / EVENTEND（同序）', () => {
    expect(ERAAKUMAMAID_EVENT_CATALOG.events.map((spec) => spec.engine)).toEqual([
      'EVENTTRAIN',
      'EVENTCOM',
      'EVENTEND',
    ]);
  });

  it('六条未声明事件确实不在目录里（初见/读档/商店/购买/回合末/指令结束）', () => {
    for (const name of ['初见', '读档', '商店', '购买', '回合末', '指令结束']) {
      expect(ERAAKUMAMAID_EVENT_NAMES).not.toContain(name);
    }
    const engines = ERAAKUMAMAID_EVENT_CATALOG.events.map((spec) => spec.engine);
    for (const engine of [
      'EVENTFIRST',
      'EVENTLOAD',
      'EVENTSHOP',
      'EVENTBUY',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]) {
      expect(engines).not.toContain(engine);
    }
  });

  it('只有指令带一枚可选 int 编号；其余 args 为空', () => {
    const com = ERAAKUMAMAID_EVENT_CATALOG.events.find((spec) => spec.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERAAKUMAMAID_EVENT_CATALOG.events) {
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });

  it('forced 只给训练结束（引擎保证触发）', () => {
    const forced = ERAAKUMAMAID_EVENT_CATALOG.events
      .filter((spec) => spec.forced)
      .map((spec) => spec.engine);
    expect(forced).toEqual(['EVENTEND']);
  });

  it('公共形状：引擎分发 + Emuera 桶优先级 + 无守卫 + 可监听', () => {
    for (const spec of ERAAKUMAMAID_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.guard).toBeNull();
      expect(spec.weavable).toBe(true);
    }
  });
});

describe('eraAkumaMaid 2.0 adapter：域符号', () => {
  it('代词三轴：我（视绑定）/ 你 / 她（不绑视点）', () => {
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual([
      '我',
      '你',
      '她',
    ]);
  });

  it('我 = %CNAME("一人称")%、family=CNAME、requiresView + viewBound', () => {
    const me = ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    expect(me.engineRef).toBe('%CNAME("一人称")%');
    expect(me.family).toBe('CNAME');
    expect(me.requiresView).toBe(true);
    expect(me.viewBound).toBe(true);
  });

  it('你 = %CALLNAME:MASTER%（不依赖视点）', () => {
    const you = ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    expect(you.engineRef).toBe('%CALLNAME:MASTER%');
    expect(you.family).toBe('CALLNAME');
    expect(you.requiresView).toBe(false);
    expect(you.viewBound).toBe(false);
  });

  it('她 = %CALLNAME:TARGET%（要视点、不绑视点）', () => {
    const her = ERAAKUMAMAID_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    expect(her.family).toBe('CALLNAME');
    expect(her.requiresView).toBe(true);
    expect(her.viewBound).toBe(false);
  });

  it('八条属性：名字 / 族 / 编号固定（不掺 name-glossary 的其余 45 条）', () => {
    expect(
      ERAAKUMAMAID_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index]),
    ).toEqual([
      ['好感度', 'CFLAG', 2],
      ['恋慕', 'TALENT', 150],
      ['処女', 'TALENT', 20],
      ['淫紋', 'MARK', 8],
      ['恥じらい', 'TALENT', 84],
      ['避妊の護符', 'TALENT', 209],
      ['ふたなり', 'TALENT', 1],
      ['マゾっ気', 'ABL', 20],
    ]);
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.attributes).toHaveLength(8);
  });

  it('八条属性全部 int 且可写（口上域直写实证；v1 无只读属性）', () => {
    for (const attribute of ERAAKUMAMAID_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
      expect(attribute.description.length).toBeGreaterThan(0);
    }
  });

  it('名字函数空表（library-table 是基础库助手，不是名字函数）', () => {
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('variables 整个省略（无真盘计数 ⇒ 宁缺）', () => {
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.variables).toBeUndefined();
  });

  it('说话人是项目级名表：CSV/CHARA 的 名前 行；未知符号 error', () => {
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV/CHARA',
      key: '名前',
    });
    expect(ERAAKUMAMAID_DOMAIN_SYMBOLS.unknown).toBe('error');
  });
});

describe('eraAkumaMaid 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile 六值：author / author / wait / D / selectcase / printdata', () => {
    expect(ERAAKUMAMAID_PROFILE.narrationColor).toBe('author');
    expect(ERAAKUMAMAID_PROFILE.dialogueColor).toBe('author');
    expect(ERAAKUMAMAID_PROFILE.waitDefault).toBe('wait');
    expect(ERAAKUMAMAID_PROFILE.colorMode).toBe('D');
    expect(ERAAKUMAMAID_PROFILE.poolStyle).toBe('selectcase');
    expect(ERAAKUMAMAID_PROFILE.randStyle).toBe('printdata');
  });

  it('features 六项与 programFeatures 一致（无 recursion / foreach）', () => {
    expect(ERAAKUMAMAID_PROFILE.features).toEqual([
      'program',
      'functions',
      'loops',
      'arrays',
      'goto',
      'repeat',
    ]);
    const enabled = Object.entries(ERAAKUMAMAID_PROGRAM_FEATURES)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .sort();
    expect(enabled).toEqual(['arrays', 'goto', 'repeat', 'while']);
    expect(ERAAKUMAMAID_PROFILE.features).not.toContain('recursion');
    expect(ERAAKUMAMAID_PROFILE.features).not.toContain('foreach');
  });

  it('programFeatures 六键：recursion / foreach 关（无实证，fail-visible）', () => {
    expect(ERAAKUMAMAID_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：心形 / 颜绘 / 选项 null（无落点）', () => {
    expect(ERAAKUMAMAID_PRESENTATION.heart).toBeNull();
    expect(ERAAKUMAMAID_PRESENTATION.face).toBeNull();
    expect(ERAAKUMAMAID_PRESENTATION.options).toBeNull();
    expect(ERAAKUMAMAID_PRESENTATION.faceTemplates).toBeUndefined();
    expect(ERAAKUMAMAID_PRESENTATION.hintNames).toBeUndefined();
  });

  it('着色面：SETCOLOR / RESETCOLOR / 0x', () => {
    expect(ERAAKUMAMAID_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
  });

  it('存储期三族齐备：scene / save / session（固定序）', () => {
    expect(ERAAKUMAMAID_STORAGE_CLASSES.classes.map((spec) => spec.period)).toEqual([
      'scene',
      'save',
      'session',
    ]);
    const byPeriod = new Map(
      ERAAKUMAMAID_STORAGE_CLASSES.classes.map((spec) => [spec.period, spec]),
    );
    expect(byPeriod.get('scene')!.engine).toBe('LOCAL');
    expect(byPeriod.get('scene')!.init).toBe('on-entry');
    expect(byPeriod.get('scene')!.persisted).toBe(false);
    expect(byPeriod.get('save')!.engine).toBe('SAVEDATA');
    expect(byPeriod.get('save')!.init).toBe('on-new-game');
    expect(byPeriod.get('save')!.persisted).toBe(true);
    expect(byPeriod.get('session')!.engine).toBe('TCVAR');
    expect(byPeriod.get('session')!.init).toBe('on-process-start');
    expect(byPeriod.get('session')!.persisted).toBe(false);
  });

  it('槽位前缀按作隔离 + 槽稳定 project-stable', () => {
    const prefixes: Record<string, string> = {
      scene: '__kojo_akumamaid_scene_',
      save: '__kojo_akumamaid_save_',
      session: '__kojo_akumamaid_session_',
    };
    for (const spec of ERAAKUMAMAID_STORAGE_CLASSES.classes) {
      expect(spec.slotPrefix).toBe(prefixes[spec.period]);
      expect(spec.description.length).toBeGreaterThan(0);
    }
    expect(ERAAKUMAMAID_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERAAKUMAMAID_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eraAkumaMaid 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + crlf + 保留 BOM + 不归一化', () => {
    expect(ERAAKUMAMAID_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERAAKUMAMAID_ENCODING_POLICY.allowedEncodings).toEqual(['utf-8-bom', 'utf-8']);
    expect(ERAAKUMAMAID_ENCODING_POLICY.eol).toBe('crlf');
    expect(ERAAKUMAMAID_ENCODING_POLICY.preserveBom).toBe(true);
    expect(ERAAKUMAMAID_ENCODING_POLICY.normalizeOnSave).toBe(false);
    expect(ERAAKUMAMAID_ENCODING_POLICY.fingerprintMismatch).toBe('error');
  });

  it('层策略：事件钩子共享（每角色重复定义 + SIF 守卫），函数 / overlay 唯一', () => {
    expect(ERAAKUMAMAID_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERAAKUMAMAID_LAYER_POLICY.rules.map((rule) => [rule.target, rule.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：四命名空间 + codes 空（最小数据面零专属码）', () => {
    expect(ERAAKUMAMAID_GAME_ADAPTER.diagnosticNamespace.namespaces).toEqual([
      'unit',
      'event',
      'symbol',
      'text',
    ]);
    expect(ERAAKUMAMAID_GAME_ADAPTER.diagnosticNamespace.codes).toEqual([]);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网 / 写盘需用户批准）', () => {
    expect(ERAAKUMAMAID_CAPABILITY).toEqual({
      executesCode: false,
      fileAccess: 'read-project',
      networkAccess: 'none',
      writablePaths: 'user-approved',
      integrity: 'none',
    });
  });

  it('source map：行级 + 事件头开；四个展开面未开（无 backend）', () => {
    expect(ERAAKUMAMAID_SOURCE_MAP).toEqual({
      granularity: 'line',
      mapsEventHeader: true,
      mapsTemplateExpansion: false,
      mapsPoolExpansion: false,
      mapsNativeLines: false,
      mapsRandomSlots: false,
    });
  });

  it('一致性套件：四面 required + 四个符号引用（夹具随 backend 批）', () => {
    expect([...ERAAKUMAMAID_CONFORMANCE_SUITE.required].sort()).toEqual([
      'differential',
      'encoding',
      'golden',
      'smoke',
    ]);
    expect(ERAAKUMAMAID_CONFORMANCE_SUITE.cases.map((item) => item.kind)).toEqual([
      'golden',
      'differential',
      'smoke',
      'encoding',
    ]);
    expect(ERAAKUMAMAID_CONFORMANCE_SUITE.cases.map((item) => item.fixture)).toEqual([
      'kojo2/golden/eraakumamaid-erb-shell',
      'kojo2/differential/eraakumamaid-erb-shell',
      'kojo2/smoke/eraakumamaid-project',
      'kojo2/encoding/eraakumamaid-utf8-bom-crlf',
    ]);
  });
});
