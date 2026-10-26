/**
 * 日志与诊断（契约 §6.10 + 采集链路 §12.1）。
 *
 * ## 为什么解码在这里而不在宿主
 *
 * 编码探测是**内核单源**（`packages/kernel/src/encoding.ts` 的 `decodeWithProbe`）：
 * 探测判序（BOM → UTF-8 合法 → 三族评分 → 兜底）、改写回写要保持的编码，全仓只有那一份。
 * 宿主再做一套 = 第二份真源，同一段字节在「日志页」与「编辑器」里迟早显示成两种文本。
 * 但插件**不许 import 内核**（`audit:decoupling` B 项），所以探测函数由**应用组合根**注入：
 *
 * ```ts
 * createLauncherPlugin({ decodeBytes: decodeWithProbe })
 * ```
 *
 * 缺席时**退化为固定标签解码**（按实例 `EncodingProfile.fallback` 取 `DECODE_LABEL` 标签，
 * 只走 `new TextDecoder(label)`）：不探测、不猜，结果里标 `probed: false`——UI 因此能
 * 如实说「按 XX 编码显示」，而不是把猜测结果当事实。
 *
 * ## 流式（跨块多字节）
 *
 * 宿主按 ≥64 KiB / ≥100 ms 合并后把**原始字节块**推过来，块边界与字符边界毫无关系。
 * 本层按目标编码的**最大码元长度**回退尾字节：`push()` 只解「完整码元覆盖的前缀」，
 * 剩下的不完整尾字节留到下一块拼起来再解——跨块的 Shift-JIS / UTF-8 多字节因此不会
 * 变成 `U+FFFD`。这条判据是纯函数 `incompleteTailLength`，单测直接对它下断言。
 *
 * ## 环形缓冲
 *
 * 实时行只在**有人订阅**时解码（没人看就不烧 CPU）；解出来的行进每实例环形缓冲
 * （缺省 2000 行），后开的日志页可以先拿一屏上下文。完整日志永远在盘上（`tail` / `read`
 * 走宿主分页），环形缓冲只服务实时面。
 */

import type {
  EncodingProfile,
  FileEncoding,
  LogLine,
  LogPage,
  LogQuery,
  LogService,
  LogSession,
  Unsubscribe,
} from '@kojo/plugin-api';
import { DECODE_LABEL } from '@kojo/plugin-api';
import type { HostLogEvent, HostLogPage, LauncherHostBridge } from './host';
import { launcherError, normalizeLauncherError } from './errors';

/**
 * 编码探测注入点：**签名与内核 `decodeWithProbe` 逐字一致**（`{ text, encoding }`）。
 * 组合根传内核那一个函数；测试传任意确定性替身。
 */
export type DecodeBytes = (bytes: Uint8Array) => { text: string; encoding: FileEncoding };

/**
 * 「纯 ASCII 前缀」的忍耐上限：探测把 ASCII 判成 `utf-8` 属于**弱证据**（ASCII 同时也是
 * Shift-JIS 子集），攒到这么多字节再定编码，避免「第一块恰好只有一行英文」把整条流
 * 误判成 UTF-8。强证据（BOM / 非 UTF-8 判定）不等这个阈值。
 */
export const AUTO_PROBE_MIN_BYTES = 4096;

/** 每实例实时行环形缓冲缺省容量（§12.1：UI 只留最近 N 行） */
export const DEFAULT_LOG_RING_LINES = 2000;

/** 带编码读数的日志页（契约 `LogPage` 的结构子类型：多两栏，不多一个字段含义） */
export interface LauncherLogPage extends LogPage {
  /** 本页实际使用的编码（探测或固定标签） */
  readonly encoding: FileEncoding;
  /** 编码是探测出来的（true）还是按实例 profile 固定标签解的（false） */
  readonly probed: boolean;
}

export interface LogServiceOptions {
  readonly host: LauncherHostBridge;
  /** 组合根注入的编码探测（缺席 = 固定标签，`probed: false`） */
  readonly decodeBytes?: DecodeBytes;
  /**
   * 实例的编码策略（**同步**：读实例库缓存）。`null` = 未知实例，按
   * `{ mode: 'auto', fallback: 'utf-8' }` 处理并如实记 `probed: false`。
   */
  readonly getEncoding: (instanceId: string) => EncodingProfile | null;
  readonly ringSize?: number;
  readonly now?: () => number;
}

