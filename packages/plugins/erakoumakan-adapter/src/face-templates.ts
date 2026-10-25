/**
 * era紅魔館 时机分野模板表（游戏知识 —— 只住本包）。
 *
 * 表层 DSL 的 `时机 <分野> [编号]：` 里作者只写分野关键字；「关键字 → 函数名」的映射
 * 是游戏知识，由本包以 `KojoFaceTable` 暴露给转译器（`kojo-sugar` 只消费不解释）。
 *
 * ## 证据（全部来自 `D:/Game/eraKoumakan` 真盘路由）
 *
 * - `ERB/EVENT_KOJO.ERB:38`：
 *   `FUNC KOJO%RESULTS%_MESSAGE_COM_K{対象}_{SELECTCOM}` → `指令`，`{i}` = 指令号，
 *   按 `CSV/Train.csv` 查表（`indexKind: 'command'`，缺省即此）。
 * - `ERB/EVENT_KOJO.ERB:30`：
 *   `FUNC KOJO%RESULTS%_MESSAGE_SCOM_K{対象}_{TFLAG:50}` → `射精`，`{i}` 也是指令号。
 * - `ERB/EVENT_KOJO.ERB:250`：
 *   `FUNC KOJO%RESULTS%_EVENT_K{対象}_{ARG}` → `事件`，`{i}` = 引擎事件号（**无名称表**，
 *   写数字；`indexKind: 'literal'` 不做任何查表）。
 * - `ERB/EVENT_KOJO.ERB:84`：
 *   `FUNC KOJO%RESULTS%_MESSAGE_COUNTER_K{対象}_{TCVAR:20}` → `计数器`，`{i}` = 计数器号
 *   （本作没有计数器值域名表，故同样 `literal`，写数字）。
 * - `ERB/EVENT_KOJO.ERB:283` 起：
 *   `KOJO_MESSAGE_PALAMCNG_A_K{NO:TARGET}_{位号}` → `参数变动`；A 面是主形（70 处），
 *   B/C 各 5 处。`{i}` 是 `TCVAR:50` 的位号，`literal`。
 * - `ERB/EVENT_KOJO.ERB:225`：`KOJO_MESSAGE_MARKCNG_K{NO:奴隷}` → `刻印`（无 `{i}`）。
 * - `ERB/EVENT_KOJO.ERB:240`：`KOJO_MESSAGE_ENDING_K{NO:TARGET}` → `结局`（无 `{i}`）。
 * - `ERB/EVENT_MESSAGE_COM.ERB:21`：
 *   `FUNC NTR_KOJO%RESULTS%_MESSAGE_COM_K{TARGET}_{SELECTCOM}` → `NTR指令`。
 * - `CALLNAME_K{n}` 是称呼函数（无 `{i}`）。
 *
 * ## 不收录的面（宁缺毋滥）
 *
 * `KOJO_WC_COUNTER…` 的面名里夹着计数器分类段（`25_1_VirginReservation_GET` 一类），
 * 不是单一模板能表达的；`SexHara休息中_{难度}_K{n}` 的难度段由运行时难度决定。
 * 这两族继续用原生 ERB 写，**不提供降糖模板**（避免生成指向错误分类的死函数名）。
 */
import type { KojoFaceTable } from '@kojo/plugin-api';

/** 构建 era紅魔館 分野表（冻结纯数据，无 IO）。 */
export function createKoumakanFaceTable(): KojoFaceTable {
  return {
    slotSemantics: { chara: { label: '角色号' } },
    faces: {
      指令: {
        template: 'KOJO_MESSAGE_COM_K{n}_{i}',
        slotSemantics: { index: { label: '指令号', detail: '按 CSV/Train.csv 换算' } },
      },
      射精: {
        template: 'KOJO_MESSAGE_SCOM_K{n}_{i}',
        slotSemantics: { index: { label: '指令号', detail: '按 CSV/Train.csv 换算' } },
      },
      事件: {
        template: 'KOJO_EVENT_K{n}_{i}',
        indexKind: 'literal',
        slotSemantics: { index: { label: '引擎事件号', detail: '没有名称表，直接写数字' } },
      },
      计数器: {
        template: 'KOJO_MESSAGE_COUNTER_K{n}_{i}',
        indexKind: 'literal',
        slotSemantics: { index: { label: '计数器号' } },
      },
      参数变动: {
        template: 'KOJO_MESSAGE_PALAMCNG_A_K{n}_{i}',
        indexKind: 'literal',
        slotSemantics: { index: { label: 'TCVAR:50 位号' } },
      },
      刻印: { template: 'KOJO_MESSAGE_MARKCNG_K{n}' },
      结局: { template: 'KOJO_MESSAGE_ENDING_K{n}' },
      称呼: { template: 'CALLNAME_K{n}' },
      NTR指令: {
        template: 'NTR_KOJO_MESSAGE_COM_K{n}_{i}',
        slotSemantics: { index: { label: '指令号', detail: '按 CSV/Train.csv 换算' } },
      },
    },
  };
}
