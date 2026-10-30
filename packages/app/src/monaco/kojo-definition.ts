import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { clampRevealPosition, revealSpanOf, type RevealSpan } from './reveal-position';
import { registerForLanguageServices } from './register-dialects';

/**
 * 转到定义的**宿主接线**（2026-10-15 语言服务批；D4 Peek 就地预览同文件改写；
 * W9 落点 span 批 2026-10-17：区间一路带到落点，并与"跳到实现"**共用同一条落地腿**）。
 *
 * 分层与 `kojo-hover` / `kojo-completion` 同款：**纯逻辑**（`collectDefinitionLocations`：
 * 按槽序问各贡献方、隔离抛错、去重；`planDefinitionJump`：这一批目标该走哪条腿；
 * `toDefinitionLinks`：目标 → Monaco `LocationLink`；`provideLocations`：一次请求的整条腿）
 * 与 **Monaco 绑定**（`installDefinitionProvider`：位置进、位置出）分开——前者可单测，
 * 后者只做协议翻译。宿主**不认识** ERB / 家族 / 角色：数据全部来自
 * `ui.editor.languageService` 槽，宿主只决定"跳去哪、能不能交给 Monaco 自己跳"。
 *
 * **LAU-4 第二步（2026-10-30）**：本文件最后一块 ERB 本地判据（`#DIM` 声明名与 `$` 标签名的
 * 本地腿）也已搬走——判据在解析器插件 `@kojo/plugin-erb-parser`，供方是它自己，宿主不再 import
 * `erb-dim-navigation` / `erb-label-navigation`。投影面（升糖预览）上的坐标换算在**读类腿**
 * （`ui/editor-global-providers.ts` 的 `readDefinitionTargets`）里做，本文件零坐标知识。
 */

/**
 * 定义目标 = 契约的 `EditorSymbolLocation` **本尊**（W9 落点 span 批的收口：区间
 * `span?: RevealSpan` 已在契约上 additive 补齐，宿主这一侧不再另加字段——
 * 这个别名只是给装配层一个读得懂的名字，**不是**第二份形状）。
 */
export type DefinitionLocation = EditorSymbolLocation;

/**
 * 合并全部贡献方的定义目标。
 *
 * 隔离纪律与装饰器 / CodeAction 一致：**单个贡献抛错不影响其余**（能力出错退化可见，
 * 不让整条"转到定义"消失）；去重键含文件与行列——同一个目标被两个贡献方同时给出
 * （如 ERB 与糖两条线都命中）时不该出现两份。
 *
 * W9：去重时**取区间的那一枚**（同一条目标，一份带 span、一份只带列 ⇒ 合并成带 span
 * 的那份）。这正是"同一处位置两条腿只有一条带列"在**数据层**的收口：腿的分叉先发生在
 * 供方给的粒度上，光在落点侧统一夹取还不够。
 */
export function collectDefinitionLocations(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest,
): DefinitionLocation[] {
  const out: DefinitionLocation[] = [];
  const indexByKey = new Map<string, number>();
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[kojo-definition] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    // `undefined` = 该贡献方不认这个文件（跳过）；空数组 = 认但不给目标（同样不加东西）
    if (!result || result.kind !== 'definition') continue;
    for (const location of result.locations) {
      // 契约已带 `span`（W9 收口）：位置事实直接就是 `DefinitionLocation`，零 cast。
      // 去重键的"列"一位取**区间起点**（`span` 优先于裸 `column`）：
      // `{line:5,column:3}` 与 `{line:5,span:{3,8}}` 是同一处，只留带区间的那一枚；
      // 而"同一行、给了列"与"同一行、什么都没给"仍然算两枚（旧口径逐字保持，
      // 见 `tests/kojo-definition.test.ts` 的去重用例）。
      const columnKey = revealSpanOf(location)?.columnStart ?? location.column ?? '';
      // B3b：`range` 在场时键里带上**终点行**——"整段落点"与"起点那一行"是两处不同的
      // 目标（2.0 的展开体：模板定义段 vs 它自己首行上的声明），只按起点去重会把
      // 后者并进前者，Peek 列表从此少一条。`range` 缺席 ⇒ 键与加这一格之前逐字相同。
      const rangeKey = location.range === undefined ? '' : `\u0000r${location.range.endLine}`;
      const key = `${location.filePath}\u0000${location.line}\u0000${columnKey}${rangeKey}`;
      const at = indexByKey.get(key);
      if (at === undefined) {
        indexByKey.set(key, out.length);
        out.push(location);
        continue;
      }
      const kept = out[at]!;
      if (!kept.span && location.span) out[at] = { ...kept, span: location.span };
      if (kept.column === undefined && location.column !== undefined) out[at] = { ...out[at]!, column: location.column };
    }
  }
  return out;
}

