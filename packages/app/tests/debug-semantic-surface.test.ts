/**
 * 调试面 · 跳转与诊断读数（1030 批）的判据。
 *
 * 面上的事：`definitionAt` / `referencesAt` / `codeActionsAt` / `signatureAt` /
 * `documentSymbols` / `diagnostics` 六条读数背后是**第三方 provider**（本仓的 kojo-*、
 * 插件、用户脚本），它们会缺字段、返脏值、返 `{value}` 包装、挂死、抛错。读数进 JSON 之前
 * 唯一的一道整形就是这几枚纯函数，所以这里把**每一条边界都定死**：
 *
 * - 空数组 / null / 非数组 ⇒ `[]` 或 `null`（绝不抛）；
 * - 字段缺失（uri / range / title / name / message / line）⇒ 整条丢弃或给"不编造"的默认值；
 * - 超长文本 ⇒ 按 `slimHoverText` 的口径（300 字符 + `…`）截断；
 * - 跨文件路径归一 ⇒ Windows 反斜杠与 POSIX 斜杠都走同一条前缀比对；
 * - 条数上限 ⇒ 20 / 50 / 30 / 200 / 200。
 *
 * 第二块是**源形状守门**（读源码字符串，形态照 `debug-language-surface.test.ts` 先例）：
 * 这批读数必须真的走 provider 注册表、真的没退回 `getAction` + 私有 DOM 类名。
 * 这一层刻意不碰 DOM / Monaco 运行时：真实链路由 `tools/debug-web-smoke.mjs` 在浏览器里对拍。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  slimCodeActions,
  slimDiagnostics,
  slimLocations,
  slimSignature,
  slimSymbols,
  toRepoRelativePath,
} from '../src/debug/install-debug';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

/* --------------------------- 路径归一（跨文件的核心） --------------------------- */

describe('跳转与诊断 · toRepoRelativePath（URI → 仓库内相对路径）', () => {
  it('Windows 反斜杠路径 + 反斜杠 rootDir ⇒ 正斜杠相对路径', () => {
    expect(toRepoRelativePath('C:\\work\\repo\\packages\\a.kojo', 'C:\\work\\repo')).toBe('packages/a.kojo');
    // rootDir 带尾斜杠也照样剥得干净（不缺、不多吃一个字符）
    expect(toRepoRelativePath('C:\\work\\repo\\a.kojo', 'C:\\work\\repo\\')).toBe('a.kojo');
  });

  it('POSIX 斜杠路径 + POSIX rootDir ⇒ 相对路径', () => {
    expect(toRepoRelativePath('/home/me/repo/packages/a.kojo', '/home/me/repo')).toBe('packages/a.kojo');
  });

  it('file:// URI 的两种形态：盘符（反斜杠/正斜杠混写）与 POSIX', () => {
    expect(toRepoRelativePath('file:///C:/work/repo/packages/a.kojo', 'C:/work/repo')).toBe('packages/a.kojo');
    expect(toRepoRelativePath('file:///C:\\work\\repo\\packages\\a.kojo', 'C:\\work\\repo')).toBe('packages/a.kojo');
    expect(toRepoRelativePath('file:///home/me/repo/src/a.kojo', '/home/me/repo')).toBe('src/a.kojo');
  });

  it('百分号编码先解开再比前缀（URI 里的中文目录）', () => {
    expect(
      toRepoRelativePath('file:///C:/work/repo/%E5%8F%A3%E4%B8%8A/a.kojo', 'C:/work/repo'),
    ).toBe('口上/a.kojo');
  });

  it('前缀比对大小写不敏感（Windows 盘符 / 目录），返回保留原文大小写', () => {
    expect(toRepoRelativePath('file:///c:/Work/Repo/src/A.kojo', 'C:/work/repo')).toBe('src/A.kojo');
  });

  it('前缀必须落在分隔符上：/repo 不许吃掉 /repo2/a.kojo', () => {
    expect(toRepoRelativePath('/srv/repo2/a.kojo', '/srv/repo')).toBe('/srv/repo2/a.kojo');
    // 反过来（文件在根下更浅）也不许硬剥
    expect(toRepoRelativePath('/srv/a.kojo', '/srv/repo')).toBe('/srv/a.kojo');
  });

  it('rootDir 缺失 / 空串 / 非字符串 ⇒ 只归一不改写（不编造相对路径）', () => {
    expect(toRepoRelativePath('C:\\x\\y.kojo')).toBe('C:/x/y.kojo');
    expect(toRepoRelativePath('C:\\x\\y.kojo', '')).toBe('C:/x/y.kojo');
    expect(toRepoRelativePath('/other/a.kojo', 42 as unknown as string)).toBe('/other/a.kojo');
    expect(toRepoRelativePath('   ')).toBe('');
    expect(toRepoRelativePath(null)).toBe('');
    expect(toRepoRelativePath(undefined)).toBe('');
  });

  it('非 file scheme（未落盘模型 inmemory）原样保留：它不是文件路径', () => {
    expect(toRepoRelativePath('inmemory://model/3', 'C:/work/repo')).toBe('inmemory://model/3');
  });
});

