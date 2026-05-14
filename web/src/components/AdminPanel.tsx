import { useCallback, useEffect, useState } from 'react';
import {
  api, ApiError,
  type AdminUser, type AdminStats, type ActivityEntry,
  type TrendDay, type AdminShareLink, type ServerSettings,
  type FileMeta, type FolderMeta,
} from '../api';

interface Props {
  onBack: () => void;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fileTypeIcon(mime: string | null): string {
  if (!mime) return '📄';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📕';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('gzip')) return '📦';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
  if (mime.includes('document') || mime.includes('word') || mime.includes('text')) return '📝';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📽️';
  return '📄';
}

type AdminTab = 'overview' | 'users' | 'files' | 'shares' | 'activity' | 'settings';

export default function AdminPanel({ onBack }: Props) {
  const [tab, setTab] = useState<AdminTab>('overview');
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="admin-panel">
      <div className="admin-header">
        <button className="btn-link" onClick={onBack}>← Back to files</button>
        <h2>⚙️ Admin Panel</h2>
      </div>

      <div className="admin-tabs">
        {(['overview', 'users', 'files', 'shares', 'activity', 'settings'] as AdminTab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => { setTab(t); setError(null); }}>
            {t === 'overview' ? '📊 Overview' : t === 'users' ? '👥 Users' : t === 'files' ? '📁 Files' : t === 'shares' ? '🔗 Shares' : t === 'activity' ? '📋 Activity' : '⚙️ Settings'}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}

      {tab === 'overview' && <OverviewTab onError={setError} />}
      {tab === 'users' && <UsersTab onError={setError} onViewFiles={(id) => { setTab('files'); setSelectedUserId(id); }} />}
      {tab === 'files' && <FilesTab onError={setError} />}
      {tab === 'shares' && <SharesTab onError={setError} />}
      {tab === 'activity' && <ActivityTab onError={setError} />}
      {tab === 'settings' && <SettingsTab onError={setError} />}
    </section>
  );
}

// ─── OVERVIEW TAB ─────────────────────────────────────────────────────────────

