/**
 * 字节保真回归：parse→serialize→assemble 对"用户从未改动、却必须原样还原"的
 * 残余字节逐字节还原。金样本六档只含 ≤1 分隔符且 remaining==0，触不到下面这些
 * 残余字节类；本文件用**手工构造的档**把每一类钉死成 byte-identity 断言。
 *
 * 覆盖四类（均在真实语料之外）：
 *  1. 主变量流多分隔符（readVarStream 旧版丢弃 0xFD）；
 *  2. 角色块两个分隔符（readCharBlock 旧版只保留最后一个）；
 *  3. 尾部残余字节（parse 计 `remaining` 却从不回写）；
 *  4. 非零保留头 [12..16]（旧版假设恒 0 并在重组时清零）。
 *
 * 对拍强度：**整文件逐字节相同**（raw 容器——头与正文皆我方控制，压缩流不
 * 参与的档型可直接对拍）；gzip 容器另测"解压载荷逐字节相同"（gzip 流本身
 * 不必逐字节还原，读侧解压即同——与 container.ts 既有口径一致）。
 */
import { describe, expect, it } from 'vitest';
import type { SnapshotArchive } from '@kojo/plugin-api';
import { assembleArchiveFile } from '../src/container';
import { getFidelity } from '../src/fidelity';
import { gunzipBytes } from '../src/gunzip';
import { parseArchive } from '../src/parse';
import { serializePayload } from '../src/serialize';
import { makeGzipFile, makeRawFile, W } from './helpers/synth';

const PATH = 'C:/games/tw/sav/fidelity.sav';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 首个差异偏移（失败时定位用） */
function firstDiffIndex(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/**
 * 整档保真回环（与 engine.inject 的 parse→serialize→assemble 链路同构）：
 * raw 容器返回**逐字节还原后的整文件**；非 raw 时 body 段即我方注入保真字节后
 * 的产物。保留头经 getFidelity 旁路透传给 assembleArchiveFile。
 */
async function roundTripFile(archive: SnapshotArchive): Promise<Uint8Array> {
  const payload = serializePayload(archive);
  return assembleArchiveFile(payload, archive.format, getFidelity(archive)?.reservedHeader);
}

describe('字节保真：主变量流多分隔符', () => {
  // 构造 var 型档（fileType=2）：主变量流 [ A , 分隔 , B , 分隔 , C ] EOF
  it('0xFD 在变量流中出现多次 → 保序回写 → 整文件逐字节相同', async () => {
    const body = new W();
    body.u8(2).i64(7153n).i64(0n).str(''); // var 型顶层
    body.u8(0x00).str('A').int(1);
    body.u8(0xfd); // separator #1（旧版 readVarStream 直接 continue 丢弃）
    body.u8(0x00).str('B').int(2);
    body.u8(0xfd); // separator #2（再来一个）
    body.u8(0x00).str('C').int(3);
    body.u8(0xff); // EOF
    const file = makeRawFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepArrayCells: true, keepRaw: true });
    expect(archive.vars).toHaveLength(3);
    expect(archive.remaining).toBe(0);
    // 保真旁路须记到**两个**分隔符位置
    expect(getFidelity(archive)?.varSeps).toEqual([1, 2]);

    const round = await roundTripFile(archive);
    expect(firstDiffIndex(round, file)).toBe(-1);
    expect(bytesEqual(round, file)).toBe(true);
  });

  it('分隔符在流首 / 流尾（EOF 之前）也保序还原', async () => {
    const body = new W();
    body.u8(2).i64(1n).i64(0n).str('');
    body.u8(0xfd); // 首字节即分隔符（在任何变量之前）
    body.u8(0x00).str('X').int(7);
    body.u8(0xfd); // 变量之后、EOF 之前又一个分隔符
    body.u8(0xff); // EOF
    const file = makeRawFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    expect(archive.vars).toHaveLength(1);
    expect(getFidelity(archive)?.varSeps).toEqual([0, 1]); // 前(0) 与 尾(1=len)

    const round = await roundTripFile(archive);
    expect(bytesEqual(round, file)).toBe(true);
  });

  it('EM 扩展区的分隔符同样保序回写（gzip 容器：解压载荷逐字节相同）', async () => {
    const body = new W();
    body.u8(0).i64(9n).i64(0n).str(''); // normal 型
    body.i64(0n); // charCount=0
    body.u8(0x00).str('DAY').int(1);
    body.u8(0xff); // 主变量区 EOF
    // EM 区（normal 的第二段）
    body.u8(0x22).str('DT1').str('<s/>').str('<d/>');
    body.u8(0xfd); // EM 区分隔符
    body.u8(0x21).str('XML1').str('<a/>');
    body.u8(0xff); // EM 区 EOF
    const file = makeGzipFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    expect(archive.emVars).toHaveLength(2);
    expect(getFidelity(archive)?.emVarSeps).toEqual([1]);

    const reserialized = serializePayload(archive);
    const originalPayload = await gunzipBytes(file.subarray(16));
    expect(bytesEqual(reserialized, originalPayload)).toBe(true);
  });
});