/* ----------------------------- 跳转目标裁剪 ----------------------------- */

describe('跳转与诊断 · slimLocations（definition / references 共用）', () => {
  it('空数组 / 非数组 / 脏元素 ⇒ 空数组（绝不抛）', () => {
    expect(slimLocations([])).toEqual([]);
    expect(slimLocations(null)).toEqual([]);
    expect(slimLocations(undefined)).toEqual([]);
    expect(slimLocations('oops')).toEqual([]);
    expect(slimLocations([null, 42, 'x', {}])).toEqual([]);
  });

  it('Location（uri + IRange）照原样出', () => {
    const raw = [
      {
        uri: 'file:///C:/work/repo/a.kojo',
        range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 9 },
      },
    ];
    expect(slimLocations(raw, { rootDir: 'C:/work/repo' })).toEqual([{ path: 'a.kojo', line: 3, column: 5 }]);
  });

  it('LocationLink 走 targetSelectionRange（选区中心），不是整个 targetRange', () => {
    const link = {
      targetUri: 'file:///home/me/repo/b.kojo',
      targetRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 },
      targetSelectionRange: { startLineNumber: 4, startColumn: 2, endLineNumber: 4, endColumn: 6 },
    };
    expect(slimLocations([link], { rootDir: '/home/me/repo' })).toEqual([{ path: 'b.kojo', line: 4, column: 2 }]);
  });

  it('嵌套 Position 形态（start:{lineNumber}）也认；列缺失 ⇒ 1', () => {
    expect(slimLocations([{ uri: '/repo/x.kojo', range: { start: { lineNumber: 7 } } }], { rootDir: '/repo' })).toEqual([
      { path: 'x.kojo', line: 7, column: 1 },
    ]);
  });

  it('缺 uri / 缺 range / 行号非正 ⇒ 整条丢弃（不让脏条目污染 total）', () => {
    expect(slimLocations([{ range: { startLineNumber: 1, startColumn: 1 } }])).toEqual([]);
    expect(slimLocations([{ uri: '/repo/a.kojo' }])).toEqual([]);
    expect(slimLocations([{ uri: '/repo/a.kojo', range: { startLineNumber: 0, startColumn: 3 } }])).toEqual([]);
    expect(slimLocations([{ uri: '/repo/a.kojo', range: { startLineNumber: 2.9, startColumn: 3.9 } }], { rootDir: '/repo' })).toEqual([
      { path: 'a.kojo', line: 2, column: 3 },
    ]);
  });

  it('默认上限 20 条（前 20 条按 provider 顺序保留）', () => {
    const many = Array.from({ length: 25 }, (_v, i) => ({
      uri: `/repo/f${i}.kojo`,
      range: { startLineNumber: i + 1, startColumn: 1 },
    }));
    const out = slimLocations(many, { rootDir: '/repo' });
    expect(out).toHaveLength(20);
    expect(out[0]).toEqual({ path: 'f0.kojo', line: 1, column: 1 });
    expect(out[19]).toEqual({ path: 'f19.kojo', line: 20, column: 1 });
  });

  it('limit 可显式抬到 50（referencesAt 的口径）', () => {
    const many = Array.from({ length: 70 }, (_v, i) => ({
      uri: `/repo/f${i}.kojo`,
      range: { startLineNumber: 1, startColumn: 1 },
    }));
    const out = slimLocations(many, { rootDir: '/repo', limit: 50 });
    expect(out).toHaveLength(50);
    expect(out[49]?.path).toBe('f49.kojo');
  });

  it('跨文件混合：Windows / POSIX 两个 target 归一进同一把尺', () => {
    const out = slimLocations(
      [
        { uri: 'file:///C:/work/repo/a.kojo', range: { startLineNumber: 1, startColumn: 1 } },
        { uri: 'file:///home/me/repo/b.kojo', range: { startLineNumber: 2, startColumn: 1 } },
      ],
      { rootDir: 'C:/work/repo' },
    );
    // 第二份不在这个 rootDir 下 ⇒ 保留归一后的绝对路径（不硬算、也不丢）
    expect(out).toEqual([
      { path: 'a.kojo', line: 1, column: 1 },
      { path: '/home/me/repo/b.kojo', line: 2, column: 1 },
    ]);
  });
});

