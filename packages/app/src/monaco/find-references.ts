import type * as Monaco from './entry';
import { errorText } from '@kojo/plugin-api';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { registerForLanguageServices } from './register-dialects';
import { clampRevealPosition, revealSpanOf } from './reveal-position';
import { normalizePathKey } from './kojo-hover';
import { owningPaneOf, sugarOwningPaneOf, sugarPreviewLineOf, type PaneCtx } from '../ui/editor-pane-registry';
import {
  explainReferenceCounts,
  isMoreSpecificKind,
  occurrencePositionKey,
  occurrencesFromLocations,
  tallyReferenceOccurrences,
  type ReferenceOccurrence,
  type ReferenceTally,
} from '../ui/reference-utils';

/**
 * 查找所有引用（R2，2026-10-16 语言服务批）——**宿主接线**。
 *
 * 分层与 `kojo-definition` 同款：**纯逻辑**（`collectReferenceLocations`：按槽序问各
 * 贡献方、隔离抛错、去重）与 **Monaco 绑定**（`installReferenceProvider`：位置进、
 * `Location[]` 出）分开。宿主**不认识** ERB / 函数 / 引用口径：数据全部来自
 * `ui.editor.languageService` 槽（ERB 方言由解析器答、`.kojo` 由糖线答），宿主只决定
 * "Peek 给什么、点了去哪"。
 *
 * **LAU-4 引用腿（2026-10-31）之后这条路上一枚 ERB 判据都没有**：此前挂在
 * `provideReferences` 里的两条缓冲区本地腿（`$` 标签作用域 / `#DIM` 声明名）与"标签 →
 * `#DIM` → 槽腿"的合并优先序整块搬进了 `@kojo/plugin-erb-parser`（`symbols.ts` 的
 * `erbReferencesAt`）。本模块只剩请求构造（`readReferences`）+ 契约 → Monaco 形状 +
 * 注册；投影面折回、未打开文件 opener、台账读数照旧住这里（它们是**宿主事实**：哪份
 * model 是投影、哪些标签是开着的），供方够不着。
 *
 * ## LAU-DUALLEG 车 3（2026-10-31）：落点通道与 provider **分离**
 *
 * 收口之前这一格是**双挂**的：共享槽腿（`slot-service-providers.ts` 的 `references` 那一格）
 * 按旧桥把一枚 provider 铺在 ERB 上，本模块的宿主腿也铺一枚 ⇒ 同一次 Shift+F12 问两趟供方，
 * 同一枚引用点还可能以两种行形状进 Peek 树（宿主夹取过 / 槽腿原样），"谁在答"由 Monaco 的
 * 注册顺序裁决。要收的不是"把宿主腿整条搬进插件"，而是先把五格**宿主事实**分离成一枚通道
 * （{@link createReferenceLanding}）：① 屏幕上这份 model 是不是某实例的糖投影、投影行怎么折回；
 * ② 已开标签那份 live model 的 URI 与行列夹取；③ **未打开的文件点了要开得先记住这枚 URI 是
 * 谁发出去的**（`knownPaths` LRU + 一枚 opener）；④ 台账读数交给哪一格；
 * ⑤ **这一次问句该发在哪一份文本、哪个位点上**（`ui/editor-global-providers.ts` 的
 * `referencesAskOf`，经 `SlotServiceHost.askReferences` 递下去——投影面要换算到原文才问得着，
 * 列的口径也跟着这条腿走）。⑤ 与 ①–④ 分开就不成立：槽腿只拿到落点、拿不到发问落点时，
 * 点名这一格的语言在升糖预览面上会**静默 0 命中**（投影文本里没有行首原生记号），
 * 那就是"让位＝静默没有"，比双挂更糟。
 * 这枚通道**不再以第二枚 `registerReferenceProvider` 的形式存在**：宿主腿用它翻形状，槽腿经
 * `SlotServiceHost.landReferences` / `SlotServiceHost.askReferences` 用同一枚翻形状与发问。
 * 于是 ERB 的 descriptor 点名 `references` 之后，宿主腿按 `excludeNamed` 让位、这一格在 ERB 上
 * 恰好一枚 provider，而「已关文件点开」「处数读数」「投影面折回与发问换算」没有一格因让位而丢
 * （缺哪一格都会立刻红在 `find-references.test.ts` 的通道组与 `kojo2-references.test.ts` 的
 * 槽腿通道组）。
 *
 * kojo1 仍留在宿主腿上（它不点名这一格）：它的取数照样经 `readReferences`——同一枚发问换算
 * （`ui/editor-global-providers.ts` 的 `referenceRequestPointOf`，两侧共用，不许有第二份）。
 * 反面钉在 `find-references.test.ts` 的挂载组。
 *
 * ## 三条腿（与 D4 转到定义同构，取证自 monaco 0.57 源码）
 *
 * - **同 model**：Monaco 自己就地跳（`referencesController` → `openCodeEditor` 缺省
 *   handler，带高亮动画）；
 * - **跨已开标签**：`kojo-definition` 注册的 editor opener 反查宿主路径 → 发同一条
 *   `editor.revealLocation`（App 开标签 / 换 model / 定位）；
 * - **未打开文件**：`ReferencesModel` 物化预览时对无 model 的 URI **逐条 catch**
 *   （`referencesModel.js:100-105`，`onUnexpectedError` 后树项照常列出）——树完整、
 *   预览缺一张脸，不算静默丢结果；点击由**本模块自己的 opener** 接住
 *   （只认自己发过的 URI，落回 `navigate` 通道）。
 *
 * 为什么不把未打开的引用**滤掉**：Peek 列表头显示的计数就是列表长度，滤掉 = 作者看到
 * "1 处引用"而真相比那多——计数说谎比缺预览严重（铁律 4）。
 *
 * ## 一份出现点台账（W8 XLANG-RENAME，2026-10-17）
 *
 * 合并去重不再"抹平成位置"：同一条 `EditorSymbolLocation` 上的 `kind`
 * （定义 / 调用 / 提及，由 `erb-parser/references.ts` 填、契约 additive 承载）
 * 进 `ui/reference-utils.ts` 的台账，`collectReferenceReport` 一并给出
 * `tally` + 一句话差值解释——F12 的"N 处"与「被调用 M 处」是**同一次计算的两个投影**,
 * 差值 = 非调用位的定义与提及，可解释、可钉测。同位多方上报取最具体分类，
 * 位置对象保住先入方形状，但**区间不丢**（W9：先入没 `span`、后到给了 ⇒ 补上，
 * 与 `collectDefinitionLocations` 同一口径——引用腿此前会把带区间的那份整个抹掉）。
 *
 * ## W9 落点 span（本批补的引用腿）
 *
 * 区间住在契约 `EditorSymbolLocation.span`（W9 收口批 additive 补上，与
 * `editor.revealLocation.span` 同形）：供方给了就一路带到落点，没给即零宽退化，
 * 宿主两侧不再按可选字段 cast 读。
 * 已开文件的落点区间一律经 `clampRevealPosition` 夹到 model 真实行列——**与转到定义、
 * 跳到实现同一个函数**，Peek 树里点这行与 F12 跳到这处不可能落成两个地方；
 * 未开文件没有 model 可问，交**原样区间**（由 App→编辑器的落地腿统一夹取，
 * 夹取判据全仓只有一份，见 `reveal-position.ts` 文件头）。
 *
 * ## 升糖预览面上的 Peek（2026-10-20 投影折回批）
 *
 * 读类取数腿（`ui/editor-global-providers.ts` 的 `readReferences`）交回的是**源坐标**，那是
 * 对的——落点类腿走 `editor.revealLocation`，源行 → 预览行那一跳住在 `EditorPane.applyReveal`。
 * 但 **Peek 树里那一枚不经过事件通道**：本模块按 `filePath` 把同文件的引用点解到**原文那份
 * model** 的 URI 上，于是列表与预览窗都摆在那一份上，`applyReveal` 一次都不被这条腿调用
 * ⇒ 投影面上列出的是存档行号（用户看到"隔壁文件第 87 行"这种不属于当前屏幕的坐标），
 * 点击只是**碰巧**被 `kojo-definition` 那枚 opener 反查回路绕回事件通道——别人的 opener 不是
 * 本模块的契约，同文件的落点该由本模块自己交对。所以折回判据落在这里，四条：
 * ① 与屏幕上这份投影**同一个源文件**的引用点 ⇒ 折回预览行、URI 用这份投影 model；
 * ② 折不回的那一枚（`sugarPreviewLineOf` 回 `null`）**整条不给**，绝不给猜的行号；
 * ③ **列一律不折算** ⇒ 收到行首（预览行与源行连文本都不是同一串，套源列就把选区盖在别的字上）；
 * ④ **跨文件原样**——那是另一份文件，与这一面的映射无关。
 * 原文面（`sugarOwningPaneOf` 回 null）⇒ 本段一行都不执行，逐字零改动。
 * 判据**只有一份**：归属认 `sugarOwningPaneOf`，行换算认 `sugarPreviewLineOf`（读的就是与投影
 * model 同批换上的那张 `sugarLineMapRef`）——本模块不许自建第二张映射表，两张表一漂移，
 * Peek 列的就是隔壁一行。
 */

