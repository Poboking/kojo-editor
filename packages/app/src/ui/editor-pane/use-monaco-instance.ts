/**
 * Monaco 实例的**生命周期**（REF-FRONT-PERF，2026-10-20 从 EditorPane 挂载 effect 拆出）。
 *
 * 这里只做一件事：把一个编辑器的"生老病死"按**原来的那一拍**执行完——
 * create（含全部选项基线）→ boot 探针 → 多实例登记 → 全局 provider 接线 → 4 个编辑
 * 命令 → 偏好安装 → 焦点监听 → 面包屑安装 → 视图/光标/补全监听 → beforeunload；
 * 卸载时按**原来的清账顺序**逐段拆除（偏好 → 焦点 → 面包屑 → 实例监听 → provider →
 * 糖视图 → 定时器 → 最后 ed.dispose + model 池引用释放）。
 *
 * 时序不可动（与 create options 那条 `codeLens` 注释同一条理由：默认值与偏好覆盖
 * 不能依赖时序）：本 hook 只在组件里被调用一次，内部**只有一个** effect、依赖数组仍为空（`eslint-disable` 与拆前一致）。偏好的安装器由
 * `use-editor-preferences.ts` 给出，面包屑由 `use-breadcrumb.ts` 给出——它们的代码
 * 可独立阅读，但**调用点仍在这一条 effect 的原来那一行**，所以执行次序零变化。
 *
 * 模块作用域单例（`self.MonacoEnvironment`、语言注册、`editorModelPool`、登记簿、
 * `sharedSaveLock`）一律留在原处：本文件不复制第二份，也不重复注册语言。
 */
import { useEffect } from 'react';
import type * as Monaco from '../../monaco/entry';
import * as monaco from '../../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../../monaco/erb-language';
import { monacoThemeIdFor } from '../../monaco/theme';
import { subscribeFindState } from '../../monaco/find-state-sync'; // FIND-STATE-PERSIST
import { loadThemePref } from '../theme-pref';
import { CODE_LENS_DEFAULT } from '../code-lens-pref';
import { installSuggestContextTrigger } from '../../monaco/suggest-context-trigger';
import { loadQuickSuggestionsPref, loadSuggestDelayPref } from '../suggest-pref';
import { applyFontZoomPref, loadFontSizePref } from '../font-size-pref';
import {
  CJK_TYPING_BASELINE,
  FIND_BASELINE,
  findPrefPatch,
  layoutPrefPatch,
  quickSuggestionsFor,
} from '../editor-options';
import {
  applyUiFontScalePref,
  editorDisplayFontPatch,
  editorDisplayOptionPatch,
} from '../editor-display-prefs';
import { CODE_FONT_BASELINE } from '../code-font';
import {
  registerPane,
  setGlobalKernel,
  setPaneFocused,
  unregisterPane,
} from '../editor-pane-registry';
import {
  disposeGlobalProviders,
  ensureGlobalProviders,
} from '../editor-global-providers';
import { clearAllProblems } from '../problem-store';
import { setJumpProbe } from '../jump-to-state';
import { flushViewStates } from '../view-state-store';
import { editorModelPool } from '../editor-model-pool-instance';
import { perf } from '../../perf';
import { PREVIEW_WRITE_VETO } from './pane-helpers';
import type { EditorPaneRefs, MutableRef } from './pane-context';
import type { PreferencesInstaller } from './use-editor-preferences';

/** 首个编辑器实例创建只打一次 boot 探针（模块存活期内一次，与实例退场无关） */
let bootEditorMarked = false;

export interface MonacoInstanceParams {
  hostRef: MutableRef<HTMLDivElement | null>;
  kernel: Kernel;
  /** 组件持有的**同一批** ref 壳（不复制：provider 反查读的就是这一批） */
  refs: EditorPaneRefs;
  /** Ctrl+S 命令经 ref 读最新 save（编辑器只创建一次，save 闭包随 kernel 更新） */
  saveRef: MutableRef<() => Promise<boolean>>;
  /** 预览面写类动作的统一否决出口（F2 / Shift+Alt+F 两条命令用） */
  notifyPreviewWriteVeto: (message: string) => void;
  clearSugarView: () => void;
  persistEditorSlice: (ed: Monaco.editor.IStandaloneCodeEditor, path: string) => void;
  snapshotActiveView: () => void;
  publishCursor: () => void;
  /** A9 选区读数（面包屑的光标/model 监听搭同一条通道） */
  pushSelStatus: (force?: boolean) => void;
  onFocusedRef: MutableRef<(() => void) | undefined>;
  markerTimerRef: MutableRef<number | null>;
  autosaveTimerRef: MutableRef<number | null>;
  externalConflictRef: MutableRef<Set<string>>;
  autosaveFailedRef: MutableRef<Set<string>>;
  /** 偏好安装器（`useEditorPreferences` 的返回值；在 create 之后、原位置调用） */
  installPreferences: PreferencesInstaller;
  /** 面包屑安装器（`useBreadcrumb().install`；在焦点监听之后、原位置调用） */
  installBreadcrumb: (
    ed: Monaco.editor.IStandaloneCodeEditor,
    onCursorActivity: () => void,
  ) => () => void;
}

