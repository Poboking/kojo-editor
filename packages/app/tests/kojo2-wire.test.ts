/**
 * K2-EDITOR-WIRE 的判据闸：Kojo 2.0 在真实编辑器里**可打开**（预演，不切流）。
 *
 * 三组断言（K2-SURFACE-DEFAULT 起语言面与切流开关解耦）：
 * ① 开关关（缺省）= **语言面照常可见**：descriptor 表四枚齐全、`.kojo2` 认出 `kojo2`、
 *    挂面四枚都挂上；切流语义仍关——`.kojo2` 打开请求 `off` 且零 port 调用；
 * ② 开关开 = 语言面同上；`.kojo2` 的路由放行（大小写不敏感、只认最后一段扩展名），v1 三条路径一字不改；
 * ③ `.kojo2` 打开 / 新建只走**注入的既有通道**（openFile / openProject 的 pendingOpenFile 腿 /
 *    既有新建通道），非 2.0 文件一律 `not-kojo2` 不接管。
 *
 * 单测环境是 `node`（无 window / 无 Monaco）：开关用假 localStorage，语言面用最小桩。
 * descriptor 表是进程级只增表 ⇒ 每个用例 `resetModules` 后重新 import，避免跨用例串表。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { JSON_LANGUAGE_ID } from '../src/monaco/json-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
// 2026-10-24 eraFL 批：descriptor 表多了一枚「口上 XML」（按表全量注册）⇒ 名单断言要看见它。
import { KOJO_XML_LANGUAGE_ID } from '../src/monaco/xml-language';
import type { Kojo2OpenPorts } from '../src/ui/kojo2-open';

type LanguagesModule = typeof import('../src/monaco/languages');
type RegistryModule = typeof import('../src/monaco/language-registry');
type FlagModule = typeof import('../src/ui/kojo2-flag');
type OpenModule = typeof import('../src/ui/kojo2-open');

/** 语言面向 `registerBuiltinLanguageSurfaces` 要的那个 Monaco 形状（只用它的参数类型） */
type SurfaceMonaco = Parameters<LanguagesModule['registerBuiltinLanguageSurfaces']>[0];

const KOJO2_KEY = 'kojo.ui.kojo2Cutover.v1';

const PROJECT_ROOT = 'D:/proj';
const KOJO2_FILE = 'D:/proj/chara/M.kojo2';

interface Wire {
  readonly languages: LanguagesModule;
  readonly registry: RegistryModule;
  readonly flag: FlagModule;
  readonly open: OpenModule;
  /** 假 localStorage 的键值袋（断言写入用；真源仍是 window.localStorage） */
  readonly store: Map<string, string>;
}

