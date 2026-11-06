/**
 * B10 批（LaneV，2026-11-06）`editor.openDocument` 的执行腿回归。
 *
 * 口径照 `mcp-editor-write.test.ts`：测的是**接线后的腿表**（`createRunSupplemental` 的 `ioTools`，
 * 即生产同一张表），不是孤立工厂函数——名字拼错 / 漏进表 / seam 没透传，在这里都会红。
 * 登记面（进没进工具清单、档位、台账）在 `mcp-editor-open.test.ts`，本文件只钉**回执诚不诚实**。
 *
 * 钉死的判据（批单 §4 逐条）：
 * ① 成功回执的每一个事实都来自注入的观察件（假登记簿改一位读数，回执就跟着改）——
 *    这条即「回执真是从登记簿读回来的」那件用例；
 * ② 判据是「活动文件命中 + 上屏 model 就是那一份标签 model」：只换路径没换 model 的竞态**不算打开**
 *    （EditorPane 的「新路径 + 旧 model」那一拍），窗内读不到 ⇒ 显式失败并交代等了多久 /
 *    看到几个实例 / 各实例正显示什么 / 为什么判没打开，绝不 opened:true 冒充；
 * ③ 登记簿读不到（GUI 未挂载）或在发射前查到该事件零订阅者 ⇒ 显式 NOT_WIRED **且不发射**（零副作用）；
 * ④ 路径闸与 fs.readFile 同尺：绝对路径 / 盘符 / `..` / 空 当场 INVALID_ARGS 且不发射；
 *    项目未打开 ⇒ RESOURCE_UNAVAILABLE；deadlineMs 脏值 ⇒ INVALID_ARGS（不静默回落）；
 * ⑤ 执行体只有宿主那一条事件（`editor.revealLocation`），载荷只带过闸后的根内绝对路径 + source 标记，
 *    且**整条腿零写盘**（kernel.io 写原语 / invoke 调用计数恒 0，回包 saved:false）；
 * ⑥ 已在活动位 ⇒ 不重复发射（alreadyOpen:true，intent.emitted:false）；
 * ⑦ 糖投影上屏 ⇒ opened:true 但 derivedView:true（写腿那一边照旧拒）；
 * ⑧ 生产观察腿（动态 import livePanes）：真登记表形状下逐位读对，且不把「有标签未上屏」判成打开。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpFailure, createMcpCapabilityRegistry, type McpSessionScope } from '@kojo/mcp-host';
import {
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
} from '../src/mcp/real-sources-io';
import {
  EDITOR_OPEN_CHANNEL,
  OPEN_DOCUMENT_DEADLINE_MS_DEFAULT,
  OPEN_DOCUMENT_DEADLINE_MS_MAX,
  OPEN_DOCUMENT_POLL_INTERVAL_MS,
  createEditorOpenLegs,
  isOpenedInPane,
  productionObserveEditorPanes,
  productionEmitOpenIntent,
  type EditorOpenIntentReceipt,
  type EditorOpenObservation,
  type EditorOpenPaneObservation,
} from '../src/mcp/editor-open-legs';

const editScope: McpSessionScope = {
  sessionId: 'sess-open',
  clientId: 'c1',
  tier: 'edit',
  approvedRoots: [],
  approvedTools: [],
};
const readScope: McpSessionScope = { ...editScope, tier: 'read' };

const ROOT = 'D:/proj';
const TARGET_ABS = `${ROOT}/src/a.kojo`;

/* ============================ 观察件 / 发射件假件 ============================ */

function obs(over: Partial<EditorOpenPaneObservation> = {}): EditorOpenPaneObservation {
  return {
    paneId: 'pane-1',
    filePath: TARGET_ABS,
    filePathIsTarget: true,
    hasTargetTab: true,
    displaysTargetModel: true,
    displaysTargetSugar: false,
    tabCount: 1,
    lineCount: 12,
    language: 'plaintext',
    modelUri: 'file:///D:/proj/src/a.kojo',
    readOnly: false,
    ...over,
  };
}

