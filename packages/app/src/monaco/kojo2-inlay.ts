/**
 * Kojo 2.0 **行内提示**的宿主面 —— B2c（2026-10-24）起只剩两件事：
 *
 * 1. **判据**：已搬 `@kojo/kojo-lang` 的 `inlay.ts`（`kojo2InlayHints` + 全部类型），
 *    此处 re-export，既有 import 点一字不改；
 * 2. **翻译 + 安装**：`toMonacoInlayHints` 把纯提示翻成 `monaco.languages.InlayHint`。
 *
 * ## 为什么判据必须搬走
 *
 * 这条腿的**供方**是插件 `@kojo/plugin-kojo-lang`（槽 `ui.editor.languageService` 的
 * `inlayHint` 成员）。插件在 `packages/plugins/**`，看不见 `packages/app/src/**`；
 * 判据留在宿主 = 插件只能靠复制一份来应答 = 两份判据迟早漂移。
 *
 * ## 为什么翻译层留下
 *
 * `InlayHintKind` / `position.lineNumber` 是 Monaco 的形状，不是语言事实。把它们塞进包里
 * 会立刻违反包的三条硬约束（零 Monaco / 零 IO / 零游戏名词）。
 *
 * ## 本文件现在只剩什么
 *
 * `toMonacoInlayHints`（纯翻译）+ `installKojo2InlayHintsProvider`（**即将删除**）。
 * 安装器今天仍在跑，但 B2c 之后 kojo2 的 inlay 已经改由共享收口挂上
 * （descriptor 的 `slotServices: ['inlayHint']`，供方是插件），所以它**不再被装配层调用**；
 * 保留到 B5 与其余 `kojo2-*.ts` 一起删。唯一还活着的是 `toMonacoInlayHints` 的
 * 单元测试（`tests/kojo2-inlay.test.ts`）——那是"翻译正确性"的判据，与谁挂 provider 无关。
 */
import type * as Monaco from './entry';
import type { GameAdapter } from '@kojo/kojo-core';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { isKojo2CutoverEnabled } from '../ui/kojo2-flag';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import { kojo2InlayHints } from '@kojo/kojo-lang/inlay';
import type { Kojo2InlayHint } from '@kojo/kojo-lang/inlay';

// 判据与形状全部原样 re-export：既有 import 点（含 `tests/kojo2-inlay.test.ts`）一行不动。
export { KOJO2_INLAY_HINT_LIMIT, kojo2InlayHints } from '@kojo/kojo-lang/inlay';
export type {
  Kojo2InlayHint,
  Kojo2InlayHintKind,
  Kojo2InlayOptions,
  Kojo2InlayPosition,
  Kojo2InlayRange,
} from '@kojo/kojo-lang/inlay';
/* ============================== Monaco 翻译层 ============================== */

/**
 * 纯提示 → `monaco.languages.InlayHint[]`。
 *
 * 种类映射：`type` → `InlayHintKind.Type`；`binding` → `InlayHintKind.Parameter`（绑定名与
 * 形参名同一种"这个名字代表什么值"的语义）；`value` 是表档摘要，Monaco 没有对应枚举，
 * **不硬借邻居那种颜色**——留空即默认样式。
 */
export function toMonacoInlayHints(
  monaco: typeof Monaco,
  hints: readonly Kojo2InlayHint[],
): Monaco.languages.InlayHint[] {
  const K = monaco.languages.InlayHintKind;
  return hints.map((hint) => {
    const kind =
      hint.kind === 'type' ? K.Type : hint.kind === 'binding' ? K.Parameter : undefined;
    return {
      position: { lineNumber: hint.position.lineNumber, column: hint.position.column },
      label: hint.label,
      ...(kind === undefined ? {} : { kind }),
      ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
      ...(hint.paddingRight === true ? { paddingRight: true } : {}),
    };
  });
}

/* ============================== 安装 ============================== */

