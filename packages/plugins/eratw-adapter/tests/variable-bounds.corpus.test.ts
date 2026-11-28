/**
 * 变量字面下标诊断 × 真语料活闸（CB-002 的反向证伪场）。
 *
 * 只钉一条：**零新增误报**。eraTW 4.981 全量 4,371 文件里，正确套上
 * `CSV/VariableSize.csv` 后字面越界应为 0；若规则拿出厂值判，`CFLAG:*:1000`
 * 一处就有 12,825 条 ⇒ 闸当场红。语料不在位 ⇒ skip（只读、绝不改语料）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConventionCheckContext, ConventionIssue, ErbIndex, GameProject, Logger } from '@kojo/plugin-api';
import { functionLookupOf } from '@kojo/plugin-api';
import { ERB_DIALECT_EXTENSIONS } from '@kojo/plugin-api';
import { parseErbText } from '@kojo/plugin-erb-parser';
import { checkVariableBounds } from '../src/variable-bounds-impl';

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

describe('P1-4 · 变量下标越界 × 真语料', () => {
  it.skipIf(!CORPUS)(
    'CSV 覆盖后零误报（照出厂判必红的那一万多条不得出现）',
    { timeout: 900_000 },
    async () => {
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
        readFile: async (p: string) => readFileSync(p.replace(/\\/g, '/'), 'utf8'),
        log: silentLog,
      };
      const issues = (await checkVariableBounds(ctx)) as ConventionIssue[];
      expect({ files: files.length, issues: issues.slice(0, 12), total: issues.length }).toEqual({
        files: files.length,
        issues: [],
        total: 0,
      });
    },
  );
});
