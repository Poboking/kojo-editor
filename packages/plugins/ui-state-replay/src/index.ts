/**
 * @kojo/plugin-ui-state-replay
 *
 * 状态回放面板（`ui.panel` 槽贡献；v0.2 第八批，架构 §5.14）。
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
import { groupUnknowns, parseCallContextText, suggestFunctions, toCallContext } from './panel-logic';

/** 函数名提示上限 */
const SUGGEST_LIMIT = 50;
/** 谓词渲染上限（防 DOM 爆炸；单函数谓词通常 <100） */
const PRED_RENDER_CAP = 300;

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

/** 单条分支链的呈现（按 depth 缩进；命中成员高亮，点击跳源码） */
type EmitReveal = (filePath: string, line: number) => void;

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
        /** 协议槽位输入（key = 槽位号；值 = 用户文本；int 缺省 '0'、str 缺省 ''） */
        const [slotTexts, setSlotTexts] = useState<Record<number, string>>({});
        const [result, setResult] = useState<FunctionReplay | null>(null);
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
          const init: Record<number, string> = {};
          for (const s of callSlots) init[s.index] = s.kind === 'int' ? '0' : '';
          setSlotTexts(init);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [slotsKey]);

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
        useEffect(() => {
          const un = ctx.bus.on('kojo.replayFunction', (ev) => {
            setFnQuery(ev.functionName);
            void runReplay(ev.functionName);
          });
          return un;
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [archivePath, charaNo, contextText]);

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
              const raw = slotTexts[s.index] ?? '';
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
          setReplayBusy(true);
          void replay
            .replayFunction(view, name, { callContext })
            .then((r) => {
              if (r === null) {
                setReplayError(`函数不在条件索引中（未解析到该函数的谓词）：${name}`);
                setResult(null);
                return;
              }
              setResult(r);
            })
            .catch((err: unknown) => {
              setReplayError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setReplayBusy(false));
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
          placeholder: '函数名（如 M_KOJO_ORTHODOX_EVENT_K49_1）',
          value: fnQuery,
          onChange: (e: { target: { value: string } }) => setFnQuery(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === 'Enter') runReplay();
          },
        });
        // 协议槽输入区（有协议 → 替代裸文本框；空值 = 未提供该槽）
        const slotInputs =
          callSlots && callSlots.length > 0
            ? createElement(
                'div',
                { className: 'rp-slots' },
                createElement('span', { className: 'dim rp-slots-head' }, '场景参数'),
                ...callSlots.map((s) =>
                  createElement(
                    'label',
                    { key: `${s.kind}${s.index}`, className: 'rp-slot', title: s.label },
                    createElement('span', { className: 'dim rp-slot-idx' }, `${s.kind === 'str' ? 'ARGS' : 'ARG'}:${s.index}`),
                    createElement('input', {
                      className: 'rp-slot-input',
                      type: 'text',
                      value: slotTexts[s.index] ?? '',
                      placeholder: s.kind === 'int' ? '0' : '',
                      onChange: (e: { target: { value: string } }) =>
                        setSlotTexts((prev) => ({ ...prev, [s.index]: e.target.value })),
                    }),
                  ),
                ),
                createElement('span', { className: 'dim rp-slot-hint' }, '空 = 未提供（按未知处理）'),
              )
            : null;
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

        // ---- 结果渲染 ----
        let resultBody: ReturnType<typeof createElement> | null = null;
        if (result) {
          const conf = CONFIDENCE_BADGE[result.confidence];
          const unknowns = groupUnknowns(result);
          const emitReveal: EmitReveal = (filePath, line) =>
            ctx.bus.emit('editor.revealLocation', { filePath, line, source: 'ui-state-replay' });
          const branchSection =
            result.branches.length > 0
              ? createElement(
                  'div',
                  { className: 'rp-branches' },
                  createElement('div', { className: 'dim rp-branches-head' }, `分支走向（${result.branches.length} 条链）`),
                  ...result.branches.map((b, i) => branchRow(b, result.filePath, emitReveal, `b${b.headLine}:${i}`)),
                )
              : null;
          resultBody = createElement(
            'div',
            { className: 'rp-result' },
            createElement(
              'div',
              { className: 'rp-summary' },
              createElement('span', { className: conf.className }, conf.label),
              createElement('span', { className: 'rp-count hit' }, `命中 ${result.stats.hit}`),
              createElement('span', { className: 'rp-count miss' }, `未命中 ${result.stats.miss}`),
              createElement('span', { className: 'rp-count unk' }, `未知 ${result.stats.unknown}`),
              createElement('span', { className: 'dim rp-meta' }, `共 ${result.stats.total} 谓词 · ${shortPath(result.filePath)}:${result.startLine}`),
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
                const ok = p.outcome.kind === 'true';
                const bad = p.outcome.kind === 'false';
                const cls = p.outcome.kind === 'true' ? 'rp-outcome hit' : p.outcome.kind === 'false' ? 'rp-outcome miss' : 'rp-outcome unk';
                return createElement(
                  'li',
                  { key: `${p.line}:${i}` },
                  createElement(
                    'button',
                    {
                      className: 'rp-pred-btn',
                      title: `${result.filePath}:${p.line}${p.outcome.kind === 'unknown' ? ` — ${p.outcome.unknown.message}` : ''}`,
                      onClick: () => ctx.bus.emit('editor.revealLocation', { filePath: result.filePath, line: p.line, source: result.normalizedName }),
                    },
                    createElement('span', { className: 'rp-kind' }, p.kind),
                    createElement('span', { className: cls }, OUTCOME_LABEL[p.outcome.kind] ?? '?'),
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
        icon: '⟲',
        order: 60,
        component: ReplayPanel,
      });
    },
  };
}
