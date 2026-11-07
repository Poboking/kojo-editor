/**
 * 诊断码闭环闸（D04a）——「生产方 ⇄ 码表」两个方向的一次性对账。
 *
 * 为什么要有这一道：`plugin-api/src/diagnostic-copy.ts` 里多组码表的注释都写着
 * 「对账钉在 `packages/app/tests/diagnostic-code-closure.test.ts`」，而那道闸此前**全仓并不存在**。
 * 于是两种缺陷都不可见：①生产方上屏了、码表没登记（作者读到裸 ASCII 码）；
 * ②码表登记了、没人产出（死条目，口径分叉的另一半）。
 *
 * 本文件**不手抄第二份名单**：产出侧一律从生产方源码机械派生，登记侧读契约层的实体
 * （各 roster + `DIAGNOSTIC_LABELS` 的键）。派生口径：
 *
 * 1. **常量形态**：`export const NAME = '<字面量>'`（SCREAMING_SNAKE）且该常量出现在 `code:` 位上。
 *    只认 `code:` 位，是为了把命令 id / 面板 id / 任务名这类"同名不同事"的导出常量挡在外面
 *    （`SLOT_CODE_ACTION_COMMAND` / `CALL_HIERARCHY_OVERLAY_ID` 一类不得混进来）。
 * 2. **模板族**（拼法由生产方唯一决定，消费方不许自己拼；前缀从生产方源码读出，不在此硬编码）：
 *    - `erb.${issue.kind}`——`plugins/erb-parser/src/structure.ts` 的 `structureIssueCode`，
 *      kind 集取契约类型 `ErbStructureIssue['kind']`；
 *    - `erb.expr-${diag.kind}`——`plugins/condition-extractor/src/decorator.ts`，kind 集取
 *      `ExprDiagnostic['kind']`；
 *    - `erb.${ERB_DIAGNOSTIC_CODE_PREFIX}${kind}`——`app/src/monaco/tree-sitter/erb-diagnostics.ts`，
 *      kind 集取 `ErbStructureDiagnosticKind`（= `KojoStructureSyntaxKind | 'unpaired-skip'`）；
 *    - `kojo.${kind}`——`app/src/monaco/tree-sitter/syntax-decorations.ts` 的 `syntaxErrorCode`；
 *    - `sugar.${码}`——`plugins/convention-linter/src/rules/sugar-conventions.ts` 的
 *      `sugarLintRuleIdOf`（码集取同文件的 `SUGAR_LINT_DIAGNOSTIC_CODES`）与同包的字面量
 *      `*_RULE_ID` 常量（`erb.duplicate-function` / `sugar.static-conventions`）。
 * 3. **糖码域**：`plugin-api/src/sugar-types.ts` 的 `SugarDiagnosticCode` 联合。生产者对它的赋值
 *    由类型系统强制（生产方不许拼表外字符串），所以联合就是产出域；联合里几枚**占位码**是
 *    登记在案的保留位（`plugins/eratw-adapter/src/tutorial-reference-expr.ts` 逐条写明
 *    「屏上不会出现这一条」），不算死码。
 *
 * 本闸明确**不覆盖**的码（各有各的台帐，且都不经 `diagnosticDisplay` 的码位面，故不进本表）：
 * `kojo2/storage-host/*`（通知中心 toast 的宿主码，`app/src/ui/kojo2-storage-adapter.ts:902`）、
 * `core/*`（core 诊断自己的命名空间）、`service/*` / `assembly/*`（宿主装配账）、`kojo-xml.*`、
 * MCP 的 `INVALID_ARGS` / `READ_FAILED` 一类传输错误码。它们要进本表，得先有各自的"上屏面"。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_FAILURE_CODES,
  DIAGNOSTIC_CODE_EXCLUSIONS,
  DIAGNOSTIC_LABELS,
  ERB_STRUCTURE_DIAGNOSTIC_CODES,
  KOJO_STRUCTURE_SYNTAX_CODES,
  NATIVE_CALL_CODES,
  NATIVE_EXPR_CODES,
  NATIVE_SEMANTIC_CODES,
  NATIVE_STRUCTURE_CODES,
  SUGAR_DIAGNOSTIC_CODES,
} from '@kojo/plugin-api';
import { KOJO_STRUCTURE_SYNTAX_KINDS } from '../src/monaco/tree-sitter/types';
import { syntaxErrorCode } from '../src/monaco/tree-sitter/syntax-decorations';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join('/');
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), 'utf8');

/* ============================== 源码扫描腿 ============================== */

