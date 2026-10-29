/**
 * Kojo 2.0 迁移向导 · **宿主入口**判据（K2-MIGRATE-MOUNT）。
 *
 * 入口是纯逻辑（零 React、零 DOM），所以这一份全部走注入的假 io / 假列举 / 假刷新，
 * 在 node 环境里钉死七件事：
 *
 * 1. **flag 关 = 零注册**：`commands()` 空数组、`open()` 不列举也不改状态；
 * 2. **开合状态机**：`closed → opening → open | failed`，重复 `open` 不重走列举、
 *    在途 `close` 让旧结果作废（不会"关掉了又自己弹出来"）；
 * 3. **IO 注入与调用序**：应用时盘上动作必须是 `backup → writeText → readback`；
 * 4. **刷新只报真写过的文件**：`refreshFiles` 一次调用给全部路径，已 2.0 / 阻断 / 回滚都不报；
 * 5. **onApplied 只触发一次刷新**（不是逐文件各发一次，也不是零次）；
 * 6. **撤销路径**：`restoreBackup` → 回读断言 → 刷新恢复的路径；
 * 7. **语义层 rewrites 能一路带到向导**：入口给的 io 跑 dry-run，计划里带 kind / 行号 / 逐条 diff。
 */
import { describe, expect, it } from 'vitest';
import type { EolStyle, FileEncoding, TextFile, WriteTextOptions } from '@kojo/plugin-api';
import {
  createKojo2MigrateEntry,
  appliedPaths,
  isMigrateCandidate,
  selectMigrateFiles,
  KOJO2_MIGRATE_COMMAND_CATEGORY,
  KOJO2_MIGRATE_COMMAND_ID,
  KOJO2_MIGRATE_COMMAND_TITLE,
  type Kojo2MigrateEntry,
  type Kojo2MigrateEntrySnapshot,
} from '../src/ui/kojo2-migrate-entry';
import {
  dryRunMigrateFiles,
  type MigrateIoPort,
} from '../src/ui/kojo2-migrate-model';

/* ============================== 假 io（带调用序） ============================== */

type IoOp = 'read' | 'backup' | 'write' | 'restore';

interface IoCall {
  readonly op: IoOp;
  readonly path: string;
  readonly text?: string;
}

interface FakeFile {
  text: string;
  encoding: FileEncoding;
  eol: EolStyle;
}

class FakeIo implements MigrateIoPort {
  readonly files = new Map<string, FakeFile>();
  /** `${path}\u0000${versionId}` → 备份时的快照 */
  readonly backupContent = new Map<string, FakeFile>();
  /** 全部盘上动作，按发生顺序（调用序判据的唯一来源） */
  readonly calls: IoCall[] = [];
  failBackup = false;
  failRestore = false;

  private nextWriteCorrupt = false;
  private backupSeq = 0;

  seed(path: string, text: string, encoding: FileEncoding = 'utf-8', eol: EolStyle = 'lf'): void {
    this.files.set(path, { text, encoding, eol });
  }

  /** 只让**下一次**写入失败（回滚时那一次重写因此还能成功） */
  failNextWrite(): void {
    this.nextWriteCorrupt = true;
  }

  /** 盘上动作序列（`read` 含预演 / stale 复核 / 回读三种，故测试按位置断言） */
  ops(): IoOp[] {
    return this.calls.map((call) => call.op);
  }

  async readText(path: string): Promise<TextFile> {
    this.calls.push({ op: 'read', path });
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
    return { path, text: file.text, encoding: file.encoding, eol: file.eol, mtimeMs: null };
  }

  async writeText(path: string, text: string, opts?: WriteTextOptions): Promise<void> {
    this.calls.push({ op: 'write', path, text });
    const corrupt = this.nextWriteCorrupt;
    this.nextWriteCorrupt = false;
    const previous = this.files.get(path);
    const next: FakeFile = {
      text: corrupt ? `${text}\u0000CORRUPT` : text,
      encoding: previous?.encoding ?? 'utf-8',
      eol: previous?.eol ?? 'lf',
    };
    this.files.set(path, next);
    if (corrupt) throw new Error('原子写失败');
    void opts;
  }

