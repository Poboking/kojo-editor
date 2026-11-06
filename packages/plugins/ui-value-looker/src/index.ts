/**
 * @kojo/plugin-ui-value-looker
 *
 * 数值看板（`ui.panel` 槽贡献；aux 副侧栏）。
 *
 * 写口上的高频动作是「翻数值」：这个 flag 是几号、中文叫什么、谁在判它、
 * 这个函数在哪儿。本面板把四件事收进一屏：
 *   ① 变量字典——adapter 的 `VariableSchema` 逐族浏览（编号 × 名字 × 中文说明），
 *      点条目出**可复制引用片段**（`CFLAG:2` / `CFLAG:TARGET:2` / 具名形）与
 *      **反查使用点**（条件抽取索引反建，点击跳行）；
 *   ② 项目符号——ERB 索引的函数（含 docComment）与 `#DIM` 声明（含 `.ERH` 全局声明），
 *      按口上包作用域过滤，点击跳编辑器；
 *   ③ 指令速查——adapter 的 `KojoInstructionTable`（编号 ↔ 中文名），点击复制。
 *
 * 分层（与 ui-state-replay / ui-condition-matrix 同款）：
 *   - **纯逻辑**（`./panel-logic.ts` + `./packs.ts` + `./var-families.ts`）：数据 → 数据，
 *     零 React 零 IO，单测覆盖；
 *   - **呈现**（`./looker-view.ts`）：props 进、元素树出，零状态；
 *   - **壳层**（本文件）：服务注入、订阅、缓存失效、复制与跳转意图。
 *
 * 铁律边界：
 *   - 本插件**零游戏名词**：族头词汇表是 era 引擎语言层事实（`var-families.ts`，
 *     与 state-replay 的 var-model 同源）；一切名字 / 标签 / 位表运行时经
 *     `game.adapter` 槽的 `VariableSchema` 流入，缺席一律显式空态（铁律 4 不静默）；
 *   - 只读：本面板不写任何文件、不发任何写授权请求。
 */

import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  createElement,
} from 'react';
import type {
  ConditionIndex,
  ConditionExtractorService,
  ErbIndex,
  ErbParserService,
  Plugin,
  ProjectService,
  SlotRegistry,
  UIPanelProps,
} from '@kojo/plugin-api';
import {
  KernelServices,
  WellKnownServices,
  activeGameAdapter,
  growWindow,
} from '@kojo/plugin-api';
import {
  VL_USAGE_WINDOW,
  VL_WINDOW,
  buildFamilyRows,
  buildInstrRows,
  buildVarUsageIndex,
  emptyVarUsageIndex,
  entryRowsForFamily,
  filterFamilies,
  filterInstr,
  filterVarEntries,
  snippetsFor,
  usagesOf,
  vlWindowSize,
  type FamilyRow,
  type IndexStats,
  type InstrRow,
  type PackSummary,
  type SymbolRow,
  type VarEntryRow,
  type VarUsageIndex,
} from './panel-logic';
import { collectPacks, packKeyOfPath, PACK_EXTERNAL, PACK_LIBRARY } from './packs';
import { ValueLookerView, type LookerTab, type ValueLookerViewProps } from './looker-view';

/** 面板 id（壳层命令与布局键用它） */
export const VALUE_LOOKER_PANEL_ID = 'value-looker';

/** 符号搜索的单次命中上限（超出即截断；防极端查询拖垮渲染） */
const SYMBOL_HIT_CAP = 2_000;

/** docComment 首行（去掉 `;` 前缀；看板行只显示一行摘要） */
function firstDocLine(doc: string): string {
  const line = doc.split('\n', 1)[0] ?? '';
  return line.replace(/^;\s*/, '').trim();
}

/** 提取一个口上包（或全库不分包）下的函数/声明行；`pack = null` 时不过滤包域 */
function symbolRowsForPack(
  index: ErbIndex,
  pack: string | null,
  kojoPaths: readonly string[],
  libraryPaths: readonly string[],
  kind: 'fn' | 'dim',
): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const packOf = (filePath: string): string => packKeyOfPath(filePath, kojoPaths, libraryPaths);
  for (const [filePath, file] of index.files) {
    const filePack = packOf(filePath);
    if (filePack === PACK_EXTERNAL) continue;
    if (pack !== null && filePack !== pack) continue;
    const inLibrary = filePack === PACK_LIBRARY;
    if (kind === 'fn') {
      for (const fn of file.functions) {
        rows.push({
          name: fn.name,
          kind: 'fn',
          filePath,
          line: fn.startLine,
          ...(fn.params !== undefined ? { params: fn.params.length } : {}),
          ...(fn.docComment ? { doc: firstDocLine(fn.docComment) } : {}),
          inLibrary,
        });
        if (rows.length >= SYMBOL_HIT_CAP) return rows;
      }
    } else {
      for (const dim of file.dims) {
        rows.push({
          name: dim.name,
          kind: 'dim',
          directive: dim.directive,
          filePath,
          line: dim.line,
          inLibrary,
        });
        if (rows.length >= SYMBOL_HIT_CAP) return rows;
      }
    }
  }
  return rows;
}

