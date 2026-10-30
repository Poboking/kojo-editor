/**
 * `debug-cli open-project` 快速失败 + `type --mode` 的守卫（2026-10-30 第二批 G 车道）。
 *
 * 事由（遗留 1）：对"不是工程根"的目录（`fixtures/sugar`：只有 .kojo、没有 CSV/ERB）应用会
 * **当场拒绝**并退回欢迎页，旧实现却只轮询「写权限弹窗 / 文件树」⇒ 一路等到第 4 步 60s 超时，
 * 抛的是「写权限审批 / 文件树」。用户读到的是"超时"，不是"不接受这个目录"。
 *
 * 钉的口径：
 * ① `classifyOpenFailure` 是**纯函数**（不碰 CDP），**只在明确有错时**返回 `{reason}`：
 *    正常中间态（opening / 树已出 / 写权限弹窗在场）一律 null——判死正常路径比"多等 60s"更糟；
 * ② 三条失败信号：`.notice.error` 原文 / `state().notices` 关键词 / 超过 1.5s 仍回流欢迎页；
 * ③ `open-project --timeout <ms>` 必须由 parseArgs 吃掉（带值参数，不许当位置参数）；
 * ④ `type --mode keys|ime` 走真实键盘 / 输入法路径（`imeSetComposition` 在场，不支持时如实红）。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'tools', 'debug-cli.mjs');
const cliSrc = readFileSync(CLI, 'utf8');

/**
 * 从源码里抠出 `export function <name>(...) { ... }` 并求值成真函数。
 * 直接 import `debug-cli.mjs` 会把整条 CLI 跑起来（文件末尾就是 main），所以按源码取函数体
 * ——顺带把"它必须自包含（不引用模块级可变状态）"这条口径也钉住了。
 */
function extractFunction(name: string): (...args: unknown[]) => unknown {
  const head = `export function ${name}(`;
  const start = cliSrc.indexOf(head);
  expect(start, `${name} 应当被 export（纯函数，供单测直接吃）`).toBeGreaterThan(-1);
  const rest = cliSrc.slice(start);
  const end = rest.indexOf('\n}\n');
  expect(end, `${name} 的函数体应当有收尾`).toBeGreaterThan(-1);
  const src = rest.slice(0, end + 3).replace(/^export\s+/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)() as (...args: unknown[]) => unknown;
}

type Verdict = { reason: string } | null;
const classifyOpenFailure = extractFunction('classifyOpenFailure') as (snap: unknown) => Verdict;

/** 正常中间态的统一底片（opening、没树、没弹窗、没通知） */
const midOpen = { notices: [] as string[], phase: 'opening', hasTree: false, modal: false };

describe('classifyOpenFailure：只在明确有错时判失败', () => {
  it('正常中间态（opening、未出树、未弹窗）→ null', () => {
    expect(classifyOpenFailure({ ...midOpen })).toBeNull();
    // 刚点开（还没到 1.5s 宽限）时欢迎页仍在场也**不是**失败
    expect(classifyOpenFailure({ ...midOpen, phase: 'welcome', revertedMs: 300 })).toBeNull();
  });

  it('error notice 命中 → 带应用原文', () => {
    const reason = '这个文件夹里没有找到 CSV / ERB，看起来不是游戏目录';
    const verdict = classifyOpenFailure({ ...midOpen, phase: 'welcome', errorNotices: [reason], revertedMs: 600 });
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toBe(reason);
  });

  it('state().notices 关键词命中 → 带原文（打开/失败/不支持/不是 任一）', () => {
    for (const text of [
      '打开项目失败：目录不可读',
      '写入失败：只读挂载',
      '本版本不支持该工程格式',
      '这不是工程根',
    ]) {
      const verdict = classifyOpenFailure({ ...midOpen, notices: [text] });
      expect(verdict, `关键词命中应当判失败：${text}`).not.toBeNull();
      expect(verdict?.reason).toBe(text);
    }
    // 不带失败关键词的通知不判死（欢迎页那条"内核装配中…"就是常态）
    expect(classifyOpenFailure({ ...midOpen, notices: ['内核装配中…'] })).toBeNull();
  });

  it('welcome 回流（phase=welcome、无树、超过 1.5s）→ 命中', () => {
    const verdict = classifyOpenFailure({ ...midOpen, phase: 'welcome', revertedMs: 1600 });
    expect(verdict).not.toBeNull();
    expect(String(verdict?.reason)).toContain('欢迎页');
    // 边界：刚好 1500ms 也算回流（宽限是按"超过"给的）
    expect(classifyOpenFailure({ ...midOpen, phase: 'welcome', revertedMs: 1500 })).not.toBeNull();
  });

  it('写权限弹窗出现 → null（应用接受了目录，正常等审批）', () => {
    expect(classifyOpenFailure({ ...midOpen, modal: true })).toBeNull();
    // 弹窗在场时即便有残留通知也不判死（弹窗才是当前真信号）
    expect(classifyOpenFailure({ ...midOpen, modal: true, phase: 'welcome', revertedMs: 5000 })).toBeNull();
  });

  it('文件树已在场 → null（成功路径绝不能被判死）', () => {
    expect(classifyOpenFailure({ ...midOpen, hasTree: true, phase: 'project' })).toBeNull();
    expect(classifyOpenFailure({ ...midOpen, hasTree: true, phase: 'welcome', revertedMs: 9000 })).toBeNull();
  });

  it('空/畸形入参不抛（缺字段＝没有信号，不是失败）', () => {
    expect(classifyOpenFailure(undefined)).toBeNull();
    expect(classifyOpenFailure({})).toBeNull();
    expect(classifyOpenFailure({ notices: null, phase: null, hasTree: null, modal: null })).toBeNull();
  });
});

