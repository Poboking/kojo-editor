/**
 * K2-CODES · batch-5 码表补齐（设计稿 §11.3 / §16.6 S5.6）验收。
 *
 * 钉三件事：
 * 1. **码表是闭集、只增不改**：`diagnostics.ts` 的 `CoreDiagnosticCode` 联合相对 batch-4
 *    基线只多出 batch-5 四条 + batch-7 一条（`core/migration/ambiguous-dialogue`，迁移期
 *    warning）+ LAU-D1 六枚（方言/事件/载体；`core/dialect/*` 三枚 + `core/event/*` 两枚 +
 *    `core/carrier/unowned`）；既有码逐条仍在（一条都不许删/改名）；无重复；batch-5 新码全部 error。
 * 2. **生产者真的用新码**（不是只写进表）：`pool-plan.ts` / `sema/check.ts` /
 *    `project/weave-layers.ts` 各自的正反例——正例必须命中新码，反例必须不命中，
 *    且**不再借用**此前那张借来的码（`core/expr/not-expression` /
 *    `core/expr/type-mismatch` / `core/weave/unsupported`）。
 * 3. **`# 设 x 整数[0]` 不放开**：设计稿 §3.4.2 写死「N 必须是正整数」，既有码
 *    `core/decl/bad-array-size` 已在表内 ⇒ parser 保持拒收（语义修正不在本批）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { GameAdapter } from '../src/adapter.js';
import { ADAPTER_VALIDATION_CODES } from '../src/adapter.js';
import type { KojoDecl, KojoFile, KojoSpan, KojoWeaveDecl, KojoWeaveModifier } from '../src/ast.js';
import { compileKojoSource } from '../src/compile.js';
import type { CoreDiagnosticCode } from '../src/diagnostics.js';
import { CORE_DIAGNOSTIC_CODES, CORE_WARNING_CODES, isCoreCode, severityOf } from '../src/diagnostics.js';
import { FIXTURE_ADAPTER, FIXTURE_BACKEND } from '../src/fixture-adapter.js';
import { planPoolDispatch } from '../src/lower/expand/pool-plan.js';
import { parseSource } from '../src/parser.js';
import { analyzeWeaveLayers } from '../src/project/weave-layers.js';
import type {
  WeaveLayerAdapterFacts,
  WeaveLayerDocument,
  WeaveLayerEventFact,
} from '../src/project/weave-layers.js';
import { checkKojoFile } from '../src/sema/index.js';

/* ============================== 0. 码表：闭集只增 ============================== */

/** 本批 additive 的四条（类型位置即编译期断言：它们必须真的在联合里） */
const BATCH5_CODES: readonly CoreDiagnosticCode[] = [
  'core/pool/duplicate-case',
  'core/func/arg-count',
  'core/array/whole-assign',
  'core/weave/not-weavable',
];

/**
 * batch-7（K2-MIGRATE-SHAPE）additive 的一条：迁移期"同形歧义"warning 台账。
 * 它不在 batch-5 的四条里，故单列一张表；下面的"差集"断言把两批一起算。
 */
const BATCH7_CODES: readonly CoreDiagnosticCode[] = ['core/migration/ambiguous-dialogue'];

/**
 * LAU-D1（方言载体契约）additive 的六枚（`ARCH-language-unification.md` §5.5 的码表落地批）。
 * 与 batch-5 的分工：那四条是"计划面/语义面"的补码，这六枚全部住在**方言/事件/载体**三格，
 * 且刻意**不复用** `event/*` `unit/*` 那两族适配器自检码（语义不同：那两族 = 适配器数据不合格）。
 * 严重度：`core/dialect/unbound` 与 `core/carrier/unowned` 是降级面 ⇒ warning；其余四枚 error。
 */
const LAUD1_CODES: readonly CoreDiagnosticCode[] = [
  'core/dialect/unbound',
  'core/dialect/mismatch',
  'core/dialect/response-mismatch',
  'core/event/unknown',
  'core/event/wrong-carrier',
  'core/carrier/unowned',
];