/** 函数名搜索走 byName（11 万名字级），命中后取首定义补位置 */
function searchFunctionRows(
  index: ErbIndex,
  query: string,
  pack: string | null,
  kojoPaths: readonly string[],
  libraryPaths: readonly string[],
): SymbolRow[] {
  const q = query.trim().toLowerCase();
  const rows: SymbolRow[] = [];
  for (const name of index.byName.keys()) {
    if (q.length > 0 && !name.toLowerCase().includes(q)) continue;
    const def = index.byName.firstOf(name);
    if (!def) continue;
    const filePack = packKeyOfPath(def.filePath, kojoPaths, libraryPaths);
    if (filePack === PACK_EXTERNAL) continue;
    if (pack !== null && filePack !== pack) continue;
    rows.push({
      name: def.name,
      kind: 'fn',
      filePath: def.filePath,
      line: def.startLine,
      ...(def.docComment ? { doc: firstDocLine(def.docComment) } : {}),
      inLibrary: filePack === PACK_LIBRARY,
    });
    if (rows.length >= SYMBOL_HIT_CAP) break;
  }
  return rows;
}

/** 声明（#DIM）搜索：迭代 files[].dims（35k 级），名字/文件命中即收 */
function searchDimRows(
  index: ErbIndex,
  query: string,
  pack: string | null,
  kojoPaths: readonly string[],
  libraryPaths: readonly string[],
): SymbolRow[] {
  const q = query.trim().toLowerCase();
  const rows: SymbolRow[] = [];
  for (const [filePath, file] of index.files) {
    const filePack = packKeyOfPath(filePath, kojoPaths, libraryPaths);
    if (filePack === PACK_EXTERNAL) continue;
    if (pack !== null && filePack !== pack) continue;
    for (const dim of file.dims) {
      if (q.length > 0 && !dim.name.toLowerCase().includes(q) && !filePath.toLowerCase().includes(q))
        continue;
      rows.push({
        name: dim.name,
        kind: 'dim',
        directive: dim.directive,
        filePath,
        line: dim.line,
        inLibrary: filePack === PACK_LIBRARY,
      });
      if (rows.length >= SYMBOL_HIT_CAP) break;
    }
    if (rows.length >= SYMBOL_HIT_CAP) break;
  }
  return rows;
}

