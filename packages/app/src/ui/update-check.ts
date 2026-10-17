/**
 * 检查更新（REL-1 自动更新链路收尾 · REL-2 设置页打磨 · MK-1 语义并一）。
 *
 * 零 React 纯逻辑，可单测。与 `motion-pref.ts` 同款分层：状态机与文案辅助住在这里，
 * React 交互留在 `ShellLayout`（`check()` / `downloadAndInstall()` 本体来自
 * `@tauri-apps/plugin-updater`，43a2caa 已接线，本模块不碰宿主 API）。
 *
 * ## 本批（MK-1）改的是什么
 *
 * 这一页上过去并着**两套更新语义**：应用自更新走 updater 自己那套"有更新 / 没更新 +
 * 一句哑巴失败话"，包更新走 `plugin-api/market.ts` 的 `packUpdateCheck`
 * （三态判别联 + 显式 `failed`）。同一个作者在同一屏里看到两种版本口径、两种失败说法。
 * 本模块现在**只借契约那三件东西**：
 *
 * 1. **一把尺**：版本比较只用契约的 `compareVersions`（全仓唯一定义，`single-source.test.ts`
 *    钉着）+ `coreVersion` 折掉预发布段——不在宿主侧再数一次点号；
 * 2. **一套态名**：关系态直接用契约导出的 `PackUpdateState`
 *    （`'updatable' | 'latest' | 'ahead' | 'failed'`）。updater 报回来的那一版**先过这把尺**
 *    再决定给哪个态（调用方给得出 `currentVersion` 就核，见 `checkFound`）；
 * 3. **一条失败语法**：失败段的类型**从契约 `MarketIndexRefresh` 的 `failed` 分支取**
 *    （`'check' | 'install'`，不另立字面量），失败那一句按契约 `makeUpdateFailure` 那张表生成
 *    （哪一段 + 为什么 + **可重试**）。
 *
 * ⚠ 契约的 `updateRelationOf` / `makeUpdateFailure` 没进 `@kojo/plugin-api` 的出口清单
 *   （`plugin-api/src/index.ts` 在本批边界外，不许顺手改），所以下面
 *   `appUpdateRelation` / `updateFailureNote` 两个函数是**按同一张表逐字复刻**的接合点。
 *   复刻不等于放宽：`packages/app/tests/update-grammar-parity.test.ts` 拿 `packUpdateCheck`
 *   真产出的失败态与本模块的产出对拍，改一个字即红。出口清单补上那一行之后，
 *   这两个复刻应当立刻删掉、换成直接 import。
 *
 * ## 为什么失败态是一等公民
 *
 * 当前仓库是私仓且尚未发布过 release：updater 端点现阶段**必然 404**——
 * 「检查失败」不是异常路径，而是这段时期内的常态路径。状态机把它钉成显式一态，
 * 调用方（ShellLayout）必须 try-catch 并把失败渲染出来，绝不允许未捕获异常。
 */

import {
  compareVersions,
  coreVersion,
  type MarketIndexRefresh,
  type PackUpdateState,
} from '@kojo/plugin-api';

/**
 * 失败段：**类型从契约那条分支取**（不在宿主侧另写一份 `'check' | 'install'` 字面量）。
 * 契约新增第三段（比如 `'verify'`）时，下面的 `UPDATE_FAILURE_REASON` 穷尽表编译期就红。
 */
export type UpdateStage = Extract<MarketIndexRefresh, { state: 'failed' }>['stage'];

/**
 * 一条失败态的最小可显示事实（`stage` + 为什么）。
 * 与包侧 `PackUpdateCheck['failure']` 同构：`{ stage, reason, detail?, note }`。
 */
export interface UpdateFailureLike {
  readonly stage: UpdateStage;
  readonly reason: string;
  readonly detail?: string;
}

/** 本链路在作者眼里的名字（包侧那句的主语是「包名」的更新——同一条语法、不同主语） */
export const UPDATE_SUBJECT = '编辑器更新';

