/**
 * 函数树面板的**纯文案助手**（从 `index.ts` 的模块级区块原样迁出，字符串逐字不变）。
 *
 * 模块级纯函数 ⇒ 可单测：`tests/panel-copy.test.ts` 钉的是口径而不是字符串运气
 * （第一眼必须是作者读得懂的中文短句，原始错误串逐字进悬停 `title`）。
 * 状态行的范围读数 / 归属判据转述也住这里——渲染层只做拼装，不另立文案。
 */

import type { ErbIndexState } from '@kojo/plugin-api';
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
 * 本轮扫描的**原始读数**（悬停用；作者要能查到"哪个来源给了几个根、降级少了什么"）。
 *
 * 只**转录**提供方交出的数字与 tag，本文件一律不重新判形状（判据单源见
 * `erb-parser/index-state.ts`）：`coverage` 那三个字面值在这里只做"tag → 中文"的翻译。
 *
 * IDX-SILENT 追加最后那一行（`filesFailed` > 0 时）：走到的文件里有几个没读进来/没解析出来。
 * 这一行**不是**从 `filesScanned − 文件数` 算的——那一对读数在全成功与被快照顶替的失败轮
 * **同形**（差值都是 0），只有提供方的 `filesFailed` 答得出"这一轮到底有没有走岔"。
 * 提供方没陈述（旧实现，字段缺席）⇒ 这一行不出现，与改前逐字一致。
 */
export function navScanReadout(state: ErbIndexState): string {
  const perSource =
    state.sources
      .map(
        (s) => `${s.source} 交出 ${s.offered} 个根` + (s.available ? '' : `（读不到：${s.reason ?? '原因未给出'}）`),
      )
      .join(' / ') || '本轮还没有过任何来源陈述';
  const lines = [
    `来源：${perSource}`,
    `实际走到的根：${state.rootsWalked} 个 · 已扫文件 ${state.filesScanned} · 名录 ${state.functions} 名`,
    `阶段：${state.phase} · 覆盖：${state.coverage}`,
  ];
  // 缺席（旧实现没陈述）与 0 都不是"有失败"，但也**不许**把缺席写进文案冒充"零失败"：
  // 那一行只由提供方亲口给出的非零条数触发（`filesFailed` 的缺席语义见契约注释）。
  const failed = state.filesFailed;
  if (failed !== undefined && failed > 0) {
    const samples = (state.failures ?? [])
      .map((f) => `${f.path}（${f.reason === 'read' ? '读不到' : '解析失败'}）`)
      .join('；');
    lines.push(`未读入：${failed} 个文件${samples === '' ? '' : `（${samples}）`}`);
  }
  if (state.error !== undefined) lines.push(`错误：${state.error}`);
  return lines.join('\n');
}

/**
 * 索引还没就绪时那一格的**三态人话**（IDX-STATE，取代"永远不变的占位文案"）。
 *
 * 判据一律取自提供方交出的 `phase`（三态是它判的，见 `erb-parser/index-state.ts` 的
 * `phaseOf()`）：本文件只做 `phase → 文案` 的**查表**，一个形状比较都不写——
 * 旧形态是"只要 `indexReady` 为假就永远说'正在构建函数索引'"，索引永远建不出来
 * （0 个可扫描位置）时那句话是**假话**，作者只能干等。
 *
 * `state === null` = 提供方没交事实（契约 additive 方法缺席的老实现）⇒ 退回原等待句，
 * 旧行为零改动；失败态复用 {@link navLoadErrorCopy}，这里**不另立第二套失败文案**。
 */
export function navIndexPendingCopy(state: ErbIndexState | null): { readonly text: string; readonly title: string } {
  if (!state) return { text: pendingTextOf('idle'), title: '提供方未给出索引状态（本轮无读数可查）' };
  if (state.phase === 'failed') {
    const reused = navLoadErrorCopy(state.error ?? '');
    return { text: reused.text, title: `${reused.title}\n${navScanReadout(state)}` };
  }
  return { text: pendingTextOf(state.phase), title: navScanReadout(state) };
}

