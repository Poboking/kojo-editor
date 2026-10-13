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
 *   - 监听 `kojo.replayFunction`（任意插件可发起的回放意图，如导航面板联动）。
 *
 * 本文件内部分两层（v1.0 收口 A3，职责归属注记见 ARCHITECTURE §5.4）：
 *   - **预览层**（`renderReplayPreview` + `branchRow`）：把 `FunctionReplay` 渲染为
 *     "状态 → 分支 / 文本预览"；纯逻辑（判定 / 统计）在 `panel-logic.ts`，可复用。
 *     语法糖预览若做，复用 `preview.renderer` 产出的 `PreviewLines[]` 渲染文本，
 *     **不自建渲染逻辑**——本层只负责"状态 → 预览数据 → 呈现"。
 *   - **面板壳层**（`ReplayPanel` 其余部分）：`ui.panel` 的选档 / 选角 / 选函数 /
 *     场景参数输入 / 错误提示等交互骨架。
 *
 * C9（v1.0 收口，信任闭环）：协议槽位预填的 0 是**默认场景假设值**，非确定值——
 * 未手改的槽在 UI 标注「假设」（虚线样式），依赖它的谓词结果标「基于假设」，
 * 分支折叠区汇总"本结果含 N 个假设参数"。空值 = 未提供（unknown）语义不变。
 */

