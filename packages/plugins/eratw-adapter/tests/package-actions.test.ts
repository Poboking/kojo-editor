import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, FileIO, FileStat, Logger, SugarCompiledBytes } from '@kojo/plugin-api';
import {
  buildZip,
  inflateZipEntry,
  readZipContainer,
  verifyZipRoundtrip,
  zipContainerContractProblem,
  ZIP_FLAG_UTF8,
} from '@kojo/plugin-api';
import { STATUS_OK_DISMISS_MS, buildPackageZip, createPackageActions } from '@kojo/kojo-project-kit';
import type { KojoCompiler } from '@kojo/kojo-project-kit';
import type { DeployTargetOk, PendingDeploy } from '../src/deploy';
import type { PanelStatus } from '@kojo/kojo-project-kit';

/**
 * 包操作控制器（P-D 导出 / P-E 部署）单测。
 *
 * 关注点是**时序与交代**：异步动作期间面板必须有忙碌态；成功要报出落点并自动收起；
 * 失败必须常驻把原因留给用户读；用户在对话框里取消不是错误，不该留消息。
 * 部署另有一层契约：返回值决定向导留不留得下——失败必须留着窗口让用户读原因。
 */

function fakeLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (m: string) => warnings.push(m),
    error: () => {},
  };
}

function setup(io: Partial<FileIO>, compileKojo: KojoCompiler = throwingCompile) {
  const log = fakeLogger();
  let notifies = 0;
  const actions = createPackageActions({
    io: io as unknown as FileIO,
    log,
    notify: () => {
      notifies += 1;
    },
    compileKojo,
  });
  return { actions, log, notifyCount: () => notifies };
}

/** 默认编译器：被调用即说明用例忘了提供 .kojo1 的替身，宁可响也不静默 */
function throwingCompile(_source: string, label: string): SugarCompiledBytes {
  throw new Error(`本用例未提供编译器，却被要求转译：${label}`);
}

/** 把 .kojo1 源变成"加一行的 .ERB"，好断言转译真的发生了 */
const fakeCompile: KojoCompiler = (source, label) => ({
  bytes: new TextEncoder().encode(`; from ${label}\n${source}`),
  transpile: { erb: '', sourceMap: [], diagnostics: [] },
});

/**
 * 导出链路的最小 io 替身：包内一个 `.kojo1` + 一个 `.txt`，落点由 `exportFile` 决定。
 * （导出已从"整目录复制"改成"制品 ZIP"，见 package-actions.ts 头注。）
 */
function exportSetup(
  exportFile: FileIO['exportFile'],
  overrides: Partial<FileIO> = {},
) {
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    [`${SRC}/事件.kojo1`]: enc.encode('如果 A：\n'),
    [`${SRC}/说明.txt`]: enc.encode('原样'),
  };
  return setup(
    {
      walkDir: async () =>
        Object.keys(files).map((p) => ({ name: p.slice(SRC.length + 1), path: p, isDirectory: false })),
      readBytes: async (p: string) => files[p] ?? (() => { throw new Error(`没有这个文件：${p}`); })(),
      exportFile,
      ...overrides,
    },
    fakeCompile,
  );
}

const SRC = '/appdata/workspaces/p1/东方口上-灵梦 v1.0';
const NAME = '东方口上-灵梦 v1.0';

/** 部署链路的最小 io 替身：一个文件、目标不存在、默认可写 */
function deployIo(overrides: Partial<FileIO> = {}): Partial<FileIO> {
  const srcFile: DirEntry = { name: '01 事件.ERB', path: `${SRC}/01 事件.ERB`, isDirectory: false };
  return {
    stat: async (): Promise<FileStat> => ({ size: 0, mtimeMs: 0, isDirectory: true }),
    exists: async () => false,
    isWritable: () => true,
    walkDir: async () => [srcFile],
    ensureDir: async () => {},
    readBytes: async () => new Uint8Array([0x41]),
    writeBytes: async () => {},
    ...overrides,
  };
}

