import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ActivityEntry } from '../api';

interface Props {
  onBack: () => void;
}

const ACTION_ICONS: Record<string, string> = {
  upload: '📤',
  download: '📥',
  delete: '🗑️',
  trash: '🗑️',
  restore: '♻️',
  share: '🔗',
  login: '🔑',
  register: '📝',
};

export default function ActivityView({ onBack }: Props) {
  const [logs, setLogs] = useState<ActivityEntry[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    try {
      const res = await api.listActivity(p);
      setLogs(res.logs);
      setPage(res.page);
      setPages(res.pages);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
    }
  }, []);

  useEffect(() => { load(page); }, [page, load]);

  return (
    <section className="activity-view">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>📋 Activity Log</h2>
      </div>

      {error && <p className="error">{error}</p>}

      {logs.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center', padding: '2rem' }}>No activity recorded yet.</p>
      ) : (
        <div className="timeline">
          {logs.map((log) => (
            <div key={log.id} className="timeline-item">
              <div className="timeline-icon">{ACTION_ICONS[log.action] ?? '📌'}</div>
              <div className="timeline-content">
                <div className="timeline-header">
                  <span className={`action-badge ${log.action}`}>{log.action}</span>
                  <span className="timeline-time">{new Date(log.createdAt).toLocaleString()}</span>
                </div>
                {log.detail && <div className="timeline-body">{log.detail}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>← Newer</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older →</button>
        </div>
      )}
    </section>
  );
}
