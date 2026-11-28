/**
 * 引擎档位锁（P1-6）——era 适配器声明目标引擎档，本判据钉四件事：
 *
 * (a) **声明集 = 证据集**：扫全部插件包 `src/constants.ts` 里的
 *     `ENGINE_PROFILE_LOCK` 声明，恰四个、逐个对得上证据（引擎系谱实测或词面差集）；
 *     想加第五个锁，先拿证据来，这里会红。
 * (b) **eratw = snake 结构锁**：erb-parser 指令表 === snake 无条件指令面
 *     （324 词双向零差集，VARI/VARS 条件注册除外）；内建表 vs snake 函数面的
 *     27 名差集 = 25 个 eratw fork 表达式扩展 + 2 个双形态，逐名钉死。
 * (c) **上游欠账 45 名钉死**：snake 函数面有、eratw registry（⇒ kojo 内建表）没有——
 *     这是补全/悬停的已知缺口，填账需上游 C# 签名提取，另案；清单变更必须过此判据。
 * (d) **erafl = em_ee 词面锁**：129 词差集全数落 em_ee 面（VARI/VARS 走条件注册）；
 *     v24 缺 53 词判死下界；与 snake-only 词零交集 ⇒ 词面证据升不到 snake，
 *     按最小充分档锁 em_ee。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ERB_ENGINE_PROFILES,
  erbEngineStatementFace,
} from '../../plugin-api/src/erb-engine-profiles';
import { BUILTIN_FUNCTION_NAMES } from '../../plugins/erb-parser/src/builtins';
import { ERB_INSTRUCTION_NAMES } from '../../plugins/erb-parser/src/instructions';
import { ENGINE_PROFILE_LOCK as ERAAKUMAMAID_LOCK } from '../../plugins/eraakumamaid-adapter/src/constants';
import { ENGINE_PROFILE_LOCK as ERAFL_LOCK } from '../../plugins/erafl-adapter/src/constants';
import { ENGINE_PROFILE_LOCK as ERATOHOREVERSE_LOCK } from '../../plugins/eratohoreverse-adapter/src/constants';
import { ENGINE_PROFILE_LOCK as ERATW_LOCK } from '../../plugins/eratw-adapter/src/constants';
import { ERAFL_EXTRA_DIRECTIVES } from '../../plugins/erafl-adapter/src/instruction-table';

const byId = new Map(ERB_ENGINE_PROFILES.map((p) => [p.id, p]));
const faceSet = (id: string): Set<string> => new Set(erbEngineStatementFace(id));

/**
 * eratw core-vm 注册、而四档上游面**全无**的表达式扩展（fork 自带：ENTITY 族 20 +
 * CHARA_TO_ENTITY / ROSTER_GENERATION / HAS_SUPER / MOD_IS_ACTIVE / SPRITEANIMEFRAME）。
 * 源头是 eratw-android 的 Builtins.registry 反射 dump；eraTW 玩家侧跑的也是这个 fork。
 */
const ERATW_FORK_EXPRESSION_ONLY: readonly string[] = [
  'CHARA_TO_ENTITY',
  'ENTITY_ADD_REL',
  'ENTITY_CREATE',
  'ENTITY_DEL_REL',
  'ENTITY_DESTROY',
  'ENTITY_EXISTS',
  'ENTITY_GET_INT',
  'ENTITY_GET_STATE',
  'ENTITY_GET_STR',
  'ENTITY_HAS_REL',
  'ENTITY_PROJECT_CHARA',
  'ENTITY_QUERY_COUNT',
  'ENTITY_QUERY_FILL',
  'ENTITY_QUERY_REL_COUNT',
  'ENTITY_QUERY_REL_FILL',
  'ENTITY_RAND',
  'ENTITY_SET_INT',
  'ENTITY_SET_STATE',
  'ENTITY_SET_STR',
  'ENTITY_TO_CHARA',
  'ENTITY_UNPROJECT_CHARA',
  'HAS_SUPER',
  'MOD_IS_ACTIVE',
  'ROSTER_GENERATION',
  'SPRITEANIMEFRAME',
];

/** 上游 snake 只有语句形（snake.commands 在档）、eratw registry 另给了表达式形。 */
const ERATW_DUAL_FORM: readonly string[] = ['BITMAP_CACHE_ENABLE', 'SETANIMETIMER'];

/**
 * 上游 snake 函数面（349）有、eratw registry（331 的真源）未注册 ⇒ kojo 内建表暂缺。
 * 真机（PC 上游引擎）能用、编辑器不认识的名字——补全缺口的欠账清单。
 * 填账注意按形态分流：DISABLE/ENABLE_INPUT_MACRO 在 core-vm 是语句别名
 * （OpcodeTable.kt StatementAlias），MAP_VALUES 在 EngineProfileData 裁剪名单，
 * SQL 族 / G_POLYGON 族 / BITGET 族才是纯表达式函数。签名真值需上游 C#
 * FunctionMethodCreator 提取，另案；谁被 port 了就从这里摘掉（这里会红提醒）。
 */
