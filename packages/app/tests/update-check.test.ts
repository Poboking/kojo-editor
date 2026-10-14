import { describe, expect, it } from 'vitest';
import {
  downloadProgressText,
  formatBytes,
  isUpdateBusy,
  reduceUpdatePhase,
  updateStatus,
  type UpdatePhase,
} from '../src/ui/update-check';

/**
 * 检查更新状态机单测（REL-2 设置页）。
 *
 * 单测环境是 `node`（不碰 @tauri-apps/plugin-updater）：这里只钉**纯状态机**的
 * 三条契约——①迁移只在合法前置态生效，非法一律原样返回（不抛、不造中间态）；
 * ②进度是「累加分片」语义（updater 的 Progress 事件只带本次 chunkLength）；
 * ③失败态是一等公民（私仓尚未发布 release，check() 404 是这段时期的常态路径）。
 */

const IDLE: UpdatePhase = { kind: 'idle' };
const CHECKING: UpdatePhase = { kind: 'checking' };

describe('reduceUpdatePhase：检查链', () => {
  it('idle → checkStart → checking，任何态都能重新发起检查', () => {
    expect(reduceUpdatePhase(IDLE, { type: 'checkStart' })).toEqual(CHECKING);
    expect(reduceUpdatePhase({ kind: 'done' }, { type: 'checkStart' })).toEqual(CHECKING);
    expect(reduceUpdatePhase({ kind: 'failed', stage: 'check' }, { type: 'checkStart' })).toEqual(CHECKING);
  });

  it('checking → checkLatest / checkFound；非法前置态一律原样返回', () => {
    expect(reduceUpdatePhase(CHECKING, { type: 'checkLatest' })).toEqual({ kind: 'latest' });
    expect(reduceUpdatePhase(CHECKING, { type: 'checkFound', version: '0.2.0' })).toEqual({
      kind: 'found',
      version: '0.2.0',
    });
    // 版本号为空是脏数据：停在 checking，不落 found
    expect(reduceUpdatePhase(CHECKING, { type: 'checkFound', version: '' })).toEqual(CHECKING);
    expect(reduceUpdatePhase(IDLE, { type: 'checkLatest' })).toEqual(IDLE);
    expect(reduceUpdatePhase(IDLE, { type: 'checkFound', version: '0.2.0' })).toEqual(IDLE);
  });

  it('checking → checkFailed 落失败态（check 档）；非 checking 不迁移', () => {
    expect(reduceUpdatePhase(CHECKING, { type: 'checkFailed' })).toEqual({
      kind: 'failed',
      stage: 'check',
    });
    expect(reduceUpdatePhase(IDLE, { type: 'checkFailed' })).toEqual(IDLE);
  });
});

describe('reduceUpdatePhase：安装链', () => {
  const FOUND: UpdatePhase = { kind: 'found', version: '0.2.0' };

  it('found → installStart 进入 downloading（received 归零）；总量未知记 null', () => {
    expect(reduceUpdatePhase(FOUND, { type: 'installStart', total: null })).toEqual({
      kind: 'downloading',
      received: 0,
      total: null,
    });
    expect(reduceUpdatePhase(FOUND, { type: 'installStart', total: 2048 })).toEqual({
      kind: 'downloading',
      received: 0,
      total: 2048,
    });
  });

  it('downloading 中的 installStart 是重入（Started 事件补报总量，不清零已收字节）', () => {
    const mid: UpdatePhase = { kind: 'downloading', received: 300, total: null };
    expect(reduceUpdatePhase(mid, { type: 'installStart', total: 1000 })).toEqual({
      kind: 'downloading',
      received: 300,
      total: 1000,
    });
  });

  it('installProgress 累加分片；非正分片与非法前置态是 no-op', () => {
    let phase = reduceUpdatePhase(FOUND, { type: 'installStart', total: 1024 * 1024 });
    phase = reduceUpdatePhase(phase, { type: 'installProgress', chunk: 300 });
    phase = reduceUpdatePhase(phase, { type: 'installProgress', chunk: 700 });
    expect(phase).toEqual({ kind: 'downloading', received: 1000, total: 1024 * 1024 });
    expect(reduceUpdatePhase(phase, { type: 'installProgress', chunk: 0 })).toEqual(phase);
    expect(reduceUpdatePhase(phase, { type: 'installProgress', chunk: -5 })).toEqual(phase);
    expect(reduceUpdatePhase(FOUND, { type: 'installProgress', chunk: 100 })).toEqual(FOUND);
  });

  it('downloading → installDone 落 done；installFailed 落失败态（install 档）', () => {
    const mid: UpdatePhase = { kind: 'downloading', received: 100, total: 100 };
    expect(reduceUpdatePhase(mid, { type: 'installDone' })).toEqual({ kind: 'done' });
    expect(reduceUpdatePhase(mid, { type: 'installFailed' })).toEqual({
      kind: 'failed',
      stage: 'install',
    });
    // found 态直接收「完成」事件：没开始下载就没有完成
    expect(reduceUpdatePhase(FOUND, { type: 'installDone' })).toEqual(FOUND);
  });
});

