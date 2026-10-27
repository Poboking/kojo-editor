/**
 * P-10③「族头直通改条件校验」（看板 §E；铁律 4：拼错名不得静默进产物）。
 *
 * 病根：族头认得出就整串放行 ⇒ `如果 NOWEX:噴乳乳瞎写：` 零诊断直接进转译产物。
 * 修法口径（提案 §3b③ 定死）：**有表则校验、无表则放行** + **严重度 warning 起步**
 * （真实语料实测的表外写法里含动态索引与汉化追加名，直接 error 必误伤）。
 *
 * 装配不依赖游戏盘：字典用本文件自带的 `VariableSchema` 桩（`lookup` 语义逐条照抄
 * adapter `variable-schema.ts`：表不存在 → undefined；具名/编号收录 → 带 description
 * 与 resolvedIndex；未收录 → 只回显，两者都不带）。真盘代价读数由一次性探针跑过
 * （2026-10-14：整个 `口上・メッセージ関連` 2,317 份 `.ERB` 的代码行里，本核对只判出
 * 7 处 / 3 个名，`NOWEX:i`×2、`NOWEX:COUNT`×1、汉化追加名 `Ｖ绝顶`×4 ⇒ 判据层见 §A）。
 *
 * 每条正向断言都配**负自证**（改一个字符必须被抓出），防止断言空转。
 */

import { describe, expect, it } from 'vitest';
import type { SugarDiagnostic, VariableSchema, VariableInfo } from '@kojo/plugin-api';
import { makeLookup } from '../src/index';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';
import { stubDict, stubFaceTable } from './support';

/* ================================ 装配夹具 ================================ */

/**
 * 名称表桩：`编号 → 名称`（与 eraTW `CSV/ex.csv` 同形态）。
 * **注意**没有 `NOWEX.csv` / `DOWNBASE.csv`——era 系里这两个族的名字就住在
 * `EX` / `BASE` 表上，正是 `index.ts` 那条"同名表候选"要解决的现实。
 *
 * ALS 批追加的那些表，**同编号写两行**就是盘上"主表 + `.als` 追加名表"并入后的形态
 * （每行的取值与行号都逐字对过 `C:\Game\eratw-画蛇添足版eratw4.980\CSV\`）。
 */
const TABLES: Record<string, [string, string][]> = {
  EX: [
    ['0', 'Ｃ絶頂'],
    ['1', 'Ｖ絶頂'],
    ['10', '噴乳'],
    ['11', '射精'],
    ['55', 'TotalEX'],
    ['1', 'Ｖ绝顶'], // ex.als:2
  ],
  BASE: [
    ['0', '胸部開発'],
    ['10', 'ムード'], // Base.csv:10
    ['10', '情绪'], // Base.als:10（简写）
    ['10', '情緒'], // Base.als:11（繁写）——同编号双写是 `.als` 的常态
  ],
  MARK: [['0', '刻印Ａ']],
  STAIN: [['0', '污渍Ａ']],
  CFLAG: [['1088', '好感度']],
  FLAG: [['1', 'SYS_EVENT起動FLAG'], ['73', '约会的对象'], ['73', 'デート相手']], // FLAG.csv:2 / :63 / FLAG.als:64
  TFLAG: [['109', '被逆推開始時間'], ['109', '押し倒され開始時間']], // TFLAG.csv:59 / TFLAG.als:59
  TEQUIP: [['13', '振動棒'], ['13', 'バイブ']], // Tequip.csv:16 / Tequip.als:16
  // ↓ 以下族头**不入库**（读数见 `index.ts` 的表）：表在位、`.als` 别名也在位，但族头不判
  PALAM: [['9', '潤滑'], ['9', '润滑']], // Palam.csv:6 / Palam.als:6
  TCVAR: [['145', '烂醉'], ['145', '泥酔']], // TCVAR.csv:83 / TCVAR.als:76
  TALENT: [['10', '胆量'], ['10', '度胸']], // Talent.csv:16 / Talent.als:16
  ABL: [['9', '親密'], ['9', '亲密']], // Abl.csv:9 / Abl.als:9
  EXP: [['26', '乳交経験'], ['26', 'パイズリ経験']], // exp.csv:31 / exp.als:32
  SOURCE: [['51', '侮辱'], ['51', '辱め']], // source.csv:35 / source.als:35
  ITEM: [['6', 'アナルビーズ']], // Item.als:7（主表 Item.csv:7 里 6 号是 `;6,後庭拉珠` 注释掉的）
  EQUIP: [['1', 'アクセサリ']], // Equip.als:1
  CSTR: [['15', 'モブ子能力']], // CSTR.als:19
  DAY: [['2', '季節']], // DAY.csv:3（`DAY.als:3` 的名称段带行内 `;` 尾巴，见 adapter 侧测试）
  JUEL: [['9', '潤滑'], ['9', '润滑']], // Juel.csv:6 / Juel.als:6
};

