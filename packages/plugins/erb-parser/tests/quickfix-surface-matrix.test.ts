/**
 * ERB 快修面矩阵守卫（QF-1，2026-11-07）——把"哪几枚码今天真的有快修"钉成断言。
 *
 * 为什么要有这一枚（口径来自既有裁决：**快速修复是作者唯一的出口**，没有快修的诊断码
 * 就是半成品；同时**不许为了"有快修"放宽判据、也不许给证明不了安全的改动造空壳动作**）：
 * 码表散在 structure.ts / declarations.ts / erh.ts / references.ts / arity.ts /
 * undefined-name.ts / builtins.ts 七处，供方只有 plugin.ts 那一枚 erb-structure-fix。
 * 任何一侧动一刀（新增码位 / 摘掉供方 / 把匹配口径从 code+行 改成近似），面上都是静默的：
 * 作者看到的是"有红线、按快捷修复没东西"。本守卫把这件事变成会红的东西。
 *
 * 四道闸（形态照 app/tests/tryc-pairing-single-source.test.ts）：
 * - (a) 码面闭集：矩阵每一枚码①取自生产方导出的常量或拼法（不抄字符串）、
 *   ②在本测试的 fixture 上**真的被生产出来过**；fixture 生产出的码若不在矩阵里 = 红
 *   （新增码位没登记就拦下）。
 * - (b) 供方行为：矩阵声明"有供方"的行，buildStructureFixes 必须给得出动作、动作必须真改
 *   文本、且**应用后同一条码复检为零**；声明"无供方"的行必须一条动作都不给
 *   （空壳冒充覆盖 = 红）。
 * - (c) 反向对照：临时摘掉一枚供方 / 凭空给一枚无供方的码挂上供方 = 守卫必须真的红
 *   （两个方向都测，证明这道闸不是空跑）。
 * - (d) 两条匹配链不许并：erb-structure-fix 按 code+行精确应答（错行 / 错码 / 空诊断集
 *   一律零动作）；convention-quickfix 那族按 diagnosticKey 求交，**不经过**本供方。
 *
 * 真语料读数（2026-11-07 本机语料 4,258 文件 / 4,376,079 行；跑法见回执，语料盘只读）：
 *   erb.unclosed-open / orphan-close / orphan-branch / dim-invalid / return-form / erh-invalid
 *     = 各 **0 处**（checkStructure 全语料零报告：加载期就会失败的形态，出厂前已被摇掉）
 *     = 有供方的两枚在**存量**上无东西可修，价值在作者新写的代码上；
 *   ERB_UNDEFINED_NAME = **49 处**，其中 48 处是我们的词表缺项（COUNT 14 / Y 33 / __INT_MAX__ 1，
 *     文本本身是对的 = 任何"修复"都是改坏）；剩 1 处 B 要人来决定补哪条声明；
 *   ERB_ARITY_MISMATCH = **473 处**少给必需（定罪开关默认关着 = 上屏 0 处），
 *     补哪个实参值不可证 = 不做；
 *   erb.call-undefined = **0 处**（D03 收口后默认档）；erb.call-try-missing = 14 处（信息档，不接 UI）；
 *   ERB_BUILTIN_ARGS / ERB_BUILTIN_ARG_TYPE = 多给 0 处 / 类型 ≤8 处（builtins.corpus 口径）。
 *   今天**唯一**有存量命中的两族（未定义名 / 实参个数）都**证明不了安全**，
 *   本批因此**不新增快修**，只把"有 / 没有"钉死（详见回执「我故意没做的口子」）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERB_ENGINE_RESERVED_IDENTIFIERS, ERB_ENGINE_STRING_IDENTIFIERS, NATIVE_STRUCTURE_CODES } from '@kojo/plugin-api';
import type { LineDecoration } from '@kojo/plugin-api';
import { checkControlFlowStructure, checkStructure, structureIssueCode } from '../src/structure';
import { checkDeclarationIssues } from '../src/declarations';
import { checkHeaderIssues } from '../src/erh';
import { structureDiagnostic, applyStructureFix, buildStructureFixes } from '../src/structure-fix';
import { erbReferenceDecorations, tryCallTargetDecorations, UNDEFINED_CALL_CODE, UNDEFINED_TRY_CALL_CODE } from '../src/references';
import { collectArityDiagnostics, ARITY_MISMATCH_CODE } from '../src/arity';
import { collectUndefinedNameDiagnostics, ERB_UNDEFINED_NAME } from '../src/undefined-name';
import { BUILTIN_FUNCTION_NAMES, builtinSignatureOf, collectBuiltinArgDiagnostics, BUILTIN_ARGS_CODE, BUILTIN_ARG_TYPE_CODE } from '../src/builtins';
import type { ErbStructureIssue } from '@kojo/plugin-api';

/** 一条矩阵行：码位 + 今天真的有没有供方 + 供方按什么匹配 + 修的是什么动作 */
interface MatrixRow {
  readonly code: string;
  /** 供方贡献 id；null = 今天没有快修（不许留空壳冒充） */
  readonly supplier: string | null;
  /** 匹配口径：code+行（结构腿天生按行）/ diagnosticKey（约定线与糖线）/ none */
  readonly match: 'code+line' | 'diagnosticKey' | 'none';
  /** 动作是什么（null = 无动作）；无供方的行必须把"为什么不做"写进 reason */
  readonly action: string | null;
  /** 无供方 / 动作受限的判据（一句话，进交付读数） */
  readonly reason?: string;
  /** 这一行的波浪线怎么来的（fixture 生产趟要能对上） */
  readonly producedBy: 'structure' | 'declaration' | 'header' | 'reference' | 'try-info' | 'arity' | 'undefined-name' | 'builtin-args' | 'builtin-type';
}