/** 产出侧扫描根：插件源码 + app 源码（测试目录与 node_modules 不进） */
const SCAN_ROOTS = ['packages/plugins', 'packages/app/src'] as const;

interface SourceFile {
  /** 仓库相对路径（正斜杠） */
  readonly path: string;
  /** 已去注释的正文（块注释按字符换行占位 ⇒ 行号不变） */
  readonly text: string;
}

/** 去注释但**保留行号**：派生只看真代码，注释里写的拼法不算产出 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

let sourcesCache: readonly SourceFile[] | undefined;

function collect(dir: string, out: string[]): void {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // 测试目录不算产出方（fixture 里的码不是上屏真源）
      if (entry.name === 'tests' || entry.name === '__tests__') continue;
      collect(child, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\./.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    out.push(child);
  }
}

function sources(): readonly SourceFile[] {
  if (sourcesCache !== undefined) return sourcesCache;
  const paths: string[] = [];
  for (const root of SCAN_ROOTS) collect(root, paths);
  sourcesCache = paths.map((p) => ({ path: p, text: stripComments(read(p)) }));
  return sourcesCache;
}

const literalsOf = (typeBody: string): string[] =>
  [...typeBody.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]!);

/** 从生产方源码里取模板前缀（拼法一改这里先炸，不静默沿用旧前缀） */
function templatePrefix(where: string, text: string, slot: string): string {
  const found = new RegExp('`([^`$]*)\\$\\{' + slot + '\\}`').exec(text);
  if (found === null) {
    throw new Error(`${where}：找不到 \`…\${${slot}}\` 这条拼法（生产方改了码的拼法？）`);
  }
  return found[1]!;
}

function unionMembers(where: string, typeBody: string): string[] {
  const members = literalsOf(typeBody);
  if (members.length === 0) throw new Error(`${where}：联合里一个字符串字面量都没解析出来（源码形状变了？）`);
  return members;
}

/* ============================== 产出侧派生 ============================== */

interface DerivedFamily {
  /** 派生口径（进报错信息，一句话说清这枚码是从哪条规则来的） */
  readonly name: string;
  readonly codes: readonly string[];
}

