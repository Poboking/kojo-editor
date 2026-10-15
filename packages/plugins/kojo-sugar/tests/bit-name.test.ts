/**
 * v1.8 **位名表层语法**：位槽写**中文位名**（`获取标记(X, 位名)` / `设置标记 X, 位名`）。
 *
 * 两条位槽路**共用同一枚解析函数** `resolveBitSlotName`（单一真源）：
 * - 表达式形：`获取标记(X, 名)` → `GETBIT(` 挂钩（`expression.ts` 步骤 3）；
 * - 语句形：`设置标记 X, 名` → codegen `_statementFn`（`codegen.ts` `emitRawLine`）。
 *
 * 钉死的硬口径（每条配**负自证**）：
 * 1. **同族同号**：位名只在第一实参`X`**自身**的位表内按 `label` 整词精确匹配 →
 *    得 `VariableInfo.bits[].bit`（引擎位号，**不是**文本）；同一名在别的变量里查不到即报错。
 * 2. **优先级不静默**：① 作者别名优先 → ② 位名 → ③ 名同时又是变量 / 引擎全局 ⇒ 报**歧义**
 *    error（绝不静默取其一）→ ④ 都不中走既有 `unknown-identifier` / 新码 `bit-name-unknown`。
 * 3. **不写新语法时逐字节不变**：位槽保持数字 / 表达式的老写法产物逐字节相同；
 *    字典缺省（无 `bitIndexOf`）⇒ 行为与改前逐字相同（additive seam 的负自证）。
 * 4. 命中位名时产物里的位号 = **引擎位号**。
 *
 * 另有**真实 adapter 集成断言**（`loadEratwVariableSchema` + 内存 io + `makeLookup`，
 * 断言贴近生产；跨包 import 由审计 C 对 `tests/` 的豁免覆盖）。
 */
import { describe, expect, it } from 'vitest';
import type { DirEntry, FileIO, Logger, SugarDiagnostic } from '@kojo/plugin-api';
import { loadEratwVariableSchema } from '../../eratw-adapter/src/variable-schema';
import { makeLookup } from '../src/index';
import { createSugarTranspileService } from '../src/service';
import { resolveBitSlotName, type ExprContext } from '../src/expression';
import type { DictionaryLookup } from '../src/types';
import { stubDict, stubFaceTable } from './support';

/* =============================== 桩位表 / 桩字典 =============================== */

/**
 * 桩位表（键 = `族:索引`，索引取变量引用**末段**——与 `makeLookup.bitIndexOf` 同口径）。
 * 覆盖：正例 / 位表内同名多枚（歧义）/ 位名与引擎全局撞名（歧义）。
 */
const STUB_BITS: Record<string, readonly { bit: number; label: string }[]> = {
  'CFLAG:1': [
    { bit: 0, label: '接吻' },
    { bit: 1, label: '诶嘿嘿' },
  ],
  'TFLAG:193': [{ bit: 2, label: '膣内' }],
  // 位表内同名多枚 → 位号不唯一（不猜）
  'MARK:3': [
    { bit: 1, label: '同名' },
    { bit: 9, label: '同名' },
  ],
  // 位名与**引擎全局** `TARGET` 撞名 → 歧义
  'FLAG:7': [{ bit: 5, label: 'TARGET' }],
};

const bitDict: DictionaryLookup = {
  ...stubDict,
  bitIndexOf(variableName, bitLabel) {
    const segs = variableName.split(':');
    if (segs.length < 2) return undefined;
    const bits = STUB_BITS[`${segs[0]!.toUpperCase()}:${segs[segs.length - 1]!}`];
    if (bits === undefined) return undefined;
    let hit: number | undefined;
    for (const b of bits) {
      if (b.label !== bitLabel) continue;
      if (hit !== undefined) return undefined; // 同一位表内多枚同名 → 歧义（不猜）
      hit = b.bit;
    }
    return hit;
  },
};

const svc = (dict: DictionaryLookup) =>
  createSugarTranspileService({ dictionary: dict, faceTable: stubFaceTable() });
const t = (dict: DictionaryLookup, src: string) => svc(dict).transpile(src);

/** 正文落在 `时机 指令 310：` 体内（stub 表 = eraTW 真实模板） */
const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;
const cond = (expr: string): string => doc(`    如果 ${expr} == 1：\n        「涩涩的话」\n`);
const outLines = (dict: DictionaryLookup, src: string): string[] =>
  t(dict, src).erb.split('\n').map((l) => l.trim());