const PKG: PendingDeploy = { absDir: SRC, dirName: NAME, displayName: NAME, charaNo: 1 };
const TARGET: DeployTargetOk = {
  ok: true,
  charaNo: 1,
  charaName: '灵梦',
  targetDir: 'C:/game/kojo/001 灵梦/东方口上-灵梦 v1.0',
};

/**
 * 等导出链落定（导出是 fire-and-forget，面板状态是唯一可见的终点）。
 *
 * 为什么不是"冲 N 拍"：链尾是 `CompressionStream`，**首次调用要冷启动约 56 ms**
 * （实测），固定拍数的 `setTimeout(0)` 冲刷会在第一个用例上稳定失败——
 * 那种测试只在"前面有别的用例先热过身"时才绿，是假的确定性。
 * `vi.waitFor` 在 fake timers 下会自动推进，两种模式共用一个 helper。
 */
const settle = (actions: { status(): PanelStatus | null }): Promise<void> =>
  vi.waitFor(
    () => {
      if (actions.status()?.kind === 'busy') throw new Error('仍在忙碌');
    },
    { timeout: 3000, interval: 5 },
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('导出制品 ZIP（P-D + 2026-10-12 导出批）', () => {
  it('调用平台时带上 .zip 建议名与中文对话框标题', async () => {
    const calls: Array<{ fileName: string; title?: string; bytes: number }> = [];
    const { actions } = exportSetup(async (fileName, bytes, opts) => {
      calls.push({
        fileName,
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        bytes: bytes.length,
      });
      return null;
    });
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fileName).toBe(`${NAME}.zip`);
    expect(calls[0]!.title).toBe(`导出「${NAME}」为…`);
    expect(calls[0]!.bytes).toBeGreaterThan(0);
  });

  it('进行中为忙碌态，成功后报出落点完整路径与转译计数', async () => {
    const { actions } = exportSetup(async () => `D:/发布/${NAME}.zip`);
    actions.exportArtifact(SRC, NAME);
    // 尚未落定：忙碌态已经在面上（用户不会以为按钮没响应）
    expect(actions.status()).toEqual({ kind: 'busy', text: `正在导出「${NAME}」…` });
    await settle(actions);
    expect(actions.status()?.kind).toBe('ok');
    expect(actions.status()!.text).toContain(`D:/发布/${NAME}.zip`);
    expect(actions.status()!.text).toContain('1 个 .kojo1 转译为 .ERB');
    expect(actions.status()!.text).toContain('1 个文件原样打包');
  });

  it('成功态到点自动收起（保持面板清爽）', async () => {
    vi.useFakeTimers();
    const { actions } = exportSetup(async () => 'D:/发布/out.zip');
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()?.kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(actions.status()).toBeNull();
  });

  it('用户在对话框里取消 → 不留消息（取消是正常路径，不是错误）', async () => {
    const { actions, log } = exportSetup(async () => null);
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()).toBeNull();
    expect(log.warnings).toEqual([]);
  });

  it('平台无对话框能力（Node 桥抛错）→ 失败态常驻并自解释呈现', async () => {
    vi.useFakeTimers();
    const { actions, log } = exportSetup(async () => {
      throw new Error('exportFile is not supported by NodeBridge');
    });
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()).toEqual({
      kind: 'err',
      text: '导出失败：exportFile is not supported by NodeBridge',
    });
    // 失败原因要留给用户读完：远超成功态的收起延时也不自动消失
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS * 10);
    expect(actions.status()?.kind).toBe('err');
    expect(log.warnings).toHaveLength(1);
  });

  /**
   * 时序契约（本批新增）：**转译失败必须发生在弹框之前**。
   * 用户选完落点才吃到"转译失败"，比不弹框恶劣得多——他已经做完了决定。
   */
  it('转译失败 → 根本不弹对话框，失败态常驻', async () => {
    vi.useFakeTimers();
    let dialogOpened = false;
    const { actions } = setup(
      {
        walkDir: async () => [
          { name: '坏.kojo1', path: `${SRC}/坏.kojo1`, isDirectory: false } satisfies DirEntry,
        ],
        readBytes: async () => new TextEncoder().encode('x'),
        exportFile: async () => {
          dialogOpened = true;
          return 'D:/不该被调用.zip';
        },
      },
      (_s, label) => {
        throw new Error(`第 3 行：缺少 否则（${label}）`);
      },
    );
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(dialogOpened).toBe(false);
    expect(actions.status()?.kind).toBe('err');
    expect(actions.status()!.text).toContain('转译失败');
    expect(actions.status()!.text).toContain('未生成制品');
  });

  it('非 Error 抛出也收敛成可读文案（不吐 [object Object]）', async () => {
    const { actions } = exportSetup(async () => {
      throw '对话框崩了';
    });
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()).toEqual({ kind: 'err', text: '导出失败：对话框崩了' });
  });

  it('手动关闭反馈条', async () => {
    const { actions } = exportSetup(async () => 'D:/发布/out.zip');
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    actions.dismiss();
    expect(actions.status()).toBeNull();
  });

  it('新动作顶掉旧反馈，且旧定时器不会把新结果误清掉', async () => {
    vi.useFakeTimers();
    let resolveFirst: (v: string | null) => void = () => {};
    const first = new Promise<string | null>((r) => {
      resolveFirst = r;
    });
    let n = 0;
    const { actions } = exportSetup(async () => {
      n += 1;
      return n === 1 ? first : 'D:/第二次.zip';
    });

    actions.exportArtifact(SRC, NAME);
    resolveFirst('D:/第一次.zip');
    await settle(actions);
    // 第二次导出紧接着发起：第一次排定的自动收起必须被取消
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()!.text).toContain('D:/第二次.zip');
    // 只剩第二次的定时器到期 → 此时才收起
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(actions.status()).toBeNull();
  });
});

