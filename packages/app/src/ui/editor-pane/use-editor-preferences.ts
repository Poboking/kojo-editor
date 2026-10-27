/**
 * 编辑器**偏好订阅**（REF-FRONT-PERF，2026-10-20 从 EditorPane 挂载 effect 拆出）。
 *
 * 这条腿的时序是硬约束（同 create options 里那条 `codeLens` 注释：默认值与偏好覆盖
 * 不能依赖"再补一次 effect"的时序）：
 * - 订阅必须**在实例创建 effect 之内、编辑器 create 之后**接线——`ed` 是闭包主角，
 *   提到另一个 effect 里接线会晚一拍（首个 commit 内改设置页的那一次就丢）；
 * - 拆阅时的退订次序与接线次序**逐字一致**（nameColor → fontSize → fontZoom →
 *   suggestDelay → quickSuggestions → layout → findSeed → display），且整段在实例卸载清账的
 *   **最前面**执行（组件原来的 return cleanup 就是按这个顺序写的）。
 *
 * 所以本文件不自己注册 effect：`useEditorPreferences` 只返回一个**安装器**，
 * 由 `useMonacoInstance` 在原来那一行调用；effect 数量、执行顺序、退订顺序都不变。
 * `codeLens` 是唯一的例外——它原本就是一个独立的 effect，这里原样保留独立 hook，
 * 调用点必须留在挂载 effect **之后**（见下方注释：`codeLens` 创建时先落默认关，
 * 偏好由这一拍覆盖）。
 */
import { useCallback, useEffect } from 'react';
import type * as Monaco from '../../monaco/entry';
import * as monaco from '../../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import { applyNameColorPref, subscribeNameColorPref } from '../semantic-color-pref';
import {
  loadQuickSuggestionsPref,
  loadSuggestDelayPref,
  subscribeQuickSuggestionsPref,
  subscribeSuggestDelayPref,
} from '../suggest-pref';
import {
  applyFontSizePref,
  applyFontZoomPref,
  setFontZoomPref,
  subscribeFontSizePref,
} from '../font-size-pref';
import { findPrefPatch, inlineSuggestPatch, layoutPrefPatch, quickSuggestionsFor } from '../editor-options';
import {
  loadInlineCompletionPref,
  loadInlineMinShowDelayPref,
  subscribeInlineCompletionPref,
  subscribeInlineMinShowDelayPref,
} from '../inline-completion-pref';
import { subscribeLayoutPref } from '../layout-pref';
import { subscribeFindSeedPref } from '../find-pref'; // FIND-STATE-PERSIST-B
import {
  applyUiFontScalePref,
  editorDisplayFontPatch,
  editorDisplayOptionPatch,
  subscribeEditorDisplayPrefs,
} from '../editor-display-prefs';
import { isKojoTextLanguage } from './pane-helpers';
import { loadCodeLensPref } from '../code-lens-pref';
import type { MutableRef } from './pane-context';

/** 安装器：接一枚已创建好的编辑器，返回"只退这一批订阅"的清理函数 */
export type PreferencesInstaller = (ed: Monaco.editor.IStandaloneCodeEditor) => () => void;

export interface EditorPreferencesParams {
  /** 糖视图当前挂载的只读 model（显示偏好回调按"此刻屏幕上这份 model"取行数） */
  sugarModelRef: MutableRef<Monaco.editor.ITextModel | null>;
  /**
   * 预览在屏时重发阅读排版四件套（行高 / 折行模式 / 栏宽 / 留白）。
   * 归属 EditorPane（它要读字号偏好与糖 model），这里只按原顺序调它。
   */
  reapplySugarReadOptions: () => void;
}

/**
 * 返回偏好安装器。**不注册 effect**：调用点在 `useMonacoInstance` 的创建 effect 里，
 * 与原实现同一行、同一拍。
 */