/** 定义 / 引用共用的"位置事实"形状（W9 收口：契约 `EditorSymbolLocation` 已带 `span`，别名只是名字） */
export type ReferenceLocation = EditorSymbolLocation;

/**
 * 一次查找引用的完整读数（W8 XLANG-RENAME）：位置 + **台账计数** + 差值解释。
 * `explanation` 是给面板/状态栏用的一句话，与 F12 的"N 处"同源同一次计算——
 * 两边不可能再各说各话。
 */
export interface ReferenceReport {
  readonly locations: readonly ReferenceLocation[];
  readonly tally: ReferenceTally;
  readonly explanation: string;
  /** 认了请求但没给出任何位置的成功贡献方（缺席 = 没有任何贡献方应答，语义不同于"没有引用"） */
  readonly answeredBy: readonly string[];
}

/** 内部：合并全部贡献方，产出台账（保留供方原对象，只补更具体的分类） */
function mergeContributions(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest & { kind: 'references' },
): { entries: Array<{ occ: ReferenceOccurrence; location: ReferenceLocation }>; answeredBy: string[] } {
  const entries: Array<{ occ: ReferenceOccurrence; location: ReferenceLocation }> = [];
  const byKey = new Map<string, number>();
  const answeredBy: string[] = [];
  for (const contribution of contributions) {
    let result: ReturnType<EditorLanguageServiceContribution['provide']>;
    try {
      result = contribution.provide(request);
    } catch (e: unknown) {
      console.warn(
        `[find-references] '${contribution.id}' provide 抛错：${errorText(e)}`,
      );
      continue;
    }
    // `undefined` = 该贡献方不认这个请求/文件（跳过）；空数组 = 认但无引用（不加东西）
    if (!result || result.kind !== 'references') continue;
    answeredBy.push(contribution.id);
    for (const location of result.locations) {
      // 契约已带 `span`（W9 收口）：供方给的位置事实直接进台账，零 cast。
      const [occ] = occurrencesFromLocations([location]);
      if (occ === undefined) continue;
      const key = occurrencePositionKey(occ);
      const at = byKey.get(key);
      if (at === undefined) {
        byKey.set(key, entries.length);
        entries.push({ occ, location });
        continue;
      }
      // 同位多方上报 = 一条出现；分类取最具体的一侧（定义 > 调用 > 提及 > 未分类），
      // 位置对象保住先入方的形状（旧消费方看到的列缺省形态不因合并而变），
      // 但**区间不抹**：先入没 `span` 而后到给了 ⇒ 补上（与 `collectDefinitionLocations` 同口径）
      const kept = entries[at]!;
      if (isMoreSpecificKind(occ.kind, kept.occ.kind)) {
        kept.occ = occ;
        if (kept.location.kind === undefined && location.kind !== undefined) {
          kept.location = { ...kept.location, kind: location.kind };
        }
      }
      if (!kept.location.span && location.span) kept.location = { ...kept.location, span: location.span };
    }
  }
  return { entries, answeredBy };
}

