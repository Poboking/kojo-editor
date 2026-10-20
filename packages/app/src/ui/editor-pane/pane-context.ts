/**
 * EditorPane 拆分后的**共享类型面**（REF-FRONT-PERF，2026-10-20）。
 *
 * 只放类型、零运行时：三个 hook（实例 / 偏好 / 面包屑）要拿到同一批 ref 壳，
 * 而这些壳的所有者是组件本体——hook 不复制 ref（复制就是让 provider 读影子，
 * 同 `editor-pane-registry.ts` 头注那条纪律），只声明自己**只读/只写**哪几位。
 *
 * `MutableRef` 刻意用结构面而不是 React 的 `RefObject`：`registerPane` 收的也是
 * 结构面（`{ current: X }`），两处能直接对上，不必再转一手。
 */
import type * as Monaco from '../../monaco/entry';
import type { EditorCodeAction, EditorDocumentSymbol } from '@kojo/plugin-api';
import type { ModelEntry } from '../editor-pane-registry';

/** 组件持有的 ref 壳（与 React `useRef` 的返回值结构相同） */
export interface MutableRef<T> {
  current: T;
}

/**
 * 面包屑树缓存（path + model 版本号为键：光标移动只换链、不重解析）。
 *
 * PS-5 起多带两位来源账：`fromIndex` = 这份树是从**项目索引**派生的（盘上真相），
 * 不是现文本解析的 ⇒ 它的失效判据除版本号外还要认索引指纹 `indexStamp`
 * （保存之后索引补扫一次，树会跟着变，而干净缓冲区的版本号不会变）。
 */
export interface CrumbTreeCache {
  path: string;
  versionId: number;
  symbols: EditorDocumentSymbol[];
  fromIndex: boolean;
  indexStamp: string | null;
}

/**
 * 三个 hook 共享的 ref 壳（**同一批对象**，不是副本）。
 *
 * 注意 `viewStatesRef` / `prevPathRef` 等视图状态位只在实例 hook 里用，
 * 但它们与编辑/面包屑的 ref 同属组件生命周期，一并放在这里，EditorPane 只向
 * hook 递一次，读起来比一长串位置参数清楚。
 */
export interface EditorPaneRefs {
  editorRef: MutableRef<Monaco.editor.IStandaloneCodeEditor | null>;
  /** 全部打开文件的 model（随标签存续；切换不销毁，关闭释放池引用） */
  entriesRef: MutableRef<Map<string, ModelEntry>>;
  /** 当前文件路径（供只注册一次的 Monaco 回调读取最新值，避免闭包过时） */
  filePathRef: MutableRef<string>;
  /** 糖视图当前挂载的只读内存 model（null = 未启用糖视图） */
  sugarModelRef: MutableRef<Monaco.editor.ITextModel | null>;
  /** 糖视图挂载前编辑器上的原文 model（糖模式降级取模 / 还原兜底用） */
  sugarOriginalModelRef: MutableRef<Monaco.editor.ITextModel | null>;
  /** 屏幕上这份糖投影的「预览行 → 源行」表（与 `sugarModelRef` 同批换上/清空） */
  sugarLineMapRef: MutableRef<readonly number[]>;
  /** CodeAction 待执行动作表（Monaco command 参数须可序列化 → 以 id 反查动作本体） */
  pendingActionsRef: MutableRef<Map<string, EditorCodeAction>>;
  /** CodeAction id 序号（**单调递增不复用**：Monaco 可能持有上一轮列表） */
  actionSeqRef: MutableRef<number>;
  /** 面包屑树缓存（登记进多实例登记簿，供 provider 反查） */
  crumbTreeCacheRef: MutableRef<CrumbTreeCache | null>;
  /** 各标签的视图状态（光标/滚动；切换时保存/恢复） */
  viewStatesRef: MutableRef<Map<string, Monaco.editor.ICodeEditorViewState | null>>;
  /** 上一个活动路径（切换时先把它的视图状态存下） */
  prevPathRef: MutableRef<string | null>;
}