/** 装假 window.localStorage（seedOn = 预置 `'on'`），重装模块并取回本用例的实例 */
async function boot(seedOn: boolean): Promise<Wire> {
  const store = new Map<string, string>();
  if (seedOn) store.set(KOJO2_KEY, 'on');
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
    },
  });
  vi.resetModules();
  const flag = await import('../src/ui/kojo2-flag');
  const open = await import('../src/ui/kojo2-open');
  const registry = await import('../src/monaco/language-registry');
  const languages = await import('../src/monaco/languages');
  return { languages, registry, flag, open, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------ Monaco 最小桩 ------------------------------ */

interface CapturedRegistration {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly aliases?: readonly string[];
}

interface SurfaceCapture {
  readonly registered: CapturedRegistration[];
  readonly monarchs: Map<string, unknown>;
  readonly configs: Map<string, unknown>;
}

/**
 * 只实现四个 descriptor 的 `register` 真正碰到的几格（getLanguages / register /
 * Monarch / 语言配置 / 主题入口）。`IndentAction` 是 `enter-rules.ts` 翻译层要的枚举。
 */
function fakeMonaco(): { readonly monaco: SurfaceMonaco; readonly captured: SurfaceCapture } {
  const registered: CapturedRegistration[] = [];
  const monarchs = new Map<string, unknown>();
  const configs = new Map<string, unknown>();
  const disposable = { dispose: (): void => undefined };
  const fake = {
    languages: {
      // 真枚举值无关紧要：只要求存在，翻译层读它构造 onEnterRules
      IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 },
      getLanguages: (): { id: string }[] => registered.map((entry) => ({ id: entry.id })),
      register: (entry: CapturedRegistration): typeof disposable => {
        registered.push(entry);
        return disposable;
      },
      setMonarchTokensProvider: (id: string, provider: unknown): typeof disposable => {
        monarchs.set(id, provider);
        return disposable;
      },
      setLanguageConfiguration: (id: string, config: unknown): typeof disposable => {
        configs.set(id, config);
        return disposable;
      },
      // 口上 XML 的 descriptor 在 `register` 里同时挂四枚 provider（它不声明
      // `languageServices`）。替身缺这几格时真壳能跑、这里抛 `not a function`
      // ⇒ 按 PITFALLS 169 口径补替身，不改源码。
      registerFoldingRangeProvider: (): typeof disposable => disposable,
      registerHoverProvider: (): typeof disposable => disposable,
      registerCompletionItemProvider: (): typeof disposable => disposable,
      registerDocumentSymbolProvider: (): typeof disposable => disposable,
    },
    editor: {
      defineTheme: (): void => undefined,
      getModels: (): unknown[] => [],
      onDidCreateModel: (): typeof disposable => disposable,
      setModelMarkers: (): void => undefined,
    },
  };
  return { monaco: fake as unknown as SurfaceMonaco, captured: { registered, monarchs, configs } };
}

/* ------------------------------ port 记录器 ------------------------------ */

interface PortLog {
  readonly opened: string[];
  readonly projects: { readonly rootDir: string; readonly pendingOpenFile: string }[];
  readonly created: string[];
  readonly notices: string[];
}

function spyPorts(): { readonly ports: Kojo2OpenPorts; readonly log: PortLog } {
  const log: PortLog = { opened: [], projects: [], created: [], notices: [] };
  return {
    log,
    ports: {
      openFile: (path) => {
        log.opened.push(path);
      },
      openProject: (rootDir, opts) => {
        log.projects.push({ rootDir, pendingOpenFile: opts.pendingOpenFile });
      },
      createFile: (path) => {
        log.created.push(path);
      },
      notify: (message) => {
        log.notices.push(message);
      },
    },
  };
}

/** 一个 port 都没被碰过（`off` / `not-kojo2` 的硬判据） */
function expectNoCalls(log: PortLog): void {
  expect(log.opened).toEqual([]);
  expect(log.projects).toEqual([]);
  expect(log.created).toEqual([]);
  expect(log.notices).toEqual([]);
}

/* ================== ① 开关关（缺省）：语言面照常，切流语义仍关 ================== */

