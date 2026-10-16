/**
 * 编辑器 model 池（SPLIT-1 分屏批）。
 *
 * 分屏后同一文件可以同时出现在多个组里——Monaco 的 model 按 URI 全局注册，
 * `createModel` 撞上同 URI 直接抛异常，而任一组把 model `dispose` 掉会把
 * 另一组正在显示的内容连根拔走。⇒ model 的所有权从「每个 EditorPane 一份
 * Map」上移到**进程级池**：引用计数归零才 dispose，同文件多组共享同一份
 * model（一处编辑、两栏同显——本来就是同一份内存）。
 *
 * 「已保存基线」版本号（BUG-4 的 O(1) 脏判定）也随池走：它属于**文件**而不
 * 属于某一组——A 组保存之后 B 组必须立刻显示干净，反之亦然。
 *
 * 工厂形态（`createEditorModelPool`）把 monaco / 内核 io 全部注入，纯逻辑
 * 闭环可单测；`editorModelPool` 是 EditorPane 用的真身单例。
 */

import type * as Monaco from '../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import { ERB_LANGUAGE_ID } from '../monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../monaco/kojo-language';

/** 按扩展名选语言：`.kojo` = 语法糖表层 DSL；其余按原生 ERB（v0.1 口径，单源在此） */
export function languageFor(filePath: string): string {
  return /\.kojo$/i.test(filePath) ? KOJO_LANGUAGE_ID : ERB_LANGUAGE_ID;
}

export interface PooledModelEntry {
  readonly model: Monaco.editor.ITextModel;
  readonly encoding: string;
  readonly eol: string;
}

export interface PoolDeps {
  /** 读盘（恢复件由调用方先取好，经 `text` 注入，池不认识 recovery-store） */
  readText: (kernel: Kernel, path: string) => Promise<{ text: string; encoding: string; eol: string }>;
  /** 建 model（真身 = monaco.editor.createModel(text, languageFor(path), Uri.file(path))） */
  createModel: (path: string, text: string) => Monaco.editor.ITextModel;
}

interface PoolRecord {
  entry?: PooledModelEntry;
  refs: number;
  loading?: Promise<PooledModelEntry>;
  /** 已保存基线版本号（BUG-4）；随文件存续，最后一份引用释放时一并清掉 */
  baseline?: number;
}

export interface EditorModelPool {
  acquire: (kernel: Kernel, path: string, opts?: { text?: string; encoding?: string; eol?: string }) => Promise<PooledModelEntry>;
  /** 释放一份引用；返回**剩余**引用数（0 = model 已 dispose，调用方可做最后清理） */
  release: (path: string) => number;
  refCount: (path: string) => number;
  baseline: (path: string) => number | undefined;
  setBaseline: (path: string, version: number) => void;
}

export function createEditorModelPool(deps: PoolDeps): EditorModelPool {
  const pool = new Map<string, PoolRecord>();
  const recordOf = (path: string): PoolRecord => {
    let rec = pool.get(path);
    if (!rec) {
      rec = { refs: 0 };
      pool.set(path, rec);
    }
    return rec!;
  };

  return {
    async acquire(kernel, path, opts) {
      const rec = recordOf(path);
      // 恢复件特例优先于一切：只要调用方带了恢复内容且 model 还没建，就以恢复内容建
      // （model 已在池里 = 已在别处打开，恢复注入不再适用——快照语义是"重启后第一次打开"）
      if (!rec.entry && !rec.loading && opts?.text !== undefined) {
        const model = deps.createModel(path, opts.text);
        const entry: PooledModelEntry = {
          model,
          encoding: opts.encoding ?? 'utf-8',
          eol: (opts.eol ?? 'LF').toUpperCase(),
        };
        rec.entry = entry;
        rec.refs += 1;
        return entry;
      }
      if (rec.entry) {
        rec.refs += 1;
        return rec.entry;
      }
      if (!rec.loading) {
        rec.loading = (async () => {
          const tf = opts?.text
            ? { text: opts.text, encoding: opts.encoding ?? 'utf-8', eol: opts.eol ?? 'LF' }
            : await deps.readText(kernel, path);
          const model = deps.createModel(path, tf.text);
          return { model, encoding: tf.encoding, eol: tf.eol.toUpperCase() } satisfies PooledModelEntry;
        })();
        // 失败不悬挂：读盘失败时清掉 loading，引用为零则整条回收（下次 acquire 重来）
        rec.loading.catch(() => {
          const cur = pool.get(path);
          if (cur && cur.refs === 0 && cur.loading) {
            cur.loading = undefined;
            pool.delete(path);
          }
        });
      }
      const entry = await rec.loading;
      rec.entry = entry;
      rec.refs += 1;
      return entry;
    },

    release(path) {
      const rec = pool.get(path);
      if (!rec || rec.refs === 0) return 0;
      rec.refs -= 1;
      if (rec.refs === 0) {
        if (rec.entry) rec.entry.model.dispose();
        pool.delete(path); // 基线随文件存续，最后一份引用释放时一并清掉
      }
      return rec.refs;
    },

    refCount(path) {
      return pool.get(path)?.refs ?? 0;
    },

    baseline(path) {
      return pool.get(path)?.baseline;
    },

    setBaseline(path, version) {
      const rec = pool.get(path);
      if (rec) rec.baseline = version;
    },
  };
}