const errs = (dict: DictionaryLookup, src: string) =>
  t(dict, src).diagnostics.filter((d) => d.severity === 'error');
const codes = (dict: DictionaryLookup, src: string) => t(dict, src).diagnostics.map((d) => d.code);

/* ===================== resolveBitSlotName 直接单测（真源） ===================== */

describe('resolveBitSlotName · 五条判据（两条位槽路共用的唯一真源）', () => {
  const mk = (over?: Partial<ExprContext>): { ctx: ExprContext; diags: SugarDiagnostic[] } => {
    const diags: SugarDiagnostic[] = [];
    return {
      ctx: {
        aliases: new Map(),
        dictionary: bitDict,
        report: (d) => diags.push(d),
        loc: null,
        ...over,
      },
      diags,
    };
  };

  it('① 位名命中 → 返回**引擎位号**文本（不是位名）', () => {
    expect(resolveBitSlotName('CFLAG:TARGET:1', '接吻', mk().ctx)).toBe('0');
    expect(resolveBitSlotName('TFLAG:193', '膣内', mk().ctx)).toBe('2');
  });

  it('① 同族同号：同一名在**别的变量**位表里查不到 → 报查无 error（**绝不跨变量**按位名解析）', () => {
    // `接吻` 只在 CFLAG:1 的位表里；TFLAG:193 的位表里没有它 ⇒ 位名不命中、且该名非变量 ⇒ 报错
    const { ctx, diags } = mk();
    expect(resolveBitSlotName('TFLAG:193', '接吻', ctx)).toBe('接吻');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('bit-name-unknown');
  });

  it('④ 第一实参**不是**引擎变量引用（定不出族）→ Return null（交回既有 `unknown-identifier`）', () => {
    const { ctx, diags } = mk();
    expect(resolveBitSlotName(undefined, '接吻', ctx)).toBeNull();
    expect(resolveBitSlotName('', '接吻', ctx)).toBeNull();
    expect(resolveBitSlotName('瞎写的名字', '接吻', ctx)).toBeNull();
    expect(diags).toEqual([]);
  });

  it('② 作者别名优先：同名别名存在 → 本函数不管（Return null）', () => {
    const { ctx } = mk({
      aliases: new Map([['接吻', { value: { kind: 'number', text: '3' }, readonly: true, line: 2 }]]),
    });
    expect(resolveBitSlotName('CFLAG:TARGET:1', '接吻', ctx)).toBeNull();
  });

  it('③ 位名命中而该名**同时**是引擎全局 → 报歧义 error，且原样返回位名（不猜）', () => {
    const { ctx, diags } = mk();
    expect(resolveBitSlotName('FLAG:7', 'TARGET', ctx)).toBe('TARGET');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('bit-name-unknown');
    expect(diags[0]!.severity).toBe('error');
  });

  it('④ 位表内同名多枚（位号不唯一）→ 报查无 error，且原样返回（不猜不产半成品）', () => {
    const { ctx, diags } = mk();
    expect(resolveBitSlotName('MARK:3', '同名', ctx)).toBe('同名');
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('bit-name-unknown');
  });

  it('④ 位名未命中 + 第一实参确是引擎变量引用 → 报 `bit-name-unknown`（fail-visible）', () => {
    const { ctx, diags } = mk();
    expect(resolveBitSlotName('CFLAG:TARGET:1', '瞎写', ctx)).toBe('瞎写');
    expect(diags[0]!.code).toBe('bit-name-unknown');
  });

  it('④ 位名未命中但该名是可解析的变量 → Return null（交回既有变量解析，不报位名错）', () => {
    const { ctx, diags } = mk();
    expect(resolveBitSlotName('CFLAG:TARGET:1', 'CFLAG', ctx)).toBeNull();
    expect(diags).toEqual([]);
  });

  it('非单一裸标识符（含 `:` 索引 / 运算符 / 数字）→ Return null（是普通表达式，交回下游）', () => {
    const { ctx } = mk();
    expect(resolveBitSlotName('CFLAG:TARGET:1', 'CFLAG:2', ctx)).toBeNull();
    expect(resolveBitSlotName('CFLAG:TARGET:1', '1 + 1', ctx)).toBeNull();
    expect(resolveBitSlotName('CFLAG:TARGET:1', '0', ctx)).toBeNull();
    expect(resolveBitSlotName('CFLAG:TARGET:1', '   ', ctx)).toBeNull();
  });

  it('缺省不做：字典无 `bitIndexOf`（未打开工程 / 旧字典）→ Return null（行为与改前逐字相同）', () => {
    const { ctx, diags } = mk({ dictionary: stubDict });
    expect(resolveBitSlotName('CFLAG:TARGET:1', '接吻', ctx)).toBeNull();
    expect(diags).toEqual([]);
  });
});

