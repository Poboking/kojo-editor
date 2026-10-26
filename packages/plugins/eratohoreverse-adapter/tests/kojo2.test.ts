import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERATOHOREVERSE_CAPABILITY,
  ERATOHOREVERSE_CONFORMANCE_SUITE,
  ERATOHOREVERSE_DIAGNOSTIC_NAMESPACE,
  ERATOHOREVERSE_DOMAIN_SYMBOLS,
  ERATOHOREVERSE_ENCODING_POLICY,
  ERATOHOREVERSE_EVENT_CATALOG,
  ERATOHOREVERSE_EVENT_NAMES,
  ERATOHOREVERSE_GAME_ADAPTER,
  ERATOHOREVERSE_GAME_FINGERPRINT,
  ERATOHOREVERSE_LAYER_POLICY,
  ERATOHOREVERSE_PRESENTATION,
  ERATOHOREVERSE_PROFILE,
  ERATOHOREVERSE_PROGRAM_FEATURES,
  ERATOHOREVERSE_SOURCE_MAP,
  ERATOHOREVERSE_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERATOHOREVERSE } from '../src/constants';
import { ERATOHOREVERSE_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * eratohoReverse 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * 三层：
 * ① 契约自洽：`validateGameAdapter` 零诊断、深冻结、根导出同实例；
 * ② 逐字段事实：八事件（无 EVENTBUY）/ 三代词 / 六属性 / 三存储期 / 编码全 LF；
 * ③ 真盘对拍（`KOJO_ERATOHOREVERSE_DIR`，缺省 `C:/game/eratohoReverse`，不在就 skip）：
 *    文件:行 级复核事件定义与共享钩子、CSV 编号、BOM/EOL、Chara 数量。
 */

const EVRSE_ROOT = process.env.KOJO_ERATOHOREVERSE_DIR ?? 'C:/game/eratohoReverse';
const hasRealDisk = (): boolean => existsSync(EVRSE_ROOT);

describe('eratohoReverse 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERATOHOREVERSE_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERATOHOREVERSE_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERATOHOREVERSE_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERATOHOREVERSE_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERATOHOREVERSE_DOMAIN_SYMBOLS.attributes[0])).toBe(true);
    expect(Object.isFrozen(ERATOHOREVERSE_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(freezeAdapter(ERATOHOREVERSE_GAME_ADAPTER)).toBe(ERATOHOREVERSE_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERATOHOREVERSE_GAME_ADAPTER.id).toBe('eratohoreverse');
    expect(ERATOHOREVERSE_GAME_ADAPTER.id).toBe(ERATOHOREVERSE.gameId);
    expect(ERATOHOREVERSE_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERATOHOREVERSE_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERATOHOREVERSE_GAME_FINGERPRINT.digest).toBe('eratohoreverse-emuera1824-ja');
    expect(ERATOHOREVERSE_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERATOHOREVERSE_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eratohoReverse 2.0 adapter：事件目录（八事件，EVENTBUY 全盘 0 处不声明）', () => {
  it('八条事件与中文名固定序', () => {
    expect(ERATOHOREVERSE_EVENT_NAMES).toEqual([
      '初见',
      '训练',
      '读档',
      '商店',
      '指令',
      '训练结束',
      '回合末',
      '指令结束',
    ]);
    expect(ERATOHOREVERSE_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎落点 = 八事件，EVENTBUY 缺席', () => {
    expect(ERATOHOREVERSE_EVENT_CATALOG.events.map((e) => e.engine)).toEqual([
      'EVENTFIRST',
      'EVENTTRAIN',
      'EVENTLOAD',
      'EVENTSHOP',
      'EVENTCOM',
      'EVENTEND',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]);
    expect(ERATOHOREVERSE_EVENT_CATALOG.events.some((e) => e.engine === 'EVENTBUY')).toBe(false);
  });

  it('forced 只给初见 / 训练结束 / 回合末（引擎保证触发）', () => {
    const forced = ERATOHOREVERSE_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST', 'EVENTEND', 'EVENTTURNEND']);
  });

  it('只有指令带可选 int 编号；其余 args 为空', () => {
    const com = ERATOHOREVERSE_EVENT_CATALOG.events.find((e) => e.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERATOHOREVERSE_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });
});

describe('eratohoReverse 2.0 adapter：域符号', () => {
  it('代词三轴：我=TARGET（视绑定）、你=MASTER、她=TARGET（不绑视点）', () => {
    expect(ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(me.engineRef).toBe('%CALLNAME:TARGET%');
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('%CALLNAME:MASTER%');
    expect(you.viewBound).toBe(false);
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    for (const pronoun of ERATOHOREVERSE_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('CALLNAME');
    }
  });

  it('六条属性：编号与 Talent/Cflag 名表一致（合意在 CFLAG 不在 TALENT），全部可写', () => {
    expect(ERATOHOREVERSE_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index])).toEqual([
      ['处女', 'TALENT', 0],
      ['主人', 'TALENT', 131],
      ['调教回数', 'CFLAG', 200],
      ['M好感', 'CFLAG', 2],
      ['好感', 'CFLAG', 9],
      ['合意', 'CFLAG', 3],
    ]);
    for (const attribute of ERATOHOREVERSE_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（本包无可派生的 library-table，不借 eraTW 的词）', () => {
    expect(ERATOHOREVERSE_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：ARG/RESULT/TIME/MONEY/RESULTS 全 int 可写', () => {
    expect(ERATOHOREVERSE_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERATOHOREVERSE_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV/CHARA（目录全大写）的 名前 行', () => {
    expect(ERATOHOREVERSE_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV/CHARA',
      key: '名前',
    });
  });
});

describe('eratohoReverse 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：作者色（口上域 SETCOLOR 425）+ W 等待 + D 系 + if 池 + printdata 随机', () => {
    expect(ERATOHOREVERSE_PROFILE.narrationColor).toBe('author');
    expect(ERATOHOREVERSE_PROFILE.dialogueColor).toBe('author');
    expect(ERATOHOREVERSE_PROFILE.waitDefault).toBe('wait');
    expect(ERATOHOREVERSE_PROFILE.colorMode).toBe('D');
    expect(ERATOHOREVERSE_PROFILE.poolStyle).toBe('if');
    expect(ERATOHOREVERSE_PROFILE.randStyle).toBe('printdata');
  });

  it('features 与 programFeatures 一致（细粒度开就必须列 program）', () => {
    expect(ERATOHOREVERSE_PROFILE.features).toEqual(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']);
    expect(ERATOHOREVERSE_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：color 与 options 有落点；heart / face 不声明', () => {
    expect(ERATOHOREVERSE_PRESENTATION.heart).toBeNull();
    expect(ERATOHOREVERSE_PRESENTATION.face).toBeNull();
    expect(ERATOHOREVERSE_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
    expect(ERATOHOREVERSE_PRESENTATION.options?.status).toBe('pending');
    expect(ERATOHOREVERSE_PRESENTATION.options?.result).toBe('RESULTS');
  });

  it('存储期三族：scene/save/session，前缀按作隔离', () => {
    expect(ERATOHOREVERSE_STORAGE_CLASSES.classes.map((c) => c.engine)).toEqual([
      'LOCAL',
      'SAVEDATA',
      'TCVAR',
    ]);
    expect(ERATOHOREVERSE_STORAGE_CLASSES.classes.map((c) => c.slotPrefix)).toEqual([
      '__kojo_evrse_scene_',
      '__kojo_evrse_save_',
      '__kojo_evrse_session_',
    ]);
    expect(ERATOHOREVERSE_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERATOHOREVERSE_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eratohoReverse 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + **lf**（全树 100% 纯 LF，照抄 CRLF 会整文件改行尾）', () => {
    expect(ERATOHOREVERSE_ENCODING_POLICY).toEqual({
      defaultEncoding: 'utf-8-bom',
      allowedEncodings: ['utf-8-bom', 'utf-8'],
      eol: 'lf',
      preserveBom: true,
      normalizeOnSave: false,
      fingerprintMismatch: 'error',
    });
  });

  it('层策略：事件钩子共享（KCOLOR.ERB / COMMON_USEFUL.ERB 共享钩子），函数 / overlay 唯一', () => {
    expect(ERATOHOREVERSE_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERATOHOREVERSE_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码）', () => {
    expect(ERATOHOREVERSE_DIAGNOSTIC_NAMESPACE.codes).toEqual([]);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERATOHOREVERSE_CAPABILITY).toEqual({
      executesCode: false,
      fileAccess: 'read-project',
      networkAccess: 'none',
      writablePaths: 'user-approved',
      integrity: 'none',
    });
  });

  it('source map：行级 + 事件头映射开；展开四项未开（无 backend）', () => {
    expect(ERATOHOREVERSE_SOURCE_MAP).toEqual({
      granularity: 'line',
      mapsEventHeader: true,
      mapsTemplateExpansion: false,
      mapsPoolExpansion: false,
      mapsNativeLines: false,
      mapsRandomSlots: false,
    });
  });

  it('一致性套件：四面 required + 四个符号引用', () => {
    expect(ERATOHOREVERSE_CONFORMANCE_SUITE.required).toEqual(['golden', 'differential', 'smoke', 'encoding']);
    expect(ERATOHOREVERSE_CONFORMANCE_SUITE.cases.map((c) => c.kind)).toEqual([
      'golden',
      'differential',
      'smoke',
      'encoding',
    ]);
    for (const c of ERATOHOREVERSE_CONFORMANCE_SUITE.cases) {
      expect(c.fixture.startsWith('kojo2/')).toBe(true);
    }
  });
});

/* ------------------------------ 真盘对拍（skipIf 守卫） ------------------------------ */

describe.skipIf(!hasRealDisk())('eratohoReverse 2.0 adapter：真盘对拍（KOJO_ERATOHOREVERSE_DIR 不在则跳过）', () => {
  const walk = (root: string, out: string[], re: RegExp): string[] => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = nodeJoin(root, entry.name);
      if (entry.isDirectory()) walk(full, out, re);
      else if (re.test(entry.name)) out.push(full);
    }
    return out;
  };

  it('事件定义文件:行 级复核（八个在、EVENTBUY 全盘 0 处、共享钩子三处）', () => {
    const erbFiles = walk(nodeJoin(EVRSE_ROOT, 'ERB'), [], /\.erb$/i);
    const sites = new Map<string, string[]>();
    for (const file of erbFiles) {
      const rel = file.slice(EVRSE_ROOT.length + 1).replaceAll('\\', '/');
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
    for (const engine of ERATOHOREVERSE_EVENT_CATALOG.events.map((e) => e.engine)) {
      const name = engine.slice('EVENT'.length);
      expect(sites.has(name), engine).toBe(true);
    }
    expect(sites.has('BUY'), 'EVENTBUY 全盘 0 处').toBe(false);
    // 共享钩子：FIRST/LOAD 的第二处都落 KCOLOR.ERB
    expect(sites.get('FIRST')).toContain('ERB/FUNCTION/PROCESS/KOMEIJI_FUNCTIONS/KCOLOR.ERB:57');
    expect(sites.get('LOAD')).toContain('ERB/FUNCTION/PROCESS/KOMEIJI_FUNCTIONS/KCOLOR.ERB:62');
    expect(sites.get('FIRST')!.length).toBe(2);
    expect(sites.get('LOAD')!.length).toBe(2);
  });

  it('CSV：Talent 处女=0 / Cflag 调教回数=200 / 合意=3（本作编号与 eraTW 不同）', () => {
    const talent = readFileSync(nodeJoin(EVRSE_ROOT, 'CSV/Talent.csv'), 'utf8');
    expect(/^0,处女/m.test(talent)).toBe(true);
    expect(/^78,恋慕/m.test(talent)).toBe(true);
    const cflag = readFileSync(nodeJoin(EVRSE_ROOT, 'CSV/Cflag.csv'), 'utf8');
    expect(/^200,调教回数/m.test(cflag)).toBe(true);
    expect(/^3,合意/m.test(cflag)).toBe(true);
  });

  it('编码：受管 ERB/ERH 907 份 100% BOM + 100% 纯 LF（含 CR 的 0 份）', () => {
    const files = walk(nodeJoin(EVRSE_ROOT, 'ERB'), [], /\.(erb|erh)$/i);
    let bom = 0;
    let lf = 0;
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom++;
      const text = bytes.toString('utf8');
      if (text.includes('\r\n')) throw new Error(`发现 CRLF：${file}`);
      if (/(^|[^\r])\n/.test(text)) lf++;
    }
    expect(files.length).toBe(907);
    expect(bom).toBe(907);
    expect(lf).toBe(907);
  });

  it('角色 CSV：CSV/CHARA（全大写目录）下 Chara*.csv = 108 份', () => {
    const files = readdirSync(nodeJoin(EVRSE_ROOT, 'CSV/CHARA'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Chara.*\.csv$/i.test(entry.name));
    expect(files.length).toBe(108);
  });
});