export class LogServiceImpl implements LogService {
  private readonly host: LauncherHostBridge;
  private readonly decodeBytes: DecodeBytes | undefined;
  private readonly getEncoding: (instanceId: string) => EncodingProfile | null;
  private readonly ringSize: number;
  private readonly now: () => number;
  private readonly listeners = new Map<string, Set<(line: LogLine) => void>>();
  private readonly strokes = new Map<string, LogStroke>();
  private readonly rings = new Map<string, LogLine[]>();
  private disposed = false;

  constructor(options: LogServiceOptions) {
    this.host = options.host;
    this.decodeBytes = options.decodeBytes;
    this.getEncoding = options.getEncoding;
    this.ringSize = Math.max(1, options.ringSize ?? DEFAULT_LOG_RING_LINES);
    this.now = options.now ?? Date.now;
  }

  /* ------------------------------ 契约面 ------------------------------ */

  async tail(instanceId: string, opts?: LogQuery): Promise<LauncherLogPage> {
    try {
      const page = await this.host.logTail(instanceId, opts);
      return this.decodePage(page, this.profileOf(instanceId));
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取日志尾部失败' });
    }
  }

  async sessions(instanceId: string): Promise<readonly LogSession[]> {
    try {
      return await this.host.logSessions(instanceId);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取日志会话列表失败' });
    }
  }

