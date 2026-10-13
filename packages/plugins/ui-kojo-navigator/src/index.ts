/**
 * @kojo/plugin-ui-kojo-navigator
 *
 * 口上函数树导航面板（`ui.panel` 槽贡献；v0.2 第二批，HANDOFF §六）。
 *
 * 三维导航：角色 → 家族 → 面 → 函数。数据全来自既有契约：
 *   - `erb.parser`：函数索引（响应式，`kojo.functionChanged` 驱动重建）；
 *   - `game.adapter` 槽位查询 + `project.adapterId` 过滤 → `functionFamilyIndex`
 *     （**不 import 适配器包**——解耦铁律，多游戏共存天然正确）；
 *   - `project.charaIndex`：角色显示名。
 *
 * 呈现层只做「浏览 + 跳转意图」：点击函数 → `editor.revealLocation`（宿主消费）。
 * 文件维度的浏览由 app 壳的 FileTree 承担，本面板负责函数/家族维度。
 */

import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  ConditionExtractorService,
  ErbParserService,
  ErbIndex,
  FamilyIndexRule,
  GameProject,
  Plugin,
  ProjectService,
  SlotRegistry,
  StateDependency,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import {
  buildNavigatorTree,
  functionTooltip,
  searchFunctions,
  shouldRebuildIndex,
  type NavigatorTree,
  type SearchHit,
} from './tree';

/** 单面最多渲染函数数（防 DOM 爆炸） */
const FACE_RENDER_CAP = 300;
/** 搜索结果上限 */
const SEARCH_LIMIT = 200;
/** 搜索最少输入长度 */
const MIN_QUERY = 2;
/** 每行最多显示的条件标签数（其余折叠为 +n） */
const COND_BADGE_CAP = 2;