/** LAU-D1 里的 warning 两枚（降级不阻断，但必须可见） */
const LAUD1_WARNING_CODES: readonly CoreDiagnosticCode[] = ['core/dialect/unbound', 'core/carrier/unowned'];

/**
 * LAU-6（`@原生` 注入）additive 的一枚：子树失败退回"整块不透明"，主树四面照常。
 * 与 LAU-D1 六枚同批口径（闭集只增），但生产者不在核心——它在宿主注入层，
 * 这里只钉"码在闭集里、级别是 warning"。
 */
const LAU6_CODES: readonly CoreDiagnosticCode[] = ['core/injection/child-failed'];

/**
 * 2026-10-29 语法口径批：`@原生{ … }` 花括号收口新写法 additive 的一枚——
 * braced 块体结束后没等到同缩进的单独一行 `}`（裸 `@原生` 旧写法不受影响）。
 */
const NATIVE_BRACE_CODES: readonly CoreDiagnosticCode[] = ['core/native/unclosed'];

/**
 * LAU-D4 车②（表层↔原生双向映射表）additive 的**三枚** `core/surface/*`：
 * `dangling`（表指向不存在的原生写法 / 落点与事实面不同 / 条目形状坏）、
 * `contested`（同一原生写法被两条表层名争用，及一名两落点、同名两遍）、
 * `unmapped`（事实面有名字而表里缺）。生产者只有一处
 * （`surface-map.ts::checkSurfaceMap`），三枚**全 error**——车② 的判据就是"错配必红"，
 * 降级成 warning 等于把方言包的数据写反说成"仅供参考"。
 */
const LAUD4_SURFACE_CODES: readonly CoreDiagnosticCode[] = [
  'core/surface/dangling',
  'core/surface/contested',
  'core/surface/unmapped',
];

/**
 * batch-4 收工时的全表（`git show <batch-4>/diagnostics.ts`）。
 *
 * **这是"闭集只增不改"的锁**：既有码逐条仍须在场；本批相对它的差集必须**恰为**
 * `BATCH5_CODES`。后续批次新增码时同步扩这里（有意为之的闸：闭集扩一条必须被看见）。
 */
const BATCH4_BASELINE: readonly string[] = `
core/lex/anchor core/lex/indent core/lex/interpolation
core/decl/duplicate-name core/decl/unknown-type core/decl/bad-initializer
core/decl/unknown-storage core/decl/reserved-name core/decl/unknown-name core/decl/unknown
core/decl/not-top-level core/decl/bad-array-size core/decl/const-cycle
core/decl/const-not-constant core/decl/missing-machine core/decl/multiple-machine
core/decl/multiple-view
core/expr/type-mismatch core/expr/assign-to-constant core/expr/readonly-target
core/expr/bad-index core/expr/index-out-of-range core/expr/divide-by-zero
core/expr/not-expression core/expr/unknown-symbol core/expr/bad-literal
core/expr/void-in-expression
core/table/overlap core/table/bad-range core/table/cycle core/table/missing-default
core/table/empty-default core/table/type-mismatch core/table/dynamic-endpoint
core/table/value-empty core/table/no-rows core/table/default-not-last
core/pool/no-default core/pool/empty-branch core/pool/side-effect core/pool/no-view
core/pool/unknown-call core/pool/cycle core/pool/default-not-last
core/template/missing-slot core/template/unexpected-slot core/template/multi-slot
core/template/arg-count core/template/side-effect
core/narrative/bare-quote core/narrative/bare-narration core/narrative/unknown-speaker
core/narrative/bad-hint core/wait/no-profile
core/color/nested core/color/no-output core/color/unsupported
core/face/unsupported core/face/args
core/random/one-candidate core/random/nested core/random/group-nested
core/random/bare-control core/random/empty-line core/random/unsupported
core/control/break-outside core/control/continue-outside core/control/bad-repeat
core/control/constant-condition core/control/unsupported
core/array/unsupported
core/goto/unsupported core/goto/unknown-label core/goto/duplicate-label
core/goto/label-in-block core/goto/cross-unit core/goto/backward
core/func/return-outside core/func/return-mixed core/func/missing-return
core/func/void-value core/func/recursion-unsupported
core/native/empty core/native/indent core/native/disallowed-location
core/weave/multiple-only core/weave/modifier-conflict core/weave/shadowed-listener
core/weave/scene-inside core/weave/unsupported
core/migration/if core/migration/switch core/migration/loop core/migration/call-return
core/migration/ask core/migration/hidden-timing core/migration/alias
core/migration/color-option core/migration/comment core/migration/version
core/migration/heart core/migration/color core/migration/random core/migration/data
core/migration/branch core/migration/label core/migration/raw core/migration/timing
core/migration/fullwidth-punct core/migration/wait
core/storage/fingerprint-mismatch core/storage/snapshot-version core/storage/invalid-class
core/storage/invalid-declaration core/storage/unknown-class core/storage/duplicate-key
core/storage/duplicate-name core/storage/shape-changed core/storage/corrupt-snapshot
core/storage/range-changed core/storage/exhausted
core/options/pending core/profile/missing core/feature/unsupported
`
  .trim()
  .split(/\s+/u);

