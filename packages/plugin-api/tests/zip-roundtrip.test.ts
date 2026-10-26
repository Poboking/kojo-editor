/**
 * ZIP **往返对拍**判据（W14）· TS 半边。
 *
 * 打包住本层（`src/zip.ts`），解包住宿主（`app/src-tauri/src/market.rs`）。两种语言没法
 * 共享实现，于是共享**一张表**：`fixtures/zip-roundtrip/contract.json` + 一只由 `buildZip`
 * 真造出来的容器夹具 `fixtures/zip-roundtrip/container.zip`。
 * Rust 半边在 `src-tauri/src/market_tests.rs`（`zip_roundtrip_*` 那几条），
 * 读的是**同一张表、同一个夹具文件**——任何一侧改了规则、限额或夹具，另一侧当场红。
 *
 * 五条链子：
 * 1. **表自证**：表里 `golden.entries` 的 `bytes` / `crc` 必须真的等于它自己的
 *    `contentBase64`；`limits` 与 `containerNameRule` 必须等于契约常量与本模块实现常量
 *    （一张会烂的表比两套规则更糟，两套"限额"也比一张表更糟）。
 * 2. **容器名单源**：`containerNames` 逐条同判，且**拒因文案逐字**相等
 *    （两层各说一句人话 = 用户在同一件事上听到两种说法）。
 * 3. **条目名单源**：`entryNames` 逐条同码，判定**顺序**也钉住（`C:\…` 必须报盘符不报反斜杠）。
 * 4. **造包 → 读回 → 逐字节**：表 → `buildZip` → `readZipContainer` → `inflateZipEntry`
 *    逐条目核名字 / UTF-8 位 / CRC / 字节 / 内容，并与钉进仓库的夹具**除 DOS 时间字段外
 *    逐字节相同**（时间按本地时区写，故掩掉；其余一字节都不许差）。
 * 5. **篡改负自证**：按表 `tampers` 做**长度不变**的字节篡改（改名 / 摘 bit 11 / ZIP64 哨兵），
 *    TS 侧的容器级判定与 Rust 侧的解包闸必须给出**同一个拒绝码**，且都在动盘之前。
 *
 * 夹具重写（Node 的 deflate 实现变了导致字节差异时）：带 `KOJO_ZIP_FIXTURE_UPDATE=1`
 * 跑本文件即可重新生成 `container.zip`。规则本身改了**不许**只改夹具——必须同时改两侧实现，
 * 否则另一侧红。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MARKET_MAX_FILE_ENTRIES,
  MARKET_MAX_PATH_DEPTH,
  MARKET_MAX_UNPACKED_BYTES,
  MARKET_ZIP_SUFFIX,
} from '../src/market';
import {
  ZIP_CONTAINER_NAME_MAX,
  ZIP_EXTRACT_LIMITS,
  ZIP_FLAG_UTF8,
  buildZip,
  crc32,
  inflateZipEntry,
  readZipContainer,
  verifyZipRoundtrip,
  zipContainerContractProblem,
  zipContainerNameProblem,
  zipEntryContractProblem,
  type ZipContainer,
} from '../src/zip';

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/zip-roundtrip/', import.meta.url));
const CONTAINER_PATH = `${FIXTURE_DIR}container.zip`;
const contract = JSON.parse(readFileSync(`${FIXTURE_DIR}contract.json`, 'utf8')) as Contract;

/** 共享表的形状（字段名即契约；两侧都按它断言） */
interface Contract {
  schema: number;
  limits: { maxEntries: number; maxDepth: number; maxUnpackedBytes: number };
  containerNameRule: { charset: string; maxBytes: number; suffix: string; rejectPureDots: boolean };
  containerNames: { name: string; ok: boolean; reason?: string }[];
  entryNames: { name: string; code: string | null }[];
  golden: {
    file: string;
    dateMs: number;
    compress: boolean;
    contract: 'generic' | 'extractable';
    entryCount: number;
    totalUnpackedBytes: number;
    entries: { name: string; nameBytes: number; bytes: number; crc: string; contentBase64: string }[];
  };
  tampers: {
    id: string;
    code: string;
    rename?: { from: string; to: string };
    clearUtf8FlagOf?: string;
    setEocdTotalEntryCount?: number;
  }[];
}

