/**
 * 时机分野模板：尾号口径 = `CFLAG:209` 口上模式（不是指令号），
 * 全部 `indexKind: 'literal'`；未登记面 fail-closed。
 */

import { describe, expect, it } from 'vitest';
import { createErasqcFaceTable } from '../src/face-templates';
import { createErasqcFamilyIndex } from '../src/family-index';

describe('分野模板', () => {
  const table = createErasqcFaceTable();

  it('17 个面，全部 literal（不查指令表 / 事件表）', () => {
    expect(Object.keys(table.faces)).toHaveLength(17);
    for (const [name, face] of Object.entries(table.faces)) {
      expect(face.indexKind, name).toBe('literal');
      expect(face.template, name).toContain('{n}');
    }
  });

  it('主链路模板逐字钉住', () => {
    expect(table.faces['指令']?.template).toBe('KOJO_MESSAGE_COM_{n}_{i}');
    expect(table.faces['独白']?.template).toBe('SELF_KOJO_K{n}_{i}');
    expect(table.faces['客人']?.template).toBe('GUEST_KOJO_K{n}_{i}');
    expect(table.faces['计数器']?.template).toBe('COUNTER_KOJO_{n}_{i}');
    expect(table.faces['日常对话']?.template).toBe('DAILY_LIFE_MESSAGE_{n}_{i}');
    expect(table.faces['恋慕分支']?.template).toBe('K{n}_KOJO2_{i}');
  });

  it('模板生成的函数名可被家族索引解析回同一面', () => {
    const family = createErasqcFamilyIndex();
    for (const [label, face] of Object.entries(table.faces)) {
      const name = face.template.replace('{n}', '7').replace('{i}', '2');
      const match = family.match(name);
      expect(match, `${label} → ${name}`).not.toBeNull();
      expect(match!.characterNo).toBe(7);
    }
  });

  it('没有 success / messageCheck / registration（本作无这些协议）', () => {
    expect(table.successFlag).toBeUndefined();
    expect(table.messageCheck).toBeUndefined();
    expect(table.registration).toBeUndefined();
    expect(table.customComRange).toBeUndefined();
  });
});