  async backup(path: string): Promise<string | null> {
    this.calls.push({ op: 'backup', path });
    if (this.failBackup) throw new Error('备份桶不可写');
    const file = this.files.get(path);
    if (file === undefined) return null;
    this.backupSeq += 1;
    const versionId = `20260101-000000-${String(this.backupSeq).padStart(3, '0')}.bak`;
    this.backupContent.set(`${path}\u0000${versionId}`, { ...file });
    return `C:\\backup\\${versionId}`;
  }

  async restoreBackup(path: string, versionId: string): Promise<void> {
    this.calls.push({ op: 'restore', path });
    if (this.failRestore) throw new Error('备份桶不可读');
    const snapshot = this.backupContent.get(`${path}\u0000${versionId}`);
    if (snapshot === undefined) throw new Error(`版本不存在：${versionId}`);
    this.files.set(path, { ...snapshot });
  }
}

/* ============================== 夹具 ============================== */

const FILE = 'C:\\proj\\a.kojo';
const OTHER = 'C:\\proj\\b.kojo';
const V1 = '角色: 灵梦\n时机 指令 310：\n    「你好。」\n';
const V1_CODE = '# 机 指令 310\n灵梦：「「你好。」」\n';
const BAD = '角色: 灵梦\n时机 指令 310：\n    她的心情 = 1\n';

/** 语义层才证得动的 `当` 块（机械层对它记 unsupported，见 core 测试同款夹具） */
const SWITCH = '角色: 灵梦\n时机 指令 310：\n    当 TFLAG:193：\n        是 1：\n            她一言不发。\n        否则：\n            她什么也没说。\n';

interface Harness {
  readonly io: FakeIo;
  readonly entry: Kojo2MigrateEntry;
  readonly refreshCalls: Array<readonly string[]>;
  readonly notices: string[];
  readonly state: { enabled: boolean; listCalls: number };
}

function harness(options: {
  readonly enabled?: boolean;
  readonly listed?: readonly string[];
  readonly listError?: Error;
  readonly listPromise?: Promise<readonly string[]>;
} = {}): Harness {
  const state = { enabled: options.enabled ?? true, listCalls: 0 };
  const io = new FakeIo();
  const refreshCalls: Array<readonly string[]> = [];
  const notices: string[] = [];
  const entry = createKojo2MigrateEntry({
    io,
    listFiles: async () => {
      state.listCalls += 1;
      if (options.listPromise !== undefined) return options.listPromise;
      if (options.listError !== undefined) throw options.listError;
      return options.listed ?? [];
    },
    refreshFiles: (paths) => {
      refreshCalls.push(paths);
    },
    notify: (message) => {
      notices.push(message);
    },
    isEnabled: () => state.enabled,
  });
  return { io, entry, refreshCalls, notices, state };
}

/** 等到微任务清空（入口的 open / apply 都是异步的） */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/* ============================== 1. flag 守卫 ============================== */

describe('flag 关：零注册、零列举、零状态变化', () => {
  it('commands() 返回空数组（命令面板 / 快捷键表里一个字都不出现）', () => {
    const { entry } = harness({ enabled: false });
    expect(entry.commands()).toEqual([]);
    expect(entry.isEnabled()).toBe(false);
  });

  it('open() 返回 disabled：不列举、状态仍是 closed、一条通知都不发', async () => {
    const { entry, state, notices } = harness({ enabled: false, listed: [FILE] });

    const outcome = await entry.open();

    expect(outcome).toBe('disabled');
    expect(state.listCalls).toBe(0);
    expect(entry.getSnapshot()).toMatchObject({ status: 'closed', filePaths: [], message: null });
    expect(notices).toEqual([]);
  });

  it('flag 关时不注册、翻成开后同一条入口即出命令（读的是注入的开关，不是模块缓存）', () => {
    const { entry, state } = harness({ enabled: false });
    expect(entry.commands()).toHaveLength(0);
    state.enabled = true;
    expect(entry.commands()).toHaveLength(1);
  });
});

