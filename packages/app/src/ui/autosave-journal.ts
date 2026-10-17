import { join, pathKey } from '@kojo/plugin-api';

/**
 * autosave 快照 journal（2026-10-16 退出/崩溃守护批）。
 *
 * 定位：**崩溃兜底**，不是第二个保存通道。脏 model 内容按防抖快照到
 * `{appData}/autosave/`（appData 在 Rust 写允许域内恒可写；**绝不写游戏目录**，
 * 也不走 kernel io——那条链路 assertWritable 游戏路径 + 触发备份轮换，都不该发生）。
 *
 * 布局（全平铺一个目录，零子树）：
 * - `manifest.json` — 索引：`{ v, root, savedAt, entries: { [绝对路径]: { file, encoding, eol, savedAt } } }`
 * - `snap-<hash>.txt` — 逐路径内容快照（恒 UTF-8 存 JS 字符串；encoding 只是原文件的显示口径，
 *   恢复后保存仍由 kernel io 按盘上文件保编码）
 * - `heartbeat.json` — `{"t":<epochMs>}`；脏周期内定期刷。启动时超龄 = 上次不是善终。
 *
 * 崩溃判定口径：manifest 有条目 **且** 心跳超龄（心跳缺失也按崩溃算——manifest 与心跳
 * 同拍写，缺失只可能是"写了一半就没命"，正是要兜的场景）。善终路径（保存完/丢弃完）
 * 会把 manifest 清空，所以"有条目 + 心跳超龄"在善终后不可能成立。
 *
 * 本模块零 React 零 Tauri：IO 经 `JournalIo` 注入（node 测试用真临时目录直喂 node:fs），
 * 判定全部是纯函数。恢复**永不自动写游戏目录**——快照内容只装回 model 当未保存脏内容，
 * 存不存由用户决定。
 */

/** 心跳超龄阈值：心跳周期 10s 的 6 倍余量（整机休眠/长 GC 都不会误判） */
export const HEARTBEAT_STALE_MS = 60_000;
/** 脏内容变化 → 快照落盘的防抖 */
export const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** 脏周期内心跳刷新周期 */
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** 快照目录名（`{appData}/autosave`）——**布局的单一真源在这里**，别处请引它 */
export const AUTOSAVE_DIR_NAME = 'autosave';
/** manifest / 心跳的文件名（同上：读面不许自拼字面量） */
export const AUTOSAVE_MANIFEST_FILE = 'manifest.json';
export const AUTOSAVE_HEARTBEAT_FILE = 'heartbeat.json';

export interface JournalEntry {
  /** 快照文件名（本目录内平铺） */
  file: string;
  encoding: string;
  eol: string;
  savedAt: number;
}

export interface JournalManifest {
  v: 1;
  /** 快照时打开的项目根（null = 无项目时产生过快照——理论不可达，防御性保留） */
  root: string | null;
  savedAt: number;
  /** 键 = 文件绝对路径（原样，不做归一——manifest 由写入方单源生成） */
  entries: Record<string, JournalEntry>;
}

/** EditorPane 快照句柄吐出的一条脏内容 */
export interface SnapshotRecord {
  path: string;
  text: string;
  encoding: string;
  eol: string;
}

/** 恢复决策产物：装回 model 的内容（原路径 + 快照文本） */
export interface RecoveredRecord {
  path: string;
  text: string;
  encoding: string;
  eol: string;
}

