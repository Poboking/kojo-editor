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
 *
 * ## 弹窗批（用户反馈第 1 条，2026-10-17）
 *
 * 进入编辑器 3 秒的静默检查与设置页手动检查落到**同一台状态机**上。`found` 现在携带
 * updater 的 `Update` 对象里那几项事实（`currentVersion` / `notes` / `date`），并一路带到
 * downloading / done / failed(install)——新弹窗与设置页共用同一份 phase，安装失败还能从
 * 该态直接重试。**检查中 / 已最新 / 检查失败都不出弹窗**：`updateDialogPhase` 是唯一判据。
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

/**
 * 一次「有新版」的发布信息（来自 updater `Update` 对象的四项事实）。
 *
 * `currentVersion` / `notes` / `date` 都是**可选**：调用方读不到就不带（键也不出现），
 * 弹窗按缺省渲染（不写"vundefined"这种机器味）。`notes` 只清洗格式、不截断——
 * 显示上限在 `visibleUpdateNoteLines` 那一层处理。
 */
export interface UpdateRelease {
  readonly version: string;
  readonly currentVersion?: string;
  readonly notes?: string;
  readonly date?: string;
}

/**
 * 检查更新的会话内状态（不落盘：每次打开设置页从 idle 起算即可）。
 *
 * found 之后的四态都携带同一份 `UpdateRelease`：弹窗在下载 / 完成 / 安装失败时仍要写
 * "vX.Y.Z / 当前 vA.B.C"，失败态的「重试」也要凭它回到 downloading——发布信息不能在中途丢。
 */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | ({ kind: 'found' } & UpdateRelease)
  | ({ kind: 'downloading'; received: number; total: number | null } & UpdateRelease)
  | ({ kind: 'done' } & UpdateRelease)
  | { kind: 'failed'; stage: 'check'; reason?: string; detail?: string }
  | { kind: 'failed'; stage: 'install'; reason?: string; detail?: string; release: UpdateRelease };

/**
 * 弹窗可渲染的那几态（**唯一判据**，ShellLayout 与 UpdateDialog 都读它）。
 *
 * 检查失败（stage='check'）刻意不在内：自动检查失败是现阶段的常态路径，绝不弹窗打扰。
 */
export type UpdateDialogPhase =
  | ({ kind: 'found' } & UpdateRelease)
  | ({ kind: 'downloading'; received: number; total: number | null } & UpdateRelease)
  | ({ kind: 'done' } & UpdateRelease)
  | { kind: 'failed'; stage: 'install'; reason?: string; detail?: string; release: UpdateRelease };

/**
 * `UpdatePhase` → `UpdateDialogPhase | null`。
 *
 * idle / checking / latest / failed(check) 一律回 null（「不打扰」这条产品纪律的唯一落点）；
 * 其余原样返回（对象身份不变，调用方不必拷贝）。
 */
export function updateDialogPhase(phase: UpdatePhase): UpdateDialogPhase | null {
  switch (phase.kind) {
    case 'found':
    case 'downloading':
    case 'done':
      return phase;
    case 'failed':
      return phase.stage === 'install' ? phase : null;
    default:
      return null;
  }
}

/** 更新说明缺省时的那一句人话（弹窗里不留白、不写"无"） */
export const UPDATE_NOTES_EMPTY = '这个版本没有附更新说明。';

/** 更新说明最多画多少行（超长说明只截显示，不截状态；见 `visibleUpdateNoteLines`） */
export const UPDATE_NOTE_LINE_LIMIT = 400;

/**
 * 更新说明入态前的清洗：`\r\n` / `\r` 统一成 `\n`；**全空白视为没有说明**（键不出现）。
 * 其余逐字保留——缩进、空行、列表符号都是作者的排版，不在状态层改写。
 */
export function normalizeUpdateNotes(notes: string | undefined): string | undefined {
  if (notes === undefined) return undefined;
  const text = notes.replace(/\r\n?/g, '\n');
  return text.trim() === '' ? undefined : text;
}

