/**
 * ERB 预处理条件块的**被裁支压暗**（A5 / P0-3 尾巴：分支变灰）。
 *
 * 分工一句话：**判据在插件、显示在这里**。哪一支会被引擎裁掉由
 * `@kojo/plugin-erb-parser` 的 `collectPreprocDeadRanges()` 算（纯函数，与 Emuera
 * `ErbLoader.PPState` 逐条对得上），本模块只负责把它变成 Monaco 的区间装饰——
 * 宿主不重新解释 `[IF xxx]` 的语义，否则就有了第二份判据。
 *
 * ## 为什么挂 `onDidCreateEditor` 而不是塞进 EditorPane
 * 装饰集是**编辑器实例级**资源（`createDecorationsCollection`），而"哪个 model 在屏上"
 * 随时会变（切标签、糖预览、分屏）。挂在这一层的好处：所有实例（含日后新增的分屏）
 * 自动覆盖，EditorPane 那 4,000 行不用再长一段"另一条去抖刷新链"。
 *
 * ## 什么时候**不压**
 * - **没有项目索引**（`definedMacros === null`）：没有"项目里有哪些宏"这个事实，
 *   猜一次就是成片压错。宁可什么都不显示——那是本仓对"错标比不标危险"的一贯选择。
 * - **不是真文件 model**：糖预览那份 `inmemory://` 投影是派生物，压暗它等于对投影
 *   撒谎（原文与投影行号也不保证对齐）。
 * - **超长文件**：装饰是逐行阅读辅助，几十万行的文件为它整篇取文本不值（与折叠/着色
 *   各批的档位纪律同源）。
 *
 * ## 为什么区间不含标记行
 * `[IF DEBUG]` 那一行本身是"为什么下面是灰的"的证据，压暗它等于把解释一起藏起来。
 * 正文压暗、标记保持原样，作者一眼就能读出因果。
 */
import type * as Monaco from './entry';
import * as monaco from './entry';
import type { ErbIndex } from '@kojo/plugin-api';
import { isErbDialectPath } from '@kojo/plugin-api';
import { collectPreprocDeadRanges } from '@kojo/plugin-erb-parser';
import { definedMacrosOf } from './erb-preproc-defines';
import './erb-preproc-dim.css';

/**
 * 装饰类名（单一真源：CSS 与这里必须同一个串）。
 *
 * 样式见 `erb-preproc-dim.css`：只落主题色阶（`--fg-dim`），不写死十六进制——
 * 三套主题各给值，浅色下也不会掉到不可读。
 */
export const ERB_PREPROC_DEAD_CLASS = 'erb-preproc-dead';

/** 编辑停顿后重算的去抖窗口（与波浪线的 `MARKER_DEBOUNCE_MS` 同量级，各走各的） */
const DEBOUNCE_MS = 220;

/** `#DEFINE` 名集的取数腿住叶子模块（零 monaco 依赖，可在 node 里单测）；这里只为旧 import 点留个面 */
export { definedMacrosOf } from './erb-preproc-defines';

/** 一个编辑器实例上的装饰状态 */
interface DimEntry {
  readonly collection: Monaco.editor.IEditorDecorationsCollection;
  timer: number | null;
  /** 当前挂着的 model 内容订阅（换 model 时先拆） */
  contentSub: Monaco.IDisposable | null;
  readonly modelSub: Monaco.IDisposable;
  readonly disposeSub: Monaco.IDisposable;
}

export interface ErbPreprocDimHandle {
  /** 立刻重算全部编辑器（索引重建后由调用方触发） */
  refresh(): void;
  dispose(): void;
}

/**
 * 装配被裁支压暗。全局一份（`ensureGlobalProviders` 里调用一次），返回句柄供整体拆毁。
 *
 * `deps.index` 每次重算时现取（不缓存索引本身）：索引重建、项目切换、关闭项目
 * 都只需调用方 `refresh()` 一次，这里不必知道任何一种生命周期。
 *
 * `deps.maxLines` = 超过这个行数整档让位。判据/阈值**单一真源**在 `ui/editor-options.ts`
 * （`LARGE_FILE_LINES`，与粘性滚动/括号对着色/整篇找同词同档）；本模块不写第二个数，
 * 也不引那个模块——它不在开机图的静态段里，引一次就要多枚模块进图（PS-10 闸）。
 * 原写死 20,000，依据是"真语料最大单文件 1.1 万行"——2026-10-28 复核已过时（同树有
 * 19,033 行与 169,119 行）。读数见 `.workbuddy-ai/reports/2026-10-28-p0-3-bigfile-highlight.md`。
 */
