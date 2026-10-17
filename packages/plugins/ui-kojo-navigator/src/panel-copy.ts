/**
 * 函数树面板的**纯文案助手**（从 `index.ts` 的模块级区块原样迁出，字符串逐字不变）。
 *
 * 模块级纯函数 ⇒ 可单测：`tests/panel-copy.test.ts` 钉的是口径而不是字符串运气
 * （第一眼必须是作者读得懂的中文短句，原始错误串逐字进悬停 `title`）。
 * 状态行的范围读数 / 归属判据转述也住这里——渲染层只做拼装，不另立文案。
 */

import type { NavigatorTree } from './tree';

/**
 * 函数树失败态的第一眼文案（模块级纯函数 ⇒ 可单测；范式抄 `ui-condition-matrix` 的收口）。
 *
 * 上屏的必须是**作者读得懂的中文短句**，内部原始错误串（`ensureIndex` / `buildNavigatorTree`
 * 抛出的 message，往往是路径 + 栈式英文片段）只进悬停 `title`——技术信息一条不丢，
 * 但它不是甩给作者的第一眼。
 */
export function navLoadErrorCopy(loadError: string): { readonly text: string; readonly title: string } {
  return {
    text: '函数树加载失败：口上函数索引构建出错（悬停查看原始错误）',
    title: loadError,
  };
}

/**
 * 状态行的范围后缀（W7 NAV-SCOPE）：**"只看"生效了就必须看得见，没生效也不装作生效过**。
 *
 * 读数说"扫了多少个文件"而不是"共多少函数"——这条通道与全文检索共用同一个戳，
 * 两边的数字必须能对上，而"文件数"是唯一能直接对上的那一项。
 */
export function navigatorScopeSuffix(tree: NavigatorTree): string {
  if (tree.scopeKey === '') return '';
  return ` · 只看范围内 ${tree.filesScanned} 个文件`;
}

/** 状态行的悬停读数：范围 + 角色归属用的是哪条判据（判据切换不许静默，铁律 4） */
export function navigatorScopeTitle(tree: NavigatorTree): string {
  const scopeLine =
    tree.scopeKey === ''
      ? '范围：不限（全项目函数）'
      : `范围：只看所选位置（已扫 ${tree.filesScanned} 个文件；范围外的文件没有看）`;
  const attributionLine =
    tree.attribution === 'dir'
      ? '角色归属：按角色目录（与检索范围同一条判据）'
      : tree.attribution === 'name'
        ? '角色归属：按函数名（提供方没有给出角色目录）'
        : '角色归属：不可用（既没有角色目录也没有家族规则）';
  return `${scopeLine}\n${attributionLine}`;
}