/** adapter 同语义的 `lookup`（表不在位 → undefined；未收录 → 只有回显，无 description） */
function schemaOf(tables: Record<string, [string, string][]>): VariableSchema {
  const parsed = new Map<string, { byIndex: Map<string, string>; byName: Map<string, string> }>();
  for (const [key, rows] of Object.entries(tables)) {
    const byIndex = new Map<string, string>();
    const byName = new Map<string, string>();
    for (const [idx, name] of rows) {
      if (!byIndex.has(idx)) byIndex.set(idx, name);
      if (!byName.has(name)) byName.set(name, idx);
    }
    parsed.set(key.toUpperCase(), { byIndex, byName });
  }
  return {
    version: 'probe',
    lookup(variableName: string, index?: number | string): VariableInfo | undefined {
      const table = parsed.get(variableName.toUpperCase());
      if (!table) return undefined;
      if (index === undefined) return { name: variableName.toUpperCase() };
      const idx = String(index);
      const byIdx = table.byIndex.get(idx);
      if (byIdx !== undefined) {
        return { name: variableName.toUpperCase(), index, description: byIdx, resolvedIndex: Number(idx) };
      }
      const back = table.byName.get(idx);
      if (back !== undefined) {
        return { name: variableName.toUpperCase(), index, description: idx, resolvedIndex: Number(back) };
      }
      return { name: variableName.toUpperCase(), index };
    },
  };
}

/** 生效字典 = 生产路径的同一个适配器（`index.ts` 装配时正是这么造的） */
const dict = (): DictionaryLookup => makeLookup(schemaOf(TABLES));
const svc = () => createSugarTranspileService({ dictionary: dict(), faceTable: stubFaceTable() });
/** 无字典装配（= 未打开项目 / adapter 缺席） */
const svcNoDict = () => createSugarTranspileService({ faceTable: stubFaceTable() });
/** 旧字典形态（不提供 `unlistedFamilyName`；E16 批的 `stubDict` 就是这一类） */
const svcLegacyDict = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;
const cond = (expr: string): string => doc(`    如果 ${expr}：\n        「涩涩的话」\n`);

const allOf = (src: string): SugarDiagnostic[] => svc().transpile(src).diagnostics;
const errorsOf = (src: string): SugarDiagnostic[] => allOf(src).filter((d) => d.severity === 'error');
const familyWarns = (diags: SugarDiagnostic[]): SugarDiagnostic[] =>
  diags.filter((d) => d.code === 'family-name-unknown');

/* ============================================================= */
/* A. 判据层：`makeLookup().unlistedFamilyName` 的口径             */
/* ============================================================= */

