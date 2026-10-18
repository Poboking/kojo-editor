/**
 * 单条 ERB 平铺行（PS-16 自 `file-tree-rows.tsx` 拆出，FE-REF ⑤ 同款纪律：
 * 模块级 ⇒ SSR/计数单测可用；与 `FileRows` 分居两个模块 ⇒ 行级 memo 的
 * 渲染计数可以不经组件内部绑定直接观测）。
 */
import { memo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { baseName } from './file-tree-model';

export interface FileRowProps {
  readonly f: string;
  readonly active: boolean;
  readonly onOpenFile: (path: string) => void;
  /** 文件行右键（B1；缺省 → 文件行无右键，旧行为） */
  readonly onFileContext?: (e: ReactMouseEvent, path: string) => void;
}

/**
 * 单条 ERB 平铺行（PS-16 行级 memo）：props 全是值/恒定回调 ⇒ `activeFile` 切换时
 * 只有旧 active 行与新 active 行重画，组内其余行全部跳过——这是点文件这条最高频
 * 路径上从"全组重画"到"两行重画"的那一刀。
 */
export const FileRow = memo(function FileRow({ f, active, onOpenFile, onFileContext }: FileRowProps): ReactElement {
  return (
    <button
      className={`tree-file ${active ? 'active' : ''}`}
      title={f}
      data-locate={f}
      onClick={() => onOpenFile(f)}
      onContextMenu={onFileContext ? (e) => onFileContext(e, f) : undefined}
    >
      {baseName(f)}
    </button>
  );
});