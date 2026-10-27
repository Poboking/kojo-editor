import { describe, expect, it } from 'vitest';
import { buildTemplate, previewFileName } from '../src/new-file-wizard';

/**
 * 新建口上文件向导的纯函数单测（2026-10-12 审阅补测批）。
 *
 * 这两个函数决定**落盘文件内容与文件名**——写坏 = 作者拿到一个游戏读不到的
 * 口上文件（且合库里"静默失效"极难自查）。契约要点：
 * - 命名知识**不来自本插件**：`declare` 模板由 adapter 提供（如 `M_KOJO_K{n}`），
 *   本插件只做 `{n}` 代入与家族段拼接（§1.4「漏下划线满屏全哑」的根治点）；
 * - 家族名去非法字符（路径分隔符 / 通配符），非法字符整体剔除而非报错；
 * - 模板首行是 `;` 注释（与 ERB 一致），随后是 `角色:` 与选填 `口上:`。
 */

describe('文件名推导（declare 模板代入）', () => {
  it('角色号代入 `{n}`，无家族段时用裸模板 + .kojo1（1.x 档 = 封存层）', () => {
    expect(previewFileName('M_KOJO_K{n}', 12, '')).toBe('M_KOJO_K12.kojo1');
  });

  it('家族段以 `_` 拼在模板之后（工具补前导下划线，作者不手写）', () => {
    expect(previewFileName('M_KOJO_K{n}', 12, '破空自制')).toBe('M_KOJO_K12_破空自制.kojo1');
  });

  it('家族名两端空白剔除；只留空白视同无家族段', () => {
    expect(previewFileName('M_KOJO_K{n}', 3, '  露米娅  ')).toBe('M_KOJO_K3_露米娅.kojo1');
    expect(previewFileName('M_KOJO_K{n}', 3, '   ')).toBe('M_KOJO_K3.kojo1');
  });

  it('家族名中的路径分隔符与通配符被剔除（不会写出越层文件）', () => {
    expect(previewFileName('M_KOJO_K{n}', 1, 'a/b\\c:d*e?f"g<h>i|j')).toBe(
      'M_KOJO_K1_abcdefghij.kojo1',
    );
  });

  it('模板含多处以角色号占位的形态也全部代入（不假设只出现一次）', () => {
    expect(previewFileName('K{n}_KOJO_{n}', 7, '')).toBe('K7_KOJO_7.kojo1');
  });
});

describe('模板内容', () => {
  it('无时机：首行注释 + 角色头 + 空行收尾（家族留空则无 `口上:` 行）', () => {
    const text = buildTemplate({ charNo: 12, charName: '露米娅', family: '', face: null, faceIndex: '' });
    expect(text).toBe('; 露米娅（12）\n角色: 12\n');
  });

  it('家族名同时进注释与 `口上:` 头（两者必须一致，否则登记与替换口径分叉）', () => {
    const text = buildTemplate({
      charNo: 12,
      charName: '露米娅',
      family: '破空自制',
      face: null,
      faceIndex: '',
    });
    expect(text).toBe('; 露米娅（12） · 破空自制\n角色: 12\n口上: 破空自制\n');
  });

  it('选时机：写入时机块（4 空格缩进占位台词），编号仅在提供时出现', () => {
    const withIdx = buildTemplate({
      charNo: 49,
      charName: '古明地觉',
      family: '',
      face: '初见',
      faceIndex: '310',
    });
    expect(withIdx).toContain('时机 初见 310：');
    expect(withIdx).toContain('\n    「……」\n');
    // 时机块在文件头之后
    expect(withIdx.indexOf('角色: 49')).toBeLessThan(withIdx.indexOf('时机 初见 310：'));

    const noIdx = buildTemplate({ charNo: 49, charName: '古明地觉', family: '', face: '初见', faceIndex: '' });
    expect(noIdx).toContain('时机 初见：');
  });

  it('编号两端空白剔除（输入框粘贴带空格不该产生 `初见  310` 这类畸形头）', () => {
    const text = buildTemplate({ charNo: 1, charName: '甲', family: '', face: '事件', faceIndex: '  12  ' });
    expect(text).toContain('时机 事件 12：');
  });

  it('家族段的非法字符同样被剔除（头与文件名保持同一家族名）', () => {
    const text = buildTemplate({ charNo: 1, charName: '甲', family: 'a/b', face: null, faceIndex: '' });
    expect(text).toContain('; 甲（1） · ab');
    expect(text).toContain('口上: ab');
    expect(text).not.toContain('a/b');
  });
});