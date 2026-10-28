/**
 * 真另存为（1028 批）——判据、编码保真与**转档随迁**的自证。
 *
 * 覆盖五面（口径与 `file-ops-exec` / `editor-model-pool` 同族：判定与执行全走注入缝，
 * 不碰原生对话框）：
 * A. `judgeSaveAs` 逐条判据（同路径→普通保存 / 域外→拒绝且文案点名『导出』与通道 id /
 *    宿主准入拒绝 / 目标已有活 buffer→拒绝（绝不两格同路径）/ 盘上已有→覆盖确认分支 / 正常 proceed）；
 * B. `saveAsFileName` 剥路径（正反分隔符与裸文件名）；
 * C. `writeSaveAsBytes` 编码保真：落盘字节 **=== io.encodeForSave 的产物**（与
 *    `encoding-actions.saveWithEncoding` 同源那半），不退化 `writeText` 默认编码；
 *    能力缺席 ⇒ 明说不写；覆盖分支先 `backup(to)`，备份没成不盖；旧键判据 `forgetPathCaches(from)`；
 * D. `runSaveAsFlow` 编排：取消/拒绝零写动作、覆盖确认两条腿、竞态 `clean` 口径；
 * E. **七处路径键登记随迁**（本批命门）——用真内核 io（NodeBridge + 临时目录）+ 真池 +
 *    真 journal 跑全链：①池 `pool/baseLru/coldLru`、②`dirtyPaths`、③`pinnedPaths`、
 *    ④journal `entries`（键原样不归一）、⑤EditorPane 三张 ref 账（源码形态，2600 行组件
 *    闭包无挂载设施——`editor-pane-dataflow.test.ts` 先例）、⑥内核 `encodingCache`、
 *    ⑦编辑器组标签（`migrateGroupPathsAfterSaveAs`）；旧路径在每一处彻底消失、
 *    **原路径盘上文件 md5 逐字节不变**、新路径字节 == encodeForSave 产物；
 *    换扩展名（.kojo↔.kojo2）的语言面重判接线另用形态钉（判据本体已由
 *    `kojo2-model-language.test.ts:407` 行为钉住）。
 * F. 接线形状：另存为的索引通知**不是** rename 成对迁移（记「盘上新增」，原路径还在）、
 *    命令入口注册与键位表懒半、调试宿只选取器命令集（`debug-surface` 另有行为钉）。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathKey, type FileEncoding } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../kernel/src/io';
import { NodeBridge } from '../../kernel/tests/helpers/node-bridge';
import {
  judgeSaveAs,
  runSaveAsFlow,
  saveAsFileName,
  SAVE_AS_OPEN_BUFFER_MESSAGE,
  SAVE_AS_OUT_OF_DOMAIN_MESSAGE,
  writeSaveAsBytes,
  type SaveAsExecIo,
  type SaveAsFlowDeps,
  type SaveAsJudgeFacts,
} from '../src/ui/file-save-as';
import { createEditorModelPool, type PoolDeps } from '../src/ui/editor-model-pool';
import { migrateGroupPathsAfterSaveAs, type EditorGroupsState } from '../src/ui/editor-groups';
import { reconcilePathsAfterDiskChange } from '../src/ui/disk-reconcile';
import { AutosaveJournal, parseManifest, snapshotFileName, type JournalIo } from '../src/ui/autosave-journal';
import { writeDomainSaveBlockedMessage } from '../src/ui/write-domain';

/* ============================ 共享小工具（源码形态钉：editor-pane-dataflow 先例） ============================ */

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const readSource = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 截 `const NAME =` 到下一个同级 `const`（粗略但足够钉形状） */
function sliceFn(src: string, name: string): string {
  const start = src.indexOf(`const ${name} =`);
  expect(start, `找不到 const ${name}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + `const ${name} =`.length);
  const end = rest.search(/\n  const [A-Za-z_]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

/* ============================ A · judgeSaveAs 逐条判据 ============================ */

const CUR = 'C:\\作者区\\口上\\原文件.ERB';
const IN_DOMAIN = 'C:\\作者区\\口上\\新位置.ERB';
const OUT_DOMAIN = 'D:\\Game\\eraNAS\\con\\9999.ERB';

/** 缺省全绿事实（逐条只翻一格，防串） */
function facts(over: Partial<SaveAsJudgeFacts> = {}): SaveAsJudgeFacts {
  return {
    currentPath: CUR,
    candidate: IN_DOMAIN,
    targetWritable: true,
    hostBlocked: false,
    targetHasLiveBuffer: false,
    targetExistsOnDisk: false,
    dialogConfirmsOverwrite: true,
    ...over,
  };
}

describe('另存为 · judgeSaveAs 逐条判据（拒绝全部写在落盘之前）', () => {
  it('candidate=null ⇒ cancelled（取消不产生任何决定）', () => {
    expect(judgeSaveAs(facts({ candidate: null }))).toEqual({ kind: 'cancelled' });
  });

  it('目标 === 当前路径 ⇒ save-current（走普通保存链；pathKey 尺子，两种拼写同路径同判）', () => {
    expect(judgeSaveAs(facts({ candidate: IN_DOMAIN, currentPath: IN_DOMAIN }))).toEqual({ kind: 'save-current' });
    // 同一路径的另一种写法（小写盘符 + 正斜杠 + 扩展名大小写）——pathKey 归一后仍是同路径
    expect(judgeSaveAs(facts({ candidate: 'c:/作者区/口上/新位置.ERB', currentPath: IN_DOMAIN }))).toEqual({ kind: 'save-current' });
  });

  it('域外 ⇒ reject，文案点名『导出』那条路与通道 id（exportFile），且一字不落', () => {
    const d = judgeSaveAs(facts({ candidate: OUT_DOMAIN, targetWritable: false }));
    expect(d.kind).toBe('reject');
    if (d.kind === 'reject') {
      expect(d.reason).toBe(SAVE_AS_OUT_OF_DOMAIN_MESSAGE);
      expect(d.reason).toContain('导出');
      expect(d.reason).toContain('exportFile');
      expect(d.reason).toContain('一个字节都没落');
    }
  });

  it('宿主准入门拒过的目录 ⇒ reject（与保存按钮置灰同一份事实、同一句人话）', () => {
    const d = judgeSaveAs(facts({ hostBlocked: true }));
    expect(d).toEqual({ kind: 'reject', reason: writeDomainSaveBlockedMessage });
  });

  it('目标已站着别的活 buffer ⇒ reject——同一路径绝不挂两格 buffer', () => {
    const d = judgeSaveAs(facts({ targetHasLiveBuffer: true }));
    expect(d).toEqual({ kind: 'reject', reason: SAVE_AS_OPEN_BUFFER_MESSAGE });
  });

  it('盘上已有同名文件：对话框自确认（桌面壳）⇒ proceed+overwrite；注入缝不确认 ⇒ confirm-overwrite（绝不直接写）', () => {
    expect(judgeSaveAs(facts({ targetExistsOnDisk: true, dialogConfirmsOverwrite: true }))).toEqual({
      kind: 'proceed', target: IN_DOMAIN, overwrite: true,
    });
    expect(judgeSaveAs(facts({ targetExistsOnDisk: true, dialogConfirmsOverwrite: false }))).toEqual({
      kind: 'confirm-overwrite', target: IN_DOMAIN,
    });
  });

  it('干净新落点 ⇒ proceed+overwrite=false；判定次序：同路径先于写域（取消目标不许吃域外拒绝）', () => {
    expect(judgeSaveAs(facts())).toEqual({ kind: 'proceed', target: IN_DOMAIN, overwrite: false });
    expect(judgeSaveAs(facts({ candidate: CUR, targetWritable: false }))).toEqual({ kind: 'save-current' });
    // 活 buffer 判定在覆盖判定之前（两格同路径比覆盖更严重）
    expect(judgeSaveAs(facts({ targetHasLiveBuffer: true, targetExistsOnDisk: true }))).toEqual({
      kind: 'reject', reason: SAVE_AS_OPEN_BUFFER_MESSAGE,
    });
  });
});

/* ============================ B · saveAsFileName ============================ */

describe('另存为 · saveAsFileName（对话框预填名 = 剥路径）', () => {
  it('反斜杠 / 正斜杠 / 混用都只剥最后一段；裸名原样；大小写与 CJK 不动', () => {
    expect(saveAsFileName('C:\\作者区\\口上\\a.ERB')).toBe('a.ERB');
    expect(saveAsFileName('C:/作者区/口上/b.kojo')).toBe('b.kojo');
    expect(saveAsFileName('C:\\混合/a\\b.kojo2')).toBe('b.kojo2');
    expect(saveAsFileName('裸文件名.ERB')).toBe('裸文件名.ERB');
    expect(saveAsFileName('')).toBe('');
  });
});

/* ============================ C · writeSaveAsBytes 编码保真 ============================ */

/** 记账假 io：每个动作留一条（kind, path）轨迹；字节全由 encodeForSave 造 */
function spyIo(over: Partial<SaveAsExecIo> = {}) {
  const calls: string[] = [];
  const produced = new Uint8Array([1, 2, 3, 250]);
  const io: SaveAsExecIo = {
    exists: vi.fn(async () => false),
    writeBytes: vi.fn(async (p: string) => { calls.push(`writeBytes:${p}`); }),
    encodeForSave: vi.fn(async (p: string) => { calls.push(`encodeForSave:${p}`); return produced; }),
    adoptEncoding: vi.fn((p: string) => { calls.push(`adoptEncoding:${p}`); }),
    backup: vi.fn(async (p: string) => { calls.push(`backup:${p}`); return 'backup-ok'; }),
    forgetPathCaches: vi.fn((p: string) => { calls.push(`forgetPathCaches:${p}`); }),
    ...over,
  };
  return { io, calls, produced };
}

describe('另存为 · writeSaveAsBytes 编码保真（不退化 writeText 默认编码）', () => {
  it('落盘字节 === encodeForSave 的产物；编码判据以**源路径**算、以**落点字节**立；旧键判据退役', async () => {
    const { io, calls, produced } = spyIo();
    await writeSaveAsBytes(io, { from: CUR, to: IN_DOMAIN, text: '正文', encoding: 'shift_jis', overwrite: false });
    expect(io.encodeForSave).toHaveBeenCalledWith(CUR, '正文', 'shift_jis');
    expect(io.writeBytes).toHaveBeenCalledWith(IN_DOMAIN, produced);
    expect(io.adoptEncoding).toHaveBeenCalledWith(IN_DOMAIN, 'shift_jis', produced);
    expect(io.forgetPathCaches).toHaveBeenCalledWith(CUR);
    expect(calls.join(',')).toBe(
      'encodeForSave:C:\\作者区\\口上\\原文件.ERB,writeBytes:C:\\作者区\\口上\\新位置.ERB,adoptEncoding:C:\\作者区\\口上\\新位置.ERB,forgetPathCaches:C:\\作者区\\口上\\原文件.ERB',
    );
  });

  it('缺 encodeForSave / adoptEncoding ⇒ 抛「缺能力」人话，一个字节都不写（绝不静默退回 writeText）', async () => {
    const a = spyIo({ encodeForSave: undefined });
    await expect(writeSaveAsBytes(a.io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: false }))
      .rejects.toThrow(/缺 encodeForSave \/ adoptEncoding/);
    expect(a.io.writeBytes).not.toHaveBeenCalled();
    const b = spyIo({ adoptEncoding: undefined });
    await expect(writeSaveAsBytes(b.io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: false }))
      .rejects.toThrow(/缺 encodeForSave \/ adoptEncoding/);
    expect(b.io.writeBytes).not.toHaveBeenCalled();
  });

  it('覆盖分支：先 backup(to) 再写；备份抛 ⇒ 不盖（file-ops-exec 同一条覆盖纪律）；无备份通道 ⇒ 停手', async () => {
    const { io, calls } = spyIo();
    await writeSaveAsBytes(io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: true });
    expect(io.backup).toHaveBeenCalledWith(IN_DOMAIN);
    expect(calls).toEqual([
      'encodeForSave:C:\\作者区\\口上\\原文件.ERB',
      'backup:C:\\作者区\\口上\\新位置.ERB',
      'writeBytes:C:\\作者区\\口上\\新位置.ERB',
      'adoptEncoding:C:\\作者区\\口上\\新位置.ERB',
      'forgetPathCaches:C:\\作者区\\口上\\原文件.ERB',
    ]);
    const boom = spyIo({ backup: vi.fn(async () => { throw new Error('本地历史写不进'); }) });
    await expect(writeSaveAsBytes(boom.io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: true }))
      .rejects.toThrow('本地历史写不进');
    expect(boom.io.writeBytes).not.toHaveBeenCalled();
    const noBackup = spyIo({ backup: undefined });
    await expect(writeSaveAsBytes(noBackup.io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: true }))
      .rejects.toThrow(/本地历史/);
    expect(noBackup.io.writeBytes).not.toHaveBeenCalled();
    // 非覆盖不立备份（新落点没有可丢的东西）
    const fresh = spyIo();
    await writeSaveAsBytes(fresh.io, { from: CUR, to: IN_DOMAIN, text: 't', encoding: 'utf-8', overwrite: false });
    expect(fresh.io.backup).not.toHaveBeenCalled();
  });
});

/* ============================ D · runSaveAsFlow 编排 ============================ */

function flowDeps(opts: {
  pickResult?: string | null;
  pickThrows?: Error;
  existsOnDisk?: boolean;
  writeFails?: boolean;
  dialogConfirmsOverwrite?: boolean;
  readSource?: SaveAsFlowDeps['readSource'];
  confirmOverwrite?: SaveAsFlowDeps['confirmOverwrite'];
  /** 让判定用的四枚事实里指定那一枚抛错（真壳实拍：web 宿对域外落点 `io.exists` 会抛） */
  factBoom?: 'isWritable' | 'hostBlocked' | 'hasLiveBuffer' | 'exists';
} = {}) {
  const { io, calls } = spyIo();
  if (opts.existsOnDisk) io.exists = vi.fn(async () => true);
  if (opts.writeFails) io.writeBytes = vi.fn(async () => { throw new Error('写不进'); });
  if (opts.factBoom === 'exists') io.exists = vi.fn(async () => { throw new Error('exists 读不出'); });

  const notices: { kind: string; message: string }[] = [];
  const transferred: { from: string; to: string; clean: boolean }[] = [];
  const deps: SaveAsFlowDeps = {
    currentPath: CUR,
    io,
    pick: opts.pickThrows
      ? vi.fn(async (): Promise<string | null> => { throw opts.pickThrows; })
      : vi.fn(async (): Promise<string | null> => ('pickResult' in opts ? opts.pickResult : IN_DOMAIN) ?? null),
    isWritable: (p) => p !== OUT_DOMAIN,
    hostBlocked: () => false,
    hasLiveBuffer: () => false,
    readSource: opts.readSource ?? vi.fn(() => ({ text: '正文', encoding: 'shift_jis', version: 7 })),
    saveCurrent: vi.fn(async () => true),
    onTransferred: (from, to, clean) => { transferred.push({ from, to, clean }); },
    notify: (kind, message) => { notices.push({ kind, message }); },
    dialogConfirmsOverwrite: opts.dialogConfirmsOverwrite ?? true,
    ...(opts.confirmOverwrite === undefined ? {} : { confirmOverwrite: opts.confirmOverwrite }),
  };
  if (opts.factBoom === 'isWritable') deps.isWritable = () => { throw new Error('isWritable 读不出'); };
  if (opts.factBoom === 'hostBlocked') deps.hostBlocked = () => { throw new Error('hostBlocked 读不出'); };
  if (opts.factBoom === 'hasLiveBuffer') deps.hasLiveBuffer = () => { throw new Error('hasLiveBuffer 读不出'); };
  return { deps, io, calls, notices, transferred };
}

describe('另存为 · runSaveAsFlow 编排（判定拒了/取消了 ⇒ 一个 IO 写动作都不发）', () => {
  it('取消：pick 回 null ⇒ cancelled，写盘/转档/通知全部零动作', async () => {
    const { deps, calls, transferred, notices } = flowDeps({ pickResult: null });
    expect(await runSaveAsFlow(deps)).toEqual({ kind: 'cancelled' });
    expect(calls.filter((c) => c.startsWith('writeBytes'))).toEqual([]);
    expect(transferred).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('同路径分支 ⇒ 转普通保存链（saveCurrent），不发另存写盘', async () => {
    const { deps, calls, transferred } = flowDeps({ pickResult: CUR });
    expect(await runSaveAsFlow(deps)).toEqual({ kind: 'saved-current' });
    expect(deps.saveCurrent).toHaveBeenCalled();
    expect(calls.some((c) => c.startsWith('writeBytes'))).toBe(false);
    expect(transferred).toEqual([]);
  });

  it('域外拒绝 ⇒ rejected + 上屏的那句人话点名『导出』；转档零发生', async () => {
    const { deps, calls, transferred, notices } = flowDeps({ pickResult: OUT_DOMAIN });
    const r = await runSaveAsFlow(deps);
    expect(r.kind).toBe('rejected');
    expect(calls.some((c) => c.startsWith('writeBytes'))).toBe(false);
    expect(transferred).toEqual([]);
    expect(notices[0]).toMatchObject({ kind: 'error', message: SAVE_AS_OUT_OF_DOMAIN_MESSAGE });
  });

  it('判定事实读不出来（四枚里任何一枚抛错）⇒ fail-closed：出声 + 零写盘 + 零转档', async () => {
    // 真壳实拍的那条形状：作者在 web 宿里按「另存为…」、选了一个写不进去的位置，
    // `io.exists` 对域外落点抛错 ⇒ 改前整条流被 `ProjectView` 那发 `void onSaveAs()`
    // 吞成未处理 rejection，**屏上一个字都不出现**（铁律 4「内核不静默」直接违掉）。
    // 现在四枚事实里任何一枚抛错都必须换成一句人话，且一个字节都不落。
    for (const boom of ['isWritable', 'hostBlocked', 'hasLiveBuffer', 'exists'] as const) {
      const { deps, calls, transferred, notices } = flowDeps({ factBoom: boom });
      const r = await runSaveAsFlow(deps);
      expect([boom, r.kind]).toEqual([boom, 'failed']);
      expect([boom, notices.length]).toEqual([boom, 1]);
      expect(notices[0]!.kind).toBe('error');
      expect(notices[0]!.message).toContain(`${boom} 读不出`);
      expect(notices[0]!.message).toContain('一个字节都没写');
      expect(notices[0]!.message).toContain('导出'); // 出路要点名，不许只说"失败了"
      expect(calls.some((c) => c.startsWith('writeBytes'))).toBe(false);
      expect(transferred).toEqual([]);
    }
  });

  it('对话框途中被关（readSource undefined）⇒ failed，不弹框不写盘', async () => {
    const { deps } = flowDeps({ readSource: () => undefined });
    expect(await runSaveAsFlow(deps)).toEqual({ kind: 'failed', message: '标签已不在编辑器中' });
    expect(deps.pick).not.toHaveBeenCalled();
  });

  it('注入缝 + 盘上已有 ⇒ confirm-overwrite：拒绝确认则目标原样零写；确认则走同一条落盘腿（覆盖前 backup）', async () => {
    const no = flowDeps({ existsOnDisk: true, dialogConfirmsOverwrite: false, confirmOverwrite: vi.fn(async () => false) });
    const rNo = await runSaveAsFlow(no.deps);
    expect(rNo).toEqual({ kind: 'cancelled' });
    expect(no.io.writeBytes).not.toHaveBeenCalled();
    expect(no.notices[0]!.message).toContain('目标文件原样没动');

    const yes = flowDeps({ existsOnDisk: true, dialogConfirmsOverwrite: false, confirmOverwrite: vi.fn(async () => true) });
    expect(await runSaveAsFlow(yes.deps)).toEqual({ kind: 'saved-as', target: IN_DOMAIN });
    expect(yes.deps.confirmOverwrite).toHaveBeenCalledWith(IN_DOMAIN);
    expect(yes.io.backup).toHaveBeenCalledWith(IN_DOMAIN);
    expect(yes.transferred).toEqual([{ from: CUR, to: IN_DOMAIN, clean: true }]);
  });

  it('竞态守卫：写窗口内版本变了 ⇒ 转档照做但 clean=false（标签保持脏，与保存链 kept-dirty 同口径）', async () => {
    let reads = 0;
    const { deps, transferred, notices } = flowDeps({
      // 每次读数版本都在涨：落盘读到的 source(v2) 与落盘后的 after(v3) 不齐 ⇒ 判脏
      readSource: vi.fn(() => ({ text: '正文', encoding: 'utf-8', version: ++reads })),
    });
    expect(await runSaveAsFlow(deps)).toEqual({ kind: 'saved-as', target: IN_DOMAIN });
    expect(transferred).toEqual([{ from: CUR, to: IN_DOMAIN, clean: false }]);
    expect(notices[0]!.message).toContain('仍标记未保存');
  });

  it('平台没有落点对话框（pick 抛）⇒ failed + 如实上屏「不会假装成功」；零写盘', async () => {
    const { deps, calls, notices } = flowDeps({
      pickThrows: new Error('当前平台没有另存为落点选择能力（需要桌面壳）'),
    });
    expect(await runSaveAsFlow(deps)).toEqual({
      kind: 'failed', message: '当前平台没有另存为落点选择能力（需要桌面壳）',
    });
    expect(calls).toEqual([]);
    expect(notices[0]!.message).toContain('落点对话框没有打开');
  });

  it('写盘失败 ⇒ failed + 上屏；转档零发生（没落成不许换键）', async () => {
    const { deps, transferred, notices } = flowDeps({ writeFails: true });
    expect(await runSaveAsFlow(deps)).toEqual({ kind: 'failed', message: '写不进' });
    expect(transferred).toEqual([]);
    expect(notices[0]).toMatchObject({ kind: 'error' });
    expect(notices[0]!.message).toContain('另存为失败');
  });
});

/* ============================ E · 七处路径键登记随迁（全链） ============================ */

/* ---- ① 池：pool / baseLru / coldLru 三本账换键（纯池，注入假件） ---- */

interface FakeModel {
  value: string;
  disposed: boolean;
  version: number;
  listeners: (() => void)[];
  onDidChangeContent(cb: () => void): { dispose(): void };
  getValue(): string;
  getValueLength(): number;
  getAlternativeVersionId(): number;
  dispose(): void;
}

function makeFakeModel(value: string): FakeModel {
  const m: FakeModel = {
    value,
    disposed: false,
    version: 1,
    listeners: [],
    onDidChangeContent(cb) {
      m.listeners.push(cb);
      return { dispose: () => { m.listeners = m.listeners.filter((l) => l !== cb); } };
    },
    getValue: () => m.value,
    getValueLength: () => m.value.length,
    getAlternativeVersionId: () => m.version,
    dispose: () => { m.disposed = true; },
  };
  return m;
}

/** 往假 model「写正文」并触发内容监听（程序性改写的注入缝） */
function editModel(m: FakeModel, value: string): void {
  m.value = value;
  m.version += 1;
  for (const l of [...m.listeners]) l();
}

function poolHarness(files: Record<string, string>) {
  const created: FakeModel[] = [];
  const writes: { path: string; text: string }[] = [];
  const writeText = vi.fn(async (_k: unknown, p: string, text: string) => {
    writes.push({ path: p, text });
  });
  const deps: PoolDeps = {
    readText: vi.fn(async (_k: unknown, p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return { text: files[p]!, encoding: 'utf-8', eol: 'LF' };
    }),
    createModel: vi.fn((_p: string, text: string) => {
      const m = makeFakeModel(text);
      created.push(m);
      return m as unknown as import('../src/monaco/entry').editor.ITextModel;
    }),
    modelUnits: (m) => (m as unknown as FakeModel).getValueLength(),
    modelVersion: (m) => (m as unknown as FakeModel).getAlternativeVersionId(),
    writeText,
    warn: () => undefined,
  };
  const kernel = { bus: { on: () => ({ dispose(): void {} } as never) } } as never;
  return { pool: createEditorModelPool(deps), created, writes, writeText, deps, kernel };
}

describe('另存为 · ① 池转档：pool/baseLru/coldLru 三本账逐条换键，旧键在每一处彻底消失', () => {
  const OLD = 'C:\\作者区\\口上\\原.ERB';
  const NEW = 'C:\\作者区\\口上\\新.ERB';

  it('活动件换键：同一份 model 原地续命（refs/baseline/savedBase/stats 随迁）', async () => {
    const h = poolHarness({ [OLD]: '正文' });
    const e = await h.pool.acquire(h.kernel, OLD);
    h.pool.setBaseline(OLD, 3);
    h.pool.setSavedBase(OLD, 'BASE');
    const before = h.pool.stats();
    expect(h.pool.retargetPath(OLD, NEW)).toBe(true);
    // 新键读数全对
    expect(h.pool.liveModel(NEW)).toBe(e.model);
    expect(h.pool.refCount(NEW)).toBe(1);
    expect(h.pool.baseline(NEW)).toBe(3);
    expect(h.pool.savedBase(NEW)).toBe('BASE'); // baseLru 键随迁（读数=基线本体）
    const after = h.pool.stats();
    expect(after).toEqual(before); // 三本账计数分毫不动（搬账不造账）
    // 旧键彻底消失：重 acquire 走**重读盘**（新建 model，不是找回原那份）
    expect(h.pool.refCount(OLD)).toBe(0);
    expect(h.pool.liveModel(OLD)).toBeUndefined();
    expect(h.pool.baseline(OLD)).toBeUndefined();
    expect(h.pool.savedBase(OLD)).toBeUndefined();
    const again = await h.pool.acquire(h.kernel, OLD);
    expect(again.model).not.toBe(e.model);
    expect(h.created).toHaveLength(2);
    // 同一路径再换自己 ⇒ 没搬（false），账不自己踩自己
    expect(h.pool.retargetPath(NEW, NEW)).toBe(false);
  });

  it('落点站着**活着的**记录 ⇒ 拒绝换键（绝不吞掉别人正编辑的账）', async () => {
    const h = poolHarness({ [OLD]: '原', [NEW]: '新' });
    await h.pool.acquire(h.kernel, OLD);
    await h.pool.acquire(h.kernel, NEW);
    expect(h.pool.retargetPath(OLD, NEW)).toBe(false);
    expect(h.pool.refCount(NEW)).toBe(1);
    expect(h.pool.refCount(OLD)).toBe(1);
  });

  it('冷档件换键：coldLru 键随迁 + 补写盘 listener 重挂到新路径（旧闭包钉旧路径 = 数据事故）', async () => {
    const h = poolHarness({ [OLD]: 'cold-body' });
    const e = await h.pool.acquire(h.kernel, OLD);
    h.pool.setBaseline(OLD, e.model.getAlternativeVersionId()); // 干净件（版本与基线对齐）才有冷档资格
    h.pool.release(OLD);
    expect(h.pool.stats().coldModels).toBe(1);
    expect(h.pool.liveModel(OLD)).toBeUndefined(); // 只答活面
    expect(h.pool.retargetPath(OLD, NEW)).toBe(true);
    // 冷档账随迁的证据①：复活 NEW 拿回的是**同一份 model**（零重读盘）
    const revived = await h.pool.acquire(h.kernel, NEW);
    expect(revived.model).toBe(e.model);
    expect(h.deps.readText).toHaveBeenCalledTimes(1); // 只有 OLD 那一次
    h.pool.release(NEW);
    // 证据②：冷档期程序性改写 ⇒ 补写盘落在**新路径**（旧监听若没重挂会往 OLD 写）
    const m = e.model as unknown as FakeModel;
    editModel(m, '程序改写后的正文');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.writes.some((w) => w.path === NEW && w.text === '程序改写后的正文')).toBe(true);
    expect(h.writes.some((w) => w.path === OLD)).toBe(false);
    // 证据③：换键后 OLD 再 acquire 必然重读盘（旧键三本账全空）
    const fromOld = await h.pool.acquire(h.kernel, OLD);
    expect(fromOld.model).not.toBe(e.model);
    expect(h.deps.readText).toHaveBeenCalledTimes(2);
  });
});

/* ---- ②③ dirtyPaths / pinnedPaths、④ journal、⑥ 编码缓存、⑦ 组态 ---- */

describe('另存为 · ⑦ 组态随迁（migrateGroupPathsAfterSaveAs 纯函数）', () => {
  const OLD = 'C:\\作者区\\a.ERB';
  const NEW = 'C:\\作者区\\b.ERB';

  it('tabs/active/preview 三处逐条换键；旧路径整树消失', () => {
    const state: EditorGroupsState = {
      orientation: 'row', activeGroupId: 'g1',
      groups: [
        { id: 'g1', tabs: [OLD, 'C:\\作者区\\c.ERB'], active: OLD, preview: OLD },
        { id: 'g2', tabs: ['C:\\作者区\\d.ERB'], active: 'C:\\作者区\\d.ERB', preview: null },
      ],
    };
    const next = migrateGroupPathsAfterSaveAs(state, OLD, NEW);
    expect(next.groups[0]!.tabs).toEqual([NEW, 'C:\\作者区\\c.ERB']);
    expect(next.groups[0]!.active).toBe(NEW);
    expect(next.groups[0]!.preview).toBe(NEW);
    const flat = JSON.stringify(next);
    expect(flat).not.toContain(OLD); // 旧路径彻底消失
    expect(next.groups[1]).toBe(state.groups[1]); // 未命中的组同一引用（不给 React 造无谓重渲）
    expect(migrateGroupPathsAfterSaveAs(state, 'C:\\不存在.ERB', NEW)).toBe(state);
  });

  it('精确匹配不走前缀：目录改名不在本函数职责内（那是 rename 链路的 mapRenamedPath）', () => {
    const state: EditorGroupsState = {
      orientation: 'row', activeGroupId: 'g1',
      groups: [{ id: 'g1', tabs: ['C:\\作者区\\旧目录\\a.ERB'], active: 'C:\\作者区\\旧目录\\a.ERB', preview: null }],
    };
    // from 给目录前缀 ⇒ 一枚都不换（另存为只搬这一份文件的键）
    expect(migrateGroupPathsAfterSaveAs(state, 'C:\\作者区\\旧目录', 'C:\\作者区\\新目录')).toBe(state);
  });
});

describe('另存为 · ②③ dirtyPaths / pinnedPaths 随迁（App 用的同一枚 reconcile）', () => {
  const OLD = 'C:\\作者区\\a.ERB';
  const NEW = 'C:\\作者区\\b.ERB';

  it('脏点与固定态逐条换键：旧路径不留悬空 pin / 幽灵脏点', () => {
    const dirty = new Set([OLD, 'C:\\作者区\\c.ERB']);
    const next = reconcilePathsAfterDiskChange(dirty, [], [{ from: OLD, to: NEW }]);
    expect(next.has(NEW)).toBe(true);
    expect(next.has(OLD)).toBe(false);
    expect(next.size).toBe(2);
    const pinned = new Set([OLD]);
    const nextPinned = reconcilePathsAfterDiskChange(pinned, [], [{ from: OLD, to: NEW }]);
    expect(nextPinned.has(NEW)).toBe(true);
    expect(nextPinned.has(OLD)).toBe(false);
  });
});

describe('另存为 · ④ autosave-journal entries 随迁（键原样不归一）', () => {
  it('转档后的重快照以新路径为键；旧键**彻底消失**；manifest 键逐字不改写', async () => {
    const mem = new Map<string, string>();
    const io: JournalIo = {
      readTextFile: async (p) => mem.get(p),
      writeTextFile: async (p, t) => { mem.set(p, t); },
      removeFile: async (p) => { mem.delete(p); },
    };
    const journal = new AutosaveJournal(io, 'X:\\appdata\\journal');
    // 旧键原样（大小写/分隔符混写）——entries 的键**不许**被归一
    const oldRaw = 'C:\\作者区\\MixedCase.ERB';
    const newRaw = 'c:/作者区/新位置.erb';
    await journal.snapshot('C:\\作者区', [{ path: oldRaw, text: 'T', encoding: 'utf-8', eol: 'LF' }]);
    const first = parseManifest(await io.readTextFile('X:\\appdata\\journal\\manifest.json'));
    expect(Object.keys(first.entries)).toEqual([oldRaw]); // 原样不归一
    // 转档腿（App.onTransferred 的同一条）：pane 换键后 records 带的是**新路径** ⇒ 全量重建
    await journal.snapshot('C:\\作者区', [{ path: newRaw, text: 'T2', encoding: 'utf-8', eol: 'LF' }]);
    const second = parseManifest(await io.readTextFile('X:\\appdata\\journal\\manifest.json'));
    expect(Object.keys(second.entries)).toEqual([newRaw]); // 旧键彻底消失
    expect(second.entries[newRaw]!.file).toBe(snapshotFileName(newRaw));
  });
});

/* ============================ 全链（真内核 io + 临时盘） ============================ */

async function bufferFlow(over: {
  text: string;
  encoding: FileEncoding;
  /** 对话框候选落点的**文件名**（落目录由 targetDir 定）；`null` = 缺省应答可再覆写 */
  candidate: string | null;
  writable?: string[];
  targetDir: (dirs: { dir: string; outside: string }) => string;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-saveas-'));
  // 域外目录必须**不在** writable 根之下（同级临时目录，Windows 上不在 dir 内）
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-saveas-out-'));
  const appData = path.join(dir, 'appdata');
  const io = new FileIOServiceImpl(new NodeBridge(appData));
  io.setWritableRoots(over.writable ?? [dir]);
  const notices: { kind: string; message: string }[] = [];
  const versionBox = { v: 7 };
  const target = over.candidate === null ? null : path.join(over.targetDir({ dir, outside }), over.candidate);
  const deps: SaveAsFlowDeps = {
    currentPath: path.join(dir, '原.ERB'),
    io,
    pick: async () => target,
    isWritable: (p) => io.isWritable(p),
    hostBlocked: () => false,
    hasLiveBuffer: () => false,
    readSource: () => ({ text: over.text, encoding: over.encoding, version: versionBox.v }),
    saveCurrent: async () => false,
    onTransferred: () => undefined,
    notify: (kind, message) => { notices.push({ kind, message }); },
    dialogConfirmsOverwrite: true,
  };
  return { dir, outside, appData, io, deps, notices, versionBox, target };
}

describe('另存为 · 全链七处登记随迁（真内核 io + 真池 + 真 journal，注入缝替对话框）', () => {
  it('Proceed 全链：七处旧键全消、新键读数正确、**原盘文件 md5 逐字节不变**、新盘字节 === encodeForSave 产物', async () => {
    const body = '@K\r\nPRINTFORML 另存为保真测试\r\n';
    const f = await bufferFlow({
      text: body, encoding: 'shift_jis', candidate: '新位置.ERB',
      targetDir: ({ dir }) => dir,
    });
    const oldPath = f.deps.currentPath;
    const newPath = f.target!;
    await f.io.writeText(oldPath, body); // 先立原件（utf-8 落盘）
    await f.io.readText(oldPath); // 进编码/字节缓存（原件判据在册）

    // —— 各登记处的真身（与 App.onTransferred 逐处同枚函数）——
    const pool = poolHarness({ [oldPath]: body });
    const entry = await pool.pool.acquire(pool.kernel, oldPath);
    pool.pool.setBaseline(oldPath, 3);
    pool.pool.setSavedBase(oldPath, 'BASE');
    const dirtyBox: { nextDirty: ReadonlySet<string>; nextPinned: ReadonlySet<string> } = {
      nextDirty: new Set<string>(), nextPinned: new Set<string>(),
    };
    const mem = new Map<string, string>();
    const journalIo: JournalIo = {
      readTextFile: async (p) => mem.get(p),
      writeTextFile: async (p, t) => { mem.set(p, t); },
      removeFile: async (p) => { mem.delete(p); },
    };
    const journal = new AutosaveJournal(journalIo, 'X:\\journal');
    await journal.snapshot(f.dir, [{ path: oldPath, text: body, encoding: 'shift_jis', eol: 'CRLF' }]);
    let groupsState: EditorGroupsState = {
      orientation: 'row', activeGroupId: 'g1',
      groups: [{ id: 'g1', tabs: [oldPath], active: oldPath, preview: null }],
    };
    const groupsSeen: string[] = [];
    const transferred: { from: string; to: string; clean: boolean }[] = [];
    // 初始两枚真 Set 也过一遍同一枚 reconcile（App 传的是 prev 集合，这里等价的单元素集）
    const r0d = reconcilePathsAfterDiskChange(new Set([oldPath]), [], []);
    expect(r0d.has(oldPath)).toBe(true);

    const expectedBytes = await f.io.encodeForSave(oldPath, body, 'shift_jis');
    const md5Of = async (p: string): Promise<string> =>
      createHash('md5').update(await fs.readFile(p)).digest('hex');
    const md5Before = await md5Of(oldPath);

    const r = await runSaveAsFlow({
      ...f.deps,
      onTransferred: async (from, to, clean) => {
        // ① 池记录换键（App 走 retargetSavedAsPath——池侧同判据：retargetPath + 语言重判）
        expect(pool.pool.retargetPath(from, to)).toBe(true);
        // ②③ 脏态/固定态（App 用同一枚 reconcile，moves = [{from,to}]）
        dirtyBox.nextDirty = reconcilePathsAfterDiskChange(new Set([from]), [], [{ from, to }]);
        dirtyBox.nextPinned = reconcilePathsAfterDiskChange(new Set([from]), [], [{ from, to }]);
        // ④ journal 重快照（pane 换键后 records 带新路径）
        await journal.snapshot(f.dir, [{ path: to, text: body, encoding: 'shift_jis', eol: 'CRLF' }]);
        // ⑥ 编码缓存清旧键（forgetPathCaches 由 writeSaveAsBytes 也调——这里显式再清一次等价）
        f.io.forgetPathCaches!(from);
        // ⑦ 组态随迁
        groupsState = migrateGroupPathsAfterSaveAs(groupsState, from, to);
        groupsSeen.push(to);
        transferred.push({ from, to, clean });
      },
    });
    expect(r).toEqual({ kind: 'saved-as', target: newPath });

    // —— 屏上回执（人话 + 转档语义）——
    expect(f.notices[0]!.kind).toBe('info');
    expect(f.notices[0]!.message).toContain('编辑已转到新路径继续');
    expect(f.notices[0]!.message).toContain('原文件一个字节未动');

    // ① 池：新键读数全对、旧键三本账全空
    expect(pool.pool.liveModel(newPath)).toBe(entry.model);
    expect(pool.pool.refCount(newPath)).toBe(1);
    expect(pool.pool.baseline(newPath)).toBe(3);
    expect(pool.pool.savedBase(newPath)).toBe('BASE');
    expect(pool.pool.savedBase(oldPath)).toBeUndefined();
    expect(pool.pool.refCount(oldPath)).toBe(0);

    // ②③ dirty/pinned：旧路径彻底消失、新路径在册
    expect(dirtyBox.nextDirty.has(newPath)).toBe(true);
    expect(dirtyBox.nextDirty.has(oldPath)).toBe(false);
    expect(dirtyBox.nextPinned.has(newPath)).toBe(true);
    expect(dirtyBox.nextPinned.has(oldPath)).toBe(false);

    // ④ journal：entries 只剩新键（键原样不归一由上一条 describe 单独钉）
    const jm = parseManifest(await journalIo.readTextFile('X:\\journal\\manifest.json'));
    expect(Object.keys(jm.entries)).toEqual([newPath]);

    // ⑤ EditorPane 三张 ref 账：闭包无挂载设施 ⇒ 源码形态钉（editor-pane-dataflow 先例）
    const pane = readSource('packages/app/src/ui/EditorPane.tsx');
    const body5 = sliceFn(pane, 'transferBuffer');
    expect(body5).toContain('selfWriteAtRef.current.delete(fromKey)');
    expect(body5).toContain('selfWriteAtRef.current.set(pathKey(to)');
    expect(body5).toContain('externalConflictRef.current.delete(resolvedFrom)');
    expect(body5).toContain('externalConflictRef.current.add(to)');
    expect(body5).toContain('autosaveFailedRef.current.delete(resolvedFrom)');
    expect(body5).toContain('autosaveFailedRef.current.add(to)');
    expect(body5).toContain('entriesRef.current.delete(resolvedFrom)');
    expect(body5).toContain('entriesRef.current.set(to, entry)');
    // 换键后监听必须经**同一份工厂**重挂到新路径（旧闭包钉旧路径 = 把新编辑报成旧路径的脏）
    expect(body5).toContain('makeDirtyListener(entry.model, to)');
    // 竞态口径：clean 立基线、不 clean 只报脏不立基线
    expect(body5).toMatch(/if \(clean\) \{\s*markSaved\(to, entry\);/);

    // ⑥ 内核 encodingCache：旧键判据全退役、新键判据按落点真相在册
    expect(f.io.encodingOf!(oldPath)).toBeUndefined();
    expect(f.io.encodingOf!(newPath)).toBe('shift_jis');

    // ⑦ 组态：tabs 只剩新路径
    expect(groupsState.groups[0]!.tabs).toEqual([newPath]);
    expect(groupsState.groups[0]!.active).toBe(newPath);
    expect(groupsSeen).toEqual([newPath]);
    expect(JSON.stringify(groupsState)).not.toContain(oldPath);

    // 盘上真相：**原件 md5 逐字节不变**；新件字节 === encodeForSave 产物（编码保真，非 utf-8 退化）
    expect(await md5Of(oldPath)).toBe(md5Before);
    const writtenBytes = await fs.readFile(newPath);
    expect(Buffer.from(writtenBytes).equals(Buffer.from(expectedBytes))).toBe(true);
    expect(writtenBytes.length).toBeGreaterThan(0);
    // 转档发生一次，且 clean=true（写窗口内无新输入）
    expect(transferred).toEqual([{ from: oldPath, to: newPath, clean: true }]);
  });

  it('换扩展名 .kojo↔.kojo2：语言面重判被调到的接线（retargetSavedAsPath 形态钉；判据本体见 kojo2-model-language.test.ts）', () => {
    const src = readSource('packages/app/src/ui/editor-model-pool-instance.ts');
    const start = src.indexOf('export function retargetSavedAsPath');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('\n}', start));
    // 先池换键、没命中就短路 false（账没搬成不许重判）
    expect(body).toContain('if (!editorModelPool.retargetPath(fromPath, nextPath)) return false;');
    // 随后按**新路径**立即重判（不等防抖——那一刻作者是停手的）
    expect(body).toContain('liveModel(nextPath)');
    expect(body).toContain('kojo2ModelLanguage.retarget(model as unknown as Kojo2LanguageModelLike, nextPath)');
  });

  it('域外落点（游戏根形态：写允许域之外的目录）在**对话框之后**被拒死：零写、原件不动、目标目录仍空', async () => {
    const f = await bufferFlow({
      text: 'x', encoding: 'utf-8', candidate: '偷放.ERB',
      targetDir: ({ outside }) => outside, // writable 只有 dir ⇒ outside 域外
    });
    const oldPath = f.deps.currentPath;
    await f.io.writeText(oldPath, 'x');
    const md5Before = createHash('md5').update(await fs.readFile(oldPath)).digest('hex');
    const r = await runSaveAsFlow(f.deps);
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toBe(SAVE_AS_OUT_OF_DOMAIN_MESSAGE);
    expect(await fs.readdir(f.outside)).toEqual([]);
    expect(createHash('md5').update(await fs.readFile(oldPath)).digest('hex')).toBe(md5Before);
  });

  it('isWritable 谎报放行 ⇒ 内核双闸（writeBytes 内 assertWritable）兜底：failed 人话上屏，池/账目一律不动，域外零文件', async () => {
    const f = await bufferFlow({
      text: 'x', encoding: 'utf-8', candidate: '外.ERB',
      targetDir: ({ outside }) => outside,
    });
    const oldPath = f.deps.currentPath;
    await f.io.writeText(oldPath, 'x');
    let transferredCount = 0;
    f.deps.onTransferred = () => { transferredCount += 1; };
    f.deps.isWritable = () => true; // 谎报第一道闸——第二道闸必须仍拒
    const r = await runSaveAsFlow(f.deps);
    expect(r.kind).toBe('failed');
    expect(f.notices.some((n) => n.kind === 'error')).toBe(true);
    expect(transferredCount).toBe(0);
    expect(await fs.readdir(f.outside)).toEqual([]);
  });
});

/* ============================ F · 接线形状（索引 / 命令入口 / 懒半） ============================ */

describe('另存为 · 接线形状', () => {
  it('索引通知是「盘上新增一个文件」不是 rename：delta 只有 changed:[to]，绝不复用成对迁移', () => {
    const app = readSource('packages/app/src/ui/App.tsx');
    const body = sliceFn(app, 'saveAs');
    expect(body).toContain('delta: { changed: [to] }');
    expect(body).not.toMatch(/delta:[^}]*renamed/); // 成对迁移（from→to）不属于另存为
    // 文件历史/树那侧收到的是 changed（新增入账），不是 renamed/gone——原路径还在盘上
    expect(body).toContain('syncErbIndexAfterDiskChange');
  });

  it('App 的转档收尾逐处点名：retargetSavedAsPath → transferBuffer（每组句柄）→ 组态 → dirty/pinned → journal snapshots()', () => {
    const app = readSource('packages/app/src/ui/App.tsx');
    const body = sliceFn(app, 'saveAs');
    expect(body).toContain('retargetSavedAsPath(from, to)');
    expect(body).toContain('a.transferBuffer(from, to, clean)');
    expect(body).toContain('migrateGroupPathsAfterSaveAs(prev, from, to)');
    expect(body).toContain('setDirtyPaths((prev) => reconcilePathsAfterDiskChange(prev, [], [{ from, to }]))');
    expect(body).toContain('setPinnedPaths((prev) => reconcilePathsAfterDiskChange(prev, [], [{ from, to }]))');
    expect(body).toContain('a.snapshots()'); // journal 真相源 = pane 换键后的快照
  });

  it('命令入口：workbench.saveAs 注册在 ProjectView 壳层命令表（run 落 onSaveAs），App 把 saveAs 递进树；键位登记在懒半（开机图不吃字节）', () => {
    const pv = readSource('packages/app/src/ui/ProjectView.tsx');
    expect(pv).toContain("id: 'workbench.saveAs'");
    expect(pv).toContain('effectiveKeybindingOf(\'workbench.saveAs\')');
    expect(pv).toMatch(/run: \(\) => \{\s*void onSaveAs\(\);/);
    const app = readSource('packages/app/src/ui/App.tsx');
    expect(app).toContain('onSaveAs={saveAs}');
    // 键位表：懒半登记（ps10 文件闸顶格，命令登记不许进开机图）
    const lazy = readSource('packages/app/src/ui/keybinding-specs-commands.ts');
    expect(lazy).toContain("id: 'workbench.saveAs'");
    const eager = readSource('packages/app/src/ui/keybinding-specs.ts');
    expect(eager).not.toContain('workbench.saveAs');
  });

  it('写盘不换通道：对话框命令 pick_save_path 只交回路径（Rust/桥/内核三层零写盘动作），落盘仍走带闸 io', () => {
    const rust = readSource('packages/app/src-tauri/src/lib.rs');
    const pick = rust.slice(rust.indexOf('async fn pick_save_path'));
    const fnBody = pick.slice(0, pick.indexOf('\n}\n') + 3);
    // 只弹对话框、交回路径：不 fs::write、不登记许可
    expect(fnBody).toContain('.save_file()');
    expect(fnBody).not.toMatch(/fs::write|std::fs|register_workspace_root|grant/);
    const bridge = readSource('packages/app/src/bridge/tauri-bridge.ts');
    expect(bridge).toContain("invoke<string | null>('pick_save_path'");
    const kern = readSource('packages/kernel/src/io.ts');
    expect(kern).toContain("throw new Error('当前平台没有另存为落点选择能力（需要桌面壳）')");
  });
});
