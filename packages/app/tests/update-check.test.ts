import { describe, expect, it } from 'vitest';
import {
  appUpdateRelation,
  downloadPercent,
  downloadProgressText,
  formatBytes,
  formatUpdateDate,
  isUpdateBusy,
  normalizeUpdateDate,
  normalizeUpdateNotes,
  reduceUpdatePhase,
  updateDialogPhase,
  updateDialogTitle,
  updateFailureNote,
  updateNoteLines,
  updateStatus,
  visibleUpdateNoteLines,
  UPDATE_NOTE_LINE_LIMIT,
  UPDATE_NOTES_EMPTY,
  UPDATE_SUBJECT,
  type UpdateDialogPhase,
  type UpdatePhase,
} from '../src/ui/update-check';

/**
 * 检查更新状态机单测（REL-2 设置页 · MK-1 语义并一）。
 *
 * 单测环境是 `node`（不碰 @tauri-apps/plugin-updater）：这里只钉**纯状态机**的
 * 三条契约——①迁移只在合法前置态生效，非法一律原样返回（不抛、不造中间态）；
 * ②进度是「累加分片」语义（updater 的 Progress 事件只带本次 chunkLength）；
 * ③失败态是一等公民（私仓尚未发布 release，check() 404 是这段时期的常态路径），
 *   而且**这条话术与包更新那一条同表**（`update-grammar-parity.test.ts` 拿 `packUpdateCheck`
 *   真产出的失败态对拍，改一个字即红）。
 *
 * MK-1 新增的第四条：updater 报回来的那一版**先过契约那把尺**（`appUpdateRelation`）再决定
 * 给哪个态——"有 found 事件"不等于"可更新"，本机已是同版/更高版时不给安装按钮。
 *
 * 用户反馈第 1 条新增第五条：found 带上 `currentVersion` / `notes` / `date`，并一路带到
 * downloading / done / failed(install)（弹窗换态不丢版本，失败重试有据可依）；弹窗判据、
 * 说明按行拆 / 超长截显示、日期格式化也在这里钉住（UpdateDialog 只消费，不再算一遍）。
 */

const IDLE: UpdatePhase = { kind: 'idle' };
const CHECKING: UpdatePhase = { kind: 'checking' };

