/**
 * Kojo 2.0 迁移向导 · 模型层判据（K2-EDITOR-MIGRATE-UI）。
 *
 * 全部走注入的假 io，钉六件事：
 * 1. dry-run 只读：预演不产生任何 write / backup 调用；
 * 2. unsupported 台账上屏：行号、原行文本、目标提示、诊断都在同一份计划里；
 * 3. 计划口径：编码 / EOL 一律 preserve，备份 + 回滚口令写明路径与版本位；
 * 4. 应用闭环：backup → write(preserve) → readback，三件事各一次且顺序正确；
 * 5. 失败不破坏源：写入抛错 / 回读不一致 / 备份恢复失败，都能回到迁移前文本；
 * 6. 批次 fail-closed：有阻断文件时默认一个字节都不写；显式 allowPartial 才动可迁移文件。
 */
import { describe, expect, it } from 'vitest';
import type {
  EolStyle,
  FileEncoding,
  TextFile,
  WriteTextOptions,
} from '@kojo/plugin-api';
import {
  applyMigratePlan,
  dryRunMigrateFiles,
  planMigrateFile,
  undoMigratePlan,
  type MigrateIoPort,
} from '../src/ui/kojo2-migrate-model';

/* ============================== 假 io ============================== */

type WriteFailure = 'none' | 'before' | 'corrupt-then-throw' | 'corrupt-silently';

interface FakeFile {
  text: string;
  encoding: FileEncoding;
  eol: EolStyle;
}

interface WriteCall {
  readonly path: string;
  readonly text: string;
  readonly opts: WriteTextOptions | undefined;
}

class FakeIo implements MigrateIoPort {
  readonly files = new Map<string, FakeFile>();
  readonly writes: WriteCall[] = [];
  readonly backups: Array<{ path: string; versionId: string }> = [];
  restoreCalls = 0;
  failRestore = false;

  private readonly backupContent = new Map<string, FakeFile>();
  private nextWriteFailure: WriteFailure = 'none';
  private backupSeq = 0;

  seed(path: string, text: string, encoding: FileEncoding = 'utf-8', eol: EolStyle = 'lf'): void {
    this.files.set(path, { text, encoding, eol });
  }

  /** 只让**下一次**写入失败（回滚那一次写入因此能成功） */
  failNextWrite(mode: Exclude<WriteFailure, 'none'>): void {
    this.nextWriteFailure = mode;
  }

  async readText(path: string): Promise<TextFile> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
    return { path, text: file.text, encoding: file.encoding, eol: file.eol, mtimeMs: null };
  }

  async writeText(path: string, text: string, opts?: WriteTextOptions): Promise<void> {
    const failure = this.nextWriteFailure;
    this.nextWriteFailure = 'none';
    this.writes.push({ path, text, opts });

    if (failure === 'before') throw new Error('磁盘已满');
    const previous = this.files.get(path);
    const next: FakeFile = {
      text,
      encoding: previous?.encoding ?? 'utf-8',
      eol: previous?.eol ?? 'lf',
    };
    if (failure === 'corrupt-then-throw') {
      this.files.set(path, { ...next, text: `${text}\u0000CORRUPT` });
      throw new Error('原子写失败');
    }
    if (failure === 'corrupt-silently') {
      this.files.set(path, { ...next, text: `${text}\u0000CORRUPT` });
      return;
    }
    this.files.set(path, next);
  }

  async backup(path: string): Promise<string | null> {
    const file = this.files.get(path);
    if (file === undefined) return null;
    this.backupSeq += 1;
    const versionId = `20260101-000000-${String(this.backupSeq).padStart(3, '0')}.bak`;
    this.backupContent.set(`${path}\u0000${versionId}`, { ...file });
    this.backups.push({ path, versionId });
    return `C:\\backup\\${versionId}`;
  }

  async restoreBackup(path: string, versionId: string): Promise<void> {
    this.restoreCalls += 1;
    if (this.failRestore) throw new Error('备份桶不可读');
    const snapshot = this.backupContent.get(`${path}\u0000${versionId}`);
    if (snapshot === undefined) throw new Error(`版本不存在：${versionId}`);
    this.files.set(path, { ...snapshot });
  }
}