const ROWS: readonly MatrixRow[] = [
  {
    code: `erb.${'unclosed-open'}`,
    supplier: 'erb-structure-fix',
    match: 'code+line',
    action: '在体检器判定的保守插入点补上配对表给出的闭合词（整行替换，一次可撤销）',
    producedBy: 'structure',
  },
  {
    code: `erb.${'orphan-close'}`,
    supplier: 'erb-structure-fix',
    match: 'code+line',
    action: '删除 / 注释该行（**仅全文只此一条发现**时供；数据块内一律不供）',
    producedBy: 'structure',
  },
  {
    code: `erb.${'orphan-branch'}`,
    supplier: null,
    match: 'none',
    action: null,
    reason: 'ELSE / CATCH 不是冗余文本：删掉改语义，补上开块要人来决定补哪一条 = 无安全修法',
    producedBy: 'structure',
  },
  {
    code: `erb.${'dim-invalid'}`,
    supplier: null,
    match: 'none',
    action: null,
    reason: '五条子规则（超 3 维 / CONST 冲突 / CONST 无初值 / REF 元素数 / 初值多于元素数）每条都至少有两种合法改法，选哪种是作者的意图，证明不了等价',
    producedBy: 'declaration',
  },
  {
    code: `erb.${'return-form'}`,
    supplier: null,
    match: 'none',
    action: null,
    reason: 'RETURN 改 RETURNF 会把值交回调用方（语义变更），去掉 #FUNCTION 同样改语义 = 二选一要人',
    producedBy: 'declaration',
  },
  {
    code: `erb.${'erh-invalid'}`,
    supplier: null,
    match: 'none',
    action: null,
    reason: '修法是"把这一行挪走 / 删掉"还是"这个文件不该是 .ERH"，静态判据分不出来',
    producedBy: 'header',
  },
  {
    code: UNDEFINED_CALL_CODE,
    supplier: null,
    match: 'none',
    action: null,
    reason: '目标函数在项目里不存在：补哪一份定义、改名成哪一枚既有函数都是造语义',
    producedBy: 'reference',
  },
  {
    code: UNDEFINED_TRY_CALL_CODE,
    supplier: null,
    match: 'none',
    action: null,
    reason:
      '信息档（引擎允许 TRY 系钩子缺失），本就不是缺陷 = 没有该修的东西；D04b 起该档由 `erb-reference` 贡献上屏（info），与 warning 档同一条判据、互斥，仍不给快修',
    producedBy: 'try-info',
  },
  {
    code: ARITY_MISMATCH_CODE,
    supplier: null,
    match: 'none',
    action: null,
    reason: '少给的实参值不可从定义反推；引擎只按 fixedArgCount 吃实参，补位 = 发明值',
    producedBy: 'arity',
  },
  {
    code: ERB_UNDEFINED_NAME,
    supplier: null,
    match: 'none',
    action: null,
    reason: '真语料 49 处里 48 处是我们词表缺项（文本本来就对，改它=改坏）；剩 1 处该补哪条声明要人来决定。did-you-mean 候选只做提示，不做替换',
    producedBy: 'undefined-name',
  },
  {
    code: BUILTIN_ARGS_CODE,
    supplier: null,
    match: 'none',
    action: null,
    reason: '内建函数实参个数：补什么值是发明；引擎侧没有兜底默认',
    producedBy: 'builtin-args',
  },
  {
    code: BUILTIN_ARG_TYPE_CODE,
    supplier: null,
    match: 'none',
    action: null,
    reason: '内建函数实参类型：把 1 改成 "1" 或反之都是在猜作者要哪种量纲',
    producedBy: 'builtin-type',
  },
];