/* ============================== D4：这批目标该走哪条腿（纯逻辑） ============================== */

/**
 * 一次"转到定义"的落地方案（三态 = 三条腿，判据全在这函数里，可单测）。
 *
 * - `'none'`：此处没有定义（什么也不做，Monaco 自己会提示"未找到定义"）；
 * - `'peek'`：**全部**目标都已有 live model ⇒ 交回 Monaco 真 `LocationLink[]`——
 *   `Ctrl+Click` / `F12` 就地跳、`Alt+F12` 能弹出列表（Peek 的数据源就是这份返回）；
 * - `'navigate'`：有目标缺 model（文件没在编辑器里打开）⇒ 走 `editor.revealLocation`
 *   事件通道，由 App 开文件后定位（**兜底腿，不退成"静默失败"**）；装配点若给了 `peekTarget`，
 *   这一腿会先试一次"给缺的那些目标建隐藏 model"（项 7），建得成就改走 `'peek'`。
 */
export type DefinitionPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'peek'; readonly locations: readonly DefinitionLocation[] }
  | { readonly kind: 'navigate'; readonly location: DefinitionLocation };

/** 路径 → 已存在的 model（`undefined` = 这个文件还没在编辑器里打开） */
export type DefinitionModelResolver = (filePath: string) => Monaco.editor.ITextModel | undefined;

/**
 * 分腿判据：**只要有任一目标没有 live model，整批就交回 Monaco**（走事件通道）。
 *
 * 为什么不做"部分返回"：Monaco 只能显示它拿到的那份列表，缺 model 的目标会从列表里
 * **静默消失**——作者看到"1 处定义"其实是"N 处里能显示的那几处"，比不弹 Peek 更坏。
 * 混合场景（同文件 + 未打开文件）宁可整体走事件通道：那条腿一直会把**第一个**目标
 * 跳到（槽序 = 优先级），零丢失。
 *
 * 单目标同理：同文件单目标 ⇒ `'peek'`（就地跳，不再发事件）；未打开文件单目标 ⇒
 * `'navigate'`，与 D4 之前的行为逐字一致。
 */
export function planDefinitionJump(
  locations: readonly DefinitionLocation[],
  findModel: DefinitionModelResolver,
): DefinitionPlan {
  if (locations.length === 0) return { kind: 'none' };
  for (const location of locations) {
    if (!findModel(location.filePath)) {
      return { kind: 'navigate', location: locations[0]! };
    }
  }
  return { kind: 'peek', locations };
}

/**
 * 目标 → Monaco `LocationLink[]`（**只收有 live model 的目标**）。
 *
 * 这条自证是 D4 的核心：**绝不把指向未建 model 的 URI 交给 Monaco**——standalone 的
 * `InMemoryTextModelService.createModelReference` 对不存在的 model 直接抛
 * `Model not found`（Peek 预览拿不到内容），`StandaloneCodeEditorService.doOpenEditor`
 * 更只认**挂在编辑器上的那一份** model，URI 对不上就返回 null ⇒ 跳动静默失败。
 * 所以 `uri` 一律取现成 model 的 `model.uri`（真 `Uri` 对象——Monaco 会读
 * `loc.uri.scheme` 过滤，字符串塞进去整条请求直接 reject）。
 *
 * 行列口径复用 `clampRevealPosition`（R1 列接线批；W9 起同时给出区间）：与
 * `editor.revealLocation` 那条腿**同一个落点函数**，两条腿跳到的位置不可能不一致；
 * 越界一律夹取不报错。
 * `range` 取整行（Peek 预览要高亮这一行），`targetSelectionRange` 取契约给的**真实区间**
 * （没给区间就退化成零宽 = 只把光标放到那一列，**不铺到行尾**——那是"猜作者要那儿"）；
 * 字段名以 monaco-editor 0.57 的**公开 API** `LocationLink`（`uri` / `range` /
 * `targetSelectionRange` / `originSelectionRange`）为准，内部 `isLocationLink` 也按这组
 * 名字判定（少一个 range 字段就当普通 `Location`，`referencesModel` 取
 * `targetSelectionRange ?? range` 作为落点）。
 */