describe('isUpdateBusy：进行中判定', () => {
  it('checking 与 downloading 算忙，其余不忙', () => {
    expect(isUpdateBusy(CHECKING)).toBe(true);
    expect(isUpdateBusy({ kind: 'downloading', received: 0, total: null })).toBe(true);
    expect(isUpdateBusy(IDLE)).toBe(false);
    expect(isUpdateBusy({ kind: 'latest' })).toBe(false);
    expect(isUpdateBusy({ kind: 'found', version: '0.2.0' })).toBe(false);
    expect(isUpdateBusy({ kind: 'done' })).toBe(false);
    expect(isUpdateBusy({ kind: 'failed', stage: 'check' })).toBe(false);
  });
});

describe('formatBytes：字节展示', () => {
  it('三档换算（B / KB / MB，小数点后一位）', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  it('负数与非有限值按 0 处理，不产生 NaN 文案', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('downloadProgressText：进度行', () => {
  it('总量未知（null / 0）回 null，调用方退化为基础文案', () => {
    expect(downloadProgressText(100, null)).toBeNull();
    expect(downloadProgressText(100, 0)).toBeNull();
  });

  it('正常与超收（钳到 100%）', () => {
    expect(downloadProgressText(0, 200)).toBe('已下载 0 B / 200 B（0%）');
    expect(downloadProgressText(100, 200)).toBe('已下载 100 B / 200 B（50%）');
    expect(downloadProgressText(200, 200)).toBe('已下载 200 B / 200 B（100%）');
    expect(downloadProgressText(999, 200)).toBe('已下载 999 B / 200 B（100%）');
  });
});

describe('updateStatus：常驻状态行', () => {
  it('各态文案与色调齐备，found 态回 null（它有自己的专属行）', () => {
    expect(updateStatus(IDLE)).toEqual({ text: '有新版本时，可在这里手动检查', tone: 'dim' });
    expect(updateStatus(CHECKING)).toEqual({ text: '正在检查更新…', tone: 'dim' });
    expect(updateStatus({ kind: 'latest' })).toEqual({ text: '已是最新版本', tone: 'ok' });
    expect(updateStatus({ kind: 'found', version: '0.2.0' })).toBeNull();
    expect(updateStatus({ kind: 'done' })).toEqual({ text: '更新已安装，重启应用后生效', tone: 'ok' });
    expect(updateStatus({ kind: 'failed', stage: 'check' })).toEqual({
      text: '检查失败（网络或尚未发布版本）',
      tone: 'err',
    });
    expect(updateStatus({ kind: 'failed', stage: 'install' })).toEqual({
      text: '下载安装失败，可重试',
      tone: 'err',
    });
  });

  it('downloading：有总量显示进度，无总量退化为基础文案', () => {
    expect(updateStatus({ kind: 'downloading', received: 100, total: 200 })).toEqual({
      text: '已下载 100 B / 200 B（50%）',
      tone: 'dim',
    });
    expect(updateStatus({ kind: 'downloading', received: 100, total: null })).toEqual({
      text: '正在下载安装…',
      tone: 'dim',
    });
  });
});
