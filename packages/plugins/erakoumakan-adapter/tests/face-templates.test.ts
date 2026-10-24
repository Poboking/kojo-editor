/**
 * 时机分野模板：渲染出来的函数名必须是真盘**存在**的定义（不是凭想象拼的）。
 * 真盘守卫缺失时只验模板文本与 indexKind。
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createKoumakanFaceTable } from '../src/face-templates';
import { GAME_ROOT, listFilesRecursive } from './harness';

const hasCorpus = existsSync(GAME_ROOT);

function render(template: string, n: number, i: number): string {
  return template.replaceAll('{n}', String(n)).replaceAll('{i}', String(i));
}

describe('分野表形状与证据', () => {
  it('九个面：模板与 indexKind 逐条钉住', () => {
    const faces = createKoumakanFaceTable().faces;
    expect(Object.keys(faces).sort()).toEqual(
      ['事件', '称呼', '参数变动', '射精', '结局', '计数器', '指令', '刻印', 'NTR指令'].sort(),
    );
    expect(faces['指令']).toEqual({ template: 'KOJO_MESSAGE_COM_K{n}_{i}' });
    expect(faces['射精']?.template).toBe('KOJO_MESSAGE_SCOM_K{n}_{i}');
    expect(faces['事件']?.indexKind).toBe('literal');
    expect(faces['计数器']?.indexKind).toBe('literal');
    expect(faces['参数变动']?.indexKind).toBe('literal');
    expect(faces['刻印']?.template).toBe('KOJO_MESSAGE_MARKCNG_K{n}');
    expect(faces['结局']?.template).toBe('KOJO_MESSAGE_ENDING_K{n}');
    expect(faces['称呼']?.template).toBe('CALLNAME_K{n}');
    expect(faces['NTR指令']?.template).toBe('NTR_KOJO_MESSAGE_COM_K{n}_{i}');
  });

  it('渲染样例（4 号角色）', () => {
    const f = createKoumakanFaceTable().faces;
    expect(render(f['指令']!.template, 4, 300)).toBe('KOJO_MESSAGE_COM_K4_300');
    expect(render(f['射精']!.template, 4, 350)).toBe('KOJO_MESSAGE_SCOM_K4_350');
    expect(render(f['事件']!.template, 4, 6)).toBe('KOJO_EVENT_K4_6');
    expect(render(f['计数器']!.template, 4, 20)).toBe('KOJO_MESSAGE_COUNTER_K4_20');
    expect(render(f['参数变动']!.template, 4, 0)).toBe('KOJO_MESSAGE_PALAMCNG_A_K4_0');
    expect(render(f['刻印']!.template, 4, 0)).toBe('KOJO_MESSAGE_MARKCNG_K4');
    expect(render(f['结局']!.template, 4, 0)).toBe('KOJO_MESSAGE_ENDING_K4');
    expect(render(f['称呼']!.template, 4, 0)).toBe('CALLNAME_K4');
    expect(render(f['NTR指令']!.template, 4, 350)).toBe('NTR_KOJO_MESSAGE_COM_K4_350');
  });
});

describe('真盘存在性（守卫：D:/Game/eraKoumakan 存在才跑）', () => {
  it.skipIf(!hasCorpus)('每条模板在真盘至少有一个实现；结局面由路由证据兜底', () => {
    const names = new Set<string>();
    for (const path of listFilesRecursive(`${GAME_ROOT}/ERB/口上`, /\.erb$/i)) {
      for (const m of readFileSync(path, 'utf8').matchAll(/^\s*@([^\s,;(]+)/gm)) {
        names.add(m[1]!);
      }
    }
    // 取每面真盘真实存在的实例（不拿 4 号硬套：SCOM/COUNTER 的实装集与 COM 不同）
    const samples: Array<[string, string]> = [
      ['指令', 'KOJO_MESSAGE_COM_K4_300'],
      ['射精', 'KOJO_MESSAGE_SCOM_K10_1'],
      ['事件', 'KOJO_EVENT_K4_6'],
      ['计数器', 'KOJO_MESSAGE_COUNTER_K10_10'],
      ['参数变动', 'KOJO_MESSAGE_PALAMCNG_A_K10_0'],
      ['刻印', 'KOJO_MESSAGE_MARKCNG_K4'],
      ['称呼', 'CALLNAME_K4'],
      ['NTR指令', 'NTR_KOJO_MESSAGE_COM_K10_302'],
    ];
    for (const [label, name] of samples) {
      expect(names.has(name), `${label}: ${name}`).toBe(true);
    }
    // 结局面：真盘 0 个角色实装，但路由明确调用它（糖层生成后引擎会走这条）
    const route = readFileSync(`${GAME_ROOT}/ERB/EVENT_KOJO.ERB`, 'utf8');
    expect(route).toContain('KOJO_MESSAGE_ENDING_K{NO:TARGET}');
  });
});
