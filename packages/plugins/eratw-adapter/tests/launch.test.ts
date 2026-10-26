/**
 * eraTW 启动面（`GameLaunchAdapter`）—— **结构面单元测试**（不依赖真语料盘）。
 *
 * 覆盖的三类判据，缺一条就会出现"能建实例但跑不起来"或"建了指向空气的实例"：
 * 1. **探测**：一个 exe / 多个 exe / 零 exe / 目录读不动，四种结果各自如实（零候选不抛）；
 * 2. **寻址**：`candidateId` 不在探测结果里 ⇒ `LAUNCHER_EXECUTABLE_INVALID`（与
 *    `launcher-core::instanceStore.create` 同一码语义）；exe 相对路径永远相对、无 `..`、无盘符；
 * 3. **布局**：存档根 / 内容根**按盘上真有的目录**产出，缺目录如实省略（绝不给不存在的路径）。
 *
 * io 用内联假实现（可注入"目录读失败"与"恶意文件名"这两类真盘造不出来的边界）；
 * 另有两条用**生产同一条** `FileIOServiceImpl` + 临时目录，防"假 io 与真 io 语义漂开"。
 * 真盘守卫在 `launch.corpus.test.ts`（`KOJO_*` 守门，语料不在位整例跳过）。
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DirEntry, LaunchProfile, LogParseRules, Logger } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { EratwLaunchError, createEratwLaunchAdapter } from '../src/launch';

/* ------------------------------- 测试地面 ------------------------------- */

/** 假游戏根（沿用本仓测试里 `G:/game` 的习惯写法；盘符只在这里出现，不参与断言） */
const ROOT = 'G:/game';

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface IoSpec {
  /** 根层文件名 */
  readonly files?: readonly string[];
  /** 根层子目录名 */
  readonly dirs?: readonly string[];
  /** `listDir` 直接抛（模拟目录被删 / 无权限） */
  readonly listThrows?: boolean;
  /** `exists` 直接抛（模拟路径判定失败） */
  readonly existsThrows?: boolean;
}

/** 只实现 `listDir` / `exists` 的假 io（= `EratwLaunchDeps.io` 的两件套） */
function ioOf(spec: IoSpec): {
  listDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
} {
  const files = [...(spec.files ?? [])];
  const dirs = [...(spec.dirs ?? [])];
  return {
    async listDir(dirPath: string): Promise<DirEntry[]> {
      if (spec.listThrows) throw new Error('ENOENT: no such directory');
      if (normalize(dirPath).toLowerCase() !== ROOT.toLowerCase()) {
        throw new Error(`ENOENT: ${dirPath}`);
      }
      return [
        ...dirs.map((name) => ({ name, path: `${ROOT}/${name}`, isDirectory: true })),
        ...files.map((name) => ({ name, path: `${ROOT}/${name}`, isDirectory: false })),
      ];
    },
    async exists(target: string): Promise<boolean> {
      if (spec.existsThrows) throw new Error('stat failed');
      const rel = normalize(target).slice(ROOT.length).replace(/^\//, '');
      return dirs.includes(rel) || files.includes(rel);
    },
  };
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/');
}

function adapterOf(spec: IoSpec) {
  return createEratwLaunchAdapter({ io: ioOf(spec), log: silentLog });
}

/** 带齐 `ERB/` `CSV/` `resources/` `sav/` 的"完整盘"根目录名（内容根三条全在位） */
const FULL_DIRS = ['ERB', 'CSV', 'resources', 'sav'] as const;

/** 实测的两档 exe（本机取证：eraTW 4.980 画蛇添足版根层） */
const MEASURED_X64 = 'Emuera_LazyLoadingV3.0_x64.exe';
const MEASURED_X86 = 'Emuera_LazyLoadingV3.0_x86.exe';

/** 断言 `buildProfile` 抛的是一枚可被 core 归一的启动错误（码 + 中文话术 + detail） */
async function expectLaunchError(run: () => Promise<unknown>, code: string): Promise<EratwLaunchError> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  const err = caught as EratwLaunchError;
  expect(err).toBeInstanceOf(EratwLaunchError);
  expect(err.code).toBe(code);
  expect(err.retryable).toBe(false);
  expect(err.message).toMatch(/[\u4e00-\u9fff]/); // 中文（英文串会被 core 压成默认话术）
  expect(err.detail.length).toBeGreaterThan(0);
  return err;
}

/* ══════════════════════════════════ 探测 ══════════════════════════════════ */

