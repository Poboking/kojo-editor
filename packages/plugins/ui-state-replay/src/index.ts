/**
 * @kojo/plugin-ui-state-replay
 *
 * 状态回放面板（`ui.panel` 槽贡献；v0.2 第八批，实施记录 §5.14（docs/IMPLEMENTATION-LOG.md））。
 *
 * 把三批成熟的回放引擎（`state.replay`：三值求值 + 本地量数据流 +
 * 有界内联，实测未知率 32%）第一次带上 UI：
 *   选档（`snapshot.source` 扫描）→ 选角色（`project.charaIndex`）→
 *   选函数（条件索引提示）→ 逐条谓词三值结果 + 置信度徽章 + 未知原因分组。
 *
 * 分层（"一切皆插件"）：本插件只做**呈现 + 意图**——
 *   - 求值在 state-replay 引擎、存档解析在 sav-parser、明细在 condition-extractor；
 *   - 调用上下文（ARG/ARGS 槽位）是**场景输入**，由用户填写、不猜测；
 *   - 谓词行点击 → `editor.revealLocation`（宿主消费，与校验面板同款）；
 *   - 监听 `kojo.replayFunction`（任意插件可发起的回放意图，如导航面板联动）；
 *     **订阅在激活层**，面板没挂载时意图落进闭包等待兑现，带 `locate`（从编辑器
 *     "跳到命中状态"那条键发来的位点）时面板自行浮出——按了必须有反应（铁律 4）。
 *
 * 本插件内部分三层（v1.0 收口 A3，职责归属注记见 ARCHITECTURE §5.4）：
 *   - **预览层**（`./preview.ts`：`renderReplayPreview` + `branchRow` + `PredicateList`）：
 *     把 `FunctionReplay` 渲染为 "状态 → 分支 / 文本预览"；纯逻辑（判定 / 统计）在
 *     `panel-logic.ts`，可复用。语法糖预览若做，复用 `preview.renderer` 产出的
 *     `PreviewLines[]` 渲染文本，**不自建渲染逻辑**——本层只负责"状态 → 预览数据 → 呈现"。
 *   - **激活层**（`./activation.ts`）：协议查询 + 存档清单 + 待处理回放意图（零 React）。
 *   - **面板壳层**（本文件 `ReplayPanel`）：`ui.panel` 的选档 / 选角 / 选函数 /
 *     场景参数输入 / 错误提示等交互骨架。
 *
 * C9（v1.0 收口，信任闭环；2026-11-05 P1 口径修正）：槽位**默认留空**——空 = 这一格
 * 不知道（引擎判 unknown），面板不再替作者预填 0。作者显式打开「按默认场景 0 试算」
 * 后，留空的数值槽才按 0 注入并标「假设」（虚线样式），依赖它的谓词结果标「基于假设」，
 * 分支折叠区汇总"本结果含 N 个假设参数"。
 *
 * 2026-11-05 面板可用性批（P1–P9）：输入框 = 路由模板槽 ∪ 函数体引用槽（`mergeSlotInputs`），
 * 候选值来自谓词 AST（`argSlotCandidates`），调用上下文组装是 `panel-logic` 里的纯函数
 * （`assembleCallContext`）；档案清单跟随 `snapshot.source` 的缓存与订阅（面板自带
 * 「重新扫描」）；切项目归零；结果过期与 INLINE 未计入统计都显式提示。
 *
 * 2026-11-05「状态回放彻底可用」面板批（六件事）：
 *   ① 判定文本优先级 = 编辑器**缓冲文本**（同文件且有未保存编辑）→ 磁盘；裁决是纯函数
 *      `preview.chooseReplayText`，结果区标出这一次用的是哪份（`textSourceLabel`）；
 *      正文只进 ref（逐键不重渲），未保存编辑再变会让「用缓冲文本判的」结果显式过期；
 *   ② 结果区列出**未建模写**行号（引擎 `unmodeledWrites`；前 5 条 + 省略，可点回源）；
 *   ③ 本角色**全段落体检**（批量编排 `batch.ts` / 展示 `batch-panel.ts`；与主判定同口径）；
 *   ④ 槽位候选并上**具名常量**的真实值（`const-candidates.ts`，经 `query` 注入的 IO 读盘）；
 *   ⑤ 谓词列表**筛选**（`predicate-filter.ts`；只筛渲染，统计与窗口语义不变）；
 *   ⑥ 可发现性：Ctrl+Alt+S 那条键与「有未保存编辑按缓冲文本判」写进常驻提示 / 空态。
 */

import { createElement, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ArchiveOverrides,
  ConditionExtractorService,
  FileIO,
  FunctionPredicates,
  FunctionReplay,
  KojoCallSlot,
  PredicateReplay,
  Plugin,
  PluginContextMenuAnchor,
  ProjectService,
  QuickEditField,
  ReplayCallContext,
  ReplayStateView,
  SlotRegistry,
  SnapshotSourceService,
  SnapshotWriteService,
  StateReplayService,
  UIPanelProps,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices, activeGameAdapter, growWindow, pathKey, shortPath } from '@kojo/plugin-api';
import type { AssumedSlot, LocateRequest, ReplayScene, SlotInput, SlotOrigin } from './panel-logic';
import {
  DEFAULT_SCENE_ID,
  PRED_WINDOW,
  TR_WINDOW,
  analyzeReplay,
  argSlotCandidates,
  assembleCallContext,
  browseCharaFunctions,
  classifySlotValue,
  collectAssumedSlots,
  defaultScene,
  defaultSlotText,
  diffReplays,
  exprArgSlots,
  locateNoticeFor,
  mergeSlotInputs,
  overridesForField,
  parseCallContextText,
  predicateGloss,
  predicateValues,
  replayDiffSummary,
  sanitizeScenes,
  sameSourcePath,
  sceneSuggestionName,
  slotKey,
  slotPlaceholder,
  suggestFunctionsSmart,
} from './panel-logic';
import {
  ASSUME_STYLE,
  DebugPreviewPanel,
  chooseReplayText,
  mergeSlotCandidates,
  renderReplayPreview,
  type BufferedDoc,
  type EmitReveal,
  type ReplayTextChoice,
} from './preview';
import { parseConstDeclarations, resolveConstCandidates } from './const-candidates';
import { countPredicates, type PredicateFilter } from './predicate-filter';
import { BATCH_DEFAULT_CAP, runBatchReplay, type BatchSummary } from './batch';
import { BatchPanel } from './batch-panel';
import { createReplayActivation } from './activation';
import { createSceneActions } from './scene-actions';
import {
  copyReplayText,
  openReplayPanelMenu,
  openReplayPredicateMenu,
  type ReplayMenuHost,
  type ReplayPredicateMenuTarget,
} from './context-menu';

/** 函数名提示上限 */
const SUGGEST_LIMIT = 50;
/** 本面板的贡献 id（`ui.panel` 注册与"浮起自己"那条意图共用一个真源） */
const PANEL_ID = 'state-replay';
/**
 * 场景预设的存储键——`ctx.storage` 的域 = 本插件 id（`ui-state-replay`），
 * 不与其他插件共用域（内核按 pluginId 隔离）。
 */
const SCENES_STORAGE_KEY = 'replay-scenes';
/**
 * 上次在调的那一段（口上调试 UI 打磨批）。
 *
 * 为什么必须存：副侧栏同一时刻只挂一块面板——切到「状态注入器」再切回来，
 * 回放面板是**重新挂载**的，`archivePath / charaNo / fnQuery` 三个 state 全部归零，
 * 连刚判完的结果也没了。作者的体感就是"两块功能，来回一趟白干"。
 * 存在本插件自己的域里（不跨域读别人的），切回来至少还原到"上次看的那一段"。
 */
const LAST_DEBUG_TARGET_KEY = 'last-debug-target';

/** 结果区容器用到的**最小** DOM 形状（见下方滚动处的说明：本包 root typecheck 无 DOM lib） */
interface ScrollHost {
  querySelector(selectors: string): { scrollIntoView(options?: unknown): void } | null;
}

/**
 * 上次回放目标（P4，2026-11-05）：从本插件存储域还原，**校验过才应用**——
 * 存档必须仍在当前项目的档案清单里、角色必须在当前角色表里，否则丢弃
 * （旧实现无条件 set 回去，换工程后会拿旧工程存档建视图）。
 */
interface RestoreTarget {
  archivePath?: string;
  charaNo?: number;
  fnQuery?: string;
}

/** datalist id 自增序号（同一页面可能挂多份面板实例；id 必须唯一） */
let datalistSeq = 0;