describe('字节保真：角色块两个分隔符', () => {
  it('一个角色块含 2 个 0xFD（旧版只留最后一个）→ 全部回写 → 整文件逐字节相同', async () => {
    const body = new W();
    body.u8(0).i64(42n).i64(0n).str('备注'); // normal 型顶层
    body.i64(1n); // charCount=1
    // 角色块：内置 V1，分隔，#DIM V2，分隔，#DIM V3，EOC
    body.u8(0x00).str('V1').int(10);
    body.u8(0xfd); // separator 1
    body.u8(0x00).str('V2').int(20);
    body.u8(0xfd); // separator 2（旧版覆盖 dimSepIndex → 丢这一个）
    body.u8(0x00).str('V3').int(30);
    body.u8(0xfe); // EOC
    body.u8(0xff); // 主变量区（空）EOF
    const file = makeRawFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    const block = archive.chars![0]!;
    expect(block.vars).toHaveLength(3);
    expect(block.dimSepIndex).toBe(1); // 首个分隔符（内置 / #DIM 分界）
    expect(getFidelity(archive)?.charSeps.get(0)).toEqual([1, 2]); // 两个都记

    const round = await roundTripFile(archive);
    expect(firstDiffIndex(round, file)).toBe(-1);
    expect(bytesEqual(round, file)).toBe(true);
  });
});

describe('字节保真：尾部残余字节', () => {
  it('最终 EOF 之后的填充字节 → 原样回写 → 整文件逐字节相同', async () => {
    const body = new W();
    body.u8(2).i64(5n).i64(0n).str('');
    body.u8(0x00).str('SOLO').int(1);
    body.u8(0xff); // EOF（协议在此结束）
    // 尾部残余：引擎在 EOF 之后留下的填充（金样本没有，构造来验）
    const trailing = [0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f];
    for (const b of trailing) body.u8(b);
    const file = makeRawFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    expect(archive.remaining).toBe(trailing.length);
    expect(Array.from(getFidelity(archive)?.trailingBytes ?? [])).toEqual(trailing);

    const round = await roundTripFile(archive);
    expect(firstDiffIndex(round, file)).toBe(-1);
    expect(bytesEqual(round, file)).toBe(true);
  });
});

describe('字节保真：非零保留头 [12..16]', () => {
  it('保留字段非零 → 捕获并原样回写 → 整文件逐字节相同', async () => {
    const body = new W();
    body.u8(2).i64(8n).i64(0n).str('');
    body.u8(0x00).str('K').int(1);
    body.u8(0xff);
    const reserved = [0x11, 0x22, 0x33, 0x44]; // 非零保留头（旧版重组时清零）
    const file = makeRawFile(body.bytes(), reserved);

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    expect(Array.from(getFidelity(archive)?.reservedHeader ?? [])).toEqual(reserved);

    const round = await roundTripFile(archive);
    expect(firstDiffIndex(round, file)).toBe(-1);
    expect(bytesEqual(round, file)).toBe(true);
    // 逐字节校验保留段确在原位（防"整体相同但错位"假象）
    expect(Array.from(round.subarray(12, 16))).toEqual(reserved);
  });

  it('四类残余同档叠加（多分隔符 + 双角色块分隔 + 尾字节 + 非零保留头）', async () => {
    const body = new W();
    body.u8(0).i64(123n).i64(0n).str('复合档');
    body.i64(2n); // charCount=2
    // 角色块 0：一个分隔符
    body.u8(0x00).str('C0').int(1);
    body.u8(0xfd);
    body.u8(0x00).str('C0D').int(2);
    body.u8(0xfe);
    // 角色块 1：两个分隔符
    body.u8(0x00).str('C1').int(3);
    body.u8(0xfd);
    body.u8(0x00).str('C1A').int(4);
    body.u8(0xfd);
    body.u8(0x00).str('C1B').int(5);
    body.u8(0xfe);
    // 主变量区：多分隔符
    body.u8(0x00).str('M1').int(6);
    body.u8(0xfd);
    body.u8(0x00).str('M2').int(7);
    body.u8(0xff); // 主变量区 EOF
    // EM 扩展区（normal 的第二段）：一个变量 + EOF（尾字节须落在最终 EOF 之后）
    body.u8(0x21).str('EMX').str('<e/>');
    body.u8(0xff); // EM 区 EOF
    // 尾部残余（最终 EOF 之后）
    body.u8(0xaa).u8(0xbb).u8(0xcc);
    const reserved = [0xff, 0x00, 0x5a, 0xa5];
    const file = makeRawFile(body.bytes(), reserved);

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    expect(getFidelity(archive)?.charSeps.get(1)).toEqual([1, 2]);
    expect(getFidelity(archive)?.varSeps).toEqual([1]);
    expect(archive.remaining).toBe(3);

    const round = await roundTripFile(archive);
    expect(firstDiffIndex(round, file)).toBe(-1);
    expect(bytesEqual(round, file)).toBe(true);
  });
});

describe('字节保真：无残余构造档在旁路缺省下逐字节不变（防回归）', () => {
  it('手工构造档（无保真旁路）仍走 dimSepIndex 单点语义 + 无尾字节 + 保留头清零', async () => {
    const body = new W();
    body.u8(0).i64(1n).i64(0n).str('');
    body.i64(1n); // charCount=1
    body.u8(0x00).str('NO').int(0);
    body.u8(0xfd); // 单分隔符 → dimSepIndex
    body.u8(0x00).str('DIM').int(9);
    body.u8(0xfe);
    body.u8(0xff);
    const file = makeRawFile(body.bytes());

    const archive = await parseArchive(file, PATH, { keepRaw: true });
    // 该档确由 parse 产生 → 有旁路；用旁路回环应字节相同
    const round = await roundTripFile(archive);
    expect(bytesEqual(round, file)).toBe(true);
    // 保留头恒 0（未指定 reserved）
    expect(Array.from(round.subarray(12, 16))).toEqual([0, 0, 0, 0]);
  });
});