describe('probe：只读探测候选', () => {
  it('零 exe ⇒ 空数组（不抛）', async () => {
    const adapter = adapterOf({ files: ['emuera.config', 'README.zh.md'], dirs: ['ERB', 'CSV'] });
    await expect(adapter.probe(ROOT)).resolves.toEqual([]);
  });

  it('根目录读不动 ⇒ 空数组（不抛：没有候选就是没有候选）', async () => {
    const adapter = adapterOf({ listThrows: true });
    await expect(adapter.probe(ROOT)).resolves.toEqual([]);
  });

  it('同名目录不算可执行体（isDirectory 的条目被跳过）', async () => {
    const adapter = adapterOf({ dirs: ['Emuera_x64.exe'], files: [] });
    await expect(adapter.probe(ROOT)).resolves.toEqual([]);
  });

  it('只有一个家族 exe ⇒ 一个候选；档位未知就不给 arch（不拿 any 冒充）', async () => {
    const adapter = adapterOf({ files: ['Emuera.exe', 'README.md'], dirs: ['ERB', 'CSV'] });
    const candidates = await adapter.probe(ROOT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'eratw-emuera',
      executableRelativePath: 'Emuera.exe',
    });
    expect(candidates[0]?.arch).toBeUndefined();
  });

  it('实测两档并存 ⇒ 两个候选，x64 在前且带「推荐」，档位各有取值', async () => {
    const adapter = adapterOf({ files: [MEASURED_X86, MEASURED_X64], dirs: ['ERB', 'CSV'] });
    const candidates = await adapter.probe(ROOT);
    expect(candidates.map((c) => c.id)).toEqual(['eratw-lazyloading-x64', 'eratw-lazyloading-x86']);
    expect(candidates.map((c) => c.arch)).toEqual(['x64', 'x86']);
    expect(candidates[0]?.label).toContain('推荐');
    expect(candidates[0]?.label).toContain('eraTW');
    // 推荐位只能靠排序 + label 表达（契约没有 recommended 字段），说明进 notes
    expect(candidates[0]?.notes).toContain('本机实测');
  });

  it('家族外的 exe（update.exe 一类）不进候选；家族内的一律进（不推荐）', async () => {
    const adapter = adapterOf({
      files: [MEASURED_X64, 'Emuera1824中文版.exe', 'update.exe', 'SoundTouch.dll'],
      dirs: ['ERB', 'CSV'],
    });
    const candidates = await adapter.probe(ROOT);
    expect(candidates.map((c) => c.executableRelativePath)).toEqual([
      MEASURED_X64,
      'Emuera1824中文版.exe',
    ]);
    expect(candidates[1]?.id).toBe('eratw-emuera1824');
    expect(candidates[1]?.notes).toContain('未知');
  });

  it('家族名里的档位标记能被认出来（x86 / x64），认不出则不给 arch', async () => {
    const adapter = adapterOf({
      files: ['Emuera_x86.exe', 'Emuera_x64.exe', 'Emuera.NET 1824+v22.exe'],
      dirs: ['ERB', 'CSV'],
    });
    const byName = new Map((await adapter.probe(ROOT)).map((c) => [c.executableRelativePath, c]));
    expect(byName.get('Emuera_x86.exe')?.arch).toBe('x86');
    expect(byName.get('Emuera_x64.exe')?.arch).toBe('x64');
    expect(byName.get('Emuera.NET 1824+v22.exe')?.arch).toBeUndefined();
  });

  it('候选 id 唯一且稳定（两个名字 slug 撞车时加序号，顺序可复现）', async () => {
    const adapter = adapterOf({ files: ['Emuera中文版.exe', 'Emuera英文版.exe'], dirs: ['ERB'] });
    const ids = (await adapter.probe(ROOT)).map((c) => c.id);
    expect(ids).toEqual(['eratw-emuera', 'eratw-emuera-2']);
    // 同一份盘探两次结果逐字相同（无随机、无时间戳）
    expect(await adapter.probe(ROOT)).toEqual(await adapter.probe(ROOT));
  });
});

/* ══════════════════════════════════ 寻址 ══════════════════════════════════ */