const enc = new TextEncoder();
const bytesOf = (s: string): Uint8Array => enc.encode(s);
const crcHex = (b: Uint8Array): string => `0x${crc32(b).toString(16).padStart(8, '0')}`;
const decodeBase64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

/* ---------------------- 头部字段偏移（两侧按同一份布局对拍） ---------------------- */

const LOCAL_FLAGS = 6;
const LOCAL_TIME = 10;
const LOCAL_NAME = 30;
const CENTRAL_FLAGS = 8;
const CENTRAL_TIME = 12;
const CENTRAL_NAME = 46;
const EOCD_TOTAL_ENTRIES = 10;

/**
 * 把全部条目的 DOS 时间字段掩成 0：那一组字节按**本地时区**写（见 `dosDateTime`），
 * 换时区就换值，不参与逐字节对平。掩掉之后剩下的每一字节都要一样。
 */
function maskDosTime(bytes: Uint8Array, container: ZipContainer): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const entry of container.entries) {
    for (const [base, time] of [
      [entry.localOffset, LOCAL_TIME],
      [entry.centralOffset, CENTRAL_TIME],
    ] as const) {
      view.setUint16(base + time, 0, true);
      view.setUint16(base + time + 2, 0, true);
    }
  }
  return out;
}

/** 按共享表做一次篡改（长度不变；本地头与中央目录同步改，夹具这才是一只"像真的"坏包） */
function tamper(bytes: Uint8Array, caseOf: Contract['tampers'][number]): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const container = readZipContainer(out);
  const hit = (name: string): ZipContainer['entries'][number] => {
    const found = container.entries.filter((e) => e.name === name);
    if (found.length !== 1) throw new Error(`篡改目标 ${JSON.stringify(name)} 命中 ${found.length} 条`);
    return found[0]!;
  };
  if (caseOf.rename !== undefined) {
    const to = bytesOf(caseOf.rename.to);
    if (bytesOf(caseOf.rename.from).length !== to.length) throw new Error('篡改必须保持字节长度不变');
    const entry = hit(caseOf.rename.from);
    out.set(to, entry.localOffset + LOCAL_NAME);
    out.set(to, entry.centralOffset + CENTRAL_NAME);
  }
  if (caseOf.clearUtf8FlagOf !== undefined) {
    const entry = hit(caseOf.clearUtf8FlagOf);
    view.setUint16(entry.centralOffset + CENTRAL_FLAGS, entry.flags & ~ZIP_FLAG_UTF8, true);
    view.setUint16(entry.localOffset + LOCAL_FLAGS, entry.flags & ~ZIP_FLAG_UTF8, true);
  }
  if (caseOf.setEocdTotalEntryCount !== undefined) {
    view.setUint16(out.length - 22 + EOCD_TOTAL_ENTRIES, caseOf.setEocdTotalEntryCount, true);
  }
  return out;
}

/** 判定串 → 拒绝码（码是契约，冒号后面那句话各层自己写） */
function codeOf(problem: string | null): string | null {
  if (problem === null) return null;
  const colon = problem.search(/[：:]/);
  return colon === -1 ? problem : problem.slice(0, colon);
}

/** 表 → `buildZip` 的唯一构造路径（夹具与对拍都从这一条来） */
async function buildGolden(): Promise<Uint8Array> {
  return buildZip(
    contract.golden.entries.map((e) => ({ name: e.name, data: decodeBase64(e.contentBase64) })),
    {
      date: contract.golden.dateMs,
      compress: contract.golden.compress,
      contract: contract.golden.contract,
    },
  );
}

/** 对拍实测读数（条目数 / 字节 / 耗时）——报数用的就是这一行 */
function readout(label: string, container: ZipContainer, bytes: number, ms: number): void {
  console.log(
    `[zip-roundtrip] ${label}：条目 ${container.entries.length}（去重后 ${container.dedupedEntryCount}）、` +
      `解压字节 ${container.totalUnpackedBytes}、容器字节 ${bytes}、耗时 ${ms.toFixed(2)}ms`,
  );
}