describe('flag 开：一条命令，run() 走 open()', () => {
  it('命令 id / 标题 / 分类逐字对上（命令面板与测试共用同一份标识）', () => {
    const { entry } = harness({ enabled: true });

    const commands = entry.commands();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      id: KOJO2_MIGRATE_COMMAND_ID,
      title: KOJO2_MIGRATE_COMMAND_TITLE,
      category: KOJO2_MIGRATE_COMMAND_CATEGORY,
    });
    expect(KOJO2_MIGRATE_COMMAND_ID).toBe('workbench.kojo2Migrate');
  });

  it('run() 是同步签名但会把入口打开（列举在后台走，不阻塞命令面板）', async () => {
    const { entry, state } = harness({ enabled: true, listed: [FILE] });

    entry.commands()[0]!.run();
    await flush();

    expect(state.listCalls).toBe(1);
    expect(entry.getSnapshot()).toMatchObject({ status: 'open', filePaths: [FILE] });
  });

  it('连按两次只列举一趟（第二次 busy，不重走 walk）', async () => {
    const { entry, state } = harness({ enabled: true, listed: [FILE] });

    entry.commands()[0]!.run();
    entry.commands()[0]!.run();
    await flush();

    expect(state.listCalls).toBe(1);
    expect(await entry.open()).toBe('busy');
    expect(state.listCalls).toBe(1);
  });
});

/* ============================== 2. 列举收口 ============================== */

describe('候选收口：只认 .kojo，按 pathKey 去重', () => {
  it('isMigrateCandidate：大小写不敏感，滤掉 .kojo2 / .erb / 无扩展名', () => {
    expect(isMigrateCandidate('C:\\proj\\a.kojo')).toBe(true);
    expect(isMigrateCandidate('C:\\proj\\A.KOJO')).toBe(true);
    expect(isMigrateCandidate('C:\\proj\\a.kojo2')).toBe(false);
    expect(isMigrateCandidate('C:\\proj\\a.erb')).toBe(false);
    expect(isMigrateCandidate('C:\\proj\\kojo')).toBe(false);
    expect(isMigrateCandidate('')).toBe(false);
  });

  it('selectMigrateFiles：保留列举顺序，同一文件（大小写 / 分隔符不同）只留一条', () => {
    const selected = selectMigrateFiles([
      'C:\\proj\\a.kojo',
      'C:\\proj\\a.erb',
      'c:/proj/A.KOJO',
      'C:\\proj\\b.kojo',
      'C:\\proj\\b.kojo2',
    ]);

    expect(selected).toEqual(['C:\\proj\\a.kojo', 'C:\\proj\\b.kojo']);
  });

  it('open：列举结果按上面的口径收口后才进快照', async () => {
    const { entry } = harness({
      listed: ['C:\\proj\\a.kojo', 'C:\\proj\\note.erb', 'C:\\proj\\x.kojo2', 'C:\\proj\\b.KOJO'],
    });

    await entry.open();

    expect(entry.getSnapshot().filePaths).toEqual(['C:\\proj\\a.kojo', 'C:\\proj\\b.KOJO']);
  });

  it('open：零文件也算开成（空态由向导呈现，不是错误）', async () => {
    const { entry, notices } = harness({ listed: [] });

    expect(await entry.open()).toBe('opened');
    expect(entry.getSnapshot()).toMatchObject({ status: 'open', filePaths: [], message: null });
    expect(notices).toEqual([]);
  });
});

/* ============================== 3. 状态机 ============================== */

describe('开合状态机：opening 可见、失败可恢复、在途 close 作废', () => {
  it('open 期间快照是 opening（列举可能要走一趟递归 walk）', async () => {
    let release: (paths: readonly string[]) => void = () => undefined;
    const pending = new Promise<readonly string[]>((resolve) => {
      release = resolve;
    });
    const { entry } = harness({ listPromise: pending });

    const opening = entry.open();
    await flush();
    expect(entry.getSnapshot().status).toBe('opening');

    release([FILE]);
    expect(await opening).toBe('opened');
    expect(entry.getSnapshot()).toMatchObject({ status: 'open', filePaths: [FILE] });
  });

  it('列举失败：failed + 人话原因上屏，再次 open 能恢复（失败不是死态）', async () => {
    const failing = harness({ listError: new Error('EPERM: 目录不可读') });
    expect(await failing.entry.open()).toBe('failed');
    expect(failing.entry.getSnapshot().status).toBe('failed');
    expect(failing.entry.getSnapshot().message).toContain('EPERM: 目录不可读');
    expect(failing.notices).toHaveLength(1);

    const recovered = harness({ listed: [FILE] });
    expect(await recovered.entry.open()).toBe('opened');
    expect(recovered.entry.getSnapshot().status).toBe('open');
  });

  it('open 在途 close：旧列举结果作废，状态保持 closed（不会关掉又自己弹出来）', async () => {
    let release: (paths: readonly string[]) => void = () => undefined;
    const pending = new Promise<readonly string[]>((resolve) => {
      release = resolve;
    });
    const { entry } = harness({ listPromise: pending });

    const opening = entry.open();
    await flush();
    entry.close();
    release([FILE]);

    expect(await opening).toBe('busy');
    expect(entry.getSnapshot()).toMatchObject({ status: 'closed', filePaths: [] });
  });

  it('close：清空 filePaths 并通知订阅者一次；重复 close 不再通知', async () => {
    const { entry } = harness({ listed: [FILE] });
    await entry.open();
    const seen: Kojo2MigrateEntrySnapshot[] = [];
    const un = entry.subscribe((snapshot) => seen.push(snapshot));

    entry.close();
    entry.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'closed', filePaths: [] });
    un();
  });

  it('getSnapshot 在状态不变时返回同一引用（订阅方不会自激重渲）', () => {
    const { entry } = harness({ enabled: true });
    expect(entry.getSnapshot()).toBe(entry.getSnapshot());
  });

  it('订阅：能收到快照，取消订阅后不再收到', async () => {
    const { entry } = harness({ listed: [FILE] });
    const seen: Kojo2MigrateEntrySnapshot[] = [];
    const un = entry.subscribe((snapshot) => seen.push(snapshot));

    await entry.open();
    expect(seen.map((snapshot) => snapshot.status)).toEqual(['opening', 'open']);

    un();
    entry.close();
    expect(seen).toHaveLength(2);
  });
});