describe('buildProfile：候选寻址与路径不变量', () => {
  it('候选 id 不在探测结果里 ⇒ LAUNCHER_EXECUTABLE_INVALID（与 core::create 同码语义）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
    const err = await expectLaunchError(
      () => adapter.buildProfile(ROOT, 'eratw-lazyloading-x86'),
      'LAUNCHER_EXECUTABLE_INVALID',
    );
    expect(err.detail).toContain('eratw-lazyloading-x86');
    expect(err.detail).toContain(MEASURED_X64); // 把"实际有哪些候选"带进 detail 供排障
  });

  it('零候选的目录 ⇒ 同一枚错误（不猜目标程序）', async () => {
    const adapter = adapterOf({ files: [], dirs: ['ERB', 'CSV'] });
    await expectLaunchError(
      () => adapter.buildProfile(ROOT, 'eratw-lazyloading-x64'),
      'LAUNCHER_EXECUTABLE_INVALID',
    );
  });

  it('exe 相对路径永远相对：无盘符、不绝对、无 ..（实测两档都过）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64, MEASURED_X86], dirs: [...FULL_DIRS] });
    for (const id of ['eratw-lazyloading-x64', 'eratw-lazyloading-x86']) {
      const profile = await adapter.buildProfile(ROOT, id);
      const rel = profile.executable.relativePath;
      expect(path.isAbsolute(rel)).toBe(false);
      expect(/^[a-zA-Z]:/.test(rel)).toBe(false);
      expect(rel.startsWith('/')).toBe(false);
      expect(rel.split('/')).not.toContain('..');
      expect(rel).toMatch(/\.exe$/);
    }
  });

  it('家族判据能匹配到带分隔符的恶意文件名，但路径闸会在 buildProfile 拦下（..）', async () => {
    // `.` 在正则里能匹配 `/`，所以 `Emuera/../../evil.exe` 会进候选 —— 闸必须在这里响
    const adapter = adapterOf({ files: ['Emuera/../../evil.exe'], dirs: [...FULL_DIRS] });
    const candidates = await adapter.probe(ROOT);
    expect(candidates).toHaveLength(1);
    await expectLaunchError(
      () => adapter.buildProfile(ROOT, candidates[0]!.id),
      'LAUNCHER_EXECUTABLE_INVALID',
    );
  });

  it('带盘符的候选名同样被拦（相对路径纪律）', async () => {
    const adapter = adapterOf({ files: ['Emuera_gamedirC:/evil.exe'], dirs: [...FULL_DIRS] });
    const candidates = await adapter.probe(ROOT);
    expect(candidates).toHaveLength(1);
    await expectLaunchError(
      () => adapter.buildProfile(ROOT, candidates[0]!.id),
      'LAUNCHER_EXECUTABLE_INVALID',
    );
  });
});

/* ══════════════════════════════════ 启动描述 ══════════════════════════════════ */

describe('buildProfile：启动描述（argv / cwd / 编码 / 语言 / 运行时）', () => {
  it('本作默认形态：cwd=.、无参数、无环境追加、窗口交给宿主、哈希留空（宿主算）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(profile.candidateId).toBe('eratw-lazyloading-x64');
    expect(profile.cwdRelative).toBe('.');
    expect(profile.executable.args).toEqual([]); // -debug 只在专门的 .bat 里出现
    expect(profile.executable.env).toEqual({});
    expect(profile.executable.windowMode).toBe('auto');
    expect(profile.executable.sha256).toBeNull();
    // 运行时未声明：无法核验 .NET 版本 ⇒ 不声明（声明了会让 core 拦掉能跑的游戏）
    expect(profile.runtime).toBeUndefined();
  });

  it('编码/语言有实测默认值，且用户选项能整份覆盖', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
    const plain = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(plain.encoding).toEqual({ mode: 'auto', fallback: 'utf-8' });
    expect(plain.locale).toEqual({ mode: 'inherit' });

    const overridden = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64', {
      encoding: { mode: 'fixed', fallback: 'shift_jis' },
      locale: { mode: 'explicit', language: 'ja-JP', codepage: 932 },
    });
    expect(overridden.encoding).toEqual({ mode: 'fixed', fallback: 'shift_jis' });
    expect(overridden.locale).toEqual({ mode: 'explicit', language: 'ja-JP', codepage: 932 });
  });

  it('选非推荐档时给一条 warnings（不拦启动，只提示）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64, MEASURED_X86], dirs: [...FULL_DIRS] });
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x86');
    expect(profile.warnings ?? []).toEqual([expect.stringContaining('推荐位更高')]);
    const preferred = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(preferred.warnings).toBeUndefined();
  });
});

/* ══════════════════════════════════ 布局 ══════════════════════════════════ */

