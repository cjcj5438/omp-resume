/**
 * 斜杠命令的详解数据（何时用 / 注意 / 参数逐项 / 相关命令）。
 *
 * 与 `ompCommands.ts` 分离：那张表只放「有哪些命令、参数提示是什么」，
 * 这里是给人看的指导。按分组拆成多个文件，便于各自维护与并行补齐。
 *
 * 编写规则：
 * - `when`：1–2 句，说清「什么情况下该用它」，不要复述命令名。
 * - `cautions`：真实存在的行为风险（丢内容、写盘、不可撤销、需重启等），没有就省略。
 * - `params`：只能来自该命令 `args` 里出现过的 token，逐个给中文解释。
 * - `related`：必须是 `OMP_COMMANDS` 的命令名/别名或 `OMP_CLI_COMMANDS` 的 name。
 */
import { PART_1 } from "./commandDetails/part1";
import { PART_2 } from "./commandDetails/part2";
import { PART_3 } from "./commandDetails/part3";
import { PART_4 } from "./commandDetails/part4";

export interface OmpCommandDetail {
  when: string;
  cautions?: string[];
  params?: { token: string; zh: string }[];
  related?: string[];
}

export const OMP_COMMAND_DETAILS: Readonly<Record<string, OmpCommandDetail>> = {
  ...PART_1,
  ...PART_2,
  ...PART_3,
  ...PART_4,
};

/** 取一条命令的详解；没有时为 undefined（界面退化为只显示一句话说明）。 */
export function findOmpDetail(name: string): OmpCommandDetail | undefined {
  return OMP_COMMAND_DETAILS[name];
}
