/**
 * 文件树的**行组件**（模块级 ⇒ 可 SSR 单测"一次渲染多少行"；FE-REF ⑤ 自 `FileTree.tsx` 逐字搬出）。
 *
 * 两个都保持无知：`EditRow` 只画输入框（受控值在宿主，Esc/Enter/失焦三个出口都从这里出），
 * `FileRows` 不认识编辑态——它只知道"这一行换成宿主给的那个元素"。
 *
 * PS-16 memo 化：`EditRow` / `FileRows` 组件级 memo（树内无关 state——菜单、批注、定位——
 * 翻动时整组行不再重画）；单行 `FileRow` 行级 memo 在 `file-tree-row.tsx`（拆模块 ⇒
 * 行级计数可观测）。生效前提在宿主：`FileTree.tsx` 把穿进行组件的回调 useCallback 化、
 * `skip`/`edit` 等引用型 props 稳定化，否则每帧新引用 ⇒ memo 形同虚设。
 *
 * 选中态与诊断量**都不进 props**（PERF 批）：旧写法收 `activeFile` 与 `probs` 表，宿主一换
 * 活动文件 / 诊断版本一翻，这层 memo 必然放行 ⇒ 每行重新 `createElement` + 查一次诊断表，
 * 成本随文件数线性涨。现在两者都由行自己订阅（`file-tree-selection` /
 * `file-tree-problem-view`），本组件对"谁被选中""谁有诊断"一无所知，也永不因此重画。
 */
import { memo, useEffect, useRef, type ReactElement } from 'react';
import { FileRow } from './file-tree-row';
import type { OpenFileOptions } from './tabs-ops';


export type { FileRowProps } from './file-tree-row';

/** 行内编辑输入框（模块级 ⇒ SSR 单测可用；受控值在宿主，Esc/Enter/失焦三个出口都从这里出） */
export const EditRow = memo(function EditRow(props: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): ReactElement {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // 同 VSCode：出现即聚焦并全选（输入新名直接覆盖旧名）
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="tree-edit-input"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          props.onCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          props.onCancel();
        }
      }}
      onBlur={props.onCancel}
    />
  );
});


export interface FileRowsProps {
  readonly files: readonly string[];
  /** 本次最多渲染的行数（≥ files.length 即全量 = 改动前行为） */
  readonly limit: number;
  readonly onOpenFile: (path: string, opts?: OpenFileOptions) => void;
  /**
   * 行内重命名（B1）：与 path 匹配的那行改画输入框（node 由宿主造好塞进来，
   * FileRows 保持无知——它不认识编辑态，只知道"这一行换成这个元素"）。
   * 缺省 → 无编辑，旧行为。
   */
  readonly edit?: { readonly path: string; readonly node: ReactElement } | null;
}

export const FileRows = memo(function FileRows({ files, limit, onOpenFile, edit }: FileRowsProps): ReactElement {
  const rows = limit >= files.length ? files : files.slice(0, Math.max(0, limit));
  return (
    <>
      {rows.map((f) => (
        <li key={f}>
          {edit && edit.path === f ? edit.node : <FileRow f={f} onOpenFile={onOpenFile} />}
        </li>
      ))}
    </>
  );
});
