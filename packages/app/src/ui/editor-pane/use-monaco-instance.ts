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
// 1023 那一版在这里 import 过 kojo1 的语言常量拼语言族 when；ERB-PARITY G8 起判据全部
// 走 descriptor（`languageIdsForContextFace`），本文件不再认识 kojo1 这个名字。
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
import { PREVIEW_WRITE_VETO, baseNameOf } from './pane-helpers';
import type { EditorPaneRefs, MutableRef } from './pane-context';
import type { PreferencesInstaller } from './use-editor-preferences';
// 1023 右键覆盖面批（WP1.1 / 1.3 / 1.4）：编辑区「应用动作」表是纯数据 + 可用性判定，
// 本文件只做接线（现取上下文 → addAction → 派发时按当下重算的表判可用性）。
// 动作表刻意不含 React / Monaco import，单测直接打 `buildEditorContextActions`。
import {
  buildEditorContextActions,
  findEditorContextAction,
  languageFamilyWhen,
  listAllEditorContextActions,
  monacoActionIdOf,
  EDITOR_CONTEXT_GROUP_MENU_ID,
  type EditorContextActionContext,
} from './editor-context-actions';
// ERB-PARITY G8：右键「语言族」项的判据从 descriptor 派生（此前是一枚手写语言 id 名单，
// 把 2.0 漏在外面且不随 descriptor 扩展）。宿主这里**不认识任何具体语言名**。
import {
  languageIdsForContextFace,
  type EditorContextFaceId,
} from '../../monaco/language-registry';
import { canRunContextMenuCommand, runContextMenuCommand } from '../context-menu-model';
import { SHOW_FILE_HISTORY_COMMAND_ID } from '../file-history';
// C 批：文档内书签的装饰层（安装器形态照 use-breadcrumb；判据全在 ../bookmarks 纯逻辑）
import { installBookmarkDecorations } from './use-bookmarks';
// VIS-63（1026 编辑器体感 E1）：补全 / hover 弹层的宿主侧样式。住在**本文件**而不是
// EditorPane.tsx——这一格是"编辑器实例存在 ⇒ 弹层样式在册"的最小充分条件，且本文件
// 独占、不与 chrome 那条热文件抢行（`css-slices-wired.test.ts` 只认真 import）。
import '../editor-widget.css';
import { revealInExplorer, revealFailureText } from '../reveal-explorer';
import { relativeToRoot } from '../file-tree-ops';
import { isInWorkspaceFile } from '../file-area';
import { isErbLike } from '../lift-preview';
// 「在资源管理器中显示」只有桌面壳才有（浏览器壳里这条动作整项不注册——铁律 4）
import { isTauri } from '../../bridge/invoke';
// K2 batch-3：2.0 诊断接线（flag 关时安装器立即返回空操作，连监听都不挂）。
// 住在本实例 effect 里而不是 EditorPane：事件源（ed / filePathRef / sugarModelRef）都在
// 这一拍之后才齐，且退场次序本来就由本 hook 的清账段钉死。
import {
  charNoForProjectPath,
  createKojo2CompileCache,
  installKojo2ProblemWiring,
  kojo2IdentityCompileExpression,
  pathOfKojo2Model,
} from '../kojo2-problem-wiring';
// K2 batch-5（K2-EDITOR-MOUNT ①）：预览面板的入口与宿主桥。编译成品由上面那条诊断接线
// 写进**同一个**缓存，预览只读——一次编译两处消费，绝不二次编译。
import { createKojo2PreviewEntry } from '../kojo2-preview-entry';
import { publishKojo2PreviewEntry } from '../kojo2-preview-host';
// LAU-D1b：方言解析的宿主入口（识别链 + 工作区覆盖 + 文件断言 → 绑定）。
import { resolveDocumentDialect } from '../dialect-binding';
// K2 batch-7：展开视图（模板/池/随机）的编译成品来源——只登记这一实例的缓存读取器，
// hover/definition 按路径问，不二次编译（flag 关 ⇒ 零注册）。B3 收口后登记表住语言面库，
// 这里直接引叶子（宿主那枚指针壳 `ui/kojo2-expand-compile.ts` 同批删除）。
import { registerKojo2ExpandCompileSource } from '@kojo/kojo-lang/expand-compile';
import { isKojo2DiagnosticsPath } from '../kojo2-diagnostics-gate';
import { revealLocationOf } from '../../monaco/reveal-position';
// K2 batch-4 + 入口 A（2026-10-24）：2.0 语言服务的 adapter 来源。**不再**静态引用
// 具体 adapter——按当前项目从宿主组合根（bootstrap）的登记簿现取（见该处头注）。
// B3c（2026-10-28）起补全 / 悬停的 adapter 由插件经 `@kojo/kojo-lang/adapter-source`
// 登记表**在请求时现取**，宿主不再向语言层注入；这里这枚 getter 只剩签名帮助还在吃。
import { kojo2AdapterForProject, kojo2SurfaceForProject } from '../../bootstrap';
import type { Notify } from '../NotificationCenter';

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
  /** 壳层通知中心（2.0 诊断失败时发一条 error toast；缺省 = 只进问题面板 + console） */
  notify: Notify;
  /**
   * 脏判定（1023 右键覆盖面批）：与组件里那份 `computeDirty` **同一个函数**
   * （model 版本号 ≠ 已保存基线），不在这里另立第二套判据——右键菜单的
   * 「重新加载磁盘版本」与状态栏的未保存点必须同时亮/灭。
   */
  computeDirty: (path: string) => boolean;
  /** 「重新加载磁盘版本」的落地通道（组件里那份 reloadFromDisk 的恒稳引用） */
  reloadFromDiskRef: MutableRef<((path: string) => Promise<void>) | null>;
  /** 「申请写权限…」的落地通道（组件既有的 `onReauth`：通知中心「去授权」同一入口） */
  requestWrite: () => void;
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
    notify,
    computeDirty,
    reloadFromDiskRef,
    requestWrite,
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
      // VIS-62：书签的 **glyph margin 槽位**。monaco-editor 这一档的缺省是 **false**
      // （`monaco.d.ts:3580`「Defaults to true in vscode and to false in monaco-editor」），
      // 而 C 批的装饰层只写了 `glyphMarginClassName` ⇒ 角标与 `glyphMarginHoverMessage`
      // 从来没画过（`bookmark-gutter.css` 那一族是死样式）。槽位与体量两轴正交，真源在
      // 档位表（`editor-options.ts` 的三档同值 + 注释），这一格只是 create 那一路的对齐
      // ——与 `formatOnType: true` 同一条纪律：创建时就对，不等第一次落档补写。
      glyphMargin: true,
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
      // 光标呼吸（C3）：与 small 档同值（`editor-options.ts` 的 TIER_SMALL）。create 到
      // 第一个文件落档之间有一拍，这一格不写就是那半秒里的硬切闪；档位表落定后同值覆盖。
      cursorBlinking: 'smooth',
      renderLineHighlight: 'all',
      padding: { top: 6, bottom: 16 },
      // 滚动条 overlay 化（C4）：滑轨 12 → 10px、滑块 8px，两条都窄一档——12px 的常驻滑轨
      // 是"网页感"最重的一处。真正的"静止半透明 / 悬停显形"在 `motion-editor.css`（Monaco 自己
      // 切 `.scrollbar.visible/.invisible`，样式侧只补 opacity 过渡，不参与显隐判定）
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        verticalSliderSize: 8,
        horizontalSliderSize: 8,
      },
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
    // K2 batch-4：Kojo 2.0 语言服务（`# 机` 事件目录）要的 adapter 由此注入——它**不是**
    // `game.adapter` 槽位上那枚 v1 契约对象，槽位里没有 2.0 的 `eventCatalog` / `domainSymbols`。
    // 全局 provider 只注册一次，getter 每次请求现问，项目开闭不必重装。
    // 入口 A（2026-10-24）：按**当前项目**的 v1 `adapterId` 从组合根登记簿现取。此前写死
    // `ERATW_GAME_ADAPTER`——打开 eraFL 工程时 2.0 面拿到的是 eraTW 的事实（不报错、只是错，
    // 比没做更危险）。取不到 ⇒ `null`（零候选、不抛）：错误事实与"没有事实"从此分开。
    ensureGlobalProviders({
      kojo2Adapter: () => kojo2AdapterForProject(kernel.project.current()),
      // B3 收口最后一格：文档级诊断的两面（adapter + backend）也走同一套登记簿。
      // 插件（`@kojo/plugin-kojo-lang` 的诊断供方）在**请求时**按文件路径问一次；这里只做
      // 组合根的组合：按当前项目取两面、按 `charaIndex[].kojoDir` 最长前缀推文件级角色号。
      // 取不到任一 ⇒ `null`（插件抛"没有 2.0 诊断面"→ 问题面板 + toast，绝不借别家事实）。
      kojo2Surface: (filePath) => {
        const project = kernel.project.current();
        const charNo = charNoForProjectPath(project, filePath);
        return kojo2SurfaceForProject(project, {
          compileExpression: kojo2IdentityCompileExpression,
          ...(charNo !== undefined && charNo.length > 0 ? { charNo } : {}),
        });
      },
    });
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
    // 书签装饰（C 批）：路径与派生面判据都取本实例持有的 ref 壳，与面包屑同一拍安装。
    // 换标签 / 挂撒糖预览 / 销毁三条边界由安装器内部的监听与卸载函数兜住。
    const disposeBookmarks = installBookmarkDecorations(ed, {
      getPath: () => filePathRef.current,
      isDerivedView: () => sugarModelRef.current !== null,
    });
    /* ---------------- 右键「应用动作」（1023 覆盖面批 · WP1.1 / 1.3 / 1.4） ----------------
     * 语义住在 `editor-pane/editor-context-actions.ts`（纯函数、可单测），本段只做三件事：
     *   ① 现取上下文（只读 / 预览面 / 脏 / 选区 / 语言 / 通道）；
     *   ② 全量动作换成一枚枚 `ed.addAction`（注册**一次**，Monaco 每次开菜单读当前 when）；
     *   ③ 派发时按**当下一拍**重算的表判可用性——不可用就把原因说出来（铁律 4）。
     *
     * 为什么可用性不在注册时判：`addAction({ precondition })` 只能表达上下文键
     * （语言 / 只读 / 选区），**不支持"灰着 + 说原因"**——为假就是整项不出现。
     * 本批要的恰恰是"能点、点了就知道为什么不行"，所以 enable/disable 一律留给派发时；
     * 注册时只写**静态**的 when（语言族 / 只读面）——那是"这一项跟这份文件无关"，
     * 与"此刻暂时不可用"是两件事（公共规程：没话说 ≠ 按不下）。
     */
    /**
     * 语言族（ERB-PARITY G8）：**从 descriptor 派生，不再手写名单**。
     *
     * 旧写法是 `[ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]` 一枚常量，两处毛病：① 2.0 漏在外面
     * （`.kojo` 里"快速修复 / 一键修复 / 看这一行的状态"三项根本不出现）；② 宿主加一门
     * 语言要改这里，与"新增语言 = 加一枚 descriptor"的纪律相反。
     *
     * 现在每一项各问各的能力声明（`LanguageDescriptor.contextFaces`），拼成 Monaco 的
     * `editorLangId == …`；`kojoFamily`（派发时那一位）取三项的并集——三项都由同一批
     * "口上方言"语言声明，所以并集与逐项各判在今天是同一批语言；未来若某门语言只声明
     * 其中一项，菜单里也只出现那一项（注册面按项判），派发面那一位仅作粗门。
     */
    const whenOfFace = (face: EditorContextFaceId): string =>
      languageFamilyWhen(languageIdsForContextFace(face));
    const DIALECT_FACE_IDS: readonly EditorContextFaceId[] = ['quick-fix', 'fix-all', 'jump-to-state'];
    const KOJO_FAMILY_LANGUAGE_IDS: ReadonlySet<string> = new Set(
      DIALECT_FACE_IDS.flatMap((face) => [...languageIdsForContextFace(face)]),
    );
    /** 剪贴板**读**能力是会话级事实：没有就没有，右键那一刻再问也变不出来 */
    const clipboardReadable = (): boolean =>
      typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

    /** 宿主命令通道（全部保存 / 一键修复 / 跳转状态 / 切预览 / 文件历史都走既有的那条腿） */
    const runHostCommand = (id: string): void => {
      if (runContextMenuCommand(id)) return;
      notify({ kind: 'info', message: '这个动作当前不可用（命令通道还没就绪）。' });
    };
    /** Monaco 内建动作：动作缺席 = 这门语言没这能力（明说，不静默） */
    const runEditorAction = (id: string): void => {
      const action = ed.getAction(id);
      if (action === null) {
        notify({ kind: 'info', message: '当前文件类型不支持这个动作。' });
        return;
      }
      void action.run();
    };
    /** 复制到剪贴板 + 一句回执（照 tabs-bar / FileTree 既有口径） */
    const copyToClipboard = (text: string, done: string): void => {
      const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clip === undefined) {
        notify({ kind: 'error', message: '复制失败：当前环境没有可用的剪贴板' });
        return;
      }
      void clip.writeText(text).then(
        () => notify({ kind: 'info', message: done }),
        () => notify({ kind: 'error', message: '复制失败：剪贴板不可用' }),
      );
    };

    /** 当下的应用动作上下文（每次派发现取：路径 / 只读 / 预览面 / 脏 / 选区 / 语言都是活读数） */
    const editorContextOf = (): EditorContextActionContext => {
      const path = filePathRef.current;
      const model = ed.getModel();
      const readOnly = ed.getOption(monaco.editor.EditorOption.readOnly) === true;
      const sugarPreview = sugarModelRef.current !== null;
      // 糖预览的可用门与 `EditorPane.applySugarView` **等价**（不是第二份判据）：
      // 那份门 = 方言 ∧ 不在工作区 ∧ 未解锁；而"游戏目录里未解锁的方言文件"正是
      // 编辑器只读面（`erbReadOnlyGate` 同一个表达式）⇒ `readOnly` 一位就够。
      // 这样本 hook 不必把 `unlockedPathsRef` 再搬进来一份。
      const canToggleSugar = isErbLike(path) && !isInWorkspaceFile(kernel, path) && readOnly;
      return {
        hasFile: path !== '' && model !== null,
        readOnly,
        sugarPreview,
        dirty: path !== '' && computeDirty(path),
        hasSelection: ed.getSelection()?.isEmpty() === false,
        kojoFamily: model !== null && KOJO_FAMILY_LANGUAGE_IDS.has(model.getLanguageId()),
        canToggleSugar,
        canReveal: isTauri(),
        canFileHistory: canRunContextMenuCommand(SHOW_FILE_HISTORY_COMMAND_ID),
        canClipboardCompare: clipboardReadable(),
        // 通道恒在（`onReauth` 是组件的必填 prop），所以这一位表达的是**此刻该不该
        // 给这条出路**：只读面（含预览面——根因可能是目录本来没授权）才出现
        canRequestWrite: readOnly,
        runSave: () => {
          void saveRef.current();
        },
        runSaveAll: () => runHostCommand('workbench.saveAll'),
        runFormatDocument: () => runEditorAction('editor.action.formatDocument'),
        runFormatSelection: () => runEditorAction('editor.action.formatSelection'),
        runQuickFix: () => runEditorAction('editor.action.quickFix'),
        runFixAll: () => runHostCommand('workbench.fixAll'),
        runFindReferences: () => runEditorAction('editor.action.goToReferences'),
        runRename: () => runEditorAction('editor.action.rename'),
        runJumpToState: () => runHostCommand('workbench.jumpToState'),
        runToggleSugar: () => runHostCommand('workbench.toggleSugarView'),
        // 历史版本走**已注册的命令**（`when: activeFile`），不在这里重写"开哪份文件的历史"
        runFileHistory: () => runHostCommand(SHOW_FILE_HISTORY_COMMAND_ID),
        runCopyPath: () => copyToClipboard(path, '已复制完整路径'),
        // 没有项目（还没打开项目）就没有"相对谁"——照 FileTree 的老口径退回完整路径，
        // 拷一个半截路径给出去只会误导收到的人
        runCopyRelPath: () => {
          const project = kernel.project.current();
          copyToClipboard(
            project === null ? path : relativeToRoot(path, project.rootDir),
            '已复制相对路径',
          );
        },
        runReveal: () => {
          void revealInExplorer(path).catch((error: unknown) => {
            notify({ kind: 'error', message: revealFailureText(error) });
          });
        },
        runReloadFromDisk: () => {
          void reloadFromDiskRef.current?.(path);
        },
        /**
         * 与剪贴板比较：两侧都给**内联文本**（左 = 此刻编辑器里的内容，右 = 剪贴板），
         * 走既有 `ui.diffView.open` 意图 —— 不新造 diff、不读盘（读盘会拿旧字节比新缓冲）。
         * 剪贴板读取需要系统授权：拒了就说一句人话，不静默。
         */
        runCompareClipboard: () => {
          const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (clip === undefined) return; // 没有读通道时这一项本来就进不了表
          void clip.readText().then(
            (text) => {
              kernel.bus.emit('ui.diffView.open', {
                title: `与剪贴板比较：${baseNameOf(path)}`,
                original: { label: `编辑器内容 · ${baseNameOf(path)}`, text: model?.getValue() ?? '' },
                modified: { label: '剪贴板', text },
                source: '编辑器右键',
              });
            },
            () =>
              notify({
                kind: 'error',
                message: '读不到剪贴板内容（系统可能未授权）——先复制一段文本再试。',
              }),
          );
        },
        runRequestWrite: () => requestWrite(),
      };
    };

    /**
     * 静态 when 表（注册面）：只写 Monaco 上下文键**能表达**的那几项。
     * `editorReadOnly` / `editorLangId` 都是 Monaco 自己维护的键（预览面也是只读 ⇒ 同样在场）。
     */
    const CONTEXT_ACTION_WHEN: Readonly<Record<string, string>> = {
      'quick-fix': whenOfFace('quick-fix'),
      'jump-to-state': whenOfFace('jump-to-state'),
      'fix-all': whenOfFace('fix-all'),
      // 切预览只对"游戏目录、未解锁的方言文件"有意义（那份门里的"只读面"这一位）。
      // 语言族按 `toggle-sugar` 那一格声明判：预览面挂着的是**投影 model**（语言 = kojo1），
      // 只认原文语言的话，恰恰在最需要"切回源码"的时候这一项会消失。
      // 2.0（`.kojo`）**不声明**这一格：它没有 v1 糖视图投影面，声明了只会长出一项按下去
      // 只能回"当前不可用"的菜单项。
      'toggle-sugar': `${whenOfFace('toggle-sugar')} && editorReadOnly`,
      'request-write': 'editorReadOnly',
    };
    /**
     * 注册（一次性）：`kojo.ctx.<id>` —— **不占** Monaco 的 `editor.action.*` 命名空间。
     * 菜单项是全局注册（`MenuRegistry` / `CommandsRegistry`），`ed.dispose()` 不管它们，
     * 故句柄必须收好、退场逐个 dispose（否则多实例退场后留下指向死编辑器的菜单项）。
     */
    const contextActionDisposables: Monaco.IDisposable[] = [];
    for (const action of listAllEditorContextActions()) {
      // 桌面壳才有「在资源管理器中显示」：浏览器壳里**整项不注册**（不是灰着）
      if (action.id === 'reveal' && !isTauri()) continue;
      const when = CONTEXT_ACTION_WHEN[action.id];
      contextActionDisposables.push(
        ed.addAction({
          id: monacoActionIdOf(action.id),
          label: action.label,
          ...(when === undefined ? {} : { precondition: when }),
          contextMenuGroupId: EDITOR_CONTEXT_GROUP_MENU_ID[action.group],
          contextMenuOrder: action.order,
          run: () => {
            // 菜单是**注册那一刻**的全量清单，可用性是**点下去那一刻**的事实：
            // 卸载/换文件/进预览都可能在这两者之间发生，所以这里现建一次表。
            const found = findEditorContextAction(buildEditorContextActions(editorContextOf()), action.id);
            if (found === undefined) {
              notify({ kind: 'info', message: '这一项在当前上下文不适用，没有执行。' });
              return;
            }
            if (!found.enabled) {
              notify({ kind: 'info', message: found.disabledReason ?? '当前不可用。' });
              return;
            }
            found.run();
          },
        }),
      );
    }
    /**
     * WP1.6 右键位置语义（"点在哪儿，动作就作用在哪儿"）：
     * - 右键落在**非空选区内** ⇒ 一个字节都不动（清选区 = 把作者刚选好要处理的那块弄丢）；
     * - 右键落在正文 / 行尾留白之外（滚动条、浮层控件里的输入框…）⇒ 不动光标；
     * - 其余 ⇒ 光标落到右键处，随后的格式化选区 / 重命名 / 快速修复就作用在这一行。
     *
     * Monaco 的 contextmenu 贡献内部有同一条规则（vendor：`contextmenu.js` 的
     * `_onContextMenu` 逐条比 `selections.containsPosition`），这里**再钉一次**的理由是：
     * 那条规则挂在该贡献"菜单开着"的分支里，而本批的落地动作是我们自己的右键项——
     * 语义不该依赖另一个贡献的分支条件。
     */
    const contextMenuPositionSub = ed.onContextMenu((e) => {
      const target = e.target;
      // 只处理"点在正文里"的两类目标（与 Monaco contextmenu 贡献同一分组）：
      // 滚动条 / 浮层控件（查找框等）/ 注入文本的右键要的是它们自己的菜单，**不动光标**
      if (
        target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT &&
        target.type !== monaco.editor.MouseTargetType.CONTENT_EMPTY
      ) {
        return;
      }
      const position = target.position;
      const selection = ed.getSelection();
      if (selection !== null && !selection.isEmpty() && selection.containsPosition(position)) return;
      ed.setPosition(position);
    });
    /**
     * Kojo 2.0 预览面板（K2-EDITOR-MOUNT ①）：入口在这一拍建，**编译成品不在这里算**。
     *
     * - `compile` 只读 {@link kojo2CompileCache}：那里面装的就是下面诊断接线那次 core 编译
     *   的产物 + 同源 source map（一次编译两处消费；预览二次编译会让两份结果不同源）；
     * - `onJumpToSource` 走既有导航通道 `editor.revealLocation`（App 开文件 / 定位），
     *   与问题面板、转到定义同一条腿，不新造第二套跳转；
     * - flag 关 ⇒ `createKojo2PreviewEntry` 返回 `null`：下面零监听、零桥、零面板。
     */
    const kojo2CompileCache = createKojo2CompileCache();
    const kojo2Preview = createKojo2PreviewEntry({
      compile: (filePath) => kojo2CompileCache.getLastCompile(filePath),
      onJumpToSource: (filePath, line, column) => {
        kernel.bus.emit(
          'editor.revealLocation',
          revealLocationOf({ path: filePath, line, column }, '编译预览'),
        );
      },
    });
    // 宿主桥：壳层底部面板用 `useSyncExternalStore` 读它（`null` 入口 ⇒ 只画一句 idle）
    const unpublishKojo2Preview = publishKojo2PreviewEntry(kojo2Preview);
    // 展开视图的成品来源（K2 batch-7）：与预览读同一份缓存；flag 关（入口 null）⇒ 零注册。
    const unregisterKojo2ExpandCompile =
      kojo2Preview === null
        ? (() => undefined)
        : registerKojo2ExpandCompileSource((filePath) => kojo2CompileCache.getLastCompile(filePath));
    // 光标同步：只订"光标位置变化"一格（面板按行同步，同列变化不通知）
    const disposeKojo2PreviewCursor = kojo2Preview?.attachCursor(ed) ?? (() => undefined);
    /**
     * 切标签：目标不是 `.kojo2`（或没有 model）⇒ **立即**撤面板，不等下一轮诊断。
     *
     * 路径判据与诊断接线同一条（`pathOfKojo2Model` + `isKojo2DiagnosticsPath`）——
     * `onDidChangeModel` 那一拍 `filePathRef` 可能还是旧标签的值，所以以 model URI 为准。
     * **糖投影 model 是派生物**（`inmemory://sugar/...`，不是文件）：跳过这一拍，别把它的
     * 伪路径当文件塞给预览；糖视图的开关会让诊断那一条腿让路（派生物没有可诊断的语义），
     * 预览随 `onCompile(null)` 一起撤——与波浪线同一个真相，回来时一起回来。
     */
    const kojo2PreviewModelSub =
      kojo2Preview === null
        ? null
        : ed.onDidChangeModel(() => {
            const model = ed.getModel();
            if (model === null || sugarModelRef.current === model) return;
            const next = pathOfKojo2Model(model, filePathRef.current);
            kojo2Preview.setFile(next.length > 0 && isKojo2DiagnosticsPath(next) ? next : null);
          });
    // Kojo 2.0 诊断（K2 batch-3）：内容变化 / 活动 model 切换两条监听 + 问题面板上账。
    // flag 关 ⇒ 安装器立即返回空操作（不挂监听、不碰 problem-store），v1 行为逐字不变。
    const disposeKojo2Problems = installKojo2ProblemWiring({
      editor: ed,
      kernel,
      filePathRef,
      sugarModelRef,
      markerHost: monaco,
      severitySource: monaco,
      notify,
      // B3 收口最后一格：诊断入口的缺省实现改成**问槽**（判据 / 供方都在插件里）。
      // 两面（adapter + backend）由上面 `ensureGlobalProviders` 登记的那枚 getter 交给插件；
      // 宿主这里不再传 `surfaceFor`——那是"宿主自己编译"那条路的残留，同批删除。
      // 取不到两面 ⇒ 插件抛错，问题面板与 toast 亮灯，而不是"这份文件干净"。
      // LAU-D1b：同一轮诊断里并 `core/dialect/*`（未绑定 / 冲突 / 响应错配）。
      // 解析语义全在 core；这里只把"当前项目 + 这份正文 + 这份路径"递进去。
      dialect: { resolve: resolveDocumentDialect },
      // K2 batch-5：把这一轮编译的成品留下（预览唯一的读入口），并通知预览刷新 / 卸载
      compileCache: kojo2CompileCache,
      onCompile: (filePath) => {
        if (kojo2Preview === null) return;
        if (filePath === null) kojo2Preview.setFile(null);
        else if (kojo2Preview.snapshot().filePath !== filePath) kojo2Preview.setFile(filePath);
        else kojo2Preview.refresh();
      },
    });
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
      // 1023：菜单项是**全局**注册（MenuRegistry / CommandsRegistry），ed.dispose() 不管它们
      // ——不逐个 dispose 就会在实例退场后留下指向死编辑器的菜单项
      for (const disposable of contextActionDisposables) disposable.dispose();
      contextMenuPositionSub.dispose();
      disposePreferences();
      focusDisposer.dispose();
      disposeBreadcrumb();
      // 书签装饰：退订两条监听 + 清装饰集合（清单里 collection.clear 由安装器负责）
      disposeBookmarks();
      disposeKojo2Problems();
      // K2 batch-5：预览入口先摘桥再 dispose（撤下后面板不再拿到半死的句柄）；
      // 次序与诊断同段：面板数据源（缓存）随实例一起走，不留上一实例的产物。
      disposeKojo2PreviewCursor();
      kojo2PreviewModelSub?.dispose();
      unpublishKojo2Preview();
      kojo2Preview?.dispose();
      kojo2CompileCache.clear();
      unregisterKojo2ExpandCompile();
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