export function toDefinitionLinks(
  locations: readonly DefinitionLocation[],
  findModel: DefinitionModelResolver,
  originSelectionRange?: Monaco.IRange,
): Monaco.languages.LocationLink[] {
  const out: Monaco.languages.LocationLink[] = [];
  for (const location of locations) {
    const target = findModel(location.filePath);
    if (!target) continue; // 未建 model ⇒ 不进列表（见上方自证）
    const geometry = {
      lineCount: target.getLineCount(),
      maxColumn: (lineNumber: number) => target.getLineMaxColumn(lineNumber),
      lineText: (lineNumber: number) => target.getLineContent(lineNumber),
    };
    // B3b（2026-10-24）：`range` 在场 = 落点本身就是**一整段**（2.0 展开体的模板 / 池定义，
    // 声明头到体末）。这时：
    // - `range` 用它（Peek 里框住整段，这才是"跳到了"的视觉证据）；
    // - `targetSelectionRange` 仍是**起点行**那一行——光标只该落在声明头，
    //   把整段当选区会让编辑器一进去就选中几百行；
    // - 夹取仍走 `clampRevealPosition`（全仓唯一落点判据），只是分别夹两端。
    // `range` 缺席 ⇒ 下面整段与加这一格之前**逐字相同**。
    if (location.range !== undefined) {
      const start = clampRevealPosition(
        { line: location.range.startLine, column: location.range.startColumn },
        geometry,
      );
      const end = clampRevealPosition(
        { line: location.range.endLine, column: location.range.endColumn },
        geometry,
      );
      // 夹取可能把两端收成同一行（原文跨行、模型却短）⇒ 终点不许早于起点
      const endLine = Math.max(start.lineNumber, end.lineNumber);
      const endColumn = endLine === start.lineNumber ? Math.max(start.column, end.column) : end.column;
      const link: Monaco.languages.LocationLink = {
        uri: target.uri,
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: endLine,
          endColumn,
        },
        targetSelectionRange: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: start.lineNumber,
          endColumn: start.columnEnd,
        },
      };
      if (originSelectionRange) link.originSelectionRange = originSelectionRange;
      out.push(link);
      continue;
    }
    // 落点判据**只有这一份**：行列与区间一律由 `clampRevealPosition` 夹到 model 真实存在的值
    const landing = clampRevealPosition({ line: location.line, column: location.column, span: location.span }, geometry);
    const endColumn = geometry.maxColumn(landing.lineNumber);
    const link: Monaco.languages.LocationLink = {
      uri: target.uri,
      range: {
        startLineNumber: landing.lineNumber,
        startColumn: 1,
        endLineNumber: landing.lineNumber,
        endColumn,
      },
      targetSelectionRange: {
        startLineNumber: landing.lineNumber,
        startColumn: landing.column,
        endLineNumber: landing.lineNumber,
        endColumn: landing.columnEnd,
      },
    };
    if (originSelectionRange) link.originSelectionRange = originSelectionRange;
    out.push(link);
  }
  return out;
}

/* ============================== Monaco 绑定（definition 与 implementation **共用**的一条腿） ============================== */

/**
 * 宿主注入的三件事：怎么问（含糖视图判据）、怎么落地、哪些目标已经开着。
 *
 * W9：`F12 转到定义` 与 `Ctrl+F12 跳到实现` **共用这一个形状**——两者要的
 * "名字 → 定义位"是同一份数据（都由 `ui.editor.languageService` 槽的供方给），
 * 分两套 handlers 就是允许第二条腿自己再算一遍（旧 `erb-implementation` 直读
 * `ErbIndex.byName` 正是这么长出第二份计算的）。
 */
