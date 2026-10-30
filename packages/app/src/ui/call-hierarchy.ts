import type { ContextMenuItem } from './context-menu-model';
/** 跨文件 resolver 的形状（`import type` 只活到编译期：本模块不进开机图） */
import type { Kojo2CallHierarchyResolvers } from '@kojo/kojo-lang/call-hierarchy';

/**
 * 调用层级 overlay 的宿主状态（2026-10-16 批 E；批次十 2026-10-23 补 kojo2 分派）。
 *
 * 形态照 `diff-view.ts` / `file-history.ts` 同款：模块级单源 + 订阅，零 React、
 * 零 Monaco 运行时，node 可单测。意图经 `editor.command` 进来（命令面板条目，宿主
 * App.tsx 注册）；位点（文件 + 光标行）由命令侧现取 `readJumpProbe()`（G1 既有
 * 探针，EditorPane 挂载时注册）——不新建第二套"光标在哪"的通道。
 *
 * kojo2 的取数（"位点 → 可调用声明 → 出入边"）不在本模块：它随
 * `@kojo/kojo-lang/call-hierarchy`（SDK-B5b 车 C 起判据住语言面库）一起**懒装载**——
 * 那边的解析器会让开机图多出一大坨（PS-10 ① 的体积闸），面板首次遇到 kojo2 文件时才走
 * {@link loadKojo2CallHierarchyPanelBundle} 的动态边；跨文件 resolver 同理（项目索引住在
 * `ui/editor-global-providers.ts`）。
 * 两条腿装好后写回模块级快照 {@link kojo2PanelBundle}：**再打开面板同步取用**，
 * 不再每次 await（批次十一 CALLHIER-INJECT 的收口点）。本模块保持零值依赖
 * （`import type` 会被擦除，真正的模块只在动态边里出现，不进开机图）。
 */

/** ui.overlay 贡献 id（`App.tsx` 接线注册；开/关窗走 `ui.overlay.open`/`close`） */
export const CALL_HIERARCHY_OVERLAY_ID = 'kojo.callHierarchy';

/** editor.command 贡献 id（命令面板条目） */
export const CALL_HIERARCHY_COMMAND_ID = 'kojo.showCallHierarchy';

/** 一次查询的位点：文件 + 光标行/列（1 基，模型坐标） */
export interface CallHierarchyRequest {
  readonly filePath: string;
  readonly line: number;
  /** 光标列（additive 可选：kojo2 的 prepare 按格子判定，缺席时按行首问） */
  readonly column?: number;
}

/**
 * 状态三态：就绪请求 / 可见拒绝（位点取不到时的原因——拒绝必须进面板，不许
 * 只进控制台，铁律「不静默」）/ 无（未开过或已清）。
 */
export type CallHierarchyState =
  | { readonly kind: 'request'; readonly request: CallHierarchyRequest }
  | { readonly kind: 'rejected'; readonly reason: string }
  | null;

let current: CallHierarchyState = null;
const listeners = new Set<() => void>();

export function getCallHierarchyState(): CallHierarchyState {
  return current;
}

export function setCallHierarchyState(next: CallHierarchyState): void {
  current = next;
  for (const cb of [...listeners]) cb();
}