/**
 * 2026-10-26 批 additive 的一条：`# 方言` 断言查重（`core/decl/multiple-dialect`）。
 * 与 LAU-D1 的分工：那六枚住方言/事件/载体三格；这条只回答"本文件里有几条断言"，
 * parser 层即可判定，不碰任何方言取值。
 */
const ODD_END_CODES: readonly CoreDiagnosticCode[] = ['core/decl/multiple-dialect'];

/** 从源码文本抽 `CoreDiagnosticCode` 联合里逐字声明的码（类型联合运行期不存在，只能抽文本） */
function declaredCoreCodes(): string[] {
  const path = fileURLToPath(new URL('../src/diagnostics.ts', import.meta.url));
  const src = readFileSync(path, 'utf8');
  // 2026-10-26 批：联合改成 `const CORE_DIAGNOSTIC_CODE_LIST = [...] as const` 派生
  // （类型与运行期闭集同源，见 `isCoreCode`），守卫跟着抽那张数组。
  const block = /const CORE_DIAGNOSTIC_CODE_LIST = \[([\s\S]*?)\] as const;/.exec(src);
  if (block === null) throw new Error('抽不到 CORE_DIAGNOSTIC_CODE_LIST——守卫自身失效，必须查');
  const codes = [...block[1]!.matchAll(/'(core\/[a-z0-9/-]+)'/gu)].map((match) => match[1]!);
  if (codes.length < 100) throw new Error(`只抽到 ${codes.length} 条码：码表格式变了，守卫先修`);
  return codes;
}