/* -------------------------------- 1. 表自证 -------------------------------- */

describe('往返契约表自证', () => {
  it('表是 schema 1、两侧用例都非空（判据不跑在空表上）', () => {
    expect(contract.schema).toBe(1);
    expect(contract.golden.entries.length).toBeGreaterThan(0);
    expect(contract.containerNames.length).toBeGreaterThan(10);
    expect(contract.entryNames.length).toBeGreaterThan(15);
    expect(contract.tampers.length).toBeGreaterThanOrEqual(7);
  });

  it('每条钉数的 bytes / crc 真的等于它自己的 contentBase64', () => {
    let total = 0;
    for (const e of contract.golden.entries) {
      const body = decodeBase64(e.contentBase64);
      expect(e.bytes, e.name).toBe(body.length);
      expect(e.crc, e.name).toBe(crcHex(body));
      expect(e.nameBytes, e.name).toBe(bytesOf(e.name).length);
      total += body.length;
    }
    expect(contract.golden.totalUnpackedBytes).toBe(total);
    expect(contract.golden.entryCount).toBe(contract.golden.entries.length);
  });

  it('golden 的形态本身合法，且没有大小写折叠后的重名', () => {
    for (const e of contract.golden.entries) {
      expect(zipEntryContractProblem(e.name, contract.limits.maxDepth), e.name).toBeNull();
      expect(e.name.endsWith('/'), e.name).toBe(false);
    }
    const folded = contract.golden.entries.map((e) => e.name.toLowerCase());
    expect(new Set(folded).size).toBe(folded.length);
  });

  it('篡改用例逐条：改名保持字节长度、目标名在 golden 里唯一', () => {
    const names = contract.golden.entries.map((e) => e.name);
    for (const caseOf of contract.tampers) {
      if (caseOf.rename !== undefined) {
        expect(bytesOf(caseOf.rename.from).length, caseOf.id).toBe(bytesOf(caseOf.rename.to).length);
        expect(names.filter((n) => n === caseOf.rename!.from).length, caseOf.id).toBe(1);
      }
      if (caseOf.clearUtf8FlagOf !== undefined) expect(names, caseOf.id).toContain(caseOf.clearUtf8FlagOf);
    }
  });

  it('解包限额三个数只有一份：表 = 契约常量 = 本模块实现', () => {
    expect(contract.limits).toEqual({
      maxEntries: MARKET_MAX_FILE_ENTRIES,
      maxDepth: MARKET_MAX_PATH_DEPTH,
      maxUnpackedBytes: MARKET_MAX_UNPACKED_BYTES,
    });
    expect(ZIP_EXTRACT_LIMITS).toEqual(contract.limits);
  });

  it('容器名字面闸的参数与实现相等（长度上限、后缀、字符集、纯点名）', () => {
    expect(contract.containerNameRule.maxBytes).toBe(ZIP_CONTAINER_NAME_MAX);
    expect(contract.containerNameRule.suffix).toBe(MARKET_ZIP_SUFFIX);
    expect(contract.containerNameRule.charset).toBe('[a-z0-9._-]');
    expect(contract.containerNameRule.rejectPureDots).toBe(true);
  });
});

/* ------------------------- 2/3. 两套字面闸逐条同判 ------------------------- */

describe('容器名与条目名的判定单源', () => {
  it('containerNames 逐条同判，且拒因文案逐字相等', () => {
    for (const caseOf of contract.containerNames) {
      const problem = zipContainerNameProblem(caseOf.name);
      expect(problem === null, `${caseOf.name} ⇒ ${problem ?? '放行'}`).toBe(caseOf.ok);
      if (caseOf.reason !== undefined) expect(problem, caseOf.name).toBe(caseOf.reason);
    }
  });

  it('entryNames 逐条同码（判定顺序一并钉住）', () => {
    for (const caseOf of contract.entryNames) {
      expect(zipEntryContractProblem(caseOf.name, contract.limits.maxDepth), caseOf.name).toBe(caseOf.code);
    }
  });
});

