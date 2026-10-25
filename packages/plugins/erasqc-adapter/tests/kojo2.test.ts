import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERASQC_CAPABILITY,
  ERASQC_CONFORMANCE_SUITE,
  ERASQC_DOMAIN_SYMBOLS,
  ERASQC_ENCODING_POLICY,
  ERASQC_EVENT_CATALOG,
  ERASQC_EVENT_NAMES,
  ERASQC_GAME_ADAPTER,
  ERASQC_GAME_FINGERPRINT,
  ERASQC_LAYER_POLICY,
  ERASQC_PRESENTATION,
  ERASQC_PROFILE,
  ERASQC_PROGRAM_FEATURES,
  ERASQC_SOURCE_MAP,
  ERASQC_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERASQC } from '../src/constants';
import { ERASQC_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * eraSQC 最小 2.0 数据面的契约闸（2026-10-26）。
 *
 * 三层：
 * ① 契约自洽：`validateGameAdapter` 零诊断、深冻结、根导出同实例；
 * ② 逐字段事实：九事件 / 三代词 / 八状态 / 三存储期 / 编码 LF 主流；
 * ③ 真盘对拍（`KOJO_ERASQC_DIR`，缺省 `D:/Game/eraSQC`，不在就 skip）：
 *    文件:行 级复核事件定义、共享钩子规模、CSV 索引、BOM/EOL、代词计数。
 */

const ERASQC_ROOT = process.env.KOJO_ERASQC_DIR ?? 'D:/Game/eraSQC';
const hasRealDisk = (): boolean => existsSync(ERASQC_ROOT);

describe('eraSQC 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERASQC_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据不可变）', () => {
    expect(Object.isFrozen(ERASQC_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERASQC_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERASQC_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERASQC_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERASQC_STORAGE_CLASSES.classes[0])).toBe(true);
    expect(freezeAdapter(ERASQC_GAME_ADAPTER)).toBe(ERASQC_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表）', () => {
    expect(ERASQC_GAME_ADAPTER.id).toBe('erasqc');
    expect(ERASQC_GAME_ADAPTER.id).toBe(ERASQC.gameId);
    expect(ERASQC_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERASQC_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERASQC_GAME_FINGERPRINT.digest).toBe('erasqc-emuera1824-eev43-zh');
    expect(ERASQC_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual([
      'engine',
      'csv',
      'erh',
      'locale',
    ]);
    for (const entry of ERASQC_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eraSQC 2.0 adapter：事件目录（九事件全部有真定义）', () => {
  it('九条事件与中文名固定序', () => {
    expect(ERASQC_EVENT_NAMES).toEqual([
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
    expect(ERASQC_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎落点 = 九事件（EVENTFIRST/TRAIN/LOAD/SHOP/BUY/COM/END/TURNEND/COMEND）', () => {
    expect(ERASQC_EVENT_CATALOG.events.map((e) => e.engine)).toEqual([
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
    const forced = ERASQC_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST', 'EVENTEND', 'EVENTTURNEND']);
  });

  it('只有指令带可选 int 编号；其余 args 为空', () => {
    const com = ERASQC_EVENT_CATALOG.events.find((e) => e.engine === 'EVENTCOM')!;
    expect(com.args).toEqual([{ name: '编号', kind: 'int', required: false }]);
    for (const spec of ERASQC_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      if (spec.engine !== 'EVENTCOM') expect(spec.args).toEqual([]);
    }
  });
});

describe('eraSQC 2.0 adapter：域符号', () => {
  it('代词三轴：我=TARGET、你=PLAYER（主力形）、她=TARGET（不同 viewBound）', () => {
    expect(ERASQC_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERASQC_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERASQC_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERASQC_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    expect(me.engineRef).toBe('%CALLNAME:TARGET%');
    expect(me.requiresView).toBe(true);
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('%CALLNAME:PLAYER%');
    expect(you.requiresView).toBe(false);
    expect(her.engineRef).toBe('%CALLNAME:TARGET%');
    expect(her.requiresView).toBe(true);
    expect(her.viewBound).toBe(false);
    for (const pronoun of ERASQC_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('CALLNAME');
    }
  });

  it('八条状态线：编号与 TALENT/MARK/ABL 名表一致、全部可写（实测有赋值）', () => {
    expect(ERASQC_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index])).toEqual([
      ['恋慕', 'TALENT', 85],
      ['反发刻印', 'MARK', 3],
      ['屈服刻印', 'MARK', 2],
      ['奉仕精神', 'ABL', 6],
      ['处女', 'TALENT', 0],
      ['淫乱', 'TALENT', 76],
      ['孕娠', 'TALENT', 135],
      ['相思相爱', 'TALENT', 211],
    ]);
    for (const attribute of ERASQC_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（本包无可派生的 library-table，不借 eraTW 的词）', () => {
    expect(ERASQC_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：RESULTS/RESULT/TIME/MONEY/ARG 全 int 可写', () => {
    expect(ERASQC_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERASQC_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV 根的 Chara{no}.csv 的 名前 行', () => {
    expect(ERASQC_DOMAIN_SYMBOLS.speakers).toEqual({
      kind: 'project',
      table: 'CSV',
      key: '名前',
    });
    expect(ERASQC_DOMAIN_SYMBOLS.unknown).toBe('error');
  });
});

describe('eraSQC 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：作者色 + W 等待 + D 系 + if 池 + printdata 随机', () => {
    expect(ERASQC_PROFILE.narrationColor).toBe('author');
    expect(ERASQC_PROFILE.dialogueColor).toBe('author');
    expect(ERASQC_PROFILE.waitDefault).toBe('wait');
    expect(ERASQC_PROFILE.colorMode).toBe('D');
    expect(ERASQC_PROFILE.poolStyle).toBe('if');
    expect(ERASQC_PROFILE.randStyle).toBe('printdata');
  });

  it('features 与 programFeatures 一致（细粒度开就必须列 program）', () => {
    const enabled = Object.entries(ERASQC_PROGRAM_FEATURES)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .sort();
    expect(enabled).toEqual(['arrays', 'goto', 'repeat', 'while']);
    expect(ERASQC_PROFILE.features).toContain('program');
    expect(ERASQC_PROFILE.features).toEqual(
      expect.arrayContaining(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']),
    );
  });

  it('programFeatures：recursion/foreach 关（无实证，fail-visible）', () => {
    expect(ERASQC_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：只有 color 有落点；heart 因缺 DW/DL 变体不声明', () => {
    expect(ERASQC_PRESENTATION.heart).toBeNull();
    expect(ERASQC_PRESENTATION.face).toBeNull();
    expect(ERASQC_PRESENTATION.options).toBeNull();
    expect(ERASQC_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
    expect(ERASQC_PRESENTATION.faceTemplates).toBeUndefined();
    expect(ERASQC_PRESENTATION.hintNames).toBeUndefined();
  });

  it('存储期三族：scene/save/session，前缀按作隔离', () => {
    const byPeriod = new Map(ERASQC_STORAGE_CLASSES.classes.map((c) => [c.period, c]));
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
    for (const spec of ERASQC_STORAGE_CLASSES.classes) {
      expect(spec.slotPrefix.startsWith('__kojo_sqc_')).toBe(true);
    }
    expect(ERASQC_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERASQC_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eraSQC 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + lf + 保留 BOM + 不归一化', () => {
    expect(ERASQC_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERASQC_ENCODING_POLICY.allowedEncodings).toContain('utf-8-bom');
    expect(ERASQC_ENCODING_POLICY.allowedEncodings).toContain('utf-8');
    expect(ERASQC_ENCODING_POLICY.eol).toBe('lf');
    expect(ERASQC_ENCODING_POLICY.preserveBom).toBe(true);
    expect(ERASQC_ENCODING_POLICY.normalizeOnSave).toBe(false);
    expect(ERASQC_ENCODING_POLICY.fingerprintMismatch).toBe('error');
  });

  it('层策略：事件钩子共享（91 份 EVENTTRAIN），函数 / overlay 唯一', () => {
    expect(ERASQC_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERASQC_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'shared-hook'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码）', () => {
    expect(ERASQC_GAME_ADAPTER.diagnosticNamespace.codes).toEqual([]);
    expect(ERASQC_GAME_ADAPTER.diagnosticNamespace.namespaces.length).toBeGreaterThan(0);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERASQC_CAPABILITY.executesCode).toBe(false);
    expect(ERASQC_CAPABILITY.fileAccess).toBe('read-project');
    expect(ERASQC_CAPABILITY.networkAccess).toBe('none');
    expect(ERASQC_CAPABILITY.writablePaths).toBe('user-approved');
    expect(ERASQC_CAPABILITY.integrity).toBe('none');
  });

  it('source map：行级 + 事件头映射开；展开四项未开（无 backend）', () => {
    expect(ERASQC_SOURCE_MAP.granularity).toBe('line');
    expect(ERASQC_SOURCE_MAP.mapsEventHeader).toBe(true);
    expect(ERASQC_SOURCE_MAP.mapsTemplateExpansion).toBe(false);
    expect(ERASQC_SOURCE_MAP.mapsPoolExpansion).toBe(false);
    expect(ERASQC_SOURCE_MAP.mapsNativeLines).toBe(false);
    expect(ERASQC_SOURCE_MAP.mapsRandomSlots).toBe(false);
  });

  it('一致性套件：四面 required + 四个符号引用', () => {
    expect([...ERASQC_CONFORMANCE_SUITE.required].sort()).toEqual([
      'differential',
      'encoding',
      'golden',
      'smoke',
    ]);
    expect(ERASQC_CONFORMANCE_SUITE.cases).toHaveLength(4);
    for (const item of ERASQC_CONFORMANCE_SUITE.cases) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.fixture.startsWith('kojo2/')).toBe(true);
    }
  });
});

/* ------------------------------ 真盘对拍（红线 6：skipIf 守卫） ------------------------------ */

describe('eraSQC 2.0 adapter：真盘对拍（KOJO_ERASQC_DIR 不在则跳过）', () => {
  const itReal = hasRealDisk() ? it : it.skip;

  itReal('九事件的文件:行 上确有 `@EVENT…` 定义', () => {
    const expected: ReadonlyArray<readonly [string, string, number]> = [
      ['ERB/SYSTEM_NEWGAME.ERB', 'EVENTFIRST', 1],
      ['ERB/EVENT_K/EVENT_K.ERB', 'EVENTTRAIN', 579],
      ['ERB/SAVELOAD.ERB', 'EVENTLOAD', 259],
      ['ERB/SHOP/SHOP.ERB', 'EVENTSHOP', 10],
      ['ERB/SHOP/SHOP.ERB', 'EVENTBUY', 611],
      ['ERB/TRAIN/EVENTCOM.ERB', 'EVENTCOM', 30],
      ['ERB/EVENT_K/EVENT_K01.ERB', 'EVENTEND', 334],
      ['ERB/SYSTEM.ERB', 'EVENTTURNEND', 392],
      ['ERB/TRAIN/EVENTCOM.ERB', 'EVENTCOMEND', 208],
    ];
    for (const [rel, engine, line] of expected) {
      const lines = readFileSync(nodeJoin(ERASQC_ROOT, rel), 'utf8').split(/\r?\n/);
      expect(lines[line - 1]!.replace(/^\uFEFF/, '').trim()).toBe(`@${engine}`);
    }
  });

  itReal('共享钩子：EVENTTRAIN / EVENTEND 在角色口上里各有数十份定义', () => {
    const dir = nodeJoin(ERASQC_ROOT, 'ERB/EVENT_K');
    let train = 0;
    let end = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.erb$/i.test(entry.name)) continue;
      const text = readFileSync(nodeJoin(dir, entry.name), 'latin1');
      train += (text.match(/^@EVENTTRAIN\s*$/gm) ?? []).length;
      end += (text.match(/^@EVENTEND\s*$/gm) ?? []).length;
    }
    expect(train).toBeGreaterThanOrEqual(50);
    expect(end).toBeGreaterThanOrEqual(50);
  });

  itReal('八条状态线的编号与 TALENT/MARK/ABL 名表逐条一致', () => {
    const indexOf = (file: string, name: string): string => {
      const csv = readFileSync(nodeJoin(ERASQC_ROOT, `CSV/${file}.CSV`), 'utf8');
      const hit = csv
        .split(/\r?\n/)
        .find((line) => line.replace(/^\uFEFF/, '').split(',')[1] === name);
      return hit!.split(',')[0]!;
    };
    for (const attribute of ERASQC_DOMAIN_SYMBOLS.attributes) {
      if (attribute.family === 'TALENT') {
        expect(indexOf('TALENT', attribute.name)).toBe(String(attribute.index));
      } else if (attribute.family === 'MARK') {
        expect(indexOf('MARK', attribute.name)).toBe(String(attribute.index));
      } else if (attribute.family === 'ABL') {
        expect(indexOf('ABL', attribute.name)).toBe(String(attribute.index));
      }
    }
  });

  itReal('编码：ERB 全树 UTF-8 BOM、LF 为绝对主流（25 份 CRLF 是既成事实）', () => {
    const dir = nodeJoin(ERASQC_ROOT, 'ERB');
    const walk = (root: string, out: string[]): string[] => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const full = nodeJoin(root, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.erb$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    let bom = 0;
    let lf = 0;
    let crlf = 0;
    for (const file of walk(dir, [])) {
      const bytes = readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bom++;
      const text = bytes.toString('utf8');
      if (text.includes('\r\n')) crlf++;
      else if (text.includes('\n')) lf++;
    }
    expect(bom).toBeGreaterThanOrEqual(300);
    expect(lf).toBeGreaterThan(crlf);
  });

  itReal('代词落点：口上域 TARGET/PLAYER 各在万级、ASSI 在千级（头注计数下限复算）', () => {
    const dir = nodeJoin(ERASQC_ROOT, 'ERB/EVENT_K');
    const counts = { target: 0, player: 0, assi: 0 };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.erb$/i.test(entry.name)) continue;
      const text = readFileSync(nodeJoin(dir, entry.name), 'utf8');
      counts.target += (text.match(/%CALLNAME:TARGET%/g) ?? []).length;
      counts.player += (text.match(/%CALLNAME:PLAYER%/g) ?? []).length;
      counts.assi += (text.match(/%CALLNAME:ASSI%/g) ?? []).length;
    }
    expect(counts.target).toBeGreaterThanOrEqual(10000);
    expect(counts.player).toBeGreaterThanOrEqual(1000);
    expect(counts.assi).toBeGreaterThanOrEqual(100);
  });
});
