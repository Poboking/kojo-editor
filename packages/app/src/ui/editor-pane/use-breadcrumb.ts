/**
 * 面包屑**刷新链**（REF-FRONT-PERF，2026-10-20 从 EditorPane 挂载 effect 拆出）。
 *
 * 独立的理由不是"行数少"，而是这条链有一整套自己的判据（PS-5 的三条腿 + 1020 批
 * 把大文件闸挪到索引快路之后），而它只**读**编辑器、只**写**一条 React 状态
 * （`crumbLevels`）。把它留在挂载 effect 里，读者要在 370 行里先过滤出四条腿；
 * 搬出来之后，挂载 effect 只剩一行安装调用，时序与原来逐字一致：
 *
 * - 安装点仍在实例 create 之后、视图/光标监听之前；
 * - 两条监听（光标 / 换 model）与防抖定时器的退订顺序、清账点都不变；
 * - `crumbRefreshRef` 仍是同一只 ref 壳（组件持有，hook 只赋值/置空）。
 *
 * 数据**复用 B3 的 documentSymbol 树**（与大纲/吸顶同源同判据，不建第二份符号树）；
 * 糖视图 / 无文件 / 光标不在任何块内 ⇒ 空链（只读派生态下绝不导到派生行号）。
 */
import { useCallback, useRef, useState } from 'react';
import type * as Monaco from '../../monaco/entry';
import type { Kernel } from '@kojo/kernel';
import type { EditorDocumentSymbol, ErbIndex } from '@kojo/plugin-api';
import { errorText } from '@kojo/plugin-api';
import {
  crumbsKey,
  crumbsNeedRefresh,
  crumbLevelsAt,
  type CrumbCursor,
  type CrumbLevel,
} from '../breadcrumb-path';
import { collectDocumentSymbols } from '../../monaco/kojo-symbols';
import { erbParserIndex } from '../editor-global-providers';
import { LARGE_FILE_LINES } from '../editor-options';
import { isErbLike } from '../lift-preview';
import { erbFileInIndex, MARKER_DEBOUNCE_MS } from './pane-helpers';
import type { CrumbTreeCache, MutableRef } from './pane-context';

export interface BreadcrumbParams {
  kernel: Kernel;
  editorRef: MutableRef<Monaco.editor.IStandaloneCodeEditor | null>;
  filePathRef: MutableRef<string>;
  sugarModelRef: MutableRef<Monaco.editor.ITextModel | null>;
  /** O(1) 脏判定（与保存/广播共用同一把尺子） */
  computeDirty: (path: string) => boolean;
}

export interface BreadcrumbControls {
  /** 逐级下拉数据（空数组 = 不渲染整条栏） */
  crumbLevels: readonly CrumbLevel[];
  /** 大纲树缓存（path + model 版本号为键），登记进多实例登记簿 */
  crumbTreeCacheRef: MutableRef<CrumbTreeCache | null>;
  /**
   * 在实例创建 effect 里接线：挂刷新入口 + 两条监听，返回只清这一段的 disposer。
   * `onCursorActivity` 是 A9 选区读数（搭同一条光标监听，不新增高频监听）。
   */
  install(ed: Monaco.editor.IStandaloneCodeEditor, onCursorActivity: () => void): () => void;
}