describe('开关关（缺省）：语言面照常可见，切流语义仍关', () => {
  it('descriptor 表四枚齐全；`.kojo2` 认得出且唯一命中 kojo2', async () => {
    const { registry, languages } = await boot(false);
    expect(registry.languageDescriptors().map((descriptor) => descriptor.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
    expect(languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
    expect(registry.descriptorForPath('D:/p/M.kojo2')?.id).toBe(KOJO2_LANGUAGE_ID);
    // 只命中 kojo2 一枚：`.kojo2` 是 kojo2 的专属扩展名，口上 XML 的 descriptor 认 `.xml`，不参与
    expect(registry.languageDescriptors().filter((d) => d.matchesPath('D:/p/M.kojo2')).map((d) => d.id)).toEqual([
      KOJO2_LANGUAGE_ID,
    ]);
  });

  it('认路（大小写 / 最后一段扩展名 / plaintext 兜底）不随开关改口', async () => {
    const { languages } = await boot(false);
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['D:/p/M.kojo', KOJO_LANGUAGE_ID],
      ['D:/p/M.KOJO', KOJO_LANGUAGE_ID],
      ['D:/p/M.ERB', ERB_LANGUAGE_ID],
      ['D:/p/M.erm', ERB_LANGUAGE_ID],
      ['D:/p/settings.json', JSON_LANGUAGE_ID],
      ['D:/p/note.txt', 'plaintext'],
      ['D:/p/M.kojo2', KOJO2_LANGUAGE_ID],
      ['D:/p/M.kojo2.bak', 'plaintext'],
    ];
    for (const [path, expected] of cases) {
      expect(languages.languageForPath(path), path).toBe(expected);
    }
  });

  it('挂面照常挂四枚：kojo2 的扩展名 / Monarch / 配置都在', async () => {
    const { languages } = await boot(false);
    const { monaco, captured } = fakeMonaco();
    languages.registerBuiltinLanguageSurfaces(monaco);
    expect(captured.registered.map((entry) => entry.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
    expect(captured.monarchs.has('kojo2')).toBe(true);
    expect(captured.configs.has('kojo2')).toBe(true);
  });

  it('`.kojo2` 打开请求 ⇒ off，零 port 调用（调用方照原样走 v1 流程）', async () => {
    const { open } = await boot(false);
    const { ports, log } = spyPorts();
    const plan = open.routeKojo2Open(
      { path: KOJO2_FILE },
      { currentRoot: PROJECT_ROOT, projectOpen: true },
      ports,
    );
    expect(plan).toEqual({ kind: 'off' });
    expectNoCalls(log);
  });
});

/* ======================== ② 开关开：语言面同上，路由放行 ======================== */

describe('开关开：语言面同上，`.kojo2` 路由放行', () => {
  it('`.kojo2` 命中且唯一（大小写不敏感、只认最后一段扩展名）', async () => {
    const { registry, languages } = await boot(true);
    expect(registry.languageDescriptors().map((descriptor) => descriptor.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
    expect(languages.languageForPath('D:/p/M.kojo2')).toBe(KOJO2_LANGUAGE_ID);
    expect(languages.languageForPath('D:/p/M.KOJO2')).toBe(KOJO2_LANGUAGE_ID);
    expect(languages.languageForPath('D:/p/M.kojo2.bak')).toBe('plaintext');
    expect(registry.descriptorForPath('D:/p/M.kojo2')?.id).toBe(KOJO2_LANGUAGE_ID);
    expect(
      registry.languageDescriptors().filter((d) => d.matchesPath('D:/p/M.kojo2')).map((d) => d.id),
    ).toEqual([KOJO2_LANGUAGE_ID]);
  });

  it('v1 认路不受影响（`.kojo` 仍是 v1 那枚 descriptor 的 id）', async () => {
    const { registry, languages } = await boot(true);
    expect(languages.languageForPath('D:/p/M.kojo')).toBe(KOJO_LANGUAGE_ID);
    expect(languages.languageForPath('D:/p/M.kojo.bak')).toBe('plaintext');
    expect(languages.languageForPath('D:/p/M.ERB')).toBe(ERB_LANGUAGE_ID);
    expect(languages.languageForPath('D:/p/settings.json')).toBe(JSON_LANGUAGE_ID);
    expect(registry.descriptorForPath('D:/p/M.kojo')?.label).toBe('kojo');
  });

  it('挂面把 `.kojo2` 扩展名 / Monarch / 语言配置一并挂上，且重复调用只挂一次', async () => {
    const { languages } = await boot(true);
    const { monaco, captured } = fakeMonaco();
    languages.registerBuiltinLanguageSurfaces(monaco);
    expect(captured.registered.map((entry) => entry.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
    const kojo2 = captured.registered.find((entry) => entry.id === KOJO2_LANGUAGE_ID);
    expect(kojo2?.extensions).toEqual(['.kojo2']);
    expect(captured.monarchs.has('kojo2')).toBe(true);
    const config = captured.configs.get('kojo2') as
      | { readonly comments?: { readonly lineComment?: string } }
      | undefined;
    expect(config?.comments?.lineComment).toBe('//');

    // 幂等：同一 Monaco 实例再挂一次，不重复 register（与 v1 register 同款守卫）
    languages.registerBuiltinLanguageSurfaces(monaco);
    expect(captured.registered.map((entry) => entry.id)).toEqual([
      ERB_LANGUAGE_ID,
      KOJO_LANGUAGE_ID,
      JSON_LANGUAGE_ID,
      KOJO2_LANGUAGE_ID,
      KOJO_XML_LANGUAGE_ID,
    ]);
  });

  it('只有脸：不声明通用语言服务、不声明结构层（v1 provider 不被误挂到 2.0）', async () => {
    const { registry } = await boot(true);
    const descriptor = registry.descriptorForLanguageId(KOJO2_LANGUAGE_ID);
    expect(descriptor).not.toBeNull();
    expect(descriptor?.languageServices).toBeUndefined();
    expect(descriptor?.structure).toBeUndefined();
    expect(descriptor?.label).toBe('kojo2');
  });
});

/* ==================== ③ 打开 / 新建：只送到既有通道 ==================== */

describe('`.kojo2` 打开 / 新建路由（走既有 project/open 流程）', () => {
  it('开关开 + 非 2.0 文件 ⇒ not-kojo2，零 port 调用（`.kojo` 不被接管）', async () => {
    const { open } = await boot(true);
    const { ports, log } = spyPorts();
    const plan = open.routeKojo2Open(
      { path: 'D:/proj/M.kojo' },
      { currentRoot: PROJECT_ROOT, projectOpen: true },
      ports,
    );
    expect(plan).toEqual({ kind: 'not-kojo2' });
    expectNoCalls(log);
  });

  it('当前项目内 ⇒ 走既有 openFile（根的大小写 / 分隔符不同也算同一根）', async () => {
    const { open } = await boot(true);
    const { ports, log } = spyPorts();
    const plan = open.routeKojo2Open(
      { path: KOJO2_FILE },
      { currentRoot: 'd:\\proj', projectOpen: true },
      ports,
    );
    expect(plan).toEqual({ kind: 'open', path: KOJO2_FILE });
    expect(log.opened).toEqual([KOJO2_FILE]);
    expect(log.projects).toEqual([]);
    expect(log.created).toEqual([]);
    expect(log.notices).toEqual([]);
  });

  it('文件属于别的项目根 ⇒ 走既有 openProject 的 pendingOpenFile 腿（与最近文件同一条）', async () => {
    const { open } = await boot(true);
    const { ports, log } = spyPorts();
    const target = 'D:/other/M.kojo2';
    const plan = open.routeKojo2Open(
      { path: target, rootDir: 'D:/other' },
      { currentRoot: PROJECT_ROOT, projectOpen: true },
      ports,
    );
    expect(plan).toEqual({ kind: 'open-project', rootDir: 'D:/other', pendingOpenFile: target });
    expect(log.projects).toEqual([{ rootDir: 'D:/other', pendingOpenFile: target }]);
    expect(log.opened).toEqual([]);
  });

  it('欢迎页：带根 ⇒ 先开项目再排文件；没有根 ⇒ blocked 并说一句人话', async () => {
    const { open } = await boot(true);
    const { ports, log } = spyPorts();
    const withRoot = open.routeKojo2Open(
      { path: KOJO2_FILE, rootDir: PROJECT_ROOT },
      { currentRoot: null, projectOpen: false },
      ports,
    );
    expect(withRoot).toEqual({
      kind: 'open-project',
      rootDir: PROJECT_ROOT,
      pendingOpenFile: KOJO2_FILE,
    });

    const noRoot = open.routeKojo2Open(
      { path: KOJO2_FILE },
      { currentRoot: null, projectOpen: false },
      ports,
    );
    expect(noRoot).toEqual({ kind: 'blocked', reason: open.KOJO2_NO_PROJECT_REASON });
    expect(log.notices).toEqual([open.KOJO2_NO_PROJECT_REASON]);
    expect(log.opened).toEqual([]);
  });

  it('新建：项目内 ⇒ 走既有 createFile；跑出项目根 / 没项目 ⇒ blocked', async () => {
    const { open } = await boot(true);
    const { ports, log } = spyPorts();

    const inside = open.routeKojo2Open(
      { path: KOJO2_FILE, mode: 'create' },
      { currentRoot: PROJECT_ROOT, projectOpen: true },
      ports,
    );
    expect(inside).toEqual({ kind: 'create', path: KOJO2_FILE });
    expect(log.created).toEqual([KOJO2_FILE]);

    const outside = open.routeKojo2Open(
      { path: 'D:/elsewhere/M.kojo2', mode: 'create' },
      { currentRoot: PROJECT_ROOT, projectOpen: true },
      ports,
    );
    expect(outside).toEqual({ kind: 'blocked', reason: open.KOJO2_CREATE_NEEDS_PROJECT_REASON });

    const noProject = open.routeKojo2Open(
      { path: KOJO2_FILE, mode: 'create' },
      { currentRoot: null, projectOpen: false },
      ports,
    );
    expect(noProject).toEqual({ kind: 'blocked', reason: open.KOJO2_CREATE_NEEDS_PROJECT_REASON });
    expect(log.notices).toEqual([
      open.KOJO2_CREATE_NEEDS_PROJECT_REASON,
      open.KOJO2_CREATE_NEEDS_PROJECT_REASON,
    ]);
  });

  it('判据单一：`isKojo2Path` 与语言层同一口径（大小写 / 最后一段扩展名）', async () => {
    const { open } = await boot(true);
    expect(open.isKojo2Path('D:/p/M.kojo2')).toBe(true);
    expect(open.isKojo2Path('D:/p/M.KOJO2')).toBe(true);
    expect(open.isKojo2Path('D:/p/M.kojo2.bak')).toBe(false);
    expect(open.isKojo2Path('D:/p/M.kojo')).toBe(false);
    expect(open.isKojo2Path('D:/p/.kojo2')).toBe(false);
  });

  it('按后缀收文件的清单恒含 `.kojo2`（看得见文件是语言面，不看开关）', async () => {
    const off = await boot(false);
    expect(off.open.kojo2SourceExtensions()).toEqual(['.kojo2']);
    const on = await boot(true);
    expect(on.open.kojo2SourceExtensions()).toEqual(['.kojo2']);
  });
});

/* ======================= 开关自身：默认关 / 坏值不翻成开 ======================= */

describe('开关自身：localStorage 唯一真源，默认关', () => {
  it('缺省关；写开 = `on`、写关 = 删键；每次写入通知订阅者', async () => {
    const { flag, store } = await boot(false);
    expect(flag.isKojo2CutoverEnabled()).toBe(false);

    const listener = vi.fn();
    const off = flag.subscribeKojo2Cutover(listener);
    flag.setKojo2CutoverEnabled(true);
    expect(flag.isKojo2CutoverEnabled()).toBe(true);
    expect(store.get(KOJO2_KEY)).toBe('on');

    flag.setKojo2CutoverEnabled(false);
    expect(flag.isKojo2CutoverEnabled()).toBe(false);
    expect(store.has(KOJO2_KEY)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    off();
    flag.setKojo2CutoverEnabled(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('手改坏值（`1` / `off` / `ON` / 乱写）一律不翻成开', async () => {
    const { flag, store } = await boot(false);
    for (const bad of ['1', 'off', 'ON', 'true', '乱写']) {
      store.set(KOJO2_KEY, bad);
      expect(flag.isKojo2CutoverEnabled(), bad).toBe(false);
    }
  });
});
