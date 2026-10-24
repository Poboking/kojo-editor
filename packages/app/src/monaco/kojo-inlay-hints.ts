import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorInlayHint,
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
} from '@kojo/plugin-api';
import { LARGE_FILE_LINES } from '../ui/editor-options';
import { registerForLanguageServices } from './register-dialects';

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
 *
 * PS-4（2026-10-18 性能批）补两条：① 交回的结果**按 Monaco 给的区间筛**（见
 * `toMonacoInlayHints` 的 `range`）——每次滚动只重建视口内那几枚装饰器；② 取文与问槽
 * 由宿主接线按 `versionId` 记忆化（见 `InlayHintHandlers` 头注），内容没变一律不重扫。
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
        `[kojo-inlay-hints] '${contribution.id}' provide 抛错：${errorText(e)}`,
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
 *
 * `range`（PS-4）= Monaco 这次问的那一段（可视区 ±30 行，`inlayHintsController` 的
 * `_getHintsRanges()`，且**每段各问一次**）。给了就只交回这一段的提示：老写法把整篇
 * 提示一次交回去，Monaco 的 `InlayHintsFragments` 不按区间筛（实测 vendor `inlayHints.js`
 * 的构造函数逐条建 `InlayHintItem`），于是每次滚动都要为**全篇每一条**提示挂一枚装饰器
 * ——4,999 行的文件上是几百枚视口外装饰器的重建。VSCode 的内置供方本来就是"问哪段答哪段"，
 * 这一改动是把 provider 拉回它一直在实现的接口形状。
 * 不给 `range`（老的直接调用方 / 单测）= 整篇照旧交回，行为与本批前逐字一致。
 */
/**
 * 契约的中性类别 → Monaco `InlayHintKind`（**唯一映射表**）。
 *
 * 缺省 = `Parameter`：这是补 `kind` 这一格**之前**宿主对所有提示硬写的值，保持它等于
 * 保持旧供方的显示不变（ERB 的形参名提示正是这一档）。`text` 映射成 `undefined` =
 * 不带类别 ⇒ Monaco 用默认样式（没有"文本类"这个枚举，硬借邻居的颜色是假信息）。
 */
function inlayKindOf(
  monaco: typeof Monaco,
  kind: EditorInlayHint['kind'],
): Monaco.languages.InlayHintKind | undefined {
  const K = monaco.languages.InlayHintKind;
  switch (kind) {
    case 'type':
      return K.Type;
    case 'text':
      return undefined;
    default:
      return K.Parameter;
  }
}

export function toMonacoInlayHints(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  hints: readonly EditorInlayHint[],
  range?: Monaco.IRange,
): Monaco.languages.InlayHint[] {
  const lineCount = model.getLineCount();
  const out: Monaco.languages.InlayHint[] = [];
  for (const hint of hints) {
    if (!Number.isFinite(hint.line) || !Number.isFinite(hint.column)) continue;
    const line = Math.trunc(hint.line);
    if (line < 1 || line > lineCount) continue;
    if (range !== undefined && (line < range.startLineNumber || line > range.endLineNumber)) continue;
    const column = Math.min(Math.max(1, Math.trunc(hint.column)), model.getLineMaxColumn(line));
    out.push({
      position: { lineNumber: line, column },
      label: hint.label,
      // B2c：供方给了类别就用它的（kojo2 的类型提示是 `Type`），缺省仍是 `Parameter`
      // ——与补这一格之前逐字相同，ERB 的供方零改动。
      kind: inlayKindOf(monaco, hint.kind),
      ...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
      ...(hint.paddingLeft === true ? { paddingLeft: true } : {}),
    });
  }
  return out;
}

/**
 * 宿主注入：这篇文档该答什么提示（全部判据——开关 / 糖视图 / 活动标签 / 体量——都在宿主接线）。
 *
 * `resolve` 拿到的是**整篇**文本，不是可视区间那一段——这不是漏改：供方
 * （`erb-parser/src/references.ts` 的 `visibleCodeLines`）带着 `[SKIPSTART]…[SKIPEND]`
 * 的**跨行状态**，从窗口中间起算会把屏蔽区里的行当代码行 ⇒ 凭空多出提示（错标比不标危险，
 * 铁律 4）。真要按区间取文，得让区间进入契约请求（`plugin-api` 的
 * `EditorLanguageServiceRequest` 加一员、由供方自己按自己的状态判起点）——本批记为后续。
 * 本批把这条腿的**重复**代价消掉：宿主接线按 `versionId` 记忆化，内容没变时一次都不重扫
 * （Monaco 每次滚动都问，缺省防抖低至 25ms）。
 */
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
    provideInlayHints(model, range) {
      let hints: EditorInlayHint[];
      try {
        hints = handlers.resolve(model);
      } catch (e: unknown) {
        // 提示是只读呈现面：出错就"没有提示"，绝不把编辑器的输入链带崩
        console.warn(`[kojo-inlay-hints] resolve 抛错：${errorText(e)}`);
        return { hints: [], dispose: () => undefined };
      }
      return { hints: toMonacoInlayHints(monaco, model, hints, range), dispose: () => undefined };
    },
  };
  // B2c：带上能力名 —— 声明了 `slotServices: ['inlayHint']` 的语言（kojo2）也挂这一枚。
  // 它的供方是插件 `@kojo/plugin-kojo-lang`，宿主侧零原生实现。
  return registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerInlayHintsProvider(id, provider),
    'inlayHint',
  );
}
