import type * as Monaco from './entry';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { clampRevealPosition, revealSpanOf } from './reveal-position';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

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
        `[kojo-definition] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
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
      const key = `${location.filePath}\u0000${location.line}\u0000${columnKey}`;
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
 *   事件通道，由 App 开文件后定位（**兜底腿，不退成"静默失败"**）。
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
    };
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
   * 目标路径 → **已在编辑器里打开**的 model（宿主按 `pathKey` 口径查自己的标签表）。
   * 缺省视为"都没有"⇒ D4 全部退回事件通道，行为与 D4 之前逐字一致（additive 接线）。
   */
  openModelFor?(filePath: string): Monaco.editor.ITextModel | undefined;
  /**
   * model URI → 宿主路径（`registerEditorOpener` 的反查表；查不到返回 `undefined` =
   * 这不是宿主认识的文件，交回 Monaco 缺省行为）。
   */
  pathForUri?(uri: string): string | undefined;
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
      console.warn(`[${label}] openModelFor('${filePath}') 抛错：${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
}

/** 光标处的**来源区间**（Peek 列表与 `Ctrl+Click` 悬停预览用它标出"从哪跳的"） */
export function originRangeOf(model: Monaco.editor.ITextModel, position: Monaco.Position): Monaco.IRange {
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
 */
export function provideLocations(
  handlers: DefinitionHandlers,
  findModel: DefinitionModelResolver,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  label = 'kojo-definition',
): Monaco.languages.LocationLink[] | undefined {
  let locations: DefinitionLocation[];
  try {
    locations = handlers.resolve(model, position);
  } catch (e: unknown) {
    // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 F12 崩掉编辑器
    console.warn(`[${label}] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  const plan = planDefinitionJump(locations, findModel);
  if (plan.kind === 'none') return undefined;
  if (plan.kind === 'navigate') {
    handlers.navigate(plan.location);
    return undefined;
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
      // 顺带给 symbolHighlight 高亮动画），本处不抢也不发事件，避免"跳两次"
      if (attached && attached.uri.toString() === resource.toString()) return false;
      const path = handlers.pathForUri?.(resource.toString());
      if (!path || !selectionOrPosition) return false; // 不是宿主认识的文件 / 没给落点：不猜
      const landedAt = selectionOrPosition as Partial<Monaco.IRange & Monaco.IPosition>;
      const line = landedAt.lineNumber ?? landedAt.startLineNumber;
      if (line === undefined) return false;
      const column = landedAt.column ?? landedAt.startColumn;
      const endColumn = landedAt.endColumn;
      const span =
        column !== undefined && endColumn !== undefined && endColumn > column
          ? { columnStart: column, columnEnd: endColumn }
          : undefined;
      handlers.navigate({
        filePath: path,
        line,
        ...(column !== undefined ? { column } : {}),
        ...(span !== undefined ? { span } : {}),
      });
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
 * 返回 `false`，让 Monaco 自己就地跳（带 symbolHighlight 高亮动画，比事件通道更准）。
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
      return provideLocations(handlers, findModel, model, position);
    },
  };
  const opener = registerLocationOpener(monaco, handlers);
  const subs = [
    monaco.languages.registerDefinitionProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerDefinitionProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return {
    dispose: () => {
      subs.forEach((s) => s.dispose());
      opener.dispose();
    },
  };
}