export function useBreadcrumb(params: BreadcrumbParams): BreadcrumbControls {
  const { kernel, editorRef, filePathRef, sugarModelRef, computeDirty } = params;

  /**
   * D1 面包屑链（宿主自绘——取证：standalone Monaco 0.57 的 `monaco.d.ts` 里 `breadcrumb`
   * 零命中，公开面没有面包屑，见 `breadcrumb-path.ts` 头注）。数据**复用 B3 的 documentSymbol
   * 树**（与大纲/吸顶同源同判据，不建第二份符号树）；空数组 = 不渲染整条栏
   * （糖视图 / 无文件 / 光标不在任何块内——只读派生态下绝不导到派生行号）。
   *
   * 1020 编辑器体感批改存**逐级下拉数据**（`CrumbLevel`）而不是裸链：同级列表要的是
   * "这一层还有哪些块"，那份数据本来就在同一棵缓存树里，另存一份链反而要第二次下行。
   */
  const [crumbLevels, setCrumbLevels] = useState<readonly CrumbLevel[]>([]);
  /** 面包屑刷新入口（ref 化：光标/model 监听只注册一次，须读最新闭包） */
  const crumbRefreshRef = useRef<((forceParse?: boolean) => void) | null>(null);
  /** 防抖重算定时器（PS-5：打字期间全文解析**每轮停笔一次**，不是每击键一次） */
  const crumbTimerRef = useRef<number | null>(null);
  /**
   * 大纲树缓存（path + model 版本号为键：光标移动只换链、不重解析）。
   *
   * PS-5 起多带两位来源账：`fromIndex` = 这份树是从**项目索引**派生的（盘上真相），
   * 不是现文本解析的 ⇒ 它的失效判据除版本号外还要认索引指纹 `indexStamp`
   * （保存之后索引补扫一次，树会跟着变，而干净缓冲区的版本号不会变）。
   */
  const crumbTreeCacheRef = useRef<CrumbTreeCache | null>(null);
  /** 上一次渲染的链键（等值即不 setState——光标每动一次不该白刷一次 React） */
  const crumbsKeyRef = useRef('');
  /** 上一次**重算过链**的位点（同 path 同行即跳过全文解析，判据见 `crumbsNeedRefresh`） */
  const crumbLastRef = useRef<CrumbCursor | null>(null);

  /* ───────────── PS-5 面包屑：能用已索引的名录就不解析全文 ───────────── */

  /** 当前项目索引（**软取**）：直接吃宿主唯一那一枚 `erbParserIndex()`（与悬停 / 函数名 / 文件事实
   *  同一份取法，ST-TAIL 2026-10-20 归一：此前这里手抄了第三份 `try + tryGet + ?? null`）。
   *  未开项目、未建好、服务抛错一律当"没有"，绝不抛进光标监听。 */
  const currentErbIndex = useCallback((): ErbIndex | null => erbParserIndex(kernel), [kernel]);

  /**
   * 从索引里取这份文件的符号表（拿不到 = null，调用方按原路解析）。
   *
   * 三条判据任一不过即**不用索引**，因为面包屑点击会 reveal 行号，行号错一位就是
   * 把作者导到别处（比没有面包屑更糟，同 `crumbRefresh` 大文件清链那条理由）：
   * ① 只有 ERB 方言在索引里（`.kojo` 的树由糖线按现文本现算，索引没有它）；
   * ② 缓冲区必须**干净**——索引读的是盘上那份，作者改了没保存时它是过期真相；
   * ③ 索引里那份的行数必须等于当前 model 的行数（干净 + 行数一致 ⇒ 盘上==缓冲，
   *    行号坐标系对得上；对不上宁可不猜）。
   *
   * 产出形状与 erb-parser 的 `erbDocumentSymbols` 逐字同源（函数 + 声明、文档序：
   * 同起始行时函数在前）。这里不抄 `detail`：面包屑只读 name/kind/startLine，
   * 而 `enclosingChainAt` 的平局折法只认"文档序第一枚"，排序一致就够。
   */
  const symbolsFromIndex = useCallback(
    (path: string, lineCount: number): { symbols: EditorDocumentSymbol[]; stamp: string | null } | null => {
      if (!isErbLike(path)) return null;
      if (computeDirty(path)) return null;
      const index = currentErbIndex();
      const file = erbFileInIndex(index, path);
      if (!file || file.lineCount !== lineCount) return null;
      const symbols: EditorDocumentSymbol[] = [];
      for (const fn of file.functions) {
        symbols.push({ name: fn.name, kind: 'function', startLine: fn.startLine, endLine: fn.endLine });
      }
      for (const dim of file.dims) {
        symbols.push({ name: dim.name, kind: 'declaration', startLine: dim.line, endLine: dim.line });
      }
      symbols.sort((a, b) => a.startLine - b.startLine || (a.kind === b.kind ? 0 : a.kind === 'function' ? -1 : 1));
      return { symbols, stamp: index?.fingerprint ?? null };
    },
    [computeDirty, currentErbIndex],
  );

  /**
   * 把一次全文重算推到停笔之后（PS-5）。
   *
   * 单条在途就够：定时器闭包读的是**落地时刻**的光标与版本号（与装饰防抖同一条纪律），
   * 所以连打期间不需要逐键排程，最后一次停笔补一次即收敛。
   * `crumbLastRef` 先清空是**必须的**——绕过 `crumbsNeedRefresh` 那道"同 path 同行不重算"
   * 的闸（那道闸正是为了省这次解析而设，不清就会 self-skip 掉自己约的这次重算）。
   */
  const scheduleCrumbRebuild = useCallback((): void => {
    if (crumbTimerRef.current !== null) return;
    crumbTimerRef.current = window.setTimeout(() => {
      crumbTimerRef.current = null;
      crumbLastRef.current = null;
      crumbRefreshRef.current?.(true);
    }, MARKER_DEBOUNCE_MS);
  }, []);

  const install = useCallback(
    (ed: Monaco.editor.IStandaloneCodeEditor, onCursorActivity: () => void): (() => void) => {
      // 面包屑（D1，宿主自绘——standalone Monaco 无面包屑 API，取证见 `breadcrumb-path.ts`）。
      // 数据复用大纲那棵树：`collectDocumentSymbols` 的应答判据与 provider 接线逐字同款
      // （糖视图只读 model 一律不给——行号属派生物，面包屑不许把作者导到不存在的位置）。
      //
      // PS-5 把"这棵树什么时候必须重算"收成三条，按代价从低到高排：
      // ① **版本号没动** ⇒ 用缓存（改前就有）；索引派生的条目额外认索引指纹——保存之后
      //    盘上补扫会让树变，而干净缓冲区的版本号不变（`fromIndex` / `indexStamp` 就是为这一条加的）；
      // ② 版本动了但缓冲区**干净**且索引认得这份文件 ⇒ 从**已索引**的函数名录派生，
      //    零解析、零全文复制（浏览/跳转这条主路径从此一次全文解析都不付）；
      // ③ 版本动了且**改脏了** ⇒ 沿用同一份文件的上一次树，把解析推到停笔那一拍
      //    （`scheduleCrumbRebuild`，250ms，与装饰防抖同节奏）。
      // ③ 的滞后窗口与 `crumbsNeedRefresh` 既有口径同一类（"块边界真的变了，最多滞后到
      // 下一次换行即补上"），换到的收益是"每敲一键整篇 getValue + 全文扫描一次"不再发生；
      // 换文件的第一次仍**立即**解析（没有可沿用的树时不给作者看上一份文件的链）。
      //
      // 1020 编辑器体感批改了**大文件那一闸的位置**：此前它在最前面按行数一刀切清空，
      // 于是 ② 这条零解析的索引快路对 ≥5,000 行的文件**根本走不到**——5,000 行正是语料里
      // "长但天天读"的那一档，VS Code 在大文件仍保留面包屑。现在体量闸落在④：只有"缓存没有、
      // 索引不认、只能现解析"时才按体量清链（清链必须清的理由逐字不变：旧链会把别的文件的行号
      // reveal 进当前文件）。
      crumbRefreshRef.current = (forceParse = false) => {
        const ed = editorRef.current;
        const path = filePathRef.current;
        const model = ed?.getModel() ?? null;
        const apply = (next: readonly CrumbLevel[]): void => {
          const key = crumbsKey(next.map((l) => l.current));
          if (key === crumbsKeyRef.current) return;
          crumbsKeyRef.current = key;
          setCrumbLevels(next);
        };
        if (!ed || !path || sugarModelRef.current || !model) {
          crumbLastRef.current = null;
          apply([]);
          return;
        }
        const cursor: CrumbCursor = {
          path,
          line: ed.getPosition()?.lineNumber ?? 1,
          lineCount: model.getLineCount(),
        };
        if (!crumbsNeedRefresh(cursor, crumbLastRef.current)) return;
        crumbLastRef.current = cursor;
        try {
          const versionId = model.getAlternativeVersionId();
          const cache = crumbTreeCacheRef.current;
          const chainOf = (symbols: readonly EditorDocumentSymbol[]): void =>
            apply(crumbLevelsAt(symbols, cursor.line));
          // ① 同版本（索引条目还须同指纹）⇒ 缓存就是当前真相，一次解析都不付
          if (
            cache &&
            cache.path === path &&
            cache.versionId === versionId &&
            (!cache.fromIndex || cache.indexStamp === (currentErbIndex()?.fingerprint ?? null))
          ) {
            chainOf(cache.symbols);
            return;
          }
          // ② 干净缓冲区 + 索引认得这份文件 ⇒ 用已索引的名录，不碰全文解析
          const indexed = symbolsFromIndex(path, cursor.lineCount);
          if (indexed) {
            crumbTreeCacheRef.current = {
              path,
              versionId,
              symbols: indexed.symbols,
              fromIndex: true,
              indexStamp: indexed.stamp,
            };
            chainOf(indexed.symbols);
            return;
          }
          // ③ 脏了：同一份文件的旧树继续顶着（最多滞后一个防抖窗口），停笔那一拍补一次真解析
          if (!forceParse && cache && cache.path === path) {
            scheduleCrumbRebuild();
            chainOf(cache.symbols);
            return;
          }
          // ④ 只剩"现解析"这一条路：大文件不值这一刀，清链（**不是**维持现状，理由见上）
          if (cursor.lineCount >= LARGE_FILE_LINES) {
            crumbLastRef.current = null;
            apply([]);
            return;
          }
          const symbols = collectDocumentSymbols(kernel.slots.query('ui.editor.languageService'), {
            kind: 'documentSymbol',
            path,
            text: model.getValue(),
            project: kernel.project.current(),
            lineCount: cursor.lineCount,
          });
          crumbTreeCacheRef.current = { path, versionId, symbols, fromIndex: false, indexStamp: null };
          chainOf(symbols);
        } catch (e: unknown) {
          // 面包屑是只读呈现面：出错就"没链"，绝不把光标处理链带崩
          console.warn(`[breadcrumb] 刷新抛错：${errorText(e)}`);
          apply([]);
        }
      };
      // A9 选区读数搭同一条光标监听：不新增高频监听，等值去抖在 pushSelStatus 内
      const crumbCursorSub = ed.onDidChangeCursorPosition(() => {
        crumbRefreshRef.current?.();
        onCursorActivity();
      });
      const crumbModelSub = ed.onDidChangeModel(() => {
        crumbRefreshRef.current?.();
        onCursorActivity();
      });
      return () => {
        crumbCursorSub.dispose();
        crumbModelSub.dispose();
        // PS-5 面包屑防抖：在途那一次重算随实例退场作废（回调里读的是这个实例的 model）
        if (crumbTimerRef.current !== null) {
          window.clearTimeout(crumbTimerRef.current);
          crumbTimerRef.current = null;
        }
        crumbRefreshRef.current = null;
      };
    },
    [currentErbIndex, editorRef, filePathRef, kernel, scheduleCrumbRebuild, symbolsFromIndex, sugarModelRef],
  );

  return { crumbLevels, crumbTreeCacheRef, install };
}