const ERB_CODES = new Set(ROWS.map((r) => r.code));
const SUPPLIED = new Set(ROWS.filter((r) => r.supplier !== null).map((r) => r.code));

/* ============================ fixture 生产 ============================ */

const ERB_FILE = 'a.erb';

/** 结构腿（配对三类 + 预处理器） */
const STRUCTURE_FIXTURES: Record<string, string> = {
  'erb.unclosed-open': 'IF 1\nPRINTW A\n',
  'erb.orphan-close': 'PRINTW A\nENDIF\n',
  'erb.orphan-branch': 'PRINTW A\nELSE\n',
};

function structureIssuesOf(text: string): ErbStructureIssue[] {
  return checkControlFlowStructure(text);
}

function declarationIssues(): ErbStructureIssue[] {
  return checkDeclarationIssues('#DIM CONST INT QF_GUARD_NOINIT\n');
}

/** `#FUNCTION` 式中函数里写裸 `RETURN`（return-form 与 dim-invalid 同一把尺子，分两段文本） */
function returnFormIssues(): ErbStructureIssue[] {
  return checkDeclarationIssues('#FUNCTION\n@QF_GUARD_EXPR_FN\nRETURN\n');
}

function headerIssues(): ErbStructureIssue[] {
  return checkHeaderIssues('PRINTW 这一行在头文件里不合法\n');
}

function referenceIssues(): LineDecoration[] {
  return erbReferenceDecorations({ path: ERB_FILE, text: 'CALL QF_GUARD_MISSING_FN\n' }, () => false);
}

function tryInfoIssues(): LineDecoration[] {
  return tryCallTargetDecorations({ path: ERB_FILE, text: 'TRYCALL QF_GUARD_MISSING_HOOK\n' }, () => false);
}

function arityIssues(): LineDecoration[] {
  return collectArityDiagnostics({
    path: ERB_FILE,
    text: 'CALL QF_GUARD_TWO_ARG(1)\n',
    catalog: (name) => (name === 'QF_GUARD_TWO_ARG' ? [{ name: 'A', hasDefault: false }, { name: 'B', hasDefault: false }] : null),
    diagnoseMissingRequired: true,
  });
}

function undefinedNameIssues(): LineDecoration[] {
  return collectUndefinedNameDiagnostics({
    text: 'IF QF_GUARD_UNDECLARED_NAME > 1\n',
    path: ERB_FILE,
    dimNames: [],
    stringNames: [],
    builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
    engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
    maxSuggestions: 0,
  }) as LineDecoration[];
}

/**
 * 两枚**只登记来源、不产波浪线**的码位（2026-11-07 实测：本守卫的合成 fixture 产不出它们）：
 * - `ERB_ARITY_MISMATCH`：实参对拍要真定义 + 真调用点两侧对齐，合成件造不出来，
 *   它的产出面由 `arity.corpus.test.ts` 的 production 对拍闸钉（473 处 = 对拍 missing-required 条数）；
 * - `ERB_BUILTIN_ARGS`：内建实参**个数**档在 fixture 探测里产不出（本仓逐枚试遍
 *   `BUILTIN_FUNCTION_NAMES` 的少给/多给三型文本，只出得了类型档），产出面由
 *   `builtins.corpus.test.ts` 钉。
 * 这两行的"有没有供方"仍由 (b) 的行为探针真跑（拿一枚同码的合成波浪线去问供方 ⇒ 必须零动作），
 * "码位还在不在产"改由源码扫描钉（常量仍被生产方贴进 decoration.code），**不靠注释兜**。
 */
const SOURCE_ONLY_CODES = new Set([ARITY_MISMATCH_CODE, BUILTIN_ARGS_CODE]);

/**
 * 内建函数两档的 fixture 是**现算出来的**：从 BUILTIN_FUNCTION_NAMES 逐枚试构造调用文本，
 * 取第一枚真能产出目标码的。为什么这么绕：签名表会随 wiki 校对增删，硬抄一枚名字 + 实参
 * 迟早出现"fixture 不再产出该码"的假绿（闸还在跑、什么也没验）。
 */
