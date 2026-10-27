/**
 * PERF-5 验收（保存链）：**一次保存 = 一次真实转译**（2→1）。
 *
 * 链路：`performSugarSave` = `planSave`（转译 #1，真源）+ `compileToFile`
 * （内部还要转译一次）——后者与前者**同 (文本, filePath) 键**，命中 kojo-sugar
 * 的共享结果缓存 ⇒ 第二次调用是键探 + 返回同一结果对象，重编译不重转译。
 *
 * 本文件用**真** `createSugarTranspileService` + 真 `compileToFile`（io 用内存替身，
 * 只替文件系统不替逻辑）——替身会把"两次调用命中"证空（同 PITFALLS §52 的纪律）。
 * 读数 = 服务自带缓存统计（misses 1 / hits 1），不依赖墙钟。
 *
 * 语义护栏（不许因提速而变）：
 * - 落盘字节与"独立直算"逐字节一致（BOM + 产物正文）；
 * - `blocked`（转译 error / 非 .kojo）仍在写盘前短路。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO } from '@kojo/plugin-api';
import { createEratwFaceTable } from '@kojo/plugin-eratw-adapter';
import { createSugarTranspileService } from '@kojo/plugin-kojo-sugar';
import { performSugarSave } from '../src/save-handler';

// 用反斜杠形态：`compileToFile` 内部先过 `normalize`（win32 风格归一到 `\`），
// 内存 io 的键即归一后的路径——此处直接以同款形态命名，断言面干净。
const PATH = 'C:\\proj\\M_KOJO_K49_指令.kojo1';
const TARGET = 'C:\\proj\\M_KOJO_K49_指令.ERB';

const DOC = '角色: 12\n时机 指令 310：\n    「呀。」\n';

interface MemIo {
  readonly io: FileIO;
  readonly files: Map<string, Uint8Array>;
  readonly textWrites: Array<{ path: string; text: string }>;
}

/** 内存 io：只实现保存链用到的方法（exists / ensureDir / backup / writeBytes / readBytes / writeText） */
function memIo(): MemIo {
  const files = new Map<string, Uint8Array>();
  const textWrites: Array<{ path: string; text: string }> = [];
  const io = {
    exists: async (path: string) => files.has(path),
    ensureDir: async () => undefined,
    backup: async (path: string) => (files.has(path) ? `backup://${path}` : null),
    writeBytes: async (path: string, bytes: Uint8Array) => {
      files.set(path, bytes);
    },
    readBytes: async (path: string) => files.get(path)!,
    writeText: async (path: string, text: string) => {
      textWrites.push({ path, text });
    },
  } as unknown as FileIO;
  return { io, files, textWrites };
}

function harness(): { sugar: ReturnType<typeof createSugarTranspileService>; mem: MemIo } {
  const mem = memIo();
  const sugar = createSugarTranspileService({ faceTable: createEratwFaceTable(), io: mem.io });
  return { sugar, mem };
}

describe('保存一次 .kojo：转译次数 2→1（缓存统计口径）', () => {
  it('planSave + compileToFile 同键共享：misses = 1（第二次是命中，不是重转译）', async () => {
    const { sugar, mem } = harness();
    const out = await performSugarSave({ sugar, io: mem.io }, { path: PATH, text: DOC, project: null });
    expect(out.status).toBe('saved');
    if (out.status === 'saved') expect(out.message).toContain('已保存并编译');

    const stats = sugar.transpileCacheStats();
    expect(stats.misses).toBe(1); // 真实转译只发生一次
    expect(stats.hits).toBe(1); // compileToFile 内部那次被缓存接住

    // 源文件与产物都真的落盘了（不是"省掉了转译也省掉了写"）
    expect(mem.textWrites).toEqual([{ path: PATH, text: DOC }]);
    const bytes = mem.files.get(TARGET);
    expect(bytes).toBeDefined();
    expect([...bytes!.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
  });

  it('落盘字节与「独立直算 compileToBytes」逐字节一致（提速不改产物）', async () => {
    const { sugar, mem } = harness();
    await performSugarSave({ sugar, io: mem.io }, { path: PATH, text: DOC, project: null });
    const viaSave = mem.files.get(TARGET)!;
    // 独立实例直算（不复用保存链的缓存）
    const fresh = createSugarTranspileService({ faceTable: createEratwFaceTable() });
    const viaBytes = fresh.compileToBytes(DOC, { filePath: PATH }, TARGET).bytes;
    expect([...viaSave]).toEqual([...viaBytes]);
  });

  it('转译 error 文档：源照存、产物不写（blocked 语义不因提速松动）', async () => {
    const { sugar, mem } = harness();
    // `别名 她 = …` 与保留代词撞名 → 既有 alias-name-conflict（error）
    const bad = '角色: 12\n别名 她 = CFLAG:1\n时机 指令 310：\n    「呀。」\n';
    const out = await performSugarSave({ sugar, io: mem.io }, { path: PATH, text: bad, project: null });
    expect(out.status).toBe('saved');
    if (out.status === 'saved') expect(out.note).toContain('产物未生成');
    expect(mem.textWrites).toEqual([{ path: PATH, text: bad }]);
    expect(mem.files.has(TARGET)).toBe(false);
  });
});

/* 说明：旧的记录型编译替身路径（`format-on-save.test.ts`）保持不动——
   它证的是"格式化 × 全角空格"的顺序语义；本文件证"真编译链的调用次数"。 */