describe('reduceUpdatePhase：检查链', () => {
  it('idle → checkStart → checking，任何态都能重新发起检查', () => {
    expect(reduceUpdatePhase(IDLE, { type: 'checkStart' })).toEqual(CHECKING);
    expect(reduceUpdatePhase({ kind: 'done', version: '0.2.0' }, { type: 'checkStart' })).toEqual(CHECKING);
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

  it('found → installStart 进入 downloading（received 归零）；总量未知记 null；版本信息一路带走', () => {
    expect(reduceUpdatePhase(FOUND, { type: 'installStart', total: null })).toEqual({
      kind: 'downloading',
      received: 0,
      total: null,
      version: '0.2.0',
    });
    expect(reduceUpdatePhase(FOUND, { type: 'installStart', total: 2048 })).toEqual({
      kind: 'downloading',
      received: 0,
      total: 2048,
      version: '0.2.0',
    });
  });

  it('downloading 中的 installStart 是重入（Started 事件补报总量，不清零已收字节）', () => {
    const mid: UpdatePhase = { kind: 'downloading', received: 300, total: null, version: '0.2.0' };
    expect(reduceUpdatePhase(mid, { type: 'installStart', total: 1000 })).toEqual({
      kind: 'downloading',
      received: 300,
      total: 1000,
      version: '0.2.0',
    });
  });

  it('installProgress 累加分片；非正分片与非法前置态是 no-op', () => {
    let phase = reduceUpdatePhase(FOUND, { type: 'installStart', total: 1024 * 1024 });
    phase = reduceUpdatePhase(phase, { type: 'installProgress', chunk: 300 });
    phase = reduceUpdatePhase(phase, { type: 'installProgress', chunk: 700 });
    expect(phase).toEqual({
      kind: 'downloading',
      received: 1000,
      total: 1024 * 1024,
      version: '0.2.0',
    });
    expect(reduceUpdatePhase(phase, { type: 'installProgress', chunk: 0 })).toEqual(phase);
    expect(reduceUpdatePhase(phase, { type: 'installProgress', chunk: -5 })).toEqual(phase);
    expect(reduceUpdatePhase(FOUND, { type: 'installProgress', chunk: 100 })).toEqual(FOUND);
  });

  it('downloading → installDone 落 done；installFailed 落失败态（install 档，带着这一版的 release）', () => {
    const mid: UpdatePhase = { kind: 'downloading', received: 100, total: 100, version: '0.2.0' };
    expect(reduceUpdatePhase(mid, { type: 'installDone' })).toEqual({
      kind: 'done',
      version: '0.2.0',
    });
    expect(reduceUpdatePhase(mid, { type: 'installFailed' })).toEqual({
      kind: 'failed',
      stage: 'install',
      release: { version: '0.2.0' },
    });
    // found 态直接收「完成」事件：没开始下载就没有完成
    expect(reduceUpdatePhase(FOUND, { type: 'installDone' })).toEqual(FOUND);
    // updater 的 Finished 只代表"下载完"：安装器随后失败时，done 必须能落回失败态（不许粉饰成已安装）
    expect(reduceUpdatePhase({ kind: 'done', version: '0.2.0' }, { type: 'installFailed', reason: '安装器拒绝' })).toEqual({
      kind: 'failed',
      stage: 'install',
      reason: '安装器拒绝',
      release: { version: '0.2.0' },
    });
  });

  it('安装失败 → installStart 允许重试（回到 downloading，版本信息不丢）；检查失败不能直接装', () => {
    const failed: UpdatePhase = {
      kind: 'failed',
      stage: 'install',
      reason: '连接断了',
      release: { version: '0.2.0', currentVersion: '0.1.0' },
    };
    expect(reduceUpdatePhase(failed, { type: 'installStart', total: null })).toEqual({
      kind: 'downloading',
      received: 0,
      total: null,
      version: '0.2.0',
      currentVersion: '0.1.0',
    });
    const failedCheck: UpdatePhase = { kind: 'failed', stage: 'check' };
    expect(reduceUpdatePhase(failedCheck, { type: 'installStart', total: null })).toEqual(failedCheck);
  });
});

describe('appUpdateRelation：updater 那一句先过契约那把尺（MK-1）', () => {
  const CHECK: UpdatePhase = { kind: 'checking' };

  it('给了本机版本 ⇒ "收到 found 事件"不再等于"可更新"：同版与更高版都不给安装态', () => {
    expect(reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.2.0', currentVersion: '0.1.0' })).toEqual({
      kind: 'found',
      version: '0.2.0',
      currentVersion: '0.1.0',
    });
    expect(reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.2.0', currentVersion: '0.2.0' })).toEqual({
      kind: 'latest',
    });
    expect(reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.2.0', currentVersion: '0.3.0' })).toEqual({
      kind: 'latest',
    });
    // 预发布后缀折成核心三段（与包侧 `minAppVersionSatisfied` 同一条口径，不给应用另立一把尺）
    expect(
      reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.4.0', currentVersion: '0.4.0-beta.1' }),
    ).toEqual({ kind: 'latest' });
  });

  it('版本形读不出 ⇒ 显式 failed（不演成"已最新"，也不给安装按钮），那一句仍可重试', () => {
    const p = reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.4', currentVersion: '0.1.0' });
    expect(p).toEqual({
      kind: 'failed',
      stage: 'check',
      reason: '版本号写法本机读不出，无法判断该不该更新',
      detail: '更新 0.4 / 本机 0.1.0',
    });
    expect(updateStatus(p)).toEqual({
      text: `${UPDATE_SUBJECT}没有检查成功，可重试：版本号写法本机读不出，无法判断该不该更新`,
      tone: 'err',
    });
  });

  it('拿不到本机版本（非 Tauri 壳 / getVersion 失败）⇒ 退回"相信 updater 那一句"，不假装比过', () => {
    expect(reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.2.0' })).toEqual({
      kind: 'found',
      version: '0.2.0',
    });
    expect(reduceUpdatePhase(CHECK, { type: 'checkFound', version: '0.2.0', currentVersion: '' })).toEqual({
      kind: 'found',
      version: '0.2.0',
    });
  });

  it('checkFailed / installFailed 带上调用方的病因；没带就落那句常态话术（两种都不是哑巴态）', () => {
    expect(reduceUpdatePhase(CHECK, { type: 'checkFailed', reason: 'HTTP 404', detail: 'endpoint' })).toEqual({
      kind: 'failed',
      stage: 'check',
      reason: 'HTTP 404',
      detail: 'endpoint',
    });
    expect(reduceUpdatePhase(CHECK, { type: 'checkFailed' })).toEqual({ kind: 'failed', stage: 'check' });
    const mid: UpdatePhase = { kind: 'downloading', received: 10, total: 10, version: '0.2.0' };
    expect(reduceUpdatePhase(mid, { type: 'installFailed', reason: '连接断了' })).toEqual({
      kind: 'failed',
      stage: 'install',
      reason: '连接断了',
      release: { version: '0.2.0' },
    });
  });

  it('比较函数本身：三态 + 不可比⇒failed（与包侧 `updateRelationOf` 同一把尺、同一套态名）', () => {
    expect(appUpdateRelation('1.10.0', '1.9.9')).toBe('updatable'); // 逐段数值比，不是字典序
    expect(appUpdateRelation('1.9.9', '1.10.0')).toBe('ahead');
    expect(appUpdateRelation('1.2.3', '1.2.3')).toBe('latest');
    expect(appUpdateRelation('1.2', '1.2.3')).toBe('failed');
    expect(appUpdateRelation('1.2.3', 'v1.2.3')).toBe('failed');
    expect(appUpdateRelation('1.2.3', '')).toBe('failed');
  });
});