/**
 * 树已经建好、但那一格该说的是"空"这条裁决时的正文（IDX-STATE）。
 *
 * 为什么不能只改等待那一格：0 个根的那一轮**照旧产出一副空索引**（`index` 非 null、
 * 既有广播照常发），于是面板早晚会走到树模式，`totalFunctions` 为 0 时上屏的是
 * 「从上方选择角色以浏览其口上函数树」——对"根本没地方可扫"同样是一句假话。
 * 这里查的还是同一枚 `phase`、同一张表：提供方没判出"空"⇒ 交回原句，既有行为零改动。
 */
export function navTreeBodyCopy(state: ErbIndexState | null, fallback: string): string {
  if (!state) return fallback;
  return PHASE_COPY[state.phase]?.verdict ?? fallback;
}

/** 三句第一眼短句（表与兜底共用同一组常量，两处各写一份字符串必然漂移） */
const BUILDING_TEXT = '正在构建函数索引…（首次打开项目需要数秒）';
const NOTHING_TO_SCAN_TEXT = '没有可扫描的位置：这个项目没有口上目录，授权的工作区也是空的（悬停看本轮扫了哪里）';
const EMPTY_AFTER_SCAN_TEXT = '扫过了，确实一个函数都没有（悬停看扫了哪些位置、几个文件）';

/** 等待句与"空"裁决共用一张表 */
const PHASE_COPY: Readonly<Record<string, { readonly pending: string; readonly verdict: string | null }>> = {
  idle: { pending: BUILDING_TEXT, verdict: null },
  scanning: { pending: BUILDING_TEXT, verdict: null },
  ready: { pending: BUILDING_TEXT, verdict: null },
  'nothing-to-scan': { pending: NOTHING_TO_SCAN_TEXT, verdict: NOTHING_TO_SCAN_TEXT },
  empty: { pending: EMPTY_AFTER_SCAN_TEXT, verdict: EMPTY_AFTER_SCAN_TEXT },
};

/** 表里没有的阶段（提供方将来加态）按等待句兜底 ⇒ 绝不静默空白 */
function pendingTextOf(phase: string): string {
  return PHASE_COPY[phase]?.pending ?? BUILDING_TEXT;
}

/**
 * 覆盖 tag → 状态行的那一寸（IDX-STATE 铁律 4：**只扫了口上根的那棵树，状态行就得看出来**，
 * 与扫全了的那棵**不同形**）。
 *
 * 这里是一张**按 tag 查的表**，没有任何形状比较——"少了哪一类位置"由提供方那一枚
 * `coverageOf()` 判（`erb-parser/index-state.ts`），本文件再算一次就是第二份真相。
 */
const COVERAGE_COPY: Readonly<Record<string, { readonly mark: string; readonly title: string }>> = {
  full: { mark: '', title: '位置覆盖：该读的位置本轮都读到了' },
  partial: {
    mark: ' · 少扫了一类位置',
    title: '位置覆盖：至少一类位置本轮读不到 ⇒ 这棵树只由读得到的那些位置建成（悬停看逐来源读数）',
  },
  none: { mark: ' · 没扫到位置', title: '位置覆盖：本轮一个可扫描的位置都没走到' },
};

/** 状态行的覆盖标记 + 悬停那一行（提供方没交事实 ⇒ 两个都空，不假装知道） */
export function navCoverageCopy(state: ErbIndexState | null): { readonly mark: string; readonly title: string } {
  if (!state) return { mark: '', title: '' };
  return COVERAGE_COPY[state.coverage] ?? { mark: '', title: '' };
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

/**
 * 状态行的悬停读数：范围 + 角色归属用的是哪条判据（判据切换不许静默，铁律 4）+
 * 本轮的位置覆盖（IDX-STATE 追加第二参；不传 ⇒ 与旧输出逐字相同，旧调用零改动）。
 */
export function navigatorScopeTitle(tree: NavigatorTree, state?: ErbIndexState | null): string {
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
  const coverageLine = navCoverageCopy(state ?? null).title;
  return `${scopeLine}\n${attributionLine}${coverageLine === '' ? '' : `\n${coverageLine}\n${navScanReadout(state!)}`}`;
}
