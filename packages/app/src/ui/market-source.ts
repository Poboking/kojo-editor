/**
 * 设置页的「注册表来源」一行（KM-9）——零 React 纯逻辑，判据可直接跑。
 *
 * **真相只住一处**：端点存进 `market` 服务（= `kojo-market` 插件的 `ctx.storage` 域），
 * 面板取数、刷新、设置页读写的都是同一个 `MarketService.endpoint()`。
 * 设置页里那些界面偏好（动效 / 视口化 / 封存）走 localStorage 是有原因的——它们只影响壳自己的渲染；
 * **注册表地址是数据源**，插件够不着 localStorage、壳也不该去抄一份，抄了就是第二份设置真相。
 *
 * **这里没有代理输入框，也没有代理开关**（刻意）：
 * 受众绝大部分没有代理客户端，跟随系统 / 进程环境即可；而 JS 能递进来的代理等于
 * "任意代理能对白名单 URL 回任意字节、还能把请求转去内网"（SSRF），前一名 agent 已按洞收掉。
 * 因此本行的全部可编辑项 = 一个 URL。现实约束：主机白名单在平台侧（当前仅放行
 * GitHub 系主机与 *.github.io 一级子域），形态过了、保存能成 ≠ 拉取能通。
 */

import { MARKET_DEFAULT_INDEX_URL, MarketError, endpointProblem, type MarketService } from '@kojo/plugin-api';