function builtinFixture(target: string): { text: string; codes: Set<string> } | null {
  for (const name of BUILTIN_FUNCTION_NAMES) {
    const sig = builtinSignatureOf(name);
    if (sig === null || sig.params === null) continue;
    const required = sig.params.filter((p) => !p.optional);
    if (required.length < 2) continue;
    const ints = (n: number) => Array.from({ length: n }, () => '1').join(', ');
    const texts = [
      // 少给一枚 ⇒ 实参个数
      `PRINT ${name}(${ints(required.length - 1)})\n`,
      // 全给整数：字符串槽吃到整数 ⇒ 类型（同文本也常常顺带报个数，逐档挑）
      `PRINT ${name}(${ints(required.length)})\n`,
      // 全给字符串：整数槽吃到字符串 ⇒ 类型
      `PRINT ${name}(${Array.from({ length: required.length }, () => '"x"').join(', ')})\n`,
    ];
    for (const text of texts) {
      const codes = new Set(
        collectBuiltinArgDiagnostics({ path: ERB_FILE, text, isUserFunction: () => false }).map((d) => d.code ?? ''),
      );
      if (codes.has(target)) return { text, codes };
    }
  }
  return null;
}

/** 逐生产方跑一遍，返回"码 → 波浪线（含来源文本）"；矩阵没登记的码 ⇒ 抛错（闭集闸） */
function produceAll(): Map<string, { text: string; decorations: LineDecoration[] }> {
  const out = new Map<string, { text: string; decorations: LineDecoration[] }>();
  const add = (code: string, text: string, decorations: readonly LineDecoration[]): void => {
    for (const d of decorations) {
      if (d.code === undefined) continue;
      if (!ERB_CODES.has(d.code)) {
        throw new Error(`生产方产出了矩阵未登记的码 ${d.code}（来源 ${code} 的 fixture）——新增码位请先在矩阵登记供方/判据`);
      }
    }
    if (decorations.length > 0 && !out.has(code)) out.set(code, { text, decorations: [...decorations] });
  };
  for (const [code, text] of Object.entries(STRUCTURE_FIXTURES)) {
    add(code, text, structureIssuesOf(text).map(structureDiagnostic));
  }
  add('erb.dim-invalid', '#DIM CONST INT QF_GUARD_NOINIT\n', declarationIssues().map(structureDiagnostic));
  add('erb.return-form', '#FUNCTION\n@QF_GUARD_EXPR_FN\nRETURN\n', returnFormIssues().map(structureDiagnostic));
  add('erb.erh-invalid', 'PRINTW 这一行在头文件里不合法\n', headerIssues().map(structureDiagnostic));
  add(UNDEFINED_CALL_CODE, 'CALL QF_GUARD_MISSING_FN\n', referenceIssues());
  add(UNDEFINED_TRY_CALL_CODE, 'TRYCALL QF_GUARD_MISSING_HOOK\n', tryInfoIssues());
  add(ARITY_MISMATCH_CODE, 'CALL QF_GUARD_TWO_ARG(1)\n', arityIssues());
  add(ERB_UNDEFINED_NAME, 'PRINT QF_GUARD_UNDECLARED_NAME\n', undefinedNameIssues());
  const argsFx = builtinFixture(BUILTIN_ARGS_CODE);
  if (argsFx) add(BUILTIN_ARGS_CODE, argsFx.text, collectBuiltinArgDiagnostics({ path: ERB_FILE, text: argsFx.text, isUserFunction: () => false }));
  const typeFx = builtinFixture(BUILTIN_ARG_TYPE_CODE);
  if (typeFx) add(BUILTIN_ARG_TYPE_CODE, typeFx.text, collectBuiltinArgDiagnostics({ path: ERB_FILE, text: typeFx.text, isUserFunction: () => false }));
  return out;
}

/* ============================ 守卫本体 ============================ */

/**
 * (b) 供方行为闸的可复用判据：声明有供方的行必须①给得出动作②动作真改文本③改完同一条码复检为零；
 * 声明无供方的行必须一条动作都不给。rows 参数化 = (c) 反向对照能在**同一条判据**上做 mutation，
 * 不另立第二把尺子。
 */