/* ===================== 表达式形（`获取标记(X, 名)`） ===================== */

describe('位名 · 表达式形 `获取标记(X, 名)`', () => {
  it('正向：`获取标记(CFLAG:TARGET:1, 接吻)` → `GETBIT(CFLAG:TARGET:1, 0)`（产物是引擎位号）', () => {
    const src = cond('获取标记(CFLAG:TARGET:1, 接吻)');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('IF GETBIT(CFLAG:TARGET:1, 0) == 1');
  });

  it('正向：`获取标记(TFLAG:193, 膣内)` → `GETBIT(TFLAG:193, 2)`', () => {
    const src = cond('获取标记(TFLAG:193, 膣内)');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('IF GETBIT(TFLAG:193, 2) == 1');
  });

  it('同族同号负例：`获取标记(TFLAG:193, 接吻)` → `bit-name-unknown` error（该变量位表无此名）', () => {
    const src = cond('获取标记(TFLAG:193, 接吻)');
    expect(codes(bitDict, src)).toContain('bit-name-unknown');
    expect(errs(bitDict, src).length).toBeGreaterThan(0);
  });

  it('歧义负例：`获取标记(FLAG:7, TARGET)`（名同时是引擎全局）→ `bit-name-unknown` error', () => {
    const src = cond('获取标记(FLAG:7, TARGET)');
    expect(codes(bitDict, src)).toContain('bit-name-unknown');
  });

  it('② 作者别名优先：`别名 接吻 = 3` 时 `接吻` 先被展开为 `3`，不按位名解析', () => {
    const src = '角色: 12\n别名 接吻 = 3\n时机 指令 310：\n    如果 获取标记(CFLAG:TARGET:1, 接吻) == 1：\n        「x。」\n';
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('IF GETBIT(CFLAG:TARGET:1, 3) == 1');
  });

  it('④ 可解析变量：`获取标记(CFLAG:TARGET:1, CFLAG)` → 交回既有链路，按变量产出（无 error）', () => {
    const src = cond('获取标记(CFLAG:TARGET:1, CFLAG)');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('IF GETBIT(CFLAG:TARGET:1, CFLAG) == 1');
  });

  it('③ 老写法逐字节不变：数字位号 / 表达式位号产物照旧', () => {
    expect(outLines(bitDict, cond('获取标记(TFLAG:193, 2)'))).toContain('IF GETBIT(TFLAG:193, 2) == 1');
    expect(outLines(bitDict, cond('获取标记(TFLAG:193, TFLAG:194)'))).toContain(
      'IF GETBIT(TFLAG:193, TFLAG:194) == 1',
    );
  });

  it('缺省负自证：桩字典无 `bitIndexOf` ⇒ 位名照旧走既有 `unknown-identifier`（行为与改前逐字相同）', () => {
    const src = cond('获取标记(CFLAG:TARGET:1, 接吻)');
    expect(codes(stubDict, src)).toContain('unknown-identifier');
    expect(codes(stubDict, src)).not.toContain('bit-name-unknown');
  });
});

/* ===================== 语句形（`设置标记 X, 名`） ===================== */

