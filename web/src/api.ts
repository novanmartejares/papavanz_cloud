export interface Me {
  id: string;
  email: string;
  role: string;
  storageUsed: number;
  storageQuota: number;
  createdAt: string;
  fileTypes?: { type: string; count: number; bytes: number }[];
}

export interface FileMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: string;
  folderId: string | null;
  starred: boolean;
  trashedAt?: string | null;
}

export interface FileVersion {
  id: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: string;
}

export interface FolderMeta {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
}

export interface FolderDetail {
  folder: FolderMeta;
  subfolders: FolderMeta[];
  files: FileMeta[];
}

export interface ShareLinkMeta {
  id: string;
  token: string;
  url: string;
  fileId: string;
  fileName: string;
  fileMimeType: string | null;
  fileSizeBytes: number;
  hasPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
}

export interface ActivityEntry {
  id: string;
  userId: string;
  email?: string;
  action: string;
  detail: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  storageQuota: number;
  storageUsed: number;
  disabled: boolean;
  fileCount: number;
  createdAt: string;
}

export interface AdminStats {
  userCount: number;
  fileCount: number;
  totalStorageUsed: number;
  activeShares: number;
  trashedCount: number;
  diskTotal: number;
  diskFree: number;
  fileTypes: { type: string; count: number; bytes: number }[];
  serverUptime: number;
}

export interface TrendDay {
  date: string;
  uploads: number;
  logins: number;
}

export interface AdminShareLink {
  id: string;
  token: string;
  userEmail: string;
  fileName: string;
  fileSizeBytes: number;
  fileMimeType: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdAt: string;
}

export interface ServerSettings {
  inviteCode: string;
  registrationOpen: boolean;
  defaultQuotaBytes: number;
  adminQuotaBytes: number;
  storageRoot: string;
  port: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* keep raw text */
    }
    throw new ApiError(res.status, message || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  duplicateInfo?: { existingFile: { id: string; originalName: string; sizeBytes: number; createdAt: string } };
  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (extra && 'existingFile' in extra && extra.existingFile) {
      this.duplicateInfo = { existingFile: extra.existingFile as { id: string; originalName: string; sizeBytes: number; createdAt: string } };
    }
  }
}