export function createUiValueLookerPlugin(): Plugin {
  return {
    id: 'ui-value-looker',
    version: '0.1.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
      KernelServices.Bus,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /* ------------------------------ 面板组件 ------------------------------ */

      const ValueLookerPanel = (_props: UIPanelProps): unknown => {
        const [tab, setTab] = useState<LookerTab>('vars');
        // 变量字典页状态
        const [familyQuery, setFamilyQuery] = useState('');
        const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
        const [entryQuery, setEntryQuery] = useState('');
        const [entryLimit, setEntryLimit] = useState<number>(VL_WINDOW.initial);
        const [selectedEntry, setSelectedEntry] = useState<VarEntryRow | null>(null);
        const [usageLimit, setUsageLimit] = useState<number>(VL_USAGE_WINDOW.initial);
        const [usageTick, setUsageTick] = useState(0);
        // 项目符号页状态
        const [symbolKind, setSymbolKind] = useState<'fn' | 'dim'>('fn');
        const [selectedPack, setSelectedPack] = useState<string | null>(null);
        const [symbolQuery, setSymbolQuery] = useState('');
        const [symbolLimit, setSymbolLimit] = useState<number>(VL_WINDOW.initial);
        // 指令速查页状态
        const [instrQuery, setInstrQuery] = useState('');
        const [instrLimit, setInstrLimit] = useState<number>(VL_WINDOW.initial);
        // 复制回执（一条，自动消退）
        const [notice, setNotice] = useState<string | null>(null);
        const noticeTimer = useRef<number | null>(null);
        /** 变量反查索引缓存（ref：按条件索引对象身份失效；构建走慢路径防首点卡帧） */
        const usageCacheRef = useRef<{ src: ConditionIndex; idx: VarUsageIndex } | null>(null);

        /** 事件驱动刷新：项目开关 → 清选中态；函数索引重算 → 派生数据重算 */
        useEffect(() => {
          const offs = [
            ctx.bus.on('project.opened', () => {
              setSelectedFamily(null);
              setSelectedEntry(null);
              setSelectedPack(null);
              usageCacheRef.current = null;
              setTab('vars');
            }),
            ctx.bus.on('project.closed', () => {
              setSelectedFamily(null);
              setSelectedEntry(null);
              setSelectedPack(null);
              usageCacheRef.current = null;
            }),
            ctx.bus.on('kojo.functionChanged', () => setUsageTick((t) => t + 1)),
          ];
          return () => {
            for (const off of offs) off();
          };
        }, []);

        const showNotice = (text: string): void => {
          setNotice(text);
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
          noticeTimer.current = setTimeout(() => setNotice(null), 2400) as unknown as number;
        };
        useEffect(
          () => () => {
            if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
          },
          [],
        );

        /* ---------- 数据源（每次渲染现查：均为内存 Map 读，幂等廉价） ---------- */
        const currentProject = project.current();
        const adapter = activeGameAdapter(slots.query('game.adapter'), currentProject?.adapterId);
        const schema = adapter?.variableSchema;
        const erbIndex = parser.currentIndex();
        const condIndex = extractor.currentIndex();

        /* ---------- 变量字典：族行 / 条目行 ---------- */
        const familyRows = useMemo<FamilyRow[]>(
          () => (schema ? buildFamilyRows(schema) : []),
          // tick 进依赖是刻意的：项目开关后 schema 引用可能仍是旧对象，事件才可靠
          [schema, usageTick],
        );

        // 族自动选中：无选中 / 选中失效 → 取第一族（族表空就保持空，不猜）
        useEffect(() => {
          if (familyRows.length === 0) {
            if (selectedFamily !== null) setSelectedFamily(null);
            return;
          }
          if (selectedFamily === null || !familyRows.some((f) => f.id === selectedFamily)) {
            setSelectedFamily(familyRows[0]!.id);
          }
        }, [familyRows, selectedFamily]);

        /** 未过滤的全族条目（每族只重建一次，搜索只做行内过滤） */
        const allEntries = useMemo<VarEntryRow[]>(
          () => (schema && selectedFamily ? entryRowsForFamily(schema, selectedFamily) : []),
          [schema, selectedFamily, usageTick],
        );
        const deferredEntryQuery = useDeferredValue(entryQuery);
        const entryRows = useMemo(
          () => filterVarEntries(allEntries, deferredEntryQuery),
          [allEntries, deferredEntryQuery],
        );
        const familyRowsFiltered = useMemo(
          () => filterFamilies(familyRows, familyQuery),
          [familyRows, familyQuery],
        );

        /** 头部副句：族数 + 名录总数 */
        const dictNote = useMemo(() => {
          if (familyRows.length === 0) return null;
          let total = 0;
          for (const f of familyRows) total += f.count;
          return `${familyRows.length} 个变量族 · ${total} 条名称`;
        }, [familyRows]);

        // 窗口复位：查询或换族时回到首窗
        useEffect(() => {
          setEntryLimit(VL_WINDOW.initial);
        }, [selectedFamily, deferredEntryQuery]);
        useEffect(() => {
          setUsageLimit(VL_USAGE_WINDOW.initial);
        }, [selectedEntry]);

        // 选中条目失效（换族 / 条目表变化）→ 清详情
        useEffect(() => {
          if (
            selectedEntry &&
            (selectedEntry.family !== selectedFamily ||
              !allEntries.some((e) => String(e.index) === String(selectedEntry.index)))
          ) {
            setSelectedEntry(null);
          }
        }, [allEntries, selectedFamily, selectedEntry]);

        /* ---------- 反查：条目选中后慢建索引，建好轻推一帧 ---------- */
        const cachedUsage = usageCacheRef.current;
        const usageHot =
          selectedEntry !== null &&
          condIndex !== null &&
          cachedUsage !== null &&
          cachedUsage.src === condIndex;
        /** 缓存未命中 = 慢路径在建（全库条件索引的首次遍历交 setTimeout，不卡点选帧） */
        const usageBuilding = selectedEntry !== null && condIndex !== null && !usageHot;
        useEffect(() => {
          if (!usageBuilding || condIndex === null) return;
          const src = condIndex;
          const t = setTimeout(() => {
            usageCacheRef.current = { src, idx: buildVarUsageIndex(src) };
            setUsageTick((x) => x + 1);
          }, 0);
          return () => clearTimeout(t);
        }, [usageBuilding, condIndex]);
        const usage = useMemo(() => {
          if (!selectedEntry) return null;
          if (!usageHot || !cachedUsage) return null;
          return usagesOf(
            cachedUsage.idx,
            selectedEntry.family,
            selectedEntry.resolvedIndex ?? selectedEntry.index,
          );
          // usageTick 只用于在建好后重算；引用不直接消费
        }, [selectedEntry, usageHot, cachedUsage, usageTick]);

        /* ---------- 项目符号：包域 / 行集 / 读数 ---------- */
        const kojoPaths = currentProject?.kojoPaths ?? [];
        const libraryPaths = currentProject?.libraryPaths ?? [];
        const deferredSymbolQuery = useDeferredValue(symbolQuery);

        const packs = useMemo<PackSummary[]>(
          () => (erbIndex ? collectPacks([...erbIndex.files.keys()], kojoPaths, libraryPaths) : []),
          [erbIndex, usageTick, kojoPaths, libraryPaths],
        );

        const stats = useMemo<IndexStats | null>(() => {
          if (!erbIndex) return null;
          let functions = 0;
          for (const _name of erbIndex.byName.keys()) functions++;
          let dims = 0;
          for (const [, file] of erbIndex.files) dims += file.dims.length;
          return { files: erbIndex.files.size, functions, dims };
        }, [erbIndex, usageTick]);

        const symbolRows = useMemo<SymbolRow[]>(() => {
          if (!erbIndex) return [];
          if (deferredSymbolQuery.trim().length > 0) {
            return symbolKind === 'fn'
              ? searchFunctionRows(erbIndex, deferredSymbolQuery, selectedPack, kojoPaths, libraryPaths)
              : searchDimRows(erbIndex, deferredSymbolQuery, selectedPack, kojoPaths, libraryPaths);
          }
          // 无查询：选了包才列（全库 11 万行不该无差别铺开）
          if (selectedPack === null) return [];
          return symbolRowsForPack(erbIndex, selectedPack, kojoPaths, libraryPaths, symbolKind);
        }, [erbIndex, symbolKind, selectedPack, deferredSymbolQuery, kojoPaths, libraryPaths, usageTick]);

        useEffect(() => {
          setSymbolLimit(VL_WINDOW.initial);
        }, [symbolKind, selectedPack, deferredSymbolQuery]);

        /* ---------- 指令速查 ---------- */
        const instrTable = adapter?.kojoInstructionTable;
        const allInstrRows = useMemo<InstrRow[]>(() => {
          if (!instrTable?.hasTable) return [];
          return buildInstrRows(instrTable.names?.(), (n) => instrTable.lookupByName(n));
        }, [instrTable, usageTick]);
        const deferredInstrQuery = useDeferredValue(instrQuery);
        const instrRows = useMemo(
          () => filterInstr(allInstrRows, deferredInstrQuery),
          [allInstrRows, deferredInstrQuery],
        );
        useEffect(() => {
          setInstrLimit(VL_WINDOW.initial);
        }, [deferredInstrQuery]);

        /* ---------- 意图：复制 / 跳转 ---------- */
        const copyText = (text: string): void => {
          const clip = (globalThis as {
            navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
          }).navigator?.clipboard;
          if (!clip) {
            showNotice('当前环境没有剪贴板权限——请手动选中复制。');
            return;
          }
          void clip
            .writeText(text)
            .then(() => showNotice(`已复制：${text}`))
            .catch((err: unknown) =>
              showNotice(`复制失败：${err instanceof Error ? err.message : String(err)}`),
            );
        };

        const jumpTo = (filePath: string, line: number): void => {
          ctx.bus.emit('editor.revealLocation', {
            filePath,
            line,
            focus: true,
            source: VALUE_LOOKER_PANEL_ID,
          });
        };
        const jumpSymbol = (s: SymbolRow): void => jumpTo(s.filePath, s.line);
        const jumpUsage = (u: { fn: string; line?: number }): void => {
          if (u.line === undefined) {
            showNotice(`这条使用点没记行号；函数：${u.fn}`);
            return;
          }
          const def = erbIndex?.byName.firstOf(u.fn);
          if (!def) {
            showNotice(`没在索引里找到函数 ${u.fn}，跳不过去。`);
            return;
          }
          jumpTo(def.filePath, u.line);
        };

        /* ---------- 空态与警示 ---------- */
        const gameVersion = currentProject?.gameVersion ?? null;
        const dictWarn =
          schema?.dictionary?.loaded === false
            ? schema.dictionary.reason === 'read-error'
              ? '名词词典在位但读取失败——名称按游戏原文显示。'
              : '名词词典不在位——名称按游戏原文显示。'
            : null;
        const emptyReason =
          currentProject === null ? '打开一个项目后，这里就是你的数值速查台。' : null;

        /* ---------- 窗口增长（触底哨兵 / 显式按钮共用 growWindow） ---------- */
        const growEntries = (): void =>
          setEntryLimit((prev) => growWindow(prev, entryRows.length, VL_WINDOW) ?? prev);
        const growUsage = (): void =>
          setUsageLimit((prev) => growWindow(prev, usage?.exact.length ?? 0, VL_USAGE_WINDOW) ?? prev);
        const growSymbols = (): void =>
          setSymbolLimit((prev) => growWindow(prev, symbolRows.length, VL_WINDOW) ?? prev);
        const growInstr = (): void =>
          setInstrLimit((prev) => growWindow(prev, instrRows.length, VL_WINDOW) ?? prev);

        const snippets = useMemo(
          () => (selectedEntry ? snippetsFor(selectedEntry.family, selectedEntry) : []),
          [selectedEntry],
        );

        // 包下拉里不出现「索引外」（空壳域不渲染）；基座库保留（可浏览、带标记）
        const selectablePacks = useMemo(
          () => packs.filter((p) => p.key !== PACK_EXTERNAL),
          [packs],
        );
        // 选中包失效（索引重算后包可能消失）
        useEffect(() => {
          if (selectedPack !== null && !selectablePacks.some((p) => p.key === selectedPack)) {
            setSelectedPack(null);
          }
        }, [selectablePacks, selectedPack]);

        // 头部读数行：项目符号页显示索引规模，其余页显示字典规模
        const headNote =
          tab === 'symbols' && stats
            ? `${stats.functions} 函数 · ${stats.dims} 声明 · ${stats.files} 文件`
            : dictNote;

        const viewProps: ValueLookerViewProps = {
          activeTab: tab,
          onTab: setTab,
          gameVersion,
          headNote,
          notice,
          dictWarn,
          stats,
          emptyReason,
          familyRows: familyRowsFiltered,
          familyQuery,
          onFamilyQuery: setFamilyQuery,
          selectedFamily,
          onSelectFamily: setSelectedFamily,
          entryRows,
          entryQuery,
          onEntryQuery: setEntryQuery,
          entryLimit: vlWindowSize(entryRows.length, entryLimit),
          onGrowEntries: growEntries,
          selectedEntry,
          onSelectEntry: (e: VarEntryRow) => {
            setSelectedEntry((prev) => (prev === e ? null : e));
          },
          snippets,
          onCopy: copyText,
          usage,
          usageBuilding,
          usageLimit,
          onGrowUsage: growUsage,
          onJumpUsage: jumpUsage,
          packs: selectablePacks,
          selectedPack,
          onSelectPack: setSelectedPack,
          symbolKind,
          onSymbolKind: setSymbolKind,
          symbolQuery,
          onSymbolQuery: setSymbolQuery,
          symbolRows,
          symbolLimit: vlWindowSize(symbolRows.length, symbolLimit),
          onGrowSymbols: growSymbols,
          onJumpSymbol: jumpSymbol,
          instrRows,
          instrQuery,
          onInstrQuery: setInstrQuery,
          instrLimit: vlWindowSize(instrRows.length, instrLimit),
          onGrowInstr: growInstr,
          onCopyInstr: (r: InstrRow) => copyText(String(r.no)),
        };
        return createElement(ValueLookerView, viewProps);
      };

      ctx.slots.register('ui.panel', {
        id: VALUE_LOOKER_PANEL_ID,
        title: '数值看板',
        icon: 'search',
        // 2026-11-07：挪到 aux 组末尾——数值看板不再夹在「状态回放」(60) 与
        // 「状态注入器」(71) 中间；查阅类面板统一排到写档 / 预览之后。
        order: 80,
        location: 'aux',
        defaultActive: false,
        component: ValueLookerPanel,
      });
    },
  };
}