/**
 * 查找引用的**完整读数**（纯逻辑）：合并 + 台账计数 + 一句话差值解释。
 * `collectReferenceLocations` 是它的位置投影——计数与列表从此共用一份数据。
 */
export function collectReferenceReport(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest & { kind: 'references' },
): ReferenceReport {
  const { entries, answeredBy } = mergeContributions(contributions, request);
  const tally = tallyReferenceOccurrences(entries.map((entry) => entry.occ));
  return {
    locations: entries.map((entry) => entry.location),
    tally,
    explanation: explainReferenceCounts(tally),
    answeredBy,
  };
}

/** 合并全部贡献方的引用点（与 `collectDefinitionLocations` 同一条隔离与去重纪律；W9 起同样**保住区间**） */
export function collectReferenceLocations(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest & { kind: 'references' },
): ReferenceLocation[] {
  return [...collectReferenceReport(contributions, request).locations];
}

/**
 * 落点通道要的宿主注入（**一条引用判据都没有**：怎么问、怎么落地、哪些文件开着、计数读数交去哪一格）。
 *
 * `onTally` 的第三参 `path` = 这批读数是谁家的：屏幕上这份 model 归属实例的**存档路径**
 * （投影面上也是那一份——投影不是文件，拿它的 URI 去对文件就是猜）。以前这一格由装配点
 * 一枚 `let` 变量随 `resolve` 记着，宿主腿与槽腿共用一枚通道之后必须现算，否则槽腿那一次
 * 请求会把**上一次**的路径盖在读数上（面板据此报的就是谎）。
 */
