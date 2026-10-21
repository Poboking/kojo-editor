/**
 * eraTW 的 `@巡` 索引循环发射器（K2-FOREACH）—— **游戏事实只住本包**。
 *
 * 输入是 core 校验过的 `ForeachLoopPlan`（槽名 / 绑定事实 / 长度机制 / 空集跳过），
 * 输出 Emuera 的 `FOR <下标槽>, 0, <长度>` … `NEXT`：
 *
 * - **结束值不含**：`FOR COUNT, 0, X` 与 `REPEAT X` 同为 X 轮（Emuera 手册 FOR-NEXT），
 *   所以空集合（长度 0）天然零轮，不需要额外 `IF`；
 * - `@续` 落 `CONTINUE` 时会走 `NEXT` 的自增，不会像手写"WHILE + 尾部 `i += 1`"那样死循环；
 * - `{下标}` 直接用下标槽；数组的 `{值}` 每轮写 `值槽 = 集合表达式:(下标槽)`；
 * - 角色集合的 `{角}` 每轮写 `角色号 = 下标 + base`，`{名}` 用 adapter 的
 *   `nameAccessor`（`CALLNAME`）按角色号派生到名字槽；
 * - 键值集合（`{项}`/`{键}`）没有 eraTW 落点 ⇒ **fail-closed**（不猜键的取法）。
 *
 * 本文件不 import core 以外的插件；表达式编译由宿主注入（与 `backend.ts` 同端口）。
 * 失败一律返回 `EmitFailure`（`unit/backend-incomplete`），**不产半成品行**。
 */
import type { EmitFailure, EmitResult, KojoDiagnostic, KojoExprText, KojoSpan } from '@kojo/kojo-core';
import { isEmitFailure } from '@kojo/kojo-core';
import type {
  ForeachBindingFact,
  ForeachLengthDecl,
  ForeachLoopPlan,
} from '../../../../kojo-core/src/lower/expand/foreach.js';

/** 函数体缩进（1 级 = 4 空格；与 backend 的 `# 机` 包装同口径） */
const INDENT = '    ';

/** 未声明落点的 fail-closed 诊断码（adapter 命名空间 `unit/*`） */
const BACKEND_INCOMPLETE = 'unit/backend-incomplete' as const;

/** 一维数组名（CJK 合法；只认单段标识符，不把下标链塞进 `名:(下标)`） */
const ARRAY_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

export interface EratwForeachEmitOptions {
  /** 2.0 表达式源切片 → ERB 表达式（宿主注入 v1 expression 管线） */
  readonly compileExpression: (expr: KojoExprText) => string | EmitFailure;
  /** 一级缩进（默认 4 空格；测试/嵌套可覆盖） */
  readonly indent?: string;
}

function fail(message: string, span: KojoSpan): EmitFailure {
  const diagnostic: KojoDiagnostic = Object.freeze({
    code: BACKEND_INCOMPLETE,
    severity: 'error',
    message,
    span,
  });
  return Object.freeze({ diagnostics: Object.freeze([diagnostic]) });
}

/** 长度机制 → `FOR` 的结束值（不含） */
function renderLength(length: ForeachLengthDecl): string {
  if (length.kind === 'declared') return String(length.size);
  const counter = length.counter.trim();
  return length.minus === 0 ? counter : `${counter} - ${length.minus}`;
}

function bindingOf(plan: ForeachLoopPlan, source: 'element' | 'name'): ForeachBindingFact | undefined {
  return plan.bindings.find((binding) => binding.source === source);
}

/**
 * 把 core 计划落成 eraTW 的索引循环行（`FOR`/`NEXT`）。
 *
 * @param plan  core `planForEachLoop` 的成功计划（`ok: true`）
 * @param body  已降糖的循环体行（core 的 walk 提供；本层只缩进，不改写）
 * @returns     多行产物；表达不了时返回 `EmitFailure`（诊断已带 span）
 */
export function emitEratwForEachLoop(
  plan: ForeachLoopPlan,
  body: readonly string[],
  options: EratwForeachEmitOptions,
): EmitResult {
  const indent = options.indent ?? INDENT;

  if (plan.kind !== 'array' && plan.kind !== 'characters') {
    const detail =
      plan.kind === 'records'
        ? '键值集合的 {项}/{键} 取法没有 eraTW 落点'
        : `未知集合类别 ${String(plan.kind)}`;
    return fail(
      `\`@巡 ${plan.collection}\` 不能生成索引循环：${detail}；请改用数组或角色集合（不猜落点）。`,
      plan.span,
    );
  }

  const indexName = plan.index.name;
  const inner: string[] = [];

  const element = bindingOf(plan, 'element');
  if (element !== undefined) {
    if (plan.kind === 'array') {
      const compiled = options.compileExpression(plan.collectionExpr);
      if (isEmitFailure(compiled)) return compiled;
      const target = compiled.trim();
      if (target.length === 0) {
        return fail(
          `集合表达式「${plan.collectionExpr.text}」编译成空串：不能生成 \`@巡\` 的取元素行。`,
          plan.span,
        );
      }
      if (!ARRAY_NAME_RE.test(target)) {
        return fail(
          `集合表达式「${plan.collectionExpr.text}」编译成“${target}”，不是单一变量名：\`@巡\` 数组只支持一维数组名（不猜下标链）。`,
          plan.span,
        );
      }
      // Emuera 的数组元素是 `名:(下标表达式)`（`CFLAG:(A + 1)` 同形），不是 2.0 表层的 `名[下标]`
      inner.push(`${indent}${element.slot} = ${target}:(${indexName})`);
    } else {
      const elementValue = plan.base === 0 ? indexName : `${indexName} + ${plan.base}`;
      inner.push(`${indent}${element.slot} = ${elementValue}`);
    }
  }

  const name = bindingOf(plan, 'name');
  if (name !== undefined) {
    const accessor = plan.nameAccessor;
    if (accessor === null || accessor.trim().length === 0 || element === undefined) {
      return fail(
        `\`@巡 ${plan.collection}\` 声明了 {名}，但缺少名字访问器或角色号槽：不能生成名字派生行（不猜）。`,
        plan.span,
      );
    }
    inner.push(`${indent}${name.slot} = ${accessor.trim()}:(${element.slot})`);
  }

  if (plan.bindings.some((binding) => binding.source === 'key')) {
    return fail(
      `\`@巡 ${plan.collection}\` 含 {键} 绑定：eraTW backend 不猜键值集合的取法。`,
      plan.span,
    );
  }

  for (const line of body) inner.push(line.length === 0 ? '' : `${indent}${line}`);

  const lines: string[] = [`FOR ${indexName}, 0, ${renderLength(plan.length)}`, ...inner, 'NEXT'];
  return lines;
}
