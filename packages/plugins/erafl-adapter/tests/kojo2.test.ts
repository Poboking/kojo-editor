import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freezeAdapter, validateGameAdapter } from '@kojo/kojo-core';
import {
  ERAFL_CAPABILITY,
  ERAFL_CONFORMANCE_SUITE,
  ERAFL_DOMAIN_SYMBOLS,
  ERAFL_ENCODING_POLICY,
  ERAFL_EVENT_CATALOG,
  ERAFL_EVENT_NAMES,
  ERAFL_GAME_ADAPTER,
  ERAFL_GAME_FINGERPRINT,
  ERAFL_LAYER_POLICY,
  ERAFL_PRESENTATION,
  ERAFL_PROFILE,
  ERAFL_PROGRAM_FEATURES,
  ERAFL_SOURCE_MAP,
  ERAFL_STORAGE_CLASSES,
} from '../src/kojo2';
import { ERAFL } from '../src/constants';
import { ERAFL_GAME_ADAPTER as ROOT_EXPORTED_ADAPTER } from '../src/index';

/**
 * 入口 B（2026-10-24）：eraFL 最小 2.0 数据面的契约闸。
 *
 * 钉三层：
 * ① **契约自洽**：`validateGameAdapter` 零诊断（装载自检是 core 的事，过不了
 *    它连表都进不了）；
 * ② **逐字段事实**：每个字段的值与头注里的真盘读数对得上（事件只有 4 条、
 *    代词三轴落点是 XML 记号 [$KNAME]/[$MNAME]/[$TNAME]、编码 utf-8-bom+crlf、
 *    color 有落点而 heart/face/options 没有…）；
 * ③ **真盘对拍**（`D:/Game/erafl` 不在就 skip——红线 6）：文件:行 级验证
 *    事件定义、CFLAG.CSV 索引、BOM/EOL 分布。合成用例独立成立，不依赖真盘。
 */

/** 真盘根（红线 6：不在就跳，不让 CI 依赖本机目录） */
const ERAFL_ROOT = 'D:/Game/erafl';
const hasRealDisk = (): boolean => existsSync(ERAFL_ROOT);