/**
 * 失败那一句人话（**契约 `makeUpdateFailure` 的复刻**，理由见文件头那条 ⚠）。
 * 三段：`${主语}没有${动词}成功` + 为什么 + 可重试。
 */
export function updateFailureNote(failure: UpdateFailureLike): string {
  const verb = failure.stage === 'check' ? '检查' : '下载安装';
  const reason = failure.reason.trim();
  return `${UPDATE_SUBJECT}没有${verb}成功，可重试${reason === '' ? '' : `：${reason}`}`;
}

/**
 * 调用方没给病因时的那句常态病因（两条路的失败都不是"未知错误"）。
 * 穷尽 `Record` ⇒ 契约加一段而这里没跟上即编译失败。
 */
const UPDATE_FAILURE_REASON: Record<UpdateStage, string> = {
  check: '网络没通，或本仓还没发布可更新的版本',
  install: '下载或安装中断（断网、磁盘、取消）',
};

/**
 * "该不该更新"的判定 = 契约 `updateRelationOf` 的复刻（同一把尺 `compareVersions`、
 * 同一套态名 `PackUpdateState`、同一条"比不了 ⇒ failed"的纪律）。
 *
 * @returns `'updatable'` 才给「下载并安装」；`'latest'` / `'ahead'` 都不给（本机已是同一版或更高）；
 *   `'failed'` = 版本形读不出——**不许**演成"已最新"，也不许直接给安装按钮
 */
export function appUpdateRelation(remoteVersion: string, currentVersion: string): PackUpdateState {
  const c = compareVersions(coreVersion(currentVersion), coreVersion(remoteVersion));
  if (c === null) return 'failed';
  return c < 0 ? 'updatable' : c > 0 ? 'ahead' : 'latest';
}

/** 检查更新的会话内状态（不落盘：每次打开设置页从 idle 起算即可） */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'found'; version: string }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'done' }
  | { kind: 'failed'; stage: UpdateStage; reason?: string; detail?: string };

/**
 * 状态机动作（与 updater 事件一一对应，Progress 只带本次分片长度）。
 *
 * `checkFound` 多带一个**可选** `currentVersion`：装配层给得出本机版本时，"到底更不更新"
 * 由 `appUpdateRelation`（契约那把尺）判；给不出时才退回"相信 updater 那一句"
 * （退回那条不是并一口径，所以调用方应当给——`ShellLayout` 手上就有 `appVersion`）。
 * `checkFailed` / `installFailed` 同理带可选 `reason`/`detail`：病因由调用方给，
 * 没给就用 `UPDATE_FAILURE_REASON` 那一句常态话术——两种情形都不许变成哑巴态。
 */
export type UpdateAction =
  | { type: 'checkStart' }
  | { type: 'checkLatest' }
  | { type: 'checkFound'; version: string; currentVersion?: string }
  | { type: 'checkFailed'; reason?: string; detail?: string }
  | { type: 'installStart'; total: number | null }
  | { type: 'installProgress'; chunk: number }
  | { type: 'installDone' }
  | { type: 'installFailed'; reason?: string };

/**
 * 纯状态机：非法迁移一律原样返回当前态（不抛、不造中间态）。
 *
 * `checkStart` 特意允许从**任何**态发起——失败 / 已最新 / 装完之后都还能再查。
 * `installStart` 允许从 found 与 downloading 两态进入：后者是下载开始事件
 * （Started）补报总字节数时用的重入。
 */
