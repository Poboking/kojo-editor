/**
 * 引擎词法/字面实参检查 × 真语料活闸。
 *
 * 语料探针先证（eraTW 4.981，4,371 文件）：== 赋值位 0（2 处 PRINTL 括号续行由
 * 可见行守卫豁免）、SETCOLOR/SETBGCOLOR 字面分量越界 0、ASSERT 字面 0 0。
 * 全角空格 40,783 处全在 PRINT 输出文本（合法），本规则不判该键——归档表留账。
 * 语料不在位 ⇒ skip（只读、绝不改语料）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ConventionIssue, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { checkEngineLineChecks } from '../src/engine-line-checks-impl';

const CORPUS = process.env.KOJO_SMOKE_PROJECT ?? process.env.KOJO_CORPUS_DIR;
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function dialectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if ((ERB_DIALECT_EXTENSIONS as readonly string[]).includes(path.extname(p).toLowerCase())) out.push(p);
    }
  }
  return out.sort();
}

describe('P2-7 · 引擎词法/字面实参 × 真语料', () => {
  it.skipIf(!CORPUS)('三类相位全量零命中（引擎会在这些行上说话，eraTW 作者没写过）', { timeout: 900_000 }, async () => {
    const root = CORPUS!;
    const files = dialectFiles(path.join(root, 'ERB'));
    expect(files.length).toBeGreaterThan(1_000);
    const indexFiles = new Map<string, ReturnType<typeof parseErbText>>();
    for (const file of files) {
      indexFiles.set(file, parseErbText(readFileSync(file, 'utf8'), file));
    }
    const index: ErbIndex = { files: indexFiles, byName: functionLookupOf(new Map()) } as ErbIndex;
    const project = {
      rootDir: root,
      adapterId: 'eratw',
      kojoPaths: [],
      writablePaths: [],
      charaIndex: new Map(),
    } as GameProject;
    const ctx: ConventionCheckContext = {
      project,
      index,
      readFile: async (p: string) => readFileSync(p, 'utf8'),
      log: silentLog,
    };
    const issues: ConventionIssue[] = await checkEngineLineChecks(ctx);
    expect(
      issues.map((i) => `${i.filePath}:${i.line} ${i.message.slice(0, 60)}`),
      '语料零命中被打破——先查是不是续行/字符串判据漏了，再谈收账',
    ).toEqual([]);
  });
});