describe('eraFL 2.0 adapter：契约自洽', () => {
  it('validateGameAdapter 零诊断', () => {
    expect(validateGameAdapter(ERAFL_GAME_ADAPTER)).toEqual([]);
  });

  it('module 装载即深冻结（契约数据零构造开销、不可变）', () => {
    expect(Object.isFrozen(ERAFL_GAME_ADAPTER)).toBe(true);
    expect(Object.isFrozen(ERAFL_EVENT_CATALOG.events)).toBe(true);
    expect(Object.isFrozen(ERAFL_EVENT_CATALOG.events[0])).toBe(true);
    expect(Object.isFrozen(ERAFL_DOMAIN_SYMBOLS.pronouns)).toBe(true);
    expect(Object.isFrozen(ERAFL_STORAGE_CLASSES.classes[0])).toBe(true);
    // freezeAdapter 幂等：再冻一次同一个对象不炸（宿主/测试复用同一口径）
    expect(freezeAdapter(ERAFL_GAME_ADAPTER)).toBe(ERAFL_GAME_ADAPTER);
  });

  it('id 与 v1 gameId 一致（宿主登记簿按 v1 键建表，§6.3）', () => {
    expect(ERAFL_GAME_ADAPTER.id).toBe('erafl');
    expect(ERAFL_GAME_ADAPTER.id).toBe(ERAFL.gameId);
    expect(ERAFL_GAME_ADAPTER.version).toBe('2.0.0');
  });

  it('包根导出与 kojo2 目录是同一枚实例（bootstrap 懒登记读的是根导出）', () => {
    expect(ROOT_EXPORTED_ADAPTER).toBe(ERAFL_GAME_ADAPTER);
  });

  it('指纹四段齐、digest 非空', () => {
    expect(ERAFL_GAME_FINGERPRINT.digest).toBe('erafl-1.45-zh');
    expect(ERAFL_GAME_FINGERPRINT.entries.map((e) => e.kind)).toEqual(['engine', 'csv', 'erh', 'locale']);
    for (const entry of ERAFL_GAME_FINGERPRINT.entries) {
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe('eraFL 2.0 adapter：事件目录（九事件里只有 4 条真定义）', () => {
  it('只声明 4 条：初见 / 读档 / 商店 / 购买', () => {
    expect(ERAFL_EVENT_NAMES).toEqual(['初见', '读档', '商店', '购买']);
    expect(ERAFL_EVENT_CATALOG.defaultEvent).toBeNull();
  });

  it('引擎落点是四个真定义（EVENTFIRST/LOAD/SHOP/BUY）', () => {
    expect(ERAFL_EVENT_CATALOG.events.map((e) => e.engine).sort()).toEqual(
      ['EVENTBUY', 'EVENTFIRST', 'EVENTLOAD', 'EVENTSHOP'].sort(),
    );
  });

  it('五个没有的事件一条都不声明（声明了就是对作者撒谎）', () => {
    for (const absent of ['EVENTTRAIN', 'EVENTCOM', 'EVENTEND', 'EVENTTURNEND', 'EVENTCOMEND']) {
      expect(ERAFL_EVENT_CATALOG.events.some((e) => e.engine === absent)).toBe(false);
    }
  });

  it('forced 只给 EVENTFIRST（新游戏首帧，引擎保证触发）', () => {
    const forced = ERAFL_EVENT_CATALOG.events.filter((e) => e.forced).map((e) => e.engine);
    expect(forced).toEqual(['EVENTFIRST']);
  });

  it('四条都是引擎分发 + Emuera 桶优先级 + 可监听（与 eraTW 同引擎机制）', () => {
    for (const spec of ERAFL_EVENT_CATALOG.events) {
      expect(spec.dispatch).toBe('engine-dispatch');
      expect(spec.priority).toBe('emuera-buckets');
      expect(spec.weavable).toBe(true);
      expect(spec.guard).toBeNull();
      expect(spec.args).toEqual([]);
    }
  });
});

describe('eraFL 2.0 adapter：域符号', () => {
  it('代词三轴全声明；落点是 eraFL 主形（不是 eraTW 的 CALLNAME:TARGET）', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.pronouns.map((p) => p.pronoun)).toEqual(['我', '你', '她']);
    const me = ERAFL_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'me')!;
    const you = ERAFL_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'you')!;
    const her = ERAFL_DOMAIN_SYMBOLS.pronouns.find((p) => p.role === 'her')!;
    // eraFL 三轴主力形都在 XML 插值记号族（eraTW 是 %CALLNAME:指令族——不照抄）
    expect(me.engineRef).toBe('[$KNAME]');
    expect(me.requiresView).toBe(true);
    expect(me.viewBound).toBe(true);
    expect(you.engineRef).toBe('[$MNAME]');
    expect(you.requiresView).toBe(false);
    expect(her.engineRef).toBe('[$TNAME]');
    expect(her.requiresView).toBe(true);
    expect(her.viewBound).toBe(false);
    for (const pronoun of ERAFL_DOMAIN_SYMBOLS.pronouns) {
      expect(pronoun.family).toBe('XML-NAME');
    }
  });

  it('五条状态线：CFLAG 编号与 CSV 名表一致、全部可写', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.attributes.map((a) => [a.name, a.family, a.index])).toEqual([
      ['好感度', 'CFLAG', 2],
      ['依存度', 'CFLAG', 3],
      ['従属度', 'CFLAG', 4],
      ['支配度', 'CFLAG', 5],
      ['面識', 'CFLAG', 17],
    ]);
    for (const attribute of ERAFL_DOMAIN_SYMBOLS.attributes) {
      expect(attribute.valueKind).toBe('int');
      expect(attribute.readonly).toBe(false);
    }
  });

  it('名字函数空表（eraFL 的 library-table 是入口 C 的事，不借 eraTW 的词）', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.nameFunctions).toEqual([]);
  });

  it('五个域变量：RESULTS/RESULT/TIME/MONEY/ARG 全 int 可写', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.variables?.map((v) => v.name).sort()).toEqual(
      ['ARG', 'MONEY', 'RESULT', 'RESULTS', 'TIME'].sort(),
    );
    for (const variable of ERAFL_DOMAIN_SYMBOLS.variables ?? []) {
      expect(variable.valueKind).toBe('int');
      expect(variable.readonly).toBeUndefined();
    }
  });

  it('说话人是项目级名表：CSV/Chara 的 名前 行（不是 eraTW 的 CHARA/CALLNAME）', () => {
    expect(ERAFL_DOMAIN_SYMBOLS.speakers).toEqual({ kind: 'project', table: 'CSV/Chara', key: '名前' });
    expect(ERAFL_DOMAIN_SYMBOLS.unknown).toBe('error');
  });
});