export function useMonacoInstance(params: MonacoInstanceParams): void {
  const {
    hostRef,
    kernel,
    refs,
    saveRef,
    notifyPreviewWriteVeto,
    clearSugarView,
    persistEditorSlice,
    snapshotActiveView,
    publishCursor,
    pushSelStatus,
    onFocusedRef,
    markerTimerRef,
    autosaveTimerRef,
    externalConflictRef,
    autosaveFailedRef,
    installPreferences,
    installBreadcrumb,
  } = params;
  const {
    editorRef,
    entriesRef,
    filePathRef,
    sugarModelRef,
    sugarOriginalModelRef,
    sugarLineMapRef,
    pendingActionsRef,
    actionSeqRef,
    crumbTreeCacheRef,
    viewStatesRef,
    prevPathRef,
  } = refs;

  // 编辑器实例（仅一次）；卸载时 dispose 全部 model
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 缩放在实例创建**之前**播种：EditorZoom 是全局单例，创建时算 fontInfo 就按它缩放
    applyFontZoomPref(monaco.editor.EditorZoom);
    // 界面字号缩放（C-1b）：外壳 CSS 变量的播种点，与 `applyFontZoomPref` 同一拍——
    // 本实例是常驻挂载点，偏好 setter 那边负责"改完当场见效"，这里负责"下次启动也认"。
    // 100%（缺省）时这一调用一位都不写，界面逐字等于样式表现值。
    applyUiFontScalePref();
    const ed = monaco.editor.create(host, {
      // 主题随偏好走（反馈 3）：模块顶层 `registerErbLanguage` 已定义三套，
      // 这里按当前 localStorage 偏好落初值，之后的切换由上面的 useThemePref effect 负责。
      theme: monacoThemeIdFor(loadThemePref()),
      language: ERB_LANGUAGE_ID,
      automaticLayout: true,
      // 用户反馈 7：原生右键菜单必须留在 light DOM。0.57 的 `useShadowDOM` 缺省 **true**，
      // 菜单会被塞进编辑器内的 open shadow root——document 级样式（context-menu.css 的玻璃
      // 面、主题 token、data-motion/data-glass 开关）一律进不去，观感无法统一。关掉它之后
      // 菜单仍是 Monaco 原生那一份（全部动作 + zh-cn NLS + 自带键盘导航），只是挂到编辑器
      // 容器的 light DOM 里；影响面仅限 context view（右键菜单 / 内联提示菜单），不碰编辑、
      // worker 与排版。实测见 2026-10-17 反馈批的浏览器冒烟记录（提交信息）。
      useShadowDOM: false,
      // 缩略图不在这里硬编码（C-1b）：三态偏好的判据只有一份，住在
      // `editor-display-prefs.ts` 的 `minimapEnabledFor`，由下面的显示偏好补丁发下来
      // （文本块模式：不逐字符渲染——口上文本为长行文，色块更干净也更省性能）。
      fontSize: loadFontSizePref(),
      lineNumbers: 'on',
      renderWhitespace: 'none',
      scrollBeyondLastLine: false,
      // 折行不在这里硬编码（P2-16）：走下面的排版偏好补丁（layoutPrefPatch），与切文件
      // 路径（applySizeTier → editorOptionsForLineCount）读同一份偏好；create 时屏幕上
      // 还没有文件，按 small 档取值（即此前的 'on'），第一个文件落档后按真实行数覆写。
      // 中文块回车的精确缩进层（ZH-D4）：`onEnterRules` 的正则只看得到原文，块头行尾带 `;`
      // 注释这类同步层判不了的形态靠 on-type provider 兜；Monaco 只在 `formatOnType` 为真时派发它。
      formatOnType: true,
      // 行上内联注解（B8）：**创建时就按默认关**——Monaco 这条选项的缺省是 `true`
      // （`common/config/editorOptions.js` 的 `EditorBooleanOption(23, 'codeLens', true)`），
      // 只靠下面那个偏好 effect 事后覆盖，等于让"默认关"依赖一次 effect 的时序；
      // 真值仍只有一处（`CODE_LENS_DEFAULT`），这里不另写 `false`。
      codeLens: CODE_LENS_DEFAULT,
      // 编辑器体感（ui-polish）：平滑滚动 / 平滑光标 / 整行高亮 / 上下留白
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      padding: { top: 6, bottom: 16 },
      scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
      // 编程字体（单一真源）：**只走 create 路径**，不进体量降级集——字体与体量两轴正交，
      // updateOptions 只覆写发过去的键，创建时钉一次就贯穿切文件
      ...CODE_FONT_BASELINE,
      // 显示偏好（1020 编辑器体感批）：行高 / 空白符 / 缩略图 / 行号 / 行内提示从设置页来，
      // **缺省值就是上面这几行硬编码的那一份**（editor-display-prefs.ts 的缺省），
      // 没动过设置的作者今天逐字不变。字体族走同一条 create 路径（覆盖上面那条基线栈）。
      ...editorDisplayOptionPatch(0),
      ...editorDisplayFontPatch(),
      // 中文打字噪声 / 选词基线（A2+A3）：与切文件降级集同源（editor-options.ts）
      ...CJK_TYPING_BASELINE,
      // 快建议总开关与延迟同源设置页；只读 / 预览的关闭由切文件与糖视图两处 updateOptions 覆盖
      quickSuggestions: quickSuggestionsFor(false, loadQuickSuggestionsPref()),
      quickSuggestionsDelay: loadSuggestDelayPref(),
      // find 体验基线（A7）：create 与切文件两条路径都要带上，吞一条就是档位漂移
      ...FIND_BASELINE,
      // 排版偏好（P2-16）：折行三选一 + 多光标修饰键 + 列选择。与切文件路径同读一份
      // 偏好（editor-options.ts 的 layoutPrefPatch）——没有文件时按 small 档取值，
      // 强制开 / 强制关同样在这一格生效。
      ...layoutPrefPatch(),
      // 查找词优先（FIND-STATE-PERSIST-B）：叠在基线之后，三档真源在 find-pref.ts，
      // 与切文件路径（editorOptionsForLineCount）读同一份补丁。
      ...findPrefPatch(),
    });
    editorRef.current = ed;
    if (!bootEditorMarked) {
      bootEditorMarked = true;
      perf.bootMark('boot.editorInteractive', undefined, '自导航起点 ms；Monaco 实例创建完成（近似：已挂载可输入）');
    }
    // SPLIT-1：本实例登记进模块登记簿——交出去的是组件持有的**同一批 ref 壳**（复制 ref 就是
    // 让 provider 读影子）。全局 provider 只注册一份（ensureGlobalProviders 内部有门），各
    // provider 的 resolve 经 `owningPaneOf(model)` 找归属实例再读它的 ref。
    const paneId = registerPane({
      editorRef,
      entriesRef,
      filePathRef,
      sugarModelRef,
      sugarLineMapRef,
      pendingActionsRef,
      actionSeqRef,
      crumbTreeCacheRef,
    });
    setGlobalKernel(kernel); // 单 kernel 应用：全局 provider 的 kernel 来源随最新实例刷新
    ensureGlobalProviders();
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current();
    });
    // A7「在选定内容中查找」：选中即把文本灌进 find widget 并把搜索域钉在选区。
    // 实测（vendor 取证）：action `editor.actions.findWithArgs` 由 findController 的
    // `StartFindWithArgsAction` 注册（standalone 包含），args 形态
    // `{ searchString, findInSelection, ... }`，`findInSelection: true` 走 `updateSearchScope`
    // 把当前非空选区变 searchScope。键位 Ctrl+Alt+F：核过 keybindings.ts 无占用
    // （Ctrl+Shift+F 是全库检索、Ctrl+F/Ctrl+H 是 Monaco 内建，均避让）。
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      const model = ed.getModel();
      const selection = ed.getSelection();
      if (!model || !selection || selection.isEmpty()) return;
      const action = ed.getAction('editor.actions.findWithArgs');
      if (!action) return;
      void action.run({ searchString: model.getValueInRange(selection), findInSelection: true });
    });
    /**
     * VETO-1：预览面上 F2 改名 / Shift+Alt+F 格式化同样是**写类**动作——派生文本上没有
     * 可落点，Monaco 内建动作在糖 model 上要么被 provider 静默拒绝、要么什么都不发生。
     * 键位表不碰（`keybindings.ts` 明说不劫持 Monaco 内建键），只在本实例 `addCommand`
     * 拦一拍：**预览面** ⇒ 与两条总线否决同一条带「切回原文」按钮的通知；
     * **原文面** ⇒ 原样交回 Monaco 内建动作，零新增通知（同一条命令逐字照旧）。
     */
    ed.addCommand(monaco.KeyCode.F2, () => {
      if (sugarModelRef.current) {
        notifyPreviewWriteVeto(PREVIEW_WRITE_VETO);
        return;
      }
      void ed.getAction('editor.action.rename')?.run();
    });
    ed.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      if (sugarModelRef.current) {
        notifyPreviewWriteVeto(PREVIEW_WRITE_VETO);
        return;
      }
      void ed.getAction('editor.action.formatDocument')?.run();
    });
    // 偏好订阅：字体 / 缩放 / 快建议 / 排版 / 显示（安装器在 use-editor-preferences.ts，
    // 接线/退订次序与拆前逐字一致；codeLens 那一条是独立 effect，仍在挂载 effect 之后）
    const disposePreferences = installPreferences(ed);
    // 焦点上抛（SPLIT-1）：编辑器聚焦 ⇒ 宿主把焦点组切到本组（点哪组哪组成为焦点组）
    const focusDisposer = ed.onDidFocusEditorText(() => {
      setPaneFocused(paneId); // 模块级焦点随编辑器焦点走（跳转探针读"最后聚焦的实例"）
      onFocusedRef.current?.();
    });
    // 面包屑：刷新入口 + 光标/model 两条监听（判据与缓存全在 use-breadcrumb.ts）
    const disposeBreadcrumb = installBreadcrumb(ed, pushSelStatus);
    // 视图状态：光标/滚动驱动快照（store 内防抖合并落盘）；页面卸载前 flush 一次
    const viewCurSub = ed.onDidChangeCursorPosition(snapshotActiveView);
    const viewScrSub = ed.onDidScrollChange(snapshotActiveView);
    // FIND-STATE-PERSIST 写存驱动：改查找词 / 拨三个开关也算视图状态变更（同一条防抖通道）。
    // 补丁未生效 ⇒ subscribeFindState 返回 null，不挂不抛，与读回点同一口径。
    const viewFindSub = subscribeFindState(ed, snapshotActiveView);
    // C1 反向下行批：光标位点广播（面板跟着光标走）。选区也要听——拖动选择区改变的是
    // 活动端（position），Monaco 两条事件都可能先到，重复的那次由广播器去重吞掉（零成本）。
    const cursorSub = ed.onDidChangeCursorPosition(() => publishCursor());
    const cursorSelSub = ed.onDidChangeCursorSelection(() => publishCursor());
    // 上下文主动触发补全（1017）：QSUG-1 打开全局快建议后，本观察者只补一种缺口——
    // 中文词法下 Monaco 不会把 CJK 当"词"自动触发的那一拍；位置判据与提供者同源。
    // **每编辑器实例一枚**（SPLIT1 分屏互不串），随卸载释放。
    // 延迟偏好**每次排程现读**（SUGGEST-2B）：设置页改完下一次击键即生效，不需要重开文件；
    // 卸载由 `contextSuggestSub.dispose()` 一并清掉未响的那一拍定时器。
    const contextSuggestSub = installSuggestContextTrigger(ed, {
      getPath: () => filePathRef.current,
      isDerivedView: () => sugarModelRef.current !== null,
      getDebounceMs: () => loadSuggestDelayPref(),
      getQuickSuggestionsEnabled: () => loadQuickSuggestionsPref(),
    });
    const flushViewOnUnload = (): void => flushViewStates();
    window.addEventListener('beforeunload', flushViewOnUnload);
    return () => {
      disposePreferences();
      focusDisposer.dispose();
      disposeBreadcrumb();
      viewCurSub.dispose();
      viewScrSub.dispose();
      viewFindSub?.dispose();
      cursorSub.dispose();
      cursorSelSub.dispose();
      contextSuggestSub.dispose();
      window.removeEventListener('beforeunload', flushViewOnUnload);
      // SPLIT-1：本实例退册；全局 provider 属于"活实例集合"，最后一个实例退场才拆
      // （unregisterPane 只退册并回答"是不是最后一个"；拆毁顺序不许动：provider → 跳转探针
      //  → 问题汇总，且整段都在 clearSugarView / ed.dispose 之前）
      if (unregisterPane(paneId)) {
        disposeGlobalProviders();
        setJumpProbe(null);
        clearAllProblems(); // 清掉全部文件的问题，防幽灵诊断残留
      }
      clearSugarView();
      // 兜底：糖 model 若因"无处可还原"被保留挂载，随卸载一并回收（编辑器即将 dispose）
      sugarModelRef.current?.dispose();
      sugarModelRef.current = null;
      sugarOriginalModelRef.current = null;
      if (markerTimerRef.current !== null) window.clearTimeout(markerTimerRef.current);
      markerTimerRef.current = null;
      if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
      externalConflictRef.current.clear();
      autosaveFailedRef.current.clear();
      // 卸载 = 会话终点：补一次最后快照（在途防抖窗口内的改动）再同步 flush
      if (prevPathRef.current) persistEditorSlice(ed, prevPathRef.current);
      flushViewStates();
      ed.dispose();
      editorRef.current = null;
      for (const [path, entry] of [...entriesRef.current]) {
        entry.listener.dispose();
        editorModelPool.release(path);
      }
      entriesRef.current.clear();
      viewStatesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
