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
 * ## 代价模型（R1，2026-10-28 重写；取证 monaco-editor 0.57 + 真语料）
 *
 * `inlayHintsController.js` ⇒ `provideInlayHints(model, range, token)` 收到的是
 * **可视区 ±30 行**，触发点比 codeLens 更密：内容变化（≥800ms 尾缘合并）+
 * **每次滚动**都会 `scheduler.schedule()`，防抖间隔按上次实测耗时自适应
 * （`_featureDebounce.for(…, { min: 25 })`）。
 *
 * **旧口径**：供方整篇扫一遍，`range` 只用来筛**输出**，于是单价正比于行数
 * （52,601 行实测 **32.9 ms**），只能在 5,000 行处整档让位。实测这一刀的三段构成：
 * `splitErbLines` 3.4 ms、`visibleCodeLines` 判读 25.0 ms、提示配对 ~4 ms。
 *
 * **新口径**：`range` 进**输入**——宿主把窗口下传（`readonly range` 在
 * `EditorInlayHintRequest` 上），供方只判这一段。400 行窗口实测 **0.44–0.54 ms**
 * （前缀只走一趟 `[SKIP` 搜索把 `[SKIPSTART]` 屏蔽状态带进来；前提是宿主连行首偏移
 * 一起给，否则供方要自己数换行，见 `VisibleLineWindow.fromOffset` 的读数）。
 *
 * 于是「体量档」只剩一件事要判：**这条腿的供方能按窗口取数吗**。能（ERB 方言）⇒
 * 成本正比于视口，行数不再是理由，闸**删除**；不能（`.kojo1` 走糖线整篇转译、
 * `kojo2` 整篇 lex+parse——实测 24,197 行 **57.7 ms** 只是解析，`range` 只省下
 * 12 ms）⇒ 闸照旧，但理由写成那条读数，不再是"5,000 行"这个数字。
 *
 * `kojo2` 的 200ms 那一档见 `kojo2-inlay.ts`；本模块管的是共享收口这一枚。
 */
import { ERB_LANGUAGE_ID } from './erb-language';

/**
 * 这条腿的供方**按行窗口取数**吗（成本正比于视口，而不是行数）。
 *
 * 判据是**供方的代价形状**，不是语言偏好：只有 ERB 方言那条腿
 * （`erb-parser/inlay-hints.ts` 的 `callArgumentHints`）把窗口吃进了输入。
 * `.kojo1` 走糖线（`kojo-sugar/langsvc.ts` 整篇转译后再问 ERB）与 `kojo2`
 * （`kojo-lang/inlay.ts` 整篇 lex+parse）都还是整篇——它们照旧吃体量档。
 */
export function inlayHintsWindowed(languageId: string): boolean {
  return languageId === ERB_LANGUAGE_ID;
}

/**
 * 这次值不值得去问供方（**宿主档降级**，判据与真由见本模块头注的代价模型）。
 * 判在请求之前：省掉一次整篇扫描与全文字符串遍历。
 *
 * 按窗口取数的语言**没有行数闸**——那正是"改形状之后闸失去理由"的落地：
 * 52,601 行整篇 32.9 ms → 400 行窗口 0.44–0.54 ms，行数不再决定单价。
 */
export function inlayHintsAffordable(languageId: string, lineCount: number): boolean {
  return inlayHintsWindowed(languageId) || lineCount < LARGE_FILE_LINES;
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
 * `resolve` 的 `range`（R1，2026-10-28）是 Monaco 这次问的那一段（可视区 ±30 行）。
 * 宿主把它下传给**按窗口取数**的供方（见 {@link inlayHintsWindowed}），于是单价从
 * "正比于行数"变成"正比于视口"；供方忽略它也不会错（少了窗口只是回到整篇）。
 *
 * 注意 `resolve` 拿到的仍然是**整篇**文本——这不是漏改：ERB 供方带着
 * `[SKIPSTART]…[SKIPEND]` 的**跨行状态**，从窗口中间起算会把屏蔽区里的行当代码行
 * ⇒ 凭空多出提示（错标比不标危险，铁律 4）。窗口只省"逐行判读"，不省"读到这一行为止"。
 */
export interface InlayHintHandlers {
  resolve(model: Monaco.editor.ITextModel, range?: Monaco.IRange): EditorInlayHint[];
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
        hints = handlers.resolve(model, range);
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