export function createUiStateReplayPlugin(): Plugin {
  return {
    id: 'ui-state-replay',
    version: '0.2.0',
    requires: [
      WellKnownServices.StateReplay,
      WellKnownServices.SnapshotSource,
      WellKnownServices.SnapshotWriter, // 口上调试统一批：注入预演的落盘手（同由 sav-parser 提供）
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
      // 常量候选（2026-11-05 常量候选批）：候选值要读「待判定函数所在文件」的文本，
      // 才能把 `#DIM CONST X = "…"` / `#DEFINE X 42` 声明的值也挂上候选
      // （`CASE OPR_战斗前` 这类「槽 == 具名常量」的分派）。
      // 只读（`io.readText`），不写盘；读失败静默降级（候选少几个，判定照常）。
      KernelServices.IO,
    ],
    activate(ctx) {
      const replay = ctx.inject<StateReplayService>(WellKnownServices.StateReplay);
      const snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const writer = ctx.inject<SnapshotWriteService>(WellKnownServices.SnapshotWriter);
      const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);
      const io = ctx.inject<FileIO>(KernelServices.IO);

      // ---- 激活层（协议查询 / 存档清单 / 待处理回放意图）：状态见 ./activation.ts ----
      const activation = createReplayActivation(ctx, { project, snapshots, slots, panelId: PANEL_ID });

      /* ------------------------------ 面板组件 ------------------------------ */

      function ReplayPanel(props: UIPanelProps): unknown {
        const [tick, force] = useState(0);
        const [archivePath, setArchivePath] = useState<string>('');
        const [charaNo, setCharaNo] = useState<number | null>(null);
        const [view, setView] = useState<ReplayStateView | null>(null);
        const [viewBusy, setViewBusy] = useState(false);
        const [viewError, setViewError] = useState<string | null>(null);
        const [fnQuery, setFnQuery] = useState('');
        const [contextText, setContextText] = useState('');
        /** 协议槽位输入（key = slotKey(kind,index)；值 = 用户文本；int 缺省 '0'、str 缺省 ''） */
        const [slotTexts, setSlotTexts] = useState<Record<string, string>>({});
        /** 协议槽位是否被作者手改过（P1：留空 + 开着「按 0 试算」且没改过 = 假设值，审阅 C9） */
        const [slotEdited, setSlotEdited] = useState<Record<string, boolean>>({});
        /** 场景预设（用户自建；内置默认场景不入存储） */
        const [scenes, setScenes] = useState<ReplayScene[]>([]);
        const [selectedSceneId, setSelectedSceneId] = useState<string>(DEFAULT_SCENE_ID);
        const [sceneNameInput, setSceneNameInput] = useState('');
        /** 场景区提示 / 冲突上报（不静默） */
        const [sceneMsg, setSceneMsg] = useState<string | null>(null);
        const [result, setResult] = useState<FunctionReplay | null>(null);
        /** 与该结果同批的假设值槽位（快照于回放时刻——改槽不影响已出结果的可信度标注） */
        const [resultAssumed, setResultAssumed] = useState<AssumedSlot[]>([]);
        /** 与该行结果同批的位点（G1：这一行的读数 + 那一行的条目高亮） */
        const [resultLocate, setResultLocate] = useState<LocateRequest | null>(null);
        /** 意图已收到但还没有存档/角色可算（不静默：先回一句"记下了"） */
        const [pendingNote, setPendingNote] = useState<string | null>(null);
        const [replayBusy, setReplayBusy] = useState(false);
        const [replayError, setReplayError] = useState<string | null>(null);
        /** 谓词渲染窗口（行数；undefined = 初始窗口——旧实现硬截 300 且第 301 条起不可达） */
        const [predWindow, setPredWindow] = useState<number | undefined>(undefined);
        /** 台词推演渲染窗口（同上；一个段落上百显示行时不许把下面的分支/谓词顶出屏外） */
        const [trWindow, setTrWindow] = useState<number | undefined>(undefined);
        /** 注入热闭环提示（同档被注入面板写盘 → 自动重算；口上调试统一批） */
        const [injectNote, setInjectNote] = useState<string | null>(null);
        /** 注入预演（口上调试统一批）：字段 / 值 / 预演结果 / 忙 / 错 / 写入二次确认 */
        const [previewFieldId, setPreviewFieldId] = useState('');
        const [previewValue, setPreviewValue] = useState('');
        const [preview, setPreview] = useState<FunctionReplay | null>(null);
        const [previewBusy, setPreviewBusy] = useState(false);
        const [previewError, setPreviewError] = useState<string | null>(null);
        const [writeArmed, setWriteArmed] = useState(false);
        const [writeNote, setWriteNote] = useState<string | null>(null);
        /**
         * 分区折叠（口上调试 UI 打磨批）：面板只有 ~300px 宽，一屏能读的东西是有限的。
         * 首屏只留「回放目标」里真正每天要动的三件（存档 / 角色 / 函数 + 判定），
         * 场景参数与场景预设默认收起——它们改了才需要展开，收起时在标题上给一行摘要，
         * 不让人怀疑"我上次改的参数是不是没了"。
         */
        const [showSlots, setShowSlots] = useState(false);
        const [showScenes, setShowScenes] = useState(false);
        /**
         * P1 开关（2026-11-05）：把留空的数值槽按 0 试算（标为假设值）。
         * 默认 **false**——面板不再替作者断言参数是 0（旧行为会把"确定的假"
         * 注入给引擎，而 API 路径同一谓词是 unknown）。
         */
        const [assumeDefaults, setAssumeDefaults] = useState(false);
        /** P2/P3/P8：当前函数的谓词明细（引用槽并集 / 候选值 / INLINE 计数都从这一份来） */
        const [fnDetail, setFnDetail] = useState<FunctionPredicates | null>(null);
        /** P5：源码已变，屏上的结果是上一次的（新结果落地即清） */
        const [resultStale, setResultStale] = useState(false);
        /**
         * 本次判定用的是哪份文本（缓冲文本批，2026-11-05）。
         * 与结果同批快照：之后作者继续打字 / 保存，都不该改写"刚才那一次判的是什么"。
         */
        const [resultTextSource, setResultTextSource] = useState<ReplayTextChoice | null>(null);
        /** D8（2026-11-05）：判定用的那份文本快照——预演复用同一份，避免「判定 v1 / 预演 v2」 */
        const judgeTextRef = useRef<ReplayTextChoice | null>(null);
        /**
         * 编辑器缓冲真相（`editor.documentChanged` 的最新一条）。
         *
         * 为什么用 ref 装正文：这是**大文本**，每键一 setState 会把整棵结果树重渲一遍；
         * 正文只在一个时刻被消费（按下「判定」组装 `textOverride`），读 ref 就够。
         * 另配一个 `bufferTick` 只在**可观察面**变化时（文件换了 / dirty 翻了）自增，
         * 让"编辑器里有未保存编辑"那句提示能自己变——纯文本变化不触发渲染。
         */
        const bufferedDocsRef = useRef<Map<string, BufferedDoc>>(new Map());
        /** 最近一条广播（只服务"编辑器里有未保存编辑"那句提示；判定本身按文件查表） */
        const latestBufferedRef = useRef<BufferedDoc | null>(null);
        const [, setBufferTick] = useState(0);
        /**
         * 条件索引代际（D1 2026-11-05）：冷启动时作者可能先打了函数名、索引随后才就绪——
         * 首次 `functionPredicates` 拿到 null 后若不再重试，面板就永远没有槽位/候选（按了没反应）。
         * `condIndex` 声明在组件更后面（直接进 deps 会 TDZ），所以用这条计数器当依赖。
         */
        const [indexTick, setIndexTick] = useState(0);
        /** 按文件取缓冲真相（键 = pathKey；本轮上限 4 份，切标签再切回来还在） */
        const bufferedFor = useCallback((path: string | null | undefined): BufferedDoc | null => {
          if (typeof path !== 'string' || path.length === 0) return null;
          return bufferedDocsRef.current.get(pathKey(path)) ?? null;
        }, []);
        const rememberBuffered = useCallback((doc: BufferedDoc): void => {
          const key = pathKey(doc.filePath);
          const map = bufferedDocsRef.current;
          map.delete(key);
          map.set(key, doc);
          while (map.size > 4) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
          }
          latestBufferedRef.current = doc;
        }, []);
        /**
         * 函数名 → 所在文件（本次会话内记住；`fnDetail` / 回放结果都是同一份事实的来路）。
         * 用途：第二次判定同一段时，即使明细还没回来，也知道该不该用缓冲文本。
         */
        const fnPathRef = useRef<Map<string, string>>(new Map());
        /** P4：上次目标（清单/角色表就绪后校验再应用；跨工程不建视图） */
        const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
        const [restoreLoaded, setRestoreLoaded] = useState(false);

        /** 触底 / 点击「显示更多」→ 按 STEP 追加（单调不减、步长有界；算式在契约层 `sugar-panels`） */
        const growPreds = useCallback((total: number): void => {
          setPredWindow((prev) => growWindow(prev, total, PRED_WINDOW)); // 无增长原样返回 prev ⇒ 跳过重渲
        }, []);
        /** 台词区「显示更多」（同一把尺、另一档参数：首屏 60 / 步长 120） */
        const growTranscript = useCallback((total: number): void => {
          setTrWindow((prev) => growWindow(prev, total, TR_WINDOW));
        }, []);
        /** 视图代际（换档/换角色时使在途 createView 作废） */
        const viewGenRef = useRef(0);
        /** 结果区容器（`locate` 到位后把对应那一条滚进视野） */
        const resultWrapRef = useRef<HTMLDivElement | null>(null);
        /** 本实例的挂载凭据（激活层用它判断"有没有人在听"） */
        const mountTokenRef = useRef<object>({});
        /** 本实例的 datalist id 前缀（同页多实例时 id 不能撞） */
        const datalistIdRef = useRef('');
        if (datalistIdRef.current === '') datalistIdRef.current = `rpdl-${++datalistSeq}`;

        /**
         * 槽位输入并集（P2）：路由模板槽 ∪ 函数体实际引用的槽。
         *
         * 函数名一变（≥2 字符）就异步取明细，用 `exprArgSlots` 扫函数体引用了哪些
         * ARG/ARGS 槽；模板没转发的槽（典型 `ARGS`）也补上输入框——旧实现只按模板
         * 渲染，那种槽根本没有输入框，作者永远填不进那一格。
         */
        const protocol = activation.currentProtocol();
        const fnNameUpper = fnQuery.trim().length >= 2 ? fnQuery.trim().toUpperCase() : '';
        const templateSlots: readonly KojoCallSlot[] =
          fnNameUpper === '' ? [] : (protocol?.slotsFor(fnNameUpper) ?? []);
        /** 项目身份（切工程后同名函数的明细必须重取：条件索引整个换了） */
        const projectKey = project.current()?.rootDir ?? '';

        useEffect(() => {
          if (fnNameUpper === '') {
            setFnDetail(null);
            return;
          }
          let cancelled = false;
          /** 明细取盘上那份只为拿 `filePath`；若编辑器里开的就是这份文件，再按缓冲文本重取一次 */
          const fetchWithBuffer = async (): Promise<void> => {
            const diskDetail = await extractor.functionPredicates(fnNameUpper);
            if (cancelled) return;
            if (diskDetail !== null) fnPathRef.current.set(diskDetail.normalizedName, diskDetail.filePath);
            const buffered = bufferedFor(diskDetail?.filePath);
            if (diskDetail !== null && buffered !== null && sameSourcePath(diskDetail.filePath, buffered.filePath)) {
              // 作者眼前是未保存/缓冲文本：槽位并集与常量候选都要按同一份文本算，
              // 否则"能填的槽位/候选"和"判定用的文本"来自两个版本。
              const bufferedDetail = await extractor.functionPredicates(fnNameUpper, buffered.text);
              if (cancelled) return;
              setFnDetail(bufferedDetail ?? diskDetail);
              return;
            }
            setFnDetail(diskDetail);
          };
          void fetchWithBuffer().catch((err: unknown) => {
            if (cancelled) return;
            ctx.log.warn(`Replay panel function detail failed: ${String(err)}`);
            setFnDetail(null);
          });
          return () => {
            cancelled = true;
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [fnNameUpper, projectKey, indexTick]);

        /** 函数体引用的槽（明细变化才重扫；谓词可能有几百条，逐帧扫不划算） */
        const detailRefs = useMemo(() => {
          const ints = new Set<number>();
          const strs = new Set<number>();
          for (const p of fnDetail?.predicates ?? []) {
            const r = exprArgSlots(p.expr);
            for (const i of r.ints) ints.add(i);
            for (const i of r.strs) strs.add(i);
          }
          return { ints: [...ints].sort((a, b) => a - b), strs: [...strs].sort((a, b) => a - b) };
        }, [fnDetail]);
        /** 渲染与组装共用的输入并集（模板在前、引用独有槽补后；同 kind+index 去重） */
        const slotInputs: SlotInput[] = mergeSlotInputs(templateSlots, detailRefs);
        const slotSignature = slotInputs.map((s) => `${s.kind}${s.index}`).join('|');
        /**
         * P4 常量候选（2026-11-05）：`CASE OPR_战斗前` 这类「槽 == 具名常量」比较里，
         * 候选值应该是一行顶部 `#DIM CONST OPR_战斗前 = "战斗前"` 的真实值，而不是空。
         *
         * 文本来源**优先用编辑器缓冲文本**（若开着的正是这份文件）：常量声明作者可能
         * 刚改过，用磁盘那份就会给出旧候选；拿不到缓冲才退回读盘。
         * 只有存在 ARG/ARGS 槽时才去取（没槽的函数读来也没用，省一次 IO）；
         * 读失败 / 解析不出常量 → 静默降级为空（候选少几个，判定照常，不打扰作者）。
         */
        const [constCandidates, setConstCandidates] = useState<Map<string, string[]> | null>(null);
        useEffect(() => {
          const d = fnDetail;
          if (d === null || slotInputs.length === 0) {
            setConstCandidates(null);
            return;
          }
          let cancelled = false;
          const buffered = bufferedFor(d.filePath);
          const textOfFile =
            buffered !== null && sameSourcePath(d.filePath, buffered.filePath)
              ? Promise.resolve(buffered.text)
              : io.readText(d.filePath).then((f) => f.text);
          void textOfFile
            .then((text) => {
              if (cancelled) return;
              const consts = parseConstDeclarations(text);
              setConstCandidates(consts.size === 0 ? null : resolveConstCandidates(d.predicates, consts));
            })
            .catch((err: unknown) => {
              if (cancelled) return;
              // 读盘失败只影响候选，不影响判定——降级但不吵人（排障留在日志里）
              ctx.log.warn(`Replay panel const candidates skipped: ${String(err)}`);
              setConstCandidates(null);
            });
          return () => {
            cancelled = true;
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [fnDetail, slotSignature]);
        /**
         * P3：候选值（键 = slotKey）——**两路并集**：谓词里的字面量（`argSlotCandidates`）
         * + 具名常量的真实值（`resolveConstCandidates`），槽内去重、base 在前。
         */
        const slotCandidates = useMemo(
          () => mergeSlotCandidates(argSlotCandidates(fnDetail?.predicates ?? []), constCandidates),
          [fnDetail, constCandidates],
        );
        /**
         * 谓词筛选（2026-11-05 筛选批）：只影响**渲染**（统计 / 分支 / 台词区仍按全量算），
         * 窗口作用于筛后列表。状态放在这里，筛选行由预览层画（它才握着谓词数组）。
         */
        const [predFilter, setPredFilter] = useState<PredicateFilter>({ kind: 'all', query: '' });
        /** 筛选行的档位计数（全量谓词现算；`availableFilters` 在预览层按计数挑档位） */
        const predCounts = useMemo(() => countPredicates(result?.predicates ?? []), [result]);

        // 槽位初始化（P7）：函数名 + 并集槽签名任一变化 → 清空输入、手改标记清零。
        // 依赖里必须有**函数名本身**：两个函数槽签名相同时，旧函数的实参不能被当成
        // 本函数的 manual 输入（`slotEdited` 清零也挡不住值还在）。
        useEffect(() => {
          const init: Record<string, string> = {};
          for (const s of slotInputs) init[slotKey(s.kind, s.index)] = defaultSlotText(s.kind);
          setSlotTexts(init);
          setSlotEdited({});
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [fnNameUpper, slotSignature]);

        // ---- 场景预设：挂载时从存储域加载（域 = 本插件 id，内核按 pluginId 隔离） ----
        useEffect(() => {
          let cancelled = false;
          void ctx.storage
            .get<unknown>(SCENES_STORAGE_KEY)
            .then((raw) => {
              // 函数式更新：若挂载后用户已抢先保存过场景，则不覆盖（避免慢加载回滚新数据）
              if (!cancelled) setScenes((prev) => (prev.length > 0 ? prev : sanitizeScenes(raw)));
            })
            .catch((err: unknown) => {
              if (!cancelled) ctx.log.warn(`Replay panel scene load failed: ${String(err)}`);
            });
          return () => {
            cancelled = true;
          };
        }, []);

        /**
         * 上次在调的那一段：挂载时读存储、**校验后**还原、变化时落盘。
         *
         * P4（2026-11-05）：旧实现把存储里的 `archivePath` / `charaNo` 无条件 set 回去。
         * 换工程后那个路径往往已经不属于当前项目，面板会拿旧工程存档建视图（旧结果
         * 还会继续显示）。现在先只把目标记下来，等档案清单 / 角色表就绪后再校验：
         * 存档必须仍在 `activation.archives` 里、角色必须在当前 `charaIndex` 里，
         * 不在就丢弃。
         *
         * 还原只在"用户还没自己选过"时生效（函数式更新判空），慢回包不会顶掉新选择；
         * 落盘在还原判定之后才开始（`uiRestoredRef`），否则首帧的空值会先把记录盖掉。
         */
        const uiRestoredRef = useRef(false);
        const restoreAppliedRef = useRef(false);
        useEffect(() => {
          void ctx.storage
            .get<{ archivePath?: unknown; charaNo?: unknown; fnQuery?: unknown }>(LAST_DEBUG_TARGET_KEY)
            .then((v) => {
              if (!v || typeof v !== 'object') return;
              const target: RestoreTarget = {};
              if (typeof v.archivePath === 'string' && v.archivePath !== '') target.archivePath = v.archivePath;
              if (typeof v.charaNo === 'number') target.charaNo = v.charaNo;
              if (typeof v.fnQuery === 'string' && v.fnQuery !== '') target.fnQuery = v.fnQuery;
              setRestoreTarget(Object.keys(target).length > 0 ? target : null);
            })
            .catch((err: unknown) => ctx.log.warn(`Replay panel target restore failed: ${String(err)}`))
            .finally(() => setRestoreLoaded(true));
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const persistScenes = (next: ReplayScene[]): void => {          setScenes(next);
          void ctx.storage.set(SCENES_STORAGE_KEY, next).catch((err: unknown) => {
            ctx.log.warn(`Replay panel scene persist failed: ${String(err)}`);
            setSceneMsg('场景写入本地存储失败（本次会话仍可用）');
          });
        };

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          activation.listeners.add(cb);
          return () => {
            activation.listeners.delete(cb);
          };
        }, []);

        // 角色列表（project.charaIndex；项目切换由 force 刷新驱动重读）
        const projectNow = project.current();
        const charaEntries = [...(projectNow?.charaIndex.entries() ?? [])].sort((a, b) => a[0] - b[0]);
        const charaKey = charaEntries.map(([no]) => no).join(',');
        const archivesKey = activation.archives.map((a) => a.path).join('|');

        // ---- 上次目标：清单/角色表就绪后校验再应用（P4） ----
        useEffect(() => {
          if (!restoreLoaded || restoreAppliedRef.current) return;
          const target = restoreTarget;
          // 清单还没就绪且确实有存档要还原 → 等它（扫描失败会变成就绪 + 显式错误，不会永远等）
          if (target?.archivePath !== undefined && !activation.archivesReady) return;
          if (target) {
            if (target.archivePath !== undefined && activation.archives.some((a) => a.path === target.archivePath)) {
              const p = target.archivePath;
              setArchivePath((prev) => (prev === '' ? p : prev));
            }
            if (target.charaNo !== undefined && charaEntries.some(([no]) => no === target.charaNo)) {
              const n = target.charaNo;
              setCharaNo((prev) => (prev === null ? n : prev));
            }
            if (target.fnQuery !== undefined) {
              const q = target.fnQuery;
              setFnQuery((prev) => (prev === '' ? q : prev));
            }
          }
          restoreAppliedRef.current = true;
          uiRestoredRef.current = true;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [restoreLoaded, restoreTarget, activation.archivesReady, archivesKey, charaKey]);
        // ---- 上次目标落盘（还原判定之后才开始，避免首帧空值盖掉记录） ----
        useEffect(() => {
          if (!uiRestoredRef.current) return;
          void ctx.storage
            .set(LAST_DEBUG_TARGET_KEY, { archivePath, charaNo, fnQuery })
            .catch((err: unknown) => ctx.log.warn(`Replay panel target persist failed: ${String(err)}`));
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [archivePath, charaNo, fnQuery]);

        /**
         * 切项目归零（P4）：面板此前**不响应项目事件**——换工程后旧存档的视图、
         * 旧结果、旧场景输入全留着继续用。project.opened / project.closed 来了
         * 就清空"属于某个工程"的一切 state（函数名留着手打，它不绑定工程）。
         */
        useEffect(() => {
          const resetForProject = (): void => {
            setArchivePath('');
            setCharaNo(null);
            setView(null);
            setViewError(null);
            setResult(null);
            setResultAssumed([]);
            setResultLocate(null);
            setResultStale(false);
            setResultTextSource(null);
            setContextText('');
            setSlotTexts({});
            setSlotEdited({});
            setFnDetail(null);
            setPreview(null);
            setPreviewError(null);
            setPendingNote(null);
            setInjectNote(null);
          };
          const offOpen = ctx.bus.on('project.opened', resetForProject);
          const offClose = ctx.bus.on('project.closed', resetForProject);
          return () => {
            offOpen();
            offClose();
          };
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // ---- 换档/换角色 → 重建视图（代际保护） ----
        useEffect(() => {
          let cancelled = false;
          const gen = ++viewGenRef.current;
          setView(null);
          setViewError(null);
          setResult(null);
          setResultAssumed([]);
          setResultLocate(null);
          setResultTextSource(null);
          if (!archivePath || charaNo === null) {
            return;
          }
          setViewBusy(true);
          void replay
            .createView(archivePath, charaNo)
            .then((v) => {
              if (cancelled || gen !== viewGenRef.current) return;
              setView(v);
            })
            .catch((err: unknown) => {
              if (cancelled || gen !== viewGenRef.current) return;
              setViewError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
              if (cancelled || gen !== viewGenRef.current) return;
              setViewBusy(false);
            });
          return () => {
            cancelled = true;
          };
        }, [archivePath, charaNo]);

        // ---- 挂载凭据（激活层的意图分发要看"有没有实例在听"） ----
        useEffect(() => {
          activation.mounted.add(mountTokenRef.current);
          return () => {
            activation.mounted.delete(mountTokenRef.current);
          };
        }, []);

        /**
         * 存档联动（口上调试 UI 打磨批）：「作者现在在看哪一档」只该有一份事实。
         * 回放与注入面板各扫同一条 sav 目录，但此前各选各的——在回放里挑好档，
         * 切过去改数值时要再挑一遍，这正是"两块功能"的观感来源之一。
         *
         * 通道复用既有的 `kojo.snapshotSelected`（归档浏览器与注入面板早已在这条通道上，
         * 零新增契约）：本面板**也广播**（仅在作者显式选档时）、**也跟随**。
         * 跟随只在路径真的不同时 setState ⇒ 自己发的那一条回到自己身上也不会多算一轮。
         */
        useEffect(() => {
          const un = ctx.bus.on('kojo.snapshotSelected', (p) => {
            setArchivePath((prev) => (prev === p.path ? prev : p.path));
          });
          return un;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // 经 ref 调用最新的 runReplay（M5 修复：deps 不含 view 时旧闭包
        // 会拿到挂接时刻的 view=null，误报"请先选择存档与角色"）。
        const runReplayRef = useRef<(nameOverride?: string, locate?: LocateRequest | null) => void>(null);
        /** 回放在途标志（ref 口径）：Enter 与按钮同门，同一次在途不并发第二回放 */
        const replayBusyRef = useRef(false);

        // ---- 回放意图（G1：订阅在激活层，这里只消费落在闭包里的待处理项） ----
        // 依赖 `[tick, view]`：意图到达（tick 变）或有存档视图了（用户刚选完档）都再试一次。
        // 没有视图时**不**吞掉待处理项——只回一句"记下了"，选完档自动兑现，
        // 这样"按了没反应"在这一路不可能发生（铁律 4）。
        useEffect(() => {
          const request = activation.pending;
          if (!request) return;
          setFnQuery(request.functionName);
          if (!view) {
            setPendingNote(`已记下 ${request.functionName}——选好存档和角色后，这一行的结果会直接给出。`);
            return;
          }
          activation.pending = null;
          setPendingNote(null);
          runReplayRef.current?.(request.functionName, request.locate ?? null);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [tick, view]);

        /**
         * 待判定函数所在文件（缓冲文本口径的输入，缓冲文本批 2026-11-05）。
         *
         * 三条来路，按新鲜度排：当前明细（刚查的）→ 屏上结果（上次判的）→ 会话记忆
         * （`fnPathRef`，明细/结果到达时顺手记下）。都没有 → null = 不知道，按磁盘判。
         * 为什么不拿"编辑器当前文件"顶替：那是**猜**——判的是另一份文件时，
         * 把手上这份缓冲文本塞进去，解析出来的会是另一个函数（静默错答案比不知道更坏）。
         */
        /** D5（2026-11-05）：条件索引里的 filePath 兜底（批量体检里绝大多数名字没有明细/结果记忆） */
        const condPathRef = useRef<(name: string) => string | undefined>(() => undefined);
        const functionPath = (name: string): string | null =>
          (fnDetail !== null && fnDetail.normalizedName === name ? fnDetail.filePath : undefined) ??
          (result !== null && result.normalizedName === name ? result.filePath : undefined) ??
          fnPathRef.current.get(name) ??
          condPathRef.current(name) ??
          null;

        /** 本次判定该用哪份文本（纯函数在 `preview.chooseReplayText`；这里只喂事实） */
        const textChoiceFor = (name: string): ReplayTextChoice =>
          (() => {
            const path = functionPath(name);
            return chooseReplayText(path, bufferedFor(path));
          })();

        const runReplay = (nameOverride?: string, locate: LocateRequest | null = null): void => {
          // 2026-10-16 busy 同门：按钮 disabled 只拦鼠标，Enter 直调绕过拦截——
          // 并发回放结果乱序覆盖。统一在函数入口同门拦截（ref 口径，防同 tick 双击）。
          if (replayBusyRef.current) return;
          const name = (nameOverride ?? fnQuery).trim().toUpperCase();
          setReplayError(null);
          setInjectNote(null); // 重算完成即撤热闭环提示
          if (!name) {
            setReplayError('先写下要看的那一段的名字。');
            return;
          }
          if (!view) {
            setReplayError('先在这块面板里选好存档和角色——没有存档，就谈不上"这行走不走"。');
            return;
          }
          const assembled = assembleContext();
          if (assembled.error !== null) {
            setReplayError(assembled.error);
            return;
          }
          // 假设值快照（C9 / P1）：与本结果同批——留空且开了「按 0 试算」的数值槽
          // 记入"基于假设"标注（改了槽不影响已出结果的可信度标注）
          const assumedAtRun = collectAssumedSlots(slotInputs, slotTexts, slotEdited, assumeDefaults);
          // 文本来源快照（缓冲文本批）：同文件 + 有未保存编辑 → 交 `textOverride`，
          // 引擎与取行都用缓冲文本，判定与作者眼前看到的字一致
          const textChoice = textChoiceFor(name);
          replayBusyRef.current = true;
          setReplayBusy(true);
          void replay
            .replayFunction(view, name, {
              callContext: assembled.callContext,
              ...(textChoice.textOverride !== undefined ? { textOverride: textChoice.textOverride } : {}),
            })
            .then((r) => {
              if (r === null) {
                setReplayError(`这一段没有登记到可判定的条件（名字：${name}）——多半是这段里根本没有条件语句，或者它没进条件索引。`);
                setResult(null);
                setResultAssumed([]);
                setResultLocate(null);
                setResultStale(false);
                setResultTextSource(null);
                return;
              }
              fnPathRef.current.set(r.normalizedName, r.filePath);
              setResult(r);
              setResultAssumed(assumedAtRun);
              setResultLocate(locate);
              setResultStale(false); // P5：新结果落地 → 过期标记清掉
              setResultTextSource(textChoice); // 结果区口径标记（磁盘 / 缓冲）
              judgeTextRef.current = textChoice; // D8：预演复用「判定那一刻」的文本快照
              setPredWindow(undefined); // 新一批谓词 = 新窗口（每次回放从初始窗口看起）
            })
            .catch((err: unknown) => {
              setReplayError(err instanceof Error ? err.message : String(err));
              setResultLocate(null);
            })
            .finally(() => {
              replayBusyRef.current = false;
              setReplayBusy(false);
            });
        };
        runReplayRef.current = runReplay;

        /**
         * 调用上下文组装（P1：**已抽成 `panel-logic.assembleCallContext` 纯函数**）。
         * 这里只做接线：输入并集 + 输入文本 + 手改标记 + 「按 0 试算」开关。
         * 预演与正式回放必须用**同一份**场景输入，否则"预演说要变、写入后没变"
         * ——两个动作两个判据正是要消灭的割裂。
         */
        const assembleContext = (): { callContext?: ReplayCallContext; error: string | null } =>
          assembleCallContext({ slotInputs, slotTexts, slotEdited, assumeDefaults, contextText });

        // ---- 注入热闭环（口上调试统一批）：同一份存档被注入面板写盘后自动重算 ----
        // 订阅在挂载期；同档才重算（作者选的档是唯一事实），异档不打扰。
        const archivePathRef = useRef('');
        archivePathRef.current = archivePath;
        useEffect(
          () =>
            ctx.bus.on('debug.snapshotInjected', (e) => {
              if (archivePathRef.current !== e.archivePath) return;
              setInjectNote('这份存档刚在注入面板里被更新，正在重算…');
              runReplayRef.current?.();
            }),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [],
        );

        // ---- P5 结果过期（2026-11-05）：判定读的是**磁盘上的文件** ----
        // 源码索引重建（保存后触发）→ 屏上的结果就不再对应当前文本，必须显式告知。
        // 用 ref 读"当前有没有结果"，订阅只挂一次（身份恒定，不因结果变化重订阅）。
        const hasResultRef = useRef(false);
        hasResultRef.current = result !== null;
        useEffect(
          () =>
            ctx.bus.on('kojo.functionChanged', () => {
              setIndexTick((n) => n + 1); // 索引代际：让明细 effect 重取（冷启动竞态，D1）
              if (hasResultRef.current) setResultStale(true);
            }),
          [],
        );

        /**
         * 编辑器缓冲真相（缓冲文本批，2026-11-05）：宿主每次改动都广播当前文件全文。
         *
         * **只进 ref、不进 state**：正文是整份文件，逐键 setState 会把结果树重渲一遍。
         * 真正需要重渲的只有「可观察面」——文件换了 / 未保存标记翻了（`bufferTick`）；
         * 纯文本变化由 ref 承载，「判定」按下那一刻才读（那里拿到的一定是最新全文）。
         *
         * 另外，**用缓冲文本判出来的结果**会跟着正文继续变化而过期（与 P5 同口径：
         * 屏上的结论必须对得上它读的那份字）；用磁盘文本判的不受影响。
         */
        const resultBufferPathRef = useRef<string | null>(null);
        resultBufferPathRef.current =
          result !== null && resultTextSource !== null && resultTextSource.source === 'buffer' ? result.filePath : null;
        useEffect(
          () =>
            ctx.bus.on('editor.documentChanged', (ev) => {
              const prev = bufferedFor(ev.filePath);
              rememberBuffered({ filePath: ev.filePath, text: ev.text, dirty: ev.dirty });
              if (prev === null || prev.dirty !== ev.dirty || !sameSourcePath(prev.filePath, ev.filePath)) {
                setBufferTick((n) => n + 1);
              }
              const judgedPath = resultBufferPathRef.current;
              if (judgedPath !== null && sameSourcePath(judgedPath, ev.filePath)) setResultStale(true);
            }),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [],
        );

        /* ------------------- 场景预设（命名保存 / 一键应用 / 删除） ------------------- */

        const allScenes: ReplayScene[] = [defaultScene(), ...scenes];
        const selectedScene = allScenes.find((s) => s.id === selectedSceneId) ?? allScenes[0]!;
        /** 建议名：协议可用时由槽位 label 拼接；协议不可用 → 空串（降级纯手填） */
        const sceneSuggestion = slotInputs.length > 0 ? sceneSuggestionName(slotInputs, slotTexts) : '';

        /** 场景三个动作（应用 / 保存 / 删除）的具体过程见 ./scene-actions.ts */
        const sceneActions = createSceneActions({
          // 并集输入（P2）：场景能命中的槽位跟着输入框走，模板不转发的引用槽也能存进场景
          callSlots: slotInputs.length > 0 ? slotInputs : null,
          slotTexts,
          contextText,
          scenes,
          selectedScene,
          sceneNameInput,
          sceneSuggestion,
          setSlotTexts,
          setSlotEdited,
          setContextText,
          setSelectedSceneId,
          setSceneNameInput,
          setSceneMsg,
          persistScenes,
        });

        // ---- 上下文输入即时校验（红字提示，不阻塞输入） ----
        const contextParse = parseCallContextText(contextText);
        const contextHint =
          contextText.trim().length > 0 && !contextParse.ok
            ? `语法：槽位=值（如 0=36, 1="文本"）— ${contextParse.detail}`
            : null;

        // ---- 函数名提示（白话批两路）：中文标签命中 + 函数名命中 ----
        // PS-7 两处收口：①**逐键打字走 deferred**（口径同导航面板：输入框即时响应，
        // 三万个名字的扫描只对已落定的查询值跑）；②**不再摊平名字表**。白话批在此之上
        // 对齐注入面板的可发现性：搜索词同时匹配条件变量的**中文标签**（与注入面板同一
        // 份 variableSchema 词典）——搜「好感」就能找到判好感的那些段。
        const condIndex = extractor.currentIndex();
        // D5：把条件索引的 filePath 供给 unctionPath（批量体检时没有明细记忆也能走缓冲文本口径）
        condPathRef.current = (name) => condIndex?.byFunction.get(name)?.filePath;
        const deferredFnQuery = useDeferredValue(fnQuery);
        const suggestions = useMemo(() => {
          if (!condIndex) return [];
          const q = deferredFnQuery.trim();
          if (q.length < 2) return [];
          return suggestFunctionsSmart(condIndex, q, SUGGEST_LIMIT);
        }, [condIndex, deferredFnQuery]);
        // 角色浏览（输入为空时）：选好角色就给「这个角色的段落」当浏览入口，
        // 不再强迫小白先知道函数名。命中不了 → 不渲染（不猜）。
        const charaBrowse = useMemo(() => {
          if (!condIndex || charaNo === null || deferredFnQuery.trim().length > 0) return [];
          return browseCharaFunctions(condIndex.byFunction.keys(), charaNo, SUGGEST_LIMIT);
        }, [condIndex, charaNo, deferredFnQuery]);

        /* ------------------- 批量体检（2026-11-05：本角色全段落一次过） -------------------
         *
         * 单函数判定回答「这一段走不走」；作者真正要问的常常是「这个档、我这个角色，
         * 哪些段落我判不出来」。编排在 `./batch.ts`（串行 + 可取消 + cap），展示在
         * `./batch-panel.ts`，这里只做**接线**：
         * - 名字集合 = 条件索引里命中本角色（`_K{charaNo}_`）的函数（与「角色浏览」
         *   同一把尺 `browseCharaFunctions`，不另抄一份正则）；
         * - 每段回放与主判定**同口径**（同一份 callContext + 同一份文本来源选择）；
         * - 点结果行的函数名 → 回填 + 直接判定（`runReplay(name)`，不是"填完等你再点"）。
         */
        const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);
        const [batchBusy, setBatchBusy] = useState(false);
        const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
        const [batchError, setBatchError] = useState<string | null>(null);
        /** 取消旗标（ref 口径：编排层每段开始前读一次；批量回放不因面板重渲丢状态） */
        const batchCancelRef = useRef(false);
        /** D8：面板卸载 = 没人看结果了，在途批量立刻收尾（不许跑完 1,500 段再丢） */
        useEffect(() => () => { batchCancelRef.current = true; }, []);
        /** 本角色的全部段落名（按索引顺序；cap 截断由 `runBatchReplay` 报 `remaining`） */
        const batchNames = useMemo(() => {
          if (!condIndex || charaNo === null) return [];
          return browseCharaFunctions(condIndex.byFunction.keys(), charaNo, Number.MAX_SAFE_INTEGER);
        }, [condIndex, charaNo]);

        // 换档 / 换角色 = 换了一次体检的对象：在途那批作废，屏上的汇总也清掉（不拿旧结论冒充）
        useEffect(() => {
          batchCancelRef.current = true;
          setBatchSummary(null);
          setBatchProgress(null);
          setBatchError(null);
          setBatchBusy(false);
        }, [archivePath, charaNo]);

        const runBatch = (): void => {
          if (batchBusy) return;
          if (view === null) {
            setBatchError('先选好存档和角色——体检是在某一档上逐段回放。');
            return;
          }
          if (batchNames.length === 0) {
            setBatchError(
              charaNo === null
                ? '先选一个角色：体检按角色圈定段落。'
                : `条件索引里没有命中 _K${charaNo}_ 的段落（这个角色也许还没有口上）。`,
            );
            return;
          }
          const assembled = assembleContext();
          if (assembled.error !== null) {
            setBatchError(assembled.error);
            return;
          }
          const v = view;
          const cc = assembled.callContext;
          batchCancelRef.current = false;
          setBatchBusy(true);
          setBatchError(null);
          setBatchSummary(null);
          setBatchProgress({ done: 0, total: Math.min(batchNames.length, BATCH_DEFAULT_CAP) });
          void runBatchReplay({
            names: batchNames,
            cap: BATCH_DEFAULT_CAP,
            isCancelled: () => batchCancelRef.current,
            // D8（2026-11-05）：上限 1,500 段时逐段 setState 会把整棵结果树重渲 1,500 次。
            // 节流到"每 20 段或每 200ms，且首尾必发"，进度条照样走、渲染次数砍两个数量级。
            onProgress: (() => {
              let lastAt = 0;
              let lastDone = -1;
              return (done: number, total: number) => {
                const now = Date.now();
                if (done !== total && done - lastDone < 20 && now - lastAt < 200) return;
                lastAt = now;
                lastDone = done;
                setBatchProgress({ done, total });
              };
            })(),
            replay: (name) => {
              // 与主判定同口径：文本来源也走同一条裁决（同文件 + 有未保存编辑 → 缓冲文本）
              const textChoice = textChoiceFor(name);
              return replay.replayFunction(v, name, {
                callContext: cc,
                ...(textChoice.textOverride !== undefined ? { textOverride: textChoice.textOverride } : {}),
              });
            },
          })
            .then((s) => {
              setBatchSummary(s);
            })
            .catch((err: unknown) => {
              setBatchError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
              setBatchBusy(false);
            });
        };

        /** 批量体检区（段头 / 进度 / 取消 / 汇总 / 最该看的段落；组件在 `./batch-panel.ts`） */
        const batchSection =
          charaNo === null
            ? null
            : createElement(BatchPanel, {
                busy: batchBusy,
                progress: batchProgress,
                summary: batchSummary,
                error: batchError,
                canRun: view !== null && batchNames.length > 0 && !replayBusy,
                runLabel: '本角色全段落体检',
                runHint: `逐段回放 K${charaNo} 的全部段落（单次上限 ${BATCH_DEFAULT_CAP} 段），汇总完全判定 / 部分 / 全未知`,
                emptyNote: `点上面的按钮：会逐段回放 K${charaNo} 的全部段落（条件索引里命中 _K${charaNo}_ 的 ${batchNames.length} 段），汇总哪些完全判定、哪些判不出。`,
                onRun: runBatch,
                onCancel: () => {
                  batchCancelRef.current = true;
                },
                onPickFunction: (name: string) => {
                  setFnQuery(name);
                  runReplay(name);
                },
              });


        // ---- 选档/选角色 ----
        const archiveSelect = createElement(
          'select',
          {
            className: 'rp-select',
            value: archivePath,
            onChange: (e: { target: { value: string } }) => {
              const next = e.target.value;
              setArchivePath(next);
              // 广播给同一条通道上的注入面板 / 归档浏览器（同一份"当前档"，见上面的联动 effect）
              const entry = activation.archives.find((a) => a.path === next);
              if (entry) {
                ctx.bus.emit('kojo.snapshotSelected', {
                  path: entry.path,
                  fileName: entry.fileName,
                  source: 'ui-state-replay',
                });
              }
            },
          },
          createElement(
            'option',
            { value: '' },
            activation.archivesReady ? `选择存档（${activation.archives.length}）` : '扫描存档中…',
          ),
          ...activation.archives.map((a) =>
            createElement(
              'option',
              { key: a.path, value: a.path },
              `${a.fileName}${a.saveMes ? ` · ${a.saveMes.slice(0, 24)}` : ''}`,
            ),
          ),
        );
        const charaSelect = createElement(
          'select',
          {
            className: 'rp-select',
            value: charaNo === null ? '' : String(charaNo),
            onChange: (e: { target: { value: string } }) => setCharaNo(e.target.value === '' ? null : Number(e.target.value)),
          },
          createElement('option', { value: '' }, `选择角色（${charaEntries.length}）`),
          ...charaEntries.map(([no, info]) =>
            createElement('option', { key: no, value: String(no) }, `K${no} ${info.name}`),
          ),
        );
        /**
         * 「重新扫描」按钮（P4）：面板自己的出路。
         * 旧空态文案让人"去状态注入器重扫"——那边扫完也不通知本面板，是条死路；
         * 这里就地能重扫（并跟 `snapshot.source` 的订阅一起，两个面板的清单口径同源）。
         */
        const rescanBtn = createElement(
          'button',
          {
            className: 'ghost small',
            type: 'button',
            disabled: activation.scanning || !activation.archivesReady,
            onClick: () => activation.rescan(),
            title: '重新扫描项目存档目录（在游戏内存档后点这个）',
          },
          activation.scanning ? '扫描中…' : '重新扫描',
        );

        // ---- 视图状态行 ----
        let viewStatus: ReturnType<typeof createElement> | null = null;
        if (viewBusy) viewStatus = createElement('div', { className: 'rp-status dim' }, '解析存档并建立视图…');
        else if (viewError) viewStatus = createElement('div', { className: 'rp-status rp-error' }, `视图建立失败：${viewError}`);
        else if (view)
          viewStatus = createElement(
            'div',
            { className: 'rp-status dim' },
            `视图就绪：K${view.characterNo}${view.characterName ? ` ${view.characterName}` : ''} · ${shortPath(view.archivePath)}`,
          );

        // ---- 函数名行 ----
        const fnInput = createElement('input', {
          className: 'rp-fn-input',
          type: 'text',
          placeholder: '函数名，或中文（好感）',
          value: fnQuery,
          onChange: (e: { target: { value: string } }) => setFnQuery(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Enter') runReplay();
          },
        });
        /**
         * 槽位输入区（P1/P2/P3，2026-11-05）：
         * - **并集**（P2）：`slotInputs` = 路由模板槽 ∪ 函数体引用的槽——模板不转发的
         *   `ARGS` 也有输入框了；并集为空才退回裸上下文文本框（由调用处判）。
         * - **默认空**（P1）：值恒空（留空 = 这一格不知道）。占位符只说明含义；
         *   勾了「按默认场景 0 试算」后数值槽占位符写「0（假设）」，并在组装时按 0 注入。
         * - **假设值**（C9）：来源三态由 `classifySlotValue` 判（空 + 开关 + 未手改），
         *   虚线 + 「假设」徽章，与作者手填的值视觉可区分（不伪装成确定命中）。
         * - **候选值**（P3）：明细里扫到的「槽 == 字面量」值挂 `datalist`，点了就填。
         */
        const slotDatalists: ReturnType<typeof createElement>[] = [];
        const slotInputsEl =
          slotInputs.length > 0
            ? createElement(
                'div',
                { className: 'rp-slots' },
                createElement('span', { className: 'dim rp-slots-head' }, '场景参数'),
                ...slotInputs.map((s) => {
                  const k = slotKey(s.kind, s.index);
                  const origin: SlotOrigin = classifySlotValue(s.kind, slotTexts[k] ?? '', slotEdited[k] === true, assumeDefaults);
                  const isAssume = origin === 'assumption';
                  const candidates = slotCandidates.get(k);
                  const listId =
                    candidates && candidates.length > 0 ? `${datalistIdRef.current}-${s.kind}-${s.index}` : undefined;
                  if (listId !== undefined && candidates) {
                    slotDatalists.push(
                      createElement(
                        'datalist',
                        { key: `dl-${k}`, id: listId },
                        ...candidates.map((c) => createElement('option', { key: c, value: c })),
                      ),
                    );
                  }
                  const idxText = `${s.kind === 'str' ? 'ARGS' : 'ARG'}:${s.index}`;
                  return createElement(
                    'label',
                    { key: k, className: 'rp-slot', title: isAssume ? `${s.label}（按默认场景 0 试算的假设值）` : s.label },
                    isAssume
                      ? createElement(
                          'span',
                          {
                            className: 'rp-badge assume',
                            style: ASSUME_STYLE,
                            title: '按默认场景 0 试算的假设值（不是引擎事实，也不等于作者给的值）',
                          },
                          '假设',
                        )
                      : null,
                    createElement('span', { className: 'dim rp-slot-idx' }, s.label ? `${s.label} · ${idxText}` : idxText),
                    createElement('input', {
                      className: 'rp-slot-input',
                      style: isAssume ? ASSUME_STYLE : undefined,
                      type: 'text',
                      value: slotTexts[k] ?? '',
                      placeholder: slotPlaceholder(s.kind, assumeDefaults),
                      title: candidates && candidates.length > 0 ? `这个槽在函数里比过的值：${candidates.join(' / ')}「点输入框可选」` : s.label,
                      ...(listId !== undefined ? { list: listId } : {}),
                      onChange: (e: { target: { value: string } }) => {
                        const v = e.target.value;
                        setSlotTexts((prev) => ({ ...prev, [k]: v }));
                        setSlotEdited((prev) => ({ ...prev, [k]: true })); // 手改 → 作者给的场景值
                      },
                    }),
                  );
                }),
                ...slotDatalists,
                createElement(
                  'span',
                  { className: 'dim rp-slot-hint' },
                  '留空 = 这一格不知道（面板会推导已知事实，其余标未知）；填值 = 场景假设',
                ),
              )
            : null;
        // ---- 场景预设工具栏（下拉切换 + 一键应用 / 保存 / 删除） ----
        const sceneSelect = createElement(
          'select',
          {
            className: 'rp-select',
            style: { flex: '1 1 160px' },
            value: selectedScene.id,
            onChange: (e: { target: { value: string } }) => {
              setSelectedSceneId(e.target.value);
              setSceneMsg(null);
            },
          },
          ...allScenes.map((s) =>
            createElement('option', { key: s.id, value: s.id }, s.id === DEFAULT_SCENE_ID ? s.name : `场景：${s.name}`),
          ),
        );
        const applySceneBtn = createElement(
          'button',
          { className: 'ghost small', onClick: sceneActions.apply, title: '把选中场景应用到当前函数槽位（场景值按作者假设对待）' },
          '应用',
        );
        const sceneNameInputEl = createElement('input', {
          className: 'rp-context-input',
          style: { flex: '1 1 140px' },
          type: 'text',
          placeholder: sceneSuggestion ? `场景名（建议：${sceneSuggestion}）` : '场景名',
          value: sceneNameInput,
          onChange: (e: { target: { value: string } }) => setSceneNameInput(e.target.value),
          title: sceneSuggestion ? '留空则用建议名（由协议槽 label 拼接）' : '协议不可用时需手填场景名',
        });
        const saveSceneBtn = createElement(
          'button',
          { className: 'ghost small', onClick: sceneActions.save, title: '把当前输入保存为场景（同名覆盖）' },
          '保存场景',
        );
        const deleteSceneBtn = createElement(
          'button',
          {
            className: 'ghost small',
            disabled: selectedScene.id === DEFAULT_SCENE_ID,
            onClick: sceneActions.remove,
            title: '删除选中场景',
          },
          '删除',
        );
        const sceneBar = createElement(
          'div',
          { className: 'rp-toolbar' },
          createElement('span', { className: 'dim' }, '场景'),
          sceneSelect,
          applySceneBtn,
          sceneNameInputEl,
          saveSceneBtn,
          deleteSceneBtn,
        );
        const sceneMsgEl = sceneMsg !== null ? createElement('div', { className: 'rp-hint dim' }, sceneMsg) : null;

        const contextInput = createElement('input', {
          className: 'rp-context-input',
          type: 'text',
          placeholder: slotInputs.length > 0 ? '' : '调用上下文（可空；如 0=36, 1=15）',
          value: contextText,
          onChange: (e: { target: { value: string } }) => setContextText(e.target.value),
          title: 'ARG/ARGS 槽位赋值（场景输入）；未提供的槽位按未知处理，不猜测',
        });
        const replayBtn = createElement(
          'button',
          { className: 'ghost small', disabled: replayBusy || !view, onClick: () => runReplay(), title: '对照这份存档，看这段里每个条件走不走' },
          replayBusy ? '判定中…' : '判定',
        );
        /**
         * 「本角色全段落体检」（2026-11-05）：选好角色后最常问的那句是「我的段落哪些判不出」——
         * 按钮就放在函数名旁边（单段判定的入口旁边，同一件事的两个粒度）。
         */
        const batchBtn =
          charaNo === null
            ? null
            : createElement(
                'button',
                {
                  className: 'ghost small',
                  type: 'button',
                  style: { flex: '0 0 auto' },
                  disabled: batchBusy || replayBusy || view === null || batchNames.length === 0,
                  onClick: runBatch,
                  title: `本角色（K${charaNo}）全段落体检：逐段回放 ${batchNames.length} 段，汇总完全判定 / 部分 / 全未知（单次上限 ${BATCH_DEFAULT_CAP} 段）`,
                },
                batchBusy ? '体检中…' : '本角色全段落体检',
              );
        /** 建议列表行：函数名 + 中文命中提示（靠标签命中的给作者看「为什么它冒出来」） */
        const suggestRows = suggestions.map((s) =>
          createElement(
            'li',
            { key: s.name },
            createElement(
              'button',
              { className: 'rp-suggest-btn', onClick: () => setFnQuery(s.name) },
              s.name,
              s.hint !== '' ? createElement('span', { className: 'dim' }, `（${s.hint}）`) : null,
            ),
          ),
        );
        const browseRows = charaBrowse.map((n) =>
          createElement(
            'li',
            { key: n },
            createElement(
              'button',
              { className: 'rp-suggest-btn', onClick: () => setFnQuery(n) },
              n,
            ),
          ),
        );
        const suggestList =
          suggestRows.length > 0
            ? createElement('ul', { className: 'rp-suggests' }, ...suggestRows)
            : browseRows.length > 0
              ? createElement(
                  'div',
                  null,
                  createElement(
                    'div',
                    { className: 'dim rp-hint' },
                    `角色 K${charaNo} 相关的段落（前 ${browseRows.length} 条；也可以在上面用中文搜，比如「好感」）：`,
                  ),
                  createElement('ul', { className: 'rp-suggests' }, ...browseRows),
                )
              : null;

        // ---- 结果渲染（预览层：状态 → 分支 / 文本预览；实现见 renderReplayPreview） ----
        // 跳转来的那一次（G1）多带一条"这一行"的横幅，并把对应条目滚进视野。
        //
        // PS-7 三格记忆化（**都在组件顶部无条件调用**，早退分支之后不许放 hook）：
        // - `notice`：`locateNoticeFor` 每次返回新对象 ⇒ 不记忆它，下面那块 memo 每帧都会被顶掉；
        // - `analysis`：3,732 条谓词的 `groupUnknowns` + 逐条递归 `exprArgSlots` 的
        //   `summarizeAssumptions`，只依赖「回放结果 × 假设槽」两件 state；
        // - `resultBody`：整棵谓词行元素树——逐键打字 / 宿主重渲时既不该重算统计、
        //   也不该把 `predLimit` 行节点重新挂一遍（旧实现每帧重建）。
        const notice = useMemo(
          () => (result && resultLocate ? locateNoticeFor(result, resultLocate) : null),
          [result, resultLocate],
        );
        const analysis = useMemo(
          () => (result ? analyzeReplay(result, resultAssumed) : null),
          [result, resultAssumed],
        );
        const emitReveal = useCallback<EmitReveal>(
          (filePath, line, source) =>
            ctx.bus.emit('editor.revealLocation', { filePath, line, source: source ?? 'ui-state-replay' }),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [],
        );
        /**
         * 谓词行中文标注（白话批）：词典来自当前 adapter 的 variableSchema（与注入
         * 面板同一真源）。经 useMemo 钉身份——它在 `resultBody` 的 memo 依赖里，
         * 身份每帧都变会把那棵几千行的树每帧重建（PS-7 的口径）。
         */
        const adapterNow = activeGameAdapter(slots.query('game.adapter'), projectNow?.adapterId);
        const schema = adapterNow?.variableSchema;
        // 谓词行标注 = 中文变量名（白话批）+ **变量实际取值**（B3 2026-11-05）：
        // 旧面板只说"假"，作者答不出"为什么假"；这里把本行引用的存档变量值一并列上
        // （`好感度 · CFLAG:2=480`）。读不出值的引用不列（未知原因由引擎行自己说）。
        const valueHintOf = useCallback(
          (p: PredicateReplay) => (view ? predicateValues(p.expr, (ref) => view.read(ref)) : null),
          [view],
        );
        const glossOf = useCallback(
          (p: PredicateReplay) => {
            const parts = [predicateGloss(p.expr, schema), valueHintOf(p)].filter(
              (s): s is string => typeof s === 'string' && s.length > 0,
            );
            return parts.length > 0 ? parts.join(' · ') : null;
          },
          [schema, valueHintOf],
        );

        /* ------------------- 注入预演（口上调试统一批；带着目的改数值） ------------------- */

        const quickFields: readonly QuickEditField[] = adapterNow?.quickEditFields ?? [];
        const selectedField = quickFields.find((f) => f.id === previewFieldId) ?? null;
        /** 引擎不支持覆盖预演（旧版本）→ 整个区不渲染（契约可选方法的降级口径） */
        const hasPreviewCap = typeof replay.replayFunctionWithOverrides === 'function';

        /** 解析预演值（整数照数、其余按字符串；空值由调用方拦截） */
        const parsePreviewValue = (raw: string): number | string => (/^-?\d+$/.test(raw) ? Number(raw) : raw);

        const runPreview = (): void => {
          setPreviewError(null);
          setWriteArmed(false);
          if (!view || !result) {
            setPreviewError('请先执行判定，再进行改动预演。');
            return;
          }
          if (!selectedField) {
            setPreviewError('先挑一个要改的数值。');
            return;
          }
          const raw = previewValue.trim();
          if (raw.length === 0) {
            setPreviewError('先填新值。');
            return;
          }
          const cc = assembleContext();
          if (cc.error !== null) {
            setPreviewError(cc.error);
            return;
          }
          setPreviewBusy(true);
          void snapshots
            .parse(view.archivePath)
            .then((archive) => {
              const ov = overridesForField(archive, selectedField, view.characterNo, parsePreviewValue(raw));
              if (!ov) throw new Error(`存档里没有「${selectedField.label}」这个变量（${selectedField.family}），改不了。`);
                            // 预演与正式判定必须同一份文本（2026-11-05 口径）：正式判定可能用缓冲文本，
              // 预演却读盘的话，同屏会出现"预演说会变、判定说没变"的割裂。
              const previewText = judgeTextRef.current ?? textChoiceFor(result.normalizedName);
              return replay.replayFunctionWithOverrides!(view, result.normalizedName, ov, {
                callContext: cc.callContext,
                ...(previewText.textOverride !== undefined ? { textOverride: previewText.textOverride } : {}),
              });
            })
            .then((r) => {
              setPreview(r);
            })
            .catch((err: unknown) => {
              setPreviewError(err instanceof Error ? err.message : String(err));
              setPreview(null);
            })
            .finally(() => setPreviewBusy(false));
        };

        const runWrite = (): void => {
          if (!view || !result || !selectedField) return;
          const raw = previewValue.trim();
          if (raw.length === 0) return;
          setWriteNote(null);
          void snapshots
            .parse(view.archivePath)
            .then((archive) => {
              const ov = overridesForField(archive, selectedField, view.characterNo, parsePreviewValue(raw));
              if (!ov) throw new Error(`存档里没有「${selectedField.label}」这个变量（${selectedField.family}），写不了。`);
              return writer.inject(view.archivePath, ov);
            })
            .then((r) => {
              // 热闭环：广播后本面板与注入面板同口径自动重算（备份信息一并告知）
              ctx.bus.emit('debug.snapshotInjected', { archivePath: r.path, source: 'ui-state-replay' });
              setWriteNote(`已写入存档（备份：${r.backupPath ?? '无'}），正在重算…`);
            })
            .catch((err: unknown) => {
              setWriteNote(`写入失败：${err instanceof Error ? err.message : String(err)}`);
            });
        };

        // 结果一换，预演基线就作废（diff 必须配对同一次判定的两份读数）
        useEffect(() => {
          setPreview(null);
          setPreviewError(null);
          setWriteArmed(false);
        }, [result]);

        /**
         * 右键菜单落点（1023 批）：两条动作都接回已有通道（`emitReveal` / `runReplay`），
         * 复制失败写进既有错误行。回调经 ref 转发、身份恒定——否则它进 `resultBody`
         * 的 memo 依赖会让那棵 3,700 行的树每帧重建（PS-7 的口径）。
         */
        const [menuNote, setMenuNote] = useState('');
        const menuHost: ReplayMenuHost = {
          reveal: (filePath, line, source) => emitReveal(filePath, line, source),
          rerun: () => runReplay(),
          copy: (text) => {
            void copyReplayText(text).then((ok) => {
              if (ok) {
                setMenuNote('已复制');
                return;
              }
              setMenuNote('复制失败：当前环境不允许写剪贴板');
              ctx.log.warn('状态回放复制失败：剪贴板不可用');
            });
          },
        };
        /** 谓词行 → 菜单目标（文件与来源取自当前这份回放结果，菜单不另存一份） */
        const predicateTarget = (p: PredicateReplay): ReplayPredicateMenuTarget => {
          const out = p.outcome;
          return {
            line: p.line,
            kind: p.kind,
            text: p.text,
            outcome: out.kind,
            ...(out.kind === 'unknown' && out.unknown !== undefined ? { unknownMessage: out.unknown.message } : {}),
            filePath: result?.filePath ?? '',
            normalizedName: result?.normalizedName ?? '',
          };
        };
        const predicateMenuRef = useRef<(p: PredicateReplay, e: PluginContextMenuAnchor) => void>(
          () => undefined,
        );
        predicateMenuRef.current = (p, e) => {
          openReplayPredicateMenu(props, e, predicateTarget(p), menuHost);
        };
        const onPredicateMenu = useCallback(
          (p: PredicateReplay, e: PluginContextMenuAnchor) => predicateMenuRef.current(p, e),
          [],
        );
        const resultBody: ReturnType<typeof createElement> | null = useMemo(() => {
          if (!result || !analysis) return null;
          return createElement(
            'div',
            { ref: resultWrapRef },
            renderReplayPreview({
              result,
              assumedSlots: resultAssumed,
              emitReveal,
              renderIcon: props.renderIcon,
              notice,
              predLimit: predWindow,
              onGrowPreds: growPreds,
              trLimit: trWindow,
              onGrowTranscript: growTranscript,
              analysis,
              onPredicateMenu,
              glossOf,
              textSource: resultTextSource,
              // 谓词筛选（筛选只影响渲染；统计/窗口语义不动——窗口按筛后条数走，见预览层）
              predicateFilter: { filter: predFilter, counts: predCounts, onChange: setPredFilter },
            }),
          );
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [result, analysis, notice, predWindow, trWindow, props.renderIcon, emitReveal, growPreds, growTranscript, glossOf, resultTextSource, predFilter, predCounts]);

        // ---- 注入预演的差异呈现（diff 纯函数在 panel-logic；这里只渲染） ----
        const diff = useMemo(() => (result && preview ? diffReplays(result, preview) : null), [result, preview]);
        const previewBox =
          result !== null && quickFields.length > 0 && hasPreviewCap
            ? createElement(DebugPreviewPanel, {
                quickFields,
                fieldId: previewFieldId,
                value: previewValue,
                busy: previewBusy,
                canRun: view !== null && selectedField !== null,
                canWrite: view !== null && selectedField !== null && previewValue.trim().length > 0,
                error: previewError,
                diff,
                diffSummary: diff ? replayDiffSummary(diff) : null,
                writeArmed,
                writeNote,
                onFieldChange: (id: string) => {
                  setPreviewFieldId(id);
                  setPreview(null);
                  setPreviewError(null);
                  setWriteArmed(false);
                },
                onValueChange: (value: string) => {
                  setPreviewValue(value);
                  setWriteArmed(false);
                },
                onPreview: runPreview,
                onWriteClick: () => {
                  if (!writeArmed) {
                    setWriteArmed(true);
                    return;
                  }
                  setWriteArmed(false);
                  runWrite();
                },
              })
            : null;

        // 滚到"就是这一行"那一条：只在结果与位点同批时做一次，找不到就作罢
        // （谓词窗口至少盖住位点那一条——见 PredicateList 的 mustInclude；
        //  来源对不上的位点本来就不该有高亮行）。
        // 为什么这里要 `as unknown as`：本包的 typecheck 跑在**无 DOM lib** 的 root 配置下
        // （root `tsc` 与 app 那套都算数），DOM 成员在那一侧是不可见的类型名；
        // 用到的能力只有"按选择器找一个能滚的东西"，就按这最小形状声明，不 import DOM 类型。
        useEffect(() => {
          if (!result || !resultLocate || !notice?.hasRows) return;
          const host = resultWrapRef.current as unknown as ScrollHost | null;
          host?.querySelector('[data-locate="1"]')?.scrollIntoView({ block: 'center' });
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [result, resultLocate]);

        const replayErrorEl =
          replayError !== null ? createElement('div', { className: 'rp-error' }, replayError) : null;

        // 空白处右键（1023 批）：重新回放（按 busy / 无结果给出禁用原因）
        const panelMenu = (e: PluginContextMenuAnchor): void => {
          openReplayPanelMenu(props, e, { hasView: view !== null, busy: replayBusy }, menuHost);
        };

        if (!projectNow) {
          return createElement(
            'div',
            { className: 'panel-state-replay', onContextMenu: panelMenu },
            createElement(
              'div',
              { className: 'dbg-empty' },
              createElement('div', { className: 'dbg-empty-title' }, '未打开项目'),
              createElement('div', { className: 'dbg-empty-note' }, '回放需要存档与角色表，两者都由项目提供。'),
            ),
          );
        }

        /* --------------------------- 分区渲染（口上调试 UI 打磨批） --------------------------- */

        /**
         * 顶部一体化标题：两个调试面板共用同一套头（左标题、右跳转）。
         * 跳转走 `ui.panel.reveal`（契约事件，宿主负责把目标面板拉到前台），
         * 面板之间零直接依赖——这也正是"改状态"能和"看结果"分开注册却像一件事的原因。
         */
        const panelHead = createElement(
          'div',
          { className: 'dbg-head' },
          createElement(
            'div',
            { className: 'dbg-head-row' },
            createElement('span', { className: 'dbg-head-title' }, '状态回放'),
            createElement(
              'button',
              {
                className: 'dbg-jump',
                type: 'button',
                title: '带着这份存档去改数值（状态注入面板）',
                onClick: () => ctx.bus.emit('ui.panel.reveal', { id: 'snapshot-injector', source: PANEL_ID }),
              },
              '状态注入 →',
            ),
          ),
          createElement(
            'div',
            { className: 'dbg-head-sub' },
            '按当前存档判定条件分支，并推演消息窗输出。',
          ),
        );

        /**
         * 提示带：错误独占一行，其余提示按"最新一条"呈现。
         * 旧实现把 5 条灰字提示平铺在结果上方，四条同时出现时作者一条都不读。
         */
        const statusNotes: string[] = [];
        if (replayError === null) {
          if (pendingNote !== null) statusNotes.push(pendingNote);
          if (injectNote !== null) statusNotes.push(injectNote);
          if (menuNote !== '') statusNotes.push(menuNote);
          if (contextHint !== null) statusNotes.push(contextHint);
        }
        const notesBand =
          replayErrorEl !== null || statusNotes.length > 0
            ? createElement(
                'div',
                { className: 'dbg-notes' },
                replayErrorEl,
                ...statusNotes.slice(0, 2).map((t, i) => createElement('div', { key: `n${i}`, className: 'dbg-note' }, t)),
              )
            : null;

        /** 场景参数摘要（收起时也要能看出"几个是假设、留空的按未知"） */
        const slotSummary = (() => {
          if (slotInputs.length === 0) return null;
          let assumed = 0;
          for (const s of slotInputs) {
            const k = slotKey(s.kind, s.index);
            if (classifySlotValue(s.kind, slotTexts[k] ?? '', slotEdited[k] === true, assumeDefaults) === 'assumption') {
              assumed += 1;
            }
          }
          return `${slotInputs.length} 项${assumed > 0 ? ` · ${assumed} 个假设` : ' · 留空按未知'}`;
        })();
        /** P1：开关只在真有可能被补 0（存在数值槽）时才显示，避免在纯字符串槽上制造噪音 */
        const hasIntSlot = slotInputs.some((s) => s.kind === 'int');
        const assumeToggle = createElement(
          'label',
          {
            className: 'rp-slot',
            style: { cursor: 'pointer' },
            title:
              '勾上后，留空的数值槽按 0 写进调用上下文并标为假设值（这是面板的试算假设，不是引擎事实）；' +
              '显式 0 会盖过引擎推导出的确定槽值——连推导出的确定值也一起按 0 试算',
          },
          createElement('input', {
            type: 'checkbox',
            checked: assumeDefaults,
            onChange: (e: { target: { checked: boolean } }) => setAssumeDefaults(e.target.checked),
          }),
          createElement('span', { className: 'dim' }, '按默认场景 0 试算（把留空的数值槽当 0，标为假设）'),
        );

        /**
         * 「场景」折叠区：槽位参数 + 假设开关 + 命名场景。
         * 这三件事都只在"要精确控制一次判定"时才动，默认收起；收起时标题带上摘要。
         */
        const sceneSection =
          slotInputs.length > 0 || scenes.length > 0
            ? createElement(
                'div',
                { className: 'dbg-fold' },
                createElement(
                  'button',
                  {
                    className: `dbg-fold-head ${showScenes ? 'open' : ''}`,
                    type: 'button',
                    'aria-expanded': showScenes ? 'true' : 'false',
                    onClick: () => setShowScenes((v) => !v),
                  },
                  createElement('span', { className: 'dbg-fold-caret' }, showScenes ? '▾' : '▸'),
                  createElement('span', { className: 'dbg-fold-title' }, '场景参数'),
                  createElement('span', { className: 'dbg-fold-note' }, slotSummary ?? '命名场景 / 调用上下文文本'),
                  scenes.length > 0 ? createElement('span', { className: 'dbg-fold-badge' }, `${scenes.length} 个场景`) : null,
                ),
                showScenes
                  ? createElement(
                      'div',
                      { className: 'dbg-fold-body' },
                      slotInputsEl,
                      hasIntSlot ? assumeToggle : null,
                      sceneBar,
                      sceneMsgEl,
                    )
                  : null,
              )
            : null;

        /**
         * P6：结果里"调用上下文没给"的未知汇总（复用 `analysis.unknowns`，不新造统计口径）。
         * P8：行内三元谓词（`kind==='INLINE'`）被引擎剔出 stats / confidence，
         * 面板照常显示「确定」徽章就是撒谎——这里单独报一句"另有 N 条没计入"。
         * 两个数字都只在结果存在时才有意义。
         */
        const ctxUnknownCount = analysis?.unknowns.find((u) => u.code === 'call-context')?.count ?? 0;
        const inlineCount =
          result !== null && fnDetail !== null && fnDetail.normalizedName === result.normalizedName
            ? fnDetail.predicates.filter((p) => p.kind === 'INLINE').length
            : 0;
        const resultFacts =
          ctxUnknownCount > 0 || inlineCount > 0
            ? createElement(
                'div',
                {
                  className: 'rp-hint dim',
                  style: { display: 'flex', flexDirection: 'column', gap: 'var(--space-0)' },
                },
                ctxUnknownCount > 0
                  ? createElement(
                      'div',
                      null,
                      `${ctxUnknownCount} 条判不出是因为「调用上下文」没给：在下面「场景参数」里给 ARG/ARGS 那一格填值就能判；数值槽也可以勾「按默认场景 0 试算」。`,
                    )
                  : null,
                inlineCount > 0
                  ? createElement('div', null, `另有 ${inlineCount} 条行内三元条件未参与统计（它们不在分支链里）`)
                  : null,
              )
            : null;

        /** 选择区：存档 / 角色 / 函数（首屏唯一必读的一块） */
        const pickSection = createElement(
          'section',
          { className: 'dbg-sec' },
          createElement(
            'div',
            { className: 'dbg-sec-head' },
            createElement('span', { className: 'dbg-sec-title' }, '回放目标'),
          ),
          createElement(
            'div',
            { className: 'dbg-fields' },
            createElement(
              // 用 div 而不是 label：这一行里嵌了「重新扫描」按钮，label 会把按钮点击
              // 转发给第一个可标量控件（select），在部分环境里表现为"点重扫却弹出下拉"。
              'div',
              { className: 'dbg-field' },
              createElement('span', { className: 'dbg-field-label' }, '存档'),
              // P4：下拉旁边就地给「重新扫描」（空态文案不再指向别的面板）
              createElement(
                'div',
                { className: 'dbg-row', style: { flex: '1 1 auto', minWidth: 0 } },
                archiveSelect,
                rescanBtn,
              ),
            ),
            createElement(
              'label',
              { className: 'dbg-field' },
              createElement('span', { className: 'dbg-field-label' }, '角色'),
              charaSelect,
            ),
          ),
          createElement(
            'div',
            { className: 'dbg-row dbg-row-fn' },
            fnInput,
            slotInputs.length > 0 ? null : contextInput,
            replayBtn,
            batchBtn,
          ),
          viewStatus,
          // 常驻口径（2026-11-05 缓冲文本批）：判定优先用编辑器里的**未保存文本**，
          // 没有未保存编辑（或判的是另一份文件）才读磁盘；结果区会标出这次用哪份。
          // 旧文案是"未保存的编辑不算数"，引擎支持 override 之后那句话就变成假话了。
          createElement(
            'div',
            { className: 'dim rp-hint' },
            '有未保存编辑时按编辑器缓冲文本判定（结果区会标出用哪份文本）；没有未保存编辑就按磁盘文件。',
          ),
          // 编辑器里这份文件脏没脏：让"我现在改的字会被算进去"这件事在按判定之前就看得见
          latestBufferedRef.current !== null && latestBufferedRef.current.dirty
            ? createElement(
                'div',
                { className: 'dim rp-hint rp-buffer-note' },
                `编辑器里「${shortPath(latestBufferedRef.current.filePath)}」有未保存的编辑：按下判定会直接用这份缓冲文本。`,
              )
            : null,
          // 求值边界的常驻口径（A3 2026-11-05）：这套回放按**函数入口时刻的存档**求值，
          // 函数体内对游戏变量的写（`CFLAG +=` / `SETBIT` / `INPUT` 之后的值等）不建模。
          // 不写这一句，作者会把"入口值是 480、但函数里先加了 10"的结论当成错答案。
          createElement(
            'div',
            { className: 'dim rp-hint' },
            '按函数入口时刻的存档求值：函数体内对游戏变量的写入（CFLAG += / SETBIT / INPUT 等）不建模。',
          ),
          // 可发现性（2026-11-05）：从编辑器里"跳到命中状态"那条键是这套面板最省事的路，
          // 但没人会去猜快捷键——写在常驻位置，作者第一次打开就知道。
          createElement(
            'div',
            { className: 'dim rp-hint' },
            '把光标放到那一行按 Ctrl+Alt+S 可直接跳到这里并自动判定。',
          ),
          // 扫完了、一个存档都没有：下拉里只有「选择存档（0）」，不解释就成了死路。
          // P4：出路是本面板自己的「重新扫描」（旧文案把人指去状态注入器——那条路不通知这边）。
          activation.archivesReady && activation.archives.length === 0
            ? createElement(
                'div',
                { className: 'dbg-note' },
                '项目内未找到存档：先在游戏内存档，再点上面的「重新扫描」。',
              )
            : null,
          activation.archivesError !== null
            ? createElement('div', { className: 'dbg-note rp-error' }, `扫描存档失败：${activation.archivesError}`)
            : null,
          sceneSection,
          suggestList,
        );

        /**
         * 预演与判定拆成**两段**：它们是两件不同的事——预演是"换个数值会怎样"，
         * 判定是"现在到底走哪一条"。此前挤在同一段标题下，作者读到的是
         * 「改动预演 … 共 0 谓词」，分不清哪半是基线、哪半是假设。
         * 引擎不支持覆写预演时（旧版本）预演段整段不出现，判定段照常。
         */
        const previewSection =
          previewBox !== null
            ? createElement(
                'section',
                { className: 'dbg-sec dbg-sec-flat' },
                createElement(
                  'div',
                  { className: 'dbg-sec-head' },
                  createElement('span', { className: 'dbg-sec-title' }, '改动预演'),
                  resultBody !== null
                    ? createElement('span', { className: 'dbg-sec-note' }, '存档不动 · 下一段是现状')
                    : null,
                ),
                previewBox,
              )
            : null;

        const resultSection =
          resultBody !== null
            ? createElement(
                'section',
                { className: 'dbg-sec dbg-sec-flat' },
                createElement(
                  'div',
                  { className: 'dbg-sec-head' },
                  createElement('span', { className: 'dbg-sec-title' }, '判定结果'),
                  // 判的是哪一段：改过函数名但没重判时，这里能让作者看出"结果还是上一段的"
                  result !== null
                    ? createElement('span', { className: 'dbg-sec-note' }, result.normalizedName)
                    : null,
                ),
                // P6 / P8：结果区的诚实提示（调用上下文未知汇总 + INLINE 未计入统计）
                resultFacts,
                resultBody,
              )
            : null;

        /** P5：源码变过 → 结果是上一次的（放在结果段正上方，紧挨着它说的那张结果） */
        const staleNote =
          resultStale && result !== null
            ? createElement(
                'div',
                { className: 'dbg-note', style: { color: 'var(--warning)' } },
                '源码已变，下面的结果是上一次的 —— 再按一次「判定」',
              )
            : null;

        return createElement(
          'div',
          { className: 'panel-state-replay', onContextMenu: panelMenu },
          panelHead,
          notesBand,
          pickSection,
          previewSection,
          staleNote,
          resultSection,
          // 「尚未判定」空态紧跟在结果位（没结果时它就是结果位）
          result === null && replayError === null
            ? createElement(
                'div',
                { className: 'dbg-empty' },
                createElement('div', { className: 'dbg-empty-title' }, '尚未判定'),
                createElement(
                  'div',
                  { className: 'dbg-empty-note' },
                  '选定存档、角色与函数后执行判定：这里逐条给出条件是否成立，以及消息窗里会打印什么。',
                ),
                // 可发现性（2026-11-05）：最省事的那条路（从编辑器跳进来）写进空态——
                // 空态正是"我还不知道该怎么用这块面板"的那一屏。
                createElement(
                  'div',
                  { className: 'dbg-empty-note dim' },
                  '也可以把光标放到那一行按 Ctrl+Alt+S：直接跳到这里并自动判定。',
                ),
              )
            : null,
          // 体检区放在最后：结果才是主事件；入口按钮在函数名旁边（见 batchBtn）
          batchSection,
        );
      }

      ctx.slots.register('ui.panel', {
        id: PANEL_ID,
        // 口上调试 UI 打磨批：与注入面板（`状态注入器`）同一套外壳、互为跳转，
        // 但标题各报本职——工具名就是一个词，作者按词找面板，不需要再翻译一层。
        title: '状态回放',
        icon: 'history',
        order: 60,
        // UI 重设计批 P1：按需验证工具 → 副侧栏，默认不激活（定稿 §四）
        location: 'aux',
        defaultActive: false,
        component: ReplayPanel,
      });
    },
  };
}