describe('P-10③-A 判据层（有表则校验、无表则放行）', () => {
  it('表内名零判据——含经姊妹表 `EX` 命中的具名（游戏目录里没有 NOWEX.csv）', () => {
    const l = dict();
    for (const name of ['噴乳', '射精', 'Ｃ絶頂', 'TotalEX']) {
      expect(l.unlistedFamilyName?.(`NOWEX:${name}`), `NOWEX:${name} 应在表内`).toBeUndefined();
    }
  });

  it('表外名给出判据（族头 + 名称段原样交回，供调用方措辞）', () => {
    expect(dict().unlistedFamilyName?.('NOWEX:噴乳乳瞎写')).toEqual({ family: 'NOWEX', name: '噴乳乳瞎写' });
  });

  it('负自证：表内名改一个字符必须被抓出', () => {
    expect(dict().unlistedFamilyName?.('NOWEX:噴乳乳')).toEqual({ family: 'NOWEX', name: '噴乳乳' });
    expect(dict().unlistedFamilyName?.('NOWEX:TotalEXX')).toEqual({ family: 'NOWEX', name: 'TotalEXX' });
  });

  it('纯数字索引一律放行（`NOWEX:10` / `CFLAG:1088` 是引擎合法写法，没有名称表可核）', () => {
    expect(dict().unlistedFamilyName?.('NOWEX:10')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('NOWEX:0')).toBeUndefined();
  });

  it('三段及以上作用域写法本批不碰（`NOWEX:PLAYER:11`、`MARK:TARGET:x`——实测表外率高，误伤面大）', () => {
    expect(dict().unlistedFamilyName?.('NOWEX:PLAYER:11')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('MARK:TARGET:刻印Ａ')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('MARK:TARGET:刻印瞎写')).toBeUndefined();
  });

  it('族头大小写归一（ERB 侧写法是全大写，作者手写小写同样判得出）', () => {
    expect(dict().unlistedFamilyName?.('nowex:噴乳乳瞎写')).toEqual({ family: 'NOWEX', name: '噴乳乳瞎写' });
  });

  it('未登记的族头不核对（本批按实测表权威收窄：CFLAG/TALENT 等的字典不全，判了就是误伤）', () => {
    expect(dict().unlistedFamilyName?.('CFLAG:好感度度')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('TALENT:恋慕')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('NOTAFAMILY:噴乳')).toBeUndefined();
  });

  it('无表则放行：族头登记了但字典里那张表根本不在位（未打开工程 / adapter 未给该表）', () => {
    const noMark = makeLookup(schemaOf({ EX: TABLES.EX ?? [], BASE: TABLES.BASE ?? [] }));
    expect(noMark.unlistedFamilyName?.('STAIN:随便什么名')).toBeUndefined();
    // `MARK` 表缺席时连表外名也不判——"字典缺席不误伤"优先于"抓拼错"
    expect(noMark.unlistedFamilyName?.('MARK:刻印瞎写')).toBeUndefined();
    // 而 `NOWEX`（经 `EX` 表）在位 ⇒ 照判
    expect(noMark.unlistedFamilyName?.('NOWEX:噴乳乳瞎写')).toEqual({ family: 'NOWEX', name: '噴乳乳瞎写' });
  });

  it('名称段为空 / 形态不整（`NOWEX:`、`NOWEX`）一律放行', () => {
    expect(dict().unlistedFamilyName?.('NOWEX:')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('NOWEX')).toBeUndefined();
  });

  it('生效族里的 `MARK` / `DOWNBASE`（经 `BASE` 表）同样判得出，表内名不判', () => {
    expect(dict().unlistedFamilyName?.('MARK:刻印瞎写')).toEqual({ family: 'MARK', name: '刻印瞎写' });
    expect(dict().unlistedFamilyName?.('MARK:刻印Ａ')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('DOWNBASE:胸部開発')).toBeUndefined();
    expect(dict().unlistedFamilyName?.('DOWNBASE:胸部開発瞎写')).toEqual({
      family: 'DOWNBASE',
      name: '胸部開発瞎写',
    });
  });

  it('既有两条入口零改动：`resolve` 仍整串放行、`resolveFamily` 仍按族表找归属', () => {
    const l = dict();
    expect(l.resolve('NOWEX:噴乳乳瞎写')).toBe('NOWEX:噴乳乳瞎写'); // 改写产物不是本批的事
    expect(l.resolve('SELECTCOM')).toBeUndefined();
    expect(l.resolveFamily('噴乳')).toBeUndefined(); // `EX` 不属 ENGINE_VARIABLE_FAMILIES，本批不动那张清单
    expect(l.resolveFamily('好感度')).toBe('CFLAG');
  });
});