/* ----------------------------- 动作表裁剪 ----------------------------- */

describe('跳转与诊断 · slimCodeActions（快速修复 / 重构，只读）', () => {
  it('完整动作：title / kind / isPreferred / hasEdit 四键齐全', () => {
    const raw = [
      {
        title: '转成双引号',
        kind: 'quickfix',
        isPreferred: true,
        edit: { edits: [{ resource: 'file:///repo/a.kojo', textEdit: { range: {}, text: 'x' } }] },
      },
    ];
    expect(slimCodeActions(raw)).toEqual([
      { title: '转成双引号', kind: 'quickfix', isPreferred: true, hasEdit: true },
    ]);
  });

  it('isPreferred 只认字面量 true（字符串 / 1 都不算）', () => {
    expect(slimCodeActions([{ title: 'a', isPreferred: 'true' }])[0]?.isPreferred).toBe(false);
    expect(slimCodeActions([{ title: 'a', isPreferred: 1 }])[0]?.isPreferred).toBe(false);
    expect(slimCodeActions([{ title: 'a' }])[0]?.isPreferred).toBe(false);
  });

  it('hasEdit：空 edits / 缺 edit / 只有 command 都当 false（读数不含 edit 内容）', () => {
    expect(slimCodeActions([{ title: 'a', edit: { edits: [] } }])[0]?.hasEdit).toBe(false);
    expect(slimCodeActions([{ title: 'a', edit: {} }])[0]?.hasEdit).toBe(false);
    expect(slimCodeActions([{ title: 'a', command: { id: 'kojo.x', title: 'x' } }])[0]?.hasEdit).toBe(false);
    expect(slimCodeActions([{ title: 'a', edit: { edits: [{}, {}] } }])[0]?.hasEdit).toBe(true);
  });

  it('缺 title ⇒ 整条丢弃；缺 kind ⇒ 空串（不是 null）', () => {
    expect(slimCodeActions([{ kind: 'quickfix' }, null, 42])).toEqual([]);
    const [only] = slimCodeActions([{ title: 'refactor it' }]);
    expect(only).toEqual({ title: 'refactor it', kind: '', isPreferred: false, hasEdit: false });
  });

  it('默认上限 30 条', () => {
    const many = Array.from({ length: 40 }, (_v, i) => ({ title: `动作 ${i}` }));
    const out = slimCodeActions(many);
    expect(out).toHaveLength(30);
    expect(out[29]?.title).toBe('动作 29');
  });

  it('超长 title 按 300 字符截断并加省略号（与 slimHoverText 同口径）；换行归一成单行', () => {
    const long = slimCodeActions([{ title: 'x'.repeat(400) }])[0]?.title ?? '';
    expect(long.length).toBe(301);
    expect(long.endsWith('…')).toBe(true);
    expect(slimCodeActions([{ title: ' 多行\n标题 ' }])[0]?.title).toBe('多行 标题');
  });

  it('空数组 / 非数组 ⇒ 空数组', () => {
    expect(slimCodeActions([])).toEqual([]);
    expect(slimCodeActions(null)).toEqual([]);
    expect(slimCodeActions({ actions: [] })).toEqual([]);
  });
});

/* ----------------------------- 签名裁剪 ----------------------------- */

