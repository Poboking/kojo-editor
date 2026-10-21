/**
 * Core 诊断码与诊断载荷。
 *
 * 纪律（设计稿 §10.6 / §11.3）：
 * - **core 码闭集，只增不改**；adapter 码必须带命名空间（`unit/*` `event/*` …）；
 * - error 阻断编译、warning 不阻断；所有诊断尽量带 span（可点回源行）；
 * - 码表与级别在这里**唯一定义**，任何消费方不得另抄一份字符串表。
 */
import type { KojoSpan } from './ast.js';

/** core 首批稳定码（与设计稿 §11.3 一一对应；词法/迁移类为 C1 实现所需 additive 扩码） */
export type CoreDiagnosticCode =
  /* 词法与结构（C1 additive） */
  | 'core/lex/anchor'
  | 'core/lex/indent'
  | 'core/lex/interpolation'
  /* 声明与名字 */
  | 'core/decl/duplicate-name'
  | 'core/decl/unknown-type'
  | 'core/decl/bad-initializer'
  | 'core/decl/unknown-storage'
  | 'core/decl/reserved-name'
  | 'core/decl/unknown-name'
  | 'core/decl/unknown'
  | 'core/decl/not-top-level'
  | 'core/decl/bad-array-size'
  | 'core/decl/const-cycle'
  | 'core/decl/const-not-constant'
  | 'core/decl/missing-machine'
  | 'core/decl/multiple-machine'
  | 'core/decl/multiple-view'
  /* 类型与表达式 */
  | 'core/expr/type-mismatch'
  | 'core/expr/assign-to-constant'
  | 'core/expr/readonly-target'
  | 'core/expr/bad-index'
  | 'core/expr/index-out-of-range'
  | 'core/expr/divide-by-zero'
  | 'core/expr/not-expression'
  | 'core/expr/unknown-symbol'
  | 'core/expr/bad-literal'
  | 'core/expr/void-in-expression'
  /* 表 */
  | 'core/table/overlap'
  | 'core/table/bad-range'
  | 'core/table/cycle'
  | 'core/table/missing-default'
  | 'core/table/empty-default'
  | 'core/table/type-mismatch'
  | 'core/table/dynamic-endpoint'
  | 'core/table/value-empty'
  | 'core/table/no-rows'
  | 'core/table/default-not-last'
  /* 池与模板 */
  | 'core/pool/no-default'
  | 'core/pool/empty-branch'
  | 'core/pool/side-effect'
  | 'core/pool/no-view'
  | 'core/pool/unknown-call'
  | 'core/pool/cycle'
  | 'core/pool/default-not-last'
  | 'core/template/missing-slot'
  | 'core/template/unexpected-slot'
  | 'core/template/multi-slot'
  | 'core/template/arg-count'
  | 'core/template/side-effect'
  /* 叙事与等待 */
  | 'core/narrative/bare-quote'
  | 'core/narrative/bare-narration'
  | 'core/narrative/unknown-speaker'
  | 'core/narrative/bad-hint'
  | 'core/wait/no-profile'
  | 'core/color/nested'
  | 'core/color/no-output'
  | 'core/color/unsupported'
  | 'core/face/unsupported'
  | 'core/face/args'
  /* 随机 */
  | 'core/random/one-candidate'
  | 'core/random/nested'
  | 'core/random/group-nested'
  | 'core/random/bare-control'
  | 'core/random/empty-line'
  | 'core/random/unsupported'
  /* 控制流与程序层 */
  | 'core/control/break-outside'
  | 'core/control/continue-outside'
  | 'core/control/bad-repeat'
  | 'core/control/constant-condition'
  | 'core/control/unsupported'
  | 'core/array/unsupported'
  | 'core/goto/unsupported'
  | 'core/goto/unknown-label'
  | 'core/goto/duplicate-label'
  | 'core/goto/label-in-block'
  | 'core/goto/cross-unit'
  | 'core/goto/backward'
  | 'core/func/return-outside'
  | 'core/func/return-mixed'
  | 'core/func/missing-return'
  | 'core/func/void-value'
  | 'core/func/recursion-unsupported'
  /* 原生与织入 */
  | 'core/native/empty'
  | 'core/native/indent'
  | 'core/native/disallowed-location'
  | 'core/weave/multiple-only'
  | 'core/weave/modifier-conflict'
  | 'core/weave/shadowed-listener'
  | 'core/weave/scene-inside'
  | 'core/weave/unsupported'
  /* 迁移、profile、feature */
  | 'core/migration/if'
  | 'core/migration/switch'
  | 'core/migration/loop'
  | 'core/migration/call-return'
  | 'core/migration/ask'
  | 'core/migration/hidden-timing'
  | 'core/migration/alias'
  | 'core/migration/color-option'
  | 'core/migration/comment'
  | 'core/migration/version'
  | 'core/migration/heart'
  | 'core/migration/color'
  | 'core/migration/random'
  | 'core/migration/data'
  | 'core/migration/branch'
  | 'core/migration/label'
  | 'core/migration/raw'
  | 'core/migration/timing'
  | 'core/migration/fullwidth-punct'
  | 'core/migration/wait'
  /* 存储期分配（project/storage，fail-closed 完整性面） */
  | 'core/storage/fingerprint-mismatch'
  | 'core/storage/snapshot-version'
  | 'core/storage/invalid-class'
  | 'core/storage/invalid-declaration'
  | 'core/storage/unknown-class'
  | 'core/storage/duplicate-key'
  | 'core/storage/duplicate-name'
  | 'core/storage/shape-changed'
  | 'core/storage/corrupt-snapshot'
  | 'core/storage/range-changed'
  | 'core/storage/exhausted'
  | 'core/options/pending'
  | 'core/profile/missing'
  | 'core/feature/unsupported';

