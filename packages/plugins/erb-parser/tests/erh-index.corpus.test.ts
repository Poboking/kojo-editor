import { mkdtempSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ErbFile, ErbIndex, ErbParserService, Logger } from '@kojo/plugin-api';
import { ERB_BODY_EXTENSIONS, ERB_DECLARATION_EXTENSIONS, isErbBodyPath, isErbDeclarationPath, isErbDialectPath } from '@kojo/plugin-api';
import { createKernel } from '../../../kernel/src/kernel';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { MemoryStorageBackend } from '../../../kernel/tests/helpers/memory-storage';
import { createErbParserPlugin } from '@kojo/plugin-erb-parser';
import { formTripleSymbolRule, messageCheckStructureRule } from '../../eratw-adapter/src/conventions';
import { checkControlFlowStructure } from '../src/structure';

/**
 * `.ERH` 进索引的真实语料自证（FT-2，`KOJO_SMOKE_PROJECT` / `KOJO_CORPUS_DIR` 守门，没盘自动跳过）。
 *
 * 三条硬事实要在真盘上钉住，一条都不许靠记忆：
 * 1. **份数与覆盖**：口上根里的每一份 `.ERH` 都真的进了索引（walk 扩面在深层 CJK 目录上成立）；
 * 2. **函数树不变**：声明文件 0 个 `@` 定义 ⇒ 索引文件数增加、函数计数与 `byName` 一个不动
 *    （`byName` 里不许出现任何指向声明文件的路径）；
 * 3. **诊断面读数**：声明文件进面后**新增**多少条诊断——结构闸门 + 两条逐文件约定规则
 *    （`.ERH` 原本不在索引里 ⇒ 它们的既有贡献恒为 0，故"这三份判据在声明文件上产出多少"
 *     就是净新增）。出现成串假阳性就必须改判据，不许靠跳过扩展名糊过去。
 *
 * 顺带留耗时读数（索引段）：扩面前后各跑一次全量重建，让"多收 31 份文件值多少钱"可见。
 */
const SMOKE = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;

/** 口上根（索引 roots）——与 `eratw-adapter` 的 `paths.personalKojo` 同一处目录；
 *  测试夹具里直写路径是既有做法（见 attribution.corpus.test.ts），游戏知识不进生产码 */
const KOJO_ROOT_REL = ['ERB', '口上・メッセージ関連', '個人口上'];

function collectBy(dir: string, pred: (name: string) => boolean, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectBy(p, pred, out);
    else if (pred(e.name)) out.push(p);
  }
}