/* ============================== 固定夹具 ============================== */

const FILE = 'C:\\proj\\a.kojo';
const V1 = '角色: 灵梦\n时机 指令 310：\n    「你好。」\n';
const V1_CODE = '# 机 指令 310\n灵梦：「你好。」\n';
const BAD = '角色: 灵梦\n时机 指令 310：\n    她的心情 = 1\n';

/* ============================== dry-run / 计划 ============================== */

describe('dry-run 计划：逐行 diff、编码/EOL 保留、备份回滚口令', () => {
  it('正例：v1 source + filePath → 迁移文本、diff 三态、preserve 写盘口径', () => {
    const plan = planMigrateFile({ filePath: FILE, source: V1, encoding: 'shift_jis', eol: 'crlf' });

    expect(plan.ok).toBe(true);
    expect(plan.error).toBeNull();
    expect(plan.changed).toBe(true);
    expect(plan.code).toBe(V1_CODE);
    expect(plan.write).toEqual({
      targetPath: FILE,
      encoding: 'preserve',
      eol: 'preserve',
      preWriteBackup: true,
    });
    expect(plan.sourceEncoding).toBe('shift_jis');
    expect(plan.sourceEol).toBe('crlf');
    expect(plan.diffText).toContain(`--- a/${FILE}`);
    expect(plan.diffText).toContain(`+++ b/${FILE}`);
    expect(plan.diffText).toContain('-角色: 灵梦');
    expect(plan.diffText).toContain('+# 机 指令 310');
    expect(plan.diffText).toContain('+灵梦：「你好。」');
    expect(plan.summary).toMatchObject({ ok: true, unsupportedCount: 0, addedLines: 2, removedLines: 3 });
  });

  it('备份 / 回滚口令：dry-run 阶段版本号为 null，回滚提示带文件路径与版本占位', () => {
    const plan = planMigrateFile({ filePath: FILE, source: V1 });

    expect(plan.backup.required).toBe(true);
    expect(plan.backup.versionId).toBeNull();
    expect(plan.backup.applyHint).toContain(FILE);
    expect(plan.backup.rollbackHint).toContain(FILE);
    expect(plan.backup.rollbackHint).toContain('<备份版本号>');
    expect(plan.backup.rollbackHint).toContain('restoreBackup');
  });

  it('already-2.0：幂等通过且 changed=false（应用时不会无意义改写）', () => {
    const plan = planMigrateFile({ filePath: FILE, source: V1_CODE });
    expect(plan.ok).toBe(true);
    expect(plan.code).toBe(V1_CODE);
    expect(plan.changed).toBe(false);
    expect(plan.summary.addedLines + plan.summary.removedLines).toBe(0);
  });
});

describe('dry-run · 禁止写盘（只读端口）', () => {
  it('dryRunMigrateFile 只调 readText；writes / backups 均为 0', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1, 'shift_jis', 'crlf');

    const run = await dryRunMigrateFiles(io, [FILE]);

    expect(run.ok).toBe(true);
    expect(run.files).toHaveLength(1);
    expect(run.files[0]?.sourceEncoding).toBe('shift_jis');
    expect(run.files[0]?.sourceEol).toBe('crlf');
    expect(io.writes).toHaveLength(0);
    expect(io.backups).toHaveLength(0);
    expect(io.restoreCalls).toBe(0);
  });

  it('读取失败只标记该文件，不抛整批；其余文件照常预演', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1);

    const run = await dryRunMigrateFiles(io, [FILE, 'C:\\proj\\missing.kojo']);

    expect(run.ok).toBe(false);
    expect(run.summary.readErrorCount).toBe(1);
    expect(run.files[0]?.ok).toBe(true);
    expect(run.files[1]?.error).toContain('读取失败');
    expect(io.writes).toHaveLength(0);
  });
});

