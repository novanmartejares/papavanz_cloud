export interface Me {
  id: string;
  email: string;
  storageUsed: number;
  storageQuota: number;
  createdAt: string;
}

export interface FileMeta {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: string;
  folderId: string | null;
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
  constructor(public status: number, message: string) {
    super(message);
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

  me: () => request<Me>('/api/me'),

  // Files

  listFiles: (folderId: string | null = null, opts: { all?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.all) params.set('all', '1');
    else if (folderId) params.set('folderId', folderId);
    const qs = params.toString();
    return request<FileMeta[]>(`/api/files${qs ? `?${qs}` : ''}`);
  },

  uploadFile: async (
    file: File,
    folderId: string | null = null,
    onProgress?: (pct: number) => void,
  ) => {
    const fd = new FormData();
    fd.append('file', file);
    if (folderId) fd.append('folderId', folderId);
    return new Promise<FileMeta>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files');
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
          try {
            msg = JSON.parse(xhr.responseText).error ?? msg;
          } catch {
            /* keep raw */
          }
          reject(new ApiError(xhr.status, msg || xhr.statusText));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, 'network error'));
      xhr.send(fd);
    });
  },

  downloadUrl: (id: string) => `/api/files/${id}/download`,

  deleteFile: (id: string) => request<void>(`/api/files/${id}`, { method: 'DELETE' }),

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
};