/** 派生 1：导出常量形态——`export const NAME = '<字面量>'` 且 NAME 出现在 `code:` 位 */
function constantFamily(): DerivedFamily {
  const codeSlots = new Set<string>();
  for (const file of sources()) {
    for (const hit of file.text.matchAll(/\bcode:\s*([A-Za-z_]\w*)/g)) codeSlots.add(hit[1]!);
  }
  const codes = new Set<string>();
  for (const file of sources()) {
    for (const hit of file.text.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([^']+)'(?: as const)?;/g)) {
      if (codeSlots.has(hit[1]!)) codes.add(hit[2]!);
    }
  }
  return { name: '导出常量（code: 位上的 `<X>_CODE` / `ERB_*` 一族）', codes: [...codes] };
}

/** 派生 2a：`erb.${issue.kind}`（erb-parser `structureIssueCode`） */
function erbStructureFamily(): DerivedFamily {
  const contract = stripComments(read('packages', 'plugin-api', 'src', 'erb-types.ts'));
  const iface = /interface ErbStructureIssue \{[\s\S]*?\n\}/.exec(contract);
  if (iface === null) throw new Error('plugin-api/erb-types.ts：ErbStructureIssue 的形状变了');
  const kindBody = /readonly kind:\s*([^;]+);/.exec(iface[0]);
  if (kindBody === null) throw new Error('ErbStructureIssue：找不到 `readonly kind:` 那一行');
  const kinds = unionMembers('ErbStructureIssue.kind', kindBody[1]!);
  const producer = stripComments(read('packages', 'plugins', 'erb-parser', 'src', 'structure.ts'));
  const prefix = templatePrefix('erb-parser/src/structure.ts', producer, 'issue.kind');
  return { name: `${prefix}\${issue.kind}`, codes: kinds.map((kind) => `${prefix}${kind}`) };
}

/** 派生 2b：`erb.expr-${diag.kind}`（condition-extractor `decorator.ts`） */
function erbExprFamily(): DerivedFamily {
  const source = stripComments(read('packages', 'plugins', 'condition-extractor', 'src', 'expr.ts'));
  const iface = /export interface ExprDiagnostic \{[\s\S]*?\n\}/.exec(source);
  if (iface === null) throw new Error('condition-extractor/src/expr.ts：ExprDiagnostic 的形状变了');
  const kindBody = /kind:\s*([^;]+);/.exec(iface[0]);
  if (kindBody === null) throw new Error('ExprDiagnostic：找不到 `kind:` 那一行');
  const kinds = unionMembers('ExprDiagnostic.kind', kindBody[1]!);
  const producer = stripComments(read('packages', 'plugins', 'condition-extractor', 'src', 'decorator.ts'));
  const prefix = templatePrefix('condition-extractor/src/decorator.ts', producer, 'diag.kind');
  return { name: `${prefix}\${diag.kind}`, codes: kinds.map((kind) => `${prefix}${kind}`) };
}

/** 派生 2c：`erb.` + `ErbStructureDiagnosticKind`（app 的 ERB 结构层上屏器） */
function erbStructureLayerFamily(): DerivedFamily {
  const source = stripComments(
    read('packages', 'app', 'src', 'monaco', 'tree-sitter', 'erb-diagnostics.ts'),
  );
  const prefixHit = /export const ERB_DIAGNOSTIC_CODE_PREFIX = '([^']+)'/.exec(source);
  if (prefixHit === null) throw new Error('erb-diagnostics.ts：找不到 ERB_DIAGNOSTIC_CODE_PREFIX 的字面量');
  const prefix = prefixHit[1]!;
  // 两条发布点都得在：CST 那一跳（展开 kind 联合）与停用区配对（固定 unpaired-skip）
  if (!source.includes('`${ERB_DIAGNOSTIC_CODE_PREFIX}${fault.kind}`')) {
    throw new Error('erb-diagnostics.ts：`${ERB_DIAGNOSTIC_CODE_PREFIX}${fault.kind}` 这条拼法不见了');
  }
  if (!source.includes('`${ERB_DIAGNOSTIC_CODE_PREFIX}unpaired-skip`')) {
    throw new Error('erb-diagnostics.ts：`${ERB_DIAGNOSTIC_CODE_PREFIX}unpaired-skip` 这条拼法不见了');
  }
  const aliasHit = /export type ErbStructureDiagnosticKind = ([^;]+);/.exec(source);
  if (aliasHit === null) throw new Error('erb-diagnostics.ts：找不到 ErbStructureDiagnosticKind 的类型别名');
  const alias = aliasHit[1]!;
  const extras = literalsOf(alias);
  const bases = alias
    .replace(/'[^']+'/g, '')
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // 基类型只许是 `KojoStructureSyntaxKind`（多出一个基类型 ⇒ 这里红，别静默少派生一族）
  if (bases.length !== 1 || bases[0] !== 'KojoStructureSyntaxKind') {
    throw new Error(`erb-diagnostics.ts：ErbStructureDiagnosticKind 的基类型集合变成 [${bases.join(', ')}]`);
  }
  return {
    name: `${prefix}\${ErbStructureDiagnosticKind}`,
    codes: [...KOJO_STRUCTURE_SYNTAX_KINDS, ...extras].map((kind) => `${prefix}${kind}`),
  };
}