/**
 * 日期入态前的清洗：空串 / 读不出的 RFC 3339 一律当没有（键不出现），
 * 免得弹窗上挂一个 `Invalid Date` 式的机器残骸。读得出的保留原串（`<time dateTime>` 要用）。
 */
export function normalizeUpdateDate(date: string | undefined): string | undefined {
  if (date === undefined) return undefined;
  const text = date.trim();
  if (text === '') return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

/**
 * 纯文本更新说明 → 行数组（弹窗按行渲染）。
 *
 * - 空 / 全空白 → `[]`（弹窗改用 `UPDATE_NOTES_EMPTY`）；
 * - 去掉每行行尾空白与首尾空行（外框留白由 CSS 给），**内部空行保留**（段落分隔是作者意图）；
 * - 不截行；超长截断由 `visibleUpdateNoteLines` 负责。
 */
export function updateNoteLines(notes: string | undefined): readonly string[] {
  const text = normalizeUpdateNotes(notes);
  if (text === undefined) return [];
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/u, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(start, end);
}

/**
 * 弹窗真正要画的行 + 截断读数。
 *
 * 超长说明（几百行以上的 changelog）全量塞进 DOM 会让一次打开变成明显掉帧；
 * 这里只截**显示**，`total` 仍报全量，弹窗据此写一句「仅显示前 N 行（共 M 行）」。
 */
export function visibleUpdateNoteLines(notes: string | undefined): {
  readonly lines: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
} {
  const all = updateNoteLines(notes);
  const lines = all.slice(0, UPDATE_NOTE_LINE_LIMIT);
  return { lines, total: all.length, truncated: lines.length < all.length };
}

/**
 * RFC 3339 发布日期 → 本地 `YYYY-MM-DD`（读不出回 null，弹窗就不画那一格）。
 * 只到日：发布时刻对作者没有决策价值，反而把一行元信息挤长。
 */
export function formatUpdateDate(date: string | undefined): string | null {
  const text = normalizeUpdateDate(date);
  if (text === undefined) return null;
  const parsed = new Date(text);
  const y = parsed.getFullYear();
  const m = String(parsed.getMonth() + 1).padStart(2, '0');
  const d = String(parsed.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 弹窗主标题：主语恒是那一版，按态换一个动词（不用全局一个大标题 + 小字解释） */
export function updateDialogTitle(phase: UpdateDialogPhase): string {
  switch (phase.kind) {
    case 'found':
      return `发现新版本 v${phase.version}`;
    case 'downloading':
      return `正在下载 v${phase.version}`;
    case 'failed':
      return `更新 v${phase.release.version} 没有装好`;
    case 'done':
      return `已安装 v${phase.version}`;
  }
}

/**
 * 状态机动作（与 updater 事件一一对应，Progress 只带本次分片长度）。
 *
 * `checkFound` 多带一个**可选** `currentVersion`（以及 updater 的 `notes`/`date`）：
 * 装配层给得出本机版本时，"到底更不更新"由 `appUpdateRelation`（契约那把尺）判；
 * 给不出时才退回"相信 updater 那一句"（退回那条不是并一口径，所以调用方应当给——
 * `Update.currentVersion` 本来就有，`ShellLayout` 直接递进来）。
 * `checkFailed` / `installFailed` 同理带可选 `reason`/`detail`：病因由调用方给，
 * 没给就用 `UPDATE_FAILURE_REASON` 那一句常态话术——两种情形都不许变成哑巴态。
 */
export type UpdateAction =
  | { type: 'checkStart' }
  | { type: 'checkLatest' }
  | { type: 'checkFound'; version: string; currentVersion?: string; notes?: string; date?: string }
  | { type: 'checkFailed'; reason?: string; detail?: string }
  | { type: 'installStart'; total: number | null }
  | { type: 'installProgress'; chunk: number }
  | { type: 'installDone' }
  | { type: 'installFailed'; reason?: string };

/**
 * 纯状态机：非法迁移一律原样返回当前态（不抛、不造中间态）。
 *
 * `checkStart` 特意允许从**任何**态发起——失败 / 已最新 / 装完之后都还能再查。
 * `installStart` 允许从 found / downloading / failed(install) 三态进入：downloading 那路
 * 是下载开始事件（Started）补报总字节数时用的重入；failed(install) 那路是失败弹窗的「重试」
 * （重试对同一个 Update 再下一次，仍要保留 vX / 当前版本这份发布信息）。
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
      const notes = normalizeUpdateNotes(action.notes);
      const date = normalizeUpdateDate(action.date);
      const release: UpdateRelease = {
        version: action.version,
        ...(current === undefined || current === '' ? {} : { currentVersion: current }),
        ...(notes === undefined ? {} : { notes }),
        ...(date === undefined ? {} : { date }),
      };
      if (current === undefined || current === '') {
        // 本机版本给不出（非 Tauri / getVersion 失败）：退回"相信 updater 那一句"
        return { kind: 'found', ...release };
      }
      const relation = appUpdateRelation(action.version, current);
      if (relation === 'updatable') return { kind: 'found', ...release };
      // 远端那版与本机相同、甚至更旧：更新检查给出什么都不能算"可更新"（与包侧同一口径）
      if (relation === 'latest' || relation === 'ahead') return { kind: 'latest' };
      return failedCheck(
        '版本号写法本机读不出，无法判断该不该更新',
        `更新 ${action.version} / 本机 ${current}`,
      );
    }
    case 'checkFailed':
      return phase.kind === 'checking' ? failedCheck(action.reason, action.detail) : phase;
    case 'installStart': {
      if (phase.kind === 'found') {
        return { kind: 'downloading', received: 0, total: action.total, ...releaseOf(phase) };
      }
      if (phase.kind === 'downloading') {
        return { ...phase, total: action.total };
      }
      if (phase.kind === 'failed' && phase.stage === 'install') {
        return { kind: 'downloading', received: 0, total: action.total, ...releaseOf(phase.release) };
      }
      return phase;
    }
    case 'installProgress':
      if (phase.kind !== 'downloading' || !(action.chunk > 0)) return phase;
      return { ...phase, received: phase.received + action.chunk };
    case 'installDone':
      return phase.kind === 'downloading' ? { kind: 'done', ...releaseOf(phase) } : phase;
    case 'installFailed':
      // downloading 是下载中途断；done 是"下载完成事件已到、installer 随后才失败"
      // （updater 的 Finished 只代表下载完；Windows 上进程会在安装时退出，done 是它能给的最后反馈，
      //  其它平台上后续 install 失败必须还能落回失败态，否则就把失败粉饰成"已安装"）。
      return phase.kind === 'downloading' || phase.kind === 'done'
        ? failedInstall(action.reason, releaseOf(phase))
        : phase;
  }
}

/** 发布信息原样带走；缺省键不出现（与 found 态的构造口径一致，对象比较才干净） */
function releaseOf(release: UpdateRelease): UpdateRelease {
  return {
    version: release.version,
    ...(release.currentVersion === undefined ? {} : { currentVersion: release.currentVersion }),
    ...(release.notes === undefined ? {} : { notes: release.notes }),
    ...(release.date === undefined ? {} : { date: release.date }),
  };
}

/** 失败态（检查段）：没有版本可言，只有病因 */
function failedCheck(reason?: string, detail?: string): UpdatePhase {
  return {
    kind: 'failed',
    stage: 'check',
    ...(reason === undefined ? {} : { reason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** 失败态（安装段）：release 必须带——失败弹窗要写版本，重试也凭它回到 downloading */
function failedInstall(reason: string | undefined, release: UpdateRelease): UpdatePhase {
  return {
    kind: 'failed',
    stage: 'install',
    ...(reason === undefined ? {} : { reason }),
    release,
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

/**
 * 下载百分比（0–100 整数；总量未知 / 非正值回 null——进度条转不定态）。
 * 与 `downloadProgressText` 共用这一处算式：文字里的百分数与条宽不许各算各的。
 */
export function downloadPercent(received: number, total: number | null): number | null {
  if (total === null || !(total > 0) || !Number.isFinite(total) || !Number.isFinite(received)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

/** 下载进度行（总量未知时回 null——调用方退化为「正在下载安装…」） */
export function downloadProgressText(received: number, total: number | null): string | null {
  const pct = downloadPercent(received, total);
  if (pct === null || total === null) return null;
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

/* ============================================================================
 * 批次十一 L05（更新体验三层递进）· 纯逻辑增补：严重度 / 语义分组 / 外链切段。
 *
 * 全部零 React、零存储、零宿主 API——和上面那台状态机同款可单测。呈现层
 * （`UpdateDialog.tsx` / `UpdateNoticeCard.tsx`）只消费这里的判定，不再各写各的正则。
 * ========================================================================== */

/**
 * 一版更新的严重度。**只有 breaking 允许「打开即模态」**（层三的产品闸门），
 * 普通更新一律走右下非阻塞卡（层一）。判据取 changelog 文本里那条公认的红线词。
 */
export type UpdateSeverity = 'normal' | 'breaking';

/** 破坏性判定的唯一词表（分组与严重度共用，口径不许分叉） */
const UPDATE_BREAKING_RE = /(breaking\s*changes?|破坏性(?:变更|更新)?|不兼容|incompatible)/i;

/** 说明里任何一行命中破坏性词 ⇒ breaking（宁松勿严：误判多给一次确认，漏判是替作者按下升级） */
export function detectUpdateSeverity(notes: string | undefined): UpdateSeverity {
  return updateNoteLines(notes).some((line) => UPDATE_BREAKING_RE.test(line)) ? 'breaking' : 'normal';
}

/** changelog 语义分组（弹窗按组渲染，不再一屏纯文本行） */
export type UpdateNoteGroupId = 'breaking' | 'added' | 'fixed' | 'other';

/** 分组固定展示序：坏的先说，其次新增、修复，兜底其它（决策价值从高到低） */
export const UPDATE_NOTE_GROUP_ORDER: readonly UpdateNoteGroupId[] = ['breaking', 'added', 'fixed', 'other'];

export const UPDATE_NOTE_GROUP_LABEL: Record<UpdateNoteGroupId, string> = {
  breaking: '破坏性变更',
  added: '新增',
  fixed: '修复',
  other: '其它',
};

/**
 * 分组关键词表（中英常见 changelog 动词）。breaking 用上面那条唯一红线词。
 * 判不出的行进「其它」——分组是导读，不是改写，一条内容都不许丢。
 */
const UPDATE_NOTE_GROUP_PATTERNS: Record<Exclude<UpdateNoteGroupId, 'other'>, RegExp> = {
  breaking: UPDATE_BREAKING_RE,
  added: /(新增|添加|加入|支持|added|feat)/i,
  fixed: /(修复|修正|解决|fixed|fixes|bugfix|hotfix|\bfix\b)/i,
};

function classifyUpdateNoteLine(text: string): UpdateNoteGroupId | null {
  if (UPDATE_NOTE_GROUP_PATTERNS.breaking.test(text)) return 'breaking';
  if (UPDATE_NOTE_GROUP_PATTERNS.added.test(text)) return 'added';
  if (UPDATE_NOTE_GROUP_PATTERNS.fixed.test(text)) return 'fixed';
  return null;
}

/** Markdown 标题行（`# …` 到 `###### …`），返回去掉 `#` 后的题面 */
function updateNoteHeading(line: string): string | null {
  const m = /^#{1,6}\s+(.*)$/u.exec(line);
  return m === null ? null : (m[1] ?? '').trim();
}

/** 一个语义分组（标题 + 归到它名下的行，保持原始顺序） */
export interface UpdateNoteGroup {
  readonly id: UpdateNoteGroupId;
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * 纯文本 changelog → 语义分组。
 *
 * 归组判据（两条腿，缺一条都会把常见格式切碎）：
 * 1. **标题上下文**：`## 新增` 之下、在遇到下一个标题之前的行，整段进该组；
 *    命中已知词的标题被「消费」（组名即标题，不再重复画一行）；认不出的标题原文进「其它」，
 *    其下各行也跟着进「其它」（保住 `## 性能` 这类小节的语境）；
 * 2. **行内关键词**：无标题上下文（裸列表 changelog 很常见）时按行判词。
 * 行本身命中已知词的，优先按词走（`## 新增` 下的 `- 修复：某崩溃` 归修复）。
 */
export function groupUpdateNotes(notes: string | undefined): readonly UpdateNoteGroup[] {
  const lines = updateNoteLines(notes);
  const buckets = new Map<UpdateNoteGroupId, string[]>();
  const push = (id: UpdateNoteGroupId, text: string): void => {
    const bucket = buckets.get(id);
    if (bucket === undefined) buckets.set(id, [text]);
    else bucket.push(text);
  };
  let context: UpdateNoteGroupId | null = null;
  for (const line of lines) {
    const heading = updateNoteHeading(line);
    if (heading !== null) {
      const id = classifyUpdateNoteLine(heading);
      if (id !== null) {
        context = id; // 已知小节题：被组名吸收，不重复画行
        continue;
      }
      context = 'other'; // 未知小节题：本行与后续内容都留在「其它」里
      push('other', heading);
      continue;
    }
    push(classifyUpdateNoteLine(line) ?? context ?? 'other', line);
  }
  const groups: UpdateNoteGroup[] = [];
  for (const id of UPDATE_NOTE_GROUP_ORDER) {
    const linesOfId = buckets.get(id);
    if (linesOfId === undefined || linesOfId.length === 0) continue;
    groups.push({ id, label: UPDATE_NOTE_GROUP_LABEL[id], lines: linesOfId });
  }
  return groups;
}

/** 分组后的显示面：跨组共享同一个行数上限（口径与 `visibleUpdateNoteLines` 一致） */
export function visibleUpdateNoteGroups(notes: string | undefined): {
  readonly groups: readonly UpdateNoteGroup[];
  readonly total: number;
  readonly truncated: boolean;
} {
  const groups = groupUpdateNotes(notes);
  const total = groups.reduce((sum, g) => sum + g.lines.length, 0);
  if (total <= UPDATE_NOTE_LINE_LIMIT) return { groups, total, truncated: false };
  let budget = UPDATE_NOTE_LINE_LIMIT;
  const capped: UpdateNoteGroup[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const lines = g.lines.slice(0, budget);
    budget -= lines.length;
    capped.push({ ...g, lines });
  }
  return { groups: capped, total, truncated: true };
}

/** 一行里的文字段：`url` 出现即外链段（弹窗渲染成 `<a>`，其余原样成文） */
export interface UpdateNoteSegment {
  readonly text: string;
  readonly url?: string;
}

/**
 * URL 切段：只认 http(s)，行尾的中文标点 / 全角括号 / 空白不算 URL 的一部分
 * （changelog 里「详见 https://xxx，见上」这种写法很常见，把「，」吞进链接是坏体验）。
 */
const UPDATE_NOTE_URL_RE = /https?:\/\/[^\s<>"'`、。！？，；：（）【】《》\u3000-\u303f\uff00-\uffef]+/g;

export function linkifyUpdateNoteLine(line: string): readonly UpdateNoteSegment[] {
  const segments: UpdateNoteSegment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(UPDATE_NOTE_URL_RE)) {
    const url = match[0];
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ text: line.slice(cursor, start) });
    segments.push({ text: url, url });
    cursor = start + url.length;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) });
  return segments;
}

/** 弹窗/卡片统一的「发现新版本 vX」标题（一处措辞，两处消费） */
export function updateNoticeTitle(release: UpdateRelease): string {
  return `发现新版本 v${release.version}`;
}