function assertSuppliers(
  rows: readonly MatrixRow[],
  produced: Map<string, { text: string; decorations: LineDecoration[] }>,
): string[] {
  const bad: string[] = [];
  for (const row of rows) {
    const hit = produced.get(row.code);
    if (!hit) {
      if (SOURCE_ONLY_CODES.has(row.code)) {
        // 来源扫描行的行为判据：拿一枚**同码的合成波浪线**去问供方，必须一条动作都不给
        if (row.supplier !== null) bad.push(`${row.code}：来源扫描行不许挂供方`);
        const synthetic: LineDecoration = { line: 1, severity: 'warning', message: `${row.code} 的合成波浪线`, code: row.code };
        if (buildStructureFixes('IF 1\nPRINTW A\n', 1, [synthetic]).some((f) => f.diagnostic.code === row.code)) {
          bad.push(`${row.code}：无供方的码位竟从结构供方拿到了动作`);
        }
        continue;
      }
      bad.push(`${row.code}：fixture 没生产出这条波浪线（码面闭集 / 生产方失效）`);
      continue;
    }
    const actions = buildStructureFixes(hit.text, hit.decorations[0]!.line, hit.decorations);
    if (row.supplier === null) {
      if (actions.length > 0) bad.push(`${row.code}：矩阵登记为无供方，实际给得出 ${actions.length} 条动作`);
      continue;
    }
    if (row.supplier !== 'erb-structure-fix') {
      bad.push(`${row.code}：供方 ${row.supplier} 不在本守卫覆盖的注册面（ERB 结构腿）内，请另立守卫`);
      continue;
    }
    if (actions.length === 0) {
      bad.push(`${row.code}：矩阵登记为有供方，实际一条动作都不给（空壳）`);
      continue;
    }
    for (const fix of actions) {
      if (fix.edits.length === 0) bad.push(`${row.code}：动作没有编辑（空壳）`);
      if (fix.diagnostic.code !== row.code) bad.push(`${row.code}：动作挂的波浪线码位是 ${fix.diagnostic.code}`);
      const repaired = applyStructureFix(hit.text, fix);
      if (repaired === hit.text) bad.push(`${row.code}：应用后文本没变（空壳）`);
      // 复检：这一枚码在这份文本上必须消失；**不许修出别的码**（orphan-close 的注释动作会留下"少一个开块"，
      // 所以逐动作只比同码位，不比全空）
      const after = checkControlFlowStructure(repaired).map(structureDiagnostic);
      if (after.some((d) => d.code === row.code && d.line === fix.issueLine)) {
        bad.push(`${row.code}：应用后同一条波浪线仍在（第 ${fix.issueLine} 行）`);
      }
      const afterAll = checkStructure(repaired, ERB_FILE).map(structureDiagnostic);
      if (afterAll.some((d) => d.code !== row.code)) {
        bad.push(`${row.code}：修出了别的码位（${afterAll.map((d) => d.code).join(', ')}）`);
      }
    }
  }
  return bad;
}