/** warning 码（其余 core 码一律 error；码表唯一真源） */
export const CORE_WARNING_CODES: ReadonlySet<CoreDiagnosticCode> = new Set<CoreDiagnosticCode>([
  'core/color/no-output',
  'core/control/constant-condition',
  'core/goto/backward',
  'core/weave/shadowed-listener',
  'core/options/pending',
]);

/** adapter 诊断命名空间（additive，不覆盖 core 码） */
export type AdapterDiagnosticNamespace =
  | 'unit'
  | 'event'
  | 'symbol'
  | 'text'
  | 'variant'
  | 'overlay'
  | 'raw';

export type AdapterDiagnosticCode = `${AdapterDiagnosticNamespace}/${string}`;

export type DiagnosticCode = CoreDiagnosticCode | AdapterDiagnosticCode;

export function isCoreCode(code: string): code is CoreDiagnosticCode {
  return code.startsWith('core/');
}

export function severityOf(code: CoreDiagnosticCode | string): 'error' | 'warning' {
  return isCoreCode(code) && CORE_WARNING_CODES.has(code) ? 'warning' : 'error';
}

/** 一条诊断（core 与 adapter 共用形状；`span` 缺省 = 无精确落点） */
export interface KojoDiagnostic {
  readonly code: DiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly span: KojoSpan | null;
}

/** 诊断收集器：解析/降糖共用；**不静默**——抛错必须转成诊断或原样上抛 */
export interface DiagnosticSink {
  report(diagnostic: KojoDiagnostic): void;
  readonly all: readonly KojoDiagnostic[];
  hasError(): boolean;
}

export function createDiagnosticSink(): DiagnosticSink {
  const list: KojoDiagnostic[] = [];
  let errors = 0;
  return {
    report(diagnostic) {
      list.push(diagnostic);
      if (diagnostic.severity === 'error') errors++;
    },
    get all() {
      return list;
    },
    hasError() {
      return errors > 0;
    },
  };
}