import { createElement, useEffect, useRef, useState } from 'react';
import type {
  BranchChainOutcome,
  ConditionExtractorService,
  FunctionReplay,
  GameAdapter,
  GameProject,
  KojoCallSlot,
  Plugin,
  ProjectService,
  ReplayStateView,
  SlotRegistry,
  SnapshotSourceService,
  StateReplayService,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import type { AssumedSlot, ReplayScene, SceneSlotValue, SlotOrigin } from './panel-logic';
import {
  DEFAULT_SCENE_ID,
  MAX_SCENES,
  MAX_SCENE_NAME,
  applyScene,
  captureSceneSlots,
  classifySlotValue,
  collectAssumedSlots,
  contextTextToSceneSlots,
  defaultScene,
  defaultSlotText,
  groupUnknowns,
  newSceneId,
  parseCallContextText,
  removeScene,
  sanitizeScenes,
  sceneSlotsToContextText,
  sceneSuggestionName,
  slotKey,
  suggestFunctions,
  summarizeAssumptions,
  toCallContext,
  upsertSceneByName,
} from './panel-logic';

/** 函数名提示上限 */
const SUGGEST_LIMIT = 50;
/** 谓词渲染上限（防 DOM 爆炸；单函数谓词通常 <100） */
const PRED_RENDER_CAP = 300;
/**
 * 场景预设的存储键——`ctx.storage` 的域 = 本插件 id（`ui-state-replay`），
 * 不与其他插件共用域（内核按 pluginId 隔离）。
 */
const SCENES_STORAGE_KEY = 'replay-scenes';

/** 置信度徽章样式 */
const CONFIDENCE_BADGE: Record<FunctionReplay['confidence'], { label: string; className: string }> = {
  exact: { label: '确定', className: 'rp-badge conf-exact' },
  partial: { label: '部分未知', className: 'rp-badge conf-partial' },
  unknown: { label: '无法判定', className: 'rp-badge conf-unknown' },
};

const OUTCOME_LABEL: Record<string, string> = { true: '真', false: '假', unknown: '未知' };

/** 分支走向的状态标记（v0.2 第九批） */
const BRANCH_MARK: Record<BranchChainOutcome['outcome'], { mark: string; className: string; title: string }> = {
  taken: { mark: '✓', className: 'rp-branch-mark taken', title: '该状态命中此分支' },
  'no-match': { mark: '∅', className: 'rp-branch-mark nomatch', title: '全部分支条件为假且无兜底（落空）' },
  unknown: { mark: '?', className: 'rp-branch-mark unk', title: '分支条件未知，无法判定走向' },
  unreachable: { mark: '·', className: 'rp-branch-mark unreach', title: '外层分支未进入（不可达）' },
};

/** 跳转源码（source 缺省 = 本插件；谓词行沿用 normalizedName 作为来源标记） */
type EmitReveal = (filePath: string, line: number, source?: string) => void;

/** 假设值标记的内联样式（插件内自持，不改 app 样式表；虚线 = 与手输确定值视觉可区分） */
const ASSUME_STYLE = { color: 'var(--amber, #d19a66)', borderColor: 'var(--amber, #d19a66)', borderStyle: 'dashed' } as const;

function branchRow(chain: BranchChainOutcome, filePath: string, emit: EmitReveal, key: string): ReturnType<typeof createElement> {
  const mk = BRANCH_MARK[chain.outcome]!;
  const takenText = chain.members.find((m) => m.line === chain.takenLine);
  const headText =
    chain.outcome === 'taken'
      ? `${takenText?.kind ?? ''} ${takenText?.text ?? ''}`.trim()
      : chain.members[0]?.kind === 'IF' || chain.members[0]?.kind === 'CASE'
        ? `${chain.members[0]!.kind} ${chain.members[0]!.text}`.trim()
        : chain.kind === 'if-chain'
          ? 'IF …'
          : 'SELECTCASE …';
  return createElement(
    'div',
    {
      key,
      className: `rp-branch-row ${chain.outcome}`,
      style: { paddingLeft: `${chain.depth * 14 + 2}px` },
    },
    createElement('span', { className: mk.className, title: mk.title }, mk.mark),
    createElement(
      'button',
      {
        className: 'rp-branch-btn',
        title: `${filePath}:${chain.takenLine ?? chain.headLine} — ${mk.title}`,
        onClick: () => emit(filePath, chain.takenLine ?? chain.headLine),
      },
      createElement('span', { className: 'rp-branch-head' }, headText),
      createElement('span', { className: 'rp-branch-taken dim' }, chain.takenLine ? ` → :${chain.takenLine}` : ''),
    ),
  );
}

/**
 * 预览层（v1.0 收口 A3）：把 `FunctionReplay` 渲染为"状态 → 分支 / 文本预览"。
 *
 * 职责分工：本层只做**状态 → 预览**（分支走向 + 谓词三值 + 未知分组 + 假设标注）；
 * 将来的语法糖预览复用 `preview.renderer`（ARCHITECTURE §5.4）产出的
 * `PreviewLines[]` 渲染文本，**不自建渲染逻辑**。参数显式传入（不闭包面板状态），
 * 与 ui.panel 壳层（选档 / 选角 / 选函数 / 输入）解耦——纯逻辑复用则下沉到
 * `panel-logic.ts`（`summarizeAssumptions` 等）。
 */
function renderReplayPreview(opts: {
  result: FunctionReplay;
  assumedSlots: readonly AssumedSlot[];
  emitReveal: EmitReveal;
}): ReturnType<typeof createElement> {
  const { result, assumedSlots, emitReveal } = opts;
  const conf = CONFIDENCE_BADGE[result.confidence];
  const unknowns = groupUnknowns(result);
  const impact = summarizeAssumptions(result, assumedSlots);

  // 假设参数汇总（C9 附加）：分支折叠结果区一眼可见的可信度提示
  const assumptionSummary =
    impact.consumed.length > 0
      ? createElement(
          'span',
          {
            className: 'rp-badge assume',
            style: ASSUME_STYLE,
            title: '命中判定用到了默认场景的假设参数（未被手改的预填 0，未必等于引擎真实默认）——请核对场景参数',
          },
          `本结果含 ${impact.consumed.length} 个假设参数`,
        )
      : null;

  // 分支折叠结果区：链走向 + 假设汇总（无链但有假设影响时也显式提示，不静默）
  const branchSection =
    result.branches.length > 0
      ? createElement(
          'div',
          { className: 'rp-branches' },
          createElement(
            'div',
            { className: 'dim rp-branches-head' },
            `分支走向（${result.branches.length} 条链）`,
            assumptionSummary,
          ),
          ...result.branches.map((b, i) => branchRow(b, result.filePath, emitReveal, `b${b.headLine}:${i}`)),
        )
      : assumptionSummary
        ? createElement(
            'div',
            { className: 'rp-branches' },
            createElement('div', { className: 'dim rp-branches-head' }, assumptionSummary),
          )
        : null;

  return createElement(
    'div',
    { className: 'rp-result' },
    createElement(
      'div',
      { className: 'rp-summary' },
      createElement('span', { className: conf.className }, conf.label),
      createElement('span', { className: 'rp-count hit' }, `命中 ${result.stats.hit}`),
      createElement('span', { className: 'rp-count miss' }, `未命中 ${result.stats.miss}`),
      createElement('span', { className: 'rp-count unk' }, `未知 ${result.stats.unknown}`),
      createElement(
        'span',
        { className: 'dim rp-meta' },
        `共 ${result.stats.total} 谓词 · ${shortPath(result.filePath)}:${result.startLine}`,
      ),
    ),
    branchSection,
    unknowns.length > 0
      ? createElement(
          'div',
          { className: 'rp-unknowns' },
          createElement('span', { className: 'dim' }, '未知原因：'),
          ...unknowns.map((u) =>
            createElement(
              'span',
              { key: u.code, className: 'rp-badge unk', title: UNKNOWN_HINT[u.code] ?? u.code },
              `${UNKNOWN_HINT[u.code] ?? u.code} ${u.count}`,
            ),
          ),
        )
      : null,
    createElement(
      'ul',
      { className: 'rp-preds' },
      ...result.predicates.slice(0, PRED_RENDER_CAP).map((p, i) => {
        const cls =
          p.outcome.kind === 'true' ? 'rp-outcome hit' : p.outcome.kind === 'false' ? 'rp-outcome miss' : 'rp-outcome unk';
        return createElement(
          'li',
          { key: `${p.line}:${i}` },
          createElement(
            'button',
            {
              className: 'rp-pred-btn',
              title: `${result.filePath}:${p.line}${p.outcome.kind === 'unknown' ? ` — ${p.outcome.unknown.message}` : ''}`,
              onClick: () => emitReveal(result.filePath, p.line, result.normalizedName),
            },
            createElement('span', { className: 'rp-kind' }, p.kind),
            createElement('span', { className: cls }, OUTCOME_LABEL[p.outcome.kind] ?? '?'),
            impact.affected[i]
              ? createElement(
                  'span',
                  {
                    className: 'rp-badge assume',
                    style: ASSUME_STYLE,
                    title: '该谓词读取了默认场景的假设参数（未手改的预填 0）——结论建立在假设之上',
                  },
                  '基于假设',
                )
              : null,
            createElement('span', { className: 'rp-pred-text' }, p.text),
            createElement('span', { className: 'rp-line dim' }, `:${p.line}`),
          ),
        );
      }),
      result.predicates.length > PRED_RENDER_CAP
        ? createElement('li', { className: 'rp-more dim' }, `其余 ${result.predicates.length - PRED_RENDER_CAP} 条未显示`)
        : null,
    ),
  );
}

/** 未知原因的中文提示（按 code；与 replay.ts 的分类一一对应） */
const UNKNOWN_HINT: Record<string, string> = {
  opaque: '表达式未解析',
  call: '函数调用不可求值',
  builtin: '内置函数无法求值',
  rename: 'rename 词',
  pseudo: '伪变量/运行期值',
  'local-no-write': '本地量无可见赋值',
  'call-context': '调用上下文未提供',
  'dynamic-index': '动态索引',
  'named-index': '具名索引无法解析',
  'missing-var': '快照中无此变量',
  'index-oob': '索引越界',
  truncated: '数组单元被截断',
  type: '类型不匹配',
  'divide-by-zero': '除零',
  'too-many-args': '参数过多',
  'string-compare': '字符串序比较',
  'non-numeric': '结果非数值',
  other: '其它',
};

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

export function createUiStateReplayPlugin(): Plugin {
  return {
    id: 'ui-state-replay',
    version: '0.2.0',
    requires: [
      WellKnownServices.StateReplay,
      WellKnownServices.SnapshotSource,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const replay = ctx.inject<StateReplayService>(WellKnownServices.StateReplay);
      const snapshots = ctx.inject<SnapshotSourceService>(WellKnownServices.SnapshotSource);
      const extractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前适配器的口上调用协议（按 adapterId 精确匹配；多适配器共存天然正确） */
      const currentProtocol = (): GameAdapter['kojoCallProtocol'] => {
        const current: GameProject | null = project.current();
        if (!current) return undefined;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId !== current.adapterId) continue;
          return contribution.adapter.kojoCallProtocol;
        }
        return undefined;
      };

      // ---- React 外部源（面板组件订阅） ----
      interface ArchiveEntryUi {
        path: string;
        fileName: string;
        saveMes: string;
        charCount: number;
      }
      let archives: ArchiveEntryUi[] = [];
      let archivesReady = false;
      const listeners = new Set<() => void>();
      const notify = (): void => {
        for (const cb of [...listeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Replay panel listener threw: ${String(err)}`);
          }
        }
      };

      const refreshArchives = (): void => {
        const current: GameProject | null = project.current();
        if (!current) {
          archives = [];
          archivesReady = false;
          notify();
          return;
        }
        void snapshots
          .scan()
          .then((scan) => {
            archives = scan.entries
              .filter((e) => !e.error)
              .map((e) => ({
                path: e.path,
                fileName: e.fileName,
                saveMes: e.meta?.saveMes ?? '',
                charCount: e.meta?.charCount ?? 0,
              }));
            archivesReady = true;
            notify();
          })
          .catch((err) => {
            ctx.log.warn(`Replay panel scan failed: ${String(err)}`);
            archivesReady = true; // 失败也是"就绪"（空列表 + 显式错误，不静默转圈）
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('project.opened', () => refreshArchives()));
      ctx.onDispose(ctx.bus.on('project.closed', () => refreshArchives()));
      if (project.current()) refreshArchives();

      /* ------------------------------ 面板组件 ------------------------------ */

      function ReplayPanel(): unknown {
        const [, force] = useState(0);
        const [archivePath, setArchivePath] = useState<string>('');
        const [charaNo, setCharaNo] = useState<number | null>(null);
        const [view, setView] = useState<ReplayStateView | null>(null);
        const [viewBusy, setViewBusy] = useState(false);
        const [viewError, setViewError] = useState<string | null>(null);
        const [fnQuery, setFnQuery] = useState('');
        const [contextText, setContextText] = useState('');
        /** 协议槽位输入（key = slotKey(kind,index)；值 = 用户文本；int 缺省 '0'、str 缺省 ''） */
        const [slotTexts, setSlotTexts] = useState<Record<string, string>>({});
        /** 协议槽位是否被作者手改过（未改的预填 0 = 假设值，审阅 C9） */
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
        const [replayBusy, setReplayBusy] = useState(false);
        const [replayError, setReplayError] = useState<string | null>(null);
        /** 视图代际（换档/换角色时使在途 createView 作废） */
        const viewGenRef = useRef(0);

        // 协议槽位（函数名变化时重置输入为默认场景值：int=0 / str=''）
        const protocol = currentProtocol();
        const callSlots: readonly KojoCallSlot[] | null =
          fnQuery.trim().length >= 2 ? (protocol?.slotsFor(fnQuery.trim().toUpperCase()) ?? null) : null;
        const slotsKey = callSlots ? callSlots.map((s) => `${s.kind}${s.index}`).join('|') : '';
        useEffect(() => {
          if (!callSlots) return;
          const init: Record<string, string> = {};
          for (const s of callSlots) init[slotKey(s.kind, s.index)] = defaultSlotText(s.kind);
          setSlotTexts(init);
          setSlotEdited({}); // 换函数 → 手改标记清零（预填 0 重新回到"假设值"）
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [slotsKey]);

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

        const persistScenes = (next: ReplayScene[]): void => {
          setScenes(next);
          void ctx.storage.set(SCENES_STORAGE_KEY, next).catch((err: unknown) => {
            ctx.log.warn(`Replay panel scene persist failed: ${String(err)}`);
            setSceneMsg('场景写入本地存储失败（本次会话仍可用）');
          });
        };

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        }, []);

        // 角色列表（project.charaIndex；项目切换由 force 刷新驱动重读）
        const projectNow = project.current();
        const charaEntries = [...(projectNow?.charaIndex.entries() ?? [])].sort((a, b) => a[0] - b[0]);

        // ---- 换档/换角色 → 重建视图（代际保护） ----
        useEffect(() => {
          let cancelled = false;
          const gen = ++viewGenRef.current;
          setView(null);
          setViewError(null);
          setResult(null);
          setResultAssumed([]);
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

        // ---- 回放意图（任意插件发起；如导航面板"回放此函数"） ----
        // 经 ref 调用最新的 runReplay（M5 修复：deps 不含 view 时旧闭包
        // 会拿到挂接时刻的 view=null，误报"请先选择存档与角色"）。
        const runReplayRef = useRef<(nameOverride?: string) => void>(null);
        useEffect(() => {
          const un = ctx.bus.on('kojo.replayFunction', (ev) => {
            setFnQuery(ev.functionName);
            runReplayRef.current?.(ev.functionName);
          });
          return un;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const runReplay = (nameOverride?: string): void => {
          const name = (nameOverride ?? fnQuery).trim().toUpperCase();
          setReplayError(null);
          if (!name) {
            setReplayError('请先输入函数名');
            return;
          }
          if (!view) {
            setReplayError('请先选择存档与角色（建立回放视图）');
            return;
          }
          // 调用上下文组装：协议槽（结构化输入）优先；无协议 → 文本框解析
          let callContext;
          if (callSlots) {
            const ints: (number | undefined)[] = [];
            const strs: (string | undefined)[] = [];
            for (const s of callSlots) {
              const raw = slotTexts[slotKey(s.kind, s.index)] ?? '';
              if (raw.trim() === '') continue; // 空 = 未提供该槽（unknown，不猜测）
              if (s.kind === 'int') {
                if (!/^-?\d+$/.test(raw.trim())) {
                  setReplayError(`场景参数 ${s.index}（${s.label}）必须是整数：「${raw}」`);
                  return;
                }
                while (ints.length <= s.index) ints.push(undefined);
                ints[s.index] = Number(raw.trim());
              } else {
                while (strs.length <= s.index) strs.push(undefined);
                strs[s.index] = raw;
              }
            }
            if (ints.some((v) => v !== undefined) || strs.some((v) => v !== undefined)) {
              callContext = {
                ...(ints.some((v) => v !== undefined) ? { ints } : {}),
                ...(strs.some((v) => v !== undefined) ? { strs } : {}),
              };
            }
          } else {
            const parsed = parseCallContextText(contextText);
            if (!parsed.ok) {
              setReplayError(`调用上下文无法解析：${parsed.detail}`);
              return;
            }
            callContext = toCallContext(parsed);
          }
          // 假设值快照（C9）：与本结果同批——未手改的预填 0 记入"基于假设"标注
          const assumedAtRun = callSlots ? collectAssumedSlots(callSlots, slotTexts, slotEdited) : [];
          setReplayBusy(true);
          void replay
            .replayFunction(view, name, { callContext })
            .then((r) => {
              if (r === null) {
                setReplayError(`函数不在条件索引中（未解析到该函数的谓词）：${name}`);
                setResult(null);
                setResultAssumed([]);
                return;
              }
              setResult(r);
              setResultAssumed(assumedAtRun);
            })
            .catch((err: unknown) => {
              setReplayError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setReplayBusy(false));
        };
        runReplayRef.current = runReplay;

        /* ------------------- 场景预设（命名保存 / 一键应用 / 删除） ------------------- */

        const allScenes: ReplayScene[] = [defaultScene(), ...scenes];
        const selectedScene = allScenes.find((s) => s.id === selectedSceneId) ?? allScenes[0]!;
        /** 建议名：协议可用时由槽位 label 拼接；协议不可用 → 空串（降级纯手填） */
        const sceneSuggestion = callSlots && callSlots.length > 0 ? sceneSuggestionName(callSlots, slotTexts) : '';

        /** 一键应用场景：协议可用 → 填结构化槽位；协议不可用 → 降级写裸上下文文本（绝不抛错） */
        const doApplyScene = (): void => {
          if (callSlots && callSlots.length > 0) {
            const app = applyScene(selectedScene, callSlots, slotTexts);
            setSlotTexts(app.texts);
            setSlotEdited(app.edited); // 场景覆盖的槽 → manual（作者假设，非引擎事实）
            const parts: string[] = [
              selectedScene.id === DEFAULT_SCENE_ID
                ? '已应用默认场景（int 全 0 = 假设 / str 空 = 未提供）'
                : `已应用「${selectedScene.name}」（${app.applied.length} 槽；场景值按作者假设对待，非引擎事实）`,
            ];
            if (app.dropped.length > 0) parts.push(`${app.dropped.length} 个场景槽位不在当前函数签名内，已忽略`);
            if (app.reset.length > 0) parts.push(`${app.reset.length} 个已填槽位被重置为默认`);
            setSceneMsg(parts.join(' · '));
            return;
          }
          setContextText(selectedScene.id === DEFAULT_SCENE_ID ? '' : sceneSlotsToContextText(selectedScene.slots));
          setSceneMsg(
            selectedScene.id === DEFAULT_SCENE_ID
              ? '已清空调用上下文'
              : `已应用「${selectedScene.name}」到调用上下文文本（作者假设，非引擎事实）`,
          );
        };

        /** 保存当前输入为场景（同名 = 覆盖，保留原 id） */
        const doSaveScene = (): void => {
          let slotsToSave: Record<string, SceneSlotValue>;
          if (callSlots && callSlots.length > 0) {
            slotsToSave = captureSceneSlots(callSlots, slotTexts);
          } else {
            const converted = contextTextToSceneSlots(contextText);
            if (converted === null) {
              setSceneMsg('调用上下文无法解析为槽位（语法：槽位=值，如 0=36, 1="文本"），未保存');
              return;
            }
            slotsToSave = converted;
          }
          const count = Object.keys(slotsToSave).length;
          if (count === 0) {
            setSceneMsg('当前没有可保存的槽位值（空 = 未提供，不入场景）');
            return;
          }
          const name = (sceneNameInput.trim() || sceneSuggestion).slice(0, MAX_SCENE_NAME);
          if (name.length === 0) {
            setSceneMsg('请输入场景名（协议不可用时无建议名）');
            return;
          }
          const sameName = scenes.some((s) => s.name === name);
          if (!sameName && scenes.length >= MAX_SCENES) {
            setSceneMsg(`场景数量已达上限（${MAX_SCENES}）`);
            return;
          }
          const { scenes: next, scene, overwritten } = upsertSceneByName(scenes, name, slotsToSave, () =>
            newSceneId(scenes.map((s) => s.id)),
          );
          persistScenes(next);
          setSelectedSceneId(scene.id);
          setSceneNameInput('');
          setSceneMsg(
            overwritten ? `已覆盖同名场景「${scene.name}」（${count} 槽）` : `已保存场景「${scene.name}」（${count} 槽）`,
          );
        };

        /** 删除选中场景（内置默认场景不可删） */
        const doDeleteScene = (): void => {
          if (selectedScene.id === DEFAULT_SCENE_ID) {
            setSceneMsg('内置默认场景不可删除');
            return;
          }
          persistScenes(removeScene(scenes, selectedScene.id));
          setSelectedSceneId(DEFAULT_SCENE_ID);
          setSceneMsg(`已删除场景「${selectedScene.name}」`);
        };

        // ---- 上下文输入即时校验（红字提示，不阻塞输入） ----
        const contextParse = parseCallContextText(contextText);
        const contextHint =
          contextText.trim().length > 0 && !contextParse.ok
            ? `语法：槽位=值（如 0=36, 1="文本"）— ${contextParse.detail}`
            : null;

        // ---- 函数名提示（条件索引中的名字；子串过滤） ----
        const condIndex = extractor.currentIndex();
        const suggestions =
          condIndex && fnQuery.trim().length >= 2 && !condIndex.byFunction.has(fnQuery.trim().toUpperCase())
            ? suggestFunctions([...condIndex.byFunction.keys()], fnQuery, SUGGEST_LIMIT)
            : [];

        // ---- 选档/选角色 ----
        const archiveSelect = createElement(
          'select',
          {
            className: 'rp-select',
            value: archivePath,
            onChange: (e: { target: { value: string } }) => setArchivePath(e.target.value),
          },
          createElement('option', { value: '' }, archivesReady ? `选择存档（${archives.length}）` : '扫描存档中…'),
          ...archives.map((a) =>
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
          placeholder: '函数名（如 MESSAGE_COM_K12_310_1）',
          value: fnQuery,
          onChange: (e: { target: { value: string } }) => setFnQuery(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Enter') runReplay();
          },
        });
        // 协议槽输入区（有协议 → 替代裸文本框；空值 = 未提供该槽）
        // 槽位来源三态（C9）：未手改的预填 0 = "假设值"——虚线 + 「假设」前缀标记，
        // 与手输确定值在视觉上可区分（不伪装成确定命中）。
        const slotInputs =
          callSlots && callSlots.length > 0
            ? createElement(
                'div',
                { className: 'rp-slots' },
                createElement('span', { className: 'dim rp-slots-head' }, '场景参数'),
                ...callSlots.map((s) => {
                  const k = slotKey(s.kind, s.index);
                  const origin: SlotOrigin = classifySlotValue(s.kind, slotTexts[k] ?? '', slotEdited[k] === true);
                  const isAssume = origin === 'assumption';
                  return createElement(
                    'label',
                    { key: k, className: 'rp-slot', title: isAssume ? `${s.label}（默认场景假设值）` : s.label },
                    isAssume
                      ? createElement(
                          'span',
                          {
                            className: 'rp-badge assume',
                            style: ASSUME_STYLE,
                            title: '默认场景假设值（未手改的预填 0，未必等于引擎真实默认）',
                          },
                          '假设',
                        )
                      : null,
                    createElement('span', { className: 'dim rp-slot-idx' }, `${s.kind === 'str' ? 'ARGS' : 'ARG'}:${s.index}`),
                    createElement('input', {
                      className: 'rp-slot-input',
                      style: isAssume ? ASSUME_STYLE : undefined,
                      type: 'text',
                      value: slotTexts[k] ?? '',
                      placeholder: s.kind === 'int' ? '0' : '',
                      onChange: (e: { target: { value: string } }) => {
                        const v = e.target.value;
                        setSlotTexts((prev) => ({ ...prev, [k]: v }));
                        setSlotEdited((prev) => ({ ...prev, [k]: true })); // 手改 → 确定值
                      },
                    }),
                  );
                }),
                createElement('span', { className: 'dim rp-slot-hint' }, '空 = 未提供（按未知处理）· 未改的预填 0 = 假设值'),
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
          { className: 'ghost small', onClick: doApplyScene, title: '把选中场景应用到当前函数槽位（场景值按作者假设对待）' },
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
          { className: 'ghost small', onClick: doSaveScene, title: '把当前输入保存为场景（同名覆盖）' },
          '保存场景',
        );
        const deleteSceneBtn = createElement(
          'button',
          {
            className: 'ghost small',
            disabled: selectedScene.id === DEFAULT_SCENE_ID,
            onClick: doDeleteScene,
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
          placeholder: callSlots ? '' : '调用上下文（可空；如 0=36, 1=15）',
          value: contextText,
          onChange: (e: { target: { value: string } }) => setContextText(e.target.value),
          title: 'ARG/ARGS 槽位赋值（场景输入）；未提供的槽位按未知处理，不猜测',
        });
        const replayBtn = createElement(
          'button',
          { className: 'ghost small', disabled: replayBusy || !view, onClick: () => runReplay() },
          replayBusy ? '回放中…' : '回放',
        );
        const suggestList =
          suggestions.length > 0
            ? createElement(
                'ul',
                { className: 'rp-suggests' },
                ...suggestions.map((n) =>
                  createElement(
                    'li',
                    { key: n },
                    createElement(
                      'button',
                      { className: 'rp-suggest-btn', onClick: () => setFnQuery(n) },
                      n,
                    ),
                  ),
                ),
              )
            : null;

        // ---- 结果渲染（预览层：状态 → 分支 / 文本预览；实现见 renderReplayPreview） ----
        let resultBody: ReturnType<typeof createElement> | null = null;
        if (result) {
          const emitReveal: EmitReveal = (filePath, line, source) =>
            ctx.bus.emit('editor.revealLocation', { filePath, line, source: source ?? 'ui-state-replay' });
          resultBody = renderReplayPreview({ result, assumedSlots: resultAssumed, emitReveal });
        }

        const replayErrorEl =
          replayError !== null ? createElement('div', { className: 'rp-error' }, replayError) : null;
        const contextHintEl = contextHint !== null ? createElement('div', { className: 'rp-hint dim' }, contextHint) : null;

        if (!projectNow) {
          return createElement(
            'div',
            { className: 'panel-state-replay' },
            createElement('div', { className: 'rp-empty dim' }, '打开项目后可回放（快照 × 角色 × 函数）'),
          );
        }

        return createElement(
          'div',
          { className: 'panel-state-replay' },
          createElement('div', { className: 'rp-toolbar' }, archiveSelect, charaSelect),
          viewStatus,
          createElement('div', { className: 'rp-toolbar' }, fnInput, callSlots ? null : contextInput, replayBtn),
          sceneBar,
          sceneMsgEl,
          slotInputs,
          contextHintEl,
          suggestList,
          replayErrorEl,
          resultBody,
          result === null && !replayError
            ? createElement(
                'div',
                { className: 'rp-empty dim' },
                '选择存档与角色后输入函数名回放；未知结果均带原因分类（近似回放的能力边界）',
              )
            : null,
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'state-replay',
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