/* --------------------------- 4. 造包 → 读回 → 逐字节 --------------------------- */

describe('golden 容器的往返', () => {
  it('表 → buildZip → 读回：逐条目事实与表全平，内容与期望逐字节相同', async () => {
    const started = performance.now();
    const bytes = await buildGolden();
    const container = readZipContainer(bytes);
    expect(container.zip64).toBe(false);
    expect(container.entries.length).toBe(contract.golden.entryCount);
    expect(container.dedupedEntryCount).toBe(contract.golden.entryCount);
    expect(container.totalUnpackedBytes).toBe(contract.golden.totalUnpackedBytes);
    expect(zipContainerContractProblem(container, contract.limits)).toBeNull();
    for (let i = 0; i < container.entries.length; i++) {
      const entry = container.entries[i]!;
      const want = contract.golden.entries[i]!;
      expect(entry.name, want.name).toBe(want.name);
      expect(entry.rawName.length, want.name).toBe(want.nameBytes);
      expect(entry.crc, want.name).toBe(parseInt(want.crc, 16));
      expect(entry.uncompressedSize, want.name).toBe(want.bytes);
      expect(entry.flags & ZIP_FLAG_UTF8, want.name).toBe(ZIP_FLAG_UTF8);
      expect(entry.localMatchesCentral, want.name).toBe(true);
      expect(await inflateZipEntry(entry), want.name).toEqual(decodeBase64(want.contentBase64));
    }
    expect(
      await verifyZipRoundtrip(
        bytes,
        contract.golden.entries.map((e) => ({ name: e.name, data: decodeBase64(e.contentBase64) })),
        contract.limits,
      ),
    ).toBeNull();
    readout('表 → 造包 → 读回', container, bytes.length, performance.now() - started);
  });

  it('与钉进仓库的夹具**逐字节相同**（除按本地时区写的 DOS 时间字段）', async () => {
    const bytes = await buildGolden();
    if (!existsSync(CONTAINER_PATH) || process.env.KOJO_ZIP_FIXTURE_UPDATE === '1') {
      writeFileSync(CONTAINER_PATH, bytes);
    }
    const pinned = new Uint8Array(readFileSync(CONTAINER_PATH));
    expect(maskDosTime(bytes, readZipContainer(bytes))).toEqual(maskDosTime(pinned, readZipContainer(pinned)));
  });

  it('夹具容器（Rust 侧读的是同一个文件）读回来仍与表逐条目平', async () => {
    const started = performance.now();
    const pinned = new Uint8Array(readFileSync(CONTAINER_PATH));
    const container = readZipContainer(pinned);
    expect(container.entries.length).toBe(contract.golden.entryCount);
    let body = 0;
    for (const entry of container.entries) {
      const want = contract.golden.entries.find((e) => e.name === entry.name);
      expect(want, entry.name).toBeDefined();
      expect(entry.crc).toBe(parseInt(want!.crc, 16));
      expect(entry.uncompressedSize).toBe(want!.bytes);
      const bytes = await inflateZipEntry(entry);
      expect(bytes, want!.name).toEqual(decodeBase64(want!.contentBase64));
      body += bytes.length;
    }
    expect(body).toBe(contract.golden.totalUnpackedBytes);
    expect(zipContainerContractProblem(container, contract.limits)).toBeNull();
    readout('夹具在位（钉数容器）', container, pinned.length, performance.now() - started);
  });
});

/* ------------------------------ 5. 篡改负自证 ------------------------------ */

