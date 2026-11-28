/**
 * eraTW 编译器审计读数 → 约定诊断的规则闸。
 *
 * 两路证据：
 * 1. **真实快照契约**：`tools/data/unresolved-symbols.tsv`（erbcc audit 真产物，
 *    eraTW 4.981 全量 4,370 文件）与生成的数据叶子逐字对拍 —— sha / 条数 / kind 序号 / 行号；
 * 2. **8 类全谱注入**：真实快照当期只有 3 类（另 5 类=语料没那类问题，不是规则不支持），
 *    用注入数据把 8 类各造一条，钉死严重度分级、0 基→1 基、指纹门控与跨文件隔离。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { ConventionCheckContext, ConventionIssue, ErbFile, Logger } from '@kojo/plugin-api';
import { stableHash } from '@kojo/plugin-api';
import { normalizeEol } from '@kojo/plugin-api/eol';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FINDING_KINDS,
  AUDIT_KIND_META,
  createEratwAuditFindingRule,
  eraTwAuditFindingRule,
  issueOf,
} from '../src/conventions';
import {
  AUDIT_FILES,
  AUDIT_FILE_COUNT,
  AUDIT_FINDING_COUNT,
  AUDIT_SOURCE_SHA256,
} from '../src/audit-findings.data';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const TSV = path.join(ROOT, 'tools', 'data', 'unresolved-symbols.tsv');
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function fileOf(p: string): ErbFile {
  return { path: p, functions: [], dims: [], hasFunctionDirective: false, lineCount: 1 };
}

function ctxOf(files: Record<string, string>): ConventionCheckContext {
  return {
    project: { rootDir: '/p', adapterId: 'eratw', kojoPaths: [], writablePaths: [], charaIndex: new Map() },
    index: { files: new Map(), byName: new Map() as never },
    readFile: async (p: string) => {
      const t = files[p];
      if (t === undefined) throw new Error(`not found: ${p}`);
      return t;
    },
    log: silentLog,
  };
}

describe('audit 数据契约（真产物逐字对拍）', () => {
  it('快照 sha256 / 条数 / 文件数与生成数据一致', () => {
    const raw = readFileSync(TSV, 'utf8');
    // 与生成器同尺：先 EOL 归一化再算 sha，避免 git autocrlf 换 EOL 造成假红。
    const sha = createHash('sha256').update(raw.replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
    expect(sha).toBe(AUDIT_SOURCE_SHA256);
    const rows = raw.split('\n').filter(Boolean).slice(1);
    expect(rows).toHaveLength(AUDIT_FINDING_COUNT);
    expect(Object.keys(AUDIT_FILES)).toHaveLength(AUDIT_FILE_COUNT);
    const sum = Object.values(AUDIT_FILES).reduce((n, e) => n + e.r.length, 0);
    expect(sum).toBe(AUDIT_FINDING_COUNT);
  });

  it('每条 row 的 kind 序号 / 行号 / 次数都合法（表外 kind 不可能混入）', () => {
    for (const entry of Object.values(AUDIT_FILES)) {
      expect(entry.s).toMatch(/^[0-9a-f]{14}$/);
      for (const [ki, , line0, , , count] of entry.r) {
        expect(ki).toBeGreaterThanOrEqual(0);
        expect(ki).toBeLessThan(AUDIT_FINDING_KINDS.length);
        expect(Number.isInteger(line0)).toBe(true);
        expect(line0).toBeGreaterThanOrEqual(-1);
        expect(count).toBeGreaterThan(0);
      }
    }
  });

  it('真实快照只含语料当期命中的 kind —— 不许伪造另 5 类', () => {
    const kinds = new Set<number>();
    for (const entry of Object.values(AUDIT_FILES)) for (const r of entry.r) kinds.add(r[0]);
    expect([...kinds].sort()).toEqual([0, 3, 7]); // VAR_UNBOUND / KEYWORD_UNBOUND / COMPILE_DIM_WARNING
  });
});

describe('8 类 Finding 映射（注入全谱）', () => {
  it('八类一一映射为 ruleId + 中文短名 + blocking 严重度（7 error / 1 info）', () => {
    expect(AUDIT_FINDING_KINDS).toHaveLength(8);
    const issues = AUDIT_FINDING_KINDS.map((_, ki) =>
      issueOf([ki, 'FN', 41, 'NAME', 'detail', 1], '/p/ERB/A.ERB', 'A.ERB'),
    );
    expect(issues.every((i) => i !== null)).toBe(true);
    const typed = issues as ConventionIssue[];
    expect(typed.map((i) => i.ruleId)).toEqual(
      AUDIT_FINDING_KINDS.map((k) => `eratw.audit-findings.${k.toLowerCase()}`),
    );
    expect(typed.filter((i) => i.severity === 'error')).toHaveLength(7);
    expect(typed.filter((i) => i.severity === 'info')).toHaveLength(1);
    expect(typed[7]!.severity).toBe('info'); // COMPILE_DIM_WARNING 是唯一非红
    expect(typed.every((i, idx) => i.message.includes(AUDIT_KIND_META[AUDIT_FINDING_KINDS[idx]!]!.label))).toBe(true);
  });

  it('0 基行号 +1 = 1 基；-1 = 定位不到 ⇒ 整文件级不给 line', () => {
    expect(issueOf([0, 'FN', 41, 'X', 'd', 1], '/p/A.ERB', 'A.ERB')!.line).toBe(42);
    expect(issueOf([0, '', -1, 'X', 'd', 1], '/p/A.ERB', 'A.ERB')!.line).toBeUndefined();
  });

  it('表外 kind 序号返回 null（第二道闸，不静默产出裸码）', () => {
    expect(issueOf([99, '', 1, 'X', 'd', 1], '/p/A.ERB', 'A.ERB')).toBeNull();
  });

  it('count 进文案不进 key（同点出现次数变化不算新问题）', () => {
    const a = issueOf([0, 'FN', 1, 'X', 'd', 1], '/p/A.ERB', 'A.ERB')!;
    const b = issueOf([0, 'FN', 1, 'X', 'd', 7], '/p/A.ERB', 'A.ERB')!;
    expect(a.key).toBe(b.key);
    expect(a.message).not.toBe(b.message);
  });
});

describe('规则执行（指纹门控 / 跨文件隔离）', () => {
  const textA = '@FN\nPRINTFORM A\n';
  const rel = 'A.ERB';

  function ruleFor(text: string) {
    return createEratwAuditFindingRule(async () => ({
      [rel]: { s: stableHash(normalizeEol(text)), r: [[0, 'FN', 0, 'X', 'detail', 2]] },
    }));
  }

  it('指纹相符 ⇒ 产出诊断，行号已换到 1 基', async () => {
    const issues = await ruleFor(textA).checkFile!(ctxOf({ '/p/ERB/A.ERB': textA }), fileOf('/p/ERB/A.ERB'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBe(1);
    expect(issues[0]!.filePath).toBe('/p/ERB/A.ERB');
    expect(issues[0]!.message).toContain('同点 2 次');
  });

  it('正文改一个字符 ⇒ 指纹不符 ⇒ 整文件不出诊断（陈旧快照绝不误导）', async () => {
    const changed = `${textA}; edited\n`;
    const issues = await ruleFor(textA).checkFile!(ctxOf({ '/p/ERB/A.ERB': changed }), fileOf('/p/ERB/A.ERB'));
    expect(issues).toEqual([]);
  });

  it('快照里没有的文件 ⇒ 零诊断（不串味）', async () => {
    const issues = await ruleFor(textA).checkFile!(ctxOf({ '/p/ERB/B.ERB': textA }), fileOf('/p/ERB/B.ERB'));
    expect(issues).toEqual([]);
  });

  it('项目根直接指 ERB 目录时路径也能匹配（两种根口径都覆盖）', async () => {
    const rule = createEratwAuditFindingRule(async () => ({
      'A.ERB': { s: stableHash(normalizeEol(textA)), r: [[0, 'FN', 0, 'X', 'detail', 1]] },
    }));
    const ctx = ctxOf({ '/p/A.ERB': textA });
    ctx.project.rootDir = '/p';
    expect(await rule.checkFile!(ctx, fileOf('/p/A.ERB'))).toHaveLength(1);
  });
});

/** 真语料端到端：生成器用原语料算指纹，运行时也读原语料 —— 这一条证明两把尺子真能对上。 */
describe.skipIf(!process.env.KOJO_SMOKE_PROJECT)('真实语料端到端（KOJO_SMOKE_PROJECT 守门）', () => {
  it('快照首文件的正文指纹命中，逐条产出该文件的全部 Finding', async () => {
    const gameRoot = process.env.KOJO_SMOKE_PROJECT!;
    const rel = Object.keys(AUDIT_FILES)[0]!;
    const abs = path.join(gameRoot, 'ERB', ...rel.toLowerCase().split('/'));
    const text = readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
    const ctx = ctxOf({ [abs]: text });
    ctx.project.rootDir = gameRoot;
    const entry = AUDIT_FILES[rel as keyof typeof AUDIT_FILES]!;
    const issues = await eraTwAuditFindingRule.checkFile!(ctx, fileOf(abs));
    expect(issues).toHaveLength(entry.r.length);
    expect(issues[0]!.filePath).toBe(abs);
    expect(issues[0]!.line).toBe(entry.r[0]![2] + 1);
  });
});
