import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERAKOUMAKAN_CAPABILITY,
  ERAKOUMAKAN_CONFORMANCE_SUITE,
  ERAKOUMAKAN_DOMAIN_SYMBOLS,
  ERAKOUMAKAN_ENCODING_POLICY,
  ERAKOUMAKAN_EVENT_CATALOG,
  ERAKOUMAKAN_EVENT_NAMES,
  ERAKOUMAKAN_GAME_ADAPTER,
  ERAKOUMAKAN_GAME_FINGERPRINT,
  ERAKOUMAKAN_LAYER_POLICY,
  ERAKOUMAKAN_PRESENTATION,
  ERAKOUMAKAN_PROFILE,
  ERAKOUMAKAN_PROGRAM_FEATURES,
  ERAKOUMAKAN_SOURCE_MAP,
  ERAKOUMAKAN_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERAKOUMAKAN } from '../src/constants';
import { ERAKOUMAKAN_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * era紅魔館 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * 三层：
 * ① 契约自洽：`validateGameAdapter` 零诊断、深冻结、根导出同实例；
 * ② 逐字段事实：七事件（无商店 / 购买）/ 三代词（主人公是 `奴隷`）/ 八属性 /
 *    两存储期（无 save）/ 编码 LF / 层策略 shared-hook / 演出面四项全 null；
 * ③ 真盘对拍（`KOJO_ERAKOUMAKAN_DIR`，缺省 `D:/Game/eraKoumakan`，不在就 skip）：
 *    文件:行 级复核事件定义、CSV 编号、BOM/LF、代词计数、Chara 数量。
 */

const ERAKOUMAKAN_ROOT = process.env.KOJO_ERAKOUMAKAN_DIR ?? 'D:/Game/eraKoumakan';
const hasRealDisk = (): boolean => existsSync(ERAKOUMAKAN_ROOT);

describe('era紅魔館 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERAKOUMAKAN_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERAKOUMAKAN_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERAKOUMAKAN_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERAKOUMAKAN_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERAKOUMAKAN_DOMAIN_SYMBOLS.attributes[0])).toBe(true);
    expect(Object.isFrozen(ERAKOUMAKAN_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(freezeAdapter(ERAKOUMAKAN_GAME_ADAPTER)).toBe(ERAKOUMAKAN_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERAKOUMAKAN_GAME_ADAPTER.id).toBe('erakoumakan');
    expect(ERAKOUMAKAN_GAME_ADAPTER.id).toBe(ERAKOUMAKAN.gameId);
    expect(ERAKOUMAKAN_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERAKOUMAKAN_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERAKOUMAKAN_GAME_FINGERPRINT.digest).toBe('erakoumakan-emuera1821-zh');
    expect(ERAKOUMAKAN_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERAKOUMAKAN_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('era紅魔館 2.0 adapter：事件目录（七事件，无商店）', () => {
  it('七条事件与中文名固定序', () => {
    expect(ERAKOUMAKAN_EVENT_NAMES).toEqual([
      '初见',
      '训练',
      '读档',
      '指令',
      '训练结束',
      '回合末',
      '指令结束',
    ]);
    expect(ERAKOUMAKAN_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('本作无商店：EVENTSHOP / EVENTBUY 不在目录里', () => {
    const engines = ERAKOUMAKAN_EVENT_CATALOG.events.map((e) => e.engine);
    expect(engines).toEqual([
      'EVENTFIRST',
      'EVENTTRAIN',
      'EVENTLOAD',
      'EVENTCOM',
      'EVENTEND',
      'EVENTTURNEND',
      'EVENTCOMEND',
    ]);
    expect(engines).not.toContain('EVENTSHOP');
    expect(engines).not.toContain('EVENTBUY');
    expect(ERAKOUMAKAN_EVENT_NAMES).not.toContain('商店');
    expect(ERAKOUMAKAN_EVENT_NAMES).not.toContain('购买');
  });

  it('forced 只给初见 / 训练结束 / 回合末（引擎保证触发）', () => {
    const forced = ERAKOUMAKAN_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST', 'EVENTEND', 'EVENTTURNEND']);
  });

  it('只有指令带可选 int 编号；其余 args 为空', () => {
    const com = ERAKOUMAKAN_EVENT_CATALOG.events.find((e) => e.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERAKOUMAKAN_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });
});

describe('era紅魔館 2.0 adapter：域符号', () => {
  it('代词三轴：我=奴隷（视绑定）、你=MASTER、她=TARGET（不绑视点）', () => {
    expect(ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(me.engineRef).toBe('%CALLNAME:奴隷%');
    expect(me.requiresView).toBe(true);
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('%CALLNAME:MASTER%');
    expect(you.requiresView).toBe(false);
    expect(you.viewBound).toBe(false);
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    expect(her.requiresView).toBe(true);
    expect(her.viewBound).toBe(false);
    for (const pronoun of ERAKOUMAKAN_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('CALLNAME');
    }
  });

  it('八条属性：编号与 CFLAG/TALENT/MARK 名表一致、全部可写（实测有赋值）', () => {
    expect(
      ERAKOUMAKAN_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index]),
    ).toEqual([
      ['好感度', 'CFLAG', 2],
      ['性欲', 'CFLAG', 20],
      ['屈服度', 'CFLAG', 21],
      ['恋慕', 'TALENT', 3],
      ['处女', 'TALENT', 0],
      ['浮気公認', 'TALENT', 159],
      ['公众便所', 'TALENT', 7],
      ['屈服刻印', 'MARK', 2],
    ]);
    for (const attribute of ERAKOUMAKAN_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（本包 name-glossary 是文件名对照表，不是名字函数）', () => {
    expect(ERAKOUMAKAN_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：ARG/RESULT/TIME/MONEY/RESULTS 全 int 可写', () => {
    expect(ERAKOUMAKAN_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERAKOUMAKAN_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV/Chara{no}.csv 的 名前 行', () => {
    expect(ERAKOUMAKAN_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV/Chara',
      key: '名前',
    });
    expect(ERAKOUMAKAN_DOMAIN_SYMBOLS.unknown).toBe('error');
  });
});

describe('era紅魔館 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：默认色 + W 等待 + plain + if 池 + printdatal 随机', () => {
    expect(ERAKOUMAKAN_PROFILE.narrationColor).toBe('default');
    expect(ERAKOUMAKAN_PROFILE.dialogueColor).toBe('default');
    expect(ERAKOUMAKAN_PROFILE.waitDefault).toBe('wait');
    expect(ERAKOUMAKAN_PROFILE.colorMode).toBe('plain');
    expect(ERAKOUMAKAN_PROFILE.poolStyle).toBe('if');
    expect(ERAKOUMAKAN_PROFILE.randStyle).toBe('printdatal');
  });

  it('features 与 programFeatures 一致（细粒度开就必须列 program）', () => {
    const enabled = Object.entries(ERAKOUMAKAN_PROGRAM_FEATURES)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .sort();
    expect(enabled).toEqual(['arrays', 'goto', 'repeat', 'while']);
    expect(ERAKOUMAKAN_PROFILE.features).toContain('program');
    expect(ERAKOUMAKAN_PROFILE.features).toEqual(
      expect.arrayContaining(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']),
    );
    expect(ERAKOUMAKAN_PROFILE.features).not.toContain('recursion');
    expect(ERAKOUMAKAN_PROFILE.features).not.toContain('foreach');
  });

  it('programFeatures：recursion/foreach 关（无实证，fail-visible）', () => {
    expect(ERAKOUMAKAN_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面四项全 null（本作无取色 / 心形打印族 / 颜绘 / 选项落点）', () => {
    expect(ERAKOUMAKAN_PRESENTATION.heart).toBeNull();
    expect(ERAKOUMAKAN_PRESENTATION.color).toBeNull();
    expect(ERAKOUMAKAN_PRESENTATION.face).toBeNull();
    expect(ERAKOUMAKAN_PRESENTATION.options).toBeNull();
    expect(ERAKOUMAKAN_PRESENTATION.faceTemplates).toBeUndefined();
    expect(ERAKOUMAKAN_PRESENTATION.hintNames).toBeUndefined();
  });

  it('存储期只三族中的两族：scene/session，save 缺席（SAVEDATA 全树 0）', () => {
    const byPeriod = new Map(ERAKOUMAKAN_STORAGE_CLASSES.classes.map((c) => [c.period, c]));
    expect([...byPeriod.keys()].sort()).toEqual(['scene', 'session']);
    expect(byPeriod.has('save')).toBe(false);
    expect(byPeriod.get('scene')!.engine).toBe('LOCAL');
    expect(byPeriod.get('scene')!.init).toBe('on-entry');
    expect(byPeriod.get('scene')!.persisted).toBe(false);
    expect(byPeriod.get('session')!.engine).toBe('TCVAR');
    expect(byPeriod.get('session')!.init).toBe('on-process-start');
    expect(byPeriod.get('session')!.persisted).toBe(false);
    for (const spec of ERAKOUMAKAN_STORAGE_CLASSES.classes) {
      expect(spec.slotPrefix.startsWith('__kojo_koumakan_')).toBe(true);
    }
    expect(ERAKOUMAKAN_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERAKOUMAKAN_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('era紅魔館 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + lf + 保留 BOM + 不归一化', () => {
    expect(ERAKOUMAKAN_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERAKOUMAKAN_ENCODING_POLICY.allowedEncodings).toContain('utf-8-bom');
    expect(ERAKOUMAKAN_ENCODING_POLICY.allowedEncodings).toContain('utf-8');
    expect(ERAKOUMAKAN_ENCODING_POLICY.eol).toBe('lf');
    expect(ERAKOUMAKAN_ENCODING_POLICY.preserveBom).toBe(true);
    expect(ERAKOUMAKAN_ENCODING_POLICY.normalizeOnSave).toBe(false);
    expect(ERAKOUMAKAN_ENCODING_POLICY.fingerprintMismatch).toBe('error');
  });

  it('层策略：事件钩子共享（EVENTTRAIN 两处定义），函数 / overlay 唯一', () => {
    expect(ERAKOUMAKAN_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERAKOUMAKAN_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码）', () => {
    expect(ERAKOUMAKAN_GAME_ADAPTER.diagnosticNamespace.codes).toEqual([]);
    expect(ERAKOUMAKAN_GAME_ADAPTER.diagnosticNamespace.namespaces.length).toBeGreaterThan(0);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERAKOUMAKAN_CAPABILITY.executesCode).toBe(false);
    expect(ERAKOUMAKAN_CAPABILITY.fileAccess).toBe('read-project');
    expect(ERAKOUMAKAN_CAPABILITY.networkAccess).toBe('none');
    expect(ERAKOUMAKAN_CAPABILITY.writablePaths).toBe('user-approved');
    expect(ERAKOUMAKAN_CAPABILITY.integrity).toBe('none');
  });

  it('source map：行级 + 事件头映射开；展开四项未开（无 backend）', () => {
    expect(ERAKOUMAKAN_SOURCE_MAP.granularity).toBe('line');
    expect(ERAKOUMAKAN_SOURCE_MAP.mapsEventHeader).toBe(true);
    expect(ERAKOUMAKAN_SOURCE_MAP.mapsTemplateExpansion).toBe(false);
    expect(ERAKOUMAKAN_SOURCE_MAP.mapsPoolExpansion).toBe(false);
    expect(ERAKOUMAKAN_SOURCE_MAP.mapsNativeLines).toBe(false);
    expect(ERAKOUMAKAN_SOURCE_MAP.mapsRandomSlots).toBe(false);
  });

  it('一致性套件：四面 required + 四个符号引用', () => {
    expect([...ERAKOUMAKAN_CONFORMANCE_SUITE.required].sort()).toEqual([
      'differential',
      'encoding',
      'golden',
      'smoke',
    ]);
    expect(ERAKOUMAKAN_CONFORMANCE_SUITE.cases).toHaveLength(4);
    expect(ERAKOUMAKAN_CONFORMANCE_SUITE.cases.map((c) => c.fixture)).toEqual([
      'kojo2/golden/erakoumakan-erb-shell',
      'kojo2/differential/erakoumakan-erb-shell',
      'kojo2/smoke/erakoumakan-project',
      'kojo2/encoding/erakoumakan-utf8-bom-lf',
    ]);
  });
});

/* ------------------------------ 真盘对拍（skipIf 守卫） ------------------------------ */

describe('era紅魔館 2.0 adapter：真盘对拍（KOJO_ERAKOUMAKAN_DIR 不在则跳过）', () => {
  const itReal = hasRealDisk() ? it : it.skip;

  itReal('七事件的文件:行 上确有 `@EVENT…` 定义（EVENTTRAIN 两处共存）', () => {
    const expected: ReadonlyArray<readonly [string, string, number]> = [
      ['ERB/SYSTEM.ERB', 'EVENTFIRST', 4],
      ['ERB/BEFORETRAIN.ERB', 'EVENTTRAIN', 3],
      ['ERB/COMMON.ERB', 'EVENTTRAIN', 123],
      ['ERB/SYSTEM.ERB', 'EVENTLOAD', 176],
      ['ERB/EVENTCOMEND.ERB', 'EVENTCOM', 4],
      ['ERB/AFTERTRA.ERB', 'EVENTEND', 4],
      ['ERB/EVENTTURNEND.ERB', 'EVENTTURNEND', 4],
      ['ERB/EVENTCOMEND.ERB', 'EVENTCOMEND', 9],
    ];
    for (const [rel, engine, line] of expected) {
      const lines = readFileSync(nodeJoin(ERAKOUMAKAN_ROOT, rel), 'utf8').split(/\r?\n/);
      expect(lines[line - 1]!.replace(/^\uFEFF/, '').trim()).toBe(`@${engine}`);
    }
  });

  itReal('八条属性的编号与 CFLAG/TALENT/MARK 名表逐条一致', () => {
    // 盘面实际大小写是 `CSV/CFLAG.csv` / `CSV/Talent.csv` / `CSV/Mark.csv`
    // （Windows 大小写不敏感）；两个写法都认。
    const resolve = (candidates: readonly string[]): string => {
      const hit = candidates.find((rel) => existsSync(nodeJoin(ERAKOUMAKAN_ROOT, rel)));
      if (hit === undefined) throw new Error(`名表缺失：${candidates.join(' / ')}`);
      return hit;
    };
    const tables = new Map<string, string>([
      ['CFLAG', resolve(['CSV/CFLAG.csv', 'CSV/Cflag.csv'])],
      ['TALENT', resolve(['CSV/Talent.csv', 'CSV/TALENT.csv'])],
      ['MARK', resolve(['CSV/Mark.csv', 'CSV/MARK.csv'])],
    ]);

    // 第 2 字段是名字；剥 BOM、去行内 `;` 注释与引号。
    const rows = (rel: string): string[][] =>
      readFileSync(nodeJoin(ERAKOUMAKAN_ROOT, rel), 'utf8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) =>
          line
            .split(';')[0]!
            .split(',')
            .map((field) => field.trim().replace(/^"|"$/g, '')),
        )
        .filter((fields) => fields.length > 1);

    const parsed = new Map<string, string[][]>();
    for (const [family, rel] of tables) parsed.set(family, rows(rel));

    for (const attribute of ERAKOUMAKAN_DOMAIN_SYMBOLS.attributes) {
      const table = parsed.get(attribute.family);
      expect(table, `${attribute.family} 名表未解析`).toBeDefined();
      const hit = table!.find((fields) => fields[1] === attribute.name);
      expect(hit, `${attribute.family}:${attribute.name}`).toBeDefined();
      expect(hit![0]).toBe(String(attribute.index));
    }
    // 关键槽位再钉一遍（名表原文：编号在第 1 字段）
    expect(parsed.get('CFLAG')!.find((f) => f[1] === '好感度')![0]).toBe('2');
    expect(parsed.get('TALENT')!.find((f) => f[1] === '处女')![0]).toBe('0');
    expect(parsed.get('MARK')!.find((f) => f[1] === '屈服刻印')![0]).toBe('2');
  });

  itReal('编码：ERB 全树 UTF-8 BOM >= 400，且 400+ 份无 CRLF（纯 LF）', () => {
    const dir = nodeJoin(ERAKOUMAKAN_ROOT, 'ERB');
    const walk = (root: string, out: string[]): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = nodeJoin(root, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.erb$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const files = walk(dir, []);
    let bom = 0;
    let crlf = 0;
    let noCrlf = 0;
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom++;
      const text = bytes.toString('utf8');
      // 与真盘口径一致：含 CRLF 记 CRLF；其余记非 CRLF（本作 394 份含 LF、
      // 9 份单行无换行——两者都证明 eol:'lf' 不会改行尾）。
      if (text.includes('\r\n')) crlf++;
      else noCrlf++;
    }
    expect(files.length).toBeGreaterThanOrEqual(400);
    expect(bom).toBeGreaterThanOrEqual(400);
    expect(noCrlf).toBeGreaterThanOrEqual(400);
    expect(crlf).toBe(0);
  });

  itReal('代词落点：口上域 奴隷/MASTER/TARGET 三代词有真语料，SETCOLOR 为 0', () => {
    const dir = nodeJoin(ERAKOUMAKAN_ROOT, 'ERB/口上');
    const walk = (root: string, out: string[]): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = nodeJoin(root, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.erb$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const counts = { slave: 0, master: 0, target: 0, setColor: 0 };
    for (const file of walk(dir, [])) {
      const text = readFileSync(file, 'utf8');
      counts.slave += (text.match(/%CALLNAME:奴隷%/g) ?? []).length;
      counts.master += (text.match(/%CALLNAME:MASTER%/g) ?? []).length;
      counts.target += (text.match(/%CALLNAME:TARGET%/g) ?? []).length;
      counts.setColor += (text.match(/\bSETCOLOR\b/g) ?? []).length;
    }
    expect(counts.slave).toBeGreaterThanOrEqual(10000);
    expect(counts.master).toBeGreaterThanOrEqual(3000);
    expect(counts.target).toBeGreaterThanOrEqual(300);
    // 钉 presentation.color = null 的口上依据：作者零取色。
    expect(counts.setColor).toBe(0);
  });

  itReal('角色 CSV：CSV 下 Chara*.csv >= 15 份', () => {
    const files = readdirSync(nodeJoin(ERAKOUMAKAN_ROOT, 'CSV'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^Chara.*\.csv$/i.test(entry.name))
      .map((entry) => entry.name);
    expect(files.length).toBeGreaterThanOrEqual(15);
  });
});
