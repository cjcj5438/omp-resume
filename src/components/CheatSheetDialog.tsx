/** omp 内置命令速查：只读分组列表 + 过滤。 */
import { Fragment, useMemo, useState } from "react";
import { OMP_COMMANDS, OMP_VERSION, filterOmpCommands } from "../ompCommands";
import { Modal } from "./ui";

export function CheatSheetDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => filterOmpCommands(OMP_COMMANDS, query), [query]);
  const shown = groups.reduce((n, g) => n + g.commands.length, 0);
  const total = OMP_COMMANDS.reduce((n, g) => n + g.commands.length, 0);
  const head =
    query.trim() === ""
      ? `基于 omp ${OMP_VERSION} · 共 ${total} 条内置命令`
      : `基于 omp ${OMP_VERSION} · 匹配 ${shown} / ${total} 条`;
  return (
    <Modal
      title="命令速查"
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>
          关闭
        </button>
      }
    >
      <p className="cheatsheet-head">{head}</p>
      <input
        type="search"
        className="filter-input cheatsheet-filter"
        placeholder="按命令名或中文说明过滤"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="过滤命令"
        data-autofocus
      />
      <div className="cheatsheet-list">
        {shown === 0 ? <div className="pane-note">没有匹配的命令</div> : null}
        {groups.map((g) => (
          <section className="cheatsheet-group" key={g.group}>
            <h3 className="cheatsheet-group-title">
              {g.group}（{g.commands.length}）
            </h3>
            <ul className="cheatsheet-rows">
              {g.commands.map((c) => (
                <li className="cheatsheet-row" key={c.name}>
                  <div className="cheatsheet-main">
                    <div>
                      <span className="mono">/{c.name}</span>
                      {c.aliases.length > 0 ? (
                        <span className="cheatsheet-alias"> 别名 {c.aliases.join("、")}</span>
                      ) : null}
                    </div>
                    {c.args ? (
                      <div className="mono cheatsheet-args">
                        {c.args.split("|").map((p, i, a) => (
                          <Fragment key={i}>
                            {p}
                            {i < a.length - 1 ? (
                              <>
                                |<wbr />
                              </>
                            ) : null}
                          </Fragment>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className="cheatsheet-zh">{c.zh}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="cheatsheet-foot">
        自定义命令、技能（/skill:xxx）和插件命令不在此列；实时补全以在 omp 中输入 /
        为准。
      </p>
    </Modal>
  );
}
