import type * as Monaco from './entry';
import type {
  EditorInlayHint,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

/**
 * 行内提示的**宿主接线**（LS-R6，2026-10-16 语言服务批）：`ui.editor.languageService`
 * 判别式联合第七员 `inlayHint` 的 Monaco 翻译层。分层照 `kojo-code-lens` 同款旧例：
 * **纯逻辑**（合并 / 抛错隔离 / 去重 / 越界丢弃 / 夹取）与 **Monaco 协议翻译**
 * （`installInlayHintsProvider`）分开，前者可脱离 React 与编辑器单测。
 *
 * ## 代价模型（为什么有体量档；取证 monaco-editor 0.57）
 *
 * `inlayHintsController.js` ⇒ `provideInlayHints(model, range, token)` 收到的是
 * **可视区 ±30 行**，但触发点比 codeLens 更密：内容变化（≥800ms 尾缘合并）+
 * **每次滚动**都会 `scheduler.schedule()`，防抖间隔按上次实测耗时自适应
 * （`_featureDebounce.for(…, { min: 25 })`）。所以单价必须按"全篇扫描"算——
 * 供方（`erb-inlay-hints`）对给进来的缓冲区做单遍线性扫描 + 每调用点一次 Map 命中。
 *
 * 真实语料实测（一次性探针，`KojoCallProtocol` 全命中偏重口径）：
 * 52,602 行那篇语料之最，一次整篇扫描 **50ms**（惰性代码视野改造前 114ms）；
 * 扫描单价 ~1μs/行，与行内容长度弱相关。⇒ 体量档**判在请求之前**，与本仓既有降级
 * （`stickyScroll` / 面包屑 / codeLens 的 `LARGE_FILE_LINES`）**同一条线**：档内
 * （≤5,000 行）单次 ≤5ms，档外整篇不办——"超长文件里省着来的功能"是作者看到的一条
 * 一致的规则，不是每面各划一档。与 codeLens 不同的是**没有密度/条数档**：行内提示
 * 不插行（行高不变，只把本行余部往右推），"插满行 = 花屏"的前提在这里不成立；
 * Monaco 自己有 `inlayHints.maximumLength`（缺省 43 字符/行）兜单行截断。
 */

/**
 * 这次值不值得去问供方（**宿主档降级**，判据与真由见本模块头注的代价模型）。
 * 判在请求之前：省掉一次整篇扫描与全文字符串遍历。
 */
export function inlayHintsAffordable(lineCount: number): boolean {
  return lineCount < LARGE_FILE_LINES;
}

/**
 * 合并全部贡献方的提示。
 *
 * 隔离与去重口径同 `collectCodeLenses`：**单枚贡献抛错不影响其余**（能力出错退化可见）；
 * 去重键 = 行 + 列 + 文本——两枚供方在同一格说同一句话不该画两个一模一样的嵌片；
 * 同格不同文本保留（两句话，不是一句话说两遍）。
 */
export function collectInlayHints(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): EditorInlayHint[] {
  const out: EditorInlayHint[] = [];
  const seen = new Set<string>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-inlay-hints] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (!result || result.kind !== 'inlayHint') continue;
    for (const hint of result.hints) {
      const key = `${hint.line}\u0000${hint.column}\u0000${hint.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hint);
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * 贡献方的提示 → Monaco 的 inlay hint（**越界行丢弃、列夹取**）。
 *
 * 行越界**丢弃**不夹取——与 codeLens 同一条理由：把第 5,000 行的话贴到第 4,999 行
 * = 错标比不标危险。列是另一回事：提示钉在"某个实参首字符**之前**"，行是作者正在写
 * 的那一行（行没变只是行尾长了）⇒ 列夹到行尾即可，丢掉反而把"还在说的话"吞了。
 * 种类恒 Parameter（`InlayHintKind` 是运行时枚举，monaco 实例由安装方递进来）。
 */
export function toMonacoInlayHints(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  hints: readonly EditorInlayHint[],
): Monaco.languages.InlayHint[] {
  const lineCount = model.getLineCount();
  const out: Monaco.languages.InlayHint[] = [];
  for (const hint of hints) {
    if (!Number.isFinite(hint.line) || !Number.isFinite(hint.column)) continue;
    const line = Math.trunc(hint.line);
    if (line < 1 || line > lineCount) continue;
    const column = Math.min(Math.max(1, Math.trunc(hint.column)), model.getLineMaxColumn(line));
    out.push({
      position: { lineNumber: line, column },
      label: hint.label,
      kind: monaco.languages.InlayHintKind.Parameter,
      ...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
      ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
    });
  }
  return out;
}

/** 宿主注入：这篇文档该答什么提示（全部判据——开关 / 糖视图 / 活动标签 / 体量——都在宿主接线） */
export interface InlayHintHandlers {
  resolve(model: Monaco.editor.ITextModel): EditorInlayHint[];
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 inlay hints 供给器。
 *
 * **为什么两种语言都注册**：应答判据本来就在宿主接线里逐次现判（同 hover /
 * definition / codeLens 各批的口径），注册面多一门语言零代价；`.kojo` 这一路将来若由
 * 糖线给出提示，不必回来改这里。**不实现 `resolveInlayHint`**：tooltip 直接随提示下发，
 * Monaco 的二段解析（resolve）通道用不上，少一条异步路径。
 */
export function installInlayHintsProvider(monaco: typeof Monaco, handlers: InlayHintHandlers): Monaco.IDisposable {
  const provider: Monaco.languages.InlayHintsProvider = {
    provideInlayHints(model) {
      let hints: EditorInlayHint[];
      try {
        hints = handlers.resolve(model);
      } catch (e: unknown) {
        // 提示是只读呈现面：出错就"没有提示"，绝不把编辑器的输入链带崩
        console.warn(`[kojo-inlay-hints] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return { hints: [], dispose: () => undefined };
      }
      return { hints: toMonacoInlayHints(monaco, model, hints), dispose: () => undefined };
    },
  };
  const subs = [
    monaco.languages.registerInlayHintsProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerInlayHintsProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