describe('checkFound 携带发布信息（用户反馈第 1 条）', () => {
  it('currentVersion / notes / date 原样进 found；CRLF 归一，空白 notes 与坏日期不出现', () => {
    expect(
      reduceUpdatePhase(CHECKING, {
        type: 'checkFound',
        version: '0.5.0',
        currentVersion: '0.4.0-beta.1',
        notes: '## 修复\r\n\r\n- 甲\r\n- 乙\r\n',
        date: '2026-10-17T12:00:00Z',
      }),
    ).toEqual({
      kind: 'found',
      version: '0.5.0',
      currentVersion: '0.4.0-beta.1',
      notes: '## 修复\n\n- 甲\n- 乙\n',
      date: '2026-10-17T12:00:00Z',
    });
    // 说明全空白 / 日期读不出：键不出现（弹窗自己写人话，不挂 "undefined"）
    expect(
      reduceUpdatePhase(CHECKING, {
        type: 'checkFound',
        version: '0.5.0',
        notes: ' \r\n\t ',
        date: 'not-a-date',
      }),
    ).toEqual({ kind: 'found', version: '0.5.0' });
    // 关系不是 updatable 时，latest 态不带任何发布信息（弹窗也不会出现）
    expect(
      reduceUpdatePhase(CHECKING, {
        type: 'checkFound',
        version: '0.5.0',
        currentVersion: '0.5.0',
        notes: 'x',
        date: '2026-10-17T12:00:00Z',
      }),
    ).toEqual({ kind: 'latest' });
  });

  it('found → downloading → done 一路保留发布信息（弹窗换态不丢版本）', () => {
    const found = reduceUpdatePhase(CHECKING, {
      type: 'checkFound',
      version: '0.5.0',
      currentVersion: '0.4.0',
      notes: '- 甲',
      date: '2026-10-17T12:00:00Z',
    });
    const downloading = reduceUpdatePhase(found, { type: 'installStart', total: 100 });
    expect(downloading).toMatchObject({
      kind: 'downloading',
      version: '0.5.0',
      currentVersion: '0.4.0',
      notes: '- 甲',
      date: '2026-10-17T12:00:00Z',
    });
    expect(reduceUpdatePhase(downloading, { type: 'installDone' })).toMatchObject({
      kind: 'done',
      version: '0.5.0',
      currentVersion: '0.4.0',
      notes: '- 甲',
      date: '2026-10-17T12:00:00Z',
    });
  });
});