export interface DefinitionHandlers {
  /** 位置 → 目标（宿主在此查槽；返回空数组 = 此处没有定义） */
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): DefinitionLocation[];
  /** 落地一次跳转（宿主注入；当前实现经 `editor.revealLocation` 复用既有导航通道） */
  navigate(location: DefinitionLocation): void;
  /**
   * **同 model 就地跳已经发生**（NAV-1，2026-10-20）：Monaco 缺省 handler 完成
   * setSelection + reveal（含 `symbolHighlight` 高亮动画）之后，本处只把这一事实交给
   * 宿主记账（装配点的实现发 `editor.navigated`，App 订阅后只 `pushNav`）。
   *
   * 契约：消费方**只许写导航历史**，不得反向驱动跳转（再开文件 / 再定位 = "跳两次"，
   * 高亮动画也会被打断）。缺省不接线 ⇒ 行为与此前逐字一致（additive）。
   */
  recordInPlaceNavigation?(location: DefinitionLocation): void;
  /**
   * 目标路径 → **已在编辑器里打开**的 model（宿主按 `pathKey` 口径查自己的标签表）。
   * 缺省视为"都没有"⇒ D4 全部退回事件通道，行为与 D4 之前逐字一致（additive 接线）。
   */
  openModelFor?(filePath: string): Monaco.editor.ITextModel | undefined;
  /**
   * model URI → 宿主路径（`registerEditorOpener` 的反查表；查不到返回 `undefined` =
   * 这不是宿主认识的文件，交回 Monaco 缺省行为）。
   */
  pathForUri?(uri: string): string | undefined;
  /**
   * 给一份**没在标签里打开**的目标建一份可 Peek 的 model（1020 编辑器体感批，项 7）。
   * 装配点注入的是 `peek-leases` 那条腿（向 model 池要文 + 有界租约）。
   * 缺省 = 没有这条腿 ⇒ 行为与 D4 逐字一致：整批退回事件通道（`tests/kojo-definition.test.ts`
   * 的老用例钉的就是这一条，additive 接线不许改旧语义）。
   */
  peekTarget?(filePath: string): Promise<Monaco.editor.ITextModel | undefined>;
}

/**
 * `openModelFor` 的安全包装：查不到 / 抛错都当"这个文件没开着"（判腿与构造链接两次都问，
 * 每次都可能是并发关标签之后的答案 ⇒ 两条腿都容错，不让 F12 崩）。
 * `label` 只用于日志前缀（definition 与 implementation 两条 provider 共用本函数）。
 */
export function createDefinitionModelResolver(
  handlers: DefinitionHandlers,
  label = 'kojo-definition',
): DefinitionModelResolver {
  return (filePath) => {
    try {
      return handlers.openModelFor?.(filePath);
    } catch (e: unknown) {
      console.warn(`[${label}] openModelFor('${filePath}') 抛错：${errorText(e)}`);
      return undefined;
    }
  };
}

/** 光标处的**来源区间**（Peek 列表与 `Ctrl+Click` 悬停预览用它标出"从哪跳的"） */
function originRangeOf(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
  const word = model.getWordAtPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word?.startColumn ?? position.column,
    endLineNumber: position.lineNumber,
    endColumn: word?.endColumn ?? position.column,
  };
}

/**
 * 一次请求的**整条腿**（definition 与 implementation 逐字共用，W9 判据③"只有一条实现路径"）：
 * 位置进 → 要么交回 Monaco 真 `LocationLink[]`（就地跳 / Peek 有数据），
 * 要么已经把第一枚目标发给 `editor.revealLocation` 并返回 `undefined`。
 *
 * 三条腿的取舍全在 `planDefinitionJump`，落点行列全在 `clampRevealPosition`——
 * 本函数只做编排，第二条腿（跳到实现）若另写一份，两份必然在夹取或兜底上漂。
 *
 * **项 7 补的那一拍**（1020 编辑器体感批）：判腿说"有目标没开着"时，先给装配点那条
 * `peekTarget` 一次机会（建隐藏 model），成了就整批改走 Peek、作者看到完整列表；
 * 没成（没接线 / 读盘失败）就照旧走事件通道跳第一个 ⇒ 旧语义逐字保留，不新造失败模式。
 * 返回值因此可能是 Thenable——Monaco 的 provider 协议本来就收 Promise（`ProviderResult`）。
 */
