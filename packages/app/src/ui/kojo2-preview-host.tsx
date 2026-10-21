/**
 * Kojo 2.0 预览面板的**宿主桥 + 挂载点**（K2-EDITOR-MOUNT ①）。
 *
 * ## 为什么需要一座桥
 *
 * 预览要的两样东西分别住在两处：
 * - **编译成品**（产物 + 同源 source map）：住诊断接线那一拍（`installKojo2ProblemWiring`
 *   把 core 那次编译的产物留在 `Kojo2CompileCache` 里，**绝不二次编译**）；
 * - **光标 / 跳转**：住编辑器实例（`attachCursor` / `revealLocation`）。
 *
 * 两者都在 `EditorPane` 的挂载 effect 里（`ui/editor-pane/use-monaco-instance.ts`），
 * 而面板要挂在壳层的底部面板区（`ProjectView` 的 `builtinViews`）。跨这一层的只有
 * **一个只读句柄**：编辑器侧 `publishKojo2PreviewEntry(entry)` 发布，壳层
 * {@link Kojo2PreviewHost} 用 `useSyncExternalStore` 订阅。与 `setShellEditorStatus`
 * 同款的模块级桥（不是第二套状态机制，也不把 entry 塞进 props 链）。
 *
 * ## 三条硬口径
 *
 * 1. **flag 关 = 零挂载零监听**：{@link kojo2PreviewBottomView} 直接返回 `null`
 *    （底部区连"编译预览"这个 tab 都不会出现），{@link Kojo2PreviewHost} 也不订阅；
 * 2. **面板只认 `panelProps()`**：入口说"没就绪"（不是 `.kojo2` / 还没编译 / 编译失败）
 *    就**不挂** `<Kojo2PreviewPanel>`，只画一句 idle 说明——面板组件本身不认识宿主；
 * 3. **两份结果不同源的守卫留在模型里**：缓存里 `compiled` 与 `sourceMapModel` 是同一次
 *    编译的两半（`compilationOfDiagnostics` 成对构造），面板构造模型时仍在校验行数，
 *    不等即渲染一条错误说明而不是错位的行。
 *
 * ## 刷新链（谁让预览重画）
 *
 * `onDidChangeModelContent`（200ms 合并）→ 诊断那一轮 core 编译 → `compileCache.remember`
 * + `onCompile(path)` → 入口 `refresh()`（或切文件时 `setFile(path)`）→ 快照 → 本组件的
 * `useSyncExternalStore` → 面板 props 重算。**链上只有一次编译**。
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import type { UIPanelContribution } from '@kojo/plugin-api';
import { Kojo2PreviewPanel } from './kojo2-preview-panel';
import {
  kojo2PreviewEnabled,
  type Kojo2PreviewEntry,
  type Kojo2PreviewEntrySnapshot,
} from './kojo2-preview-entry';

/** 底部区里这只视图的稳定 id（命令 `workbench.problems` 同款命名法；可被 `layout` 记住） */
export const KOJO2_PREVIEW_VIEW_ID = 'kojo.kojo2preview';

/* ============================== 桥（模块级、只读面） ============================== */

let currentEntry: Kojo2PreviewEntry | null = null;
/** 快照版本：`useSyncExternalStore` 的 getSnapshot 必须返回**同一引用**直到真的变了 */
let revision = 0;
const listeners = new Set<() => void>();

function bump(): void {
  revision += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 订阅者自己炸了不该把发布方（编辑器挂载 effect）带下水
    }
  }
}

/**
 * 发布（或撤下，传 `null`）当前预览入口；返回**只撤自己**的注销函数。
 *
 * 编辑器实例卸载时调用它：撤下前先比对身份，后一个实例发布过就不会被前一个的清理误清
 * （多编辑器组场景下同一条纪律，与 `editor-pane-registry` 的退册同源）。
 */