/* ============================== 4. 应用：调用序 + 刷新一次 ============================== */

describe('应用：backup → writeText → readback，刷新一次', () => {
  it('IO 调用序：复核读 → backup → write → readback（写盘 preserve）', async () => {
    const { io, entry } = harness({ listed: [FILE] });
    io.seed(FILE, V1, 'shift_jis', 'crlf');
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);
    io.calls.length = 0; // 预演的读盘已记账；下面只判 apply 那一段的盘上动作序

    const result = await entry.apply(plan);

    expect(result.ok).toBe(true);
    // 只数 apply 那一段（dry-run 自己的读盘属于预演，先清账）：
    // 首读 = stale 复核（预演之后盘上有没有被改过），末读 = 写入后的回读断言
    expect(io.ops()).toEqual(['read', 'backup', 'write', 'read']);
    const write = io.calls.find((call) => call.op === 'write');
    expect(write?.text).toBe(V1_CODE);
    expect((await io.readText(FILE)).text).toBe(V1_CODE);
  });

  it('刷新恰好一次，参数 = 真写过的路径（不是逐文件各发一次）', async () => {
    const { io, entry, refreshCalls } = harness({ listed: [FILE] });
    io.seed(FILE, V1);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);

    await entry.apply(plan);

    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toEqual([FILE]);
  });

  it('通知恰好一次，消息来自迁移结果（写盘成功口径）', async () => {
    const { io, entry, notices } = harness({ listed: [FILE] });
    io.seed(FILE, V1);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);

    const result = await entry.apply(plan);

    expect(notices).toEqual([result.message]);
    expect(notices[0]).toContain('写入 1 个文件');
  });

  it('已是 2.0：零写盘、零刷新，仍通知（作者要看见"这次没改"）', async () => {
    const { io, entry, refreshCalls, notices } = harness({ listed: [FILE] });
    io.seed(FILE, V1_CODE);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);

    const result = await entry.apply(plan);

    expect(result.ok).toBe(true);
    expect(result.written).toBe(0);
    expect(io.ops()).toEqual(['read']);
    expect(refreshCalls).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('整批阻断（fail-closed）：零写盘、零刷新，通知说明拒绝', async () => {
    const { io, entry, refreshCalls, notices } = harness({ listed: [FILE] });
    io.seed(FILE, BAD);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);

    const result = await entry.apply(plan);

    expect(result.ok).toBe(false);
    expect(io.ops()).toEqual(['read']);
    expect(refreshCalls).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('拒绝');
    expect((await io.readText(FILE)).text).toBe(BAD);
  });

  it('回滚：盘上回到迁移前，刷新 0 次（没留下新内容），通知一条', async () => {
    const { io, entry, refreshCalls, notices } = harness({ listed: [FILE] });
    io.seed(FILE, V1);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);
    io.failNextWrite();

    const result = await entry.apply(plan);

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(1);
    expect((await io.readText(FILE)).text).toBe(V1);
    expect(refreshCalls).toHaveLength(0);
    expect(notices).toHaveLength(1);
  });

  it('部分写入（整批 ok=false 但有文件写成功）：写过的那个照样刷新一次', async () => {
    const { io, entry, refreshCalls } = harness({ listed: [FILE, OTHER] });
    io.seed(FILE, V1);
    io.seed(OTHER, V1);
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE, OTHER]);
    io.failNextWrite(); // 第一个文件写坏 → 回滚；第二个照常写入

    const result = await entry.apply(plan);

    expect(result.ok).toBe(false);
    expect(result.written).toBe(1);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toEqual([OTHER]);
    expect(appliedPaths(result)).toEqual([OTHER]);
  });
});

