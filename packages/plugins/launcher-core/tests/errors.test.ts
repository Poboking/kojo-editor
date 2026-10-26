/**
 * 错误归一：宿主 DTO → 中文 `LauncherError`。
 *
 * 三条要钉的纪律：码不改写、`retryable` 透传、英文 OS 串不透传给用户。
 */

import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_ERROR_MESSAGES,
  isLauncherError,
  isLauncherErrorCode,
  launcherError,
  normalizeLauncherError,
} from '../src/errors';

describe('normalizeLauncherError · 宿主 DTO', () => {
  it('中文话术原样保留，detail 与码都不动，retryable 透传', () => {
    const dto = {
      code: 'LAUNCHER_TRUST_CHANGED',
      message: '目标程序与上次确认的不一致',
      detail: 'game.exe · sha256 9f2c…',
      retryable: false,
    };
    const error = normalizeLauncherError(dto);
    expect(error).toMatchObject({
      code: 'LAUNCHER_TRUST_CHANGED',
      message: '目标程序与上次确认的不一致',
      detail: 'game.exe · sha256 9f2c…',
      retryable: false,
    });
    // retryable 的宿主值优先于码级默认（TRUST_CHANGED 默认可重试）
    expect(launcherError('LAUNCHER_TRUST_CHANGED').retryable).toBe(true);
  });

  it('纯英文 OS 串不透传：换中文默认话术，原文压进 detail', () => {
    const error = normalizeLauncherError({
      code: 'LAUNCHER_EXECUTABLE_INVALID',
      message: 'Access is denied. (os error 5)',
      detail: 'game/game.exe',
      retryable: false,
    });
    expect(error.code).toBe('LAUNCHER_EXECUTABLE_INVALID');
    expect(error.message).toBe(LAUNCHER_ERROR_MESSAGES.LAUNCHER_EXECUTABLE_INVALID);
    expect(error.detail).toBe('game/game.exe · 宿主原文：Access is denied. (os error 5)');
    expect(error.retryable).toBe(false);
  });

  it('合集外的码降级为 LAUNCHER_INTERNAL，但原码留在 detail（不静默丢）', () => {
    const error = normalizeLauncherError({ code: 'LAUNCHER_WHAT_IS_THIS', message: '未知故障' });
    expect(error.code).toBe('LAUNCHER_INTERNAL');
    expect(error.message).toBe('未知故障');
    expect(error.detail).toBe('宿主错误码：LAUNCHER_WHAT_IS_THIS');
  });

  it('本层补充的上下文与宿主 detail 并列，不覆盖', () => {
    const error = normalizeLauncherError(
      { code: 'LAUNCHER_INSTANCE_NOT_READY', message: '实例尚未就绪', detail: 'state=broken' },
      { detail: '创建实例失败' },
    );
    expect(error.detail).toBe('state=broken · 创建实例失败');
    expect(error.code).toBe('LAUNCHER_INSTANCE_NOT_READY');
  });

  it('非结构化抛出物：字符串 / Error / 已有 LauncherError', () => {
    expect(normalizeLauncherError('boom')).toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      message: LAUNCHER_ERROR_MESSAGES.LAUNCHER_INTERNAL,
      retryable: true,
    });
    expect(normalizeLauncherError('boom').detail).toBe('boom');

    expect(normalizeLauncherError(new Error('socket hang up'))).toMatchObject({
      code: 'LAUNCHER_INTERNAL',
      retryable: true,
    });

    const existing = launcherError('LAUNCHER_INSTANCE_BUSY', { detail: '已有操作' });
    // 幂等：再归一一次得到等值对象（不做「形状像就原样返回」的短路，见实现注释）
    expect(normalizeLauncherError(existing)).toEqual(existing);
    expect(normalizeLauncherError(existing, { detail: '再次检查' }).detail).toBe('已有操作 · 再次检查');
  });

  it('fallbackCode 只在主体没有可用码时生效', () => {
    expect(normalizeLauncherError(new Error('x'), { fallbackCode: 'LAUNCHER_INSTANCE_NOT_FOUND' }).code).toBe(
      'LAUNCHER_INSTANCE_NOT_FOUND',
    );
    expect(
      normalizeLauncherError({ code: 'LAUNCHER_PATH_ESCAPE', message: '路径逃逸' }, { fallbackCode: 'LAUNCHER_INTERNAL' }).code,
    ).toBe('LAUNCHER_PATH_ESCAPE');
  });
});

describe('错误码表与判据', () => {
  it('话术表覆盖全集且无空文案；判据只认表里的码', () => {
    const codes = Object.keys(LAUNCHER_ERROR_MESSAGES);
    expect(codes.length).toBeGreaterThan(20);
    for (const code of codes) {
      expect(LAUNCHER_ERROR_MESSAGES[code as keyof typeof LAUNCHER_ERROR_MESSAGES].length).toBeGreaterThan(0);
      expect(isLauncherErrorCode(code)).toBe(true);
    }
    expect(isLauncherErrorCode('LAUNCHER_NOT_A_CODE')).toBe(false);
    expect(isLauncherErrorCode(undefined)).toBe(false);
  });

  it('isLauncherError 只认完整形状（码 + 文案 + retryable）', () => {
    expect(isLauncherError(launcherError('LAUNCHER_INTERNAL'))).toBe(true);
    expect(isLauncherError({ code: 'LAUNCHER_INTERNAL', message: 'x' })).toBe(false);
    expect(isLauncherError(null)).toBe(false);
  });
});