const UPSTREAM_SNAKE_FUNCTION_GAP: readonly string[] = [
  'ACOS',
  'ARGLEN',
  'ASIN',
  'ATAN',
  'BITGET',
  'BITINDEXOFFIRST',
  'BITSET',
  'BITTOGGLE',
  'CEIL',
  'COS',
  'DISABLE_INPUT_MACRO',
  'DT_CELL_GETF',
  'ENABLE_INPUT_MACRO',
  'EVAL',
  'EVALF',
  'EVALS',
  'EXISTSIMAGELAYER',
  'EXIST_IN_CSV',
  'EXIST_IN_ERD',
  'FLOOR',
  'GETCSVNOBYCALLNAME',
  'GETCSVNOBYMASTERNAME',
  'GETCSVNOBYNAME',
  'GETCSVNOBYNICKNAME',
  'GETLINEY',
  'GETMETHF',
  'GETVARF',
  'GET_SKIA_QUALITY',
  'GET_TEXT_DRAWING_MODE',
  'G_POLYGON_DRAW',
  'G_POLYGON_FILL',
  'G_POLYGON_POINT_ADD',
  'G_POLYGON_POINT_CLEAR',
  'MAP_FROMSTRING',
  'MAP_VALUES',
  'MATCHALL',
  'MATCHALLEX',
  'SEQUENCEINPUT',
  'SIN',
  'SPRITECREATEFROMFILE',
  'STRFORMCHECK',
  'TAN',
  'TOSTRF',
  'UNCHECKED_NEG',
  'UNCHECKED_SUB',
];

describe('引擎档位锁（每适配器一档，声明集 = 证据集）', () => {
  it('(a) 全仓恰四档声明，逐个对得上证据', () => {
    const declared: Record<string, string> = {};
    const pluginsDir = new URL('../../plugins/', import.meta.url);
    for (const dir of readdirSync(pluginsDir)) {
      let text: string;
      try {
        text = readFileSync(new URL(`../../plugins/${dir}/src/constants.ts`, import.meta.url), 'utf8');
      } catch {
        continue; // 没有 constants.ts 的包不可能是锁档声明方
      }
      const m = /export const ENGINE_PROFILE_LOCK = '([a-z_0-9]+)' as const;/.exec(text);
      if (m) declared[dir] = m[1]!;
    }
    expect(declared).toEqual({
      'eraakumamaid-adapter': 'v24', // 引擎「Emuera 1824+v18 私家改造版」（constants 头注实测）
      'erafl-adapter': 'em_ee', // 129 词差集判据，见 (d)
      'eratohoreverse-adapter': 'v24', // 引擎 Emuera1824+v1.exe（constants 头注真盘实测）
      'eratw-adapter': 'snake', // 项目复刻目标 4.981（snake）
    });
    expect(ERATW_LOCK).toBe('snake');
    expect(ERAFL_LOCK).toBe('em_ee');
    expect(ERAAKUMAMAID_LOCK).toBe('v24');
    expect(ERATOHOREVERSE_LOCK).toBe('v24');
    for (const id of Object.values(declared)) {
      expect(byId.has(id), `锁档 ${id} 必须在 profile 表内`).toBe(true);
    }
  });

  it('(b-1) eratw/snake 结构锁：指令表 === snake 无条件指令面（双向零差集）', () => {
    const snake = byId.get('snake')!;
    const unconditional = snake.commands.filter((n) => !(n in snake.conditionalCommands));
    expect([...ERB_INSTRUCTION_NAMES].sort()).toEqual([...unconditional].sort());
  });

  it('(b-2) 内建表 vs snake.functions：27 名差集 = 25 fork 扩展 + 2 双形态，逐名钉死', () => {
    const snakeFn = new Set(byId.get('snake')!.functions);
    const missing = BUILTIN_FUNCTION_NAMES.filter((n) => !snakeFn.has(n)).sort();
    expect(missing).toEqual([...ERATW_FORK_EXPRESSION_ONLY, ...ERATW_DUAL_FORM].sort());
    // fork 扩展在四档上游面全部缺席
    const faces = ['cs_reference', 'em_ee', 'snake', 'v24'].map(faceSet);
    for (const n of ERATW_FORK_EXPRESSION_ONLY) {
      for (const f of faces) expect(f.has(n), `${n} 不该在任何上游面`).toBe(false);
    }
    // 双形态：上游只有语句形（snake.commands 在档），eratw registry 另给了表达式形
    const snakeCmd = new Set(byId.get('snake')!.commands);
    for (const n of ERATW_DUAL_FORM) expect(snakeCmd.has(n), n).toBe(true);
  });

  it('(c) 上游欠账 45 名钉死（snake.functions − 内建表）；谁被 port 谁出列', () => {
    const builtins = new Set(BUILTIN_FUNCTION_NAMES);
    const gap = [...byId.get('snake')!.functions].filter((n) => !builtins.has(n)).sort();
    expect(gap).toEqual([...UPSTREAM_SNAKE_FUNCTION_GAP].sort());
    expect(gap).toHaveLength(45);
  });

  it('(d-1) erafl 129 词差集全数 ∈ em_ee 面 ∪ 条件注册（VARI/VARS 开关开着）', () => {
    const em = byId.get('em_ee')!;
    const allow = new Set([...erbEngineStatementFace('em_ee'), ...Object.keys(em.conditionalCommands)]);
    expect(ERAFL_EXTRA_DIRECTIVES.filter((n) => !allow.has(n))).toEqual([]);
    // VARI/VARS 是 eraFL 语料里出现次数最高的两词，必须走条件注册通道放行
    expect(ERAFL_EXTRA_DIRECTIVES).toContain('VARI');
    expect(ERAFL_EXTRA_DIRECTIVES).toContain('VARS');
  });

  it('(d-2) 下界判死 v24（缺 53 词）；上界升不到 snake（与 snake-only 词零交集）', () => {
    const v24 = faceSet('v24');
    expect(ERAFL_EXTRA_DIRECTIVES.filter((n) => !v24.has(n))).toHaveLength(53);
    const em = faceSet('em_ee');
    const snakeOnly = [...faceSet('snake')].filter((n) => !em.has(n));
    expect(ERAFL_EXTRA_DIRECTIVES.filter((n) => snakeOnly.includes(n))).toEqual([]);
  });
});