describe('码表 · 闭集只增（S5.6）', () => {
  const declared = declaredCoreCodes();

  it('四条新码都在联合里，且全表无重复条目', () => {
    for (const code of BATCH5_CODES) expect(declared, `${code} 不在 CoreDiagnosticCode 联合里`).toContain(code);
    expect(new Set(declared).size, '联合里有重复码（闭集表被抄重）').toBe(declared.length);
  });

  it('batch-4 基线的每一条既有码都还在（只增不改：删/改名即红）', () => {
    const missing = BATCH4_BASELINE.filter((code) => !declared.includes(code));
    expect(missing, `既有码被删/改名：${missing.join(' / ')}`).toEqual([]);
  });

  it('本批相对基线的差集恰为 batch-5 四条 + batch-7 一条 + LAU-D1 六枚 + 2026-10-26 批一条 + LAU-6 一枚 + 原生花括号一枚 + LAU-D4 车② 三枚（多一条/少一条都要过审）', () => {
    const baseline = new Set(BATCH4_BASELINE);
    const added = declared.filter((code) => !baseline.has(code));
    expect(added.sort()).toEqual(
      [...BATCH5_CODES, ...BATCH7_CODES, ...LAUD1_CODES, ...ODD_END_CODES, ...LAU6_CODES, ...NATIVE_BRACE_CODES, ...LAUD4_SURFACE_CODES].sort(),
    );
  });

  it('LAU-D4 车② 三枚都在闭集里、全是 error（错配必红 ⇒ 一张表不许降级成"仅供参考"）', () => {
    for (const code of LAUD4_SURFACE_CODES) {
      expect(declared, `${code} 不在 CoreDiagnosticCode 联合里`).toContain(code);
      expect(CORE_WARNING_CODES.has(code), `${code} 不该是 warning`).toBe(false);
      expect(severityOf(code)).toBe('error');
      expect(CORE_DIAGNOSTIC_CODES.has(code)).toBe(true);
    }
  });

  it('原生花括号批的 `core/native/unclosed` 在闭集里、是 error（缺收口不静默）', () => {
    for (const code of NATIVE_BRACE_CODES) {
      expect(declared).toContain(code);
      expect(CORE_WARNING_CODES.has(code)).toBe(false);
      expect(severityOf(code)).toBe('error');
      expect(CORE_DIAGNOSTIC_CODES.has(code)).toBe(true);
    }
  });

  it('LAU-6 的 `core/injection/child-failed` 在闭集里、是 warning（降级面不阻断）', () => {
    for (const code of LAU6_CODES) {
      expect(declared, `${code} 不在 CoreDiagnosticCode 联合里`).toContain(code);
      expect(CORE_WARNING_CODES.has(code), `${code} 必须是 warning`).toBe(true);
      expect(severityOf(code)).toBe('warning');
      expect(CORE_DIAGNOSTIC_CODES.has(code)).toBe(true);
    }
  });

  it('2026-10-26 批的 `core/decl/multiple-dialect` 在闭集里、是 error，且运行期闭集与类型同源', () => {
    for (const code of ODD_END_CODES) {
      expect(declared).toContain(code);
      expect(CORE_WARNING_CODES.has(code)).toBe(false);
      expect(severityOf(code)).toBe('error');
      // 运行期闭集（isCoreCode 的判据）与文本抽取的码表逐条相等
      expect(CORE_DIAGNOSTIC_CODES.has(code)).toBe(true);
    }
    expect([...CORE_DIAGNOSTIC_CODES].sort()).toEqual([...declared].sort());
  });

  it('isCoreCode 查闭集：自造的 `core/x` 过不了类型守卫（不再按前缀放行）', () => {
    expect(isCoreCode('core/decl/unknown')).toBe(true);
    expect(isCoreCode('core/x')).toBe(false);
    expect(isCoreCode('core/')).toBe(false);
    expect(isCoreCode('unit/unknown')).toBe(false);
    expect(severityOf('core/x')).toBe('error'); // 非 core 码一律 error 档，但不会被当 core 码消费
  });

  it('LAU-D1 六枚都在闭集里，且严重度按声明落位（两枚 warning / 四枚 error）', () => {
    for (const code of LAUD1_CODES) {
      expect(declared, `${code} 不在 CoreDiagnosticCode 联合里`).toContain(code);
      const expectWarning = LAUD1_WARNING_CODES.includes(code);
      expect(CORE_WARNING_CODES.has(code), `${code} 的 warning 归属不符`).toBe(expectWarning);
      expect(severityOf(code), `${code} 的严重度不符`).toBe(expectWarning ? 'warning' : 'error');
    }
    // error 四枚逐条点名（防止有人顺手把冲突也降成 warning）
    for (const code of ['core/dialect/mismatch', 'core/dialect/response-mismatch', 'core/event/unknown', 'core/event/wrong-carrier']) {
      expect(severityOf(code), `${code} 必须是 error`).toBe('error');
    }
  });

  it('LAU-D1 不吃适配器自检码：`event/unknown` 仍是 `event/*` 族、语义与级别不动', () => {
    expect(ADAPTER_VALIDATION_CODES.eventUnknown).toBe('event/unknown');
    expect(isCoreCode(ADAPTER_VALIDATION_CODES.eventUnknown)).toBe(false);
    expect(LAUD1_CODES).toContain('core/event/unknown');
    // 作者面码与自检码是两条串，聚合时才分得开
    expect(LAUD1_CODES.map(String)).not.toContain('event/unknown');
  });

  it('batch-7 的同形歧义码是 warning（迁移期保留现状，不阻断）', () => {
    for (const code of BATCH7_CODES) {
      expect(declared, `${code} 不在 CoreDiagnosticCode 联合里`).toContain(code);
      expect(CORE_WARNING_CODES.has(code), `${code} 必须是 warning`).toBe(true);
      expect(severityOf(code)).toBe('warning');
    }
  });

  it('新码全部 error（不在 warning 集合里，severityOf 逐条为 error）', () => {
    for (const code of BATCH5_CODES) {
      expect(CORE_WARNING_CODES.has(code), `${code} 不该是 warning`).toBe(false);
      expect(severityOf(code)).toBe('error');
    }
  });

  it('命名空间归属：各落既有 `core/<域>/` 前缀，不吃别人的域', () => {
    expect(BATCH5_CODES.map((code) => code.split('/')[1])).toEqual(['pool', 'func', 'array', 'weave']);
    for (const code of BATCH5_CODES) {
      expect(code.startsWith('core/')).toBe(true);
      // 每条都落在既有域里：既有域在基线里已有别的码（不是本批私造的新命名空间）
      const domain = code.split('/')[1]!;
      expect(
        BATCH4_BASELINE.some((baseline) => baseline.startsWith(`core/${domain}/`)),
        `core/${domain}/ 不是既有命名空间`,
      ).toBe(true);
    }
  });

  it('`core/decl/bad-array-size` 是既有码（`[0]` 收口不需要新码）', () => {
    expect(BATCH4_BASELINE).toContain('core/decl/bad-array-size');
    expect(declared).toContain('core/decl/bad-array-size');
    expect(BATCH5_CODES).not.toContain('core/decl/bad-array-size');
  });
});

