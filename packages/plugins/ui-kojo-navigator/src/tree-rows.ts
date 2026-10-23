/**
 * 函数树面板的**树态渲染**（从 `navigator-panel.ts` 的面板组件原样迁出，DOM 结构与文案逐字不变）。
 *
 * 导出的是**普通渲染函数**（不是组件）⇒ 产出的元素树与原先就地渲染逐层同形，零重挂载风险；
 * 面板把闭包依赖显式传进来（折叠开关 / 图标桥 / 面窗口增长 / 徽章 / 跳转意图），本模块不持状态、
 * 不读 store、不 inject 服务。面函数行的窗口渲染仍委托 `face-list.ts`，窗口数学仍在 `tree.ts`。
 */

import { createElement, type ReactNode } from 'react';
import { shortPath } from '@kojo/plugin-api';
import type { PluginContextMenuAnchor } from '@kojo/plugin-api';
import { FaceList } from './face-list';
import { faceLabel, familyLabel } from './labels';
import { functionTooltip, type CharaNode, type FunctionNode } from './tree';

/** 树态渲染的显式入参（面板每帧构造一次；字段与面板闭包一一对应，不做二次抽象） */
export interface TreeRowsArgs {
  /** 选定角色（面板判空后才走到树态） */
  readonly chara: CharaNode;
  readonly openFamilies: ReadonlySet<string>;
  readonly openFaces: ReadonlySet<string>;
  /** 各已展开面的渲染窗口（行数；缺省 = 初始窗口） */
  readonly faceWindows: ReadonlyMap<string, number>;
  readonly onToggleFamily: (key: string) => void;
  readonly onToggleFace: (key: string) => void;
  readonly onGrowFace: (faceKey: string, total: number) => void;
  /** 面 → 中文标签（适配器提供；缺省 ⇒ 原样显示面 token） */
  readonly faceLabels: () => Readonly<Record<string, string>> | undefined;
  readonly icon: (name: string, size: number, fallback: string) => ReactNode;
  readonly condBadges: (name: string) => ReactNode[];
  readonly replayBadge: (name: string) => ReactNode;
  /** 点击行 = 跳函数意图 */
  readonly onOpen: (fn: FunctionNode) => void;
  /**
   * 右键函数行（1023 批，可选）：面板把菜单交给宿主统一渲染。
   * 可选 ⇒ 旧调用方零改动；不传就是「没有右键菜单」。
   */
  readonly onFunctionMenu?: (fn: FunctionNode, event: PluginContextMenuAnchor) => void;
  /** 右键家族 / 面行（可选）：展开或收起 · 复制名称 */
  readonly onGroupMenu?: (
    target: { kind: 'family' | 'face'; key: string; label: string; expanded: boolean; count: number },
    event: PluginContextMenuAnchor,
  ) => void;
}

export function renderTreeRows(args: TreeRowsArgs): ReactNode {
  const { chara, openFamilies, openFaces, faceWindows } = args;
  return createElement(
    'div',
    { className: 'nav-tree' },
    ...chara.families.map((family) => {
      const fKey = `${chara.no}|${family.family}`;
      const fOpen = openFamilies.has(fKey);
      return createElement(
        'div',
        {
          key: fKey,
          className: 'nav-family',
          ...(args.onGroupMenu === undefined
            ? {}
            : {
                onContextMenu: (e: PluginContextMenuAnchor) =>
                  args.onGroupMenu?.(
                    {
                      kind: 'family',
                      key: fKey,
                      label: familyLabel(family.family),
                      expanded: fOpen,
                      count: family.faces.reduce((n, f) => n + f.functions.length, 0),
                    },
                    e,
                  ),
              }),
        },
        createElement(
          'button',
          { className: 'nav-family-btn', onClick: () => args.onToggleFamily(fKey) },
          createElement('span', { className: 'caret' }, args.icon(fOpen ? 'chevron-down' : 'chevron-right', 12, fOpen ? '▾' : '▸')),
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
                return createElement(
                  'div',
                  {
                    key: fcKey,
                    className: 'nav-face',
                    ...(args.onGroupMenu === undefined
                      ? {}
                      : {
                          onContextMenu: (e: PluginContextMenuAnchor) =>
                            args.onGroupMenu?.(
                              {
                                kind: 'face',
                                key: fcKey,
                                label: faceLabel(face.face, args.faceLabels()),
                                expanded: fcOpen,
                                count: face.functions.length,
                              },
                              e,
                            ),
                        }),
                  },
                  createElement(
                    'button',
                    { className: 'nav-face-btn', onClick: () => args.onToggleFace(fcKey) },
                    createElement('span', { className: 'caret' }, args.icon(fcOpen ? 'chevron-down' : 'chevron-right', 12, fcOpen ? '▾' : '▸')),
                    createElement('span', { className: 'nav-face-name' }, faceLabel(face.face, args.faceLabels())),
                    createElement('span', { className: 'nav-count dim' }, String(face.functions.length)),
                  ),
                  // 面函数列表：窗口化渲染（初始 80 行；触底/点击「显示更多」按 160 步进——
                  // 旧实现是硬截 300 行 + 其余不可达，见 FaceList / tree.ts 的窗口口径）
                  fcOpen
                    ? createElement(FaceList, {
                        key: `${fcKey}|funcs`,
                        faceKey: fcKey,
                        functions: face.functions,
                        limit: faceWindows.get(fcKey),
                        onGrow: args.onGrowFace,
                        badges: (fn: FunctionNode): ReactNode[] => {
                          const badges: ReactNode[] = [];
                          // 徽标写作者的词，不写查表记号（裸 `MC` / `#n` 是内部缩记，
                          // 作者读到的是又一个要背的格式）：MESSAGECHECK 否决钩子是
                          // 「隐藏情景:」「隐藏口上:」的产物；剧本编号沿用项目管理面板的「剧本N」。
                          if (fn.match?.isMessageCheck)
                            badges.push(
                              createElement(
                                'span',
                                {
                                  key: 'mc',
                                  className: 'nav-badge',
                                  title:
                                    '隐藏钩子（MESSAGECHECK 否决钩子）：写「隐藏情景:」「隐藏口上:」时由工具生成，' +
                                    '按 RETURN 位掩码决定跳过游戏情景还是这份口上',
                                },
                                '隐藏钩子',
                              ),
                            );
                          if (fn.match && fn.match.kind === 'declare' && fn.match.selector > 0)
                            badges.push(
                              createElement(
                                'span',
                                {
                                  key: 'sel',
                                  className: 'nav-badge',
                                  title: `剧本${fn.match.selector}：同一家族的这一版口上（多剧本作品按剧本号分开）`,
                                },
                                `剧本${fn.match.selector}`,
                              ),
                            );
                          badges.push(...args.condBadges(fn.name));
                          badges.push(args.replayBadge(fn.name));
                          return badges;
                        },
                        onOpen: args.onOpen,
                        ...(args.onFunctionMenu === undefined ? {} : { onMenu: args.onFunctionMenu }),
                        tooltip: (fn: FunctionNode) => functionTooltip(fn, shortPath),
                      })
                    : null,
                );
              }),
            )
          : null,
      );
    }),
  );
}
