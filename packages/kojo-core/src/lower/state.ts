/**
 * 降糖的共享状态与发射助手（**唯一的可变点**都在这里，模块间不互相 import 副作用）。
 *
 * 为什么是可变状态：50k 行文本 lowering 的热路径不能每节点 `{...state, color}` 复制对象；
 * 这里的状态是**一次 lowering 调用的局部变量**，不逃逸、不跨调用——纯函数语义不变。
 */
import type { KojoDispatchNode, KojoExprText, KojoNarrativeNode, KojoSpan } from '../ast.js';
import type { CoreDiagnosticCode, DiagnosticSink } from '../diagnostics.js';
import { severityOf } from '../diagnostics.js';
import type { KojoEmitBackend, EmitResult } from './backend.js';
import { createEmitBuffer, type EmitBuffer } from './buffer.js';
import type { FeatureCheck, ResolvedProgramFeatures } from './feature-gate.js';
import { featureDiagnosticKey, resolveProgramFeatures } from './feature-gate.js';

/** 叙事区 / 调度区（决定裸行怎么解释；降糖只关心"这段体是哪张脸"） */
export type LowerRegion = 'narrative' | 'dispatch';

/** 叙事节点体降糖回调（从上层注入，避免模块间循环 import） */
export type LowerNarrativeBody = (nodes: readonly KojoNarrativeNode[]) => void;

/** 调度节点体降糖回调 */
export type LowerDispatchBody = (nodes: readonly KojoDispatchNode[]) => void;

export interface LowerState {
  readonly backend: KojoEmitBackend;
  /** 统一能力闸（K2-FEATURE-GATE-UNIFY）：adapter 声明 × backend 落点已解析一次，主链只读它 */
  readonly featureGate: ResolvedProgramFeatures;
  /** 已报过的 feature 诊断键（`code@span`）：同一情形只报一条（见 `reportFeature`） */
  readonly reportedFeatures: Set<string>;
  readonly buffer: EmitBuffer;
  readonly sink: DiagnosticSink;
  /** 当前 `# 视` 目标（池内裸引号的默认说话人）；缺省 null */
  readonly view: string | null;
  region: LowerRegion;
  /** 当前生效的 `@着色` 颜色（null = 不在颜色块内；`@着色` 不许嵌套所以只有一层） */
  color: KojoExprText | null;
  /** 颜色块已被控制转移提前收口（避免重复 RESETCOLOR） */
  colorClosed: boolean;
  /** 循环体深度（`@断`/`@续` 合法性） */
  loopDepth: number;
  /** `@函` 深度（`@返` 合法性；@织 内 return 非法由 parser 保证） */
  functionDepth: number;
  /** `@织` 监听体深度 */
  weaveDepth: number;
}

export interface CreateLowerStateInput {
  readonly backend: KojoEmitBackend;
  readonly buffer: EmitBuffer;
  readonly sink: DiagnosticSink;
  readonly view?: string | null;
  /**
   * 已解析好的能力闸（2.0 主链从 `ExpandContext.featureGate` 传下来，一次 compile 只解析一次）。
   * 缺省 = 通用 lower 路径（没有 adapter 可比）：按 backend 的落点记录判（旧行为不变）。
   */
  readonly featureGate?: ResolvedProgramFeatures;
}

export function createLowerState(input: CreateLowerStateInput): LowerState {
  return {
    backend: input.backend,
    featureGate: input.featureGate ?? resolveProgramFeatures(null, input.backend),
    reportedFeatures: new Set<string>(),
    buffer: input.buffer,
    sink: input.sink,
    view: input.view ?? null,
    region: 'narrative',
    color: null,
    colorClosed: false,
    loopDepth: 0,
    functionDepth: 0,
    weaveDepth: 0,
  };
}

/** 报一条 core 诊断（级别由码表唯一定义，见 diagnostics.ts） */
export function report(state: LowerState, code: CoreDiagnosticCode, message: string, span: KojoSpan | null): void {
  state.sink.report({ code, severity: severityOf(code), message, span });
}

/**
 * 报一条能力闸诊断（**唯一出口**）：同一 `(code, span)` 只报一条。
 *
 * 口径：同一码 + 同一 span = **同一情形**（重复走同一节点、或同一段源行被展开两次）。
 * 报两条只是噪音，也不利于"产物面与诊断面一致"的可断言性（K2-FEATURE-GATE-UNIFY）。
 */
export function reportFeature(state: LowerState, check: FeatureCheck): void {
  const diagnostic = check.diagnostic;
  if (diagnostic === null) return;
  const key = featureDiagnosticKey(diagnostic);
  if (state.reportedFeatures.has(key)) return;
  state.reportedFeatures.add(key);
  state.sink.report(diagnostic);
}

/** 把 backend 的一次发射写进缓冲区（失败诊断原样收下） */
export function emit(state: LowerState, result: EmitResult, span: KojoSpan | null): void {
  state.buffer.pushEmitted(result, { source: span }, state.sink);
}

/** 保存/恢复"颜色块"上下文的轻量栈（`@着色` 不许嵌套，所以只有一层，但骨架仍写通用） */
export interface ColorFrame {
  readonly color: KojoExprText | null;
  readonly colorClosed: boolean;
}

export function captureColor(state: LowerState): ColorFrame {
  return { color: state.color, colorClosed: state.colorClosed };
}

export function restoreColor(state: LowerState, frame: ColorFrame): void {
  state.color = frame.color;
  state.colorClosed = frame.colorClosed;
}

/**
 * 在**子缓冲**里降糖一段体，返回它已生成的行（`@随机` 候选 / `选项` 按钮正文用）。
 *
 * 为什么需要子缓冲：这些体要被 adapter 插进它自己组装的块里（PRINTDATA 条目 / 按钮正文），
 * 顺序由 adapter 定；如果直接写父缓冲，adapter 返回的头行就只能排在体后面（产物顺序错）。
 * 子缓冲的行数组零拷贝交回（字符串共享），source map 归到块头（§10.7 随机隐藏槽 → 块头）。
 */
export function lowerIntoChildLines(state: LowerState, lower: (child: LowerState) => void): readonly string[] {
  const buffer = createEmitBuffer(8);
  const child: LowerState = { ...state, buffer };
  lower(child);
  return buffer.finish().lines;
}