describe('unsupported 台账上屏', () => {
  it('不可迁移行：ok=false、行号 / 原行文本 / 目标提示 / error 诊断齐全', () => {
    const plan = planMigrateFile({ filePath: FILE, source: BAD });

    expect(plan.ok).toBe(false);
    expect(plan.unsupported).toEqual([
      expect.objectContaining({
        line: 3,
        code: 'core/migration/raw',
        sourceLine: '    她的心情 = 1',
      }),
    ]);
    expect(plan.unsupported[0]?.construct.length).toBeGreaterThan(0);
    expect(plan.unsupported[0]?.targetHint.length).toBeGreaterThan(0);
    expect(plan.summary.firstBlockedLine).toBe(3);
    expect(plan.diagnostics.some((d) => d.severity === 'error' && d.line === 3)).toBe(true);
    expect(plan.diffText).toContain('    她的心情 = 1');
  });
});

/* ============================== 应用 / 回读 ============================== */

describe('应用：备份 → 写入(preserve) → readback', () => {
  it('成功路径：一次 backup、一次写、回读逐字等于迁移结果', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1, 'shift_jis', 'crlf');
    const run = await dryRunMigrateFiles(io, [FILE]);
    const expected = run.files[0]!.code;

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.written).toBe(1);
    expect(result.rolledBack).toBe(0);
    expect(io.backups).toHaveLength(1);
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0]?.opts).toEqual({ encoding: 'preserve', eol: 'preserve', backup: false });

    const after = await io.readText(FILE);
    expect(after.text).toBe(expected);
    expect(after.encoding).toBe('shift_jis');
    expect(after.eol).toBe('crlf');

    const file = result.files[0]!;
    expect(file.status).toBe('applied');
    expect(file.backupVersionId).toBe(io.backups[0]!.versionId);
    expect(file.readback?.text).toBe(expected);
    expect(file.rollback).toBe('none');
  });

  it('已是 2.0：应用为 no-op，不备份也不写盘', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1_CODE);
    const run = await dryRunMigrateFiles(io, [FILE]);

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.written).toBe(0);
    expect(io.backups).toHaveLength(0);
    expect(io.writes).toHaveLength(0);
    expect(result.files[0]?.message).toContain('已是 2.0');
  });

  it('撤销：按本次写入留下的备份版本恢复，源文本 / 编码 / EOL 回到迁移前', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1, 'shift_jis', 'crlf');
    const run = await dryRunMigrateFiles(io, [FILE]);
    const applied = await applyMigratePlan(io, run);
    expect(applied.ok).toBe(true);

    const undo = await undoMigratePlan(io, run, applied);

    expect(undo.ok).toBe(true);
    expect(undo.restored).toBe(1);
    expect(undo.failed).toBe(0);
    const after = await io.readText(FILE);
    expect(after.text).toBe(V1);
    expect(after.encoding).toBe('shift_jis');
    expect(after.eol).toBe('crlf');
    expect(io.restoreCalls).toBe(1);
  });

  it('预演后文件被外部改动 → stale，拒绝写入且不产生备份', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1);
    const run = await dryRunMigrateFiles(io, [FILE]);
    const external = `${V1}她走了。\n`;
    io.seed(FILE, external);

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    expect(result.files[0]?.status).toBe('stale');
    expect(io.writes).toHaveLength(0);
    expect(io.backups).toHaveLength(0);
    expect((await io.readText(FILE)).text).toBe(external);
  });
});

/* ============================== 失败回滚 ============================== */