const silentLog: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe.skipIf(!SMOKE)('.ERH 进索引 · 真实语料自证', () => {
  it('份数 / 函数树不变 / 诊断净新增 / 索引耗时', async () => {
    const root = join(SMOKE!, ...KOJO_ROOT_REL);
    statSync(root); // 语料在但结构不符预期 ⇒ 显式失败，不静默跳过

    // ---- 盘上枚举（用单一真源，与索引 walk 同一条口径）----
    const bodyFiles: string[] = [];
    const declFiles: string[] = [];
    collectBy(root, isErbBodyPath, bodyFiles);
    collectBy(root, isErbDeclarationPath, declFiles);
    const allDialect: string[] = [];
    collectBy(root, isErbDialectPath, allDialect);
    const declOnDisk: string[] = [];
    collectBy(join(SMOKE!, 'ERB'), isErbDeclarationPath, declOnDisk);
    console.log(
      `[erh] 口上根内：正文 ${bodyFiles.length}（${ERB_BODY_EXTENSIONS.join('/')}）` +
        ` / 声明 ${declFiles.length}（${ERB_DECLARATION_EXTENSIONS.join('/')}）；` +
        `ERB 目录全域声明 ${declOnDisk.length}`,
    );
    expect(declFiles.length, '口上根里该有声明文件').toBeGreaterThan(0);
    expect(declOnDisk.length, 'ERB 全域的声明文件份数（历史读数 157 盘上实测）').toBeGreaterThanOrEqual(100);
    // 口径可加性：方言全集 = 正文 + 声明，两条轴不重不漏
    expect(allDialect.length).toBe(bodyFiles.length + declFiles.length);

    // ---- 全量重建索引（计时）----
    const appData = mkdtempSync(join(tmpdir(), 'kojo-erh-'));
    const kernel = await createKernel({
      platform: new NodeBridge(appData),
      plugins: [createErbParserPlugin()],
      storageBackend: new MemoryStorageBackend(),
    });
    await kernel.start();
    try {
      const parser = kernel.services.get<ErbParserService>('erb.parser');
      const t0 = performance.now();
      const index = await parser.buildIndex([root]);
      const ms = performance.now() - t0;

      let functions = 0;
      let dims = 0;
      for (const f of index.files.values()) {
        functions += f.functions.length;
        dims += f.dims.length;
      }
      console.log(
        `[erh] 索引：文件 ${index.files.size} / 函数 ${functions}（去重名 ${index.byName.size}）` +
          ` / #DIM ${dims} / 全量重建 ${ms.toFixed(0)}ms`,
      );

      // ---- 1. 覆盖：每一份声明文件都在索引里，且没有多收非方言文件 ----
      for (const p of declFiles) expect(index.files.has(p), `声明文件未进索引：${p}`).toBe(true);
      expect(index.files.size, '索引文件数 = 盘上方言文件数').toBe(allDialect.length);
      expect([...index.files.keys()].filter(isErbBodyPath).length).toBe(bodyFiles.length);

      // ---- 2. 函数树不变：声明文件 0 函数，byName 里不许有它们 ----
      let declFunctions = 0;
      let declLines = 0;
      for (const p of declFiles) {
        const f = index.files.get(p)!;
        declFunctions += f.functions.length;
        declLines += f.lineCount;
      }
      console.log(`[erh] 声明文件合计 ${declFiles.length} 份 / ${declLines} 行 / 函数定义 ${declFunctions} 个`);
      expect(declFunctions, '声明文件不该产出函数定义').toBe(0);
      const leaked = [...index.byName.values()].flatMap((refs) => refs.map((r) => r.filePath)).filter(isErbDeclarationPath);
      expect(leaked, `函数树里混进声明文件：\n${leaked.join('\n')}`).toEqual([]);
      // 函数计数必须与"只收正文"时的总数一致（正文侧独立复核一遍逐文件计数）
      const bodyFnTotal = [...index.files.values()].filter((f) => isErbBodyPath(f.path)).reduce((s, f) => s + f.functions.length, 0);
      expect(functions, '函数总数 = 正文文件函数总数').toBe(bodyFnTotal);
      expect(functions, '函数总数（历史读数 99,104，扩面后不许动）').toBeGreaterThanOrEqual(90_000);

      // ---- 3. 诊断净新增：三处判据在声明文件上各产出多少 ----
      const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));
      const ctx = {
        project: { rootDir: SMOKE!, kojoPaths: [root], adapterId: 'eratw' },
        index,
        readFile: async (p: string) => (await io.readText(p)).text,
        log: silentLog,
      } as unknown as ConventionCheckContext;

      const structureHits: string[] = [];
      const conventionHits: string[] = [];
      let readMs = 0;
      const declarationEntries: ErbFile[] = declFiles.map((p) => index.files.get(p)!);
      for (const f of declarationEntries) {
        const r0 = performance.now();
        const text = await io.readText(f.path);
        readMs += performance.now() - r0;
        for (const issue of checkControlFlowStructure(text.text)) {
          structureHits.push(`${f.path.replace(SMOKE!, '')}:${issue.line} ${issue.message}`);
        }
        for (const rule of [formTripleSymbolRule, messageCheckStructureRule]) {
          const produced = (await rule.checkFile!(ctx, f)) ?? [];
          for (const i of produced) {
            conventionHits.push(`${rule.id} ${f.path.replace(SMOKE!, '')}:${i.line ?? 0} ${i.message}`);
          }
        }
      }
      console.log(
        `[erh] 诊断净新增：结构闸门 ${structureHits.length} 条 / 逐文件约定 ${conventionHits.length} 条；` +
          `这 ${declFiles.length} 份声明文件的边际成本 = 读盘 ${readMs.toFixed(0)}ms（含逐份体检与两条逐文件规则）`,
      );
      expect(structureHits, `声明文件上的结构假阳性（应为空）：\n${structureHits.join('\n')}`).toEqual([]);
      expect(conventionHits, `声明文件上的约定假阳性（应为空）：\n${conventionHits.join('\n')}`).toEqual([]);

      // 整项目层（KX 占位符 / 四件套完整性 / 槽覆盖）只吃 byName 与函数表：
      // 上面已证 0 函数进树 ⇒ 它们的输入一个字节没变，结论必然不变，无需重跑一遍 20s 级校验。
      for (const f of declarationEntries) {
        expect(f.hasFunctionDirective, `声明文件不该带 #FUNCTION：${f.path}`).toBe(false);
      }
    } finally {
      await kernel.stop();
    }
  }, 300_000);
});
