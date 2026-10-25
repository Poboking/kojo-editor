/**
 * 单条 ERB 平铺行（PS-16 自 `file-tree-rows.tsx` 拆出，FE-REF ⑤ 同款纪律：
 * 模块级 ⇒ SSR/计数单测可用；与 `FileRows` 分居两个模块 ⇒ 行级 memo 的
 * 渲染计数可以不经组件内部绑定直接观测）。
 *
 * 本模块同时是**诊断徽标的唯一画法**（`TreeProbMark`）：角色组 / 作者包标题行与单条文件行
 * 共用这一枚——同一 class、同一配色（`SEVERITY_TINT`）、同一句口径（`PROBLEM_SCOPE`）。
 * 画法为什么住在行模块而不是宿主：宿主能安全穿进行组件的只有**值**（每帧新造的
 * `ReactElement` 就是新引用 ⇒ PS-16 的行级 memo 当场作废），所以"值 → 画什么"这一段
 * 必须留在行这一侧；而它一旦留在行这一侧，组/包那两层也只能复用它——否则就是
 * "同一棵树两种画法"的新分叉（工包 E 留下的洞，本批补上）。
 */
import { memo, useSyncExternalStore, type ReactElement } from 'react';
import { baseName, middleEllipsis, TREE_LABEL_MAX } from './file-tree-model';
import { isRowActive, subscribeSelection } from './file-tree-selection';
import {
  isRowSelected,
  setSelected,
  subscribeMultiSelection,
  toggleSelected,
} from './file-tree-multi-selection';
import { useRowProblems, type ProbFile } from './file-tree-problem-view';
import { Icon } from './icons';
import { PROBLEM_SCOPE, SEVERITY_TINT } from './problem-store';
import type { OpenFileOptions } from './tabs-ops';

/** 组 / 包 tooltip 里点名用的一个文件（行徽标不点名：行本身就是那个文件） */
export type { ProbFile };

/** 单条文件行徽标的口径主语（两条行装配线共用同一个词，不各写一句中文） */
export const ROW_PROB_SCOPE = '本文件';

/**
 * 徽标样式：`styles*.css` / `styles-project.css` 不在可改集 ⇒ 按 `DirRows` 的 `pad` 先例走内联，
 * 配色仍取自 store。`lineHeight: 1` + `alignItems: center` 是行内那一腿要的——`.tree-file`
 * 行高固定（`--tree-row-h`），徽标不许把行撑高一个像素。
 */
const MARK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  flex: 'none',
  gap: 4,
  marginInlineStart: 6,
  lineHeight: 1,
  fontSize: 'var(--fs-0)',
  fontVariantNumeric: 'tabular-nums',
} as const;

export interface TreeProbMarkProps {
  /** tooltip / aria 的作用域名：`角色目录`、`作者包 X`、`本文件` */
  readonly scope: string;
  readonly error: number;
  readonly warning: number;
  /** 组 / 包两层要"点名谁在报"（超出上限的折进 `more`）；文件行不传 */
  readonly files?: readonly ProbFile[];
  readonly more?: number;
  /**
   * 紧凑档（视觉批十六）：**只画状态灯、不画数字**。文件行用它——真壳扫描完成后每行尾挂
   * `⚠ 55` / `⚠ 910`，整棵树是一列红数字墙，第一眼像"项目坏了"；数字聚合到角色组 / 作者包
   * 那一层（读树的人在那里决定打开哪一瓶），文件行只留"这里有诊断"的红点，
   * 精确读数继续在 `title` / `aria-label` 里（悬停与读屏一条不丢）。
   */
  readonly compact?: boolean;
}

/**
 * 一枚诊断徽标（`error` 圈叉 + 计数 / `warning` 三角 + 计数，L10 图标批把字符 `✕`/`⚠`
 * 换成注册表里的状态族 SVG）：两档皆空 ⇒ **整个节点不画**，零视觉扰动。
 * 每一档的读数格带 `data-prob`（error/warning）——测试与配色口径都按它点名，不再数汉字字形。
 *
 * 只折错误 / 警告两档：只报了 `info` 的文件不在树上说话（那一档面板表头本来就在说，
 * 铺满一棵树就是把注意力花在噪声上）。判据写在画法里而不是写在每个调用点，
 * 就是为了"info 不开口"这条只有一条腿。
 */
