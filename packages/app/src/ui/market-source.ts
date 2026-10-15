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
 * 因此本行的全部可编辑项 = 一个 URL。
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
          : `已改用自建地址（下次打开市场面板生效）`,
      );
    }
  }
}

function view(effective: string, note: string): MarketSourceView {
  return { effective, overridden: isOverridden(effective), note };
}