interface Harness {
  readonly deps: McpIoDeps;
  /** 每一轮 observePanes 依次吐出的读数（用完后重复最后一份）。 */
  setRounds(rounds: Array<readonly EditorOpenPaneObservation[] | null>): void;
  readonly emissions: { count: number; lastTarget: string | null; intent: EditorOpenIntentReceipt };
  readonly ioCalls: string[];
  readonly invokeCalls: string[];
  /** 关掉项目（`kernel.project.current()` 之外的最硬缺席：内核直接不到场）。 */
  closeProject(): void;
}

/**
 * 一条「什么都能记账」的腿表：观察轮次可编排、发射记账可数、内核写原语与 invoke 全部插桩计数。
 * `now` 每调一次前进 1000ms ⇒ 缺省 3000ms 窗恰好 4 轮，超时账是可断言的确定数。
 */
function makeHarness(firstRound: readonly EditorOpenPaneObservation[] = []): Harness {
  let rounds: Array<readonly EditorOpenPaneObservation[] | null> = [firstRound];
  let round = 0;
  let clock = 0;
  let projectOpen = true;
  const emissions = { count: 0, lastTarget: null as string | null, intent: {
    emitted: true,
    channel: EDITOR_OPEN_CHANNEL,
    channelAvailable: true,
    subscribers: 2,
    note: '假件已发射',
  } as EditorOpenIntentReceipt };
  const ioCalls: string[] = [];
  const invokeCalls: string[] = [];
  const kernel = {
    project: { current: () => ({ rootDir: ROOT, adapterId: 'x', kojoPaths: [] }) },
    io: {
      walkDir: async () => [],
      exists: async () => { ioCalls.push('exists'); return true; },
      readTexts: async () => [],
      createFileExclusive: async () => { ioCalls.push('createFileExclusive'); return true; },
      writeText: async () => { ioCalls.push('writeText'); },
      removeFile: async () => { ioCalls.push('removeFile'); },
      removeDir: async () => { ioCalls.push('removeDir'); },
      rename: async () => { ioCalls.push('rename'); },
    },
    plugins: { list: () => [] },
    services: { tryGet: () => undefined },
    bus: { on: () => () => undefined, emit: () => undefined },
    slots: { query: () => [] },
  } as unknown as McpKernelLike;
  const deps: McpIoDeps = {
    getKernel: () => (projectOpen ? kernel : null),
    getCommands: () => [],
    invoke: async (cmd: string) => { invokeCalls.push(cmd); return ''; },
    searchInFiles: async () => ({ files: [], totalMatches: 0, truncated: false, filesScanned: 0, elapsedMs: 0, skipped: [] }),
    editorOpen: {
      observePanes: () => {
        const item = rounds[Math.min(round, rounds.length - 1)];
        round += 1;
        // rounds 里显式塞 null = 「登记簿整张读不到」；索引签名给出的 undefined 只是兜底分支
        if (item === undefined || item === null) return { panes: null, reason: '假登记簿装载失败' };
        return { panes: item };
      },
      emitIntent: (targetAbs: string) => {
        emissions.count += 1;
        emissions.lastTarget = targetAbs;
        return emissions.intent;
      },
      sleep: async () => undefined,
      now: () => {
        const t = clock;
        clock += 1_000;
        return t;
      },
    },
  };
  return {
    deps,
    setRounds(next) {
      rounds = next;
      round = 0;
    },
    emissions,
    ioCalls,
    invokeCalls,
    closeProject() {
      projectOpen = false;
    },
  };
}

async function open(h: Harness, args: Record<string, unknown>): Promise<unknown> {
  return createRunSupplemental(h.deps)('editor.openDocument', args, editScope);
}