describe('buildProfile：存档根 / 内容根按盘上实际目录产出', () => {
  it('完整盘 ⇒ 存档根 1 条 + 内容根 3 条，字段取值逐个钉住', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');

    expect(profile.saveRoots).toEqual([
      {
        id: 'sav',
        label: expect.any(String),
        relativePath: 'sav',
        format: 'emuera-sav',
        writableInShared: false,
      },
    ]);
    expect(profile.contentRoots.map((root) => [root.id, root.relativePath, root.kind, [...root.accepts]]))
      .toEqual([
        ['erb', 'ERB', 'script', ['script']],
        ['csv', 'CSV', 'data', ['data']],
        ['resources', 'resources', 'resource', ['resource']],
      ]);
    // 可写口径：脚本可写（部署同域），数据表与素材不可写（要用户显式授权）
    expect(profile.contentRoots.map((root) => root.writableInShared)).toEqual([true, false, false]);
  });

  it('sav/ 不在 ⇒ saveRoots 为空并给 warnings（绝不声明不存在的路径）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: ['ERB', 'CSV', 'resources'] });
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(profile.saveRoots).toEqual([]);
    expect(profile.warnings ?? []).toEqual([expect.stringContaining('sav')]);
  });

  it('contentRoots 逐条按存在性过滤：resources 缺就不给，ERB 缺也不给', async () => {
    const withoutResources = await adapterOf({
      files: [MEASURED_X64],
      dirs: ['ERB', 'CSV', 'sav'],
    }).buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(withoutResources.contentRoots.map((root) => root.id)).toEqual(['erb', 'csv']);

    const withoutErb = await adapterOf({
      files: [MEASURED_X64],
      dirs: ['CSV', 'resources', 'sav'],
    }).buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(withoutErb.contentRoots.map((root) => root.id)).toEqual(['csv', 'resources']);
  });

  it('exists 判定失败 ⇒ 按"不在位"处理（如实省略，且不把异常当成功）', async () => {
    const adapter = createEratwLaunchAdapter({
      io: ioOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS], existsThrows: true }),
      log: silentLog,
    });
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(profile.saveRoots).toEqual([]);
    expect(profile.contentRoots).toEqual([]);
  });

  it('adapter 级 saveLayout / contentRoots 是声明面（buildProfile 的过滤不改变声明）', async () => {
    const empty = adapterOf({ files: [MEASURED_X64], dirs: ['sav'] });
    const launch = (empty as { saveLayout?: { roots: readonly { relativePath: string }[]; listRule?: { extensions: readonly string[]; labelFromFileName?: boolean } } }).saveLayout;
    expect(launch?.roots.map((root) => root.relativePath)).toEqual(['sav']);
    expect(launch?.listRule).toEqual({ extensions: ['.sav'], labelFromFileName: true });
    expect((empty as { contentRoots?: readonly { id: string }[] }).contentRoots?.map((root) => root.id)).toEqual([
      'erb',
      'csv',
      'resources',
    ]);
    // 声明面 ≠ 实例面：盘上只有 sav/ 时，实例的 contentRoots 为空
    const profile = await empty.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(profile.contentRoots).toEqual([]);
    expect(profile.saveRoots).toHaveLength(1);
  });

  it('includeSaves:false 不改变布局（那是 copy 任务的开关，不是"声明成没存档"）', async () => {
    const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
    const withSaves = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64', { includeSaves: true });
    const withoutSaves = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64', { includeSaves: false });
    expect(withoutSaves.saveRoots).toEqual(withSaves.saveRoots);
    expect(withoutSaves.saveRoots).toHaveLength(1);
  });
});

/* ══════════════════════════════════ 日志 ══════════════════════════════════ */