describe('buildPackageZip（ZIP 组装本身）', () => {
  const enc = new TextEncoder();

  /** 解出我们自己的包：只验"名字集合对不对"，字节保真由 zip.test.ts 钉 */
  const namesIn = (zip: Uint8Array): string[] => {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const out: string[] = [];
    for (let i = 0; i + 4 <= zip.length; i++) {
      if (view.getUint32(i, true) !== 0x04034b50) continue;
      const nameLen = view.getUint16(i + 26, true);
      out.push(new TextDecoder().decode(zip.subarray(i + 30, i + 30 + nameLen)));
    }
    return out;
  };

  it('包内根 = 源目录名，.kojo1 已换成 .ERB，非 .kojo1 原样', async () => {
    const io = {
      walkDir: async () =>
        [
          { name: '事件.kojo1', path: `${SRC}/事件.kojo1`, isDirectory: false },
          { name: '说明.txt', path: `${SRC}/说明.txt`, isDirectory: false },
        ] as DirEntry[],
      readBytes: async (p: string) => (p.endsWith('.kojo1') ? enc.encode('如果 A：\n') : enc.encode('原样')),
    } as unknown as FileIO;

    const { fileName, bytes, plan } = await buildPackageZip(io, SRC, fakeCompile);
    expect(fileName).toBe(`${NAME}.zip`);
    expect(namesIn(bytes).sort()).toEqual([`${NAME}/事件.ERB`, `${NAME}/说明.txt`]);
    expect(plan.transpiled).toBe(1);
    expect(plan.passthrough).toBe(1);
  });

  it('路径以分隔符结尾也能取到包目录名（walkDir 各家形态不一）', async () => {
    const io = { walkDir: async () => [] as DirEntry[], readBytes: async () => new Uint8Array(0) } as unknown as FileIO;
    const { fileName } = await buildPackageZip(io, `${SRC}/`, fakeCompile);
    expect(fileName).toBe(`${NAME}.zip`);
  });

  it('根路径取不到目录名 → 明确报错，不打出无根的空包', async () => {
    const io = { walkDir: async () => [] as DirEntry[], readBytes: async () => new Uint8Array(0) } as unknown as FileIO;
    await expect(buildPackageZip(io, '/', fakeCompile)).rejects.toThrow(/无法从源路径取到包目录名/);
  });
});