export function provideLocations(
  handlers: DefinitionHandlers,
  findModel: DefinitionModelResolver,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  label = 'kojo-definition',
): Monaco.languages.ProviderResult<Monaco.languages.LocationLink[]> {
  let locations: DefinitionLocation[];
  try {
    locations = handlers.resolve(model, position);
  } catch (e: unknown) {
    // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 F12 崩掉编辑器
    console.warn(`[${label}] resolve 抛错：${errorText(e)}`);
    return undefined;
  }
  const plan = planDefinitionJump(locations, findModel);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'navigate') {
    if (!handlers.peekTarget) {
      handlers.navigate(plan.location);
      return undefined;
    }
    const origin = originRangeOf(model, position);
    return Promise.all(
      locations
        .filter((location) => !findModel(location.filePath))
        .map((location) => handlers.peekTarget!(location.filePath).catch(() => undefined)),
    ).then(() => {
      const links = toDefinitionLinks(locations, findModel, origin);
      if (links.length === 0) {
        // 一份都没建成（读盘全失败）：退回跳转腿，不返回空列表让 Monaco 哑掉
        handlers.navigate(plan.location);
        return undefined;
      }
      // 部分成功也交链接：`toDefinitionLinks` 只收有 model 的那几枚 ⇒ 少的那几条此刻
      // 真的看不见。与 D4 的"混合场景宁可整体走事件通道"相比这是一次**有意**放宽：
      // 建 model 失败是少数（读得到才建得来），而 Peek 列表里至少看得到东西。
      if (links.length < locations.length) {
        console.warn(`[${label}] ${locations.length} 处定义里有 ${locations.length - links.length} 处取文失败，Peek 列表少这几条`);
      }
      return links;
    });
  }
  const links = toDefinitionLinks(plan.locations, findModel, originRangeOf(model, position));
  // 双保险（自证"绝不返回指向未建 model 的 URI"）：链接构造阶段又少了一个 model
  // （并发关标签 / 抛错）⇒ 这批一个都交不出去，退回事件通道，不返回空列表让 Monaco 哑掉
  if (links.length === 0) {
    handlers.navigate(plan.locations[0]!);
    return undefined;
  }
  return links;
}

/**
 * `openCodeEditor` 收到的落点（Monaco 给的是 `IRange | IPosition`）→ 宿主位置事实。
 *
 * 两条腿（同文件记账 / 跨文件发事件）共用这一个解析：真给了宽度才升级成 `span`，
 * 零宽/点式请求仍是一条 `column`——与 `reveal-position` 的退化判据逐字相同。
 * `undefined` = 没给落点（不猜目标，调用方据此拒绝）。
 */
function landingOf(
  selectionOrPosition: Monaco.IRange | Monaco.IPosition | undefined,
): { line: number; column?: number; span?: RevealSpan } | undefined {
  if (!selectionOrPosition) return undefined;
  const landedAt = selectionOrPosition as Partial<Monaco.IRange & Monaco.IPosition>;
  const line = landedAt.lineNumber ?? landedAt.startLineNumber;
  if (line === undefined) return undefined;
  const column = landedAt.column ?? landedAt.startColumn;
  const endColumn = landedAt.endColumn;
  const span =
    column !== undefined && endColumn !== undefined && endColumn > column
      ? { columnStart: column, columnEnd: endColumn }
      : undefined;
  return { line, ...(column !== undefined ? { column } : {}), ...(span !== undefined ? { span } : {}) };
}

/**
 * Peek 里按 Enter / `gotoNextSymbolFromResult` / F12 多目标的跨 model 跳转落地
 * （standalone **必须**宿主补这一手，理由见 `installDefinitionProvider` 的取证段）。
 *
 * 落点**照原样把区间交回宿主通道**：Monaco 给的是 `IRange | IPosition`，
 * 只有真给了宽度才升级成 `span`——零宽/点式请求就仍是一条 `column`，
 * 与转到定义那条腿在 `reveal-position` 里合流。
 */
export function registerLocationOpener(
  monaco: typeof Monaco,
  handlers: DefinitionHandlers,
): Monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const attached = source.getModel();
      // 同 model（同文件就地跳）：交回 Monaco 缺省 handler（它只做 setSelection + reveal，
      // 顺带给 symbolHighlight 高亮动画），本处**不抢跳转、不发 `editor.revealLocation`**
      //（那会让宿主再开一次文件/再定位，等于"跳两次"）。
      // NAV-1 补的一拍（2026-10-20）：跳照旧由 Monaco 做，但"导航已发生"这一事实必须
      // 交给宿主记账（`recordInPlaceNavigation` → 宿主发 `editor.navigated` → App 只 pushNav），
      // 否则同文件 F12 / Peek 回车永远进不了导航栈，Alt+← 回不来。
      if (attached && attached.uri.toString() === resource.toString()) {
        const path = handlers.pathForUri?.(resource.toString());
        const landing = landingOf(selectionOrPosition);
        if (path !== undefined && landing) {
          try {
            handlers.recordInPlaceNavigation?.({ filePath: path, ...landing });
          } catch (e: unknown) {
            // 记账是旁路：它抛错绝不能把 Monaco 的就地跳（含高亮动画）拖下水
            console.warn(`[kojo-definition] recordInPlaceNavigation('${path}') 抛错：${errorText(e)}`);
          }
        }
        return false;
      }
      const path = handlers.pathForUri?.(resource.toString());
      if (!path) return false; // 不是宿主认识的文件：不猜
      const landing = landingOf(selectionOrPosition);
      if (!landing) return false; // 没给落点：不猜
      handlers.navigate({ filePath: path, ...landing });
      return true;
    },
  });
}