/* ============================================================= */
/* B. 服务层：诊断口径（warning 起步、产物照旧、不静默）          */
/* ============================================================= */

describe('P-10③-B 转译层：表内名零诊断 / 表外名必出一条 warn', () => {
  it('`NOWEX:噴乳`（表内）→ 一条诊断都没有，产物逐字如常', () => {
    const src = cond('NOWEX:噴乳 == 1');
    expect(allOf(src)).toEqual([]);
    expect(svc().transpile(src).erb).toContain('IF NOWEX:噴乳 == 1');
  });

  it('`NOWEX:噴乳乳瞎写`（表外）→ 恰 1 条 `family-name-unknown` / severity=warning / 定位到条件行', () => {
    const src = cond('NOWEX:噴乳乳瞎写 == 1');
    const diags = allOf(src);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.code).toBe('family-name-unknown');
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('噴乳乳瞎写');
    expect(d.message).toContain('NOWEX');
    expect(d.loc?.line, '诊断须落在条件所在行（第 3 行）').toBe(3);
    expect(errorsOf(src)).toEqual([]); // 不是 error——warn 起步
  });

  it('产物不再静默的口径 = **进产物但带 warn**：该行仍原样写进 ERB（引擎侧另有约定时不拦人）', () => {
    const r = svc().transpile(cond('NOWEX:噴乳乳瞎写 == 1'));
    expect(r.erb).toContain('IF NOWEX:噴乳乳瞎写 == 1');
    expect(familyWarns(r.diagnostics)).toHaveLength(1);
  });

  it('warn 不拦保存前置检查（`planSave` 只因 error 而 blocked）', () => {
    const plan = svc().planSave({
      source: cond('NOWEX:噴乳乳瞎写 == 1'),
      sourcePath: 'ERB/KOJO/M_KOJO_K12_指令.kojo1',
    });
    expect(plan.transpile.diagnostics.some((d) => d.code === 'family-name-unknown')).toBe(true);
    expect(plan.blocked).toBe(false);
    expect(plan.erbPath).toBe('ERB/KOJO/M_KOJO_K12_指令.ERB');
  });

  it('四条降糖路径都报、且同一条各只报一处（不重复刷屏）', () => {
    const cases: [string, string][] = [
      ['条件', cond('NOWEX:噴乳乳瞎写 == 1')],
      ['当 主语', doc('    当 NOWEX:噴乳乳瞎写：\n        是 1：\n            「x。」\n')],
      ['别名右值', `角色: 12\n别名 甲 = NOWEX:噴乳乳瞎写\n时机 指令 310：\n    如果 甲：\n        「x。」\n`],
      ['插值', doc('    「{NOWEX:噴乳乳瞎写}」\n')],
      ['台词行表达式', doc('    她 NOWEX:噴乳乳瞎写 = 1\n')],
    ];
    for (const [label, src] of cases) {
      const warns = familyWarns(allOf(src));
      expect(warns, `${label} 应恰好 1 条具名索引 warn`).toHaveLength(1);
      expect(warns[0]!.code).toBe('family-name-unknown');
    }
  });

  it('动态索引形态不报：名称段是裸引擎全局（语料实有 `IF NOWEX:i` / `SIF NOWEX:COUNT`）', () => {
    expect(allOf(cond('NOWEX:COUNT == 1'))).toEqual([]);
  });

  it('E16 那批的三条读数在**带核对的字典**下依旧成立（零回归护栏，不改现有用例）', () => {
    // 裸引擎全局照旧放行
    expect(errorsOf(cond('SELECTCOM == 20'))).toEqual([]);
    expect(allOf(cond('SELECTCOM == 20'))).toEqual([]);
    // 全角拉丁字母的具名索引（表内）零诊断
    expect(allOf(cond('NOWEX:Ｃ絶頂 == 3'))).toEqual([]);
    // `LOCAL` 是段块糖的信封槽，白名单不收 ⇒ 仍报 error
    expect(errorsOf(cond('LOCAL == 1')).map((d) => d.code)).toContain('unknown-identifier');
  });
});