describe('部署到游戏目录（P-E）', () => {
  it('成功：回报文件数与落点，并告知调用方可以关窗', async () => {
    const { actions } = setup(deployIo());
    const running = actions.deployArtifact(PKG, TARGET);
    expect(actions.status()).toEqual({ kind: 'busy', text: `正在部署「${NAME}」…` });
    expect(await running).toBe(true);
    expect(actions.status()).toEqual({
      kind: 'ok',
      text: `已部署「${NAME}」1 个文件 → ${TARGET.targetDir}`,
    });
  });

  it('目标已存在：失败态写明「不覆盖」，返回 false 让向导留着窗口', async () => {
    const { actions, log } = setup(deployIo({ exists: async () => true }));
    expect(await actions.deployArtifact(PKG, TARGET)).toBe(false);
    expect(actions.status()).toEqual({
      kind: 'err',
      text: `部署失败：目标已存在，未覆盖：${TARGET.targetDir}`,
    });
    expect(log.warnings).toHaveLength(1);
  });

  it('游戏目录未批准写权限：原因直达「先授权」这一步', async () => {
    const { actions } = setup(deployIo({ isWritable: () => false }));
    expect(await actions.deployArtifact(PKG, TARGET)).toBe(false);
    expect(actions.status()?.text).toContain('请先批准游戏目录的写权限');
  });

  it('部署成功同样到点自动收起', async () => {
    vi.useFakeTimers();
    const { actions } = setup(deployIo());
    await actions.deployArtifact(PKG, TARGET);
    expect(actions.status()?.kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS);
    expect(actions.status()).toBeNull();
  });

  it('部署失败不自动收起（用户要读完原因、改完再点）', async () => {
    vi.useFakeTimers();
    const { actions } = setup(deployIo({ exists: async () => true }));
    await actions.deployArtifact(PKG, TARGET);
    await vi.advanceTimersByTimeAsync(STATUS_OK_DISMISS_MS * 10);
    expect(actions.status()?.kind).toBe('err');
  });

  it('导出与部署共用同一条状态条：后落定的顶掉前一个', async () => {
    const { actions } = setup({ ...deployIo(), exportFile: async () => 'D:/发布/out.zip' });
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(actions.status()?.kind).toBe('ok');
    await actions.deployArtifact(PKG, TARGET);
    expect(actions.status()?.text).toContain('已部署');
  });
});

/**
 * **W14 往返契约在导出链路上生效**（规则单源见 `plugin-api/fixtures/zip-roundtrip/contract.json`）。
 *
 * 三条各钉一件事：
 * 1. 导出的字节确实是**平台解包器认识**的容器（过解包侧的闸，且逐条目读回内容一致）；
 * 2. 违反契约的工作区（大小写重名 = Windows 上同一文件）必须**拒在弹框之前**，
 *    失败态带的是解包侧那套拒绝码，不是本层自造的一句话；
 * 3. 导出链路的**唯一写盘通道是 `exportFile`**（对话框即授权，落点由平台决定）——
 *    任何一条 `writeBytes` / `ensureDir` / `rename` 被调用都算越权，测试直接炸。
 */