/** 输入框内容 → 该做什么（`''` = 撤销覆盖、回到默认，不是"存一个空地址"） */
export type EndpointEdit =
  | { readonly kind: 'keep' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'set'; readonly url: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * 点「保存」时的判定（纯函数）：与生效值一致 ⇒ 什么都不做（不写存储、不发"改好了"的假回执）。
 * 形态闸只核 `https` / 可解析（`endpointProblem` 住在契约）——**主机白名单在平台侧**，
 * 这里再写一份就是第二份真相，而且它会漂。
 */
export function planEndpointEdit(draft: string, effective: string): EndpointEdit {
  const trimmed = draft.trim();
  if (trimmed === effective) return { kind: 'keep' };
  if (trimmed === '') return { kind: 'reset' };
  const problem = endpointProblem(trimmed);
  if (problem !== null) return { kind: 'invalid', reason: problem };
  return { kind: 'set', url: trimmed };
}

/** 是否处于"作者自建源"状态（默认值只住契约常量，这里比字面、不复制常量） */
export function isOverridden(effective: string): boolean {
  return effective !== MARKET_DEFAULT_INDEX_URL;
}

/**
 * 草稿与生效值是否等价（等价 ⇒ 保存按钮根本没有可点性，而不是点完回一句「没有改动」）。
 * 空草稿在"本来就用默认地址"时等价于不动——壳里空框 = 跟默认，这是既有约定，不是新真相源。
 */
export function isDraftNoop(draft: string, effective: string): boolean {
  const trimmed = draft.trim();
  if (trimmed === effective) return true;
  return trimmed === '' && effective === MARKET_DEFAULT_INDEX_URL;
}

/** 行内提示的三态着色口径（成功 / 失败 / 中性）；只复用设置页既有的 `.settings-hint` 着色，不新增样式 */
export type MarketNoteTone = 'ok' | 'err' | 'dim';

/**
 * 「是不是失败」按 applyEndpointEdit 的既有文案口径判，住在这一侧，
 * 免得 React 里到处散落 `note.startsWith('没有保存')` 那种临时猜字符串。
 */
export function classifyNote(note: string): MarketNoteTone {
  if (note === '') return 'dim';
  // 已改用… / 已恢复…：写成功了
  if (note.startsWith('已')) return 'ok';
  // 没有保存：…（输入不合法 / 服务拒写）＋ 这一项现在改不了 / 读不出来（缺席、读取失败）
  if (note.startsWith('没有保存') || note.includes('改不了') || note.includes('读不出来')) return 'err';
  // 没有改动、读取中…：不是坏事，也不值得抢视线
  return 'dim';
}

/** 三态 → 既有类名（设置页那三个 hint 类是唯一视觉来源；这里只做映射，不造新类） */
export function hintClassFor(tone: MarketNoteTone): string {
  if (tone === 'ok') return 'settings-hint is-ok';
  if (tone === 'err') return 'settings-hint is-err';
  return 'settings-hint';
}

/** 设置页那一行的完整投影（壳里不许有第二份判断，所以状态全在这里算完） */
export interface SourceRowUi {
  readonly loading: boolean;
  /** 输入框与两个按钮当前是否可操作（读取中 / 服务缺席 / 读不出来 ⇒ false，不留"能改"的错觉） */
  readonly canEdit: boolean;
  /** 仅在覆盖态出现：清空覆盖、回到默认地址 */
  readonly showReset: boolean;
  /** 状态主句：现在用的是默认地址还是自建地址（改不了时就是那句实话） */
  readonly statusText: string;
  /** 状态主句的着色 */
  readonly statusTone: MarketNoteTone;
  /** **显式读数**：当前生效的那串地址（默认态 = 契约常量）；`''` = 现在没有可读地址 */
  readonly address: string;
  /** 回执（保存后那句）；`''` = 这一行不出现 */
  readonly note: string;
  readonly noteTone: MarketNoteTone;
}

/**
 * `null` = 读取中；其余直接取服务里那份视图 ⇒ 生效地址永远只有 `market.endpoint()` 一个来源，
 * 这里只做"该给作者看哪句话"的翻译，不缓存地址。
 */
export function sourceRowUi(state: MarketSourceView | null): SourceRowUi {
  if (state === null) {
    return {
      loading: true,
      canEdit: false,
      showReset: false,
      statusText: '正在读取当前用的地址…',
      statusTone: 'dim',
      address: '',
      note: '',
      noteTone: 'dim',
    };
  }
  // 缺席 / 读不出来：没有地址可显，把"现在改不了"那句直接当主句（失败着色），别让用户对着空框猜
  if (state === NO_SERVICE_VIEW || state.effective === '') {
    return {
      loading: false,
      canEdit: false,
      showReset: false,
      statusText: state.note === '' ? '现在读不到地址，这一项也改不了' : state.note,
      statusTone: 'err',
      address: '',
      note: '',
      noteTone: 'dim',
    };
  }
  return {
    loading: false,
    canEdit: true,
    showReset: state.overridden,
    statusText: state.overridden ? '当前用的是自建地址' : '当前用的是默认地址',
    statusTone: 'dim',
    address: state.effective,
    note: state.note,
    noteTone: classifyNote(state.note),
  };
}

export interface MarketSourceView {
  readonly effective: string;
  readonly overridden: boolean;
  readonly note: string;
}

/** 服务缺席时的视图（装配没排好 ⇒ 一句实话，不是空输入框假装能存） */
export const NO_SERVICE_VIEW: MarketSourceView = {
  effective: '',
  overridden: false,
  note: '市场服务没装配（口上市场插件没起来），这一项现在改不了',
};

/**
 * 存端点并给出回执（设置页只叫这一个函数 ⇒ "改完显示什么"也只有一份口径）。
 * `MarketError`（`endpoint-invalid`）不抛给壳：它是作者的一次输入错误，走行内提示。
 */
export async function applyEndpointEdit(
  market: MarketService,
  draft: string,
): Promise<MarketSourceView> {
  const effectiveNow = await market.endpoint();
  const plan = planEndpointEdit(draft, effectiveNow);
  switch (plan.kind) {
    case 'keep':
      return view(effectiveNow, '没有改动');
    case 'invalid':
      return view(effectiveNow, `没有保存：${plan.reason}`);
    case 'reset':
    case 'set': {
      try {
        await market.setEndpoint(plan.kind === 'reset' ? '' : plan.url);
      } catch (err: unknown) {
        const message = err instanceof MarketError ? err.message : String(err);
        return view(await market.endpoint(), `没有保存：${message}`);
      }
      const after = await market.endpoint();
      return view(
        after,
        plan.kind === 'reset'
          ? `已恢复默认注册表地址（下次打开市场面板生效）`
          : `已改用自建地址（仅放行 GitHub 系主机；下次打开市场面板生效）`,
      );
    }
  }
}

function view(effective: string, note: string): MarketSourceView {
  return { effective, overridden: isOverridden(effective), note };
}

/**
 * 「恢复默认」按钮走的就是 `applyEndpointEdit(svc, '')` 这条**既有** reset 通路
 * （`planEndpointEdit` 把 `''` 判成 reset）⇒ 不新增服务方法、不动契约，回执口径也还是那一套。
 */
export async function resetEndpoint(market: MarketService | undefined): Promise<MarketSourceView> {
  if (market === undefined) return NO_SERVICE_VIEW;
  return applyEndpointEdit(market, '');
}