describe('失败回滚：源文件必须回到迁移前', () => {
  it('写入抛错（且已留下半成品）→ 按备份恢复，源文本 / 编码 / EOL 原样', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1, 'shift_jis', 'crlf');
    const run = await dryRunMigrateFiles(io, [FILE]);
    io.failNextWrite('corrupt-then-throw');

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(1);
    const file = result.files[0]!;
    expect(file.status).toBe('rolled-back');
    expect(file.rollback).toBe('restore-backup');
    expect(io.restoreCalls).toBe(1);

    const after = await io.readText(FILE);
    expect(after.text).toBe(V1);
    expect(after.encoding).toBe('shift_jis');
    expect(after.eol).toBe('crlf');
  });

  it('写入成功但回读不一致 → 同样回滚，并在消息里说明原因', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1);
    const run = await dryRunMigrateFiles(io, [FILE]);
    io.failNextWrite('corrupt-silently');

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    const file = result.files[0]!;
    expect(file.status).toBe('rolled-back');
    expect(file.rollback).toBe('restore-backup');
    expect(file.message).toContain('回读');
    expect((await io.readText(FILE)).text).toBe(V1);
  });

  it('备份恢复也失败 → 退回显式重写原文，源仍不被破坏', async () => {
    const io = new FakeIo();
    io.seed(FILE, V1);
    const run = await dryRunMigrateFiles(io, [FILE]);
    io.failNextWrite('corrupt-then-throw');
    io.failRestore = true;

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    const file = result.files[0]!;
    expect(file.status).toBe('rolled-back');
    expect(file.rollback).toBe('rewrite-source');
    expect((await io.readText(FILE)).text).toBe(V1);
  });

  it('阻断文件：apply 拒绝写盘，源文件逐字未动', async () => {
    const io = new FakeIo();
    io.seed(FILE, BAD);
    const run = await dryRunMigrateFiles(io, [FILE]);

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    expect(result.files[0]?.status).toBe('blocked');
    expect(io.writes).toHaveLength(0);
    expect(io.backups).toHaveLength(0);
    expect((await io.readText(FILE)).text).toBe(BAD);
  });
});

/* ============================== 整批 ============================== */
describe('整批：默认 fail-closed，allowPartial 才动可迁移文件', () => {
  const GOOD = 'C:\\proj\\good.kojo';
  const BAD_FILE = 'C:\\proj\\bad.kojo';

  function seedBatch(io: FakeIo): void {
    io.seed(GOOD, V1);
    io.seed(BAD_FILE, BAD);
  }

  it('存在阻断 → 整批拒绝：两个文件都 skipped，零写入', async () => {
    const io = new FakeIo();
    seedBatch(io);
    const run = await dryRunMigrateFiles(io, [GOOD, BAD_FILE]);
    expect(run.ok).toBe(false);
    expect(run.summary.blockedCount).toBe(1);

    const result = await applyMigratePlan(io, run);

    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(2);
    expect(io.writes).toHaveLength(0);
    expect(io.backups).toHaveLength(0);
    expect((await io.readText(GOOD)).text).toBe(V1);
  });

  it('显式 allowPartial → 只写可迁移文件，阻断文件原样保留', async () => {
    const io = new FakeIo();
    seedBatch(io);
    const run = await dryRunMigrateFiles(io, [GOOD, BAD_FILE]);

    const result = await applyMigratePlan(io, run, { allowPartial: true });

    expect(result.ok).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
    expect((await io.readText(GOOD)).text).toBe(V1_CODE);
    expect((await io.readText(BAD_FILE)).text).toBe(BAD);
  });
});

/* ============================== 语义层（K2-MIGRATE-MOUNT 起改调） ============================== */

/**
 * 本批把 dry-run 的引擎从机械层换成**语义层**（`migrateKojoSourceSemantic`）。
 *
 * 返回值是机械层结果的超集（`MigrateResult & { rewrites }`），所以上面 16 条期望
 * **一条都不用改**——这是那批期望的回归证据。下面几条钉的是"换引擎换来了什么"：
 * `当 / 分支： / 初回` 从"一律阻断"变成"可证的才改写、不可证的照旧阻断"。
 */