/** journal 的 IO 面（Tauri 壳接 bridge，node 测试接 node:fs） */
export interface JournalIo {
  /** 缺失返回 undefined（与存在但读失败区分） */
  readTextFile(path: string): Promise<string | undefined>;
  writeTextFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

/* ------------------------------ 纯函数 ------------------------------ */

/** FNV-1a 32bit 单 lane（offset-basis 与遍历方向可换——两条独立 lane 的拼法见 `contentHashOf`） */
function fnv1a32(s: string, basis: number, reverse: boolean): number {
  let h = basis >>> 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(reverse ? n - 1 - i : i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 路径 → 64 位判据 → 16 位 hex（快照文件名喂的是 `pathKey` 归一形）。
 *
 * 为什么必须是 64 位：32 位单 lane 在数千文件的同目录语料下生日碰撞 ~0.06%——碰撞的
 * 两条路径共用同一份 `snap-<hash>.txt`，崩溃恢复会把 B 的内容装回 A 的 buffer，而纯文本
 * 快照没有属主信息可校验，串档是静默的。判据 = 两条**独立** FNV-1a 32 位 lane 拼接：
 * - lane1 正序、标准 offset-basis `0x811c9dc5`；
 * - lane2 逆序、basis 取 FNV-1a 64 位 offset-basis 的低 32 位 `0x84222325`——同目录文件的
 *   前缀全同、差异集中在短后缀，逆序让差异**先**进 lane2，两条 lane 对这一真实事故形态
 *   天然解耦；组合空间 64 位，数千文件规模碰撞概率 ~1e-12。
 * 纯函数、零随机零时钟：同一输入恒得同一输出（确定性可测）。
 */
export function contentHashOf(path: string): string {
  const hi = fnv1a32(path, 0x811c9dc5, false);
  const lo = fnv1a32(path, 0x84222325, true);
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** 快照文件名：hash 喂 pathKey 归一形（Windows 大小写/分隔符折叠——同一文件两种写法共用一份快照） */
export function snapshotFileName(path: string): string {
  return `snap-${contentHashOf(pathKey(path))}.txt`;
}

/**
 * 某路径的快照落点（**读面唯一的拼法**：时间线要预览/写回快照时不许自拼 `snap-` 前缀）。
 * 与 `snapshotFileName` 同尺：Windows 两种写法折叠成同一个文件，读回来的就是那一份。
 */
export function snapshotFilePathOf(dir: string, path: string): string {
  return join(dir, snapshotFileName(path));
}

export function emptyManifest(root: string | null): JournalManifest {
  return { v: 1, root, savedAt: 0, entries: {} };
}

/** 损坏容忍：任何不合法形态都回空 manifest（快照是兜底数据，绝不让它反过来炸启动） */
export function parseManifest(raw: string | undefined): JournalManifest {
  if (raw === undefined) return emptyManifest(null);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyManifest(null);
    const m = parsed as Record<string, unknown>;
    if (m.v !== 1 || typeof m.entries !== 'object' || m.entries === null) return emptyManifest(null);
    const entries: Record<string, JournalEntry> = {};
    for (const [p, e] of Object.entries(m.entries as Record<string, unknown>)) {
      if (typeof p !== 'string' || p === '') continue;
      if (typeof e !== 'object' || e === null) continue;
      const t = e as Record<string, unknown>;
      if (typeof t.file !== 'string' || t.file === '') continue;
      entries[p] = {
        file: t.file,
        encoding: typeof t.encoding === 'string' ? t.encoding : 'utf-8',
        eol: typeof t.eol === 'string' ? t.eol : 'lf',
        savedAt: typeof t.savedAt === 'number' && Number.isFinite(t.savedAt) ? t.savedAt : 0,
      };
    }
    return {
      v: 1,
      root: typeof m.root === 'string' ? m.root : null,
      savedAt: typeof m.savedAt === 'number' && Number.isFinite(m.savedAt) ? m.savedAt : 0,
      entries,
    };
  } catch {
    return emptyManifest(null);
  }
}

export function serializeManifest(m: JournalManifest): string {
  return JSON.stringify(m);
}

/** 心跳文件 → 时间戳；缺失/损坏 → null */
export function parseHeartbeatMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const t = (parsed as Record<string, unknown>).t;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
  } catch {
    return null;
  }
}

/** 崩溃判定（纯）：条目非空 且 心跳缺失或超龄。善终路径清空 manifest，不会落进这里 */
export function planCrashRecovery(m: JournalManifest, heartbeatRaw: string | undefined, nowMs: number): boolean {
  if (Object.keys(m.entries).length === 0) return false;
  const beat = parseHeartbeatMs(heartbeatRaw);
  return beat === null || nowMs - beat > HEARTBEAT_STALE_MS;
}

/** 下一次 manifest：entries 以本次快照记录为准（真相源 = model，不信任触发用的脏集合） */
export function buildManifest(
  root: string | null,
  records: readonly SnapshotRecord[],
  nowMs: number,
): JournalManifest {
  const entries: Record<string, JournalEntry> = {};
  for (const r of records) {
    entries[r.path] = {
      file: snapshotFileName(r.path),
      encoding: r.encoding,
      eol: r.eol,
      savedAt: nowMs,
    };
  }
  return { v: 1, root, savedAt: nowMs, entries };
}

/* ------------------------------ 引擎 ------------------------------ */

export class AutosaveJournal {
  private readonly dirPromise: Promise<string> | string;
  /** 本会话最近一次写出的快照文件名（孤儿回收用） */
  private liveFiles = new Set<string>();
  /** 本会话是否写过非空快照（clear 的保护闸 / heartbeat 的前置条件） */
  private hasEntries = false;

  constructor(
    private readonly io: JournalIo,
    dir: string | Promise<string>,
  ) {
    this.dirPromise = dir;
  }

  private async dir(): Promise<string> {
    return typeof this.dirPromise === 'string' ? this.dirPromise : this.dirPromise;
  }

  private async path(name: string): Promise<string> {
    return join(await this.dir(), name);
  }

  /** 快照一批脏内容（entries 以本次记录全量重建；records 为空 = 写空 manifest 即清空） */
  async snapshot(root: string | null, records: readonly SnapshotRecord[], nowMs = Date.now()): Promise<void> {
    const manifest = buildManifest(root, records, nowMs);
    const names = new Set<string>();
    for (const r of records) {
      const file = snapshotFileName(r.path);
      names.add(file);
      await this.io.writeTextFile(await this.path(file), r.text);
    }
    // 上轮有、这轮没了的快照文件顺手回收（保存/关标签后的孤儿；失败不打扰下次）
    for (const file of this.liveFiles) {
      if (!names.has(file)) await this.io.removeFile(await this.path(file)).catch(() => undefined);
    }
    this.liveFiles = names;
    await this.io.writeTextFile(await this.path(AUTOSAVE_MANIFEST_FILE), serializeManifest(manifest));
    await this.io.writeTextFile(await this.path('heartbeat.json'), JSON.stringify({ t: nowMs }));
    this.hasEntries = records.length > 0;
  }