/** 派生 2d：`kojo.` + kind（`syntaxErrorCode` 是唯一拼法出处） */
function kojoStructureFamily(): DerivedFamily {
  const source = stripComments(
    read('packages', 'app', 'src', 'monaco', 'tree-sitter', 'syntax-decorations.ts'),
  );
  if (!source.includes('`${SYNTAX_CODE_PREFIX}${kind}`')) {
    throw new Error('syntax-decorations.ts：`${SYNTAX_CODE_PREFIX}${kind}` 这条拼法不见了');
  }
  return {
    name: 'kojo.${kind}（syntaxErrorCode）',
    codes: KOJO_STRUCTURE_SYNTAX_KINDS.map((kind) => syntaxErrorCode(kind)),
  };
}

/** 派生 2e：约定面板规则 id（`sugar.` + 码，以及字面量 `*_RULE_ID` 常量） */
function conventionRuleFamily(): DerivedFamily {
  const source = stripComments(
    read('packages', 'plugins', 'convention-linter', 'src', 'rules', 'sugar-conventions.ts'),
  );
  const prefixHit = /export const SUGAR_RULE_ID_PREFIX = '([^']+)'/.exec(source);
  if (prefixHit === null) throw new Error('sugar-conventions.ts：找不到 SUGAR_RULE_ID_PREFIX 的字面量');
  const prefix = prefixHit[1]!;
  if (!source.includes('`${SUGAR_RULE_ID_PREFIX}${code}`')) {
    throw new Error('sugar-conventions.ts：`${SUGAR_RULE_ID_PREFIX}${code}` 这条拼法不见了');
  }
  const lintBlock = /export const SUGAR_LINT_DIAGNOSTIC_CODES = \[([\s\S]*?)\] as const/.exec(source);
  if (lintBlock === null) throw new Error('sugar-conventions.ts：找不到 SUGAR_LINT_DIAGNOSTIC_CODES 清单');
  const codes = new Set<string>(literalsOf(lintBlock[1]!).map((code) => `${prefix}${code}`));
  // 同包的字面量规则 id（不经前缀函数的那两类：结构函数重名 / 静态约定汇总）
  for (const file of sources()) {
    if (!file.path.startsWith('packages/plugins/convention-linter/src/')) continue;
    for (const hit of file.text.matchAll(/export const [A-Z][A-Z0-9_]*_RULE_ID = '([^']+)';/g)) codes.add(hit[1]!);
  }
  return { name: `${prefix}${'<码>'}（约定面板规则 id）`, codes: [...codes] };
}

/** 派生 3：糖码域（转译器契约联合；生产者赋值由类型系统强制） */
function sugarFamily(): DerivedFamily {
  const source = stripComments(read('packages', 'plugin-api', 'src', 'sugar-types.ts'));
  const body = /export type SugarDiagnosticCode =([\s\S]*?);/.exec(source);
  if (body === null) throw new Error('plugin-api/sugar-types.ts：找不到 SugarDiagnosticCode 的联合定义');
  return { name: 'SugarDiagnosticCode（转译器契约联合）', codes: unionMembers('SugarDiagnosticCode', body[1]!) };
}

let familiesCache: readonly DerivedFamily[] | undefined;

function families(): readonly DerivedFamily[] {
  if (familiesCache !== undefined) return familiesCache;
  familiesCache = [
    constantFamily(),
    erbStructureFamily(),
    erbExprFamily(),
    erbStructureLayerFamily(),
    kojoStructureFamily(),
    conventionRuleFamily(),
    sugarFamily(),
  ];
  return familiesCache;
}

