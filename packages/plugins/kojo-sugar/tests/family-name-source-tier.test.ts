/**
 * ALS-R1「来源分层」+ ALS-R2「`SOURCE` 入库 / 被截断的三段形放行」——判据层单测（不依赖游戏盘）。
 *
 * 治的两个真缺陷：
 * 1. **R1 族归属漂移**：字典的三层数据源（主表 `*.csv` / 追加名表 `*.als` / 作者自定常量
 *    `*.ERH`）在 `resolveFamily` 眼里过去**不分层**，按族表顺序取首个"收录"⇒
 *    后两层把更早主表的归属抢走。盘上实例：`憤怒` 原判 `TCVAR`（`TCVAR.csv:70`）被
 *    `Base.als` 的别名改成 `BASE`；`教養` 原判 `ABL`（`ABL.csv:32`）被 `ERB/DIM.ERH:36`
 *    的 `#DIM CONST 教養 = 43` 改成 `CFLAG`（`CFLAG` 排族表首位）。后果是
 *    **升糖投影按主表显示、作者照抄降糖写到另一个族**（显示与写不同族）。
 *    修法：契约加 `VariableInfo.source`（additive），adapter 如实标源，
 *    `resolveFamily` **两轮**——先只看主表、全不中才看追加表，`'const'` 一律不参与；
 *    而 `lookup` 的**换算**（`resolvedIndex`）与 `unlistedFamilyName` 的**收录判定**
 *    三层都算（快照回放 / 别名 / 拼错名检测一条不许弱化）。
 * 2. **R2 判据与自述口径不符**：`index.ts` 的扩族判据表自述"只取二段形"，旧读数却把
 *    三段形 `族:A:B` 的头两段也算进去 ⇒ `SOURCE` 被记为"残余 6/6 = `SOURCE:LOCAL`"而
 *    不入库；生产判据（只核真二段形）下三盘判表外 0/0/0，按该表自己的判据**应入库**。
 *    顺带钉一条截词缺陷：扫描器把 `SOURCE:LOCAL:(LOCAL:1)` 截成 `SOURCE:LOCAL` 交进核对，
 *    绕过了"三段及以上一律放行"（`expression.ts` 现按"截断处仍是 `:` 则整条不核"处理）。
 *
 * 装配：名称表 / `.ERH` 用**内存假 io** 喂**生产同一条** `loadEratwVariableSchema`
 * （标源逻辑属 adapter，夹具不许抄第二份实现），再交 `makeLookup` 消费。
 * 每条正向断言配**负自证**（把顺序推翻 / 把 const 整条砍掉 / 把放行放宽，必须有测试变红）。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, Logger, VariableInfo, VariableSchema } from '@kojo/plugin-api';
import { loadEratwVariableSchema } from '../../eratw-adapter/src/variable-schema';
import { makeLookup } from '../src/index';
import { createSugarTranspileService } from '../src/service';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';

const CSV_DIR = 'M:/game/CSV';
const ERB_DIR = 'M:/game/ERB';

/**
 * 夹具逐字取自盘上原句（画蛇添足版 4.980）：
 * `TCVAR.csv:70 = 132,憤怒` / `Base.als:14-15 = 愤怒|憤怒`（同编号简繁双写，`BASE` 在族表
 * 里排 `TCVAR` 前面）/ `ABL.csv:32 = 43,教養` / `CFLAG.csv` 的 43 号是 `;` 注释掉的 /
 * `ERB/DIM.ERH:36 = #DIM CONST 教養 = 43`。
 */
const CSV_FILES: Record<string, string> = {
  'BASE.csv': '10,ムード\n0,胸部開発\n',
  'BASE.als': '10,情绪\n10,情緒\n13,愤怒\n13,憤怒\n2001,怒濤\n',
  'TCVAR.csv': '132,憤怒\n',
  'ABL.csv': '43,教養\n',
  'CFLAG.csv': ';43,教養\n1088,好感度\n',
  'CFLAG.als': '2001,怒濤\n',
  'SOURCE.csv': '51,侮辱\n',
  'EX.csv': '1,Ｖ絶頂\n',
};