  /** 心跳：只在会话内写过快照时刷（干净会话绝不制造"疑似崩溃"的证据） */
  async heartbeat(nowMs = Date.now()): Promise<void> {
    if (!this.hasEntries) return;
    await this.io.writeTextFile(await this.path('heartbeat.json'), JSON.stringify({ t: nowMs }));
  }

  /** 会话内善终清空：本会话没写过快照 = no-op（保护上一次会话的崩溃证据不被新会话抹掉） */
  async clear(): Promise<void> {
    if (!this.hasEntries) return;
    await this.writeEmpty();
  }

  /** 强制清空（用户明确丢弃未保存内容 / 保存后立即退出的竞态兜底） */
  async discard(): Promise<void> {
    await this.writeEmpty();
  }

  private async writeEmpty(): Promise<void> {
    await this.io.writeTextFile(await this.path(AUTOSAVE_MANIFEST_FILE), serializeManifest(emptyManifest(null)));
    await this.io.removeFile(await this.path('heartbeat.json')).catch(() => undefined);
    this.hasEntries = false;
  }

  /**
   * 启动时读回：崩溃（条目非空 + 心跳超龄/缺失）→ 逐条读快照内容；否则 null。
   * 不改 hasEntries（读回的不是本会话的写入）。
   */
  async readForRecovery(nowMs = Date.now()): Promise<{ manifest: JournalManifest; records: RecoveredRecord[] } | null> {
    const manifest = parseManifest(await this.io.readTextFile(await this.path(AUTOSAVE_MANIFEST_FILE)));
    if (!planCrashRecovery(manifest, await this.io.readTextFile(await this.path('heartbeat.json')), nowMs)) {
      return null;
    }
    const records: RecoveredRecord[] = [];
    for (const [path, entry] of Object.entries(manifest.entries)) {
      const text = await this.io.readTextFile(await this.path(entry.file));
      if (text === undefined) continue; // 快照文件丢了：宁缺毋滥，其余条目照常恢复
      records.push({ path, text, encoding: entry.encoding, eol: entry.eol });
    }
    return records.length > 0 ? { manifest, records } : null;
  }
}

/* ---------------------- 只读视图（W11 时间线批） ---------------------- */

/**
 * 时间线要的**只读**那一面：给一个 `dir`（`{appData}/autosave`）和一条最小读通道，
 * 把 manifest 里的快照清单读回来——**不建引擎、不改状态、不消费恢复件**。
 *
 * 为什么值得单开一个口子而不是"再举一次 AutosaveJournal 实例"：
 * 崩溃引擎的生命周期属于会话（`hasEntries` / 孤儿回收），历史查看是一次只读旁听，
 * 两者混在一个实例里会让"看一眼时间线"变成一次可能改动会话状态的动作。
 * 格式仍只有这一份实现（`parseManifest` / `snapshotFileName` 都住在本模块）。
 */
export interface JournalReadIo {
  /** 缺失返回 undefined（与 `JournalIo.readTextFile` 同口径） */
  readTextFile(path: string): Promise<string | undefined>;
}

/** manifest 里的一条快照（`savedAt` = 防抖落盘那一刻；条目没有版本号，路径就是身份） */
export interface AutosaveSnapshotInfo {
  path: string;
  /** 快照文件名（本目录内平铺） */
  file: string;
  /** 快照的盘上绝对路径（= `join(dir, file)`，读预览/写回都拿它） */
  filePath: string;
  savedAt: number;
  encoding: string;
  eol: string;
}

/** 快照清单 + 是否"疑似上次没善终"（心跳缺失/超龄；横幅口径与启动探测同一个函数） */
export interface AutosaveView {
  snapshots: AutosaveSnapshotInfo[];
  root: string | null;
  crashSuspected: boolean;
}

export async function readAutosaveView(io: JournalReadIo, dir: string): Promise<AutosaveView> {
  const manifest = parseManifest(await io.readTextFile(join(dir, AUTOSAVE_MANIFEST_FILE)));
  const heartbeatRaw = await io.readTextFile(join(dir, AUTOSAVE_HEARTBEAT_FILE));
  const snapshots: AutosaveSnapshotInfo[] = [];
  for (const [path, entry] of Object.entries(manifest.entries)) {
    snapshots.push({
      path,
      file: entry.file,
      filePath: join(dir, entry.file),
      savedAt: entry.savedAt,
      encoding: entry.encoding,
      eol: entry.eol,
    });
  }
  // 按时刻新在前（与备份/回收站清单同一呈现口径）
  snapshots.sort((a, b) => b.savedAt - a.savedAt);
  return {
    snapshots,
    root: manifest.root,
    crashSuspected: planCrashRecovery(manifest, heartbeatRaw, Date.now()),
  };
}
