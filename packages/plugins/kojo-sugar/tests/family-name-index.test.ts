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
 */
const TABLES: Record<string, [string, string][]> = {
  EX: [
    ['0', 'Ｃ絶頂'],
    ['1', 'Ｖ絶頂'],
    ['10', '噴乳'],
    ['11', '射精'],
    ['55', 'TotalEX'],
  ],
  BASE: [['0', '胸部開発']],
  MARK: [['0', '刻印Ａ']],
  STAIN: [['0', '污渍Ａ']],
  CFLAG: [['1088', '好感度']],
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
      sourcePath: 'ERB/KOJO/M_KOJO_K12_指令.kojo',
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
