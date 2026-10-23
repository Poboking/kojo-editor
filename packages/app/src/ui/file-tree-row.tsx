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
import { memo, type ReactElement } from 'react';
import { baseName } from './file-tree-model';
import { Icon } from './icons';
import { PROBLEM_SCOPE, SEVERITY_TINT, type ProblemFileCounts } from './problem-store';
import type { OpenFileOptions } from './tabs-ops';

/** 组 / 包 tooltip 里点名用的一个文件（行徽标不点名：行本身就是那个文件） */
export interface ProbFile {
  readonly name: string;
  readonly error: number;
  readonly warning: number;
}

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
          <Icon name="error" size="xs" /> {error}
        </span>
      ) : null}
      {warning > 0 ? (
        <span data-prob="warning" style={{ color: SEVERITY_TINT.warning }}>
          <Icon name="warning" size="xs" /> {warning}
        </span>
      ) : null}
    </span>
  );
}

export interface FileRowProps {
  readonly f: string;
  readonly active: boolean;
  /** 打开（第二参 = 方式：单击给预览态；类型见 tabs-ops.OpenFileOptions） */
  readonly onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /**
   * 这一行的诊断量（**additive 传值**，工包：文件行徽标）。
   *
   * 宿主给的是 `problem-store.summarizeProblems()` 的 `byKey` 里 `pkey(行路径)` 那一格
   * （同一份 summary 版本内引用恒定 ⇒ 行级 memo 的浅比较照旧挡得住；诊断一换版本引用必换
   * ⇒ 徽标跟着真相走，不需要第二条订阅腿）。缺省 = 树上不标；只有 `info` 的那一格由
   * `TreeProbMark` 吞掉。
   */
  readonly prob?: ProblemFileCounts;
}

/**
 * 单条 ERB 平铺行（PS-16 行级 memo）：props 全是值/恒定回调 ⇒ `activeFile` 切换时
 * 只有旧 active 行与新 active 行重画，组内其余行全部跳过——这是点文件这条最高频
 * 路径上从"全组重画"到"两行重画"的那一刀。徽标那一位同样是**值**（见 `FileRowProps.prob`），
 * 加它不会让这一刀变钝。
 *
 * 右键自 1023 批起**不再挂事件处理器**：行上写 `data-context-surface` / `data-tree-*`，
 * 由根路由（`App` 的 window 监听）读出作用域后交给 `file-tree` 面——行级 memo 因此
 * 少了一位"每帧可能换引用的回调"，右键也不再有 `preventDefault` 顺手 focus 带来的
 * 选中态变化。
 */
export const FileRow = memo(function FileRow({
  f,
  active,
  onOpenFile,
  prob,
}: FileRowProps): ReactElement {
  return (
    <button
      className={`tree-file ${active ? 'active' : ''}`}
      title={f}
      data-locate={f}
      data-context-surface="file-tree"
      data-tree-kind="file"
      data-tree-path={f}
      // 单击 = 预览态浏览（VS Code 单击文件树那份手感：斜体、不占新位、再点一下转正）
      onClick={() => onOpenFile(f, { preview: true })}
    >
      {baseName(f)}
      {prob ? <TreeProbMark scope={ROW_PROB_SCOPE} error={prob.error} warning={prob.warning} /> : null}
    </button>
  );
});
