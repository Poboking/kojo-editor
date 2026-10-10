/**
 * 合成存档字节构造器（仅测试用）。
 *
 * 手写镜像引擎写侧的字节语义（与 `src/` 的读侧实现**独立**——单测即双向对拍）：
 * - 16 字节明文头：魔数 + 1808 + 保留字段；
 * - 正文：gzip（node:zlib，测试环境专有）或裸字节；
 * - 字符串 7-bit 前缀 = **字节数**；整数 ≤0xCF 直写 / 0xD0 / 0xD1 / 0xD2。
 *
 * 真实游戏存档不入库（隐私 + 体积）；合成样本覆盖协议全形态，
 * 真实档回归走 `KOJO_SMOKE_PROJECT` 集成冒烟。
 */

import { gzipSync } from 'node:zlib';

/** 小端字节写器 */
export class W {
  private readonly parts: number[] = [];

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    this.u8(v & 0xff);
    this.u8((v >> 8) & 0xff);
    return this;
  }

  u32(v: number): this {
    this.u8(v & 0xff);
    this.u8((v >>> 8) & 0xff);
    this.u8((v >>> 16) & 0xff);
    this.u8((v >>> 24) & 0xff);
    return this;
  }

  i64(v: bigint): this {
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.u8(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  /** 7-bit 变长无符号整数（.NET 长度前缀） */
  u7(v: number): this {
    let x = v;
    for (;;) {
      const b = x & 0x7f;
      x = Math.floor(x / 128);
      if (x === 0) return this.u8(b);
      this.u8(b | 0x80);
    }
  }

  /** .NET 字符串：7-bit 前缀（字节数）+ UTF-16LE */
  str(s: string): this {
    const buf = Buffer.from(s, 'utf16le');
    this.u7(buf.length);
    for (const b of buf) this.u8(b);
    return this;
  }

  /** m_WriteInt 编码整数（读侧 m_ReadInt 的镜像） */
  int(v: number): this {
    if (v >= 0 && v <= 0xcf) return this.u8(v);
    if (v >= -0x8000 && v <= 0x7fff) {
      this.u8(0xd0);
      return this.u16(v);
    }
    if (v >= -0x80000000 && v <= 0x7fffffff) {
      this.u8(0xd1);
      return this.u32(v);
    }
    this.u8(0xd2);
    return this.i64(BigInt(v));
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }

  static concat(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

export const MAGIC_GZIP = 0x0a50495a41524589n;
export const MAGIC_RAW = 0x0a1a0a0d41524589n;

export interface ArchiveSpec {
  fileType: 0 | 1 | 2 | 3;
  uniqueCode?: bigint;
  gameVersion?: bigint;
  saveMes?: string;
  charCount?: number;
  /** 第 i 个角色块的字节（normal / charvar） */
  charBlock?: (w: W, i: number) => void;
  /** 主 / 全局变量区（normal / var / global）；无需自写结尾 0xFF */
  vars?: (w: W) => void;
  /** EM 扩展区（normal / global）；无需自写结尾 0xFF */
  em?: (w: W) => void;
  /** 存档后是否附加 EM 区（默认 false：无 em 回调时不写） */
  withEm?: boolean;
  /** 默认 true = gzip；false = 裸正文 */
  compress?: boolean;
  /** 覆盖格式版本（错误路径测试用） */
  versionOverride?: number;
  /** 覆盖魔数（错误路径测试用） */
  magicOverride?: bigint;
}

/** 构造完整存档文件字节 */
export function makeArchiveFile(spec: ArchiveSpec): Uint8Array {
  const body = new W();
  body.u8(spec.fileType);
  body.i64(spec.uniqueCode ?? 7153n);
  body.i64(spec.gameVersion ?? 0n);
  body.str(spec.saveMes ?? '');

  const isCharFile = spec.fileType === 0 || spec.fileType === 3;
  const hasVarArea = spec.fileType === 0 || spec.fileType === 2 || spec.fileType === 1;

  if (isCharFile) {
    const n = spec.charCount ?? 0;
    body.i64(BigInt(n));
    for (let i = 0; i < n; i++) spec.charBlock?.(body, i);
  }
  if (hasVarArea) {
    spec.vars?.(body);
    body.u8(0xff);
  }
  if (spec.fileType === 0 || spec.fileType === 1) {
    if (spec.em || spec.withEm) {
      spec.em?.(body);
      body.u8(0xff);
    }
  }

  const header = new W();
  header.i64(spec.magicOverride ?? (spec.compress === false ? MAGIC_RAW : MAGIC_GZIP));
  header.u32(spec.versionOverride ?? 1808);
  header.u32(0);

  const payload = spec.compress === false ? body.bytes() : new Uint8Array(gzipSync(body.bytes()));
  return W.concat(header.bytes(), payload);
}

/** 常用角色块：内置 3 变量 + Separator + 1 个 #DIM 变量 + EOC */
export function simpleCharBlock(w: W, no: number): void {
  w.u8(0x00).str('NO').int(no);
  w.u8(0x10).str('NAME').str(`角色${no}`);
  w.u8(0x01).str('CFLAG').u32(4).u8(1).u8(0xf0).u8(2).u8(3).u8(0xff); // [1,_,_,3]
  w.u8(0xfd); // 内置 / #DIM 分隔
  w.u8(0x00).str('TEST_DIM').int(-1); // 0xD0 路径
  w.u8(0xfe); // EOC
}