/** 依赖的悬停提示（标签 + 阈值） */
function dependencyTitle(d: StateDependency): string {
  const label = d.schema?.description ? `${d.schema.description}（${d.key}）` : d.key;
  const comps = d.comparisons.map((c) => `${c.op} ${c.text}`).join('、');
  return comps.length > 0 ? `${label} ${comps}` : label;
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/** 家族显示名：'' = 初始家族 */
function familyLabel(family: string): string {
  return family === '' ? '初始家族' : family;
}

/** 面显示名 */
function faceLabel(face: string): string {
  switch (face) {
    case '':
      return '其它';
    case 'declare':
      return '家族声明';
    default:
      return face;
  }
}

export function createUiKojoNavigatorPlugin(): Plugin {
  return {
    id: 'ui-kojo-navigator',
    version: '0.2.0',
    requires: [
      WellKnownServices.ErbParser,
      WellKnownServices.ConditionExtractor,
      KernelServices.Project,
      KernelServices.Slots,
    ],
    activate(ctx) {
      const parser = ctx.inject<ErbParserService>(WellKnownServices.ErbParser);
      const conditionExtractor = ctx.inject<ConditionExtractorService>(WellKnownServices.ConditionExtractor);
      const project = ctx.inject<ProjectService>(KernelServices.Project);
      const slots = ctx.inject<SlotRegistry>(KernelServices.Slots);

      /** 当前激活适配器的家族规则（多适配器共存时按 adapterId 精确匹配） */
      const currentFamilyIndex = (): FamilyIndexRule | null => {
        const current: GameProject | null = project.current();
        if (!current) return null;
        for (const contribution of slots.query('game.adapter')) {
          if (contribution.adapter.gameId === current.adapterId && contribution.adapter.functionFamilyIndex) {
            return contribution.adapter.functionFamilyIndex;
          }
        }
        return null;
      };

      // ---- 状态（React 外部源；面板组件读取并订阅） ----
      let tree: NavigatorTree | null = null;
      let indexReady = false;
      /** 上一次建树所用的索引实例（去重判据：同一实例不重复建树，见 `shouldRebuildIndex`） */
      let lastBuiltIndex: ErbIndex | null = null;
      /** 索引/建树失败原因（2026-10-11 实机反馈）：此前只在 catch 里 log.warn，
       *  面板永久停在「打开项目后自动构建函数索引…」占位，用户既不知失败也无从重试 */
      let loadError: string | null = null;
      const treeListeners = new Set<() => void>();

      const notify = (): void => {
        for (const cb of [...treeListeners]) {
          try {
            cb();
          } catch (err) {
            ctx.log.warn(`Navigator listener threw: ${String(err)}`);
          }
        }
      };

      const rebuild = (index: ErbIndex | null): void => {
        // 去重（2026-10-12 内核优化批）：`project.opened` 与 `kojo.functionChanged` 会
        // 双双触发 refresh，两者拿到的是同一个索引实例——同一实例不重复建树
        // （`buildNavigatorTree` 在 95k 函数上是近秒级开销，白跑第二遍纯属浪费）。
        if (!shouldRebuildIndex(lastBuiltIndex, index)) return;
        lastBuiltIndex = index;
        if (!index || !project.current()) {
          tree = null;
          indexReady = index !== null;
        } else {
          tree = buildNavigatorTree(index, currentFamilyIndex(), project.current()!.charaIndex);
          indexReady = true;
        }
        loadError = null;
        notify();
      };

      /** 等待索引就绪并重建（项目刚打开时索引可能在途） */
      const refresh = (): void => {
        if (!project.current()) {
          rebuild(null);
          return;
        }
        loadError = null;
        notify();
        void parser
          .ensureIndex()
          .then((index) => rebuild(index))
          .catch((err: unknown) => {
            // 失败必须可见（含建树抛错，此前被同一个 catch 静默吞掉）
            const msg = err instanceof Error ? err.message : String(err);
            loadError = msg;
            indexReady = false;
            ctx.log.error(`Navigator load failed: ${msg}`);
            notify();
          });
      };

      ctx.onDispose(ctx.bus.on('kojo.functionChanged', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.opened', () => refresh()));
      ctx.onDispose(ctx.bus.on('project.closed', () => rebuild(null)));

      // 激活时已有现成索引（插件晚于项目打开加载）→ 立即构建
      if (project.current()) refresh();

      /* ------------------------------ 面板组件 ------------------------------ */

      function NavigatorPanel(): unknown {
        const [, force] = useState(0);
        const [selectedNo, setSelectedNo] = useState<number | null>(null);
        const [query, setQuery] = useState('');
        const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
        const [openFaces, setOpenFaces] = useState<Set<string>>(new Set());

        useEffect(() => {
          const cb = (): void => force((n) => n + 1);
          treeListeners.add(cb);
          return () => {
            treeListeners.delete(cb);
          };
        }, []);

        // 条件索引（后台全量抽取完成后刷新徽章）
        useEffect(() => {
          const off = conditionExtractor.subscribe(() => force((n) => n + 1));
          return off;
        }, []);

        /** 函数行的条件徽章（schema 标签优先；悬停显示阈值） */
        const condBadges = (name: string): ReactNode[] => {
          const cond = conditionExtractor.functionConditions(name.toUpperCase());
          if (!cond) return [];
          const labelled = cond.dependencies.filter((d) => d.schema?.description);
          const out: ReactNode[] = [];
          for (const d of labelled.slice(0, COND_BADGE_CAP)) {
            out.push(
              createElement(
                'span',
                { key: `cond-${d.key}`, className: 'nav-badge cond', title: dependencyTitle(d) },
                d.schema!.description!,
              ),
            );
          }
          if (labelled.length > COND_BADGE_CAP) {
            out.push(
              createElement(
                'span',
                {
                  key: 'cond-more',
                  className: 'nav-badge dim',
                  title: labelled.map((d) => dependencyTitle(d)).join('\n'),
                },
                `+${labelled.length - COND_BADGE_CAP}`,
              ),
            );
          }
          return out;
        };

        const treeNow = tree;
        const chara = treeNow?.charas.find((c) => c.no === selectedNo) ?? null;

        const hits: SearchHit[] = useMemo(() => {
          if (!indexReady || query.trim().length < MIN_QUERY) return [];
          // 索引不变时 query 驱动；parser.currentIndex() 在面板生命周期内稳定
          const idx = parser.currentIndex();
          return idx ? searchFunctions(idx, query, currentFamilyIndex(), SEARCH_LIMIT) : [];
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [query, indexReady, treeNow]);

        const toggle = (setter: typeof setOpenFamilies, key: string): void => {
          setter((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        };

        const open = (filePath: string, line: number, name: string): void => {
          ctx.bus.emit('editor.revealLocation', { filePath, line, source: name });
        };

        /** 回放意图：请求回放面板解释该函数（内核事件，回放面板响应） */
        const requestReplay = (name: string): void => {
          ctx.bus.emit('kojo.replayFunction', { functionName: name, source: 'ui-kojo-navigator' });
        };

        /** 函数行尾的回放按钮（阻止冒泡——外层是跳转按钮） */
        const replayBadge = (name: string): ReactNode =>
          createElement(
            'span',
            {
              className: 'nav-badge replay',
              title: `在状态回放面板中解释 ${name}`,
              onClick: (e: { stopPropagation: () => void }) => {
                e.stopPropagation();
                requestReplay(name);
              },
            },
            '⟲',
          );

        // 失败态优先：显示原因 + 重试（此前静默停在占位，用户无从判断与自救）
        if (loadError) {
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-empty err', title: loadError }, `函数索引加载失败：${loadError}`),
            createElement(
              'button',
              { className: 'small', onClick: () => refresh() },
              '重试',
            ),
          );
        }

        if (!indexReady) {
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-empty dim' }, '正在构建函数索引…（首次打开项目需要数秒）'),
          );
        }

        const charaSelect = createElement(
          'select',
          {
            className: 'nav-chara-select',
            value: selectedNo === null ? '' : String(selectedNo),
            onChange: (e: { target: { value: string } }) => {
              const v = e.target.value;
              setSelectedNo(v === '' ? null : Number(v));
            },
          },
          createElement('option', { value: '' }, treeNow ? `选择角色（${treeNow.charas.length}）` : '选择角色'),
          ...(treeNow?.charas ?? []).map((c) =>
            createElement('option', { key: c.no, value: String(c.no) }, `${c.label}（${c.functionCount}）`),
          ),
        );

        const searchBox = createElement('input', {
          className: 'nav-search',
          type: 'search',
          placeholder: `搜索函数名（≥${MIN_QUERY} 字符，含未归属函数）`,
          value: query,
          onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
        });

        const statusBar = treeNow
          ? createElement(
              'div',
              { className: 'nav-status dim' },
              `${treeNow.totalFunctions} 函数 · ${treeNow.charas.length} 角色` +
                (treeNow.hasFamilyIndex ? ` · 未归属 ${treeNow.orphanCount}` : ' · 适配器未提供家族规则'),
            )
          : null;

        // ---- 搜索模式 ----
        if (query.trim().length >= MIN_QUERY) {
          return createElement(
            'div',
            { className: 'panel-kojo-nav' },
            createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
            statusBar,
            createElement(
              'div',
              { className: 'nav-hits' },
              hits.length === 0
                ? createElement('div', { className: 'nav-empty dim' }, '无匹配函数')
                : createElement(
                    'ul',
                    { className: 'nav-hit-list' },
                    ...hits.map((h, i) =>
                      createElement(
                        'li',
                        { key: `${h.node.filePath}:${h.node.startLine}:${i}` },
                        createElement(
                          'button',
                          {
                            className: 'nav-hit-btn',
                            title: functionTooltip(h.node, shortPath),
                            onClick: () => open(h.node.filePath, h.node.startLine, h.node.name),
                          },
                          createElement('span', { className: 'nav-hit-name' }, h.node.name),
                          ...condBadges(h.node.name),
                          replayBadge(h.node.name),
                          createElement(
                            'span',
                            { className: 'nav-hit-loc dim' },
                            `${h.charaNo !== null ? `K${h.charaNo}` : '—'} · ${shortPath(h.node.filePath)}:${h.node.startLine}`,
                          ),
                        ),
                      ),
                    ),
                  ),
            ),
          );
        }

        // ---- 树模式 ----
        let body: ReactNode;
        if (!chara) {
          body = createElement('div', { className: 'nav-empty dim' }, '从上方选择角色以浏览其口上函数树');
        } else {
          body = createElement(
            'div',
            { className: 'nav-tree' },
            ...chara.families.map((family) => {
              const fKey = `${chara.no}|${family.family}`;
              const fOpen = openFamilies.has(fKey);
              return createElement(
                'div',
                { key: fKey, className: 'nav-family' },
                createElement(
                  'button',
                  { className: 'nav-family-btn', onClick: () => toggle(setOpenFamilies, fKey) },
                  createElement('span', { className: 'caret' }, fOpen ? '▾' : '▸'),
                  createElement('span', { className: 'nav-family-name' }, familyLabel(family.family)),
                  createElement(
                    'span',
                    { className: 'nav-count dim' },
                    String(family.faces.reduce((n, f) => n + f.functions.length, 0)),
                  ),
                ),
                fOpen
                  ? createElement(
                      'div',
                      { className: 'nav-faces' },
                      ...family.faces.map((face) => {
                        const fcKey = `${fKey}|${face.face}`;
                        const fcOpen = openFaces.has(fcKey);
                        const cap = FACE_RENDER_CAP;
                        return createElement(
                          'div',
                          { key: fcKey, className: 'nav-face' },
                          createElement(
                            'button',
                            { className: 'nav-face-btn', onClick: () => toggle(setOpenFaces, fcKey) },
                            createElement('span', { className: 'caret' }, fcOpen ? '▾' : '▸'),
                            createElement('span', { className: 'nav-face-name' }, faceLabel(face.face)),
                            createElement('span', { className: 'nav-count dim' }, String(face.functions.length)),
                          ),
                          fcOpen
                            ? createElement(
                                'ul',
                                { className: 'nav-funcs' },
                                ...face.functions.slice(0, cap).map((fn) => {
                                  const badges: ReactNode[] = [];
                                  if (fn.match?.isMessageCheck) badges.push(createElement('span', { key: 'mc', className: 'nav-badge' }, 'MC'));
                                  if (fn.match?.isPlaceholder) badges.push(createElement('span', { key: 'kx', className: 'nav-badge warn' }, 'KX'));
                                  if (fn.match && fn.match.kind === 'declare' && fn.match.selector > 0)
                                    badges.push(createElement('span', { key: 'sel', className: 'nav-badge' }, `#${fn.match.selector}`));
                                  badges.push(...condBadges(fn.name));
                                  badges.push(replayBadge(fn.name));
                                  return createElement(
                                    'li',
                                    { key: `${fn.filePath}:${fn.startLine}` },
                                    createElement(
                                      'button',
                                      {
                                        className: 'nav-func-btn',
                                        title: functionTooltip(fn, shortPath),
                                        onClick: () => open(fn.filePath, fn.startLine, fn.name),
                                      },
                                      createElement('span', { className: 'nav-func-name' }, fn.name),
                                      ...badges,
                                    ),
                                  );
                                }),
                                face.functions.length > cap
                                  ? createElement(
                                      'li',
                                      { className: 'nav-more dim' },
                                      `其余 ${face.functions.length - cap} 个未显示（用搜索定位）`,
                                    )
                                  : null,
                              )
                            : null,
                        );
                      }),
                    )
                  : null,
              );
            }),
          );
        }

        return createElement(
          'div',
          { className: 'panel-kojo-nav' },
          createElement('div', { className: 'nav-toolbar' }, charaSelect, searchBox),
          statusBar,
          body,
        );
      }

      ctx.slots.register('ui.panel', {
        id: 'kojo-navigator',
        title: '函数树',
        icon: 'structure',
        order: 40,
        // UI 重设计批 P1：与壳层内建口上文件树合并为单 Explorer（定稿 Q5）
        group: 'explorer',
        component: NavigatorPanel,
      });
    },
  };
}