describe('logRules：按实测日志行解析（认不出就 null，不猜）', () => {
  const adapter = adapterOf({ files: [MEASURED_X64], dirs: [...FULL_DIRS] });
  // 本实现三件都给了（`Required<>` 让断言不必逐处非空断言；顺带钉住"三件都在"）
  const rules = adapter.logRules! as Required<LogParseRules>;

  it('实测三种定位行（全角/半角括号、"在N行"/"的第N行"/"的N行"）', () => {
    // 三条原句逐字取自真盘 `emuera.log`（第 167 / 172 / 170 行）
    expect(
      rules.parseLocation('MOVEMENTS\\物件関連\\COMMON2.ERB在30行错误发生在:Emuera.NET 1.824+v22'),
    ).toEqual({ relativePath: 'MOVEMENTS/物件関連/COMMON2.ERB', line: 30 });
    expect(
      rules.parseLocation('MOVEMENTS\\物件関連\\PLACE_拠点別分岐.ERB的第255行（函数@NAME_FROM_PLACE内）'),
    ).toEqual({ relativePath: 'MOVEMENTS/物件関連/PLACE_拠点別分岐.ERB', line: 255 });
    expect(rules.parseLocation('函数: @GET_MAPID（MOVEMENTS\\物件関連\\COMMON2.ERB的26行）')).toEqual({
      relativePath: 'MOVEMENTS/物件関連/COMMON2.ERB',
      line: 26,
    });
  });

  it('认不出 / 不合法一律 null（绝对路径不回显，正文不当路径）', () => {
    expect(rules.parseLocation('★★请选择游戏模式★★')).toBeNull();
    expect(rules.parseLocation('')).toBeNull();
    // 绝对路径不许带进 UI（契约只认相对 gameRoot 的路径）
    expect(rules.parseLocation('C:\\game\\ERB\\SYSTEM.ERB在12行错误发生在:')).toBeNull();
    expect(rules.parseLocation('ERB\\SYSTEM.ERB在0行')).toBeNull();
  });

  it('错误行只认实测标记；警告/普通正文不算错误', () => {
    expect(rules.isErrorLine('MOVEMENTS\\物件関連\\COMMON2.ERB在30行错误发生在:Emuera.NET')).toBe(true);
    expect(rules.isErrorLine('错误内容:可能进入了无限循环因此选择强制终止')).toBe(true);
    expect(rules.isErrorLine('エラー：未定義の関数')).toBe(true);
    expect(rules.isErrorLine('★基本标志未设定（警告）')).toBe(false);
    expect(rules.isErrorLine('要变成谁呢？')).toBe(false);
  });

  it('噪声行 = 空行 / 纯 <shape> 排版标记；正文与错误行都不是噪声', () => {
    expect(rules.isNoiseLine('   ')).toBe(true);
    expect(rules.isNoiseLine("<shape type='space' param='100'><shape type='space' param='50'>")).toBe(true);
    expect(rules.isNoiseLine('要变成谁呢？')).toBe(false);
    expect(rules.isNoiseLine('错误内容:可能进入了无限循环')).toBe(false);
  });

  it('defaultEncoding 与 buildProfile 的 encoding 同一档（单源，不各写一份）', async () => {
    const profile = await adapter.buildProfile(ROOT, 'eratw-lazyloading-x64');
    expect(adapter.defaultEncoding).toEqual(profile.encoding);
  });
});

/* ═════════════════════════ 真实 io（生产同一条管线） ═════════════════════════ */

describe('生产 io 端到端：FileIOServiceImpl + 临时目录', () => {
  const temps: string[] = [];
  afterEach(async () => {
    for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeGame(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-eratw-launch-'));
    temps.push(dir);
    await fs.mkdir(path.join(dir, 'ERB'));
    await fs.mkdir(path.join(dir, 'CSV'));
    await fs.mkdir(path.join(dir, 'sav'));
    await fs.writeFile(path.join(dir, MEASURED_X64), '');
    await fs.writeFile(path.join(dir, 'emuera.config'), 'USE SAV FOLDER:YES\r\n');
    return dir;
  }

  it('探到候选、路径在根内、存档根在位（真 io 下与假 io 同结果）', async () => {
    const dir = await makeGame();
    const adapter = createEratwLaunchAdapter({
      io: new FileIOServiceImpl(new NodeBridge(dir), silentLog),
      log: silentLog,
    });
    const candidates = await adapter.probe(dir);
    expect(candidates.map((c) => c.id)).toEqual(['eratw-lazyloading-x64']);
    // 真 io 报的 entry.name 必须是纯文件名（相对路径纪律的上游保证）
    expect(candidates[0]?.executableRelativePath).toBe(MEASURED_X64);
    expect(await fs.readFile(path.join(dir, candidates[0]!.executableRelativePath), 'utf8')).toBe('');

    const profile: LaunchProfile = await adapter.buildProfile(dir, 'eratw-lazyloading-x64');
    expect(profile.saveRoots.map((root) => root.relativePath)).toEqual(['sav']);
    expect(profile.contentRoots.map((root) => root.relativePath)).toEqual(['ERB', 'CSV']);
  });

  it('不存在的目录：probe 空数组（真 io 的抛错被吃成"没有候选"）', async () => {
    const dir = path.join(os.tmpdir(), `kojo-eratw-missing-${Date.now()}`);
    const adapter = createEratwLaunchAdapter({
      io: new FileIOServiceImpl(new NodeBridge(dir), silentLog),
      log: silentLog,
    });
    await expect(adapter.probe(dir)).resolves.toEqual([]);
  });
});