/**
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 definition provider（D4：分三条腿，见
 * `planDefinitionJump`），并注册 standalone 的 **editor opener**。
 *
 * **为什么还要 opener**（D4 取证，monaco-editor 0.57）：standalone 的
 * `StandaloneCodeEditorService.doOpenEditor` 只把 `input.resource` 和**挂在编辑器上的那一份
 * model** 比 URI（`findModel`），别的标签虽然 model 早已注册、也一样返回 null ⇒
 * `openCodeEditor` 无人应答 ⇒ 跨文件跳转静默失败。API 注释写得很直白：
 * "If no handler is registered the default behavior is to do nothing for models other than
 * the currently attached one."。所以"model 已存在就能切过去"这条腿**不是白捡的**，必须
 * 由宿主补一手：opener 收到跨 model 的请求 → 反查宿主路径 → 发同一条
 * `editor.revealLocation`（App 开标签 / 换 model / 定位，一条通道走到底）。同 model 的请求
 * 返回 `false`，让 Monaco 自己就地跳（带 symbolHighlight 高亮动画，比事件通道更准）；
 * 跳完只补一条 `recordInPlaceNavigation`（NAV-1：宿主据此只记账，不重放跳转）。
 *
 * opener 全进程**只此一枚**（W9）：`registerEditorOpener` 后注册者会顶掉前一位，
 * 而"跳到实现"要的落地通道与此逐字相同 ⇒ 它不重复注册（见 `erb-implementation.ts`）。
 *
 * 事件通道那两条腿（未打开文件的兜底、opener 的落地）**照旧存在**：D4 没有把它们换成
 * Monaco 自带跳转，只是**在同文件与已开标签两种情形下**把 Monaco 需要的 `Location` 补给它，
 * 让 `Alt+F12` 有东西可显示。
 *
 * 多目标（重名函数的多处定义）**全给**：这与上一批"取第一个、不弹选择器"的保守取舍是
 * 有意反转——`Alt+F12` 的 Peek 列表本身就是那个选择器，`gotoLocation.multipleDefinitions`
 * 缺省就是 `peek`（>1 才弹、单目标直接跳），所以列表既不会打扰单目标场景，又让重名函数
 * 的多处定义第一次变得可见。槽序优先级仍体现在事件通道兜底时取第一个。
 */
export function installDefinitionProvider(
  monaco: typeof Monaco,
  handlers: DefinitionHandlers,
): Monaco.IDisposable {
  const findModel = createDefinitionModelResolver(handlers);
  const provider: Monaco.languages.DefinitionProvider = {
    provideDefinition(model, position) {
      // 宿主这一层**不再有自己的 ERB 判据**（LAU-4 第二步，2026-10-30）：`#DIM` 声明名与
      // `$` 标签名的落点由插件 `@kojo/plugin-erb-lang` 的 `erb-nameDefinition` 贡献给出，
      // 优先级由**槽序**表达（那条贡献 `order = 10` < `erb-parser` 的 `erb-definition` 20）
      // ⇒ `collectDefinitionLocations` 收集出来的顺序仍是"标签 > 声明 > 函数索引"，
      // 与宿主 `mergeNavigationLegs`（查找引用那条腿仍用它）逐字同序。
      // 宿主留给自己的只有两件事：查槽（`handlers.resolve`）与 Monaco 协议翻译。
      return provideLocations(handlers, findModel, model, position);
    },
  };
  const opener = registerLocationOpener(monaco, handlers);
  const dialectSubs = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerDefinitionProvider(id, provider),
    // B3b（2026-10-24）：带能力名调用 —— kojo2 的 descriptor 点名了
    // `slotServices: ['definition']`，共享收口据此也把它挂上（供方是插件）。
    // 不带这一格时本 installer 只覆盖 v1 两门方言，2.0 就没人应答。
    'definition',
  );
  return {
    dispose: () => {
      dialectSubs.dispose();
      opener.dispose();
    },
  };
}
