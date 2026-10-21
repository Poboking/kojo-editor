/**
 * 演出落点的 core 侧骨架：`@着色` / `@颜绘` / `@随机`（§8.2–8.4 / §16.2 C2.9/C2.14）。
 *
 * core 只做三件事：**能力闸**（adapter 未声明即 error，不生成无效产物）、**结构校验**
 * （嵌套/参数个数/候选纯度事实）、**编排**（进入/体/退出、颜色自动配对与转移清理）。
 * 具体产物行（`SETCOLOR`、`PRINT_FACE`、`PRINTDATA` / `RAND+SELECTCASE`）由 adapter 发射器给。
 */
import type {
  KojoColorBlock,
  KojoFaceLine,
  KojoNarrativeNode,
  KojoOptionItem,
  KojoOptionsBlock,
  KojoRandomBlock,
  KojoRandomCandidate,
  KojoTextLine,
} from '../ast.js';
import type { RandomCandidatePurity } from './backend.js';
import type { LowerNarrativeBody, LowerState } from './state.js';
import { captureColor, emit, lowerIntoChildLines, report, restoreColor } from './state.js';

/** `@着色 <颜色>` 块：自动配对 SETCOLOR/RESETCOLOR，不许嵌套（§8.2） */
export function lowerColorBlock(node: KojoColorBlock, state: LowerState, lowerBody: LowerNarrativeBody): void {
  // 嵌套：任何词法嵌套都是 error（不管隔了几层 `?`）
  if (state.color !== null) {
    report(
      state,
      'core/color/nested',
      '`@着色` 不能嵌套：外层已有颜色块。要在不同条件用不同颜色，写平级 `@着色` 块、外面套 `?`。',
      node.span,
    );
    lowerBody(node.body);
    return;
  }
  // adapter 未声明着色：error，不产 SETCOLOR/RESETCOLOR（不生成无效 ERB）
  if (!state.backend.profile.presentations.color) {
    report(
      state,
      'core/color/unsupported',
      '当前 adapter 没有声明 `着色` 演出（presentation.color）：不能生成 SETCOLOR/RESETCOLOR。请换 adapter 或改用 `@原生`。',
      node.span,
    );
    return;
  }

  const frame = captureColor(state);
  emit(state, state.backend.presentation.colorEnter(node.color), node.span);
  state.color = node.color;
  state.colorClosed = false;
  lowerBody(node.body);
  // 控制转移已提前收口时不再重复 RESETCOLOR（§9.7）
  if (!state.colorClosed) emit(state, state.backend.presentation.colorExit(), node.span);
  restoreColor(state, frame);

  if (!narrativeHasOutput(node.body)) {
    report(
      state,
      'core/color/no-output',
      '`@着色` 块内没有任何可打印内容（只有计算）：SETCOLOR/RESETCOLOR 会白配一对。计算请移到着色块外。',
      node.span,
    );
  }
}

/** `@颜绘` 单行：`[对象] 表情 [服装] [差分] [特效]`（§8.3） */
export function lowerFaceLine(node: KojoFaceLine, state: LowerState): void {
  if (!state.backend.profile.presentations.face) {
    report(
      state,
      'core/face/unsupported',
      '当前 adapter 没有声明 `颜绘` 演出（presentation.face）：不能生成 PRINT_FACE/PRINT_FACE_PLAYER。请换 adapter、改用基础库函数或 `@原生`。',
      node.span,
    );
    return;
  }
  if (node.args.length > 4) {
    report(state, 'core/face/args', `\`@颜绘\` 最多 4 个参数（表情/服装/差分/特效），这行给了 ${node.args.length} 个。`, node.span);
    return;
  }
  emit(
    state,
    state.backend.presentation.face({ object: node.object, args: node.args, span: node.span }),
    node.span,
  );
}

/** `@随机`：候选择一；落点由 adapter 的 randStyle + 候选纯度决定（§8.4） */
export function lowerRandomBlock(
  node: KojoRandomBlock,
  state: LowerState,
  lowerCandidate: (child: LowerState, candidate: KojoRandomCandidate) => void,
): void {
  if (!state.backend.profile.presentations.random) {
    report(
      state,
      'core/random/unsupported',
      '当前 adapter 没有声明随机演出（presentation.random）：不能生成 PRINTDATA/DATALIST/RAND 落点。请换 adapter 或用 `@原生`。',
      node.span,
    );
    return;
  }
  if (node.candidates.length < 2) {
    report(
      state,
      'core/random/one-candidate',
      '`@随机` 只有一个候选：随机没有分叉。至少给两个候选（单行文本或 `@组`）。',
      node.span,
    );
    return;
  }
  const slot = `__kojo_rand_${node.span.start.line}`;
  emit(
    state,
    state.backend.presentation.randomBlock(
      {
        purity: randomCandidatePurity(node.candidates, state),
        candidates: node.candidates,
        slot,
        span: node.span,
      },
      (candidate) => lowerIntoChildLines(state, (child) => lowerCandidate(child, candidate)),
    ),
    node.span,
  );
}