export interface ReferenceLandingHandlers {
  /** 落地一次跳转（未打开文件那条腿的落点；与转到定义同一条 `editor.revealLocation`，W9 起带区间） */
  navigate(location: ReferenceLocation): void;
  /** 文件路径 → 已打开标签的 live model（查不到 = 未打开） */
  openModelFor?(filePath: string): Monaco.editor.ITextModel | undefined;
  /**
   * 计数读数出口（**可选**，W8 XLANG-RENAME）：F12 的"N 处"与「被调用 M 处」面板
   * 从此读**同一份** `ReferenceTally`，宿主把它接到状态栏 / 面板头即可，
   * 差值由 `explainReferenceCounts` 一句话讲清。缺席 = 只出列表不出读数（旧行为）。
   */
  onTally?(tally: ReferenceTally, explanation: string, path: string): void;
}

/**
 * 宿主注入：怎么问（`resolve`，含糖视图判据），落点那一侧**二选一**：
 *
 * - `landing` = 装配点建好的**共用通道**（LAU-DUALLEG 车 3）：宿主腿与槽腿拿同一枚
 *   （一张 `uri → 路径` 反查表、一枚 `registerEditorOpener`、一份台账），这时落点三格住在通道里，
 *   本安装器再交一份就是第二枚 opener（全局各认自己发过的 URI，多一枚就多一处抢答与一处
 *   "按了没反应"）——类型上把这条路堵掉，比注释里劝一句可靠；
 * - 或者交 {@link ReferenceLandingHandlers} 那三格，由本安装器**自建**一枚通道
 *   （与分离前逐字相同；单测与没有装配点的宿主走这一路）。
 */
export type ReferenceHandlers = {
  /** 位置 → 引用点全集（宿主在此查槽；空数组 = 此处没有可证明的引用） */
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): readonly ReferenceLocation[];
} & (
  | {
      readonly landing: ReferenceLanding;
      navigate?: undefined;
      openModelFor?: undefined;
      onTally?: undefined;
    }
  | ReferenceLandingHandlers
);

/** 一枚装配产出的落点通道：翻译 + 未打开文件的点击通道共用同一张反查表 */
export interface ReferenceLanding extends Monaco.IDisposable {
  /** 引用点 → Peek 的行：投影面折回、已开标签夹取、未开文件登记，并顺手报出台账读数 */
  land(
    model: Monaco.editor.ITextModel,
    locations: readonly ReferenceLocation[],
  ): Monaco.languages.Location[];
}

/** 本模块 opener 反查表容量上限（LRU；见 `rememberPath`） */
export const KNOWN_PATHS_LIMIT = 256;

