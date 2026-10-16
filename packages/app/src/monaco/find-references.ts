import type * as Monaco from './entry';
import type {
  EditorLanguageServiceContribution,
  EditorLanguageServiceRequest,
  EditorSymbolLocation,
} from '@kojo/plugin-api';
import { ERB_LANGUAGE_ID } from './erb-language';
import { KOJO_LANGUAGE_ID } from './kojo-language';

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
 */

/** 合并全部贡献方的引用点（与 `collectDefinitionLocations` 同一条隔离与去重纪律） */
export function collectReferenceLocations(
  contributions: readonly EditorLanguageServiceContribution[],
  request: EditorLanguageServiceRequest & { kind: 'references' },
): EditorSymbolLocation[] {
  const out: EditorSymbolLocation[] = [];
  const seen = new Set<string>();
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
    for (const location of result.locations) {
      const key = `${location.filePath}\u0000${location.line}\u0000${location.column ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(location);
    }
  }
  return out;
}

/** 宿主注入：怎么问（含糖视图判据）、怎么落地、哪些文件已经开着 */
export interface ReferenceHandlers {
  /** 位置 → 引用点全集（宿主在此查槽；空数组 = 此处没有可证明的引用） */
  resolve(model: Monaco.editor.ITextModel, position: Monaco.Position): readonly EditorSymbolLocation[];
  /** 落地一次跳转（未打开文件那条腿的落点；与转到定义同一条 `editor.revealLocation`） */
  navigate(location: EditorSymbolLocation): void;
  /** 文件路径 → 已打开标签的 live model（查不到 = 未打开） */
  openModelFor?(filePath: string): Monaco.editor.ITextModel | undefined;
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
      let locations: readonly EditorSymbolLocation[];
      try {
        locations = handlers.resolve(model, position);
      } catch (e: unknown) {
        // 宿主自己的 resolve（查槽 + 组请求）出错也不能让 Shift+F12 崩掉编辑器
        console.warn(`[find-references] resolve 抛错：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      const out: Monaco.languages.Location[] = [];
      for (const location of locations) {
        const live = findModel(location.filePath);
        const column = location.column ?? 1;
        // 已开文件用真 model 的 uri（Monaco 才能给预览与就地跳）；未开文件发 file URI，
        // 预览物化会失败但树项保留（计数不说谎），点击由下方 opener 兜住
        const uri = live ? live.uri : monaco.Uri.file(location.filePath);
        if (!live) knownPaths.set(uri.toString(), location.filePath);
        out.push({
          uri,
          range: {
            startLineNumber: location.line,
            startColumn: column,
            endLineNumber: location.line,
            endColumn: column,
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
      const landedAt = selectionOrPosition as Partial<Monaco.IRange & Monaco.IPosition>;
      const line = landedAt.lineNumber ?? landedAt.startLineNumber;
      if (line === undefined) return false;
      const column = landedAt.column ?? landedAt.startColumn;
      handlers.navigate({ filePath: path, line, ...(column !== undefined ? { column } : {}) });
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