describe('语义层：rewrites 进计划，可证的构造不再阻断', () => {
  const SWITCH =
    '角色: 灵梦\n时机 指令 310：\n    当 TFLAG:193：\n        是 1：\n            她一言不发。\n        是 5 到 8：\n            她微微眯起眼睛。\n        否则：\n            她什么也没说。\n';

  it('`当` → `# 表`：ok=true、unsupported 清零、rewrites 一条带逐条 diff', () => {
    const plan = planMigrateFile({ filePath: FILE, source: SWITCH });

    expect(plan.ok).toBe(true);
    expect(plan.unsupported).toEqual([]);
    expect(plan.code).toBe(
      '# 表 迁移表1 由 TFLAG:193\n' +
        '    1 她一言不发。\n' +
        '    5..8 她微微眯起眼睛。\n' +
        '    否 她什么也没说。\n' +
        '\n' +
        '# 机 指令 310\n' +
        '> {迁移表1}\n',
    );

    expect(plan.rewrites).toHaveLength(1);
    const rewrite = plan.rewrites[0]!;
    expect(rewrite).toMatchObject({
      kind: 'switch-table',
      line: 3,
      endLine: 9,
      declName: '迁移表1',
      reference: '> {迁移表1}',
    });
    // 原块逐行（含块头与缩进体）在 diff 左侧，落点在右侧
    expect(rewrite.removedLines).toEqual([
      '    当 TFLAG:193：',
      '        是 1：',
      '            她一言不发。',
      '        是 5 到 8：',
      '            她微微眯起眼睛。',
      '        否则：',
      '            她什么也没说。',
    ]);
    expect(rewrite.diffText).toContain(`--- a/${FILE}（v1 第 3–9 行）`);
    expect(rewrite.diffText).toContain('-    当 TFLAG:193：');
    expect(rewrite.diffText).toContain('+> {迁移表1}');
    // 整份 diff 仍然照旧（声明提升到顶层 + 原位置换引用行）
    expect(plan.diffText).toContain('+# 表 迁移表1 由 TFLAG:193');
    expect(plan.summary).toMatchObject({ ok: true, unsupportedCount: 0, rewriteCount: 1 });
  });

  it('`分支：` → `# 池` 与 `初回` → `@原生`：两种 kind 各一条，汇总计入整批', async () => {
    const BRANCH =
      '角色: 灵梦\n时机 指令 310：\n    分支：\n        [她的恋慕 >= 100]\n            她笑了。\n        [其他]\n            她什么也没说。\n';
    const ASK = '角色: 灵梦\n时机 指令 310：\n    初回 "once"：\n        「甲」\n';
    const io = new FakeIo();
    io.seed(FILE, BRANCH);
    io.seed('C:\\proj\\b.kojo', ASK);

    const run = await dryRunMigrateFiles(io, [FILE, 'C:\\proj\\b.kojo']);

    expect(run.ok).toBe(true);
    expect(run.summary.rewriteCount).toBe(2);
    expect(run.files[0]?.rewrites[0]).toMatchObject({
      kind: 'branch-pool',
      declName: '迁移池1',
      reference: '! 迁移池1',
    });
    expect(run.files[0]?.code).toContain('# 池 迁移池1\n    ? 她的恋慕 >= 100\n');
    expect(run.files[1]?.rewrites[0]).toMatchObject({ kind: 'ask-native', declName: null });
    expect(run.files[1]?.code).toContain('@原生\n    初回 "once"：\n        「甲」');
    // `初回` 的围栏内容还是 v1：warning 上屏（ok 不受影响）
    expect(run.files[1]?.summary.warningCount).toBeGreaterThan(0);
  });

  it('不可证的形态维持阻断：字符串臂的 `当` 仍然 ok=false、rewrites 为空', () => {
    const source =
      '角色: 灵梦\n时机 指令 310：\n    当 恋慕：\n        是 "高"：\n            她笑了。\n        否则：\n            她没说话。\n';

    const plan = planMigrateFile({ filePath: FILE, source });

    expect(plan.ok).toBe(false);
    expect(plan.rewrites).toEqual([]);
    expect(plan.unsupported.map((item) => item.code)).toContain('core/migration/switch');
    expect(plan.summary.rewriteCount).toBe(0);
  });

  it('目标口径：原地改写（targetPath === filePath，不改扩展名、不产出 .kojo2）', () => {
    const plan = planMigrateFile({ filePath: FILE, source: V1 });

    expect(plan.targetPath).toBe(FILE);
    expect(plan.write.targetPath).toBe(FILE);
    expect(plan.backup.applyHint).toContain(FILE);
    expect(plan.backup.applyHint).toContain('不改扩展名、不删源');
    expect(plan.code).not.toContain('.kojo2');
  });
});