describe('跳转与诊断 · slimSignature（参数提示）', () => {
  it('null / 非对象 / 空 signatures ⇒ null', () => {
    expect(slimSignature(null)).toBeNull();
    expect(slimSignature(undefined)).toBeNull();
    expect(slimSignature(42)).toBeNull();
    expect(slimSignature({})).toBeNull();
    expect(slimSignature({ signatures: [] })).toBeNull();
    expect(slimSignature({ signatures: [null] })).toBeNull();
  });

  it('基础形状：label / activeParameter / parameters / documentation', () => {
    const raw = {
      signatures: [
        {
          label: '口上(引数)',
          parameters: [{ label: '第一' }, '第二'],
          documentation: '说明',
        },
      ],
      activeSignature: 0,
      activeParameter: 1,
    };
    expect(slimSignature(raw)).toEqual({
      label: '口上(引数)',
      activeParameter: 1,
      parameters: ['第一', '第二'],
      documentation: '说明',
    });
  });

  it('documentation 是 {value} 时取 value；为空 ⇒ 不挂键（空值不挂键纪律）', () => {
    expect(slimSignature({ signatures: [{ label: 'f()', documentation: { value: ' **粗** ' } }] })).toEqual({
      label: 'f()',
      activeParameter: 0,
      parameters: [],
      documentation: '**粗**',
    });
    const noDoc = slimSignature({ signatures: [{ label: 'f()', documentation: { value: '  ' } }] });
    expect(noDoc).toEqual({ label: 'f()', activeParameter: 0, parameters: [] });
    expect(noDoc && 'documentation' in noDoc).toBe(false);
  });

  it('provider 返 {value, dispose} 形态时自动解包', () => {
    expect(slimSignature({ value: { signatures: [{ label: 'g()' }], activeSignature: 0 } })).toEqual({
      label: 'g()',
      activeParameter: 0,
      parameters: [],
    });
  });

  it('activeSignature 越界夹到最后一个；activeParameter 非数 ⇒ 0、超范围夹到 99', () => {
    const two = { signatures: [{ label: 'first' }, { label: 'second' }], activeSignature: 9 };
    expect(slimSignature(two)?.label).toBe('second');
    expect(slimSignature({ signatures: [{ label: 'f' }], activeParameter: 'x' })?.activeParameter).toBe(0);
    expect(slimSignature({ signatures: [{ label: 'f' }], activeParameter: 1000 })?.activeParameter).toBe(99);
  });

  it('缺 label ⇒ null；参数表缺失 ⇒ []；超量参数截 50 条', () => {
    expect(slimSignature({ signatures: [{ parameters: ['a'] }] })).toBeNull();
    expect(slimSignature({ signatures: [{ label: 'f' }] })?.parameters).toEqual([]);
    const parameters = Array.from({ length: 60 }, (_v, i) => `p${i}`);
    const reading = slimSignature({ signatures: [{ label: 'f', parameters }] });
    expect(reading?.parameters).toHaveLength(50);
    expect(reading?.parameters[49]).toBe('p49');
  });

  it('超长 label 按 300 字符截断（签名行可能把整段文档塞进来）', () => {
    const label = slimSignature({ signatures: [{ label: 'y'.repeat(400) }] })?.label ?? '';
    expect(label.length).toBe(301);
    expect(label.endsWith('…')).toBe(true);
  });
});

/* ----------------------------- 符号树裁剪 ----------------------------- */