describe('更新说明 / 日期 / 弹窗判据（用户反馈第 1 条）', () => {
  it('normalizeUpdateNotes：CRLF 归一、全空白视为没有、其余逐字保留（含超长）', () => {
    expect(normalizeUpdateNotes(undefined)).toBeUndefined();
    expect(normalizeUpdateNotes(' \r\n\t ')).toBeUndefined();
    expect(normalizeUpdateNotes('a\r\nb\rc')).toBe('a\nb\nc');
    const long = '长'.repeat(100_000);
    expect(normalizeUpdateNotes(long)).toBe(long);
  });

  it('updateNoteLines：按行拆、去行尾空白与首尾空行、内部空行保留', () => {
    expect(updateNoteLines(undefined)).toEqual([]);
    expect(updateNoteLines('  \n\t\n')).toEqual([]);
    // 行首缩进是作者排版的一部分（pre-wrap 保留），只收掉行尾空白与首尾空行
    expect(updateNoteLines('\n  第一行  \n\n第二行\n\n')).toEqual(['  第一行', '', '第二行']);
  });

  it('visibleUpdateNoteLines：只截显示，total 仍报全量', () => {
    const notes = Array.from({ length: UPDATE_NOTE_LINE_LIMIT + 5 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const view = visibleUpdateNoteLines(notes);
    expect(view.lines).toHaveLength(UPDATE_NOTE_LINE_LIMIT);
    expect(view.lines[0]).toBe('第 1 行');
    expect(view.lines[UPDATE_NOTE_LINE_LIMIT - 1]).toBe(`第 ${UPDATE_NOTE_LINE_LIMIT} 行`);
    expect(view.total).toBe(UPDATE_NOTE_LINE_LIMIT + 5);
    expect(view.truncated).toBe(true);
    expect(visibleUpdateNoteLines('一行')).toEqual({ lines: ['一行'], total: 1, truncated: false });
    expect(visibleUpdateNoteLines('')).toEqual({ lines: [], total: 0, truncated: false });
  });

  it('formatUpdateDate：坏日期 / 空串回 null；读得出的按本地日期 YYYY-MM-DD', () => {
    expect(normalizeUpdateDate(undefined)).toBeUndefined();
    expect(normalizeUpdateDate('   ')).toBeUndefined();
    expect(normalizeUpdateDate('not-a-date')).toBeUndefined();
    expect(formatUpdateDate(undefined)).toBeNull();
    expect(formatUpdateDate('   ')).toBeNull();
    expect(formatUpdateDate('not-a-date')).toBeNull();
    // 用"本地正午"构造 ISO：任何时区格式化回来都还是同一天（测试不绑时区）
    const localNoon = new Date(2026, 9, 17, 12, 0, 0);
    expect(formatUpdateDate(localNoon.toISOString())).toBe('2026-10-17');
  });

  it('updateDialogPhase：只有 found / downloading / done / failed(install) 出弹窗', () => {
    expect(updateDialogPhase(IDLE)).toBeNull();
    expect(updateDialogPhase(CHECKING)).toBeNull();
    expect(updateDialogPhase({ kind: 'latest' })).toBeNull();
    expect(updateDialogPhase({ kind: 'failed', stage: 'check' })).toBeNull();
    const found: UpdatePhase = { kind: 'found', version: '0.2.0' };
    const downloading: UpdatePhase = { kind: 'downloading', received: 1, total: 2, version: '0.2.0' };
    const done: UpdatePhase = { kind: 'done', version: '0.2.0' };
    const failed: UpdatePhase = { kind: 'failed', stage: 'install', release: { version: '0.2.0' } };
    expect(updateDialogPhase(found)).toBe(found);
    expect(updateDialogPhase(downloading)).toBe(downloading);
    expect(updateDialogPhase(done)).toBe(done);
    expect(updateDialogPhase(failed)).toBe(failed);
  });

  it('updateDialogTitle：按态换动词，主语都是那一版', () => {
    const cases: Array<[UpdateDialogPhase, string]> = [
      [{ kind: 'found', version: '0.5.0' }, '发现新版本 v0.5.0'],
      [{ kind: 'downloading', received: 0, total: null, version: '0.5.0' }, '正在下载 v0.5.0'],
      [{ kind: 'done', version: '0.5.0' }, '已安装 v0.5.0'],
      [
        { kind: 'failed', stage: 'install', release: { version: '0.5.0' } },
        '更新 v0.5.0 没有装好',
      ],
    ];
    expect(cases.map(([phase]) => updateDialogTitle(phase))).toEqual(cases.map(([, text]) => text));
    expect(UPDATE_NOTES_EMPTY).toBe('这个版本没有附更新说明。');
  });
});

describe('isUpdateBusy：进行中判定', () => {
  it('checking 与 downloading 算忙，其余不忙', () => {
    expect(isUpdateBusy(CHECKING)).toBe(true);
    expect(isUpdateBusy({ kind: 'downloading', received: 0, total: null, version: '0.2.0' })).toBe(true);
    expect(isUpdateBusy(IDLE)).toBe(false);
    expect(isUpdateBusy({ kind: 'latest' })).toBe(false);
    expect(isUpdateBusy({ kind: 'found', version: '0.2.0' })).toBe(false);
    expect(isUpdateBusy({ kind: 'done', version: '0.2.0' })).toBe(false);
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

describe('downloadPercent / downloadProgressText：进度读数同源', () => {
  it('总量未知（null / 0 / 非有限）回 null，进度条转不定态', () => {
    expect(downloadPercent(100, null)).toBeNull();
    expect(downloadPercent(100, 0)).toBeNull();
    expect(downloadPercent(100, Number.POSITIVE_INFINITY)).toBeNull();
    expect(downloadPercent(Number.NaN, 100)).toBeNull();
    expect(downloadProgressText(100, null)).toBeNull();
    expect(downloadProgressText(100, 0)).toBeNull();
  });

  it('百分比与文字同一算式：四舍五入、上下钳位（负收 / 超收都不出怪数）', () => {
    expect(downloadPercent(0, 200)).toBe(0);
    expect(downloadPercent(100, 200)).toBe(50);
    expect(downloadPercent(101, 200)).toBe(51);
    expect(downloadPercent(999, 200)).toBe(100);
    expect(downloadPercent(-5, 200)).toBe(0);
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
    expect(updateStatus({ kind: 'done', version: '0.2.0' })).toEqual({
      text: '更新已安装，重启应用后生效',
      tone: 'ok',
    });
  });

  /**
   * MK-1 并一后的失败文案：主语 + 哪一段 + 为什么 + **可重试**（过去这两句各写各的，
   * 一句"检查失败（网络或尚未发布版本）"连能不能再点一次都没说）。
   */
  it('失败态那一句由 `updateFailureNote` 一处生成：两段都有"可重试"，病因缺省也不是哑巴话', () => {
    expect(updateStatus({ kind: 'failed', stage: 'check' })).toEqual({
      text: `${UPDATE_SUBJECT}没有检查成功，可重试：网络没通，或本仓还没发布可更新的版本`,
      tone: 'err',
    });
    expect(updateStatus({ kind: 'failed', stage: 'install', release: { version: '0.2.0' } })).toEqual({
      text: `${UPDATE_SUBJECT}没有下载安装成功，可重试：下载或安装中断（断网、磁盘、取消）`,
      tone: 'err',
    });
    // 调用方给了病因 ⇒ 用作者的病因，不再重复那句常态话术
    expect(updateFailureNote({ stage: 'check', reason: '404 not found' })).toBe(
      `${UPDATE_SUBJECT}没有检查成功，可重试：404 not found`,
    );
    // 空病因 ⇒ 只剩主干那一句（不出现"：undefined"那种东西）
    expect(updateFailureNote({ stage: 'install', reason: '   ' })).toBe(
      `${UPDATE_SUBJECT}没有下载安装成功，可重试`,
    );
  });

  it('downloading：有总量显示进度，无总量退化为基础文案', () => {
    expect(updateStatus({ kind: 'downloading', received: 100, total: 200, version: '0.2.0' })).toEqual({
      text: '已下载 100 B / 200 B（50%）',
      tone: 'dim',
    });
    expect(updateStatus({ kind: 'downloading', received: 100, total: null, version: '0.2.0' })).toEqual({
      text: '正在下载安装…',
      tone: 'dim',
    });
  });
});