/** 屏幕上这一面 = 某实例的糖投影（`null` = 原文面 ⇒ Peek 折回段一行都不执行） */
interface ProjectionSurface {
  readonly ctx: PaneCtx;
  /** 投影归属实例的存档路径 = "同文件"的分界：这一份文件的引用点折回，别处的原样交付 */
  readonly path: string;
}

/**
 * 屏幕上挂着的那份 model 是不是某实例的**糖投影**（判据单源在登记簿的 `sugarOwningPaneOf`；
 * 本模块不许另建映射表，见文件头"升糖预览面上的 Peek"段）。
 */
function projectionSurfaceOf(model: Monaco.editor.ITextModel): ProjectionSurface | null {
  const ctx = sugarOwningPaneOf(model);
  return ctx === null ? null : { ctx, path: ctx.filePathRef.current };
}

/**
 * 这批引用读数是谁家的 = 屏幕上这份 model 归属实例的**存档路径**（投影面上取投影主人那一份，
 * 与 `ui/editor-global-providers.ts` 的 `readTargetOf` 同一条判据：投影不是文件，拿它的 URI
 * 去对文件就是猜）。两侧（宿主腿 / 槽腿）共用一枚通道，所以这一格必须现算而不能由调用方递。
 */
function landingPathOf(model: Monaco.editor.ITextModel): string {
  const projectionOwner = sugarOwningPaneOf(model);
  if (projectionOwner !== null) return projectionOwner.filePathRef.current;
  return owningPaneOf(model)?.filePathRef.current ?? '';
}

/** 一条要交给 Peek 的出现点（`previewLine` = 它在屏幕上这一面的那一行；缺席 = 不属于这一面，原样交付） */
interface PeekRow {
  readonly location: ReferenceLocation;
  readonly previewLine?: number;
}

/**
 * `uri → 路径` 反查表，带 **LRU 上限**。
 *
 * 为什么必须有上限：这张表只增不减——每次 Shift+F12 都会把**未打开**的引用文件写进去，
 * 关闭标签、切换项目都不回收（真语料一处符号能牵出上百份文件），整个会话攒下来就是一张
 * 无界表；更要紧的是换项目后旧项目的 URI 仍在表里，命中同一路径的点击会被**陈旧路由**
 * 接到上一个项目的落点。Monaco 的 opener 是全局注册、先注册先应答，所以不能靠"留着无害"
 * 自我安慰：按插入序淘汰最旧的一条（`Map` 保序 ⇒ `keys().next()` 即最旧），
 * 命中时重新插入让它"续命"，常用条目留在表里。
 */
