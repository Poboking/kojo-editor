/**
 * `debug-cli` 命令面扩展的守卫（1030 调试批第三波：把下层能力接到 CLI 上）。
 *
 * 这一波只加"接线"，没有新判据——所以能钉的不是行为结果，而是**接线本身**：
 * ① `parseArgs` 必须吃掉 `--steps / --dx / --dy / --settle / --repo`（带值参数没吃掉就变位置参数；
 *    本仓库已为此踩过一次坑：`type --mode` 的 mode 被当成待输入文本）；
 * ② 指针坐标是**一个**位置参数 `"x,y"`（拆成两个会和 `drag <起点> <终点>` 打架），
 *    解析失败必须能回显用户写的那串原文；
 * ③ 语义族行列 **1 基**，0 / 缺省 / 非数都在碰 CDP 之前就红；
 * ④ `--json` 是唯一闸门，默认输出逐字不变（有脚本和人在读）；
 * ⑤ 语义族依赖 `evalJs` 的 `awaitPromise`——关掉它，provider 链拿回来的是 Promise 的壳 `{}`，
 *    看起来恰好像"没有结果"，是最坏的一种假阴性。这条钉在 debug-lib 的源码上。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'debug-cli.mjs');
const LIB = path.join(ROOT, 'tools', 'debug-lib.mjs');
const cliSrc = readFileSync(CLI, 'utf8');
const libSrc = readFileSync(LIB, 'utf8');

/**
 * 从源码里抠出 `export function <name>(...) { ... }` 并求值成真函数。
 * 直接 import `debug-cli.mjs` 会把整条 CLI 跑起来（文件末尾就是 main），所以按源码取函数体
 * ——顺带把"它必须自包含（不引用模块级可变状态）"这条口径也钉住了。
 */
function extractFunction(name: string): (...args: any[]) => any {
  const head = `export function ${name}(`;
  const start = cliSrc.indexOf(head);
  expect(start, `${name} 应当被 export（纯函数，供单测直接吃）`).toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end, `${name} 的函数体应当有收尾`).toBeGreaterThan(-1);
  const src = rest.slice(0, end + 3).replace(/^export\s+/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)() as (...args: any[]) => any;
}

const parseArgs = extractFunction('parseArgs');
const parseTargetArg = extractFunction('parseTargetArg');
const parseLineColumn = extractFunction('parseLineColumn');

describe('parseArgs · 带值参数必须被吃掉', () => {
  it('--steps / --dx / --dy / --settle / --repo 都进 opts，不落到 positional', () => {
    const r = parseArgs(['.a', '.b', '--steps', '12', '--dx', '-30', '--dy', '120', '--settle', '250', '--repo', '/tmp/x']);
    expect(r.positional).toEqual(['.a', '.b']);
    expect(r.opts.steps).toBe('12');
    expect(r.opts.dx).toBe('-30');
    expect(r.opts.dy).toBe('120');
    expect(r.opts.settle).toBe('250');
    expect(r.opts.repo).toBe('/tmp/x');
  });

  it('--steps 写在位置参数中间也不会改变 drag 的起终点顺序', () => {
    const r = parseArgs(['--steps', '4', '.from', '.to']);
    expect(r.positional).toEqual(['.from', '.to']);
  });

  it('--json 是布尔开关：进 opts、不进 flags、不进 positional', () => {
    const r = parseArgs(['--json', 'state']);
    expect(r.opts.json).toBe(true);
    expect(r.flags).toEqual([]);
    expect(r.positional).toEqual(['state']);
  });

  it('没有 --json 时 opts.json 缺省（默认形态不许被顺手改成 true）', () => {
    expect(parseArgs(['state']).opts.json).toBeUndefined();
  });
});

describe('parseTargetArg · 坐标是"一个"位置参数', () => {
  it('"x,y"（含负数、小数、空白）⇒ 坐标', () => {
    expect(parseTargetArg('320,480')).toMatchObject({ kind: 'point', x: 320, y: 480 });
    expect(parseTargetArg('-10, 20.5')).toMatchObject({ kind: 'point', x: -10, y: 20.5 });
  });

  it('选择器原样穿过（含带逗号的选择器，只要不以数字打头）', () => {
    expect(parseTargetArg('.monaco-editor')).toMatchObject({ kind: 'selector', selector: '.monaco-editor' });
    expect(parseTargetArg('a[href], b')).toMatchObject({ kind: 'selector' });
  });

  it('看着像坐标但写坏了 ⇒ bad-point 并带回收到的原文', () => {
    expect(parseTargetArg('10,y')).toEqual({ kind: 'bad-point', raw: '10,y' });
    expect(parseTargetArg('10,,20')).toEqual({ kind: 'bad-point', raw: '10,,20' });
    expect(parseTargetArg('10,20,30')).toEqual({ kind: 'bad-point', raw: '10,20,30' });
  });

  it('空 ⇒ missing（调用方据此报"要几个参数"）', () => {
    expect(parseTargetArg(undefined)).toEqual({ kind: 'missing' });
    expect(parseTargetArg('   ')).toEqual({ kind: 'missing' });
  });
});