export function useEditorPreferences(params: EditorPreferencesParams): PreferencesInstaller {
  const { sugarModelRef, reapplySugarReadOptions } = params;
  return useCallback(
    (ed: Monaco.editor.IStandaloneCodeEditor): (() => void) => {
      // 偏好落盘只在设置页，生效走 Monaco 配置项：开 ⇒ 逐 model 挂上着色器，关 ⇒ 卸掉，
      // 不用重开文件（standalone 的 DocumentSemanticTokensFeature 自己监听这条配置）。
      applyNameColorPref(ed);
      const nameColorUnsub = subscribeNameColorPref(() => applyNameColorPref(ed));
      // 字号/缩放偏好（A1）：设置页一改立即生效；反向（Monaco 原生 fontZoom 动作改了
      // EditorZoom 单例）也落盘，两条方向都收敛到 localStorage 这一份真源。
      const fontSizeUnsub = subscribeFontSizePref(() => {
        applyFontSizePref(ed);
        applyFontZoomPref(monaco.editor.EditorZoom);
        // 字号变了，阅读态行距（按字号算的倍数）跟着重发——只在预览在屏时
        reapplySugarReadOptions();
      });
      const fontZoomSync = monaco.editor.EditorZoom.onDidChangeZoomLevel((level) => setFontZoomPref(level));
      // 补全弹出延迟（QSUG-1）：同一份偏好既喂宿主观察者（每次排程现读），也喂 Monaco 的
      // quickSuggestionsDelay；设置页一改立即重发，不用重开文件。
      const suggestDelayUnsub = subscribeSuggestDelayPref(() => {
        ed.updateOptions({ quickSuggestionsDelay: loadSuggestDelayPref() });
      });
      // 快建议总开关（QSUG-2）：关 ⇒ 整条自动弹出停；只读 / 糖预览仍按各自的门强制 false。
      // 编辑器的 readOnly 选项是唯一可写态真源（糖预览在 setModel 时已置 true）。
      const quickSuggestionsUnsub = subscribeQuickSuggestionsPref(() => {
        let readOnly = false;
        try {
          readOnly = ed.getOption(monaco.editor.EditorOption.readOnly);
        } catch {
          readOnly = false;
        }
        ed.updateOptions({ quickSuggestions: quickSuggestionsFor(readOnly, loadQuickSuggestionsPref()) });
      });
      // 幽灵文本（IC 批）：三格里只有这两格进 Monaco 选项（总开关 + 停顿延迟），
      // 候选上限住在 provider 侧（它是宿主的截断点，不是 Monaco 的概念）。
      // 只读 / 派生视图这里同样强制关——与上面 `quickSuggestions` 那一拍同一条纪律，
      // 且这里是**选项**层面的关：Monaco 连一次请求都不发（"关掉 = 逐字节一致"的机制保证）。
      const inlineCompletionUnsub = subscribeInlineCompletionPref(() => {
        let readOnly = false;
        try {
          readOnly = ed.getOption(monaco.editor.EditorOption.readOnly);
        } catch {
          readOnly = false;
        }
        ed.updateOptions(
          inlineSuggestPatch(readOnly ? false : loadInlineCompletionPref(), loadInlineMinShowDelayPref()),
        );
      });
      const inlineMinDelayUnsub = subscribeInlineMinShowDelayPref(() => {
        let readOnly = false;
        try {
          readOnly = ed.getOption(monaco.editor.EditorOption.readOnly);
        } catch {
          readOnly = false;
        }
        ed.updateOptions(
          inlineSuggestPatch(readOnly ? false : loadInlineCompletionPref(), loadInlineMinShowDelayPref()),
        );
      });
      // 排版偏好（P2-16）：折行 / 多光标修饰键 / 列选择。与切文件路径同读一份偏好
      // （editor-options.ts 的 layoutPrefPatch）；这里只补发这三个键——补丁里没有
      // readOnly / quickSuggestions，所以订阅回调不必复刻切标签那层的 overrides。
      // 「跟随体量档」时按**此刻屏幕上那份文档**的行数取档位值（糖预览在屏上就算投影的
      // 行数，与挂预览那一拍同口径）：从强制关翻回跟随档，大文件当场回到 huge 档的关值。
      const layoutUnsub = subscribeLayoutPref(() => {
        const model = ed.getModel();
        ed.updateOptions(layoutPrefPatch(model ? model.getLineCount() : 0));
        // 预览在屏：阅读栏宽（bounded + 88 列）盖在偏好补发之后——用户显式改折行偏好，
        // 下一次挂预览仍按正文口径走，这里只保住"此刻这份投影"的稿纸栏宽。
        reapplySugarReadOptions();
      });
      // 查找词优先（FIND-STATE-PERSIST-B）：三档真源在 find-pref.ts，与 create / 切文件
      // 两条路径同读 editor-options.ts 的 findPrefPatch。补丁**恒带整组 find 字段**
      // （EditorFind.validate 对缺字段逐位回落内建缺省，只发一字会顶掉同组其余值——
      // 实测快照钉在 tests/find-pref.test.ts），这一拍不需要按行数取档（find 与体量正交）。
      const findSeedUnsub = subscribeFindSeedPref(() => {
        ed.updateOptions(findPrefPatch());
      });
      // 显示偏好（1020 编辑器体感批，C-1b 补缩略图三态与界面字号）：行高 / 空白符 / 缩略图 /
      // 行号 / 行内提示 / 字体族。只补发这几位——`formatOnType` 由方言判据管（`tierOverrides`），
      // 字体族与体量正交但同一条偏好轴，一起发。行数按**此刻屏幕上那份 model** 取（糖预览在屏上
      // 就算投影行数，与挂预览那一拍同口径）：缩略图这一位在 huge 档恒关，偏好翻不回它，
      // 与档位表同一把尺；「跟随」档那两条内容判据（`.kojo` 正文 / 预览投影）也按同一份 model 现算。
      const displayUnsub = subscribeEditorDisplayPrefs(() => {
        const model = ed.getModel();
        // 缩略图「跟随」档的上下文按**此刻屏幕上这份 model** 取（与挂/撤预览那两拍同口径）：
        // 糖投影 → preview，真 `.kojo` 文件 → kojoText；两者都不是才按体量档决定画不画。
        const sugarModel = sugarModelRef.current;
        ed.updateOptions({
          ...editorDisplayOptionPatch(model ? model.getLineCount() : 0, undefined, {
            preview: sugarModel !== null && model === sugarModel,
            kojoText: model ? isKojoTextLanguage(model.getLanguageId()) : false,
          }),
          ...editorDisplayFontPatch(),
        });
        // 界面字号缩放不进 Monaco（它是外壳的 CSS 变量）：偏好一改就把那几位落到根元素。
        // 本实例是常驻挂载点，另一处写入点（设置页）在 setter 里当场应用，两条路同一个真源。
        applyUiFontScalePref();
        // 预览在屏：设置页的 `lineHeight` 补发会把稿纸行距顶掉，按阅读口径盖回去
        reapplySugarReadOptions();
      });
      // 退订次序与接线次序逐字一致（组件卸载清账的第一段，见 use-monaco-instance）
      return () => {
        nameColorUnsub();
        fontSizeUnsub();
        fontZoomSync.dispose();
        suggestDelayUnsub();
        quickSuggestionsUnsub();
        inlineCompletionUnsub();
        inlineMinDelayUnsub();
        layoutUnsub();
        findSeedUnsub();
        displayUnsub();
      };
    },
    [sugarModelRef, reapplySugarReadOptions],
  );
}

