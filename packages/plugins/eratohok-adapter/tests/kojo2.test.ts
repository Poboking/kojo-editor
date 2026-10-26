import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERATOHOK_CAPABILITY,
  ERATOHOK_CONFORMANCE_SUITE,
  ERATOHOK_DOMAIN_SYMBOLS,
  ERATOHOK_ENCODING_POLICY,
  ERATOHOK_EVENT_CATALOG,
  ERATOHOK_EVENT_NAMES,
  ERATOHOK_GAME_ADAPTER,
  ERATOHOK_GAME_FINGERPRINT,
  ERATOHOK_LAYER_POLICY,
  ERATOHOK_PRESENTATION,
  ERATOHOK_PROFILE,
  ERATOHOK_PROGRAM_FEATURES,
  ERATOHOK_SOURCE_MAP,
  ERATOHOK_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERATOHOK } from '../src/constants';
import { ERATOHOK_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * eratohoK 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * 三层：
 * ① 契约自洽：`validateGameAdapter` 零诊断、深冻结、根导出同实例；
 * ② 逐字段事实：九事件 / 三代词 / 八属性 / 三存储期 / 编码 CRLF 主流；
 * ③ 真盘对拍（`KOJO_ERATOHOK_DIR`，缺省 `D:/Game/eratohok`，不在就 skip）：
 *    文件:行 级复核事件定义、共享钩子、CSV 编号、BOM/EOL、代词计数、Chara 数量。
 */

const ERATOHOK_ROOT = process.env.KOJO_ERATOHOK_DIR ?? 'D:/Game/eratohok';
const hasRealDisk = (): boolean => existsSync(ERATOHOK_ROOT);

describe('eratohoK 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERATOHOK_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERATOHOK_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERATOHOK_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERATOHOK_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERATOHOK_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERATOHOK_DOMAIN_SYMBOLS.attributes[0])).toBe(true);
    expect(Object.isFrozen(ERATOHOK_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(freezeAdapter(ERATOHOK_GAME_ADAPTER)).toBe(ERATOHOK_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERATOHOK_GAME_ADAPTER.id).toBe('eratohok');
    expect(ERATOHOK_GAME_ADAPTER.id).toBe(ERATOHOK.gameId);
    expect(ERATOHOK_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERATOHOK_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERATOHOK_GAME_FINGERPRINT.digest).toBe('eratohok-emuera1824-zh');
    expect(ERATOHOK_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERATOHOK_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eratohoK 2.0 adapter：事件目录（九事件全部有真定义）', () => {
  it('九条事件与中文名固定序', () => {
    expect(ERATOHOK_EVENT_NAMES).toEqual([
      '初见',
      '训练',
      '读档',
      '商店',
      '购买',
      '指令',
      '训练结束',
      '回合末',
      '指令结束',
    ]);
    expect(ERATOHOK_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎落点 = 九事件（EVENTFIRST/TRAIN/LOAD/SHOP/BUY/COM/END/TURNEND/COMEND）', () => {
    expect(ERATOHOK_EVENT_CATALOG.events.map((e) => e.engine)).toEqual([
      'EVENTFIRST',
      'EVENTTRAIN',
      'EVENTLOAD',
      'EVENTSHOP',
      'EVENTBUY',
      'EVENTCOM',
      'EVENTEND',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]);
  });

  it('forced 只给初见 / 训练结束 / 回合末（引擎保证触发）', () => {
    const forced = ERATOHOK_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST', 'EVENTEND', 'EVENTTURNEND']);
  });

  it('只有指令带可选 int 编号；其余 args 为空', () => {
    const com = ERATOHOK_EVENT_CATALOG.events.find((e) => e.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERATOHOK_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });
});

describe('eratohoK 2.0 adapter：域符号', () => {
  it('代词三轴：我=TARGET（视绑定）、你=MASTER、她=TARGET（不绑视点）', () => {
    expect(ERATOHOK_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERATOHOK_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERATOHOK_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERATOHOK_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(me.engineRef).toBe('%CALLNAME:TARGET%');
    expect(me.requiresView).toBe(true);
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('%CALLNAME:MASTER%');
    expect(you.requiresView).toBe(false);
    expect(you.viewBound).toBe(false);
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    expect(her.requiresView).toBe(true);
    expect(her.viewBound).toBe(false);
    for (const pronoun of ERATOHOK_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('CALLNAME');
    }
  });

  it('八条属性：编号与 CFLAG/TALENT 名表一致、全部可写（实测有赋值）', () => {
    expect(ERATOHOK_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index])).toEqual([
      ['好感度', 'CFLAG', 2],
      ['恋慕', 'TALENT', 150],
      ['服従', 'TALENT', 154],
      ['恋人', 'TALENT', 153],
      ['合意', 'TALENT', 160],
      ['親友', 'TALENT', 151],
      ['隷属', 'TALENT', 155],
      ['処女', 'TALENT', 1],
    ]);
    for (const attribute of ERATOHOK_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（本包无可派生的 library-table，不借 eraTW 的词）', () => {
    expect(ERATOHOK_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：ARG/RESULT/TIME/MONEY/RESULTS 全 int 可写', () => {
    expect(ERATOHOK_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERATOHOK_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV/Chara 的 Chara{no} {名前}.csv 的 名前 行', () => {
    expect(ERATOHOK_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV/Chara',
      key: '名前',
    });
    expect(ERATOHOK_DOMAIN_SYMBOLS.unknown).toBe('error');
  });
});

describe('eratohoK 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：作者色 + W 等待 + D 系 + if 池 + printdatal 随机', () => {
    expect(ERATOHOK_PROFILE.narrationColor).toBe('author');
    expect(ERATOHOK_PROFILE.dialogueColor).toBe('author');
    expect(ERATOHOK_PROFILE.waitDefault).toBe('wait');
    expect(ERATOHOK_PROFILE.colorMode).toBe('D');
    expect(ERATOHOK_PROFILE.poolStyle).toBe('if');
    expect(ERATOHOK_PROFILE.randStyle).toBe('printdatal');
  });

  it('features 与 programFeatures 一致（细粒度开就必须列 program）', () => {
    const enabled = Object.entries(ERATOHOK_PROGRAM_FEATURES)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .sort();
    expect(enabled).toEqual(['arrays', 'goto', 'repeat', 'while']);
    expect(ERATOHOK_PROFILE.features).toContain('program');
    expect(ERATOHOK_PROFILE.features).toEqual(
      expect.arrayContaining(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']),
    );
    expect(ERATOHOK_PROFILE.features).not.toContain('recursion');
    expect(ERATOHOK_PROFILE.features).not.toContain('foreach');
  });

  it('programFeatures：recursion/foreach 关（无实证，fail-visible）', () => {
    expect(ERATOHOK_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：color 与 options 有落点；heart / face 不声明', () => {
    expect(ERATOHOK_PRESENTATION.heart).toBeNull();
    expect(ERATOHOK_PRESENTATION.face).toBeNull();
    expect(ERATOHOK_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
    expect(ERATOHOK_PRESENTATION.options).not.toBeNull();
    expect(ERATOHOK_PRESENTATION.options).toEqual({
      status: 'pending',
      button: 'PRINTBUTTON',
      input: 'INPUTS',
      result: 'RESULTS',
      maxPerScene: 1,
    });
    expect(ERATOHOK_PRESENTATION.faceTemplates).toBeUndefined();
    expect(ERATOHOK_PRESENTATION.hintNames).toBeUndefined();
  });

  it('存储期三族：scene/save/session，前缀按作隔离', () => {
    const byPeriod = new Map(ERATOHOK_STORAGE_CLASSES.classes.map((c) => [c.period, c]));
    expect([...byPeriod.keys()].sort()).toEqual(['save', 'scene', 'session']);
    expect(byPeriod.get('scene')!.engine).toBe('LOCAL');
    expect(byPeriod.get('scene')!.init).toBe('on-entry');
    expect(byPeriod.get('scene')!.persisted).toBe(false);
    expect(byPeriod.get('save')!.engine).toBe('SAVEDATA');
    expect(byPeriod.get('save')!.init).toBe('on-new-game');
    expect(byPeriod.get('save')!.persisted).toBe(true);
    expect(byPeriod.get('session')!.engine).toBe('TCVAR');
    expect(byPeriod.get('session')!.init).toBe('on-process-start');
    expect(byPeriod.get('session')!.persisted).toBe(false);
    for (const spec of ERATOHOK_STORAGE_CLASSES.classes) {
      expect(spec.slotPrefix.startsWith('__kojo_tohok_')).toBe(true);
    }
    expect(ERATOHOK_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERATOHOK_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eratohoK 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + crlf + 保留 BOM + 不归一化', () => {
    expect(ERATOHOK_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERATOHOK_ENCODING_POLICY.allowedEncodings).toContain('utf-8-bom');
    expect(ERATOHOK_ENCODING_POLICY.allowedEncodings).toContain('utf-8');
    expect(ERATOHOK_ENCODING_POLICY.eol).toBe('crlf');
    expect(ERATOHOK_ENCODING_POLICY.preserveBom).toBe(true);
    expect(ERATOHOK_ENCODING_POLICY.normalizeOnSave).toBe(false);
    expect(ERATOHOK_ENCODING_POLICY.fingerprintMismatch).toBe('error');
  });

  it('层策略：事件钩子共享（EVENTTRAIN/EVENTEND 各两处），函数 / overlay 唯一', () => {
    expect(ERATOHOK_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERATOHOK_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码）', () => {
    expect(ERATOHOK_GAME_ADAPTER.diagnosticNamespace.codes).toEqual([]);
    expect(ERATOHOK_GAME_ADAPTER.diagnosticNamespace.namespaces.length).toBeGreaterThan(0);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERATOHOK_CAPABILITY.executesCode).toBe(false);
    expect(ERATOHOK_CAPABILITY.fileAccess).toBe('read-project');
    expect(ERATOHOK_CAPABILITY.networkAccess).toBe('none');
    expect(ERATOHOK_CAPABILITY.writablePaths).toBe('user-approved');
    expect(ERATOHOK_CAPABILITY.integrity).toBe('none');
  });

  it('source map：行级 + 事件头映射开；展开四项未开（无 backend）', () => {
    expect(ERATOHOK_SOURCE_MAP.granularity).toBe('line');
    expect(ERATOHOK_SOURCE_MAP.mapsEventHeader).toBe(true);
    expect(ERATOHOK_SOURCE_MAP.mapsTemplateExpansion).toBe(false);
    expect(ERATOHOK_SOURCE_MAP.mapsPoolExpansion).toBe(false);
    expect(ERATOHOK_SOURCE_MAP.mapsNativeLines).toBe(false);
    expect(ERATOHOK_SOURCE_MAP.mapsRandomSlots).toBe(false);
  });

  it('一致性套件：四面 required + 四个符号引用', () => {
    expect([...ERATOHOK_CONFORMANCE_SUITE.required].sort()).toEqual([
      'differential',
      'encoding',
      'golden',
      'smoke',
    ]);
    expect(ERATOHOK_CONFORMANCE_SUITE.cases).toHaveLength(4);
    expect(ERATOHOK_CONFORMANCE_SUITE.cases.map((c) => c.fixture)).toEqual([
      'kojo2/golden/eratohok-erb-shell',
      'kojo2/differential/eratohok-erb-shell',
      'kojo2/smoke/eratohok-project',
      'kojo2/encoding/eratohok-utf8-bom-crlf',
    ]);
  });
});

/* ------------------------------ 真盘对拍（skipIf 守卫） ------------------------------ */

describe('eratohoK 2.0 adapter：真盘对拍（KOJO_ERATOHOK_DIR 不在则跳过）', () => {
  /**
   * 真盘用例：盘不在就跳过，盘在就给**显式 IO 预算**。
   *
   * 这五条都要扫真盘（2500+ 份 ERB / 174 份 CSV，单跑 1.4–4.2 s）。满载并行池里会被挤过
   * vitest 默认 20 s 而**假红**：2026-10-26 全量跑实测报的是 `Test timed out in 20000ms`，
   * 不是断言失败——单跑本文件 89 例全过。重 IO 用例给显式预算是本仓既有口径
   * （`docs/PITFALLS.md` §81；同批 `erafl-adapter` / `erb-parser` 的语料用例是 120–180 s）。
   * 120 s ≈ 单跑最慢一条的 28 倍余量：既容得下满载抖动，也不会把真挂住吞掉。
   */
  const REAL_DISK_TIMEOUT = 120_000;
  const itReal: (name: string, fn: () => void) => void = hasRealDisk()
    ? (name, fn) => {
        it(name, fn, REAL_DISK_TIMEOUT);
      }
    : (name, fn) => {
        it.skip(name, fn);
      };

  itReal('九事件的文件:行 上确有 `@EVENT…` 定义（含两处共享钩子）', () => {
    const expected: ReadonlyArray<readonly [string, string, number]> = [
      ['ERB/SYSTEM/NEWGAME.ERB', 'EVENTFIRST', 73],
      ['ERB/TRAIN/SYSTEM_TRAIN.ERB', 'EVENTTRAIN', 6],
      ['ERB/口上/_KOJO_SYSTEM.ERB', 'EVENTTRAIN', 104],
      ['ERB/SYSTEM/SAVELOAD.ERB', 'EVENTLOAD', 298],
      ['ERB/SHOP/SHOP.ERB', 'EVENTSHOP', 6],
      ['ERB/SHOP/SHOP.ERB', 'EVENTBUY', 152],
      ['ERB/TRAIN/SYSTEM_TRAIN.ERB', 'EVENTCOM', 280],
      ['ERB/TRAIN/EVENT_AFTER.ERB', 'EVENTEND', 6],
      ['ERB/口上/_KOJO_SYSTEM.ERB', 'EVENTEND', 137],
      ['ERB/SYSTEM/TURNEND.ERB', 'EVENTTURNEND', 4],
      ['ERB/TRAIN/SYSTEM_TRAIN.ERB', 'EVENTCOMEND', 527],
    ];
    for (const [rel, engine, line] of expected) {
      const lines = readFileSync(nodeJoin(ERATOHOK_ROOT, rel), 'utf8').split(/\r?\n/);
      expect(lines[line - 1]!.replace(/^\uFEFF/, '').trim()).toBe(`@${engine}`);
    }
  });

  itReal('八条属性的编号与 CFLAG/TALENT 名表逐条一致', () => {
    // 盘面实际大小写是 `CSV/Talent.csv`（Windows 大小写不敏感）；两个写法都认。
    const resolve = (candidates: readonly string[]): string => {
      const hit = candidates.find((rel) => existsSync(nodeJoin(ERATOHOK_ROOT, rel)));
      if (hit === undefined) throw new Error(`名表缺失：${candidates.join(' / ')}`);
      return hit;
    };
    const talentCsv = resolve(['CSV/Talent.csv', 'CSV/TALENT.CSV']);
    const cflagCsv = resolve(['CSV/CFLAG.CSV', 'CSV/Cflag.csv']);

    // 第 2 字段是名字；剥 BOM、去行内 `;` 注释与引号。
    const rows = (rel: string): string[][] =>
      readFileSync(nodeJoin(ERATOHOK_ROOT, rel), 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) =>
          line
            .split(';')[0]!
            .split(',')
            .map((field) => field.trim().replace(/^"|"$/g, '')),
        )
        .filter((fields) => fields.length > 1);

    const talentRows = rows(talentCsv);
    const cflagRows = rows(cflagCsv);
    for (const attribute of ERATOHOK_DOMAIN_SYMBOLS.attributes) {
      const table = attribute.family === 'CFLAG' ? cflagRows : talentRows;
      const hit = table.find((fields) => fields[1] === attribute.name);
      expect(hit, `${attribute.family}:${attribute.name}`).toBeDefined();
      expect(hit![0]).toBe(String(attribute.index));
    }
    expect(cflagRows.find((fields) => fields[1] === '好感度')![0]).toBe('2');
  });

  itReal('编码：ERB 源树（.ERB + .ERH）UTF-8 BOM >= 2500，CRLF 为绝对主流', () => {
    const dir = nodeJoin(ERATOHOK_ROOT, 'ERB');
    const walk = (root: string, out: string[]): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = nodeJoin(root, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(erb|erh)$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    let bom = 0;
    let crlf = 0;
    let other = 0;
    for (const file of walk(dir, [])) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom++;
      const text = bytes.toString('utf8');
      // 与真盘口径一致：含 CRLF 即记 CRLF，其余记非 CRLF（本作的 39 份是单行无换行）。
      if (text.includes('\r\n')) crlf++;
      else other++;
    }
    expect(bom).toBeGreaterThanOrEqual(2500);
    expect(crlf).toBeGreaterThan(other);
  });

  itReal('代词落点：口上域 TARGET/MASTER 在数万级、%CALLNAME:MASTER% >= 20', () => {
    const dir = nodeJoin(ERATOHOK_ROOT, 'ERB/口上');
    const walk = (root: string, out: string[]): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = nodeJoin(root, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.erb$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const counts = { target: 0, master: 0, callMaster: 0 };
    for (const file of walk(dir, [])) {
      const text = readFileSync(file, 'utf8');
      counts.target += (text.match(/\bTARGET\b/g) ?? []).length;
      counts.master += (text.match(/\bMASTER\b/g) ?? []).length;
      counts.callMaster += (text.match(/%CALLNAME:MASTER%/g) ?? []).length;
    }
    expect(counts.target).toBeGreaterThanOrEqual(30000);
    expect(counts.master).toBeGreaterThanOrEqual(40000);
    expect(counts.callMaster).toBeGreaterThanOrEqual(20);
  });

  itReal('角色 CSV：CSV/Chara 下 Chara*.csv >= 150 份', () => {
    const files = readdirSync(nodeJoin(ERATOHOK_ROOT, 'CSV/Chara'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Chara.*\.csv$/i.test(entry.name))
      .map((entry) => entry.name);
    expect(files.length).toBeGreaterThanOrEqual(150);
  });
});