/** 作者自定名表（FT-1 的第三源）：`教養` 与盘上同号同名，另两个是"只有 `.ERH` 才有"的名字 */
const ERH_FILES: Record<string, string> = {
  'ERB/DIM.ERH':
    '#DIM CONST 教養 = 43 ;作者自定名\n#DIM CONST 胸部開発上限 = 7\n#DIM CONST K15C_SETTING_DISABLE_HATE_DIALOG = 1101\n',
};

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 内存 io：只实现字典要用的四个方法（`walkDir` 缺位 = 不喂 `.ERH` 的那条对照路） */
const memIo = (): FileIO => {
  const entry = (path: string, isDirectory = false): DirEntry => ({
    name: path.split('/').pop() ?? path,
    path,
    isDirectory,
  });
  const text = (path: string): string => {
    const key = path.replace(/^M:\/game\/CSV\//, '').replace(/^M:\/game\//, '');
    const body = CSV_FILES[key] ?? ERH_FILES[key];
    if (body === undefined) throw new Error(`夹具没有这个文件：${path}`);
    return body;
  };
  return {
    listDir: async (dir: string) => Object.keys(CSV_FILES).map((n) => entry(`${dir}/${n}`)),
    readText: async (path: string) => ({
      path,
      text: text(path),
      encoding: 'utf-8' as const,
      eol: 'lf' as const,
      mtimeMs: null,
    }),
    /** FileIO 契约的批量读（字典的两条读循环走这里）：夹具缺文件 = null 失败位，不整批抛 */
    readTexts: async (paths: readonly string[]) =>
      Promise.all(
        paths.map(async (p) => {
          try {
            return {
              path: p,
              text: text(p),
              encoding: 'utf-8' as const,
              eol: 'lf' as const,
              mtimeMs: null,
            };
          } catch {
            return null;
          }
        }),
      ),
    walkDir: async (dir: string, opts?: { filter?: (e: DirEntry) => boolean }) => {
      const all = Object.keys(ERH_FILES).map((n) => entry(`${ERB_DIR}/${n.split('/').pop() ?? n}`));
      return opts?.filter ? all.filter(opts.filter) : all;
    },
  } as unknown as FileIO;
};

/** `erh = false` ⇒ 不传 `erbDir`（字典只有主表 + 追加表），用于"const 确实参与了换算"的对照 */
async function lookupFor(erh: boolean): Promise<DictionaryLookup & { schema: VariableSchema }> {
  const schema = await loadEratwVariableSchema({
    io: memIo(),
    csvDir: CSV_DIR,
    ...(erh ? { erbDir: ERB_DIR } : {}),
    log: silentLog,
  });
  return Object.assign(makeLookup(schema), { schema });
}

const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;
const cond = (expr: string): string => doc(`    如果 ${expr} == 1：\n        「涩涩的话」\n`);

/* ============================================================= */
/* A. R1：来源分层 —— 族归属只认前两层，且主表优先                 */
/* ============================================================= */

describe('ALS-R1-A 族归属只认主表→追加表两层，const 不参与', () => {
  it('主表归属不被追加名表抢走：`憤怒` 仍是 `TCVAR`（`Base.als` 的别名排在族表前面也不行）', async () => {
    const l = await lookupFor(true);
    expect(l.schema.lookup('TCVAR', '憤怒')?.source, 'TCVAR.csv 的名字标 primary').toBe('primary');
    expect(l.schema.lookup('BASE', '憤怒')?.source, 'Base.als 的别名标 append').toBe('append');
    expect(l.resolveFamily('憤怒')).toBe('TCVAR');
    // 负自证①：归属不是靠"BASE 查不到"得来的——BASE 表里确实收录了它
    expect(l.schema.lookup('BASE', '憤怒')?.resolvedIndex).toBe(13);
    // 负自证②：只属于追加名表的名字（盘上简体别名 `愤怒`）第二轮照样给归属 ⇒ 不是"append 一律不认"
    expect(l.resolveFamily('愤怒')).toBe('BASE');
    expect(l.resolveFamily('情緒')).toBe('BASE');
  });

  it('同一层内仍是族表顺序即优先级：两个 append 命中取族表首位 `CFLAG`', async () => {
    const l = await lookupFor(true);
    // `怒濤` 只在 `CFLAG.als` / `BASE.als` 里（主表两条都没有）⇒ 第一轮全不中，进第二轮
    expect(l.schema.lookup('CFLAG', '怒濤')?.source).toBe('append');
    expect(l.schema.lookup('BASE', '怒濤')?.source).toBe('append');
    expect(l.resolveFamily('怒濤')).toBe('CFLAG');
    // 负自证：同一层里换掉首位那条（`CFLAG.als` 里不再写它）⇒ 归属就落到 `BASE`，
    // 证明上面 `CFLAG` 是"族表顺序"给的，不是随便取的
    const withoutCflag = await (async () => {
      const saved = CSV_FILES['CFLAG.als'];
      delete CSV_FILES['CFLAG.als'];
      try {
        return await lookupFor(true);
      } finally {
        if (saved !== undefined) CSV_FILES['CFLAG.als'] = saved;
      }
    })();
    expect(withoutCflag.resolveFamily('怒濤'), '只剩 BASE.als 收录时第二轮给 BASE').toBe('BASE');
    expect(withoutCflag.schema.lookup('CFLAG', '怒濤'), 'CFLAG 表还在位，只是没收这个名字').toEqual({
      name: 'CFLAG',
      index: '怒濤',
    });
  });

  it('`.ERH` 常量不宣称族归属：`教養` 仍是 `ABL`，且它照样能换算编号', async () => {
    const l = await lookupFor(true);
    expect(l.resolveFamily('教養'), 'const 命中不得抢走 ABL 的归属').toBe('ABL');
    const viaCflag = l.schema.lookup('CFLAG', '教養');
    expect(viaCflag?.source, 'ERH 常量标 const').toBe('const');
    expect(viaCflag?.resolvedIndex, '换算仍可用（快照回放 / 别名靠它）').toBe(43);
    expect(viaCflag?.description).toBe('教養');
    // 负自证：不喂 `.ERH` 时这条路根本不存在（只回显、无编号）⇒ 上面的 resolvedIndex 真是 const 给的
    const noErh = await lookupFor(false);
    expect(noErh.schema.lookup('CFLAG', '教養')).toEqual({ name: 'CFLAG', index: '教養' });
    expect(noErh.resolveFamily('教養'), '不喂 .ERH 时归属本来就是 ABL').toBe('ABL');
  });

  it('只有 `.ERH` 才有的名字：无归属，但 `unlistedFamilyName` 仍算收录（拼错名核对三层都算）', async () => {
    const l = await lookupFor(true);
    expect(l.resolveFamily('K15C_SETTING_DISABLE_HATE_DIALOG'), 'const 不参与族归属').toBeUndefined();
    expect(l.schema.lookup('CFLAG', 'K15C_SETTING_DISABLE_HATE_DIALOG')?.resolvedIndex).toBe(1101);
    // `BASE:胸部開発上限` 只在 `.ERH` 里 ⇒ 表内 ⇒ 不判（分层没把核对面收窄）
    expect(l.unlistedFamilyName?.('BASE:胸部開発上限')).toBeUndefined();
    // 负自证：同一族加一个字仍判得出 ⇒ 上面"不判"是查到了，不是没在核
    expect(l.unlistedFamilyName?.('BASE:胸部開発上限瞎写')).toEqual({
      family: 'BASE',
      name: '胸部開発上限瞎写',
    });
  });

  it('旧字典形态（不标 source）行为与今天逐字相同：首个命中即归属', () => {
    // `BASE`（族表第 6）与 `TCVAR`（族表第 9）都收录 `憤怒`，但**都不标源**
    const tables: Record<string, Record<string, number>> = { BASE: { 憤怒: 13 }, TCVAR: { 憤怒: 132 } };
    const legacy: VariableSchema = {
      version: 'legacy',
      lookup(variableName: string, index?: number | string): VariableInfo | undefined {
        const key = variableName.toUpperCase();
        const table = tables[key];
        if (table === undefined) return undefined;
        if (index === undefined) return { name: key };
        const idx = table[String(index)];
        // 与 adapter 同语义：收录 → 带 description / resolvedIndex；查无 → 只回显
        return idx === undefined
          ? { name: key, index }
          : { name: key, index, description: String(index), resolvedIndex: idx };
      },
    };
    expect(makeLookup(legacy).resolveFamily('憤怒'), '缺省来源按 primary 处理 = 改前那趟"首个命中"').toBe('BASE');
  });

  it('转译层端到端：`她的憤怒` 落 `TCVAR:TARGET:`（升糖显示与降糖写同族）', async () => {
    const l = await lookupFor(true);
    const svc = createSugarTranspileService({ dictionary: l, faceTable: stubFaceTable() });
    const r = svc.transpile(doc('    如果 她的憤怒 > 0：\n        「x。」\n'));
    expect(r.erb).toContain('TCVAR:TARGET:憤怒');
    expect(r.erb).not.toContain('BASE:TARGET:憤怒');
    expect(r.diagnostics).toEqual([]);
    // 反糖侧（`nameAt`）走的仍是编号 → 名称，主表的名称不许被追加表覆盖
    expect(l.nameAt?.('BASE', '10')).toBe('ムード');
  });
});

/* ============================================================= */
/* B. R2：`SOURCE` 入库 + 被截断的三段形不再绕过放行               */
/* ============================================================= */

describe('ALS-R2-B 生效族九张：SOURCE 入库、MAXBASE 仍不入库', () => {
  it('`SOURCE` 入库：表内名放行、表外名判得出（族头 + 名称段原样交回）', async () => {
    const l = await lookupFor(true);
    expect(l.unlistedFamilyName?.('SOURCE:侮辱')).toBeUndefined();
    expect(l.unlistedFamilyName?.('SOURCE:侮辱瞎写')).toEqual({ family: 'SOURCE', name: '侮辱瞎写' });
    // 负自证：纯数字索引照样放行（引擎合法写法）
    expect(l.unlistedFamilyName?.('SOURCE:51')).toBeUndefined();
  });

  it('`MAXBASE` **仍不入库**（本批决定：入库要动生效族清单，读数交 ALS 线决定）', async () => {
    const l = await lookupFor(true);
    // 它的名字全住在 `BASE` 表里（`['MAXBASE','BASE']` 判表外能降到 0），但族头未登记 ⇒ 一条不判
    expect(l.unlistedFamilyName?.('MAXBASE:肯定不在表里的瞎写名')).toBeUndefined();
  });

  it('转译层：`SOURCE:瞎写名` → 恰 1 条 warning；产物原样', async () => {
    const l = await lookupFor(true);
    const svc = createSugarTranspileService({ dictionary: l, faceTable: stubFaceTable() });
    const r = svc.transpile(cond('SOURCE:侮辱瞎写'));
    const warns = r.diagnostics.filter((d) => d.code === 'family-name-unknown');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.severity).toBe('warning');
    expect(r.erb).toContain('IF SOURCE:侮辱瞎写 == 1');
  });

  it('扫描器截断的三段作用域写法不再绕过"≥3 段一律放行"（语料实有 `SOURCE:LOCAL:(LOCAL:1)`）', async () => {
    const l = await lookupFor(true);
    const svc = createSugarTranspileService({ dictionary: l, faceTable: stubFaceTable() });
    // `LOCAL` 不在裸引擎全局表里（E16 线的判据面，本批不越线补）⇒ 全靠"截断处仍是 `:` 不核"放行
    const r = svc.transpile(cond('SOURCE:LOCAL:(LOCAL:1)'));
    expect(r.diagnostics.filter((d) => d.code === 'family-name-unknown')).toEqual([]);
    expect(r.erb, '产物仍逐字原样').toContain('SOURCE:LOCAL:(LOCAL:1)');
    // 负自证：真二段形的表外名照旧判得出 ⇒ 上面那条放行不是把核对整个关掉
    const off = svc.transpile(cond('SOURCE:LOCAL瞎写'));
    expect(off.diagnostics.filter((d) => d.code === 'family-name-unknown')).toHaveLength(1);
    // 负自证②：被截断的**段首是拼错的具名**也不判（口径自相一致：三段形一律不碰）
    const truncatedTypo = svc
      .transpile(cond('SOURCE:侮辱瞎写:(LOCAL:1)'))
      .diagnostics.filter((d) => d.code === 'family-name-unknown');
    expect(truncatedTypo).toEqual([]);
  });
});
