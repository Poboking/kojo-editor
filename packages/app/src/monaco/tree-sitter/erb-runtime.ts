import type * as Monaco from '../entry';
import { ERB_STRUCTURE_ASSETS } from './erb-assets';
import { erbBaseIndentPatterns } from './erb-indent';
import { ERB_SEMANTIC_FACET } from './erb-semantic';
import { erbStructureDiagnostics, ERB_DIAGNOSTIC_SOURCE } from './erb-diagnostics';
import { erbCaptureTier } from './erb-tiers';
import type { KojoStructureSyntaxFault } from './types';
import type { StructureLanguageRuntime } from './structure-runtime';

/**
 * ERB 的结构层运行时（ERB-TS-FULL）：独立 worker、独立 wasm，供四面——
 * **折叠 + 语义着色 + 缩进 + 结构诊断**。
 *
 * - 折叠 / 结构诊断：worker 协议对所有语言一致（`folds.scm` 的 `@fold`、CST 的 ERROR/MISSING），
 *   这里不需要额外声明；
 * - 语义着色：`semantic` 面 = `erb-semantic.ts`（ERB 自己的档位表与编码器；查询是
 *   `highlights.scm`）。`providers.ts` 看到这面就会给 ERB 注册
 *   `DocumentSemanticTokensProvider`，没数据时那枚 provider 回 `null`，让名字分色应答；
 * - 缩进：`baseIndentPatterns` 接 `erb-enter.ts` 的既有层级（基底三格 + `SIF` / 注释两格），
 *   worker 的 `indents.scm` 再把结构规则合并上去——**加法，不替换**既有回车手感；
 * - 结构残缺上屏：`presentSyntax` / `clearSyntax`（LAU-3）。ERB 的文案、码名与
 *   `[SKIPSTART]` 配对判据都在 `erb-diagnostics.ts`，与 `.kojo` 那套通用上屏器不混用；
 *   宿主因此不再需要按语言 id 分支（`providers.ts` 里那两处 `if (ERB)` 已随本面删除）。
 *
 * 默认关：整条叠层由 `ui/tree-sitter-pref.ts`（`kojo.ui.treeSitter.v1`，缺省关）控制；
 * 关着时本模块（连同 `?worker`、`?url`、`?raw`）不进主线程静态图，一个 provider 都不注册。
 */

/**
 * ERB 结构诊断的 marker owner（与 `.kojo` 的 `kojo-structure-syntax` 分开：两门语言各自的
 * model 不会被彼此覆盖，但分开后排查时一眼能看出是哪一层报的）。
 */
const ERB_STRUCTURE_SYNTAX_OWNER = 'erb-structure-syntax';

/**
 * ERB 的结构残缺 → 行级波浪线（`erb-diagnostics.ts` 只产 plain 事实，上屏的 owner 在这里定）。
 *
 * 为什么不复用 `syntax-decorations.show()`：那个上屏器按 `.kojo` 语言 id 过滤（它的文案是按
 * Kojo 结构写的），ERB 的文案 / 码名 / `[SKIPSTART]` 配对判据都在 `erb-diagnostics.ts` 里。
 */
function applyErbStructureMarkers(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  faults: readonly KojoStructureSyntaxFault[],
): void {
  try {
    const diagnostics = erbStructureDiagnostics(faults, model.getValue());
    monaco.editor.setModelMarkers(
      model,
      ERB_STRUCTURE_SYNTAX_OWNER,
      diagnostics.map((diagnostic) => ({
        startLineNumber: diagnostic.line,
        startColumn: diagnostic.startColumn,
        endLineNumber: diagnostic.endLine,
        endColumn: diagnostic.endColumn,
        message: diagnostic.message,
        severity: monaco.MarkerSeverity.Error,
        code: diagnostic.code,
        source: ERB_DIAGNOSTIC_SOURCE,
      })),
    );
  } catch {
    // 上屏失败只让这一轮没有波浪线，绝不影响结构层其余能力（折叠 / 缩进 / 着色）
  }
}

export const ERB_STRUCTURE_RUNTIME: StructureLanguageRuntime = {
  runtimeWasmUrl: ERB_STRUCTURE_ASSETS.runtimeWasmUrl,
  grammarWasmUrl: ERB_STRUCTURE_ASSETS.erbWasmUrl,
  semantic: ERB_SEMANTIC_FACET,
  // LAU-1（D4）：v3 起 worker 只回捕获的扁平投影，捕获 → 档位这一步回到宿主。
  // 这张表本来就在两侧共用（`erb-tiers.ts` 头注），现在 worker 侧不再需要它。
  captureTier: erbCaptureTier,
  baseIndentPatterns: erbBaseIndentPatterns,
  presentSyntax: ({ monaco, model, faults }) => applyErbStructureMarkers(monaco, model, faults),
  clearSyntax: ({ monaco, model }) => {
    try {
      monaco.editor.setModelMarkers(model, ERB_STRUCTURE_SYNTAX_OWNER, []);
    } catch {
      /* 撤不掉 markers 不影响换轨（下一条 model 重挂） */
    }
  },
};
