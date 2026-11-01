/**
 * 常驻备份表（设计稿 memory 备份 panel）：文件/体积/时间/操作 + foot 根目录。
 * 文件名取 backup id 的时间段（目录快照非 .db 文件）+ kind 小字；恢复走 quiet 按钮
 * 直达 MemoryBackupsDialog 的 restore 视图。
 */
import { useEffect, useState, type ReactNode } from "react";
import { getAppPaths, memoryBackups } from "../api";
import type { MemoryBackup } from "../types";
import { formatFullTime, formatSize } from "../format";
import { BACKUP_KIND_LABEL } from "./useMemoryMaintenance";
import { Panel } from "./page";

interface MemoryBackupTableProps {
  refreshToken: number;
  onRestore: (backup: MemoryBackup) => void;
}

export function MemoryBackupTable(props: MemoryBackupTableProps): ReactNode {
  const { refreshToken, onRestore } = props;
  const [rows, setRows] = useState<MemoryBackup[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([memoryBackups({}), getAppPaths().catch(() => null)])
      .then(([list, paths]) => {
        if (cancelled) return;
        setRows(list.slice(0, 10));
        setDataDir(paths?.dataDir ?? null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setRows([]);
        void e;
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return (
    <Panel
      title="备份"
      meta="每库每类保留最近 5 份"
      body="flush"
      foot={<><span>备份写入应用数据目录。</span><span className="mono">{dataDir ?? "—"}</span></>}
    >
      {loading ? (
        <div className="pane-note">备份加载中…</div>
      ) : rows.length === 0 ? (
        <div className="pane-note">还没有备份。删除记忆或移除库时会自动创建。</div>
      ) : (
        <div className="tbl-wrap">
        <table className="tbl mem-backup-table">
          <thead><tr><th scope="col">文件</th><th scope="col" className="r">体积</th><th scope="col" className="r">时间</th><th scope="col" className="r">操作</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  <span className="mono">{b.id.split("@")[1] ?? b.id}</span>{" "}
                  <span className="badge badge-grey">{BACKUP_KIND_LABEL[b.kind]}</span>
                </td>
                <td className="r mono muted">{formatSize(b.bytes)}</td>
                <td className="r mono muted">{formatFullTime(b.createdAt)}</td>
                <td className="r cell-actions">
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => onRestore(b)}>
                    恢复
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </Panel>
  );
}