describe('位名 · 语句形 `设置标记/清除标记/反转标记 X, 名`', () => {
  it('正向：`设置标记 CFLAG:TARGET:1, 接吻` → `SETBIT CFLAG:TARGET:1, 0`', () => {
    const src = doc('\t设置标记 CFLAG:TARGET:1, 接吻');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('SETBIT CFLAG:TARGET:1, 0');
  });

  it('正向：`清除标记 TFLAG:193, 膣内` → `CLEARBIT TFLAG:193, 2`', () => {
    const src = doc('\t清除标记 TFLAG:193, 膣内');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('CLEARBIT TFLAG:193, 2');
  });

  it('正向：`反转标记 CFLAG:TARGET:1, 诶嘿嘿` → `INVERTBIT CFLAG:TARGET:1, 1`', () => {
    const src = doc('\t反转标记 CFLAG:TARGET:1, 诶嘿嘿');
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('INVERTBIT CFLAG:TARGET:1, 1');
  });

  it('② 作者别名优先：`别名 接吻 = 3` 时位槽先走别名展开，不按位名解析', () => {
    const src = '角色: 12\n别名 接吻 = 3\n时机 指令 310：\n\t设置标记 CFLAG:TARGET:1, 接吻\n';
    expect(errs(bitDict, src)).toEqual([]);
    expect(outLines(bitDict, src)).toContain('SETBIT CFLAG:TARGET:1, 3');
  });

  it('③ 老写法逐字节不变：数字 / 变量表达式位槽产物照旧', () => {
    expect(outLines(bitDict, doc('\t设置标记 TFLAG:193, 0'))).toContain('SETBIT TFLAG:193, 0');
    expect(outLines(bitDict, doc('\t设置标记 TFLAG:193, TFLAG:194'))).toContain(
      'SETBIT TFLAG:193, TFLAG:194',
    );
  });

  it('④ 负例：`设置标记 TFLAG:193, 接吻` → `bit-name-unknown` error（该变量位表无此名）', () => {
    const src = doc('\t设置标记 TFLAG:193, 接吻');
    expect(codes(bitDict, src)).toContain('bit-name-unknown');
    expect(errs(bitDict, src).length).toBeGreaterThan(0);
  });

  it('缺省负自证：桩字典无 `bitIndexOf` ⇒ 位名照旧走既有 `unknown-identifier`', () => {
    const src = doc('\t设置标记 CFLAG:TARGET:1, 接吻');
    expect(codes(stubDict, src)).toContain('unknown-identifier');
    expect(codes(stubDict, src)).not.toContain('bit-name-unknown');
  });
});

/* ==================== 真实 adapter 集成（位表数据只住 adapter） ==================== */

describe('位名 · 真实 adapter 集成（`loadEratwVariableSchema` + `makeLookup`）', () => {
  const CSV_DIR = 'M:/game/CSV';
  const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  // 定义行让 `lookup(族, 索引)` 命中 byIndex 并挂上 `VariableInfo.bits`（`withBits`）；
  // 位表数据（`ERATW_BIT_TABLES`）是 adapter 的冻结策展数据，此处**只喂定义行**。
  const CSV_FILES: Record<string, string> = {
    'CFLAG.csv': '1,既成事実\n1088,好感度\n',
    'TFLAG.csv': '1,射精部位\n',
  };
  const memIo = (): FileIO => {
    const entry = (path: string): DirEntry => ({
      name: path.split('/').pop() ?? path,
      path,
      isDirectory: false,
    });
    return {
      listDir: async (dir: string) => Object.keys(CSV_FILES).map((n) => entry(`${dir}/${n}`)),
      readText: async (path: string) => {
        const key = path.replace(/^M:\/game\/CSV\//, '');
        const body = CSV_FILES[key];
        if (body === undefined) throw new Error(`夹具没有这个文件：${path}`);
        return { path, text: body, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      },
      walkDir: async () => [],
    } as unknown as FileIO;
  };

  it('真位表命中：`CFLAG:TARGET:1` 的 `接吻` → 位 0；`TFLAG:1` 的 `膣内` → 位 1（两条位槽路一致）', async () => {
    const schema = await loadEratwVariableSchema({ io: memIo(), csvDir: CSV_DIR, log: silentLog });
    const dict = makeLookup(schema);
    // 表达式形
    expect(errs(dict, cond('获取标记(CFLAG:TARGET:1, 接吻)'))).toEqual([]);
    expect(outLines(dict, cond('获取标记(CFLAG:TARGET:1, 接吻)'))).toContain(
      'IF GETBIT(CFLAG:TARGET:1, 0) == 1',
    );
    expect(outLines(dict, cond('获取标记(TFLAG:1, 膣内)'))).toContain('IF GETBIT(TFLAG:1, 1) == 1');
    // 语句形（与表达式形共用同一枚解析函数 ⇒ 位号一致）
    expect(outLines(dict, doc('\t设置标记 CFLAG:TARGET:1, 接吻'))).toContain('SETBIT CFLAG:TARGET:1, 0');
  });

  it('真位表负例：`接吻` 不在 `TFLAG:1` 位表 → 同一名跨变量查无 ⇒ `bit-name-unknown` error', async () => {
    const schema = await loadEratwVariableSchema({ io: memIo(), csvDir: CSV_DIR, log: silentLog });
    const dict = makeLookup(schema);
    expect(codes(dict, cond('获取标记(TFLAG:1, 接吻)'))).toContain('bit-name-unknown');
  });
});
