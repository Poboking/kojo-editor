/**
 * 叙事文本三正交 lowering（§4.7 / §16.2 C2.1–C2.3）。
 *
 * 三条轴**互相正交**，core 只解析事实，不选打印变体：
 * - speech：`角色：「…」` / `> …` / 池内裸引号 → `TextEmitRequest.speech`；
 * - color：行内不写颜色；只来自 profile（profile 轴）或外层 `@着色` 块（block 轴）；
 * - wait：行尾 `续` = continue；无 `续` = profile.waitDefault。**没有 waitDefault 就报错**，
 *   不替作者选（§4.7 最后一条）。
 *
 * 空行也是同一套等待三态：`空行`（按 waitDefault）/ `空行 等待` / `空行 续`（§4.7 表）。
 */
import type { KojoBlankLine, KojoTextLine, KojoWaitMode } from '../ast.js';
import type { ResolvedWait, TextColor } from './backend.js';
import type { HintSupport } from './backend.js';
import type { LowerState } from './state.js';
import { emit, report } from './state.js';

/**
 * 等待轴解析：行尾 `续`/`空行 等待` 已由 parser 记成三态；`default` 才看 profile。
 * 缺 `waitDefault` → `core/wait/no-profile` error 且**不产该行**（fail-closed）。
 */
export function resolveWait(mode: KojoWaitMode, state: LowerState, span: KojoTextLine['span']): ResolvedWait | null {
  if (mode === 'wait') return 'wait';
  if (mode === 'continue') return 'continue';
  const fallback = state.backend.profile.waitDefault;
  if (fallback === undefined) {
    report(
      state,
      'core/wait/no-profile',
      '这行没有行尾「续」，但当前 profile 没有 waitDefault：不能替作者选“等”还是“不等”。请在 project/file profile 里声明 waitDefault。',
      span,
    );
    return null;
  }
  return fallback;
}

/** 颜色轴：行内不写颜色；块内用块颜色，否则交给 profile（dialogueColor / narrationColor） */
export function textColor(state: LowerState): TextColor {
  if (state.color !== null && !state.colorClosed) return { kind: 'block', color: state.color };
  return { kind: 'profile' };
}

/** 行尾提示判定（`心形` 是 adapter 知识；core 只按三态决定是否阻断） */
export function resolveHint(
  hint: string | null,
  state: LowerState,
  span: KojoTextLine['span'],
): { readonly role: Exclude<HintSupport, 'unsupported'> | null; readonly hint: string | null } {
  if (hint === null) return { role: null, hint: null };
  const support = state.backend.hintSupport(hint);
  if (support === 'unsupported') {
    report(
      state,
      'core/feature/unsupported',
      `当前 adapter 没有声明行尾提示「${hint}」对应的演出：不能生成无效产物。请换 adapter、或在 profile 里声明该 presentation。`,
      span,
    );
    return { role: 'annotation', hint };
  }
  return { role: support, hint };
}

/** 一行叙事文本（台词/旁白/池内裸引号） */
export function lowerTextLine(node: KojoTextLine, state: LowerState): void {
  const wait = resolveWait(node.wait, state, node.span);
  if (wait === null) return;

  let speaker: string | null = null;
  let defaultSpeaker: string | null = null;
  switch (node.speech.kind) {
    case 'dialogue':
      speaker = node.speech.speaker;
      break;
    case 'narration':
      break;
    case 'bareQuote':
      // 池内裸引号：省略的说话人 = 当前 `# 视` 目标（§7.1）
      if (state.view === null) {
        report(
          state,
          'core/pool/no-view',
          '池内裸引号省略了说话人，但本文件没有 `# 视`：默认说话人（池内 `{我}`）无处解析。请补 `# 视 <目标>` 或写完整 `角色：「…」`。',
          node.span,
        );
        return;
      }
      defaultSpeaker = state.view;
      break;
  }

  const hint = node.hint ?? null;
  const resolvedHint = resolveHint(hint, state, node.span);
  const result = state.backend.text.line({
    speech: node.speech,
    speaker,
    defaultSpeaker,
    parts: node.parts,
    wait,
    color: textColor(state),
    hint: resolvedHint.hint,
    hintRole: resolvedHint.role,
    span: node.span,
  });
  emit(state, result, node.span);
}

/** `空行` / `空行 等待` / `空行 续`（§4.7 三态，2.0 保留不迁移） */
export function lowerBlankLine(node: KojoBlankLine, state: LowerState): void {
  const wait = resolveWait(node.wait, state, node.span);
  if (wait === null) return;
  emit(state, state.backend.blank.line({ wait, span: node.span }), node.span);
}
