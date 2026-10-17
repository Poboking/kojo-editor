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
 * 属于某一组——A 组保存之后 B 组必须立刻显示干净，反之亦然。同一份生命周期上
 * 还挂一份**磁盘文本快照**（`savedBase`，ZH-F3 三方合并的 base）：版本号判得了
 * "有没有变"，判不了"变在哪一行"，所以做三方必须另存文本。
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
  /** 这份 model 的初稿来自恢复快照（而非读盘）——调用方据此决定**提交后**才消费快照 */
  readonly fromRecovery: boolean;
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
  /**
   * 正在等待 `loading` 落地的 acquire 数（含**尚未把自身引用挂上**的）。
   * refs 归零但 pending>0 ⇒ 记录不许 dispose/回收：等待者的引用会在其 settle
   * 续体里挂上，提前拆记录会把那份 model 变成"已 dispose 却仍被返回"的孤儿。
   */
  pending: number;
  loading?: Promise<{ entry: PooledModelEntry; diskText?: string }>;
  /** 已保存基线版本号（BUG-4）；随文件存续，最后一份引用释放时一并清掉 */
  baseline?: number;
  /**
   * 最后一次与磁盘对齐的**文本**快照（ZH-F3 三方合并的 base）。
   * 版本号那份（`baseline`）只能判脏，判不了"改在哪"，所以这里另存文本；
   * 生命周期与 `baseline` 完全一致（随记录回收一起释放，不留悬空副本）。
   * 缺省 = 没有 base（恢复件首开：盘上真相此刻未知）⇒ 调用方必须退回两方语义。
   */
  savedBase?: string;
}

export interface EditorModelPool {
  acquire: (kernel: Kernel, path: string, opts?: { text?: string; encoding?: string; eol?: string }) => Promise<PooledModelEntry>;
  /** 释放一份引用；返回**剩余**引用数（0 = model 已 dispose，调用方可做最后清理） */
  release: (path: string) => number;
  refCount: (path: string) => number;
  baseline: (path: string) => number | undefined;
  setBaseline: (path: string, version: number) => void;
  /** 三方合并用的磁盘文本快照；undefined = 无 base（不许拿空串冒充） */
  savedBase: (path: string) => string | undefined;
  /** 保存成功 / 自动合并落地后推进 base；路径不在池里则 no-op（同 `setBaseline` 口径） */
  setSavedBase: (path: string, text: string) => void;
}

export function createEditorModelPool(deps: PoolDeps): EditorModelPool {
  const pool = new Map<string, PoolRecord>();
  const recordOf = (path: string): PoolRecord => {
    let rec = pool.get(path);
    if (!rec) {
      rec = { refs: 0, pending: 0 };
      pool.set(path, rec);
    }
    return rec!;
  };

  return {
    async acquire(kernel, path, opts) {
      const rec = recordOf(path);
      // 恢复件特例优先于一切：只要调用方带了恢复内容且 model 还没建，就以恢复内容建
      // （model 已在池里 = 已在别处打开，恢复注入不再适用——快照语义本就是"重启后第一次"）。
      // **基线钉 0 落在建 model 的这一刻、落在池记录上**：恢复件的"未保存脏"不许依赖调用方
      // 局部变量撑过 await——切换 effect 的提交闸（cancelled 判）在 await 之后，重跑时局部
      // `recovered` 可能已是 null，届时若基线仍待调用方后补，恢复内容就会被当"干净"吞掉。
      if (!rec.entry && !rec.loading && opts?.text !== undefined) {
        const model = deps.createModel(path, opts.text);
        const entry: PooledModelEntry = {
          model,
          encoding: opts.encoding ?? 'utf-8',
          eol: (opts.eol ?? 'LF').toUpperCase(),
          fromRecovery: true,
        };
        rec.entry = entry;
        rec.baseline = 0;
        rec.refs += 1;
        return entry;
      }
      if (rec.entry) {
        rec.refs += 1;
        return rec.entry;
      }
      if (!rec.loading) {
        rec.loading = (async () => {
          const fromRecovery = opts?.text !== undefined;
          const tf = opts?.text !== undefined
            ? { text: opts.text, encoding: opts.encoding ?? 'utf-8', eol: opts.eol ?? 'LF' }
            : await deps.readText(kernel, path);
          const model = deps.createModel(path, tf.text);
          // 读盘得来的那份文本就是"与磁盘对齐的 base"；恢复件不是（它是未保存的初稿）
          return {
            entry: { model, encoding: tf.encoding, eol: tf.eol.toUpperCase(), fromRecovery } satisfies PooledModelEntry,
            diskText: fromRecovery ? undefined : tf.text,
          };
        })();
      }
      const loading = rec.loading;
      rec.pending += 1;
      // settle 走 then-配对而非 try/await：让"等待者销账（pending −1）+ 引用挂账（refs +1）"
      // 在**同一个续体**内完成，先于任何调用方续体（cancelled ⇒ release）执行 ⇒
      // release 永远拆不掉"还有等待者正在 attach"的记录。
      const settled = await loading.then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      const cur = pool.get(path);
      if (cur) cur.pending -= 1;
      if (!settled.ok) {
        // 失败不悬挂：清掉本次 loading；引用与等待者都归零则整条回收（下次 acquire 重来）
        if (cur && cur.loading === loading) cur.loading = undefined;
        if (!cur || (cur.refs === 0 && cur.pending === 0)) pool.delete(path);
        throw settled.err;
      }
      // 等待期间 pending 计数钉住记录不被回收 ⇒ cur 必在；共担同一 loading 的
      // 等待者写入的是同一个 entry（幂等）。
      const target = cur ?? recordOf(path);
      if (!target.entry) target.entry = settled.value.entry;
      if (target.savedBase === undefined && settled.value.diskText !== undefined) {
        target.savedBase = settled.value.diskText;
      }
      target.refs += 1;
      return target.entry;
    },

    release(path) {
      const rec = pool.get(path);
      if (!rec || rec.refs === 0) return 0;
      rec.refs -= 1;
      if (rec.refs === 0 && rec.pending > 0) {
        // model 还没真正 dispose（有等待中的 acquire 即将 attach）⇒ 对外视同仍有引用，
        // 调用方别做"最后一份引用"的终局清理（清 problems / 报不脏）。
        return 1;
      }
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

    savedBase(path) {
      return pool.get(path)?.savedBase;
    },

    setSavedBase(path, text) {
      const rec = pool.get(path);
      if (rec) rec.savedBase = text;
    },
  };
}