/** flag 关时交回的句柄（调用方照常 `dispose()`，什么也不会发生） */
const NOOP_DISPOSABLE: Monaco.IDisposable = { dispose: () => undefined };

/** 空结果（每次新建：Monaco 会消费/持有这个数组，不共享一份可变的空表） */
function emptyInlayResult(): { hints: Monaco.languages.InlayHint[]; dispose: () => void } {
  return { hints: [], dispose: () => undefined };
}

/**
 * adapter 注入面：直接给一枚（测试 / 单项目），或给 getter 让宿主**请求时现取**
 * （项目可开可关；缓存会把上一个项目的集合声明带过来）。
 */
export type Kojo2InlayAdapterSource =
  | GameAdapter
  | null
  | undefined
  | (() => GameAdapter | null | undefined);

export interface Kojo2InlayProviderOptions {
  /** 当前项目 2.0 adapter（`@巡` 命名集合的绑定名来源；缺省 = 只认本文件数组声明） */
  readonly adapter?: Kojo2InlayAdapterSource;
}

/** adapter 现取；getter 抛错 = 这一轮没有 adapter（不抛进 Monaco） */
function adapterAt(source: Kojo2InlayAdapterSource): GameAdapter | undefined {
  if (source === null || source === undefined) return undefined;
  if (typeof source === 'function') {
    try {
      return source() ?? undefined;
    } catch {
      return undefined;
    }
  }
  return source;
}

/** 这份 model 是否超过行内提示的体量档（与 v1 `inlayHintsAffordable` 同一条线） */
function overBudget(model: Monaco.editor.ITextModel): boolean {
  try {
    if (typeof model.getLineCount !== 'function') return false;
    const lineCount = model.getLineCount();
    return Number.isFinite(lineCount) && lineCount >= LARGE_FILE_LINES;
  } catch {
    return false;
  }
}

/**
 * 为 `kojo2` 语言注册 inlay hints provider，返回**幂等**的 disposable。
 *
 * - flag 关 ⇒ 空操作（**零注册**；调用点在宿主 2.0 段，本函数再挡一道）；
 * - 只挂 {@link KOJO2_LANGUAGE_ID}：v1 的 ERB / `.kojo` 面由 `kojo-inlay-hints.ts` 的
 *   `registerForLanguageServices` 各挂各的，两边不重叠；
 * - 体量档判在请求之前（`LARGE_FILE_LINES` 同一条线）：超长文件里行内提示整体让路，
 *   与 stickyScroll / 面包屑 / codeLens 的规则一致；
 * - provider 内任何异常 ⇒ `{ hints: [] }`（不把编辑器的输入链带崩）；
 * - 注册失败原样外抛（只有一枚注册，没有半成品要回滚，宿主那侧的全有或全无才有机会收口）。
 */
export function installKojo2InlayHintsProvider(
  monaco: typeof Monaco,
  options: Kojo2InlayProviderOptions = {},
): Monaco.IDisposable {
  if (!isKojo2CutoverEnabled()) return NOOP_DISPOSABLE;

  const adapterSource = options.adapter;

  const provider: Monaco.languages.InlayHintsProvider = {
    provideInlayHints(model, range) {
      try {
        if (typeof model.isDisposed === 'function' && model.isDisposed()) return emptyInlayResult();
        if (overBudget(model)) return emptyInlayResult();
        const source = model.getValue();
        if (typeof source !== 'string') return emptyInlayResult();
        const adapter = adapterAt(adapterSource);
        const hints = kojo2InlayHints(source, range, { adapter: adapter ?? null });
        return { hints: toMonacoInlayHints(monaco, hints), dispose: () => undefined };
      } catch {
        return emptyInlayResult();
      }
    },
  };

  const registration = monaco.languages.registerInlayHintsProvider(KOJO2_LANGUAGE_ID, provider);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        registration.dispose();
      } catch {
        /* 幂等 + 不抛：一枚撤不掉不许把卸载链带崩（错误也没有第二个消费者） */
      }
    },
  };
}
