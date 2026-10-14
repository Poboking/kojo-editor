/**
 * erb_check.py 冒烟闸：kojo-sugar 转译产物 → 游戏自带静态检查器。
 *
 * 契约（2026-10-13 实测定案，探针留档 %TEMP%\erb-check-probe\）：
 * - erb_check.py 发现问题**也 exit 0**，判定必须解析 stdout 的 `[ERROR]`/`[FATAL]`；
 * - `[WARN]` 不视为失败（语料里 RAND 逻辑告警是真阳性但非转译错误）；
 * - 必须 `PYTHONIOENCODING=utf-8`，否则 GBK 终端下 emoji 直接崩；
 * - 产物写盘**不带 BOM**（BOM + 首行关键字会触发它的假阳性 "Extra closing tag"）。
 *
 * 开启方式：`pnpm test:erbcheck`，或
 * `KOJO_ERB_CHECK=1 pnpm vitest run packages/plugins/kojo-sugar/tests/erbcheck.smoke.test.ts`。
 * 检查器路径优先级：`KOJO_ERB_CHECK_PY=<path>` > `KOJO_CORPUS_DIR` 下的 `tool/erb_check.py` >
 * **按内容就地发现语料**（认内容不认名：语料目录名会被反复重排，写死必过期；口径同 `tools/corpus.mjs`，
 * 但本测试属插件包，**不 import 仓库 tools/**——跨层引用不干净，故就地写一份同样的小解析）。
 * 既无 env 又发现不到 → 整组 skip；`KOJO_CORPUS_DIR` 设了却不成立 → **直接报错**（不静默换版本，免得对拍对象张冠李戴）。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { readKojo } from './golden.test';
import { stubDict, stubFaceTable } from './support';

/** 扫描根：`KOJO_CORPUS_SCAN_DIRS`（`;` 分隔）设了则整体替换默认值——口径同 `tools/corpus.mjs`。 */
function scanRoots(): string[] {
  const raw = (process.env.KOJO_CORPUS_SCAN_DIRS ?? '').trim();
  return raw ? raw.split(';').map((s) => s.trim()).filter(Boolean) : ['C:/game'];
}
/** 大小写不敏感找条目（盘符/目录名大小写都能中），wantDir 时只认目录。 */
function findEntry(root: string, name: string, wantDir: boolean): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const lower = name.toLowerCase();
  for (const ent of entries) {
    if (ent.name.toLowerCase() !== lower) continue;
    if (wantDir && !ent.isDirectory()) continue;
    return ent.name;
  }
  return null;
}
function countErb(dir: string): number {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let ents: Dirent[];
    try {
      ents = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(join(cur, ent.name));
      else if (ent.isFile() && /\.erb$/i.test(ent.name)) n++;
    }
  }
  return n;
}
/** 语料内容体检：ERB/ + CSV/ + tool/erb_check.py 三样齐了才算候选。 */
function inspect(dir: string): { dir: string; erbCount: number; savCount: number } | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  for (const base of ['ERB', 'CSV']) if (!findEntry(dir, base, true)) return null;
  if (!findEntry(join(dir, 'tool'), 'erb_check.py', false)) return null;
  const savName = findEntry(dir, 'sav', true);
  let savCount = 0;
  try {
    savCount = savName ? readdirSync(join(dir, savName)).length : 0;
  } catch {
    savCount = 0;
  }
  return { dir, erbCount: countErb(join(dir, 'ERB')), savCount };
}
/** 命中多个时的确定性判据：①sav/ 非空优先 ②.ERB 数多者 ③目录名（与 tools/corpus.mjs 同口径）。 */
function discoverCorpus(): string | null {
  const hits: Array<{ dir: string; erbCount: number; savCount: number }> = [];
  for (const root of scanRoots()) {
    let ents: Dirent[];
    try {
      ents = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      const info = inspect(join(root, ent.name));
      if (info) hits.push(info);
    }
  }
  hits.sort((a, b) => (b.savCount > 0 ? 1 : 0) - (a.savCount > 0 ? 1 : 0) || b.erbCount - a.erbCount || a.dir.localeCompare(b.dir));
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    console.log(
      `[erbcheck] 自动选定语料 ${hits[0]!.dir}（ERB ${hits[0]!.erbCount} / sav ${hits[0]!.savCount}）`
      + `— 判据 ①sav/ 非空优先 ②.ERB 数 ③目录名；其余候选: ${hits.slice(1).map((h) => `${h.dir}（ERB ${h.erbCount} / sav ${h.savCount}）`).join('，')}`
      + `；要固定就设 KOJO_CORPUS_DIR=<语料目录> 或 KOJO_ERB_CHECK_PY=<erb_check.py 路径>`,
    );
  }
  return hits[0]!.dir;
}
/** 只在闸开（KOJO_ERB_CHECK=1）时才解析，免得每次全量收集都去扫盘。 */
function resolveChecker(): string | undefined {
  const envPy = process.env.KOJO_ERB_CHECK_PY;
  if (envPy) return envPy;
  const envCorpus = (process.env.KOJO_CORPUS_DIR || '').trim();
  if (envCorpus) {
    const py = join(envCorpus, 'tool', 'erb_check.py');
    if (!existsSync(envCorpus) || !existsSync(py)) {
      throw new Error(`KOJO_CORPUS_DIR 指向的目录不存在或缺 tool/erb_check.py: ${envCorpus}\n  设 KOJO_CORPUS_DIR=<语料目录> 可改指（不设则按内容自动发现：需 ERB/、CSV/、tool/erb_check.py）`);
    }
    return py;
  }
  const dir = discoverCorpus();
  return dir ? join(dir, 'tool', 'erb_check.py') : undefined;
}

let workDir: string | undefined;

const cases = [
  ['spec-6.1-lumia-310.kojo', 'K12_SPEC61'],
  ['spec-6.2-choice-heart-random.kojo', 'K12_SPEC62'],
  ['spec-3.3-narration-default.kojo', 'K12_SPEC33A'],
  ['spec-3.3-narration-author-color.kojo', 'K12_SPEC33B'],
] as const;

const checker = process.env.KOJO_ERB_CHECK === '1' ? resolveChecker() : undefined;
const guarded = checker && existsSync(checker) ? describe : describe.skip;

guarded('erb_check.py 冒烟闸（转译产物静态验收）', () => {

  beforeAll(() => {
    const svc = createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
    workDir = mkdtempSync(join(tmpdir(), 'kojo-erbcheck-'));
    for (const [fixture, stem] of cases) {
      const { erb, diagnostics } = svc.transpile(readKojo(fixture));
      const errors = diagnostics.filter((d) => d.severity === 'error');
      expect(errors, `${fixture} 转译诊断有 error`).toEqual([]);
      writeFileSync(join(workDir!, `${stem}.ERB`), Buffer.from(erb, 'utf8'));
    }
  });

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('全部产物零 [ERROR]/[FATAL]', () => {
    const r = spawnSync('python', [checker!, workDir!], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 60_000,
    });
    if (r.error) throw new Error(`python 启动失败：${r.error.message}（检查 python 是否在 PATH）`);
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(out, `erb_check 退出码 ${r.status}\n${out}`).not.toMatch(/\[(ERROR|FATAL)\]/);
  });
});
