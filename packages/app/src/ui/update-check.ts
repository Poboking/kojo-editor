/**
 * 检查更新（REL-1 自动更新链路收尾 · REL-2 设置页打磨）：零 React 纯逻辑，可单测。
 *
 * 与 `motion-pref.ts` 同款分层：状态机与文案辅助住在这里，React 交互留在
 * `ShellLayout`（check() / downloadAndInstall() 本体来自 @tauri-apps/plugin-updater，
 * 43a2caa 已接线，本模块不碰宿主 API）。
 *
 * ## 为什么失败态是一等公民
 *
 * 当前仓库是私仓且尚未发布过 release：updater 端点现阶段**必然 404**——
 * 「检查失败」不是异常路径，而是这段时期内的常态路径。状态机把它钉成显式一态，
 * 调用方（ShellLayout）必须 try-catch 并把失败渲染出来，绝不允许未捕获异常。
 */

/** 检查更新的会话内状态（不落盘：每次打开设置页从 idle 起算即可） */
export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'found'; version: string }
  | { kind: 'downloading'; received: number; total: number | null }
  | { kind: 'done' }
  | { kind: 'failed'; stage: 'check' | 'install' };

/** 状态机动作（与 updater 事件一一对应，Progress 只带本次分片长度） */
export type UpdateAction =
  | { type: 'checkStart' }
  | { type: 'checkLatest' }
  | { type: 'checkFound'; version: string }
  | { type: 'checkFailed' }
  | { type: 'installStart'; total: number | null }
  | { type: 'installProgress'; chunk: number }
  | { type: 'installDone' }
  | { type: 'installFailed' };

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
    case 'checkFound':
      return phase.kind === 'checking' && action.version !== ''
        ? { kind: 'found', version: action.version }
        : phase;
    case 'checkFailed':
      return phase.kind === 'checking' ? { kind: 'failed', stage: 'check' } : phase;
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
      return phase.kind === 'downloading' ? { kind: 'failed', stage: 'install' } : phase;
  }
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
      return phase.stage === 'install'
        ? { text: '下载安装失败，可重试', tone: 'err' }
        : { text: '检查失败（网络或尚未发布版本）', tone: 'err' };
  }
}