async function failureOf(p: Promise<unknown>): Promise<McpFailure> {
  try {
    const out = await p;
    throw new Error(`调用静默成功（应显式失败），返回=${JSON.stringify(out)}`);
  } catch (err) {
    expect(err).toBeInstanceOf(McpFailure);
    return err as McpFailure;
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* ============================ ① 回执来自登记簿读数 ============================ */

describe('editor.openDocument · 回执是从登记簿读回来的事实（判据 ①）', () => {
  it('成功回包的 paneId / path / lineCount / language / modelUri / readOnly / tabCount 逐位跟着观察件变（观察件一改就红）', async () => {
    const h = makeHarness();
    h.setRounds([[], [obs({ paneId: 'pane-7', lineCount: 37, language: 'typescript', tabCount: 4, readOnly: true, modelUri: 'file:///x/y' })]]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out).toMatchObject({
      opened: true,
      tool: 'editor.openDocument',
      relPath: 'src/a.kojo',
      path: TARGET_ABS,
      paneId: 'pane-7',
      active: true,
      derivedView: false,
      lineCount: 37,
      language: 'typescript',
      modelUri: 'file:///x/y',
      readOnly: true,
      tabCount: 4,
      alreadyOpen: false,
      contentChanged: false,
      saved: false,
      persisted: false,
    });
    // 观察窗账：轮询间隔与窗都是常量读数，waitedMs / polls 是这次真实跑出来的数
    expect(out['pollIntervalMs']).toBe(OPEN_DOCUMENT_POLL_INTERVAL_MS);
    expect(out['deadlineMs']).toBe(OPEN_DOCUMENT_DEADLINE_MS_DEFAULT);
    expect(typeof out['waitedMs']).toBe('number');
    expect(out['polls']).toBe(2);
    expect(out['panesObserved']).toBe(1);
    expect(out['intent']).toMatchObject({ emitted: true, channel: EDITOR_OPEN_CHANNEL, subscribers: 2 });
    // 下一跳的指引：paneId 交给带读回核对的定位两枚（本工具不兼任定位）
    expect(String(out['next'])).toContain('paneId="pane-7"');
  });

  it('第一轮没落地、第二轮才落地 ⇒ opened 的判据只在读到上屏那一刻成立（发射恰好一次）', async () => {
    const h = makeHarness();
    h.setRounds([[], [obs()]]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out['opened']).toBe(true);
    expect(h.emissions.count).toBe(1);
    expect(h.emissions.lastTarget).toBe(TARGET_ABS);
    expect(out['polls']).toBe(2);
  });

  it('已在活动位 ⇒ 不发射任何事件（alreadyOpen:true + intent.emitted:false，零重复导航）', async () => {
    const h = makeHarness([obs()]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out).toMatchObject({ opened: true, alreadyOpen: true });
    expect((out['intent'] as Record<string, unknown>)['emitted']).toBe(false);
    expect(h.emissions.count).toBe(0);
  });
});

/* ============================ ② 反假绿：读不到就显式失败 ============================ */

describe('editor.openDocument · 绝不 opened:true 冒充（判据 ②）', () => {
  it('「新路径 + 旧 model」那一拍不算打开：窗内始终读不到上屏 ⇒ 显式失败并交代等了多久 / 几个实例 / 各实例正显示什么', async () => {
    const h = makeHarness();
    // filePathIsTarget 命中，但 model 还是上一份（displaysTargetModel:false）且标签表里没有目标
    h.setRounds([[obs({ filePathIsTarget: true, displaysTargetModel: false, hasTargetTab: false, lineCount: null })]]);
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('TOOL_EXECUTION_FAILED');
    expect(err.message).toContain('[E_EDITOR_OPEN_UNVERIFIED]');
    expect(err.message).toContain(`等了 ${OPEN_DOCUMENT_DEADLINE_MS_DEFAULT}ms`);
    expect(err.message).toContain(`每 ${OPEN_DOCUMENT_POLL_INTERVAL_MS}ms 复核`);
    expect(err.message).toContain('登记簿里有 1 个实例');
    expect(err.message).toContain('pane-1=D:/proj/src/a.kojo');
    expect(err.message).toContain('绝不回 opened:true 冒充');
  });

  it('标签已开但没上屏 ⇒ 同样判没打开，并在账里点名「有标签未上屏」', async () => {
    const h = makeHarness();
    h.setRounds([[obs({ filePath: 'D:/proj/other.kojo', filePathIsTarget: false, displaysTargetModel: false })]]);
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('TOOL_EXECUTION_FAILED');
    expect(err.message).toContain('[有标签未上屏]');
    expect(err.message).toContain('1 个的标签表已含目标');
  });

  it('判据函数本身可钉：只有 filePath 命中 + (原文 model 或该文档糖投影上屏) 才算打开', () => {
    expect(isOpenedInPane(obs())).toBe(true);
    expect(isOpenedInPane(obs({ displaysTargetModel: false, displaysTargetSugar: true }))).toBe(true);
    expect(isOpenedInPane(obs({ displaysTargetModel: false }))).toBe(false);
    expect(isOpenedInPane(obs({ filePathIsTarget: false, displaysTargetModel: true }))).toBe(false);
  });
});

/* ============================ ③ 缺席必须可见（不静默、也不硬发） ============================ */

describe('editor.openDocument · 登记簿 / 通道缺席时先拒绝再谈发射（判据 ③）', () => {
  it('登记簿整张读不到 ⇒ NOT_WIRED 且**一次都没发射**（零副作用的拒绝）', async () => {
    const h = makeHarness();
    h.setRounds([null]);
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('NOT_WIRED');
    expect(err.message).toContain('[E_EDITOR_GUI_NOT_MOUNTED]');
    expect(err.message).toContain('假登记簿装载失败');
    expect(h.emissions.count).toBe(0);
  });

  it('实例数为零（欢迎页 / 无 EditorPane）且窗内没出现 ⇒ NOT_WIRED，不拿空表冒充「打开了」', async () => {
    const h = makeHarness();
    h.setRounds([[]]);
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('NOT_WIRED');
    expect(err.message).toContain('[E_EDITOR_GUI_NOT_MOUNTED]');
    expect(err.message).toContain('一个编辑器实例都没有');
  });

  it('发射腿报「通道缺席」⇒ NOT_WIRED，绝不继续轮询后假称打开', async () => {
    const h = makeHarness();
    h.emissions.intent = {
      emitted: false,
      channel: EDITOR_OPEN_CHANNEL,
      channelAvailable: false,
      subscribers: null,
      note: '内核总线没有 emit（精简桥）',
    };
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('NOT_WIRED');
    expect(err.message).toContain('[E_EDITOR_OPEN_CHANNEL_MISSING]');
    expect(err.message).toContain('精简桥');
  });

  it('真·生产发射腿：订阅者读数 0 ⇒ 不发射并如实回报（Wave4 #4「订阅者只在 GUI 挂载时存在」的正面处理）', () => {
    let emitted = 0;
    const emit = productionEmitOpenIntent(() => ({
      emit: () => { emitted += 1; },
      listenerCount: () => 0,
    }));
    const receipt = emit(TARGET_ABS);
    expect(receipt).toMatchObject({ emitted: false, channelAvailable: true, subscribers: 0 });
    expect(emitted).toBe(0);
    expect(receipt.note).toContain('零订阅者');
  });

  it('真·生产发射腿：发射的就是宿主那条事件与过闸后的路径 + source 标记（不新造第二套跳转、不带 line/column）', () => {
    const seen: Array<{ name: string; payload: unknown }> = [];
    const emit = productionEmitOpenIntent(() => ({
      emit: (name, payload) => seen.push({ name, payload }),
      listenerCount: () => 1,
    }));
    expect(emit(TARGET_ABS)).toMatchObject({ emitted: true, subscribers: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('editor.revealLocation');
    expect(seen[0]!.payload).toEqual({ filePath: TARGET_ABS, source: 'mcp:editor.openDocument' });
  });

  it('listenerCount 读数缺席 ⇒ subscribers:null（如实标注，不编造订阅数），仍照常发射', () => {
    let emitted = 0;
    const emit = productionEmitOpenIntent(() => ({ emit: () => { emitted += 1; } }));
    expect(emit(TARGET_ABS)).toMatchObject({ emitted: true, subscribers: null });
    expect(emitted).toBe(1);
  });
});

/* ============================ ④ 路径闸同尺（同 fs.readFile） ============================ */

describe('editor.openDocument · 项目根闸与 fs.readFile 同一条（判据 ④）', () => {
  it.each([
    ['绝对路径', 'D:/proj/src/a.kojo'],
    ['根外上跳', '../outside/a.kojo'],
    ['内嵌上跳', 'src/../../outside/a.kojo'],
    ['UNC', '//host/share/a.kojo'],
    ['空串', ''],
    ['反斜杠', 'src\\a.kojo'],
  ])('%s ⇒ INVALID_ARGS 且一事件不发', async (_label, relPath) => {
    const h = makeHarness();
    h.setRounds([[obs()]]);
    const err = await failureOf(open(h, { relPath }));
    expect(err.code).toBe('INVALID_ARGS');
    expect(h.emissions.count).toBe(0);
  });

  it('relPath 缺席 / 非字符串 ⇒ INVALID_ARGS 并写明「只收项目根内相对路径」', async () => {
    const h = makeHarness();
    const err = await failureOf(open(h, {}));
    expect(err.code).toBe('INVALID_ARGS');
    expect(err.message).toContain('[E_EDITOR_INVALID_ARGS]');
    expect(err.message).toContain('项目根内相对路径');
  });

  it('deadlineMs 脏值（低于下限 / 超上限 / 非整数）⇒ INVALID_ARGS，不静默回落缺省窗', async () => {
    const h = makeHarness();
    for (const bad of [50, OPEN_DOCUMENT_DEADLINE_MS_MAX + 1, 1500.5, '3000']) {
      const err = await failureOf(open(h, { relPath: 'src/a.kojo', deadlineMs: bad }));
      expect(err.code, `${String(bad)} 应显式拒`).toBe('INVALID_ARGS');
      expect(err.message).toContain('deadlineMs');
    }
    expect(h.emissions.count).toBe(0);
  });

  it('窗内可覆写：deadlineMs 合法值进回包（不夹取、不改常量）', async () => {
    const h = makeHarness();
    h.setRounds([[], [obs()]]);
    const out = (await open(h, { relPath: 'src/a.kojo', deadlineMs: 2_000 })) as Record<string, unknown>;
    expect(out['deadlineMs']).toBe(2_000);
    expect(out['opened']).toBe(true);
  });

  it('项目未打开 ⇒ RESOURCE_UNAVAILABLE（不猜根、不把相对路径当绝对路径发出去）', async () => {
    const h = makeHarness();
    h.closeProject();
    const err = await failureOf(open(h, { relPath: 'src/a.kojo' }));
    expect(err.code).toBe('RESOURCE_UNAVAILABLE');
    expect(h.emissions.count).toBe(0);
  });

  it('read 会话经 registry 调这一枚 ⇒ PERMISSION_DENIED 且腿零触达（一次事件都不发）', async () => {
    const h = makeHarness();
    h.setRounds([[obs()]]);
    const supplemental = createRunSupplemental(h.deps);
    const reg = createMcpCapabilityRegistry({
      runSupplemental: (name, args, scope) => supplemental(name, args, scope),
    });
    await expect(reg.callTool('editor.openDocument', { relPath: 'src/a.kojo' }, readScope)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(h.emissions.count).toBe(0);
    // edit 会话同一条调用走得到腿并成功（档位闸只挡 read，不误伤已授权的档）
    const out = (await reg.callTool('editor.openDocument', { relPath: 'src/a.kojo' }, editScope)) as Record<
      string,
      unknown
    >;
    expect(out['opened']).toBe(true);
  });
});

/* ============================ 装配缺位（腿自己的显式拒） ============================ */

describe('editor.openDocument · 宿主缺位的一条都不许静默（判据 ④ 的装配侧）', () => {
  it('没有项目根读数腿 / 没有路径闸 / 没有发射口 ⇒ 各自 NOT_WIRED 并点名缺什么，且都不发射', async () => {
    const resolve = (root: string, rel: string): string => `${root}/${rel}`;
    const observe: EditorOpenObservation = { panes: [obs()] };
    const noRoot = createEditorOpenLegs({ observePanes: () => observe, now: () => 0 }).editorOpenDocument;
    await expect(noRoot({ relPath: 'src/a.kojo' }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_EDITOR_OPEN_HOST_MISSING]'),
    });
    const noGate = createEditorOpenLegs({
      getRootDir: () => ROOT,
      observePanes: () => observe,
      now: () => 0,
    }).editorOpenDocument;
    await expect(noGate({ relPath: 'src/a.kojo' }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('resolveWithinRoot'),
    });
    const noChannel = createEditorOpenLegs({
      getRootDir: () => ROOT,
      resolveWithinRoot: resolve,
      observePanes: () => observe,
      now: () => 0,
    }).editorOpenDocument;
    await expect(noChannel({ relPath: 'src/a.kojo' }, editScope)).rejects.toMatchObject({
      code: 'NOT_WIRED',
      message: expect.stringContaining('[E_EDITOR_OPEN_HOST_MISSING]'),
    });
  });
});

/* ============================ ⑤ 零写盘自证（判据 ⑦） ============================ */

describe('editor.openDocument · 打开文档不写盘、不改模型（判据 ⑦）', () => {
  it('一次成功打开：内核写原语与 invoke 调用计数恒 0，回包 saved / persisted / contentChanged 全是诚实读数', async () => {
    const h = makeHarness();
    h.setRounds([[obs()]]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out['saved']).toBe(false);
    expect(out['persisted']).toBe(false);
    expect(out['contentChanged']).toBe(false);
    expect(out['dirty']).toBeNull();
    expect(String(out['dirtyReason'])).toContain('不产生任何模型改动');
    expect(h.ioCalls).toEqual([]);
    expect(h.invokeCalls).toEqual([]);
    expect(String(out['persistNote'])).toContain('fileTree.update');
  });

  it('打开动作不进撤销栈、不动别的 pane：回执里没有任何「已改」读数，且只发射一次', async () => {
    const h = makeHarness();
    h.setRounds([[], [obs()]]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out['contentChanged']).toBe(false);
    expect(out['applied']).toBeUndefined(); // 本工具不冒充写腿的 applied 语义
    expect(h.emissions.count).toBe(1);
    expect(h.ioCalls).toEqual([]);
    expect(h.invokeCalls).toEqual([]);
  });
});

/* ============================ ⑦ 派生视图口径 ============================ */

describe('editor.openDocument · 糖投影上屏（派生视图）如实标注', () => {
  it('opened:true 但 derivedView:true，next 指引写明写腿在投影上照旧拒', async () => {
    const h = makeHarness();
    h.setRounds([[obs({ displaysTargetModel: false, displaysTargetSugar: true })]]);
    const out = (await open(h, { relPath: 'src/a.kojo' })) as Record<string, unknown>;
    expect(out).toMatchObject({ opened: true, derivedView: true, active: true });
    expect(String(out['next'])).toContain('糖投影');
    expect(String(out['next'])).toContain('显式拒绝');
  });
});

/* ============================ ⑧ 生产观察腿（真登记簿形状） ============================ */

vi.mock('../src/ui/editor-pane-registry', () => {
  const models = new Map<string, { id: string }>();
  const mk = (id: string) => {
    const m = { id };
    models.set(id, m);
    return m;
  };
  const oldModel = mk('old');
  const targetModel = mk('target');
  const sugarModel = mk('sugar');
  const livePanes = new Map<string, unknown>();
  livePanes.set('pane-1', {
    paneId: 'pane-1',
    editorRef: { current: { getModel: () => oldModel, getRawOptions: () => ({ readOnly: false }) } },
    entriesRef: { current: new Map([['D:/proj/old.kojo', { model: oldModel }]]) },
    filePathRef: { current: 'D:/proj/old.kojo' },
    sugarModelRef: { current: null },
  });
  return { livePanes, __targetModel: targetModel, __sugarModel: sugarModel };
});

describe('editor.openDocument · 生产观察腿读的是同一张 livePanes（判据 ①② 的真源侧）', () => {
  it('未开的文档：三个判据位全 false（绝不因「路径字符串含目标」而判打开）', async () => {
    const result = await productionObserveEditorPanes(TARGET_ABS);
    expect(result.panes).toHaveLength(1);
    const p = result.panes![0]!;
    expect(p).toMatchObject({
      paneId: 'pane-1',
      filePath: 'D:/proj/old.kojo',
      filePathIsTarget: false,
      hasTargetTab: false,
      displaysTargetModel: false,
      lineCount: null,
      tabCount: 1,
    });
    expect(isOpenedInPane(p)).toBe(false);
  });
});