/* ============================================================= */
/* C. 宽容口径：字典缺席 / 旧字典形态 = 今天的行为                 */
/* ============================================================= */

describe('P-10③-C 无字典装配零误伤（"未打开项目不误伤"钉死）', () => {
  it('无字典（`createSugarTranspileService({ faceTable })`）下 `NOWEX:噴乳乳瞎写` 仍静默放行', () => {
    const src = cond('NOWEX:噴乳乳瞎写 == 1');
    const r = svcNoDict().transpile(src);
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('IF NOWEX:噴乳乳瞎写 == 1');
  });

  it('旧字典形态（不提供 `unlistedFamilyName`）同样零诊断——契约是可选能力，不硬要', () => {
    const r = svcLegacyDict().transpile(cond('NOWEX:噴乳乳瞎写 == 1'));
    expect(r.diagnostics).toEqual([]);
    expect(r.erb).toContain('IF NOWEX:噴乳乳瞎写 == 1');
  });

  it('字典只提供属性查询（`resolveFamily`/`resolve`）而无核对 → 属性路径行为不变', () => {
    const bare: DictionaryLookup = {
      resolveFamily: (name: string) => (name === '好感度' ? 'CFLAG' : undefined),
      resolve: () => undefined,
    };
    const s = createSugarTranspileService({ dictionary: bare, faceTable: stubFaceTable() });
    expect(s.transpile(doc('    如果 她的好感度 > 0：\n        「x。」\n')).diagnostics).toEqual([]);
    const warn = s.transpile(cond('NOWEX:噴乳乳瞎写'));
    expect(warn.diagnostics).toEqual([]);
  });
});

/* ============================================================= */
/* D. ALS 批：`CSV/*.als` 进字典后的扩族面                        */
/* ============================================================= */