describe('篡改容器的两侧同判（TS 半边）', () => {
  const namesInGolden = contract.golden.entries.map((e) => e.name);
  for (const caseOf of contract.tampers) {
    it(`${caseOf.id} → ${caseOf.code}`, async () => {
      const pinned = new Uint8Array(readFileSync(CONTAINER_PATH));
      const bad = tamper(pinned, caseOf);
      // ZIP64 哨兵那一只是"整只容器不再可读"的形态，条数字段本就被替换掉 ⇒ 只判码
      if (caseOf.setEocdTotalEntryCount === undefined) expect(bad.length, caseOf.id).toBe(pinned.length);
      const container = readZipContainer(bad);
      const problem = zipContainerContractProblem(container, contract.limits);
      expect(problem, caseOf.id).not.toBeNull();
      expect(codeOf(problem!)).toBe(caseOf.code);
      if (caseOf.setEocdTotalEntryCount === undefined) {
        expect(container.entries.length, caseOf.id).toBe(contract.golden.entryCount);
      }
      if (caseOf.rename !== undefined && namesInGolden.includes(caseOf.rename.to)) {
        // 精确重名那一只是读器口径的洞：`zip` crate 按名字建索引（同款口径的 `dedupedEntryCount`），
        // 同名条目被**静默合并**，条目数与落盘内容都已经不是包里的那份 ⇒ 只有中央目录原数能发现
        expect(container.dedupedEntryCount, caseOf.id).toBeLessThan(container.entries.length);
      }
    });
  }

  it('被改过一个数据字节的容器过不了自证（entry-bytes 而非静默少一个文件）', async () => {
    const items = [{ name: 'a.txt', data: bytesOf('hello world') }];
    const bytes = await buildZip(items, { contract: 'extractable', compress: false });
    const flipped = bytes.slice();
    const container = readZipContainer(flipped);
    const payloadStart = container.entries[0]!.dataOffset;
    flipped[payloadStart] = flipped[payloadStart]! ^ 0xff;
    const problem = await verifyZipRoundtrip(flipped, items, contract.limits);
    expect(problem).not.toBeNull();
    expect(problem!).toMatch(/^entry-bytes：.*内容逐字节往返不符/);
    // 头里的 CRC 仍是旧值 ⇒ 内容与头已经不是同一份东西
    expect(container.entries[0]!.crc).toBe(crc32(bytesOf('hello world')));
  });
});

/* ------------------- 6. 契约档与通用档的分界（导出链路那一档） ------------------- */

describe('buildZip 的契约档', () => {
  it("contract:'extractable' 在写第一个字节之前拒：目录条目 / 上跳 / 超深 / 大小写重名 / 条目数", async () => {
    for (const [name, code] of [
      ['子目录/', 'path-empty-segment'],
      ['../escape.txt', 'path-dotdot'],
      ['a/b/c/d/e/f/g/h/i/j/k/l/m/n.txt', 'path-depth'],
      ['C:/windows/a.txt', 'path-drive'],
    ] as [string, string][]) {
      await expect(buildZip([{ name, data: bytesOf('x') }], { contract: 'extractable' })).rejects.toThrow(
        new RegExp(`^${code}：`),
      );
    }
    await expect(
      buildZip(
        [
          { name: 'ERB/事件.ERB', data: bytesOf('a') },
          { name: 'erb/事件.erb', data: bytesOf('b') },
        ],
        { contract: 'extractable' },
      ),
    ).rejects.toThrow(/^entry-duplicate：/);
    await expect(
      buildZip(
        [
          { name: 'a.txt', data: bytesOf('a') },
          { name: 'b.txt', data: bytesOf('b') },
        ],
        { contract: 'extractable', limits: { ...contract.limits, maxEntries: 1 } },
      ),
    ).rejects.toThrow(/^entries-limit：/);
  });

  it('默认档（generic）零改动：目录条目照样能写（跨工具形态，与平台解包器无关）', async () => {
    const bytes = await buildZip([
      { name: '空目录/', data: new Uint8Array(0) },
      { name: '空目录/占位.txt', data: bytesOf('hi') },
    ]);
    const container = readZipContainer(bytes);
    expect(container.entries.map((e) => e.name)).toEqual(['空目录/', '空目录/占位.txt']);
    expect(codeOf(zipContainerContractProblem(container, contract.limits)!)).toBe('path-empty-segment');
  });

  it('导出形态（根 = 中文目录名、输入带反斜杠）过得了平台闸，且包内路径恒为 posix 形态', async () => {
    const root = '东方口上-灵梦 v1.0';
    const items = [
      { name: `${root}/README.md`, data: bytesOf('# 说明\n') },
      { name: `${root}/ERB/口上・メッセージ関連/事件.ERB`, data: bytesOf('@A\n') },
      { name: `${root}\\CSV\\Chara\\Chara1 测试角色.csv`, data: bytesOf('名称,值\n') },
    ];
    const started = performance.now();
    const bytes = await buildZip(items, { contract: 'extractable', date: contract.golden.dateMs });
    expect(await verifyZipRoundtrip(bytes, items, contract.limits)).toBeNull();
    const container = readZipContainer(bytes);
    expect(container.entries.map((e) => e.name)).toEqual([
      `${root}/README.md`,
      `${root}/ERB/口上・メッセージ関連/事件.ERB`,
      `${root}/CSV/Chara/Chara1 测试角色.csv`,
    ]);
    readout('导出形态', container, bytes.length, performance.now() - started);
  });
});