describe('eraFL 2.0 adapter：profile / 演出面 / 存储期 / 程序层', () => {
  it('profile：作者色 + W 等待 + D 系 + if 池 + printdata 随机', () => {
    expect(ERAFL_PROFILE.narrationColor).toBe('author');
    expect(ERAFL_PROFILE.dialogueColor).toBe('author');
    expect(ERAFL_PROFILE.waitDefault).toBe('wait');
    expect(ERAFL_PROFILE.colorMode).toBe('D');
    expect(ERAFL_PROFILE.poolStyle).toBe('if');
    expect(ERAFL_PROFILE.randStyle).toBe('printdata');
  });

  it('features 与 programFeatures 一致（有细粒度开就必须列 program）', () => {
    const enabled = Object.entries(ERAFL_PROGRAM_FEATURES)
      .filter(([, on]) => on)
      .map(([key]) => key)
      .sort();
    expect(enabled).toEqual(['arrays', 'goto', 'repeat', 'while']);
    // 六个细粒度键与 features 的对应：program（总闸）+ functions（CALL 遍地）
    for (const feature of ERAFL_PROFILE.features) {
      expect(['program', 'functions', 'loops', 'arrays', 'goto', 'repeat']).toContain(feature);
    }
    expect(ERAFL_PROFILE.features).toContain('program');
  });

  it('programFeatures：recursion/foreach 关（无实证，fail-visible）', () => {
    expect(ERAFL_PROGRAM_FEATURES).toEqual({
      arrays: true,
      while: true,
      goto: true,
      recursion: false,
      foreach: false,
      repeat: true,
    });
  });

  it('演出面：只有 color 有落点；heart/face/options 不声明', () => {
    expect(ERAFL_PRESENTATION.heart).toBeNull();
    expect(ERAFL_PRESENTATION.face).toBeNull();
    expect(ERAFL_PRESENTATION.options).toBeNull();
    expect(ERAFL_PRESENTATION.color).toEqual({
      setColor: 'SETCOLOR',
      resetColor: 'RESETCOLOR',
      hexPrefix: '0x',
    });
    // 能力没声明就不给候选数据（faceTemplates/hintNames 不出现）
    expect(ERAFL_PRESENTATION.faceTemplates).toBeUndefined();
    expect(ERAFL_PRESENTATION.hintNames).toBeUndefined();
  });

  it('存储期三族：scene/save/session，init 与 persisted 合语义', () => {
    const byPeriod = new Map(ERAFL_STORAGE_CLASSES.classes.map((c) => [c.period, c]));
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
    for (const spec of ERAFL_STORAGE_CLASSES.classes) {
      expect(spec.slotPrefix.startsWith('__')).toBe(true);
    }
    expect(ERAFL_STORAGE_CLASSES.slotStability).toBe('project-stable');
  });

  it('foreachCollections = null（无 @巡 语料 ⇒ 整面不支持）', () => {
    expect(ERAFL_GAME_ADAPTER.foreachCollections).toBeNull();
  });
});

