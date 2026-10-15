import type {
  PlatformBridge,
  RemoteDownload,
  RemoteDownloadOptions,
  RemoteExtractLimits,
  RemoteExtractResult,
  RemoteService,
  RemoteText,
  RemoteTextOptions,
} from '@kojo/plugin-api';

/**
 * `kernel.remote` 实现：**平台桥的零逻辑透传**（远程面在插件侧的唯一入口）。
 *
 * 为什么要单独一个服务键，而不是塞进 `FileIO`：
 * - 出网是**另一种能力**（写能力必须显式可审计，见 `plugin-api/services.ts` 的 SugarLiftApply 口径），
 *   混在文件面里就等于"要读盘的人顺带拿到了要网络的人"；
 * - 内核**刻意不解释 URL**：可信主机白名单 / 逐跳重定向重核 / 体积上限 / 超时全在平台侧那一条链路里，
 *   内核再核一次就是第二份白名单（它会漂）。
 * - 平台无此能力（Node 桥）时由桥抛错，调用侧自解释呈现——**不降级**去 `fetch()`。
 *
 * `marketDownload` / `marketExtract` 同样零逻辑：落点决定权在平台命令内（本层没有路径参数可传），
 * 解压限额只是把调用方给的三个数字原样递下去——内核一个数都不解释。
 */
export class RemoteServiceImpl implements RemoteService {
  constructor(private readonly bridge: PlatformBridge) {}

  fetchText(url: string, opts?: RemoteTextOptions): Promise<RemoteText> {
    return this.bridge.fetchText(url, opts);
  }

  marketDownload(url: string, containerName: string, opts?: RemoteDownloadOptions): Promise<RemoteDownload> {
    return this.bridge.marketDownload(url, containerName, opts);
  }

  marketExtract(
    containerName: string,
    targetName: string,
    limits: RemoteExtractLimits,
  ): Promise<RemoteExtractResult> {
    return this.bridge.marketExtract(containerName, targetName, limits);
  }
}