/**
 * 候选纯度事实（§8.4）：纯文本单行 → PRINTDATA；多行纯文本 @组 → DATALIST；
 * 其余一律 RAND+SELECTCASE。**core 只给事实，选落点是 adapter 的事**。
 */
export function randomCandidatePurity(candidates: readonly KojoRandomCandidate[], state: LowerState): RandomCandidatePurity {
  let allSingleLine = true;
  for (const candidate of candidates) {
    if (candidate.kind === 'randomGroup') {
      allSingleLine = false;
      for (const inner of candidate.body) {
        if (!isPureTextNode(inner, state)) return 'control-or-side-effect';
      }
      continue;
    }
    const line = candidate.line;
    if (line.kind === 'blankLine') return 'control-or-side-effect';
    if (!isPureTextLine(line, state)) return 'control-or-side-effect';
  }
  return allSingleLine ? 'single-line-text' : 'group-text';
}

/** 纯文本：无 `{…}` 插值、不切换打印函数（`(心形)` 一类） */
function isPureTextLine(line: KojoTextLine, state: LowerState): boolean {
  for (const part of line.parts) if (part.kind === 'interp') return false;
  if (line.hint !== undefined && state.backend.hintSupport(line.hint) === 'supported') return false;
  return true;
}

function isPureTextNode(node: KojoNarrativeNode, state: LowerState): boolean {
  return node.kind === 'textLine' && isPureTextLine(node, state);
}

/**
 * `选项`（§7.5，2.0 待定 UI）的**通用 lower 路径**（无 adapter 上下文，块级预览/旧消费方用）：
 * 永远先给 `core/options/pending` warning；backend profile 未开 → error 且不产字节。
 *
 * 2.0 编译主链不走这里：`expand/walk.ts` 调 `lowerOptionsBlockExpanded`
 * （adapter UI 能力闸 + ETB 计划）。本路径不带 `plan`，新 adapter 应按 fail-closed 处理
 * （不知道按钮顺序/回传值就不猜）。
 */
export function lowerOptionsBlock(
  node: KojoOptionsBlock,
  state: LowerState,
  lowerItemBody: (child: LowerState, item: KojoOptionItem) => void,
): void {
  report(
    state,
    'core/options/pending',
    '`选项` 是 2.0 待定 UI：形态与 API 未来可能变化（不是旧语法例外）。迁移期请知悉；需要稳定交互时用 `@原生`。',
    node.span,
  );
  if (!state.backend.profile.presentations.options) {
    report(
      state,
      'core/feature/unsupported',
      `当前 adapter（${state.backend.id}）没有声明「选项」UI（presentation.options）：不能生成按钮落点。`,
      node.span,
    );
    return;
  }
  emit(
    state,
    state.backend.presentation.optionsBlock({ items: node.items, span: node.span }, (item) =>
      lowerIntoChildLines(state, (child) => lowerItemBody(child, item)),
    ),
    node.span,
  );
}

/**
 * `@着色` 块的 "no output" 判据：块内有没有任何会写屏/改演出状态的节点。
 * 只看结构性事实，不求值表达式。
 */
export function narrativeHasOutput(nodes: readonly KojoNarrativeNode[]): boolean {
  for (const node of nodes) {
    switch (node.kind) {
      case 'textLine':
      case 'blankLine':
      case 'faceLine':
      case 'nativeBlock':
      case 'optionsBlock':
        return true;
      case 'randomBlock':
        if (node.candidates.length > 0) return true;
        break;
      case 'conditionChain':
        for (const branch of node.branches) if (narrativeHasOutput(branch.body)) return true;
        break;
      case 'colorBlock':
        if (narrativeHasOutput(node.body)) return true;
        break;
      case 'sandboxBlock':
        for (const inner of node.body) if (inner.kind === 'nativeBlock') return true;
        break;
    }
  }
  return false;
}