  async read(sessionId: string, opts?: LogQuery): Promise<LauncherLogPage> {
    try {
      const page = await this.host.logRead(sessionId, opts);
      return this.decodePage(page, this.profileOf(page.session.instanceId));
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '读取日志会话失败' });
    }
  }

  subscribe(instanceId: string, listener: (line: LogLine) => void): Unsubscribe {
    if (this.disposed) return () => {};
    let set = this.listeners.get(instanceId);
    if (!set) {
      set = new Set();
      this.listeners.set(instanceId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(instanceId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(instanceId);
        this.dropStrokes(instanceId);
      }
    };
  }

  /**
   * 诊断包：**落点与写盘全在宿主**（原生保存对话框 + 同命令写 ZIP + 路径脱敏）。
   * 本层的「请求编排」只有一件事：省略 sessionId 时取最近一个会话（按 `startedAt` 倒序）。
   */
  async exportBundle(instanceId: string, sessionId?: string): Promise<string | null> {
    const exportFn = this.host.logExport;
    if (!exportFn) {
      throw launcherError('LAUNCHER_PLATFORM_UNSUPPORTED', {
        detail: '当前宿主未提供诊断包导出（launcher_log_export）',
      });
    }
    try {
      const target = sessionId ?? (await this.latestSessionId(instanceId));
      return await exportFn.call(this.host, instanceId, target);
    } catch (err) {
      throw normalizeLauncherError(err, { fallbackCode: 'LAUNCHER_INTERNAL', detail: '导出诊断包失败' });
    }
  }

  /* ------------------------------ 实时流（宿主事件） ------------------------------ */

  /**
   * `kojo:launcher-log`：把原始字节块喂给该实例的流式解码器。
   * 没人订阅 = 不解码（完整日志在盘上，`tail` 随时可取）。
   */
  handleHostEvent(event: HostLogEvent): void {
    if (this.disposed) return;
    const listeners = this.listeners.get(event.instanceId);
    if (!listeners || listeners.size === 0) return;
    const key = strokeKey(event.instanceId, event.sessionId, event.stream);
    let stroke = this.strokes.get(key);
    if (!stroke) {
      stroke = new LogStroke(event.stream, this.profileOf(event.instanceId), this.decodeBytes);
      this.strokes.set(key, stroke);
    }
    const lines = stroke.push(decodeBase64(event.bytesBase64), this.now());
    if (lines.length > 0) this.emitLines(event.instanceId, lines);
  }

  /** 会话结束（`exited` / `crashed`）：把未闭合的半行冲出来，再丢掉该会话的解码状态 */
  finishSession(instanceId: string, sessionId: string | null): void {
    if (this.disposed) return;
    const prefix = `${instanceId}\u0000${sessionId ?? ''}\u0000`;
    for (const [key, stroke] of [...this.strokes]) {
      if (!key.startsWith(prefix)) continue;
      this.strokes.delete(key);
      const lines = stroke.flush(this.now());
      if (lines.length > 0) this.emitLines(instanceId, lines);
    }
  }

  /** 实时环形缓冲（additive 便利方法：日志页后开时先补一屏上下文） */
  recent(instanceId: string, maxLines?: number): readonly LogLine[] {
    const ring = this.rings.get(instanceId);
    if (!ring) return [];
    const limit = maxLines === undefined ? ring.length : Math.max(0, maxLines);
    return limit === 0 ? [] : ring.slice(Math.max(0, ring.length - limit));
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.strokes.clear();
    this.rings.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private profileOf(instanceId: string): EncodingProfile {
    return this.getEncoding(instanceId) ?? { mode: 'auto', fallback: 'utf-8' };
  }

  /**
   * 把宿主给出的一页**原始块**解成行。
   *
   * 每个流一份独立的解码器（stdout / stderr 的编码可以不同，且绝不能互相污染半个字符），
   * 块按宿主给的顺序喂入；末尾各 `flush` 一次把最后一行冲出来（`truncated` 由宿主给）。
   */
  private decodePage(page: HostLogPage, profile: EncodingProfile): LauncherLogPage {
    const strokes = new Map<LogLine['stream'], LogStroke>();
    const lines: LogLine[] = [];
    for (const chunk of page.chunks) {
      let stroke = strokes.get(chunk.stream);
      if (!stroke) {
        stroke = new LogStroke(chunk.stream, profile, this.decodeBytes);
        strokes.set(chunk.stream, stroke);
      }
      lines.push(...stroke.push(decodeBase64(chunk.bytesBase64), chunk.ts));
    }
    const lastTs = page.chunks.at(-1)?.ts ?? this.now();
    for (const stroke of strokes.values()) lines.push(...stroke.flush(lastTs));

    // 编码读数取第一路流的判据（同一实例的各路流共享同一份 profile；判据不同则如实取先到者）
    const first = strokes.values().next();
    const encoding: FileEncoding = first.done ? normalizeLabel(profile.fallback) : first.value.encoding;
    const probed = !first.done && first.value.probed;
    return { session: page.session, lines, truncated: page.truncated, encoding, probed };
  }

  private async latestSessionId(instanceId: string): Promise<string | undefined> {
    const sessions = await this.sessions(instanceId);
    let best: LogSession | undefined;
    for (const session of sessions) {
      if (!best || session.startedAt > best.startedAt) best = session;
    }
    return best?.id;
  }

  private emitLines(instanceId: string, lines: readonly LogLine[]): void {
    let ring = this.rings.get(instanceId);
    if (!ring) {
      ring = [];
      this.rings.set(instanceId, ring);
    }
    ring.push(...lines);
    if (ring.length > this.ringSize) ring.splice(0, ring.length - this.ringSize);

    const listeners = this.listeners.get(instanceId);
    if (!listeners) return;
    for (const line of lines) {
      for (const listener of [...listeners]) {
        try {
          listener(line);
        } catch {
          // 订阅者异常不影响其它订阅者
        }
      }
    }
  }

  private dropStrokes(instanceId: string): void {
    const prefix = `${instanceId}\u0000`;
    for (const key of [...this.strokes.keys()]) {
      if (key.startsWith(prefix)) this.strokes.delete(key);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 单个流：字节 → 文本 → 行
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 一路日志（stdout / stderr / system）的解码 + 分行状态机 */
class LogStroke {
  private readonly stream: LogLine['stream'];
  private readonly decoder: StreamingLogDecoder;
  private carry = '';

  constructor(stream: LogLine['stream'], profile: EncodingProfile, decodeBytes?: DecodeBytes) {
    this.stream = stream;
    this.decoder = new StreamingLogDecoder(profile, decodeBytes);
  }

  get encoding(): FileEncoding {
    return this.decoder.encoding;
  }

  get probed(): boolean {
    return this.decoder.probed;
  }

  push(bytes: Uint8Array, ts: number): LogLine[] {
    return this.split(this.decoder.push(bytes), ts);
  }

  flush(ts: number): LogLine[] {
    const lines = this.split(this.decoder.flush(), ts);
    if (this.carry !== '') {
      lines.push(this.line(this.carry, ts));
      this.carry = '';
    }
    return lines;
  }

  /** 只按 `\n` 切，行尾 `\r` 剥掉；末段留在 `carry` 等下一块（CRLF 跨块也成立） */
  private split(text: string, ts: number): LogLine[] {
    if (text === '') return [];
    const merged = this.carry + text;
    const parts = merged.split('\n');
    this.carry = parts.pop() ?? '';
    const lines: LogLine[] = [];
    for (const raw of parts) {
      lines.push(this.line(raw.endsWith('\r') ? raw.slice(0, -1) : raw, ts));
    }
    return lines;
  }

  private line(text: string, ts: number): LogLine {
    return { ts, stream: this.stream, text };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 流式解码（跨块多字节不截断）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 流式解码器：**编码判据一次定死**（中途换编码 = 同一行两种文本，是比猜错更糟的错），
 * 之后只做「按该编码解完整前缀 + 回退不完整尾字节」。
 *
 * 定编码的判据顺序：
 * 1. `profile.mode === 'fixed'`，或探测函数缺席 ⇒ `fallback`（`probed: false`）；
 * 2. `profile.mode === 'auto'` + 有探测函数 ⇒ **强证据立即定**（BOM、非 UTF-8 判定），
 *    纯 ASCII 前缀这类弱证据等攒到 `AUTO_PROBE_MIN_BYTES` 再定（`probed: true`）；
 * 3. 直到 `flush()` 都没攒够 ⇒ 用现有字节探测一次（仍无字节就用 `fallback`）。
 */
export class StreamingLogDecoder {
  private readonly profile: EncodingProfile;
  private readonly decodeBytes: DecodeBytes | undefined;
  private pending: Uint8Array = EMPTY;
  private decided = false;
  private label: FileEncoding;
  private probedFlag = false;

  constructor(profile: EncodingProfile, decodeBytes?: DecodeBytes) {
    this.profile = profile;
    this.decodeBytes = decodeBytes;
    this.label = normalizeLabel(profile.fallback);
  }

  get encoding(): FileEncoding {
    return this.label;
  }

  get probed(): boolean {
    return this.probedFlag;
  }

  /** 是否已定编码（未定 = 还在等强证据，`push` 返回空串） */
  get settled(): boolean {
    return this.decided;
  }

  /** 未消化的字节数（含不完整尾字节）——测试与排障用 */
  get pendingBytes(): number {
    return this.pending.length;
  }

  push(bytes: Uint8Array): string {
    if (bytes.length === 0) return '';
    this.pending = concatBytes(this.pending, bytes);
    if (!this.decided && !this.tryDecide()) return '';
    if (!this.decided) return '';
    const keep = incompleteTailLength(this.pending, this.label);
    const cut = this.pending.length - keep;
    if (cut <= 0) return '';
    const body = this.pending.subarray(0, cut);
    this.pending = this.pending.subarray(cut);
    return decodeLabel(body, this.label);
  }

  flush(): string {
    if (!this.decided) this.decideFromWhatWeHave();
    const body = this.pending;
    this.pending = EMPTY;
    if (body.length === 0) return '';
    return decodeLabel(body, this.label);
  }

  private tryDecide(): boolean {
    if (this.profile.mode === 'fixed' || !this.decodeBytes) {
      this.settle(normalizeLabel(this.profile.fallback), false);
      return true;
    }
    const probe = this.decodeBytes(this.pending);
    if (probe.encoding !== 'utf-8') {
      // 强证据：BOM 或非 UTF-8 判定（ASCII 前缀不可能走到这里）
      this.settle(probe.encoding, true);
      return true;
    }
    if (this.pending.length >= AUTO_PROBE_MIN_BYTES) {
      this.settle('utf-8', true);
      return true;
    }
    return false;
  }

  private decideFromWhatWeHave(): void {
    if (this.profile.mode === 'fixed' || !this.decodeBytes || this.pending.length === 0) {
      this.settle(normalizeLabel(this.profile.fallback), false);
      return;
    }
    this.settle(this.decodeBytes(this.pending).encoding, true);
  }

  private settle(label: FileEncoding, probed: boolean): void {
    this.decided = true;
    this.label = label;
    this.probedFlag = probed;
  }
}

const EMPTY = new Uint8Array(0);

/**
 * **不完整尾字节长度**（按目标编码的最大码元长度回退）。
 *
 * 返回 `n` 表示末尾 `n` 个字节构不成一个完整码元，必须留到下一块。
 * 单字节编码恒为 0；SJIS / GBK / Big5 只看末字节，UTF-8 回扫最多 4 字节，
 * UTF-16 处理奇数字节与「高位代理单独出现」。
 */
export function incompleteTailLength(bytes: Uint8Array, encoding: FileEncoding): number {
  const n = bytes.length;
  if (n === 0) return 0;
  switch (encoding) {
    case 'utf-8':
    case 'utf-8-bom': {
      for (let back = 1; back <= Math.min(4, n); back++) {
        const byte = bytes[n - back]!;
        if ((byte & 0xc0) === 0x80) continue; // 续字节：继续向前找首字节
        const need = byte < 0x80 ? 1 : byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return back < need ? back : 0;
      }
      return 0;
    }
    case 'shift_jis': {
      // 单字节区 0x00–0x7F 与 0xA1–0xDF（半角片假名）；双字节首字节 0x81–0x9F / 0xE0–0xFC
      const last = bytes[n - 1]!;
      return (last >= 0x81 && last <= 0x9f) || (last >= 0xe0 && last <= 0xfc) ? 1 : 0;
    }
    case 'gbk':
    case 'big5': {
      // 末字节落在首字节区间 ⇒ 既可能是上一个序列的尾字节、也可能是半个新序列，保守留 1
      const last = bytes[n - 1]!;
      return last >= 0x81 && last <= 0xfe ? 1 : 0;
    }
    case 'gb18030': {
      const isLead = (b: number) => b >= 0x81 && b <= 0xfe;
      const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
      const last = bytes[n - 1]!;
      if (isLead(last)) return 1;
      if (isDigit(last)) {
        if (n >= 2 && isLead(bytes[n - 2]!)) return 2; // 首字节 + 第 1 位
        if (n >= 3 && isDigit(bytes[n - 2]!) && isLead(bytes[n - 3]!)) return 3; // 首字节 + 2 位
      }
      return 0;
    }
    case 'utf-16le': {
      if (n % 2 === 1) return 1;
      const unit = bytes[n - 2]! | (bytes[n - 1]! << 8);
      return isHighSurrogate(unit) ? 2 : 0;
    }
    case 'utf-16be': {
      if (n % 2 === 1) return 1;
      const unit = (bytes[n - 2]! << 8) | bytes[n - 1]!;
      return isHighSurrogate(unit) ? 2 : 0;
    }
    default:
      return 0;
  }
}

/** 未知标签（`DECODE_LABEL` 的键集即全集）退回 utf-8，不抛：日志链路不该因一个坏配置整条断 */
function normalizeLabel(label: string): FileEncoding {
  return Object.prototype.hasOwnProperty.call(DECODE_LABEL, label) ? (label as FileEncoding) : 'utf-8';
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function decodeLabel(bytes: Uint8Array, encoding: FileEncoding): string {
  return new TextDecoder(DECODE_LABEL[encoding]).decode(bytes);
}

/* ------------------------------ 工具 ------------------------------ */

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function strokeKey(instanceId: string, sessionId: string, stream: LogLine['stream']): string {
  return `${instanceId}\u0000${sessionId}\u0000${stream}`;
}

/**
 * base64 → 字节（纯 JS，不依赖 `Buffer` / `atob`）：插件代码要能在 Node 与浏览器两侧
 * 逐字同行为，环境自带实现是最容易漂的那种"小差别"。
 */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '');
  const table = BASE64_ALPHABET;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = table.indexOf(clean[i]!);
    if (value < 0) continue; // 非法字符：跳过而不是抛（日志链路不该因为一个坏块整条断）
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
