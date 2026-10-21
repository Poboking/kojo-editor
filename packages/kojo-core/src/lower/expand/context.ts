/**
 * 编译期展开上下文（`# 表` / `# 池` / `# 模` 引用点展开共用）。
 *
 * 一次 `compileKojoFile` 调用一份：**不跨调用、不落盘、不缓存到模块级**——
 * 两个文件的同名表/池互不影响（文件作用域名字，§6.2 / §7.1）。
 */
import type {
  KojoConstDecl,
  KojoDecl,
  KojoFile,
  KojoFunctionDecl,
  KojoPoolDecl,
  KojoTemplateDecl,
  KojoTableDecl,
} from '../../ast.js';
import type { GameAdapter } from '../../adapter.js';
import type { CoreDiagnosticCode, DiagnosticSink, KojoDiagnostic } from '../../diagnostics.js';
import { severityOf } from '../../diagnostics.js';
import type { KojoEmitBackend, KojoHiddenSlot } from '../backend.js';
import type { EmitBuffer } from '../buffer.js';
import type { LowerState } from '../state.js';
import type { TableLoweringPlan } from '../../table.js';
import { collectIntegerConstants } from '../../table.js';

/** 展开器用的"体走法"回调（避免 expand 目录内部循环 import） */
export type WalkNarrative = (nodes: readonly import('../../ast.js').KojoNarrativeNode[], ctx: ExpandContext, state: LowerState) => void;
export type WalkDispatch = (nodes: readonly import('../../ast.js').KojoDispatchNode[], ctx: ExpandContext, state: LowerState) => void;

export interface ExpandContext {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  /** 源文本（预分配行数估算、宿主身份等；core 不解析第二遍） */
  readonly sourceText: string;
  readonly sink: DiagnosticSink;
  readonly view: string | null;
  /** 文件作用域声明索引（同名唯一，由 parser 保证） */
  readonly tables: Map<string, KojoTableDecl>;
  readonly pools: Map<string, KojoPoolDecl>;
  readonly templates: Map<string, KojoTemplateDecl>;
  readonly functions: Map<string, KojoFunctionDecl>;
  /** 已声明整数常量（表端点静态求值用） */
  readonly constants: Map<string, number>;
  /** 表校验结果缓存：同一张表只校验/只报一次（plan=null 表示有 error） */
  readonly tablePlans: Map<string, TableLoweringPlan | null>;
  /** 循环检测栈（表/池/模板各自一条；栈里出现同名 = 环） */
  readonly tableStack: string[];
  readonly poolStack: string[];
  readonly templateStack: string[];
  /** 结构非法（缺 `否` 等）的池只报一次，且不产字节 */
  readonly invalidPools: Set<string>;
  /** 隐藏槽清单（名字 → 来源；去重、按首次发射顺序） */
  readonly slots: Map<string, KojoHiddenSlot>;
  readonly slotOrder: string[];
  /**
   * 当前**槽作用域**（null = 主场景体）：`@织` 监听体是独立 ERB 函数、局部槽跨函数不可见，
   * 所以监听体降糖时切到自己的作用域，槽只进该 listener 的清单（`weaveHeader.slots`）。
   */
  activeSlotScope: SlotScope | null;
  /** 展开深度上限（防病态嵌套；超限按循环处理） */
  readonly maxDepth: number;
}

/** 一个槽作用域（主场景 / 单个 `@织` 监听） */
export interface SlotScope {
  readonly slots: Map<string, KojoHiddenSlot>;
  readonly order: string[];
}

export interface CreateExpandContextInput {
  readonly adapter: GameAdapter;
  readonly backend: KojoEmitBackend;
  readonly sourceText: string;
  readonly sink: DiagnosticSink;
  readonly view: string | null;
}

const MAX_EXPAND_DEPTH = 64;

export function createExpandContext(input: CreateExpandContextInput): ExpandContext {
  return {
    adapter: input.adapter,
    backend: input.backend,
    sourceText: input.sourceText,
    sink: input.sink,
    view: input.view,
    tables: new Map(),
    pools: new Map(),
    templates: new Map(),
    functions: new Map(),
    constants: new Map(),
    tablePlans: new Map(),
    tableStack: [],
    poolStack: [],
    templateStack: [],
    invalidPools: new Set(),
    slots: new Map(),
    slotOrder: [],
    activeSlotScope: null,
    maxDepth: MAX_EXPAND_DEPTH,
  };
}