function rememberPath<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key); // 先删后插 ⇒ 最近使用排到队尾
  map.set(key, value);
  while (map.size > KNOWN_PATHS_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/**
 * 装配**引用落点通道**（LAU-DUALLEG 车 3 分离出来的那一枚宿主模块）。
 *
 * 交进来的只有引用点，产出的是 Peek 能用的 `Location[]`；这一趟里四件事全是宿主事实：
 * ① 屏幕上这份 model 若在某实例的糖投影上 ⇒ 同文件的引用点折回预览行（判据见文件头
 *    "升糖预览面上的 Peek"段，折不过来的**整条不给**，绝不给猜的行号）；
 * ② 已开标签那份 model 的 URI 与行列夹取（`clampRevealPosition` 全仓唯一点）；
 * ③ 未打开文件发 `file` URI 并把 `uri → 路径` 记进 {@link rememberPath} 那张有界表，
 *    点击由本通道注册的那枚 opener 接回 `navigate`（只认自己发过的 URI——不抢别人的请求）；
 * ④ 台账读数（计数与列表同源：先折行、后进台账，Peek 表头那枚 N 必须等于树里的行数）。
 *
 * 反向那一格（"这一面该拿哪份文本、哪个位点去问"）住在装配点的 `referencesAskOf`，
 * 与本模块同源同判据：两侧（宿主腿 / 槽腿）拿到的必须是同一个发问落点。
 *
 * **它不注册任何 ReferenceProvider**——注册是各腿自己的事，这一枚只回答"一枚位置怎么落地"。
 */
export function createReferenceLanding(
  monaco: typeof Monaco,
  handlers: ReferenceLandingHandlers,
): ReferenceLanding {
  /** 本通道发出去过的 `uri → 路径`（opener 反查表；只含**未打开**文件——已开的走既有 opener） */
  const knownPaths = new Map<string, string>();
  const findModel: ReferenceLandingHandlers['openModelFor'] = (filePath) => {
    try {
      return handlers.openModelFor?.(filePath);
    } catch (e: unknown) {
      console.warn(
        `[find-references] openModelFor('${filePath}') 抛错：${errorText(e)}`,
      );
      return undefined;
    }
  };
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const path = knownPaths.get(resource.toString());
      if (!path || !selectionOrPosition) return false; // 不是本通道发过的 URI：交回其它 handler
      rememberPath(knownPaths, resource.toString(), path); // LRU：被点中的条目续命
      const landedAt = selectionOrPosition as Partial<Monaco.IRange & Monaco.IPosition>;
      const line = landedAt.lineNumber ?? landedAt.startLineNumber;
      if (line === undefined) return false;
      const column = landedAt.column ?? landedAt.startColumn;
      // 真给了宽度才升级成 `span`（与 `registerLocationOpener` 逐字同判据）：
      // 零宽/点式请求仍是一条 `column`，在 `reveal-position` 与转到定义那条腿合流
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
  return {
    land(model, locations) {
      const out: Monaco.languages.Location[] = [];
      // 投影面上**同文件**的引用点先折回屏幕上那一行（判据见文件头"升糖预览面上的 Peek"段）；
      // 折不过去的那一枚整条不给。这一趟必须在台账之前：计数与列表同源是本模块的立身判据，
      // Peek 表头那枚 N 必须等于树里的行数。
      const surface = projectionSurfaceOf(model);
      const ownKey = surface === null ? '' : normalizePathKey(surface.path);
      const rows: PeekRow[] = [];
      for (const location of locations) {
        if (surface !== null && normalizePathKey(location.filePath) === ownKey) {
          const previewLine = sugarPreviewLineOf(surface.ctx, location.line);
          if (previewLine === null) continue; // 折不回 = 不给，绝不给一个猜的行号
          rows.push({ location, previewLine });
          continue;
        }
        rows.push({ location }); // 原文面 / 跨文件：原样，一个字段都不碰
      }
      // 计数与列表同源：位置进台账（分类由供方带过来，缺席即未分类），读数与列表一次算出
      const tally = tallyReferenceOccurrences(occurrencesFromLocations(rows.map((row) => row.location)));
      try {
        handlers.onTally?.(tally, explainReferenceCounts(tally), landingPathOf(model));
      } catch (e: unknown) {
        console.warn(`[find-references] onTally 抛错（不影响列表交付）：${errorText(e)}`);
      }
      for (const { location, previewLine } of rows) {
        if (previewLine !== undefined) {
          // URI 就是屏幕上挂着的那份投影 model ⇒ Monaco 走"同 model 就地跳"（一条事件都不发，
          // 所以 `applyReveal` 那一跳在这里帮不上忙）。列一律收到行首：预览行与源行连文本都不是
          // 同一串，把源列套过来就把选区盖在别的字上（纪律②）。
          // 夹取仍走全仓唯一的 `clampRevealPosition`：映射与投影 model 的对应关系不许假定算准了
          const landing = clampRevealPosition(
            { line: previewLine, column: 1 },
            {
              lineCount: model.getLineCount(),
              maxColumn: (n) => model.getLineMaxColumn(n),
              lineText: (n) => model.getLineContent(n),
            },
          );
          out.push({
            uri: model.uri,
            range: {
              startLineNumber: landing.lineNumber,
              startColumn: landing.column,
              endLineNumber: landing.lineNumber,
              endColumn: landing.columnEnd,
            },
          });
          continue;
        }
        const live = findModel(location.filePath);
        // 区间归一与退化**不在此二次实现**：一律 `revealSpanOf`（缺 span 时由裸 column
        // 折成零宽，什么都没给即 undefined ⇒ 行首），与定义 / 实现 / 面板六条腿同一判据
        const span = revealSpanOf(location);
        let line = location.line;
        let startColumn = span?.columnStart ?? 1;
        let endColumn = span?.columnEnd ?? startColumn;
        if (live) {
          // 已开文件：交 `clampRevealPosition`（**全仓唯一点**）夹到 model 真实行列，
          // Peek 就地跳与 F12 事件通道从此共用一个落点函数
          const landing = clampRevealPosition(
            { line: location.line, column: location.column, span },
            {
              lineCount: live.getLineCount(),
              maxColumn: (n) => live.getLineMaxColumn(n),
              lineText: (n) => live.getLineContent(n),
            },
          );
          line = landing.lineNumber;
          startColumn = landing.column;
          endColumn = landing.columnEnd;
        }
        // 已开文件用真 model 的 uri（Monaco 才能给预览与就地跳）；未开文件发 file URI，
        // 预览物化会失败但树项保留（计数不说谎），点击由上面那枚 opener 兜住
        const uri = live ? live.uri : monaco.Uri.file(location.filePath);
        if (!live) rememberPath(knownPaths, uri.toString(), location.filePath);
        out.push({
          uri,
          range: {
            startLineNumber: line,
            startColumn,
            endLineNumber: line,
            endColumn,
          },
        });
      }
      return out;
    },
    dispose: () => opener.dispose(),
  };
}

/**
 * 为**没有**把 `references` 这条腿交给槽供方的语言（今天 = `.kojo1`）注册 ReferenceProvider。
 *
 * 挂载口径（LAU-DUALLEG 车 3）：`registerForLanguageServices(monaco, register, undefined,
 * { excludeNamed: 'references' })`——**第三参必须是 `undefined`**：再传一次 `'references'`
 * 就等于把点名了这一格的语言（今天的 ERB）重新挂上，"一个 kind 恰一枚 provider"立刻破。
 * ERB 由共享槽腿那一枚应答（数据仍来自同一枚 `ui.editor.languageService` 槽的解析器供方），
 * 两侧交回的引用点走**同一枚落点通道**（装配点建的那一枚，第二参），所以「已关文件点开」
 * 「行号夹取」「处数台账」没有一格因为让位而丢。
 *
 * `landing` 是必填参：这一枚安装器**不许**自建通道。两枚通道 = 两张 `uri → 路径` 反查表 +
 * 两枚 `registerEditorOpener`（全局只认先应答的那一位），点开会落到没人登记过的 URI 上——
 * 那是"按了没反应"，比少一条结果更难查。撤也是同一句：本安装器只撤自己的注册，通道归装配点撤。
 */
export function installReferenceProvider(
  monaco: typeof Monaco,
  handlers: ReferenceHandlers,
): Monaco.IDisposable {
  // 通道二选一（见 {@link ReferenceHandlers}）：交来共用通道就借它，没交才自建一枚。
  // 借来的那枚由**装配点**撤（槽腿还在用），自建的才归本安装器——先撤的那一枚不许把
  // 另一枚的点击通道一起带走。
  const shared = 'landing' in handlers;
  const landing = shared ? handlers.landing : createReferenceLanding(monaco, handlers);
  const provider: Monaco.languages.ReferenceProvider = {
    provideReferences(model, position) {
      // **本模块不含任何 ERB 判据**（LAU-4 引用腿，2026-10-31）：`$` 标签 / `#DIM` 声明 /
      // 反向索引三条腿的判据整块住 `@kojo/plugin-erb-parser`（`symbols.ts` 的
      // `erbReferencesAt`），宿主在这一格只做"问槽 → 交落点通道"。
      let locations: readonly ReferenceLocation[];
      try {
        locations = handlers.resolve(model, position);
      } catch (e: unknown) {
        // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 Shift+F12 崩掉编辑器。
        // 本地腿已随判据搬进供方 ⇒ 这里没有"本地兜底"可交，如实退化成"这次没有引用"。
        console.warn(`[find-references] resolve 抛错：${errorText(e)}`);
        return undefined;
      }
      return landing.land(model, locations);
    },
  };
  const dialectSubs = registerForLanguageServices(
    monaco,
    (m, id) => m.languages.registerReferenceProvider(id, provider),
    undefined,
    { excludeNamed: 'references' },
  );
  return {
    dispose: () => {
      dialectSubs.dispose();
      if (!shared) landing.dispose();
    },
  };
}