/**
 * 「标注函数被谁调用」开关落地（B8，2026-10-16 行内注解批）。
 *
 * 偏好真源是 `code-lens-pref.ts` 的 localStorage（**默认关**，理由写在那份文件里），
 * 本 effect 只做一件事：把它写成 Monaco 的 `codeLens` 选项。
 * 这条腿必须在**选项**上而不是在 `resolve()` 里返回空数组——关掉时 Monaco 不再发请求，
 * 于是那份文档的整篇解析一次都不付（供给器没有可视区间，开着的代价是"每次停笔解析一遍"）。
 *
 * 翻开关为什么要听事件而不是自己再读一次偏好：Monaco 只在 `EditorOption.codeLens`
 * 变化时重算注解（取证 `codelensController.js` 的 `e.hasChanged(...) → _onModelChange()`），
 * 不推就是"作者关掉设置页回到编辑器，一条注解都没动"。壳层的设置页与本页读的都是同一把
 * localStorage，所以这里不存在两份状态——事件只是"去重算一次"的扳机（同 `editor.sugarView.set`）。
 *
 * **调用点必须留在挂载 effect 之后**：create 时先落 `CODE_LENS_DEFAULT`（默认关），
 * 这条 effect 再把偏好覆盖上去——提前到实例创建之前，`editorRef.current` 还是 null，
 * "上次开着"的偏好首个 commit 就丢了。
 */
export function useCodeLensPreference(
  editorRef: MutableRef<Monaco.editor.IStandaloneCodeEditor | null>,
  kernel: Kernel,
): void {
  useEffect(() => {
    const apply = (on: boolean): void => {
      editorRef.current?.updateOptions({ codeLens: on });
    };
    apply(loadCodeLensPref());
    const un = kernel.bus.on('editor.codeLens.set', ({ on }) => apply(on));
    return un;
  }, [editorRef, kernel]);
}