export function reduceUpdatePhase(phase: UpdatePhase, action: UpdateAction): UpdatePhase {
  switch (action.type) {
    case 'checkStart':
      return { kind: 'checking' };
    case 'checkLatest':
      return phase.kind === 'checking' ? { kind: 'latest' } : phase;
    case 'checkFound': {
      if (phase.kind !== 'checking' || action.version === '') return phase;
      const current = action.currentVersion;
      if (current === undefined || current === '') return { kind: 'found', version: action.version };
      const relation = appUpdateRelation(action.version, current);
      if (relation === 'updatable') return { kind: 'found', version: action.version };
      // 远端那版与本机相同、甚至更旧：更新检查给出什么都不能算"可更新"（与包侧同一口径）
      if (relation === 'latest' || relation === 'ahead') return { kind: 'latest' };
      return {
        kind: 'failed',
        stage: 'check',
        reason: '版本号写法本机读不出，无法判断该不该更新',
        detail: `更新 ${action.version} / 本机 ${current}`,
      };
    }
    case 'checkFailed':
      return phase.kind === 'checking' ? failed('check', action.reason, action.detail) : phase;
    case 'installStart': {
      if (phase.kind !== 'found' && phase.kind !== 'downloading') return phase;
      return {
        kind: 'downloading',
        received: phase.kind === 'downloading' ? phase.received : 0,
        total: action.total,
      };
    }
    case 'installProgress':
      if (phase.kind !== 'downloading' || !(action.chunk > 0)) return phase;
      return { kind: 'downloading', received: phase.received + action.chunk, total: phase.total };
    case 'installDone':
      return phase.kind === 'downloading' ? { kind: 'done' } : phase;
    case 'installFailed':
      return phase.kind === 'downloading' ? failed('install', action.reason) : phase;
  }
}

/** 失败态的唯一构造点（调用方给的病因优先，没给就落那句常态话术） */
function failed(stage: UpdateStage, reason?: string, detail?: string): UpdatePhase {
  return {
    kind: 'failed',
    stage,
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** 检查与下载安装都在「进行中」：这期间两颗按钮都得禁用 */
export function isUpdateBusy(phase: UpdatePhase): boolean {
  return phase.kind === 'checking' || phase.kind === 'downloading';
}

/** 字节数 → 展示文案（B / KB / MB 三档，小数点后一位；非有限值与负数按 0 处理） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下载进度行（总量未知时回 null——调用方退化为「正在下载安装…」） */
export function downloadProgressText(received: number, total: number | null): string | null {
  if (total === null || total <= 0) return null;
  const pct = Math.min(100, Math.round((received / total) * 100));
  return `已下载 ${formatBytes(received)} / ${formatBytes(total)}（${pct}%）`;
}

/** 状态行文案的色调（对齐 styles.css：dim = 默认弱化，ok/err 有语义色） */
export type UpdateStatusTone = 'dim' | 'ok' | 'err';

/**
 * 常驻状态行文案（`found` 态除外——它另有带安装按钮的专属行，返回 null 不画）。
 *
 * 三态都走**行内状态**而非弹窗：设置页是安静的地方（HK-4）。
 */
export function updateStatus(phase: UpdatePhase): { text: string; tone: UpdateStatusTone } | null {
  switch (phase.kind) {
    case 'idle':
      return { text: '有新版本时，可在这里手动检查', tone: 'dim' };
    case 'checking':
      return { text: '正在检查更新…', tone: 'dim' };
    case 'latest':
      return { text: '已是最新版本', tone: 'ok' };
    case 'found':
      return null;
    case 'downloading': {
      const text = downloadProgressText(phase.received, phase.total) ?? '正在下载安装…';
      return { text, tone: 'dim' };
    }
    case 'done':
      // 未装 process 插件（最小改动面）：不替用户重启，只提示手动重启
      return { text: '更新已安装，重启应用后生效', tone: 'ok' };
    case 'failed':
      // 句子由 `updateFailureNote`（契约同一张表的复刻）生成：主语 + 哪一段 + 为什么 + 可重试。
      // 调用方给了病因就用它，没给就退回那句常态话术——两条路都不是哑巴态。
      return {
        text: updateFailureNote({
          stage: phase.stage,
          reason: phase.reason ?? UPDATE_FAILURE_REASON[phase.stage],
          ...(phase.detail === undefined ? {} : { detail: phase.detail }),
        }),
        tone: 'err',
      };
  }
}