/* ============================== 5. 撤销 ============================== */

describe('撤销：restoreBackup → 回读 → 刷新恢复的路径', () => {
  it('undo 成功：源文本 / 编码 / EOL 回到迁移前，刷新一次', async () => {
    const { io, entry, refreshCalls } = harness({ listed: [FILE] });
    io.seed(FILE, V1, 'shift_jis', 'crlf');
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);
    const applied = await entry.apply(plan);
    expect(applied.ok).toBe(true);
    refreshCalls.length = 0;

    const undo = await entry.undo(plan, applied);

    expect(undo.ok).toBe(true);
    expect(undo.restored).toBe(1);
    expect(io.ops()).toContain('restore');
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toEqual([FILE]);
    const after = await io.readText(FILE);
    expect(after.text).toBe(V1);
    expect(after.encoding).toBe('shift_jis');
    expect(after.eol).toBe('crlf');
  });

  it('没有可撤销的写入：刷新 0 次，通知一条（结果必须可见）', async () => {
    const { io, entry, refreshCalls, notices } = harness({ listed: [FILE] });
    io.seed(FILE, V1_CODE); // 已是 2.0 ⇒ apply 不写盘 ⇒ 无备份可恢复
    await entry.open();
    const plan = await dryRunMigrateFiles(io, [FILE]);
    const applied = await entry.apply(plan);
    refreshCalls.length = 0;
    notices.length = 0;

    const undo = await entry.undo(plan, applied);

    expect(undo.ok).toBe(false);
    expect(refreshCalls).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('没有可撤销');
  });
});

/* ============================== 6. 语义层 rewrites 上屏 ============================== */

describe('语义层：入口注入的 io 跑出的计划带 rewrites（逐条 diff 能上屏）', () => {
  it('`当` 块：机械层会阻断，入口的计划 ok=true 且带一条 switch-table', async () => {
    const { io, entry } = harness({ listed: [FILE] });
    io.seed(FILE, SWITCH);
    await entry.open();

    const plan = await dryRunMigrateFiles(io, [FILE]);

    expect(plan.ok).toBe(true);
    expect(plan.summary.rewriteCount).toBe(1);
    const file = plan.files[0]!;
    expect(file.ok).toBe(true);
    expect(file.rewrites).toHaveLength(1);
    const rewrite = file.rewrites[0]!;
    expect(rewrite.kind).toBe('switch-table');
    expect([rewrite.line, rewrite.endLine]).toEqual([3, 7]);
    expect(rewrite.declName).toBe('迁移表1');
    expect(rewrite.reference).toBe('> {迁移表1}');
    // 逐条 diff：原块逐行在左、落点在右
    expect(rewrite.diffText).toContain('-    当 TFLAG:193：');
    expect(rewrite.diffText).toContain('+> {迁移表1}');
    expect(rewrite.diffText).toContain(`--- a/${FILE}`);
    // 整份 diff 里也能看见语义层的产物
    expect(file.diffText).toContain('+# 对照表 迁移表1 依据 TFLAG:193');
  });

  it('`初回` 块：落点是 @原生 围栏，原块按 context 展示（没被"删掉"）', async () => {
    const { io } = harness();
    io.seed(FILE, '角色: 灵梦\n时机 指令 310：\n    初回 "once"：\n        「甲」\n');

    const plan = await dryRunMigrateFiles(io, [FILE]);

    expect(plan.ok).toBe(true);
    const rewrite = plan.files[0]!.rewrites[0]!;
    expect(rewrite.kind).toBe('ask-native');
    expect(rewrite.declName).toBeNull();
    expect(rewrite.reference).toBe('@原生');
    expect(rewrite.diffText).toContain('     初回 "once"：');
    expect(rewrite.diffText).toContain('+@原生');
  });
});

