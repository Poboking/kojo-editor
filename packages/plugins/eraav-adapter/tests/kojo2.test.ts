import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERAAV_CAPABILITY,
  ERAAV_CONFORMANCE_SUITE,
  ERAAV_DIAGNOSTIC_NAMESPACE,
  ERAAV_DOMAIN_SYMBOLS,
  ERAAV_ENCODING_POLICY,
  ERAAV_EVENT_CATALOG,
  ERAAV_EVENT_NAMES,
  ERAAV_GAME_ADAPTER,
  ERAAV_GAME_FINGERPRINT,
  ERAAV_LAYER_POLICY,
  ERAAV_PRESENTATION,
  ERAAV_PROFILE,
  ERAAV_PROGRAM_FEATURES,
  ERAAV_SOURCE_MAP,
  ERAAV_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERAAV } from '../src/constants';
import { ERAAV_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * eraAV 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * 三层：
 * ① 契约自洽：`validateGameAdapter` 零诊断、深冻结、根导出同实例；
 * ② 逐字段事实：八事件（无 EVENTLOAD）/ 三代词 / 三属性 / 三存储期 / 编码 CRLF 主流；
 * ③ 真盘对拍（`KOJO_ERAAV_DIR`，缺省 `C:/game/eraAV`，不在就 skip）：
 *    文件:行 级复核事件定义、CSV 编号、BOM/EOL、Chara 数量。
 */

const ERAAV_ROOT = process.env.KOJO_ERAAV_DIR ?? 'C:/game/eraAV';
const hasRealDisk = (): boolean => existsSync(ERAAV_ROOT);

describe('eraAV 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERAAV_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERAAV_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERAAV_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERAAV_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERAAV_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERAAV_DOMAIN_SYMBOLS.attributes[0])).toBe(true);
    expect(Object.isFrozen(ERAAV_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(freezeAdapter(ERAAV_GAME_ADAPTER)).toBe(ERAAV_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERAAV_GAME_ADAPTER.id).toBe('eraav');
    expect(ERAAV_GAME_ADAPTER.id).toBe(ERAAV.gameId);
    expect(ERAAV_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERAAV_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERAAV_GAME_FINGERPRINT.digest).toBe('eraav-emuera1824-zh');
    expect(ERAAV_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERAAV_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eraAV 2.0 adapter：事件目录（八事件，EVENTLOAD 全盘 0 处不声明）', () => {
  it('八条事件与中文名固定序', () => {
    expect(ERAAV_EVENT_NAMES).toEqual([
      '初见',
      '训练',
      '商店',
      '购买',
      '指令',
      '训练结束',
      '回合末',
      '指令结束',
    ]);
    expect(ERAAV_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎落点 = 八事件，EVENTLOAD 缺席', () => {
    expect(ERAAV_EVENT_CATALOG.events.map((e) => e.engine)).toEqual([
      'EVENTFIRST',
      'EVENTTRAIN',
      'EVENTSHOP',
      'EVENTBUY',
      'EVENTCOM',
      'EVENTEND',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]);
    expect(ERAAV_EVENT_CATALOG.events.some((e) => e.engine === 'EVENTLOAD')).toBe(false);
  });

  it('forced 只给初见 / 训练结束 / 回合末（引擎保证触发）', () => {
    const forced = ERAAV_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST', 'EVENTEND', 'EVENTTURNEND']);
  });

  it('只有指令带可选 int 编号；其余 args 为空', () => {
    const com = ERAAV_EVENT_CATALOG.events.find((e) => e.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERAAV_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });
});

describe('eraAV 2.0 adapter：域符号', () => {
  it('代词三轴：我=TARGET（视绑定）、你=MASTER、她=TARGET（不绑视点）', () => {
    expect(ERAAV_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERAAV_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERAAV_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERAAV_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(me.engineRef).toBe('%CALLNAME:TARGET%');
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('%CALLNAME:MASTER%');
    expect(you.viewBound).toBe(false);
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    for (const pronoun of ERAAV_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('CALLNAME');
    }
  });

  it('三条属性：编号与 Talent 简体名表一致（处女=0，与 eraTW 的 1 不同）、全部可写', () => {
    expect(ERAAV_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index])).toEqual([
      ['爱慕', 'TALENT', 85],
      ['处女', 'TALENT', 0],
      ['崩坏', 'TALENT', 9],
    ]);
    for (const attribute of ERAAV_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（本包无可派生的 library-table，不借 eraTW 的词）', () => {
    expect(ERAAV_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：ARG/RESULT/TIME/MONEY/RESULTS 全 int 可写', () => {
    expect(ERAAV_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERAAV_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV/Chara 的 名前 行', () => {
    expect(ERAAV_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV/Chara',
      key: '名前',
    });
  });
});

describe('eraAV 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：默认色（口上域 SETCOLOR 0）+ W 等待 + plain + if 池 + rand-selectcase', () => {
    expect(ERAAV_PROFILE.narrationColor).toBe('default');
    expect(ERAAV_PROFILE.dialogueColor).toBe('default');
    expect(ERAAV_PROFILE.waitDefault).toBe('wait');
    expect(ERAAV_PROFILE.colorMode).toBe('plain');
    expect(ERAAV_PROFILE.poolStyle).toBe('if');
    expect(ERAAV_PROFILE.randStyle).toBe('rand-selectcase');
  });

  it('features 与 programFeatures 一致（细粒度开就必须列 program）', () => {
    expect(ERAAV_PROFILE.features).toEqual(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']);
    expect(ERAAV_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：color 与 options 有落点；heart / face 不声明', () => {
    expect(ERAAV_PRESENTATION.heart).toBeNull();
    expect(ERAAV_PRESENTATION.face).toBeNull();
    expect(ERAAV_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
    expect(ERAAV_PRESENTATION.options?.status).toBe('pending');
    expect(ERAAV_PRESENTATION.options?.result).toBe('RESULTS');
  });

  it('存储期三族：scene/save/session，前缀按作隔离（save 本作零实证照实写）', () => {
    expect(ERAAV_STORAGE_CLASSES.classes.map((c) => c.engine)).toEqual([
      'LOCAL',
      'SAVEDATA',
      'TCVAR',
    ]);
    expect(ERAAV_STORAGE_CLASSES.classes.map((c) => c.slotPrefix)).toEqual([
      '__kojo_eraav_scene_',
      '__kojo_eraav_save_',
      '__kojo_eraav_session_',
    ]);
    expect(ERAAV_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERAAV_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eraAV 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + crlf + 保留 BOM + 不归一化', () => {
    expect(ERAAV_ENCODING_POLICY).toEqual({
      defaultEncoding: 'utf-8-bom',
      allowedEncodings: ['utf-8-bom', 'utf-8'],
      eol: 'crlf',
      preserveBom: true,
      normalizeOnSave: false,
      fingerprintMismatch: 'error',
    });
  });

  it('层策略：事件钩子共享（口上域 #PRI 成对写法），函数 / overlay 唯一', () => {
    expect(ERAAV_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERAAV_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码）', () => {
    expect(ERAAV_DIAGNOSTIC_NAMESPACE.codes).toEqual([]);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERAAV_CAPABILITY).toEqual({
      executesCode: false,
      fileAccess: 'read-project',
      networkAccess: 'none',
      writablePaths: 'user-approved',
      integrity: 'none',
    });
  });

  it('source map：行级 + 事件头映射开；展开四项未开（无 backend）', () => {
    expect(ERAAV_SOURCE_MAP).toEqual({
      granularity: 'line',
      mapsEventHeader: true,
      mapsTemplateExpansion: false,
      mapsPoolExpansion: false,
      mapsNativeLines: false,
      mapsRandomSlots: false,
    });
  });

  it('一致性套件：四面 required + 四个符号引用', () => {
    expect(ERAAV_CONFORMANCE_SUITE.required).toEqual(['golden', 'differential', 'smoke', 'encoding']);
    expect(ERAAV_CONFORMANCE_SUITE.cases.map((c) => c.kind)).toEqual([
      'golden',
      'differential',
      'smoke',
      'encoding',
    ]);
    for (const c of ERAAV_CONFORMANCE_SUITE.cases) {
      expect(c.fixture.startsWith('kojo2/')).toBe(true);
    }
  });
});

/* ------------------------------ 真盘对拍（skipIf 守卫） ------------------------------ */

describe.skipIf(!hasRealDisk())('eraAV 2.0 adapter：真盘对拍（KOJO_ERAAV_DIR 不在则跳过）', () => {
  const walk = (root: string, out: string[], re: RegExp): string[] => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = nodeJoin(root, entry.name);
      if (entry.isDirectory()) walk(full, out, re);
      else if (re.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('事件定义文件:行 级复核（八个在、EVENTLOAD 全盘 0 处）', () => {
    const erbFiles = walk(nodeJoin(ERAAV_ROOT, 'ERB'), [], /\.erb$/i);
    const sites = new Map<string, string[]>();
    for (const file of erbFiles) {
      const rel = file.slice(ERAAV_ROOT.length + 1).replaceAll('\\', '/');
      readFileSync(file, 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const m = /^@EVENT(FIRST|TRAIN|LOAD|SHOP|BUY|COM|END|TURNEND|COMEND)\b/i.exec(line.trim());
          if (m) {
            const key = m[1]!.toUpperCase();
            (sites.get(key) ?? sites.set(key, []).get(key)!).push(`${rel}:${i + 1}`);
          }
        });
    }
    for (const engine of ERAAV_EVENT_CATALOG.events.map((e) => e.engine)) {
      const name = engine.slice('EVENT'.length);
      expect(sites.has(name), engine).toBe(true);
    }
    expect(sites.has('LOAD'), 'EVENTLOAD 全盘 0 处').toBe(false);
  });

  it('CSV：Talent 处女=0 / 爱慕=85（本作编号与 eraTW 不同）；无 CFLAG 表', () => {
    const talent = readFileSync(nodeJoin(ERAAV_ROOT, 'CSV/Talent.csv'), 'utf8');
    expect(/^0,处女/m.test(talent)).toBe(true);
    expect(/^85,爱慕/m.test(talent)).toBe(true);
    expect(existsSync(nodeJoin(ERAAV_ROOT, 'CSV/CFLAG.CSV'))).toBe(false);
  });

  it('编码：受管 ERB 全 CRLF，BOM 470/471（唯一无 BOM 是 EVENT_K22）', () => {
    const files = walk(nodeJoin(ERAAV_ROOT, 'ERB'), [], /\.(erb|erh)$/i);
    let bom = 0;
    let crlf = 0;
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom++;
      if (bytes.toString('utf8').includes('\r\n')) crlf++;
    }
    expect(files.length).toBe(471);
    expect(bom).toBe(470);
    expect(crlf).toBe(471);
  });

  it('角色 CSV：CSV/Chara 下 Chara*.csv = 120 份', () => {
    const files = readdirSync(nodeJoin(ERAAV_ROOT, 'CSV/Chara'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Chara.*\.csv$/i.test(entry.name));
    expect(files.length).toBe(120);
  });
});