export function subscribeCallHierarchy(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/* ==================== 右键菜单（WP3.4 · 1023 覆盖面批） ==================== */

/**
 * 面子 id（= 面板根元素的 `data-context-surface`；已在清单预登记）。
 *
 * 菜单**只做入口**：跳转复用面板自己的 `deps.reveal`，重定查询复用
 * `setCallHierarchyState`（命令面板开这一屏走的就是这条通道），展开更多行复用
 * 两个 section 的窗口步进——本文件不新增任何查询能力或第二套导航。
 */
export const CALL_HIERARCHY_SURFACE_ID = 'call-hierarchy';

/** 菜单项 id（面自己分发；不是命令 id，不冒充命令） */
export const CALL_HIERARCHY_MENU_IDS = {
  jump: 'ch.jump',
  recenter: 'ch.recenter',
  copyChain: 'ch.copyChain',
  copyLocation: 'ch.copyLocation',
  copyList: 'ch.copyList',
  expandIn: 'ch.expand.in',
  expandOut: 'ch.expand.out',
  refresh: 'ch.refresh',
  close: 'ch.close',
} as const;

export type CallHierarchySection = 'in' | 'out';

/** 右键命中的一行（组行 = 一个调用者/被调者，点位行 = 一处调用点） */
export interface CallHierarchyRowRef {
  readonly kind: 'group' | 'site';
  readonly section: CallHierarchySection;
  /** 组行 = 函数名；点位行 = 所属组名（可能为空串） */
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly column: number | null;
  /** 组行名下点位数 */
  readonly count: number;
  /** 组行名下全部点位（`path:line:column`，按渲染顺序） */
  readonly sites: readonly string[];
}

/** 一次菜单构建的全部输入（纯数据；测试直接构造） */
export interface CallHierarchyMenuInput {
  /** null = 没点在行上（面板级菜单） */
  readonly row: CallHierarchyRowRef | null;
  /** 面板正在查看的函数（null = 还没有请求） */
  readonly subject: { readonly name: string; readonly path: string; readonly line: number } | null;
  /** 当前环境有没有剪贴板写入口（没有 ⇒ 复制项禁用并说清原因） */
  readonly clipboardAvailable: boolean;
  /** 入 / 出两个 section 还有多少行没画出来（0 = 不给「展开更多行」） */
  readonly hidden: { readonly in: number; readonly out: number };
  /** 两个 section 各自的总行数（窗口步进要用它算下一档上界） */
  readonly total: { readonly in: number; readonly out: number };
  /** 整屏清单的可复制文本（组行逐条成链；空串 ⇒ 复制清单禁用） */
  readonly listText: string;
}

/** 一条调用链的可复制文本：`名字（path:line）` + 逐处 `↳ path:line:column` */
export function callChainText(row: CallHierarchyRowRef): string {
  const head = `${row.name === '' ? '调用' : row.name}（${row.path}:${row.line}）`;
  const rest = row.sites.map((site) => `\n  ↳ ${site}`);
  return rest.length === 0 ? head : head + rest.join('');
}

/** 点位行的可复制位置 */
export function callSiteLocationText(row: CallHierarchyRowRef): string {
  return row.column === null ? `${row.path}:${row.line}` : `${row.path}:${row.line}:${row.column}`;
}

function copyDisabledReason(clipboardAvailable: boolean): string | undefined {
  return clipboardAvailable ? undefined : '当前环境没有可用的剪贴板';
}

/**
 * 调用层级菜单（纯函数）：输入上下文 → 菜单项。
 *
 * 分组：`这一行`（跳转 / 重定查询 / 复制）→ `显示`（展开更多行 / 刷新）→ 末尾关闭。
 * 行的能力差异：组行给「复制调用链」，点位行给「复制位置」；「查看调用者的调用层级」
 * 只在入调用侧的点位行出现（出调用侧的点位就在当前函数体内，重定查询等于原地绕圈）。
 */
export function buildCallHierarchyMenu(input: CallHierarchyMenuInput): { items: ContextMenuItem[] } | null {
  const items: ContextMenuItem[] = [];
  const copyReason = copyDisabledReason(input.clipboardAvailable);
  const row = input.row;

  if (row !== null) {
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.jump,
      label: row.kind === 'group' ? '跳转到定义' : '跳转到调用处',
      icon: 'target',
      group: '这一行',
    });
    if (row.kind === 'group' || row.section === 'in') {
      items.push({
        id: CALL_HIERARCHY_MENU_IDS.recenter,
        label: row.kind === 'group' ? '查看此函数的调用层级' : '查看调用者的调用层级',
        icon: 'search',
      });
    }
    if (row.kind === 'group') {
      items.push({
        id: CALL_HIERARCHY_MENU_IDS.copyChain,
        label: `复制调用链（${row.count} 处）`,
        icon: 'files',
        ...(copyReason === undefined ? {} : { disabled: true, disabledReason: copyReason }),
      });
    }
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.copyLocation,
      label: '复制位置',
      icon: 'files',
      ...(copyReason === undefined ? {} : { disabled: true, disabledReason: copyReason }),
    });
  }

  // 面板级：没有"当前查看的函数"时只剩刷新 / 关闭（不摆读不出东西的入口）。
  // 行上已经给过「查看…的调用层级」时不再重复一条——同 id 两项会让分发认不出是谁
  if (row === null && input.subject !== null) {
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.recenter,
      label: '查看当前函数的调用层级',
      icon: 'search',
      group: '这一屏',
    });
  }
  if (input.listText !== '') {
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.copyList,
      label: '复制调用清单',
      icon: 'files',
      dividerBefore: row === null && input.subject === null,
      ...(copyReason === undefined ? {} : { disabled: true, disabledReason: copyReason }),
    });
  }

  if (input.hidden.in > 0) {
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.expandIn,
      label: `展开更多被调用行（还有 ${input.hidden.in} 行）`,
      icon: 'structure',
      group: '显示',
    });
  }
  if (input.hidden.out > 0) {
    items.push({
      id: CALL_HIERARCHY_MENU_IDS.expandOut,
      label: `展开更多调用行（还有 ${input.hidden.out} 行）`,
      icon: 'structure',
      ...(input.hidden.in > 0 ? {} : { group: '显示' }),
    });
  }

  items.push({
    id: CALL_HIERARCHY_MENU_IDS.refresh,
    label: '刷新调用层级',
    icon: 'refresh',
    // 没有请求时"刷新"没有对象：禁用并说明（不静默）
    ...(input.subject === null
      ? { disabled: true, disabledReason: '还没有在查看任何函数，先按一次「查看调用层级」' }
      : {}),
    ...(input.hidden.in > 0 || input.hidden.out > 0 ? {} : { dividerBefore: true }),
  });
  items.push({ id: CALL_HIERARCHY_MENU_IDS.close, label: '关闭', icon: 'close' });
  return { items };
}