export const api = {
  register: (email: string, password: string, inviteCode?: string) =>
    request<Me>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, inviteCode }),
    }),

  login: (email: string, password: string) =>
    request<Me>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  me: () => request<Me>('/api/me'),

  // Files

  listFiles: (
    folderId: string | null = null,
    opts: { all?: boolean; q?: string; recent?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    else if (opts.recent) params.set('recent', '1');
    else if (opts.all) params.set('all', '1');
    else if (folderId) params.set('folderId', folderId);
    const qs = params.toString();
    return request<FileMeta[]>(`/api/files${qs ? `?${qs}` : ''}`);
  },

  uploadFile: async (
    file: File,
    folderId: string | null = null,
    onProgress?: (pct: number) => void,
    action?: 'rename' | 'replace',
    existingId?: string,
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    if (folderId) fd.append('folderId', folderId);
    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (existingId) params.set('existingId', existingId);
    const qs = params.toString();
    return new Promise<FileMeta>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/files${qs ? `?${qs}` : ''}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new ApiError(xhr.status, 'invalid response'));
          }
        } else {
          let msg = xhr.responseText;
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(xhr.responseText);
            msg = (parsed && typeof parsed.error === 'string') ? parsed.error : msg;
          } catch {
            /* keep raw */
          }
          reject(new ApiError(xhr.status, msg || xhr.statusText, parsed ?? undefined));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.send(fd);
    });
  },

  downloadUrl: (id: string) => `/api/files/${id}/download`,

  // Inline-render URL: same blob but Content-Disposition: inline so it
  // renders in <img>/<video>/<iframe> instead of triggering a save dialog.
  previewUrl: (id: string) => `/api/files/${id}/download?inline=1`,

  deleteFile: (id: string) => request<void>(`/api/files/${id}`, { method: 'DELETE' }),

  listVersions: (id: string) => request<FileVersion[]>(`/api/files/${id}/versions`),

  downloadVersionUrl: (id: string, versionId: string) => `/api/files/${id}/versions/${versionId}/download`,

  moveFile: (id: string, folderId: string | null) =>
    request<FileMeta>(`/api/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ folderId }),
    }),

  renameFile: (id: string, originalName: string) =>
    request<FileMeta>(`/api/files/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ originalName }),
    }),

  // Folders

  listFolders: () => request<FolderMeta[]>('/api/folders'),

  getFolder: (id: string) => request<FolderDetail>(`/api/folders/${id}`),

  createFolder: (name: string, parentId: string | null = null) =>
    request<FolderMeta>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name, parentId }),
    }),

  renameFolder: (id: string, name: string) =>
    request<FolderMeta>(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),

  moveFolder: (id: string, parentId: string | null) =>
    request<FolderMeta>(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    }),

  deleteFolder: (id: string) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),

  // Bulk actions

  bulkDelete: (fileIds: string[], folderIds: string[]) =>
    request<{ deletedFiles: number; deletedFolders: number; refundedBytes: number }>(
      '/api/bulk/delete',
      {
        method: 'POST',
        body: JSON.stringify({ fileIds, folderIds }),
      },
    ),

  bulkDownload: async (fileIds: string[], folderIds: string[]) => {
    const res = await fetch('/api/bulk/download', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds, folderIds }),
    });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* keep raw */
      }
      throw new ApiError(res.status, message || res.statusText);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const match = /filename="?([^";]+)"?/.exec(cd);
    const filename = match?.[1] ?? `papavanz-cloud-${new Date().toISOString().slice(0, 10)}.zip`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // Starred

  listStarred: () => request<FileMeta[]>('/api/starred'),

  starFile: (id: string) => request<{ ok: boolean; starred: boolean }>(`/api/starred/${id}`, { method: 'POST' }),

  unstarFile: (id: string) => request<{ ok: boolean; starred: boolean }>(`/api/starred/${id}`, { method: 'DELETE' }),

  // Trash

  listTrash: () => request<FileMeta[]>('/api/trash'),

  trashFile: (id: string) => request<{ ok: boolean }>(`/api/trash/${id}`, { method: 'POST' }),

  restoreFile: (id: string) => request<{ ok: boolean }>(`/api/trash/${id}/restore`, { method: 'POST' }),

  permanentlyDeleteFile: (id: string) => request<void>(`/api/trash/${id}`, { method: 'DELETE' }),

  emptyTrash: () => request<{ deleted: number; refundedBytes: number }>('/api/trash/empty', { method: 'POST' }),

  // Share links
  getPublicShare: (token: string, password?: string) => {
    const headers: Record<string, string> = {};
    if (password) headers['X-Share-Password'] = password;
    return request<Record<string, unknown>>(`/api/public/shares/${token}`, { headers });
  },

  downloadPublicShareUrl: (token: string, inline = false) => `/api/public/shares/${token}?download=1${inline ? '&inline=1' : ''}`,

  listShares: () => request<ShareLinkMeta[]>('/api/shares'),

  createShare: (fileId: string, opts: { password?: string; expiresIn?: number; maxDownloads?: number } = {}) =>
    request<ShareLinkMeta & { url: string }>('/api/shares', {
      method: 'POST',
      body: JSON.stringify({ fileId, ...opts }),
    }),

  deleteShare: (id: string) => request<void>(`/api/shares/${id}`, { method: 'DELETE' }),

  // Activity log

  listActivity: (page = 1, limit = 30) =>
    request<{ logs: ActivityEntry[]; total: number; page: number; pages: number }>(
      `/api/activity?page=${page}&limit=${limit}`,
    ),

  // ─── Admin ────────────────────────────────────────────────────────────

  adminGetStats: () => request<AdminStats>('/admin/stats'),

  adminGetTrends: () => request<{ days: TrendDay[] }>('/admin/trends'),

  adminListUsers: (page = 1, limit = 50, search = '') => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('q', search);
    return request<{ users: AdminUser[]; total: number; page: number; pages: number }>(
      `/admin/users?${params}`,
    );
  },

  adminUpdateUser: (id: string, data: { role?: string; disabled?: boolean; storageQuota?: number }) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  adminDeleteUser: (id: string) =>
    request<{ ok: boolean; deleted: string }>(`/admin/users/${id}`, { method: 'DELETE' }),

  adminGetUserFiles: (userId: string, folderId: string | null = null) => {
    const params = new URLSearchParams();
    if (folderId) params.set('folderId', folderId);
    return request<{ email: string; files: FileMeta[]; folders: FolderMeta[] }>(
      `/admin/users/${userId}/files?${params}`,
    );
  },

  adminDeleteFile: (fileId: string) =>
    request<{ ok: boolean }>(`/admin/files/${fileId}`, { method: 'DELETE' }),

  adminGetSettings: () => request<ServerSettings>('/admin/settings'),

  adminUpdateSettings: (data: { inviteCode?: string; registrationOpen?: boolean }) =>
    request<{ ok: boolean }>('/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  adminListShares: (page = 1, limit = 50) =>
    request<{ shares: AdminShareLink[]; total: number; page: number; pages: number }>(
      `/admin/shares?page=${page}&limit=${limit}`,
    ),

  adminDeleteShare: (id: string) =>
    request<{ ok: boolean }>(`/admin/shares/${id}`, { method: 'DELETE' }),

  adminListActivity: (page = 1, limit = 50, action = '') => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (action) params.set('action', action);
    return request<{ logs: ActivityEntry[]; total: number; page: number; pages: number }>(
      `/admin/activity?${params}`,
    );
  },
};