describe('eraFL 2.0 adapter：非功能性面', () => {
  it('编码策略：utf-8-bom 缺省 + crlf + 保留 BOM + 不归一化', () => {
    expect(ERAFL_ENCODING_POLICY.defaultEncoding).toBe('utf-8-bom');
    expect(ERAFL_ENCODING_POLICY.allowedEncodings).toContain('utf-8-bom');
    // 76 份无 BOM 文件是既成事实 ⇒ 读要能读
    expect(ERAFL_ENCODING_POLICY.allowedEncodings).toContain('utf-8');
    expect(ERAFL_ENCODING_POLICY.eol).toBe('crlf');
    expect(ERAFL_ENCODING_POLICY.preserveBom).toBe(true);
    expect(ERAFL_ENCODING_POLICY.normalizeOnSave).toBe(false);
    expect(ERAFL_ENCODING_POLICY.fingerprintMismatch).toBe('error');
  });

  it('层策略：三类定义面一律 unique', () => {
    expect(ERAFL_LAYER_POLICY.defaultMode).toBe('unique');
    expect(ERAFL_LAYER_POLICY.rules.map((r) => [r.target, r.mode])).toEqual([
      ['function', 'unique'],
      ['event-hook', 'unique'],
      ['kojo-overlay', 'unique'],
    ]);
  });

  it('诊断命名空间：codes 空（最小数据面零 adapter 专属码，有意为之）', () => {
    expect(ERAFL_GAME_ADAPTER.diagnosticNamespace.codes).toEqual([]);
    expect(ERAFL_GAME_ADAPTER.diagnosticNamespace.namespaces.length).toBeGreaterThan(0);
  });

  it('安全边界：纯数据 adapter（不执行代码 / 不联网）', () => {
    expect(ERAFL_CAPABILITY.executesCode).toBe(false);
    expect(ERAFL_CAPABILITY.fileAccess).toBe('read-project');
    expect(ERAFL_CAPABILITY.networkAccess).toBe('none');
    expect(ERAFL_CAPABILITY.writablePaths).toBe('user-approved');
    expect(ERAFL_CAPABILITY.integrity).toBe('none');
  });

  it('source map：行级 + 事件头映射必开；展开四项未开（入口 D 后逐项翻）', () => {
    expect(ERAFL_SOURCE_MAP.granularity).toBe('line');
    expect(ERAFL_SOURCE_MAP.mapsEventHeader).toBe(true);
    expect(ERAFL_SOURCE_MAP.mapsTemplateExpansion).toBe(false);
    expect(ERAFL_SOURCE_MAP.mapsPoolExpansion).toBe(false);
    expect(ERAFL_SOURCE_MAP.mapsNativeLines).toBe(false);
    expect(ERAFL_SOURCE_MAP.mapsRandomSlots).toBe(false);
  });

  it('一致性套件：四面 required + 四个用例 + fixture 非空', () => {
    expect([...ERAFL_CONFORMANCE_SUITE.required].sort()).toEqual([
      'differential',
      'encoding',
      'golden',
      'smoke',
    ]);
    expect(ERAFL_CONFORMANCE_SUITE.cases).toHaveLength(4);
    for (const item of ERAFL_CONFORMANCE_SUITE.cases) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.fixture.startsWith('kojo2/')).toBe(true);
    }
  });
});

/* ------------------------------ 真盘对拍（红线 6：skipIf 守卫） ------------------------------ */