export function TreeProbMark({
  scope,
  error,
  warning,
  files,
  more = 0,
  compact = false,
}: TreeProbMarkProps): ReactElement | null {
  if (error + warning === 0) return null;
  // 组 / 包那两层点名到人；超出上限的折成「另 n 个」（展开的作者包动辄几十份文件）。
  // 点名串住在 `title` 属性里——tooltip 只能带纯文本，`✕n`/`⚠n` 字形是它唯一的记法，不改。
  const who =
    files && files.length > 0
      ? `（${files
          .map(
            (f) =>
              `${f.name}${f.error > 0 ? ` ✕${f.error}` : ''}${f.warning > 0 ? ` ⚠${f.warning}` : ''}`,
          )
          .join('、')}${more > 0 ? `，另 ${more} 个` : ''}）`
      : '';
  return (
    <span
      className="tree-prob-mark"
      role="img"
      style={MARK_STYLE}
      title={`${scope}内${PROBLEM_SCOPE.label}文件的诊断：错误 ${error} / 警告 ${warning}${who} · 详见问题面板 (Ctrl+Shift+M)`}
      aria-label={`${scope}有错误 ${error}、警告 ${warning}（仅${PROBLEM_SCOPE.label}文件）`}
    >
      {error > 0 ? (
        <span data-prob="error" style={{ color: SEVERITY_TINT.error }}>
          <Icon name="error" size="xs" />
          {compact ? null : <> {error}</>}
        </span>
      ) : null}
      {warning > 0 ? (
        /* 警告档在树上走**中性色**（视觉批十六 · 真壳实测）：扫描完成后角色组行是
           `33 ⚠432 / 27 ⚠910` 满屏红字，第一眼像"项目坏了"——警告多是 lint 级提示。
           语义色里只有错误档保留红；精确读数仍在 title / aria 里。 */
        <span data-prob="warning" style={{ color: 'var(--fg-dim)' }}>
          <Icon name="warning" size="xs" />
          {compact ? null : <> {warning}</>}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 行级选中判据（PERF 批：`activeFile` 不再走 props）。
 *
 * 旧形态把 `active` 当 prop：宿主一换活动文件，`FileRows` 的 memo 就按浅比较放行，
 * 整组行重新 `createElement`（行数越多越贵）。改成行自己订阅模块级的外部 store 后，
 * 只有**两行**（旧的、新的）拿到翻转后的布尔快照 ⇒ 其余行连 `render` 都不进。
 *
 * 第三参是 SSR 快照：`renderToStaticMarkup` 没有 store 通知，读当时的值即可，
 * 这样"高亮当前文件"这条行为在服务端渲染下逐字不变。
 */
function useActiveRow(path: string): boolean {
  return useSyncExternalStore(subscribeSelection, () => isRowActive(path), () => isRowActive(path));
}

/**
 * 行级多选判据（D 批：勾选态同样走订阅，不进 props）。
 *
 * 快照是布尔 ⇒ 勾一个文件时只有"旧的两行 + 新的一行"翻转，其余行连 render 都不进。
 * SSR 第三参读当时值，服务端渲染下"已被勾选"这条行为与改前一致（改前根本没有勾选，
 * 服务端读到的就是空集 ⇒ 不画多选高亮）。
 */
function useRowSelected(path: string): boolean {
  return useSyncExternalStore(
    subscribeMultiSelection,
    () => isRowSelected(path),
    () => isRowSelected(path),
  );
}

export interface FileRowProps {
  readonly f: string;
  /** 打开（第二参 = 方式：单击给预览态；类型见 tabs-ops.OpenFileOptions） */
  readonly onOpenFile: (path: string, opts?: OpenFileOptions) => void;
}

/**
 * 单条 ERB 平铺行：props 全是值/恒定回调（选中态与诊断量**都不在 props 里**，见
 * `useActiveRow` / `useRowProblems`）⇒ 组内任何一次父级重画、任何一次选中切换、任何一次
 * 诊断版本翻新，没变的那一行都整行跳过。
 *
 * 诊断为什么不走 props（PERF 批）：`problem-store` 的版本号每切一次标签就 +1，汇总表随之
 * 整份重建 ⇒ 当 prop 传进来的表引用必换 ⇒ 全部行重画。改成行自己订阅之后，快照是
 * **字符串**，内容没变的行连 `render` 都不进。
 *
 * 右键自 1023 批起**不再挂事件处理器**：行上写 `data-context-surface` / `data-tree-*`，
 * 由根路由（`App` 的 window 监听）读出作用域后交给 `file-tree` 面——行级 memo 因此
 * 少了一位"每帧可能换引用的回调"，右键也不再有 `preventDefault` 顺手 focus 带来的
 * 选中态变化。
 *
 * `aria-current` 只挂在选中的那一行（读屏的"当前项"语义；与 `.active` 同一个布尔，
 * 不许出现两份判据）。
 */
export const FileRow = memo(function FileRow({ f, onOpenFile }: FileRowProps): ReactElement {
  const active = useActiveRow(f);
  const selected = useRowSelected(f);
  const prob = useRowProblems(f);
  return (
    <button
      className={`tree-file ${active ? 'active' : ''} ${selected && !active ? 'multi-selected' : ''}`}
      aria-current={active ? 'true' : undefined}
      // 多选态给读屏 / 测试一个稳定挂点（不与 aria-current 的"当前项"语义抢位）
      data-multi-selected={selected ? 'true' : undefined}
      title={f}
      data-locate={f}
      data-context-surface="file-tree"
      data-tree-kind="file"
      data-tree-path={f}
      onClick={(e) => {
        // Ctrl / Cmd + 单击 = 勾选（不打开）；纯单击 = 把多选集收回这一份并照旧预览打开。
        // 两条腿合起来就能选中**恰好两个**文件，右侧「比较已选文件」据此出现。
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          toggleSelected(f);
          return;
        }
        setSelected([f]);
        onOpenFile(f, { preview: true });
      }}
    >
      {middleEllipsis(baseName(f), TREE_LABEL_MAX)}
      {prob ? (
        <TreeProbMark scope={ROW_PROB_SCOPE} error={prob.error} warning={prob.warning} compact />
      ) : null}
    </button>
  );
});