describe('parseLineColumn · 行列 1 基', () => {
  it('正整数通过，回 { line, column }', () => {
    expect(parseLineColumn('12', '5', 'definition')).toEqual({ ok: true, at: { line: 12, column: 5 } });
  });

  it('0 / 负数 / 非整数 / 缺省都在本地红掉（不像 Monaco 那样静默给错位结果）', () => {
    expect(parseLineColumn('0', '1', 'definition').ok).toBe(false);
    expect(parseLineColumn('1', '0', 'definition').ok).toBe(false);
    expect(parseLineColumn('1.5', '1', 'definition').ok).toBe(false);
    expect(parseLineColumn(undefined, '1', 'definition').ok).toBe(false);
  });

  it('报错带命令名与收到的原文（`definition 3 0` 与 `definition 3` 能分辨）', () => {
    expect(parseLineColumn('3', '0', 'definition').error).toContain('definition');
    expect(parseLineColumn('3', '0', 'definition').error).toContain('「0」');
    expect(parseLineColumn('3', undefined, 'definition').error).toContain('「」');
  });
});

describe('命令面 · 三族都挂在 commands 表上', () => {
  const names = [
    'doctor',
    'hover',
    'dblclick',
    'drag',
    'wheel',
    'definition',
    'references',
    'code-actions',
    'signature',
    'symbols',
    'diagnostics',
  ];

  it.each(names)('%s 在 commands 表里（否则 help 与分发都看不见它）', (name) => {
    // 表项形如 `  hover: () => ...` 或 `  'code-actions': () => ...`
    const re = new RegExp(`^  '?${name.replace(/[-]/g, '\\-')}'?: `, 'm');
    expect(re.test(cliSrc), `commands 表里缺 ${name}`).toBe(true);
  });

  it('help 点明了指针族、语义族与 --json', () => {
    expect(cliSrc).toContain('hover <选择器|"x,y">');
    expect(cliSrc).toContain('definition|references|code-actions|signature <行> <列>');
    expect(cliSrc).toContain('行列 **1 基**');
    expect(cliSrc).toContain('doctor [--json] [--repo <路径>]');
  });
});

describe('--json 闸门 · 默认输出逐字不变', () => {
  it('只有一处 JSON.stringify 闸门（命令里不许各自判 opts.json）', () => {
    const gate = cliSrc.slice(cliSrc.indexOf('function emit('), cliSrc.indexOf('function emit(') + 400);
    expect(gate).toContain('jsonOut');
    expect(gate).toContain('JSON.stringify(value)');
    // 反向守卫：非注释行里 `opts.json` 只出现两次——parseArgs 里收下它、入口把它折成 jsonOut
    const codeReads = cliSrc
      .split('\n')
      .filter((line) => line.includes('opts.json') && !line.includes('//') && !line.trim().startsWith('*'));
    expect(codeReads).toHaveLength(2);
    expect(codeReads[0]).toContain("opts.json = true");
    expect(codeReads[1]).toContain('jsonOut = Boolean(opts.json);');
  });

  it('人类形态的关键字面量都还在（脚本/人照着这几行读）', () => {
    for (const literal of [
      '[ok] wait 满足（',
      '[ok] 断言成立：',
      '（最近 ${reading.count} 条）',
      ' 条${filter ? `，过滤「${filter}」` : \'\'}）',
      'JSON.stringify(report, null, 2)',
    ]) {
      expect(cliSrc, `默认输出丢了「${literal}」`).toContain(literal);
    }
  });
});

describe('语义族 · evalJs 必须 awaitPromise', () => {
  it('Cdp.evalJs 带 awaitPromise: true（关掉它，语义读数会变成空壳，看着像"没有结果"）', () => {
    const body = libSrc.slice(libSrc.indexOf('async evalJs('), libSrc.indexOf('async screenshot('));
    expect(body).toContain('awaitPromise: true');
    expect(body).toContain('returnByValue: true');
  });

  it('语义族调用点都走 querySemantic（行列原样进页内，不做 0 基换算）', () => {
    expect(cliSrc).toContain('return cdp.evalJs(`__kojoDebug.editor.${api}(${at.line}, ${at.column})`, timeoutMs);');
  });
});