/** 隐藏槽的附加事实（用途细分；类型是必填的） */
export interface SlotFacts {
  readonly role?: KojoHiddenSlot['role'];
}

/** 记一个隐藏槽（去重；顺序 = 首次发射顺序；写进当前槽作用域） */
export function recordSlot(
  ctx: ExpandContext,
  name: string,
  kind: KojoHiddenSlot['kind'],
  valueType: KojoHiddenSlot['valueType'],
  role?: KojoHiddenSlot['role'],
): void {
  const slot: KojoHiddenSlot = role === undefined ? { name, kind, valueType } : { name, kind, valueType, role };
  const scope = ctx.activeSlotScope;
  if (scope === null) {
    if (ctx.slots.has(name)) return;
    ctx.slots.set(name, slot);
    ctx.slotOrder.push(name);
    return;
  }
  if (scope.slots.has(name)) return;
  scope.slots.set(name, slot);
  scope.order.push(name);
}

function materializeScope(scope: SlotScope): readonly KojoHiddenSlot[] {
  const out = new Array<KojoHiddenSlot>(scope.order.length);
  for (let i = 0; i < scope.order.length; i++) out[i] = scope.slots.get(scope.order[i]!)!;
  return out;
}

/**
 * 在**独立槽作用域**里执行一段降糖（`@织` 监听体用），返回这段实际用到的槽清单。
 *
 * 顺序契约：先降 body 收集槽/产物行，再发 head（head 需要完整 slots）——所以监听体的
 * 编排在 `expand/weave.ts`，不是直接调单文件 lower 入口。
 */
export function captureSlots(ctx: ExpandContext, lower: () => void): readonly KojoHiddenSlot[] {
  const previous = ctx.activeSlotScope;
  const scope: SlotScope = { slots: new Map(), order: [] };
  ctx.activeSlotScope = scope;
  try {
    lower();
  } finally {
    ctx.activeSlotScope = previous;
  }
  return materializeScope(scope);
}

/** 主场景体的隐藏槽清单（稳定序；只读快照；不含 `@织` 监听体的槽） */
export function hiddenSlots(ctx: ExpandContext): readonly KojoHiddenSlot[] {
  const out = new Array<KojoHiddenSlot>(ctx.slotOrder.length);
  for (let i = 0; i < ctx.slotOrder.length; i++) out[i] = ctx.slots.get(ctx.slotOrder[i]!)!;
  return out;
}

/** 把 `file.decls` 索引进上下文（声明提升：引用点可以出现在声明之前） */
export function indexDeclarations(ctx: ExpandContext, decls: readonly KojoDecl[]): void {
  for (const decl of decls) {
    switch (decl.kind) {
      case 'table':
        ctx.tables.set(decl.name, decl);
        break;
      case 'pool':
        ctx.pools.set(decl.name, decl);
        break;
      case 'template':
        ctx.templates.set(decl.name, decl);
        break;
      case 'function':
        ctx.functions.set(decl.name, decl);
        break;
      default:
        break;
    }
  }
  const consts = decls.filter((decl): decl is KojoConstDecl => decl.kind === 'const');
  for (const [name, value] of collectIntegerConstants(consts)) ctx.constants.set(name, value);
}

/** 报一条 core 诊断（级别仍由 diagnostics.ts 码表唯一定义） */
export function reportAt(
  ctx: ExpandContext,
  code: CoreDiagnosticCode,
  message: string,
  span: import('../../ast.js').KojoSpan | null,
): void {
  ctx.sink.report({ code, severity: severityOf(code), message, span });
}

/** 报一条已有 adapter 诊断（`event/*` 等；不重写码/级别） */
export function reportDiagnostic(ctx: ExpandContext, diagnostic: KojoDiagnostic): void {
  ctx.sink.report(diagnostic);
}

/** 估算预分配行数：源文本行数 × 2（展开会放大，但只是预分配提示，不参与语义） */
export function estimateLines(sourceText: string, override?: number): number {
  if (override !== undefined && override > 0) return override;
  let lines = 1;
  for (let i = 0; i < sourceText.length; i++) if (sourceText.charCodeAt(i) === 10) lines++;
  return Math.min(262_144, Math.max(16, lines * 2));
}

export type { EmitBuffer, LowerState, KojoFile };
