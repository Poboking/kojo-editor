/**
 * 文件树的**行组件**（模块级 ⇒ 可 SSR 单测"一次渲染多少行"；FE-REF ⑤ 自 `FileTree.tsx` 逐字搬出）。
 *
 * 两个都保持无知：`EditRow` 只画输入框（受控值在宿主，Esc/Enter/失焦三个出口都从这里出），
 * `FileRows` 不认识编辑态——它只知道"这一行换成宿主给的那个元素"。
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { baseName } from './file-tree-model';

/** 行内编辑输入框（模块级 ⇒ SSR 单测可用；受控值在宿主，Esc/Enter/失焦三个出口都从这里出） */
export function EditRow(props: {
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
}

/** ERB 平铺行（模块级组件 ⇒ 可 SSR 单测"一次渲染多少行"；窗口大小由 `limit` 决定） */
export interface FileRowsProps {
  readonly files: readonly string[];
  /** 本次最多渲染的行数（≥ files.length 即全量 = 改动前行为） */
  readonly limit: number;
  readonly activeFile: string | null;
  readonly onOpenFile: (path: string) => void;
  /**
   * 行内重命名（B1）：与 path 匹配的那行改画输入框（node 由宿主造好塞进来，
   * FileRows 保持无知——它不认识编辑态，只知道"这一行换成这个元素"）。
   * 缺省 → 无编辑，旧行为。
   */
  readonly edit?: { readonly path: string; readonly node: ReactElement } | null;
  /** 文件行右键（B1；缺省 → 文件行无右键，旧行为） */
  readonly onFileContext?: (e: ReactMouseEvent, path: string) => void;
}

export function FileRows({ files, limit, activeFile, onOpenFile, edit, onFileContext }: FileRowsProps): ReactElement {
  const rows = limit >= files.length ? files : files.slice(0, Math.max(0, limit));
  return (
    <>
      {rows.map((f) => (
        <li key={f}>
          {edit && edit.path === f ? (
            edit.node
          ) : (
            <button
              className={`tree-file ${f === activeFile ? 'active' : ''}`}
              title={f}
              data-locate={f}
              onClick={() => onOpenFile(f)}
              onContextMenu={onFileContext ? (e) => onFileContext(e, f) : undefined}
            >
              {baseName(f)}
            </button>
          )}
        </li>
      ))}
    </>
  );
}