/* ============================== 1. core/pool/duplicate-case ============================== */

const MACHINE = ['# 机 开场', '# 视角 灵梦'];

function poolOf(lines: readonly string[]) {
  const file = parseSource(lines.join('\n'));
  for (const decl of file.decls) if (decl.kind === 'pool') return decl;
  throw new Error('fixture 里没有 `# 池` 声明');
}

const DUPLICATE_POOL = [
  ...MACHINE,
  '# 池 甲',
  '    ? 好感 == 0',
  '        > 甲',
  '    ? 好感 == 0',
  '        > 乙',
  '    ? 否',
  '        > 丙',
];

describe('生产者 · core/pool/duplicate-case（等值键重复）', () => {
  it('等值键重复 → error + 新码，指向后一档（不再借用 not-expression）', () => {
    const plan = planPoolDispatch(poolOf(DUPLICATE_POOL));
    expect(plan.style).toBe('error');
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/pool/duplicate-case']);
    expect(plan.diagnostics[0]!.severity).toBe('error');
    expect(plan.diagnostics[0]!.message).toContain('重复');
    expect(plan.diagnostics[0]!.span?.start.line).toBe(6); // 第二个 `? 好感 == 0`
    expect(plan.diagnostics.map((item) => String(item.code))).not.toContain('core/expr/not-expression');
  });

  it('反例：键互不相同 → selectcase、零诊断（不误报）', () => {
    const plan = planPoolDispatch(
      poolOf([
        ...MACHINE,
        '# 池 甲',
        '    ? 好感 == 0',
        '        > 甲',
        '    ? 好感 == 1',
        '        > 乙',
        '    ? 否',
        '        > 丙',
      ]),
    );
    expect(plan.style).toBe('selectcase');
    expect(plan.diagnostics).toEqual([]);
  });

  it('分工：缺 `? 否` 仍走旧码 `core/pool/no-default`，不会被新码吞并', () => {
    const plan = planPoolDispatch(
      poolOf([...MACHINE, '# 池 甲', '    ? 好感 == 0', '        > 甲', '    ? 好感 == 1', '        > 乙']),
    );
    expect(plan.diagnostics.map((item) => item.code)).toEqual(['core/pool/no-default']);
    expect(plan.diagnostics.map((item) => String(item.code))).not.toContain('core/pool/duplicate-case');
  });

  it('编译主链：计划不自洽 ⇒ ok=false、零字节、诊断带新码', () => {
    const result = compileKojoSource({
      source: [...DUPLICATE_POOL, '! 甲'].join('\n'),
      adapter: FIXTURE_ADAPTER,
      backend: FIXTURE_BACKEND,
    });
    expect(result.ok).toBe(false);
    expect(result.erb).toBe('');
    expect(result.diagnostics.map((item) => String(item.code))).toContain('core/pool/duplicate-case');
  });
});