describe('导出链路的往返契约（W14）', () => {
  const enc = new TextEncoder();

  /** 只有读能力的 io 替身：任何写原语被调用即红（导出没有、也不该有第二条写路径） */
  function readOnlyIo(files: Record<string, string>): FileIO {
    return {
      walkDir: async () =>
        Object.entries(files).map(
          ([rel, _]): DirEntry => ({ name: rel, path: `${SRC}/${rel}`, isDirectory: false }),
        ),
      readBytes: async (p: string) => {
        const rel = p.slice(SRC.length + 1);
        if (!(rel in files)) throw new Error(`没有这个文件：${p}`);
        return enc.encode(files[rel]);
      },
      writeBytes: async () => {
        throw new Error('导出链路不许直接写盘：落点只能由 exportFile 的对话框决定');
      },
      writeText: async () => {
        throw new Error('导出链路不许直接写盘：落点只能由 exportFile 的对话框决定');
      },
      ensureDir: async () => {
        throw new Error('导出链路不许建目录：落点只能由 exportFile 的对话框决定');
      },
      rename: async () => {
        throw new Error('导出链路不许搬运：落点只能由 exportFile 的对话框决定');
      },
    } as unknown as FileIO;
  }

  it('导出的字节是平台解包器认识的容器（逐条目读回内容与字节全平）', async () => {
    const io = readOnlyIo({ '事件.kojo1': '如果 A：\n', '说明.txt': '原样', '子目录/备注.md': '# 备注' });
    const { fileName, bytes } = await buildPackageZip(io, SRC, fakeCompile);
    expect(fileName).toBe(`${NAME}.zip`);
    const container = readZipContainer(bytes);
    expect(zipContainerContractProblem(container)).toBeNull();
    expect(container.entries.map((e) => e.name)).toEqual([
      `${NAME}/事件.ERB`,
      `${NAME}/说明.txt`,
      `${NAME}/子目录/备注.md`,
    ]);
    const back: Uint8Array[] = [];
    for (const entry of container.entries) {
      expect(entry.flags & ZIP_FLAG_UTF8).toBe(ZIP_FLAG_UTF8);
      back.push(await inflateZipEntry(entry));
    }
    expect(new TextDecoder().decode(back[0]!)).toContain('; from 事件.kojo1');
    expect(new TextDecoder().decode(back[2]!)).toBe('# 备注');
    // 自证与产品链路同一条判据：通过 = null
    expect(
      await verifyZipRoundtrip(
        bytes,
        container.entries.map((e, i) => ({ name: e.name, data: back[i]! })),
      ),
    ).toBeNull();
  });

  it('大小写重名的工作区（Windows 上是同一个文件）→ 拒在弹框之前，两层都拦', async () => {
    vi.useFakeTimers();
    let dialogOpened = false;
    const { actions } = setup(
      {
        ...readOnlyIo({ 'A.ERB': 'x\n', 'a.ERB': 'y\n' }),
        exportFile: async () => {
          dialogOpened = true;
          return 'D:/不该被调用.zip';
        },
      },
      fakeCompile,
    );
    actions.exportArtifact(SRC, NAME);
    await settle(actions);
    expect(dialogOpened).toBe(false);
    expect(actions.status()?.kind).toBe('err');
    // 先响的是**制品计划层**（`artifact.ts` 的"产物名冲突"，用作者的語言说"请改名后再导出"）；
    // ZIP 契约层的 `entry-duplicate` 是第二道网（判据见 plugin-api 的 zip-roundtrip 测试）：
    // 任何绕过计划层的调用者打的包照样过不了平台解包器的闸。
    expect(actions.status()!.text).toMatch(/产物名冲突|entry-duplicate/);
  });

  it('绕过制品计划层直接打 ZIP 时，第二道网确实接得住（entry-duplicate 出自契约层）', async () => {
    await expect(
      buildZip(
        [
          { name: `${NAME}/A.ERB`, data: enc.encode('x\n') },
          { name: `${NAME}/a.ERB`, data: enc.encode('y\n') },
        ],
        { contract: 'extractable' },
      ),
    ).rejects.toThrow(/^entry-duplicate：/);
  });

  it('超深的工作区目录 → path-depth 同样拒在弹框之前', async () => {
    const deep = Array.from({ length: 14 }, (_v, i) => `d${i}`).join('/');
    const io = { ...readOnlyIo({ [`${deep}/事件.kojo1`]: '如果 A：\n' }) } as unknown as FileIO;
    await expect(buildPackageZip(io, SRC, fakeCompile)).rejects.toThrow(/^path-depth：/);
  });
});
