import type * as Monaco from './entry';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';
import { clampRevealPosition, revealSpanOf } from './reveal-position';
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
        `[find-references] '${contribution.id}' provide 抛错：${e instanceof Error ? e.message : String(e)}`,
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

/** 宿主注入：怎么问（含糖视图判据）、怎么落地、哪些文件已经开着 */
export interface ReferenceHandlers {
  /** 位置 → 引用点全集（宿主在此查槽；空数组 = 此处没有可证明的引用） */
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): readonly ReferenceLocation[];
  /** 落地一次跳转（未打开文件那条腿的落点；与转到定义同一条 `editor.revealLocation`，W9 起带区间） */
  navigate(location: ReferenceLocation): void;
  /** 文件路径 → 已打开标签的 live model（查不到 = 未打开） */
  openModelFor?(filePath: string): Monaco.editor.ITextModel | undefined;
  /**
   * 计数读数出口（**可选**，W8 XLANG-RENAME）：F12 的"N 处"与「被调用 M 处」面板
   * 从此读**同一份** `ReferenceTally`，宿主把它接到状态栏 / 面板头即可，
   * 差值由 `explainReferenceCounts` 一句话讲清。缺席 = 只出列表不出读数（旧行为）。
   */
  onTally?(tally: ReferenceTally, explanation: string): void;
}

/** 本模块 opener 反查表容量上限（LRU；见 `rememberPath`） */
export const KNOWN_PATHS_LIMIT = 256;

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
 * 为 ERB 方言与 `.kojo` 两种语言 id 注册 ReferenceProvider，并注册**未打开文件**那条
 * 腿的 opener（只认本 provider 发过的 URI——不抢别人的请求，见 `openCodeEditor` 判据）。
 */
export function installReferenceProvider(
  monaco: typeof Monaco,
  handlers: ReferenceHandlers,
): Monaco.IDisposable {
  /** 本 provider 发出去过的 `uri → 路径`（opener 反查表；只含**未打开**文件——已开的走既有 opener） */
  const knownPaths = new Map<string, string>();
  const findModel: ReferenceHandlers['openModelFor'] = (filePath) => {
    try {
      return handlers.openModelFor?.(filePath);
    } catch (e: unknown) {
      console.warn(
        `[find-references] openModelFor('${filePath}') 抛错：${e instanceof Error ? e.message : String(e)}`,
      );
      return undefined;
    }
  };
  const provider: Monaco.languages.ReferenceProvider = {
    provideReferences(model, position) {
      let locations: readonly ReferenceLocation[];
      try {
        locations = handlers.resolve(model, position);
      } catch (e: unknown) {
        // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 Shift+F12 崩掉编辑器
        console.warn(`[find-references] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      const out: Monaco.languages.Location[] = [];
      // 计数与列表同源：位置进台账（分类由供方带过来，缺席即未分类），读数与列表一次算出
      const tally = tallyReferenceOccurrences(occurrencesFromLocations(locations));
      try {
        handlers.onTally?.(tally, explainReferenceCounts(tally));
      } catch (e: unknown) {
        console.warn(`[find-references] onTally 抛错（不影响列表交付）：${e instanceof Error ? e.message : String(e)}`);
      }
      for (const location of locations) {
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
            { lineCount: live.getLineCount(), maxColumn: (n) => live.getLineMaxColumn(n) },
          );
          line = landing.lineNumber;
          startColumn = landing.column;
          endColumn = landing.columnEnd;
        }
        // 已开文件用真 model 的 uri（Monaco 才能给预览与就地跳）；未开文件发 file URI，
        // 预览物化会失败但树项保留（计数不说谎），点击由下方 opener 兜住
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
  };
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const path = knownPaths.get(resource.toString());
      if (!path || !selectionOrPosition) return false; // 不是本 provider 发过的 URI：交回其它 handler
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
  const subs = [
    monaco.languages.registerReferenceProvider(ERB_LANGUAGE_ID, provider),
    monaco.languages.registerReferenceProvider(KOJO_LANGUAGE_ID, provider),
  ];
  return {
    dispose: () => {
      subs.forEach((s) => s.dispose());
      opener.dispose();
    },
  };
}