describe('debug-cli 源形状钉子', () => {
  it('① open-project 第 4 步真的调用 classifyOpenFailure 并抛固定文案', () => {
    const start = cliSrc.indexOf('async function cmdOpenProject(');
    expect(start).toBeGreaterThan(-1);
    const body = cliSrc.slice(start, cliSrc.indexOf('\nasync function cmdOpenFile('));
    expect(body).toContain('classifyOpenFailure(');
    expect(body).toContain('throw openRejectedError(abs, said || verdict.reason)');
    // 原文优先取应用新说的那句话（`.toast-error`），判据本身仍由纯函数给
    expect(body).toContain('freshToasts');
    expect(body).toContain('errorToasts');
    // 固定文案住在 openRejectedError（单一出处），形态与契约逐字一致
    expect(cliSrc).toContain('不是工程根或缺权限，换目录或先看 dom 通知');
    // 失败必须 exit 1（2 是"前置不满足"，这里应用明确拒了这次打开）
    expect(body).toContain('failure?.kojoOpenRejected');
    expect(body).toContain('die(failure.message, 1)');
  });

  it('② --timeout 在 parseArgs 的带值分支里被吃掉，并夹到 [3000,300000]', () => {
    const start = cliSrc.indexOf('function parseArgs(argv) {');
    expect(start).toBeGreaterThan(-1);
    const body = cliSrc.slice(start, cliSrc.indexOf('const [rawCmd, ...rest] = process.argv.slice(2);'));
    expect(body).toContain("a === '--timeout'");
    expect(body).toContain('opts.timeout = argv[++i]');
    expect(body).toContain("a === '--mode'");
    expect(body).toContain('opts.mode = argv[++i]');
    // 夹取常量在场（默认 60000，上下界 3000 / 300000）
    expect(cliSrc).toContain('OPEN_TIMEOUT_DEFAULT_MS = 60000');
    expect(cliSrc).toContain('OPEN_TIMEOUT_MIN_MS = 3000');
    expect(cliSrc).toContain('OPEN_TIMEOUT_MAX_MS = 300000');
    expect(cliSrc).toContain('clampOpenTimeout(args?.timeout)');
  });

  it('③ type 的 keys/ime 走真实输入路径（imeSetComposition 在场，non-BMP 有 fallback 计数）', () => {
    expect(cliSrc).toContain('Input.imeSetComposition');
    expect(cliSrc).toContain('selectionStart: text.length');
    expect(cliSrc).toContain('fallback');
    expect(cliSrc).toContain("type: 'keyDown'");
    expect(cliSrc).toContain("type: 'char'");
    expect(cliSrc).toContain("type: 'keyUp'");
    // 默认分支必须**仍是** insertText 直插（text 模式行为逐字不变）
    const start = cliSrc.indexOf('async function cmdType(');
    const body = cliSrc.slice(start, cliSrc.indexOf('\nasync function cmdKey('));
    expect(body).toContain("if (modeNorm === 'text')");
    expect(body).toContain("await cdp.send('Input.insertText', { text });");
  });

  it('④ 真壳 --writable 仍拒绝（exit 2 不变），文案给两条可走路径', () => {
    const start = cliSrc.indexOf('async function cmdOpenProject(');
    const body = cliSrc.slice(start, cliSrc.indexOf('\nasync function cmdOpenFile('));
    expect(body).toContain('不支持 --writable');
    expect(body).toContain('可走的两条路');
    expect(body).toContain('serve');
    expect(body).toMatch(/PITFALLS §160\/§161/);
  });

  it('⑤ status 复用的 cdpForSession 有不退出分支（die 是 process.exit，会污染返回码）', () => {
    // 病根（H 车道实测）：浏览器退出后 status 复用 cdpForSession，后者直接 die() ⇒ 读数被
    // 变成一次 exit 2，"三件套健康"的返回码含义不再可信。
    expect(cliSrc).toContain('dieOnError = true } = {}');
    expect(cliSrc).toContain('if (!mustHavePage || !dieOnError) return null;');
    const start = cliSrc.indexOf('async function cmdStatus()');
    expect(start).toBeGreaterThan(-1);
    const body = cliSrc.slice(start, cliSrc.indexOf('async function cmdStop()'));
    expect(body).toContain('cdpForSession(s, { dieOnError: false })');
    expect(body).toContain('cdpWhy');
  });

  it('⑥ 相位不对＝干净文案 + exit 2（不再 throw 到顶层打整段堆栈）', () => {
    const start = cliSrc.indexOf('async function cmdOpenProject(');
    const body = cliSrc.slice(start, cliSrc.indexOf('\nasync function cmdOpenFile('));
    // 文案一句给全下一步（close-project），且与相位拼在一起
    expect(body).toContain('[FAIL] 当前相位是 ${phase}（已开着别的项目）');
    expect(body).toContain('先 node tools/debug-cli.mjs close-project 回到欢迎相位，再跑本命令');
    // 走标记 + 出口 die(...,2)：不是直接 throw 给顶层
    expect(body).toContain('err.kojoPhaseMismatch = true');
    expect(body).toContain('die(failure.message, 2)');
    expect(body).not.toContain('（close-project 跑的就是命令面板里的 workbench.closeProject，回到欢迎相位后再跑本命令）');
  });
});