describe('ALS-D 扩族登记面：入库族判得出、不入库族逐族钉死不判', () => {
  it('入库新族 `BASE` / `FLAG` / `TFLAG` / `TEQUIP`：`.als` 别名放行、瞎写判得出', () => {
    const l = dict();
    // `.als` 的简繁双写都在表里 ⇒ 两种写法都不判（BASE 实测 711 条表外全部由 `.als` 消掉）
    for (const ref of ['BASE:情绪', 'BASE:情緒', 'BASE:ムード', 'FLAG:デート相手', 'FLAG:约会的对象', 'TFLAG:押し倒され開始時間', 'TEQUIP:バイブ']) {
      expect(l.unlistedFamilyName?.(ref), `${ref} 应在表内`).toBeUndefined();
    }
    for (const ref of ['BASE:情緒瞎写', 'FLAG:デート相手瞎写', 'TFLAG:押し倒され開始時間瞎写', 'TEQUIP:バイブ瞎写']) {
      const head = ref.slice(0, ref.indexOf(':'));
      const name = ref.slice(head.length + 1);
      expect(l.unlistedFamilyName?.(ref), `${ref} 应判表外`).toEqual({ family: head, name });
    }
  });

  it('`TEQUIP:震动棒`（语料实有：`M_KOJO_K55_絶頂.ERB:217`）判得出 = 真阳性，不是误伤', () => {
    // 表内是 `振動棒`（主表）/ `バイブ`（追加表），作者写的 `震动棒` 首字就不同 ⇒ 引擎取不到值
    expect(dict().unlistedFamilyName?.('TEQUIP:震动棒')).toEqual({ family: 'TEQUIP', name: '震动棒' });
  });

  it('既有四族在并入 `.als` 后判据不变（`NOWEX:Ｖ绝顶` 由追加名表救回，其余逐字如旧）', () => {
    const l = dict();
    expect(l.unlistedFamilyName?.('NOWEX:Ｖ绝顶')).toBeUndefined(); // ← ex.als 的功劳（P-10③ 曾判表外 4 次）
    expect(l.unlistedFamilyName?.('NOWEX:噴乳乳瞎写')).toEqual({ family: 'NOWEX', name: '噴乳乳瞎写' });
    expect(l.unlistedFamilyName?.('MARK:刻印瞎写')).toEqual({ family: 'MARK', name: '刻印瞎写' });
    expect(l.unlistedFamilyName?.('DOWNBASE:胸部開発')).toBeUndefined();
    expect(l.unlistedFamilyName?.('STAIN:污渍Ａ')).toBeUndefined();
  });

  it('**不入库族逐族钉死**：表在位、`.als` 别名也在位，族头不登记就一条都不判', () => {
    const l = dict();
    // `SOURCE` 已由 ALS-R2 入库（生产判据三盘判表外 0/0/0），故从这张清单里移出
    const DECLINED = ['CFLAG', 'TALENT', 'TCVAR', 'ABL', 'PALAM', 'EXP', 'ITEM', 'EQUIP', 'CSTR', 'DAY', 'JUEL', 'EX'];
    for (const family of DECLINED) {
      // 连"一眼假"的名字都不判——扩族只按读数放行，不许顺手把误伤面打开
      expect(l.unlistedFamilyName?.(`${family}:肯定不在表里的瞎写名`), `${family} 不该被核对`).toBeUndefined();
    }
  });

  it('`SOURCE` 入库（ALS-R2）：表内名放行、表外名判得出', () => {
    const l = dict();
    // `source.csv:35 = 51,侮辱` / `source.als:35 = 51,辱め`（夹具同一形态）
    expect(l.unlistedFamilyName?.('SOURCE:侮辱')).toBeUndefined();
    expect(l.unlistedFamilyName?.('SOURCE:辱め')).toBeUndefined();
    expect(l.unlistedFamilyName?.('SOURCE:侮辱瞎写')).toEqual({ family: 'SOURCE', name: '侮辱瞎写' });
  });

  it('`PALAM:润滑` 仍不判（**本批明知可判而不判**：残余 42/43 是 `PALAM:LOCAL` 作用域形态）', () => {
    const l = dict();
    // 名字确实被 `.als` 带进字典了（负自证：换成登记族就判得出）
    expect(l.unlistedFamilyName?.('PALAM:润滑')).toBeUndefined();
    expect(l.unlistedFamilyName?.('PALAM:LOCAL')).toBeUndefined();
    // 同一张表的姊妹写法在登记族里就判得出 ⇒ 上面两条"不判"是族头登记决定的，不是查不到
    expect(l.unlistedFamilyName?.('BASE:润滑')).toEqual({ family: 'BASE', name: '润滑' });
  });

  it('转译层：登记族的表外名 → 恰 1 条 warning、产物原样；不登记族 → 0 条', () => {
    const on = svc().transpile(cond('BASE:情緒瞎写 == 1'));
    expect(familyWarns(on.diagnostics)).toHaveLength(1);
    expect(on.diagnostics[0]!.severity).toBe('warning');
    expect(on.erb).toContain('IF BASE:情緒瞎写 == 1');

    const off = svc().transpile(cond('TCVAR:泥酔瞎写 == 1'));
    expect(familyWarns(off.diagnostics)).toHaveLength(0);
    expect(off.erb).toContain('IF TCVAR:泥酔瞎写 == 1');
  });

  it('登记族的名字经 `.als` 才查得到时，属性路径（`她的X`）也随之多命中一条', () => {
    // `BASE:情绪` 是追加名表给的：属性反查（resolveFamily）现在认得它
    expect(dict().resolveFamily('情绪')).toBe('BASE');
    expect(dict().resolveFamily('情緒')).toBe('BASE');
    expect(dict().nameAt?.('BASE', '10')).toBe('ムード'); // 编号侧仍是主表的名称（不被覆盖）
  });
});