function OverviewTab({ onError }: { onError: (msg: string) => void }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [trends, setTrends] = useState<TrendDay[]>([]);

  useEffect(() => {
    api.adminGetStats().then(setStats).catch((e) => { if (e instanceof ApiError) onError(e.message); });
    api.adminGetTrends().then((r) => setTrends(r.days)).catch(() => {});
  }, [onError]);

  if (!stats) return <p className="muted">Loading…</p>;

  const diskUsedPct = stats.diskTotal > 0 ? ((stats.diskTotal - stats.diskFree) / stats.diskTotal) * 100 : 0;
  const maxUploads = Math.max(1, ...trends.map((d) => d.uploads));

  return (
    <>
      {/* Stat cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.userCount}</div>
          <div className="stat-label">Total Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.fileCount}</div>
          <div className="stat-label">Active Files</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{fmtBytes(stats.totalStorageUsed)}</div>
          <div className="stat-label">Storage Used</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.activeShares}</div>
          <div className="stat-label">Active Shares</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.trashedCount}</div>
          <div className="stat-label">Trashed Files</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{fmtUptime(stats.serverUptime)}</div>
          <div className="stat-label">Server Uptime</div>
        </div>
      </div>

      {/* Disk usage */}
      {stats.diskTotal > 0 && (
        <div className="card" style={{ marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>💾 Disk Usage</h3>
          <div className="quota-bar">
            <div className={`quota-fill ${diskUsedPct > 85 ? 'warn' : ''}`} style={{ width: `${diskUsedPct}%` }} />
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: '13px' }}>
            {fmtBytes(stats.diskTotal - stats.diskFree)} used of {fmtBytes(stats.diskTotal)} ({diskUsedPct.toFixed(1)}%) · {fmtBytes(stats.diskFree)} free
          </p>
        </div>
      )}

      {/* Upload trend chart */}
      {trends.length > 0 && (
        <div className="card" style={{ marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>📈 Upload Trend (7 days)</h3>
          <div className="trend-chart">
            {trends.map((d) => (
              <div key={d.date} className="trend-bar-group">
                <div className="trend-bar-wrap">
                  <div className="trend-bar" style={{ height: `${(d.uploads / maxUploads) * 100}%` }}>
                    <span className="trend-count">{d.uploads}</span>
                  </div>
                </div>
                <span className="trend-label">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* File type breakdown */}
      {stats.fileTypes.length > 0 && (() => {
        const totalTypeBytes = stats.fileTypes.reduce((acc, ft) => acc + ft.bytes, 0);
        const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#d946ef', '#64748b'];
        
        return (
          <div className="card" style={{ marginTop: '16px' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>📁 File Types Breakdown</h3>
            
            {/* Visual Bar */}
            <div style={{ display: 'flex', height: '24px', borderRadius: '12px', overflow: 'hidden', marginBottom: '20px', background: 'var(--bg-hover)', boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.1)' }}>
              {stats.fileTypes.map((ft, i) => {
                const pct = totalTypeBytes > 0 ? (ft.bytes / totalTypeBytes) * 100 : 0;
                if (pct === 0) return null;
                return (
                  <div key={ft.type} style={{ width: `${pct}%`, backgroundColor: colors[i % colors.length], transition: 'width 0.5s ease-out' }} title={`${ft.type}: ${pct.toFixed(1)}%`} />
                );
              })}
            </div>

            {/* Legend / List */}
            <div className="type-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '16px' }}>
              {stats.fileTypes.map((ft, i) => (
                <div key={ft.type} style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--bg-hover)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', transition: 'transform 0.2s' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '8px', backgroundColor: `${colors[i % colors.length]}15`, color: colors[i % colors.length], display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', flexShrink: 0 }}>
                    {ft.type === 'image' ? '🖼️' : ft.type === 'video' ? '🎬' : ft.type === 'audio' ? '🎵' : ft.type === 'application' ? '📦' : ft.type === 'text' ? '📝' : '📄'}
                  </div>
                  <div className="type-info" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                      <span className="type-name" style={{ fontWeight: 600, fontSize: '14px', textTransform: 'capitalize', color: 'var(--text)' }}>{ft.type}</span>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: colors[i % colors.length] }}>{totalTypeBytes > 0 ? ((ft.bytes / totalTypeBytes) * 100).toFixed(1) : 0}%</span>
                    </div>
                    <span className="type-stats" style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ft.count} files · {fmtBytes(ft.bytes)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </>
  );
}

// ─── USERS TAB ────────────────────────────────────────────────────────────────

function UsersTab({ onError }: { onError: (msg: string) => void; onViewFiles?: (id: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: number, q: string) => {
    try {
      const res = await api.adminListUsers(p, 50, q);
      setUsers(res.users); setPage(res.page); setPages(res.pages);
    } catch (e) { if (e instanceof ApiError) onError(e.message); }
  }, [onError]);

  useEffect(() => { load(page, search); }, [page, search, load]);

  function doSearch() { setPage(1); load(1, search); }

  async function handleToggleRole(u: AdminUser) {
    setBusy(true);
    try {
      await api.adminUpdateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' });
      await load(page, search);
    } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
  }

  async function handleToggleDisabled(u: AdminUser) {
    setBusy(true);
    try {
      await api.adminUpdateUser(u.id, { disabled: !u.disabled });
      await load(page, search);
    } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
  }

  async function handleChangeQuota(u: AdminUser) {
    const gb = prompt('Set storage quota (in GB):', String(Math.round(u.storageQuota / (1024 ** 3))));
    if (gb === null) return;
    const parsed = parseFloat(gb);
    if (isNaN(parsed) || parsed <= 0) return;
    setBusy(true);
    try {
      await api.adminUpdateUser(u.id, { storageQuota: Math.round(parsed * 1024 ** 3) });
      await load(page, search);
    } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
  }

  async function handleDeleteUser(u: AdminUser) {
    if (!confirm(`⚠️ DELETE user "${u.email}" and ALL their files permanently?\n\nThis cannot be undone!`)) return;
    setBusy(true);
    try {
      await api.adminDeleteUser(u.id);
      await load(page, search);
    } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="search-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
          <input
            type="search" className="search-input" placeholder="Search users by email…"
            value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
          />
          <button onClick={doSearch}>Search</button>
        </div>
        <button onClick={async () => {
          setBusy(true);
          try {
            const res = await api.adminListUsers(1, 100000, search);
            const lines = ['ID,Email,Role,Storage Quota (Bytes),Storage Used (Bytes),Disabled,Files,Joined'];
            res.users.forEach(u => lines.push(`${u.id},"${u.email}",${u.role},${u.storageQuota},${u.storageUsed},${u.disabled},${u.fileCount},${u.createdAt}`));
            const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `users_export_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
        }} disabled={busy}>📥 Export CSV</button>
      </div>

      <div className="user-cards">
        {users.map((u) => {
          const pct = u.storageQuota > 0 ? (u.storageUsed / u.storageQuota) * 100 : 0;
          return (
            <div key={u.id} className={`user-card ${u.disabled ? 'disabled-card' : ''}`}>
              <div className="user-card-top">
                <div className="user-card-info">
                  <span className="user-card-email">{u.email}</span>
                  <div className="user-card-meta">
                    <span className={`role-badge ${u.role}`}>{u.role}</span>
                    <span className={`status-badge ${u.disabled ? 'disabled' : 'active'}`}>
                      {u.disabled ? 'Disabled' : 'Active'}
                    </span>
                  </div>
                </div>
                <span className="user-card-date">Joined {new Date(u.createdAt).toLocaleDateString()}</span>
              </div>

              <div className="user-card-storage">
                <div className="user-card-storage-info">
                  <span>{fmtBytes(u.storageUsed)} / {fmtBytes(u.storageQuota)}</span>
                  <span className="muted">{u.fileCount} files</span>
                </div>
                <div className="quota-bar" style={{ height: '6px' }}>
                  <div className={`quota-fill ${pct > 90 ? 'warn' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>

              <div className="user-card-actions">
                <button className="btn-link" onClick={() => handleToggleRole(u)} disabled={busy}>
                  {u.role === 'admin' ? '👤 Demote' : '👑 Promote'}
                </button>
                <button className="btn-link" onClick={() => handleChangeQuota(u)} disabled={busy}>💾 Quota</button>
                <button className={`btn-link ${u.disabled ? '' : 'danger'}`} onClick={() => handleToggleDisabled(u)} disabled={busy}>
                  {u.disabled ? '✅ Enable' : '🚫 Disable'}
                </button>
                <button className="btn-link danger" onClick={() => handleDeleteUser(u)} disabled={busy}>🗑️ Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {pages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>→</button>
        </div>
      )}
    </>
  );
}

// ─── FILES TAB (Admin File Browser) ──────────────────────────────────────────

function FilesTab({ onError }: { onError: (msg: string) => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedEmail, setSelectedEmail] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [folderPath, setFolderPath] = useState<{ id: string | null; name: string }[]>([{ id: null, name: 'Root' }]);

  useEffect(() => {
    api.adminListUsers(1, 200).then((r) => setUsers(r.users)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedUser) return;
    api.adminGetUserFiles(selectedUser, folderId).then((r) => {
      setFiles(r.files); setFolders(r.folders); setSelectedEmail(r.email);
    }).catch((e) => { if (e instanceof ApiError) onError(e.message); });
  }, [selectedUser, folderId, onError]);

  function openFolder(id: string, name: string) {
    setFolderPath((prev) => [...prev, { id, name }]);
    setFolderId(id);
  }

  function goToPathIndex(index: number) {
    const entry = folderPath[index];
    setFolderPath((prev) => prev.slice(0, index + 1));
    setFolderId(entry.id);
  }

  function selectUser(id: string) {
    setSelectedUser(id);
    setFolderId(null);
    setFolderPath([{ id: null, name: 'Root' }]);
  }

  async function handleDeleteFile(id: string, name: string) {
    if (!confirm(`Delete "${name}" permanently?`)) return;
    setBusy(true);
    try {
      await api.adminDeleteFile(id);
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (e) { if (e instanceof ApiError) onError(e.message); } finally { setBusy(false); }
  }

  if (!selectedUser) {
    return (
      <div className="card">
        <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 600 }}>Select a user to browse files</h3>
        <div className="user-select-list">
          {users.map((u) => (
            <button key={u.id} className="user-select-item" onClick={() => selectUser(u.id)}>
              <span>{u.email}</span>
              <span className="muted">{u.fileCount} files · {fmtBytes(u.storageUsed)}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '16px' }}>
        <div>
          <button className="btn-link" onClick={() => { setSelectedUser(null); setFiles([]); setFolders([]); }}>← Back to users</button>
          <span style={{ marginLeft: '12px', fontWeight: 600 }}>{selectedEmail}'s Files</span>
        </div>
      </div>

      {/* Breadcrumb */}
      <nav className="breadcrumb" style={{ marginBottom: '12px' }}>
        {folderPath.map((p, i) => (
          <span key={i} className="crumb">
            {i > 0 && <span className="crumb-sep">/</span>}
            <button className="btn-link" onClick={() => goToPathIndex(i)} disabled={i === folderPath.length - 1}>{p.name}</button>
          </span>
        ))}
      </nav>

      {folders.length === 0 && files.length === 0 ? (
        <p className="muted">This folder is empty.</p>
      ) : (
        <table className="files">
          <thead>
            <tr><th>Name</th><th>Size</th><th>Date</th><th /></tr>
          </thead>
          <tbody>
            {folders.map((f) => (
              <tr key={f.id} className="folder-row">
                <td className="filename">
                  <button className="btn-link folder-name" onClick={() => openFolder(f.id, f.name)}>📁 {f.name}</button>
                </td>
                <td className="muted">—</td>
                <td>{new Date(f.createdAt).toLocaleString()}</td>
                <td />
              </tr>
            ))}
            {files.map((f) => (
              <tr key={f.id}>
                <td className="filename">
                  <span>{fileTypeIcon(f.mimeType)} {f.originalName}</span>
                </td>
                <td>{fmtBytes(f.sizeBytes)}</td>
                <td>{new Date(f.createdAt).toLocaleString()}</td>
                <td className="actions">
                  <a href={`/api/files/${f.id}/download`} className="btn-link">Download</a>
                  <button className="btn-link danger" onClick={() => handleDeleteFile(f.id, f.originalName)} disabled={busy}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── SHARES TAB ───────────────────────────────────────────────────────────────

function SharesTab({ onError }: { onError: (msg: string) => void }) {
  const [shares, setShares] = useState<AdminShareLink[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: number) => {
    try {
      const res = await api.adminListShares(p);
      setShares(res.shares); setPage(res.page); setPages(res.pages);
    } catch (e) { if (e instanceof ApiError) onError(e.message); }
  }, [onError]);

  useEffect(() => { load(page); }, [page, load]);

  async function handleRevoke(id: string) {
    if (!confirm('Revoke this share link?')) return;
    setBusy(true);
    try { await api.adminDeleteShare(id); await load(page); }
    catch (e) { if (e instanceof ApiError) onError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      {shares.length === 0 ? (
        <p className="muted">No active share links.</p>
      ) : (
        <table className="files admin-table">
          <thead>
            <tr><th>File</th><th>Shared by</th><th>Downloads</th><th>Expires</th><th /></tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.id}>
                <td className="filename">{fileTypeIcon(s.fileMimeType)} {s.fileName}</td>
                <td>{s.userEmail}</td>
                <td>{s.downloadCount}{s.maxDownloads ? ` / ${s.maxDownloads}` : ''}</td>
                <td>{s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : 'Never'}</td>
                <td className="actions">
                  <button className="btn-link danger" onClick={() => handleRevoke(s.id)} disabled={busy}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>→</button>
        </div>
      )}
    </>
  );
}

// ─── ACTIVITY TAB ─────────────────────────────────────────────────────────────

function ActivityTab({ onError }: { onError: (msg: string) => void }) {
  const [logs, setLogs] = useState<ActivityEntry[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');

  const load = useCallback(async (p: number, action: string) => {
    try {
      const res = await api.adminListActivity(p, 50, action);
      setLogs(res.logs); setPage(res.page); setPages(res.pages);
    } catch (e) { if (e instanceof ApiError) onError(e.message); }
  }, [onError]);

  useEffect(() => { load(page, actionFilter); }, [page, actionFilter, load]);

  const actions = ['', 'login', 'register', 'upload', 'download', 'trash', 'restore', 'share', 'admin'];

  return (
    <>
      <div className="filter-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className="muted" style={{ fontSize: '13px' }}>Filter:</span>
          {actions.map((a) => (
            <button key={a} className={`filter-chip ${actionFilter === a ? 'active' : ''}`}
              onClick={() => { setActionFilter(a); setPage(1); }}>
              {a || 'All'}
            </button>
          ))}
        </div>
        <button onClick={async () => {
          try {
            const res = await api.adminListActivity(1, 100000, actionFilter);
            const lines = ['ID,User Email,Action,Detail,IP Address,Time'];
            res.logs.forEach(a => lines.push(`${a.id},"${a.email ?? ''}",${a.action},"${(a.detail ?? '').replace(/"/g, '""')}","${a.ipAddress ?? ''}",${a.createdAt}`));
            const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `activity_export_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          } catch (e) { if (e instanceof ApiError) onError(e.message); }
        }}>📥 Export CSV</button>
      </div>

      <table className="files admin-table">
        <thead>
          <tr><th>User</th><th>Action</th><th>Detail</th><th>IP</th><th>Time</th></tr>
        </thead>
        <tbody>
          {logs.map((a) => (
            <tr key={a.id}>
              <td>{a.email ?? '—'}</td>
              <td><span className={`action-badge ${a.action}`}>{a.action}</span></td>
              <td className="filename">{a.detail ?? '—'}</td>
              <td className="muted">{a.ipAddress ?? '—'}</td>
              <td>{new Date(a.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {pages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>←</button>
          <span>{page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>→</button>
        </div>
      )}
    </>
  );
}

// ─── SETTINGS TAB ─────────────────────────────────────────────────────────────

function SettingsTab({ onError }: { onError: (msg: string) => void }) {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [regOpen, setRegOpen] = useState(true);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.adminGetSettings().then((s) => {
      setSettings(s);
      setInviteCode(s.inviteCode);
      setRegOpen(s.registrationOpen);
    }).catch((e) => { if (e instanceof ApiError) onError(e.message); });
  }, [onError]);

  async function handleSave() {
    try {
      await api.adminUpdateSettings({ inviteCode, registrationOpen: regOpen });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { if (e instanceof ApiError) onError(e.message); }
  }

  if (!settings) return <p className="muted">Loading…</p>;

  return (
    <div className="settings-grid">
      <div className="card">
        <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>🔐 Registration</h3>

        <label className="settings-label">
          <span>Invite Code</span>
          <input type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
            placeholder="Leave empty for no code" className="settings-input" />
          <span className="muted" style={{ fontSize: '12px' }}>Users need this code to register</span>
        </label>

        <label className="settings-toggle">
          <input type="checkbox" checked={regOpen} onChange={(e) => setRegOpen(e.target.checked)} />
          <span>Registration Open</span>
        </label>

        <button onClick={handleSave} style={{ marginTop: '16px' }}>
          {saved ? '✅ Saved!' : '💾 Save Settings'}
        </button>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 16px', fontSize: '14px', fontWeight: 600 }}>ℹ️ Server Info</h3>
        <div className="settings-info">
          <div className="settings-info-row"><span className="muted">Storage Root</span><code>{settings.storageRoot}</code></div>
          <div className="settings-info-row"><span className="muted">Port</span><code>{settings.port}</code></div>
          <div className="settings-info-row"><span className="muted">Default User Quota</span><span>{fmtBytes(settings.defaultQuotaBytes)}</span></div>
          <div className="settings-info-row"><span className="muted">Admin Quota</span><span>{fmtBytes(settings.adminQuotaBytes)}</span></div>
        </div>
      </div>
    </div>
  );
}

// We need to handle the unused setSelectedUserId reference from the parent
// by making the tab switch work via state at the top level. Since that would
// require more complex state, we just let users click into the files tab
// and select from there for now. The onViewFiles callback isn't used yet.
function setSelectedUserId(_id: string) { void _id; /* placeholder for future cross-tab nav */ }