describe('zipEntryContractProblem · Windows 保留设备名（归入既有 entry-name-encoding 码）', () => {
  it('本体 / 带扩展名变体 / 深层路径里的段 / 大小写不敏感全拒；普通名不误伤', () => {
    expect(zipEntryContractProblem('CON')).toBe('entry-name-encoding');
    expect(zipEntryContractProblem('con.txt')).toBe('entry-name-encoding');
    expect(zipEntryContractProblem('ERB/口上/CON.tar.gz')).toBe('entry-name-encoding');
    expect(zipEntryContractProblem('COM1')).toBe('entry-name-encoding');
    expect(zipEntryContractProblem('LPT4.erb')).toBe('entry-name-encoding');
    expect(zipEntryContractProblem('CONTOUR.erb')).toBeNull();
    expect(zipEntryContractProblem('ERB/口上/nulless.txt')).toBeNull();
  });

  it('buildZip 契约档在写第一个字节之前就拒（与既有判据同一条链）', async () => {
    await expect(
      buildZip([{ name: 'ERB/CON.txt', data: bytesOf('x') }], { contract: 'extractable' }),
    ).rejects.toThrow(/^entry-name-encoding：/);
  });
});

describe('zipEntryContractProblem · 尾点尾空格与 ADS（宿主同名缺口的对侧锚）', () => {
  it('任一段尾随点/空格 → path-windows-unsafe；段内冒号 → path-drive（ADS）；合法名不误伤', () => {
    expect(zipEntryContractProblem('files/a.txt.')).toBe('path-windows-unsafe');
    // 末位是真空格（编辑器里看不见，靠共享表同一行钉住）
    expect(zipEntryContractProblem('files/a.txt ')).toBe('path-windows-unsafe');
    expect(zipEntryContractProblem('files/sub./a.txt')).toBe('path-windows-unsafe');
    expect(zipEntryContractProblem('files/sub /a.txt')).toBe('path-windows-unsafe');
    expect(zipEntryContractProblem('files/a.txt:stream')).toBe('path-drive');
    expect(zipEntryContractProblem('files/a.txt::$DATA')).toBe('path-drive');
    expect(zipEntryContractProblem('files/13:00.txt')).toBe('path-drive');
    // 盘符仍然是盘符（顺序：盘符先于绝对路径，判定码不变）
    expect(zipEntryContractProblem('C:/windows/a.txt')).toBe('path-drive');
    // 合法形态零误伤：中间有点、点多于一个、深目录都放行
    expect(zipEntryContractProblem('files/v1.0/README.md')).toBeNull();
    expect(zipEntryContractProblem('files/a.b.c.txt')).toBeNull();
    expect(zipEntryContractProblem('files/deep/说明.txt')).toBeNull();
  });

  it('buildZip 契约档在写第一个字节之前就拒（写侧同一套闸）', async () => {
    for (const [name, code] of [
      ['files/a.txt.', 'path-windows-unsafe'],
      ['files/a.txt ', 'path-windows-unsafe'],
      ['files/a.txt:stream', 'path-drive'],
    ] as [string, string][]) {
      await expect(buildZip([{ name, data: bytesOf('x') }], { contract: 'extractable' })).rejects.toThrow(
        new RegExp(`^${code}：`),
      );
    }
  });
});