describe('eraFL 2.0 adapter：真盘对拍（D:/Game/erafl 不在则跳过）', () => {
  const itReal = hasRealDisk() ? it : it.skip;

  itReal('四条事件的文件:行 上确有 `@EVENT…` 定义', () => {
    const expected: ReadonlyArray<readonly [string, string, number]> = [
      ['ERB/SYSTEM/NEWGAME.ERB', 'EVENTFIRST', 76],
      ['ERB/SYSTEM/SAVELOAD.ERB', 'EVENTLOAD', 441],
      ['ERB/SHOP/SHOP.ERB', 'EVENTSHOP', 6],
      ['ERB/SHOP/SHOP.ERB', 'EVENTBUY', 113],
    ];
    for (const [rel, engine, line] of expected) {
      const lines = readFileSync(nodeJoin(ERAFL_ROOT, rel), 'utf8').split(/\r?\n/);
      // 去掉 BOM 再比（eraFL 的 ERB 全树 UTF-8 BOM）
      expect(lines[line - 1]!.replace(/^\uFEFF/, '').trim()).toBe(`@${engine}`);
    }
  });

  itReal('五个缺席的事件在树里没有函数定义（TURNEND/COMEND 只有 eraFL 自己的流程函数）', () => {
    // 反向证据逐条钉在文件:行 上——"名字像"不等于"是引擎事件"：
    const turnend = readFileSync(nodeJoin(ERAFL_ROOT, 'ERB/SYSTEM/TURNEND.ERB'), 'utf8').split(/\r?\n/);
    expect(turnend[3]!.replace(/^\uFEFF/, '').trim()).toBe('@FL_EVENTTURNEND');
    const questMain = readFileSync(nodeJoin(ERAFL_ROOT, 'ERB/QUEST/QUEST_MAIN.ERB'), 'utf8').split(/\r?\n/);
    expect(questMain[217]!.replace(/^\uFEFF/, '').trim()).toBe('@QST_EVENTCOMEND()');
    // 事件表本身一条都不许含它们（合成层已钉，这里钉真盘侧没有第二定义）
    for (const engine of ['EVENTTRAIN', 'EVENTCOM', 'EVENTEND', 'EVENTTURNEND', 'EVENTCOMEND']) {
      expect(ERAFL_EVENT_CATALOG.events.some((e) => e.engine === engine)).toBe(false);
    }
  });

  itReal('五条状态线的 CFLAG 编号与 CSV 名表逐条一致', () => {
    const csv = readFileSync(nodeJoin(ERAFL_ROOT, 'CSV/CFLAG.CSV'), 'utf8');
    const indexOf = (name: string): string => {
      const hit = csv.split(/\r?\n/).find((line) => line.replace(/^\uFEFF/, '').split(',')[1] === name);
      return hit!.split(',')[0]!;
    };
    for (const attribute of ERAFL_DOMAIN_SYMBOLS.attributes) {
      expect(indexOf(attribute.name)).toBe(String(attribute.index));
    }
  });

  itReal('壳函数抽样：UTF-8 BOM + CRLF（编码策略的缺省形态）', () => {
    const shell = nodeJoin(ERAFL_ROOT, 'ERB/口上/10_蒂娅/KOJO_DEFINE_K10.ERB');
    const bytes = readFileSync(shell);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = bytes.toString('utf8');
    expect(text).toContain('\r\n');
  });

  itReal('代词落点：口上 XML 里 [$KNAME]/[$MNAME]/[$TNAME] 三轴都在用（头注计数的下限复算）', () => {
    // 头注的 2,875 / 6,951 / 740 是全树 XML 读数；这里扫口上域全部 XML，
    // 用下限断言防"表与语料脱节"——读数只会比这更高，不会更低。
    const kojoRoot = nodeJoin(ERAFL_ROOT, 'ERB/口上');
    const walk = (dir: string, out: string[]): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = nodeJoin(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.xml$/i.test(entry.name)) out.push(full);
      }
      return out;
    };
    const counts = { kname: 0, mname: 0, tname: 0 };
    for (const file of walk(kojoRoot, [])) {
      const text = readFileSync(file, 'utf8');
      counts.kname += (text.match(/\[\$KNAME\]/g) ?? []).length;
      counts.mname += (text.match(/\[\$MNAME\]/g) ?? []).length;
      counts.tname += (text.match(/\[\$TNAME\]/g) ?? []).length;
    }
    expect(counts.kname).toBeGreaterThanOrEqual(1000);
    expect(counts.mname).toBeGreaterThanOrEqual(1000);
    expect(counts.tname).toBeGreaterThanOrEqual(100);
    // 口上域（说话人战场）确实读得到东西——空目录会让上面的断言变成永绿
    expect(walk(kojoRoot, []).length).toBeGreaterThan(0);
  });
});