describe('跳转与诊断 · slimSymbols（文档符号树压平）', () => {
  it('空数组 / 非数组 ⇒ 空数组', () => {
    expect(slimSymbols([])).toEqual([]);
    expect(slimSymbols(null)).toEqual([]);
    expect(slimSymbols('x')).toEqual([]);
  });

  it('父子压平成 depth：0 顶层 / 1 子 / 2 孙，且**前序**保留兄弟顺序', () => {
    const tree = [
      {
        name: '口上',
        kind: 12,
        children: [{ name: 'あ行', kind: 12, children: [{ name: 'default', kind: 8 }] }, { name: 'か行', kind: 12 }],
      },
      { name: 'EVENT', kind: 5 },
    ];
    expect(slimSymbols(tree)).toEqual([
      { name: '口上', kind: 12, depth: 0 },
      { name: 'あ行', kind: 12, depth: 1 },
      { name: 'default', kind: 8, depth: 2 },
      { name: 'か行', kind: 12, depth: 1 },
      { name: 'EVENT', kind: 5, depth: 0 },
    ]);
  });

  it('缺 name ⇒ 连子树一起丢（无主条目对调试没有价值）', () => {
    expect(slimSymbols([{ children: [{ name: '孤儿' }], kind: 12 }])).toEqual([]);
    expect(slimSymbols([{ name: '   ', kind: 12, children: [{ name: 'x' }] }])).toEqual([]);
  });

  it('kind 缺失 / 非数字 ⇒ 0 = 未知（不猜成 Function 之类）', () => {
    expect(slimSymbols([{ name: '无 kind' }])).toEqual([{ name: '无 kind', kind: 0, depth: 0 }]);
    expect(slimSymbols([{ name: 'a', kind: '12' }])).toEqual([{ name: 'a', kind: 0, depth: 0 }]);
    expect(slimSymbols([{ name: 'a', kind: 8.9 }])).toEqual([{ name: 'a', kind: 8, depth: 0 }]);
  });

  it('默认上限 200 条（宽树也只取前 200）', () => {
    const wide = Array.from({ length: 300 }, (_v, i) => ({ name: `s${i}`, kind: 12 }));
    const out = slimSymbols(wide);
    expect(out).toHaveLength(200);
    expect(out[0]?.name).toBe('s0');
    expect(out[199]?.name).toBe('s199');
  });

  it('超长符号名按 300 字符截断', () => {
    const name = slimSymbols([{ name: 'z'.repeat(400), kind: 12 }])[0]?.name ?? '';
    expect(name.length).toBe(301);
    expect(name.endsWith('…')).toBe(true);
  });

  it('环状 children 不打爆（深度护栏：超过 20 层不再下钻）', () => {
    const deep: { name: string; kind: number; children?: unknown[] } = { name: 'd0', kind: 12 };
    let cursor = deep;
    for (let i = 1; i < 60; i += 1) {
      const next = { name: `d${i}`, kind: 12 };
      cursor.children = [next];
      cursor = next;
    }
    const out = slimSymbols([deep]);
    expect(out.length).toBe(21); // depth 0..20（20 层之后不再下钻）
    expect(out[out.length - 1]?.depth).toBe(20);
  });
});

/* ----------------------------- 诊断裁剪 ----------------------------- */

describe('跳转与诊断 · slimDiagnostics（只加作用域与裁剪）', () => {
  it('空数组 / 非数组 ⇒ 空数组', () => {
    expect(slimDiagnostics([])).toEqual([]);
    expect(slimDiagnostics(null)).toEqual([]);
    expect(slimDiagnostics('x')).toEqual([]);
  });

  it('契约形态照原样裁剪（severity 与 markers() 同口径：8 = Error）', () => {
    const raw = [{ severity: 8, message: '未知函数 foo', line: 12, column: 3, source: 'kojo-lang' }];
    expect(slimDiagnostics(raw)).toEqual([
      { severity: 8, message: '未知函数 foo', line: 12, column: 3, source: 'kojo-lang' },
    ]);
  });

  it('markers 形态（startLineNumber / startColumn）也认：复用同一条取数腿', () => {
    const raw = [{ severity: 4, message: '空口上', startLineNumber: 5, startColumn: 7, source: 'kojo' }];
    expect(slimDiagnostics(raw)).toEqual([{ severity: 4, message: '空口上', line: 5, column: 7, source: 'kojo' }]);
  });

  it('缺 message / 缺行号 ⇒ 整条丢弃；severity 缺 ⇒ 0、column 缺 ⇒ 1', () => {
    expect(slimDiagnostics([{ line: 1 }, { message: 'x' }, null, 42])).toEqual([]);
    expect(slimDiagnostics([{ message: 'x', line: 2 }])).toEqual([
      { severity: 0, message: 'x', line: 2, column: 1 },
    ]);
  });

  it('source 为空串 / 缺失 ⇒ 不挂键（空值不挂键）', () => {
    const [withEmpty] = slimDiagnostics([{ message: 'm', line: 1, source: '   ' }]);
    expect(withEmpty).toEqual({ severity: 0, message: 'm', line: 1, column: 1 });
    expect(withEmpty && 'source' in withEmpty).toBe(false);
  });

  it('超长 message 按 300 字符截断；换行归一成单行', () => {
    const message = slimDiagnostics([{ message: 'w'.repeat(400), line: 1 }])[0]?.message ?? '';
    expect(message.length).toBe(301);
    expect(message.endsWith('…')).toBe(true);
    expect(slimDiagnostics([{ message: ' 第一行\n第二行 ', line: 1 }])[0]?.message).toBe('第一行 第二行');
  });

  it('默认上限 200 条', () => {
    const many = Array.from({ length: 260 }, (_v, i) => ({ message: `m${i}`, line: i + 1 }));
    const out = slimDiagnostics(many);
    expect(out).toHaveLength(200);
    expect(out[199]?.message).toBe('m199');
  });
});