let producedCache: ReadonlyMap<string, string> | undefined;

/** 产出全集：码 → 派生它的那一族（报错时能一句话说清"这枚码是哪儿来的"） */
function produced(): ReadonlyMap<string, string> {
  if (producedCache !== undefined) return producedCache;
  const map = new Map<string, string>();
  for (const family of families()) {
    for (const code of family.codes) if (!map.has(code)) map.set(code, family.name);
  }
  producedCache = map;
  return map;
}

/* ============================== 登记侧（契约层实体） ============================== */

const ROSTERS: readonly { readonly name: string; readonly codes: readonly string[] }[] = [
  { name: 'SUGAR_DIAGNOSTIC_CODES', codes: SUGAR_DIAGNOSTIC_CODES },
  { name: 'NATIVE_STRUCTURE_CODES', codes: NATIVE_STRUCTURE_CODES },
  { name: 'NATIVE_EXPR_CODES', codes: NATIVE_EXPR_CODES },
  { name: 'NATIVE_CALL_CODES', codes: NATIVE_CALL_CODES },
  { name: 'NATIVE_SEMANTIC_CODES', codes: NATIVE_SEMANTIC_CODES },
  { name: 'KOJO_STRUCTURE_SYNTAX_CODES', codes: KOJO_STRUCTURE_SYNTAX_CODES },
  { name: 'ERB_STRUCTURE_DIAGNOSTIC_CODES', codes: ERB_STRUCTURE_DIAGNOSTIC_CODES },
  { name: 'APP_FAILURE_CODES', codes: APP_FAILURE_CODES },
];

const LABEL_KEYS: readonly string[] = Object.keys(DIAGNOSTIC_LABELS);

const hasChinese = (s: string): boolean => /[\u4e00-\u9fa5]/.test(s);

/* ============================== 闸 0：派生本身不空 ============================== */

describe('诊断码闭环：派生侧自检（别在空集合上自欺）', () => {
  it('每一族都派生出了码（生产方文件搬家 / 拼法改形 ⇒ 这里先红）', () => {
    for (const family of families()) {
      expect(family.codes.length, `派生族「${family.name}」一枚码都没派生出来`).toBeGreaterThan(0);
    }
  });

  it('产出总数与登记表都非空（闸不许在空清单上自欺）', () => {
    expect(produced().size).toBeGreaterThanOrEqual(70);
    expect(LABEL_KEYS.length).toBeGreaterThanOrEqual(60);
    for (const roster of ROSTERS) {
      expect(roster.codes.length, `码表 ${roster.name} 是空的`).toBeGreaterThan(0);
    }
  });
});

/* ============================== 闸 1：产出 ⊆ 登记 ============================== */

