/**
 * SMOKE-PORT 防再腐源形状守卫（2026-10-20）——vite dev 端口只许有一个真源。
 *
 * 真源 = `tools/smoke-lib.mjs` 的 `devTarget`（`tauri.conf.json` 的 `build.devUrl` ⇔
 * `vite.config.ts` 的 `server.port`，不一致就抛；`KOJO_SMOKE_VITE_PORT` 可换）。
 * 本守卫钉死三件事：
 *
 * ① 三份真壳工具（`smoke-editor-features` / `boot-watermarks` / `smoke-tauri-dev`）的**代码行**
 *    里不许再出现裸 `1420`——端口、CDP 判据、提示文案都必须取自解析结果。注释里的历史说明
 *    （「当前配置 1420」这类）**允许保留**，故判据只看剥掉注释后的文本（口径照
 *    `packages/app/tests/compute-task-table-single-source.test.ts` 的 `codeLines`）。
 * ② 三份文件都必须 import 并调用 `devTarget`，用 `dev.port` 做判据/连接目标；
 *    占用探测走 `smoke-lib` 的 `portBusy`（两个地址族都试）而不是自己另写一个单栈探测。
 * ③ 剥注释器自检：带 1420 的代码行必须命中、注释里的 1420 必须不命中——
 *    否则①会退化成「扫了个空」的假绿（revert-prove 也失去意义）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { devTarget, portBusy } from '../smoke-lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 剥注释（口径照 `codeLines`）：整段块注释（含 JSDoc）先摘掉，再逐行去掉行注释——
 * 行首 `//` / `*` 与行尾 `// …`（`(^|\s)//` 保证 `http://` 这类 URL 不被误伤），
 * 其余空行丢弃。返回的只有**会执行的字面量**。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('*');
    })
    .join('\n');
}

const codeLinesOf = (rel: string): string => stripComments(read(rel));

/** 端口字面量判据：`1420` 作为独立数字出现（`14201` / `v1420` 不算） */
const BARE_PORT = /\b1420\b/;

/** 消费方 → 必须从 smoke-lib 取得的三种口径（缺一即红：端口真源、占用探测、判据变量） */
const CONSUMERS: ReadonlyArray<{
  readonly file: string;
  readonly why: string;
}> = [
  { file: 'tools/smoke-editor-features.mjs', why: '起壳 + 等空闲（VITE_PORT 常量已删）' },
  { file: 'tools/boot-watermarks.mjs', why: '前置闸「目标端口被占 ⇒ exit 2」' },
  { file: 'tools/smoke-tauri-dev.mjs', why: 'checks.viteUp 判据' },
];

describe('SMOKE-PORT ③ 剥注释器自检（守卫自身不许退化成空扫描）', () => {
  /** 同一段工具源码的两种写法：代码行命中、注释行不命中 */
  const SAMPLE = [
    '// 历史：默认端口是 1420（注释可留）',
    'const p = 1420;',
    '/* 块注释里的 1420 也不算 */',
    "const url = 'http://127.0.0.1:1420';",
    'await portBusy(port); // 行尾注释 1420',
  ].join('\n');

  it('代码行命中、注释行不命中（两个方向都钉，漏一个方向守卫就会退化成假绿）', () => {
    const stripped = stripComments(SAMPLE);
    expect(stripped.match(/\b1420\b/g) ?? []).toHaveLength(2);
    expect(stripped).toContain('const p = 1420;');
    expect(stripped).toContain("'http://127.0.0.1:1420'"); // URL 里的端口仍在（`//` 未被误当注释）
    expect(stripped).not.toContain('历史：默认端口');
    expect(stripped).not.toContain('块注释里的');
    expect(stripped).not.toContain('行尾注释');
  });
});

describe('SMOKE-PORT ① 三份工具的代码行里裸 1420 归零', () => {
  it('扫描集合非空（三份文件都在）', () => {
    expect(CONSUMERS.length).toBe(3);
    for (const { file } of CONSUMERS) expect(read(file).length).toBeGreaterThan(1000);
  });

  it.each(CONSUMERS)('$file 的代码行不再出现端口字面量 1420（$why）', ({ file }) => {
    const code = codeLinesOf(file);
    const offenders = code.split(/\r?\n/).filter((line) => BARE_PORT.test(line));
    expect(offenders, `${file} 仍有把 1420 当端口/连接目标/提示文案的代码行：\n${offenders.join('\n')}`)
      .toEqual([]);
  });
});

describe('SMOKE-PORT ② 三份工具都经 smoke-lib 的 devTarget 取端口', () => {
  it('smoke-lib 仍导出 devTarget / portBusy（提供方缺席 ⇒ 消费方无处可接）', () => {
    expect(typeof devTarget).toBe('function');
    expect(typeof portBusy).toBe('function');
  });

  it.each(CONSUMERS)('$file：import devTarget+portBusy、调用 devTarget(ROOT)、判据用 dev.port', ({ file }) => {
    const code = codeLinesOf(file);
    expect(code, `${file} 必须 import ./smoke-lib.mjs`).toMatch(
      /import \{[^}]*\bdevTarget\b[^}]*\bportBusy\b[^}]*\} from '\.\/smoke-lib\.mjs'/,
    );
    expect(code, `${file} 必须调用 devTarget(ROOT)`).toMatch(/devTarget\(ROOT\)/);
    expect(code, `${file} 的端口判据必须取 dev.port`).toMatch(/dev\.port/);
    expect(code, `${file} 的占用探测必须复用 portBusy`).toMatch(/portBusy\(/);
  });
});