/* ----------------------------- 源形状守门 ----------------------------- */

describe('跳转与诊断 · 源形状守门（provider 链 + 只读 + 不碰私有 DOM）', () => {
  const source = read('packages/app/src/debug/install-debug.ts');

  const sliceFrom = (anchor: string, length = 2600): string => {
    const at = source.indexOf(anchor);
    expect(at, `install-debug.ts 里找不到锚点：${anchor}`).toBeGreaterThanOrEqual(0);
    return source.slice(at, at + length);
  };

  it('六条读数都在公开接口上（KojoDebugApi.editor 是契约面）', () => {
    const apiSlice = sliceFrom('export interface KojoDebugApi {', 4200);
    for (const member of [
      'definitionAt(line: number',
      'referencesAt(line: number',
      'codeActionsAt(line: number',
      'signatureAt(line: number',
      'documentSymbols(): Promise<DebugSymbol[]>',
      'diagnostics(): Promise<DebugDiagnostic[]>',
    ]) {
      expect(apiSlice, `KojoDebugApi.editor 缺 ${member}`).toContain(member);
    }
  });

  it('走的是 provider 注册表（ILanguageFeaturesService），不是 revealDefinition / quickFix 动作', () => {
    for (const name of [
      'definitionProvider',
      'referenceProvider',
      'codeActionProvider',
      'signatureHelpProvider',
      'documentSymbolProvider',
    ]) {
      expect(source, `取数腿缺注册表 ${name}`).toContain(name);
    }
    expect(source).toContain('StandaloneServices');
    expect(source).toContain('ILanguageFeaturesService');
    // 动作链一条都不该有：那三条都是"点下去会动编辑器"的动作，不是查询
    expect(source).not.toContain("getAction('editor.action.revealDefinition')");
    expect(source).not.toContain("getAction('editor.action.quickFix')");
  });

  it('新读数不碰私有 DOM 类名（.monaco-hover 那一类只归 selfCheck）', () => {
    const at = source.indexOf('function languageFeaturesService(');
    const end = source.indexOf('/* --------------------------- 自检读数');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(at);
    const leg = source.slice(at, end);
    expect(leg).not.toContain('querySelector');
    expect(leg).not.toContain('.monaco-hover');
    expect(leg).not.toContain('document.');
    // 每条 provider 调用都过超时护栏（provider 挂死不许拖住调试面）
    expect(leg).toContain('callWithin(');
    expect(leg).toContain('CancellationTokenSource');
  });

  it('六条方法各自吞错：无焦点编辑器 / 注册表不可用都回空读数，不抛', () => {
    for (const anchor of [
      'async definitionAt(line, column, opts)',
      'async referencesAt(line, column, opts)',
      'async codeActionsAt(line, column, opts)',
      'async signatureAt(line, column, opts)',
      'async documentSymbols()',
      'async diagnostics()',
    ]) {
      const body = sliceFrom(anchor, 1400);
      expect(body, `${anchor} 缺 catch`).toContain('catch {');
    }
    // referencesAt 的空读数是 {items, total} 两键（不是裸数组）
    expect(sliceFrom('async referencesAt(line, column, opts)', 1400)).toContain('{ items: [], total: 0 }');
  });
});