export function publishKojo2PreviewEntry(entry: Kojo2PreviewEntry | null): () => void {
  currentEntry = entry;
  bump();
  return () => {
    if (currentEntry !== entry) return;
    currentEntry = null;
    bump();
  };
}

/** 当前入口（没有 = `null`；订阅方只在渲染 / 事件里现取） */
export function currentKojo2PreviewEntry(): Kojo2PreviewEntry | null {
  return currentEntry;
}

/** 订阅桥变化（发布 / 撤下 / 注销）；返回取消订阅 */
export function subscribeKojo2PreviewBridge(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 桥的版本号（`useSyncExternalStore` 的快照；只保证"变了就不同"） */
export function kojo2PreviewBridgeRevision(): number {
  return revision;
}

/** 当前入口快照（`null` = 没有入口；宿主 / 测试读数面） */
export function currentKojo2PreviewSnapshot(): Kojo2PreviewEntrySnapshot | null {
  return currentEntry === null ? null : currentEntry.snapshot();
}

/* ============================== 面板挂载点 ============================== */

const IDLE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  margin: 0,
  background: 'var(--surface-sunken)',
  color: 'var(--fg-dim)',
  borderTop: '1px solid var(--border-subtle)',
  fontFamily: 'var(--font-meta)',
  fontSize: 'var(--fs-1)',
} as const;

/** 面板没挂上时的一句人话（不是"空面板"，也不假装产物是空的） */
function idleHint(reason: string): ReactElement {
  return (
    <div className="kojo2-preview__idle" data-state="idle" style={IDLE_STYLE}>
      <span aria-hidden="true" style={{ color: 'var(--fg-dim)', opacity: 0.7 }}>
        ·
      </span>
      <span>{reason}</span>
    </div>
  );
}

const IDLE_NO_FILE = '当前没有可预览的 Kojo 2.0 文件（活动文件是 .kojo2 且编译完成后这里会显示产物）。';

/**
 * 预览面板的宿主组件（内建底部视图的 `component`：模块级函数 ⇒ 组件身份恒定，
 * 壳层重渲不会整棵重挂）。
 *
 * hooks 与 flag 无关地走完（`useSyncExternalStore` 无条件调用）：宿主翻开关不会让 hook
 * 表错位。flag 关 / 没有入口 / 入口未就绪 ⇒ 渲染 idle 说明，**不挂面板本体**。
 */
export function Kojo2PreviewHost(): ReactElement | null {
  // 订阅桥：入口发布 / 撤下 / 每次编译回填都会递增修订号
  useSyncExternalStore(
    subscribeKojo2PreviewBridge,
    kojo2PreviewBridgeRevision,
    kojo2PreviewBridgeRevision,
  );

  if (!kojo2PreviewEnabled()) return null; // flag 关：零挂载（与底部 tab 的出现条件同一格）
  const entry = currentEntry;
  if (entry === null) return idleHint('编辑器还没装上 Kojo 2.0 预览接线（打开项目后自动接上）。');
  const props = entry.panelProps();
  if (props === null) return idleHint(IDLE_NO_FILE);
  return <Kojo2PreviewPanel {...props} />;
}

/**
 * 底部区的内建视图贡献（flag 关 ⇒ `null`：连 tab 都不出现）。
 *
 * 与「问题」面板同一条挂载法（`location: 'bottom'`），但**不抢默认激活落点**
 * （`defaultActive: false`）：底部区的默认激活仍是「约定校验」（Ctrl+J），预览是作者
 * 打开 2.0 文件后主动去看的一栏。
 */
export function kojo2PreviewBottomView(): UIPanelContribution | null {
  if (!kojo2PreviewEnabled()) return null;
  return {
    id: KOJO2_PREVIEW_VIEW_ID,
    title: '编译预览',
    icon: 'preview',
    order: 45, // 「问题」40 之后、「约定校验」50 之前：诊断 → 预览 → 校验，与作者读屏顺序一致
    location: 'bottom',
    defaultActive: false,
    component: Kojo2PreviewHost,
  };
}