describe('诊断码闭环：产出 ⊆ 登记', () => {
  it('每个会上屏的码都有码表归属（生产方在产、没有任何码表收它 ⇒ 这里红）', () => {
    const registered = new Set<string>([
      ...ROSTERS.flatMap((roster) => roster.codes),
      ...LABEL_KEYS,
    ]);
    const missing = [...produced()]
      .filter(([code]) => !registered.has(code))
      .map(([code, family]) => `${code}　←　${family}`);
    expect(
      missing,
      `这些码由生产方产出、却没有任何码表收它（补进对应 roster / DIAGNOSTIC_LABELS）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('每个会上屏的码都有中文标签（或排除台账理由）——否则面板只能回落原码', () => {
    const missing = [...produced()]
      .filter(([code]) => {
        const named = DIAGNOSTIC_LABELS[code]?.name;
        const excluded = DIAGNOSTIC_CODE_EXCLUSIONS[code];
        return !(named !== undefined && named.trim() !== '') && !(excluded !== undefined && excluded.trim() !== '');
      })
      .map(([code, family]) => `${code}　←　${family}`);
    expect(
      missing,
      `这些码会上屏却没有中文短名（补 DIAGNOSTIC_LABELS，或进 DIAGNOSTIC_CODE_EXCLUSIONS 写明理由）：\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

/* ============================== 闸 2：登记 ⊆ 产出 ============================== */

describe('诊断码闭环：登记 ⊆ 产出', () => {
  it('码表里不许躺死码（登记了却没人产出 ⇒ 这里红）', () => {
    const dead: string[] = [];
    for (const roster of ROSTERS) {
      for (const code of roster.codes) {
        if (!produced().has(code)) dead.push(`${roster.name} → ${code}`);
      }
    }
    expect(
      dead,
      `这些码表条目对不上任何生产方（口径分叉：要么补生产方，要么从码表删掉）：\n${dead.join('\n')}`,
    ).toEqual([]);
  });
});

/* ============================== 闸 3：标签键的可解释性 ============================== */

describe('诊断码闭环：标签表的键必须站得住', () => {
  it('每个标签键要么被产出、要么在排除台账里且理由非空', () => {
    const unexplained: string[] = [];
    for (const code of LABEL_KEYS) {
      if (produced().has(code)) continue;
      const why = DIAGNOSTIC_CODE_EXCLUSIONS[code];
      if (why === undefined || why.trim().length === 0) unexplained.push(code);
    }
    expect(
      unexplained,
      `这些标签键在扫描根里找不到生产方，也没进 DIAGNOSTIC_CODE_EXCLUSIONS（不许静默留着）：\n${unexplained.join('\n')}`,
    ).toEqual([]);
  });
});

/* ============================== 闸 4：标签 / 台账的卫生 ============================== */

describe('诊断码闭环：标签与排除台账的卫生', () => {
  it('源码级查重：DIAGNOSTIC_LABELS 里没有同名键（对象字面量会静默覆盖同名键）', () => {
    const text = read('packages', 'plugin-api', 'src', 'diagnostic-copy.ts');
    const block = /export const DIAGNOSTIC_LABELS[\s\S]*?\n\}\);/.exec(text);
    expect(block, '找不到 DIAGNOSTIC_LABELS 的对象字面量（形状变了？）').not.toBeNull();
    const keys = [...block![0].matchAll(/^\s*(?:'([^']+)'|([A-Za-z_]\w*)):\s*\{/gm)].map(
      (hit) => hit[1] ?? hit[2]!,
    );
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const key of keys) {
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups, `这些键在源码里写了两遍（后一条会静默覆盖前一条）：${[...new Set(dups)].join(', ')}`).toEqual([]);
    // 源码里读到的键数必须与运行期对象一致：少一个就说明有键被同名覆盖吃掉了
    expect(keys.length, '源码键数与运行期对象键数不一致（有键被静默覆盖）').toBe(LABEL_KEYS.length);
  });

  it('标签值非空：短名非空串、短名是中文、说明要么不写要么写满', () => {
    for (const [code, label] of Object.entries(DIAGNOSTIC_LABELS)) {
      expect(code.trim(), '标签键是空串').not.toBe('');
      expect(label.name.trim(), `${code} 的短名是空串`).not.toBe('');
      expect(hasChinese(label.name), `${code} 的短名不是中文：${label.name}`).toBe(true);
      if (label.detail !== undefined) {
        expect(label.detail.trim(), `${code} 的说明是空串（要么删掉字段，要么写满）`).not.toBe('');
      }
    }
  });

  it('排除台账一条一理由、且不与标签表重复登记', () => {
    for (const [code, why] of Object.entries(DIAGNOSTIC_CODE_EXCLUSIONS)) {
      expect(why.trim(), `${code} 的排除没有理由`).not.toBe('');
      expect(code.includes(':') || code.includes('-') || code.includes('/'), `${code} 看着不像诊断码`).toBe(true);
      expect(DIAGNOSTIC_LABELS[code], `${code} 既有中文名又被豁免（两处口径打架）`).toBeUndefined();
    }
  });
});