export function installErbPreprocDim(deps: {
  index: () => ErbIndex | null;
  maxLines: number;
}): ErbPreprocDimHandle {
  const entries = new Map<Monaco.editor.ICodeEditor, DimEntry>();

  const clearOf = (entry: DimEntry): void => {
    if (entry.collection.length > 0) entry.collection.clear();
  };

  const compute = (editor: Monaco.editor.ICodeEditor, entry: DimEntry): void => {
    const model = editor.getModel();
    if (model === null || model.isDisposed()) {
      clearOf(entry);
      return;
    }
    // 糖预览 / diff 侧的派生 model：不对投影判死支（行号也可能对不上）。
    // 判据走**路径扩展名**（ERB 方言三件套）而不是 model 语言 id：语言 id 分支是
    // LAU-2 起要收敛的形态（`audit-language` M2），而"哪些扩展名属 ERB"本来就由契约
    // `ERB_DIALECT_EXTENSIONS` 一处回答。
    if (model.uri.scheme !== 'file' || !isErbDialectPath(model.uri.fsPath)) {
      clearOf(entry);
      return;
    }
    const ranges =
      model.getLineCount() >= deps.maxLines
        ? []
        : collectPreprocDeadRanges(model.getValue(), definedMacrosOf(deps.index()));
    if (ranges.length === 0) {
      clearOf(entry);
      return;
    }
    entry.collection.set(
      ranges.map((r) => ({
        range: new monaco.Range(r.fromLine, 1, r.toLine, model.getLineMaxColumn(r.toLine)),
        options: {
          isWholeLine: true,
          inlineClassName: ERB_PREPROC_DEAD_CLASS,
          // 悬停说明用**标记原词**开头：作者看到的灰与解释指向同一行
          hoverMessage: {
            value:
              `\`${r.marker}\` 这一支会被引擎裁掉：` +
              (r.macro === ''
                ? '前面已有一支条件成立。'
                : `宏 \`${r.macro}\` 在整个项目里没有 \`#DEFINE\`。`) +
              (r.macro === 'DEBUG' || r.macro === 'NDEBUG'
                ? '\n\n想按调试模式分支，写法是 `[IF_DEBUG]` / `[IF_NDEBUG]`（下划线版）。'
                : ''),
          },
        },
      })),
    );
  };

  const entryFor = (editor: Monaco.editor.ICodeEditor): DimEntry => {
    const existing = entries.get(editor);
    if (existing !== undefined) return existing;
    const entry: DimEntry = {
      collection: editor.createDecorationsCollection(),
      timer: null,
      contentSub: null,
      // 换 model / 销毁 都由这里收口：装饰集不跨 model 存活（`setModel` 已自动清空，
      // 但 `contentSub` 必须换绑，否则新 model 的输入不触发重算）
      modelSub: editor.onDidChangeModel(() => refreshSoon(entry, editor)),
      disposeSub: editor.onDidDispose(() => {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
        entry.contentSub?.dispose();
        entry.modelSub.dispose();
        entry.disposeSub.dispose();
        entries.delete(editor);
      }),
    };
    entries.set(editor, entry);
    return entry;
  };

  const refreshSoon = (entry: DimEntry, editor: Monaco.editor.ICodeEditor): void => {
    entry.contentSub?.dispose();
    entry.contentSub = null;
    const model = editor.getModel();
    if (model !== null && !model.isDisposed()) {
      entry.contentSub = model.onDidChangeContent(() => schedule(entry, editor));
    }
    schedule(entry, editor);
  };

  const schedule = (entry: DimEntry, editor: Monaco.editor.ICodeEditor): void => {
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      compute(editor, entry);
    }, DEBOUNCE_MS);
  };

  const hook = (editor: Monaco.editor.ICodeEditor): void => {
    refreshSoon(entryFor(editor), editor);
  };

  // 已存在的编辑器补挂一遍（挂载顺序不保证这枚 provider 一定先到）。**只认数组**：
  // 这是全局 provider 链上的一枚，而接线层契约是「半途抛错 ⇒ 整批 provider 回滚、本次不重试」
  // （`ui/editor-global-providers.ts` 缺陷 ②）——为一次补挂便利把补全 / 悬停 / 改名一起带下去不值。
  // 非数组（宿主单测的万能桩会把任意调用记成一枚 disposable，返回的就不是数组）按
  // "当前没有已存在实例"处理——新实例由下面那条订阅兜住，功能不缺，只是补挂晚一拍。
  const existing: unknown = monaco.editor.getEditors();
  if (Array.isArray(existing)) {
    for (const editor of existing as Monaco.editor.ICodeEditor[]) hook(editor);
  }
  const createSub = monaco.editor.onDidCreateEditor(hook);

  return {
    refresh: () => {
      for (const [editor, entry] of entries) compute(editor, entry);
    },
    dispose: () => {
      createSub.dispose();
      for (const entry of entries.values()) {
        if (entry.timer !== null) window.clearTimeout(entry.timer);
        entry.contentSub?.dispose();
        entry.modelSub.dispose();
        entry.disposeSub.dispose();
        entry.collection.clear();
      }
      entries.clear();
    },
  };
}