describe('ERB 快修面矩阵（QF-1）', () => {
  const produced = produceAll();

  it('(a) 码面闭集：矩阵 = 生产方导出的常量/拼法，逐码双向对账', () => {
    // 结构六枚取自 plugin-api 的闭集（与 diagnostic-copy 的双向对账同一条码面），拼法只住在 structureIssueCode
    const structureFromTable = NATIVE_STRUCTURE_CODES.filter((c) => c.startsWith('erb.'));
    const structureFromRows = ROWS.filter((r) => r.producedBy === 'structure' || r.producedBy === 'declaration' || r.producedBy === 'header').map((r) => r.code);
    expect([...structureFromTable].sort(), '结构/声明/头文件六枚码位 = plugin-api 闭集').toEqual([...structureFromRows].sort());
    // structureIssueCode 的拼法（erb.${kind}）必须仍是那一枚码的来源，不许生产方另拼
    expect(structureIssueCode({ kind: 'unclosed-open' } as ErbStructureIssue)).toBe('erb.unclosed-open');
    // 语义五枚取自各腿导出的常量（抄字符串就不算对账）
    for (const code of [UNDEFINED_CALL_CODE, UNDEFINED_TRY_CALL_CODE, ARITY_MISMATCH_CODE, ERB_UNDEFINED_NAME, BUILTIN_ARGS_CODE, BUILTIN_ARG_TYPE_CODE]) {
      expect(ERB_CODES.has(code), `${code} 必须在矩阵里登记`).toBe(true);
    }
    expect(new Set(ROWS.map((r) => r.code)).size, '矩阵不许有重复行').toBe(ROWS.length);
  });

  it('(a2) 每一行都有波浪线来源：fixture 真产出，或登记为来源扫描（且合成件确实产不出）', () => {
    const missing = ROWS.filter((r) => !produced.has(r.code)).map((r) => r.code);
    expect([...missing].sort(), '这些码位既没有 fixture 也没登记为来源扫描').toEqual([...SOURCE_ONLY_CODES].sort());
    // 来源扫描闸：那两枚常量必须仍被生产方自己贴进 decoration.code（不抄字符串、不靠注释）
    const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(src('../src/arity.ts'), 'arity.ts 仍须把 ARITY_MISMATCH_CODE 贴进诊断').toContain('code: ARITY_MISMATCH_CODE');
    expect(src('../src/builtins.ts'), 'builtins.ts 仍须把 BUILTIN_ARGS_CODE 贴进诊断').toContain('code: BUILTIN_ARGS_CODE');
    // "合成件确实产不出"也钉住：产得出就该转成 fixture 行，不许长期躲在来源扫描里
    expect(arityIssues(), 'arity 合成 fixture 仍产不出波浪线（产得出就把这行转成 fixture 来源）').toEqual([]);
    expect(builtinFixture(BUILTIN_ARGS_CODE), '内建实参个数档仍产不出波浪线（同上）').toBeNull();
  });

  it('(b) 供方行为闸：有供方的真修得动、复检干净；无供方的一条不给', () => {
    expect([...SUPPLIED].sort(), '今天有快修的 ERB 码位').toEqual(['erb.orphan-close', 'erb.unclosed-open']);
    expect(assertSuppliers(ROWS, produced), '矩阵与行为必须逐行一致').toEqual([]);
  });

  it('(c) 反向对照：摘掉一枚供方 / 凭空挂一枚供方，这条判据真的会红', () => {
    const mutatedOff = ROWS.map((r) => (r.code === 'erb.unclosed-open' ? { ...r, supplier: null } : r));
    const redOff = assertSuppliers(mutatedOff, produced);
    expect(redOff.length, '摘掉 unclosed-open 的供方后守卫必须红').toBeGreaterThan(0);
    expect(redOff.join('\n')).toContain('erb.unclosed-open');

    const mutatedOn = ROWS.map((r) => (r.code === 'erb.orphan-branch' ? { ...r, supplier: 'erb-structure-fix', action: '假装有动作' } : r));
    const redOn = assertSuppliers(mutatedOn, produced);
    expect(redOn.length, '给 orphan-branch 凭空挂供方后守卫必须红（空壳冒充覆盖）').toBeGreaterThan(0);
    expect(redOn.join('\n')).toContain('erb.orphan-branch');
  });

  it('(d) 两条匹配链不并：code+行精确应答，错行 / 错码 / 空诊断集一律零动作', () => {
    const text = STRUCTURE_FIXTURES['erb.unclosed-open']!;
    const issue = structureIssuesOf(text)[0]!;
    const deco = structureDiagnostic(issue);
    // 对得上：一条动作
    expect(buildStructureFixes(text, issue.line, [deco])).toHaveLength(1);
    // 行不对 ⇒ 不近似
    expect(buildStructureFixes(text, issue.line, [{ ...deco, line: issue.line + 1 }])).toEqual([]);
    // 码不对（约定线那族的 diagnosticKey 口径不该从本供方漏出来）⇒ 零动作
    expect(buildStructureFixes(text, issue.line, [{ ...deco, code: 'CONVENTION_ANY' }])).toEqual([]);
    // 空诊断集（零波浪线的请求）⇒ 零动作，宿主那道闸的前提
    expect(buildStructureFixes(text, issue.line, [])).toEqual([]);
    // 同一份波浪线的身份字段与装饰器同源：逐字段等于 structureDiagnostic（B9）
    const fix = buildStructureFixes(text, issue.line, [deco])[0]!;
    expect(fix.diagnostic).toEqual(deco);
    // 声明腿的码位（dim-invalid）今天没有供方：即便请求点明它，也一条不给
    const dimText = '#DIM CONST INT QF_GUARD_NOINIT\n';
    const dimDeco = structureDiagnostic(declarationIssues()[0]!);
    expect(dimDeco.code, '声明腿码位的拼法同源').toBe('erb.dim-invalid');
    expect(buildStructureFixes(dimText, dimDeco.line, [dimDeco])).toEqual([]);
  });
});