/* --------------------------- DOM 读取（面 → 纯输入） --------------------------- */

function attrNumber(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 行元素的 `data-ch-*` → 行引用（读不出身份 ⇒ null，面据此回落到面板级菜单） */
export function readCallHierarchyRow(target: HTMLElement): CallHierarchyRowRef | null {
  const el = target.closest<HTMLElement>('[data-ch-row]');
  if (el === null) return null;
  const kind = el.getAttribute('data-ch-row');
  const path = el.getAttribute('data-ch-path');
  const line = attrNumber(el, 'data-ch-line');
  if ((kind !== 'group' && kind !== 'site') || path === null || line === null) return null;
  const chain = el.getAttribute('data-ch-chain');
  return {
    kind,
    section: el.getAttribute('data-ch-section') === 'out' ? 'out' : 'in',
    name: el.getAttribute('data-ch-name') ?? '',
    path,
    line,
    column: attrNumber(el, 'data-ch-column'),
    count: attrNumber(el, 'data-ch-count') ?? 0,
    sites: chain === null || chain === '' ? [] : chain.split('\n'),
  };
}

/**
 * 被右击元素 → 菜单输入（DOM 读；面板级事实写在面根元素的 `data-ch-*` 上，
 * 于是模块顶层的 `build` 不需要 React 闭包也能拿到当前查看对象与两档行数）。
 */
export function readCallHierarchyMenuInput(
  target: HTMLElement,
  opts: { readonly clipboardAvailable: boolean },
): CallHierarchyMenuInput {
  const root =
    target.closest<HTMLElement>(`[data-context-surface="${CALL_HIERARCHY_SURFACE_ID}"]`) ??
    target.closest<HTMLElement>('[data-context-surface]');
  const subjectPath = root?.getAttribute('data-ch-subject-path') ?? null;
  const subjectLine = root === null ? null : attrNumber(root, 'data-ch-subject-line');
  const subject =
    root === null || subjectPath === null || subjectLine === null
      ? null
      : { name: root.getAttribute('data-ch-subject-name') ?? '', path: subjectPath, line: subjectLine };
  // 清单 = 屏上这些组行拼成的层次文本（不多不少，与看到的一致）
  const groupRows = root === null ? [] : [...root.querySelectorAll<HTMLElement>('[data-ch-row="group"]')];
  const listText = groupRows
    .map((el) => {
      const row = readCallHierarchyRow(el);
      return row === null ? '' : callChainText(row);
    })
    .filter((text) => text !== '')
    .join('\n\n');
  return {
    row: readCallHierarchyRow(target),
    subject,
    clipboardAvailable: opts.clipboardAvailable,
    hidden: {
      in: root === null ? 0 : (attrNumber(root, 'data-ch-hidden-in') ?? 0),
      out: root === null ? 0 : (attrNumber(root, 'data-ch-hidden-out') ?? 0),
    },
    total: {
      in: root === null ? 0 : (attrNumber(root, 'data-ch-total-in') ?? 0),
      out: root === null ? 0 : (attrNumber(root, 'data-ch-total-out') ?? 0),
    },
    listText,
  };
}

/* ============================== kojo2 分支的懒装载边 ============================== */

/**
 * kojo2 取数模块的形状（`import type` 只活到编译期：本模块不进开机图）。
 *
 * 取数与 provider 都在 `@kojo/kojo-lang/call-hierarchy`（纯模型 + 宿主自建面板的取数层；
 * SDK-B5b 车 C 起判据住语言面库，宿主不再持有这一份），
 * 那里会拉起 `@kojo/kojo-core` 的解析器——所以只能走动态边，见模块头。
 */
export type Kojo2PanelApi = typeof import('@kojo/kojo-lang/call-hierarchy');

let kojo2PanelModule: Promise<Kojo2PanelApi> | null = null;

/**
 * 懒装载 kojo2 取数模块（进程内一次；失败也记住，由面板把错误画成可见态）。
 *
 * 动态 `import()` 是 PS-10 ① 的既有形态：静态图不许有解析器，首次打开 kojo2 文件时才拉。
 */
export function loadKojo2CallHierarchyPanel(): Promise<Kojo2PanelApi> {
  kojo2PanelModule ??= import('@kojo/kojo-lang/call-hierarchy');
  return kojo2PanelModule;
}

/* ============================== kojo2 分支的就绪面（批次十一） ============================== */

/**
 * kojo2 分支的就绪上下文：取数模块（provider 工厂 + 取数函数）+ 项目索引交出的跨文件
 * resolver。
 *
 * **缺口**（批次十一定位）：resolver 住在 `ui/editor-global-providers.ts`（项目索引
 * `kojo2ProjectIndex` 的所在），面板此前从未接上它——`resolveKojo2CallHierarchy` 退到
 * `createKojo2CallHierarchyProvider()` 的默认腿，只算同文件，跨文件入 / 出边永远不可见。
 * 两条腿都只能走动态 `import()`（PS-10 ① 开机图闸），所以在这里合成一条 Promise 一起等：
 * 就位后写模块级快照 {@link kojo2PanelBundle}，**面板第二次打开直接同步取用**，
 * 首帧只有在真正装载时才显示加载态（不许拿"只同文件"冒充空态）。
 */
export interface Kojo2PanelBundle {
  readonly api: Kojo2PanelApi;
  readonly resolvers: Kojo2CallHierarchyResolvers;
}

let kojo2ResolversModule: Promise<Kojo2CallHierarchyResolvers> | null = null;
let kojo2Bundle: Kojo2PanelBundle | null = null;
let kojo2BundleModule: Promise<Kojo2PanelBundle> | null = null;

/** 已装载的就绪上下文（同步；`null` = 还没装好——面板据此显示加载态） */
export function kojo2PanelBundle(): Kojo2PanelBundle | null {
  return kojo2Bundle;
}

/**
 * 懒装载跨文件 resolver（进程内一次；失败不钉死，收起面板重开会重试——与面板文案同一承诺）。
 *
 * resolver 由项目索引**现造**、每次查询读实时索引 ⇒ 扫描 / 保存把新文件喂进索引后，
 * 再次打开面板即可拿到新的跨文件边，不需要重新装载。
 */
export function loadKojo2CallHierarchyResolvers(): Promise<Kojo2CallHierarchyResolvers> {
  kojo2ResolversModule ??= import('./editor-global-providers').then(
    (host) => host.kojo2CallHierarchyResolvers(),
    (error: unknown) => {
      kojo2ResolversModule = null;
      throw error;
    },
  );
  return kojo2ResolversModule;
}

/** 两条腿一起等（解析器模块 + 项目索引 resolver）；就绪后写模块级快照。 */
export function loadKojo2CallHierarchyPanelBundle(): Promise<Kojo2PanelBundle> {
  kojo2BundleModule ??= Promise.all([
    loadKojo2CallHierarchyPanel(),
    loadKojo2CallHierarchyResolvers(),
  ]).then(
    ([api, resolvers]) => (kojo2Bundle = { api, resolvers }),
    (error: unknown) => {
      kojo2BundleModule = null;
      throw error;
    },
  );
  return kojo2BundleModule;
}