/* ============================== 2. core/func/arg-count ============================== */

/** 全开能力 adapter：隔离"能力闸"，只看参数个数判定 */
const CAPABLE_ADAPTER: GameAdapter = {
  ...FIXTURE_ADAPTER,
  programFeatures: { arrays: true, while: true, goto: true, recursion: true, foreach: true, repeat: true },
};

const codes = (text: string, adapter: GameAdapter = CAPABLE_ADAPTER): string[] =>
  checkKojoFile(parseSource(text), { adapter, filePath: 'codes.kojo2' }).diagnostics.map((item) =>
    String(item.code),
  );

const FN_TWO = `@函 加(甲, 乙=2)
    @返 甲 + 乙
`;

describe('生产者 · core/func/arg-count（@函 实参个数）', () => {
  it('缺必填：形参没有默认值却没给 → error + 新码', () => {
    const text = `${FN_TWO}! 加()\n`;
    expect(codes(text)).toContain('core/func/arg-count');
    const diagnostic = checkKojoFile(parseSource(text), { adapter: CAPABLE_ADAPTER }).diagnostics.find(
      (item) => item.code === 'core/func/arg-count',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('第 1 个形参');
    expect(diagnostic?.message).toContain('至少要给 1 个');
  });

  it('多给：实参数超过形参表 → 同一码（多出的不传给函数）', () => {
    const text = `${FN_TWO}! 加(1, 2, 3)\n`;
    const match = checkKojoFile(parseSource(text), { adapter: CAPABLE_ADAPTER }).diagnostics.find(
      (item) => item.code === 'core/func/arg-count',
    );
    expect(match).toBeDefined();
    expect(match?.message).toContain('只有 2 个形参');
    expect(match?.message).toContain('多出的 1 个');
  });

  it('反例：个数正好 / 省略有默认值的尾参 → 不报', () => {
    expect(codes(`${FN_TWO}! 加(1)\n`)).not.toContain('core/func/arg-count');
    expect(codes(`${FN_TWO}! 加(1, 2)\n`)).not.toContain('core/func/arg-count');
  });

  it('边角：默认值写在中间时按位置取必填下界（`函(a=1, b)` 给 1 个仍缺 b）', () => {
    const text = `@函 混(甲=1, 乙)
    @返 乙
! 混(5)
`;
    const match = checkKojoFile(parseSource(text), { adapter: CAPABLE_ADAPTER }).diagnostics.find(
      (item) => item.code === 'core/func/arg-count',
    );
    expect(match?.message).toContain('第 2 个形参');
  });

  it('不猜：未声明名字的调用不判个数；也不挪用模板专用码', () => {
    const unknown = `${FN_TWO}! 外部函数()\n`;
    expect(codes(unknown)).not.toContain('core/func/arg-count');
    expect(codes(`${FN_TWO}! 加()\n`)).not.toContain('core/template/arg-count');
  });
});

/* ============================== 3. core/array/whole-assign ============================== */

describe('生产者 · core/array/whole-assign（数组整体赋值）', () => {
  const HEADER = `# 设 队列 整数[3]
# 设 数 整数
`;

  it('`队列 = 1` → error + 新码（不再借用 type-mismatch）', () => {
    const text = `${HEADER}@算
    队列 = 1
`;
    expect(codes(text)).toContain('core/array/whole-assign');
    expect(codes(text)).not.toContain('core/expr/type-mismatch');
  });

  it('反例：写元素 / 读 `.长度` 都不报', () => {
    const text = `${HEADER}@算
    队列[0] = 1
    数 = 队列.长度
`;
    expect(codes(text)).not.toContain('core/array/whole-assign');
  });

  it('不误伤：标量的类型不符仍走 type-mismatch（两件事不合并）', () => {
    const text = `${HEADER}@算
    数 = "一"
`;
    expect(codes(text)).toContain('core/expr/type-mismatch');
    expect(codes(text)).not.toContain('core/array/whole-assign');
  });
});

/* ============================== 4. core/weave/not-weavable ============================== */

const sp = (line: number, column = 1): KojoSpan => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

const weave = (event: string, modifiers: readonly KojoWeaveModifier[] = [], line = 1): KojoWeaveDecl => ({
  kind: 'weave',
  event,
  args: [],
  modifiers,
  body: [],
  span: sp(line),
});

const fileOf = (decls: readonly KojoDecl[]): KojoFile => ({ decls, scenes: [], diagnostics: [] });

const doc = (filePath: string, decls: readonly KojoWeaveDecl[]): WeaveLayerDocument => ({
  filePath,
  file: fileOf(decls),
});

const adapter = (events: readonly WeaveLayerEventFact[]): WeaveLayerAdapterFacts => ({
  eventCatalog: { events },
  layerPolicy: {
    defaultMode: 'unique',
    rules: [
      { target: 'event-hook', mode: 'unique' },
      { target: 'kojo-overlay', mode: 'unique' },
    ],
  },
});

describe('生产者 · core/weave/not-weavable（weavable: false）', () => {
  it('weavable=false → error + 新码，逐块 blocked（不再借用 unsupported）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', [], 1)])],
      adapter([{ event: '回合末', priority: 'emuera-buckets', weavable: false }]),
    );
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0]!;
    expect(conflict.kind).toBe('not-weavable');
    expect(conflict.code).toBe('core/weave/not-weavable');
    expect(conflict.severity).toBe('error');
    expect(result.units[0]!.verdict).toBe('blocked');
    expect(result.units[0]!.codes).toEqual(['core/weave/not-weavable']);
    expect(String(conflict.code)).not.toBe('core/weave/unsupported');
  });

  it('反例：weavable 缺省 / 显式 true ⇒ 可监听、零冲突', () => {
    const implicit = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', [], 1)])],
      adapter([{ event: '回合末', priority: 'emuera-buckets' }]),
    );
    expect(implicit.conflicts).toEqual([]);
    const explicit = analyzeWeaveLayers(
      [doc('a.kojo', [weave('回合末', [], 1)])],
      adapter([{ event: '回合末', priority: 'emuera-buckets', weavable: true }]),
    );
    expect(explicit.conflicts).toEqual([]);
  });

  it('分工：未知事件仍走 `core/weave/unsupported`（两种"不能监听"不合并）', () => {
    const result = analyzeWeaveLayers(
      [doc('a.kojo', [weave('不存在的事件', [], 1)])],
      adapter([{ event: '回合末', priority: 'emuera-buckets' }]),
    );
    expect(result.conflicts.map((item) => item.code)).toEqual(['core/weave/unsupported']);
    expect(result.conflicts.map((item) => String(item.code))).not.toContain('core/weave/not-weavable');
  });
});

/* ============================== 5. `# 设 x 整数[0]`：设计稿拒收，不放开 ============================== */

describe('`整数[0]` · 设计稿 §3.4.2「N 必须是正整数」⇒ 保持拒收（语义修正不在本批）', () => {
  /** parser 诊断住在 `file.diagnostics`（`checkKojoFile` 只看 sema 层） */
  const parserCodes = (text: string): string[] =>
    parseSource(text).diagnostics.map((item) => String(item.code));

  it('字面量 `[0]` 被 parser 拒：既有码 `core/decl/bad-array-size`', () => {
    expect(parserCodes('# 设 队列 整数[0]\n')).toContain('core/decl/bad-array-size');
  });

  it('常量 0 长度同样拒（sema 侧既有判定），`[1]` 是合法对照', () => {
    expect(codes('# 设 零 整数 = 0\n# 设 队列 整数[零]\n')).toContain('core/decl/bad-array-size');
    expect(parserCodes('# 设 队列 整数[1]\n')).not.toContain('core/decl/bad-array-size');
  });
});
