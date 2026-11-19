import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Empty, Input, Modal, Space, Spin, Tooltip } from 'antd';
import { ArrowUpOutlined, CloudServerOutlined, FolderAddOutlined, FolderFilled, HddOutlined, HomeOutlined, RightOutlined } from '@ant-design/icons';
import { api } from '../api';

export interface FolderEntry {
  name: string;
  path: string;
}

/** Reply of /api/destinations/browse | test | mkdir (see apps/api/src/folder-ops.ts). */
export type FolderOpReply = {
  account: string;
  via: 'worker' | 'website';
} & (
  | {
      ok: true;
      listing?: { path: string | null; parent: string | null; folders: FolderEntry[]; truncated: boolean };
      check?: { status: 'HEALTHY' | 'LOW_SPACE' | 'UNAVAILABLE'; freeMb: number | null; error: string | null };
      created?: string;
    }
  | { ok: false; error: string }
);

/** "D:\a\b" -> "D:\a"; drive or share root -> null (top level). */
function parentOf(p: string): string | null {
  const t = p.replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(t) || /^\\\\[^\\]+\\[^\\]+$/.test(t)) return null;
  const up = t.slice(0, t.lastIndexOf('\\'));
  return /^[a-zA-Z]:$/.test(up) ? `${up}\\` : up || null;
}

/** Who did the check, in words an admin understands. */
export function CheckedAs({ reply }: { reply: Pick<FolderOpReply, 'account' | 'via'> }) {
  if (!reply.account) return null;
  return reply.via === 'worker' ? (
    <span className="mv-muted" style={{ fontSize: 12.5 }}>
      Checked by the MailVault worker as <span className="mv-mono">{reply.account}</span>
    </span>
  ) : (
    <span style={{ fontSize: 12.5, color: '#B45309' }}>
      The worker is not running, so this was checked as the website's account (<span className="mv-mono">{reply.account}</span>). The worker's
      access may differ.
    </span>
  );
}

/**
 * Browses folders ON THE SERVER (not the user's PC). Lists folder names only; the worker does the
 * listing so what you see is what MailVault can reach.
 */
export function FolderPicker({ open, initialPath, onCancel, onSelect }: { open: boolean; initialPath?: string; onCancel: () => void; onSelect: (path: string) => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    const start = initialPath?.trim() ? initialPath.trim() : null;
    setPath(start);
    setTyped(start ?? '');
    setNewName(null);
  }, [open, initialPath]);

  const q = useQuery({
    queryKey: ['folder-browse', path],
    queryFn: () => api.post<FolderOpReply>('/api/destinations/browse', { path }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });
  const reply = q.data;
  const listing = reply?.ok ? reply.listing : undefined;
  const current = listing ? listing.path : path;
  const up = listing ? listing.parent : path ? parentOf(path) : null;

  const go = (p: string | null) => {
    setPath(p);
    setTyped(p ?? '');
    setNewName(null);
  };

  const createFolder = async () => {
    if (!current || !newName?.trim()) return;
    setCreating(true);
    try {
      const r = await api.post<FolderOpReply>('/api/destinations/mkdir', { parent: current, name: newName.trim() });
      if (!r.ok) return void message.error(r.error);
      message.success(`Folder created: ${r.created}`);
      void qc.invalidateQueries({ queryKey: ['folder-browse', current] });
      if (r.created) go(r.created);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      width={660}
      title={
        <Space>
          <CloudServerOutlined />
          Choose a folder on the server
        </Space>
      }
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>{reply && <CheckedAs reply={reply} />}</div>
          <Button onClick={onCancel}>Cancel</Button>
          <Button type="primary" disabled={!current || !reply?.ok} onClick={() => current && onSelect(current)}>
            Select this folder
          </Button>
        </div>
      }
    >
      <Space.Compact style={{ width: '100%', marginBottom: 10 }}>
        <Tooltip title="Drives">
          <Button icon={<HomeOutlined />} onClick={() => go(null)} disabled={path === null} aria-label="Drives" />
        </Tooltip>
        <Tooltip title="Up one level">
          <Button icon={<ArrowUpOutlined />} onClick={() => go(up)} disabled={path === null} aria-label="Up one level" />
        </Tooltip>
        <Input
          className="mv-mono"
          value={typed}
          placeholder="Type a path, e.g. D:\Files or \\fileserver\share"
          onChange={(e) => setTyped(e.target.value)}
          onPressEnter={() => go(typed.trim() || null)}
        />
        <Button onClick={() => go(typed.trim() || null)}>Go</Button>
      </Space.Compact>

      <div style={{ border: '1px solid #E7E5EF', borderRadius: 10, height: 340, overflow: 'auto', position: 'relative' }}>
        {q.isFetching && !listing ? (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
            <Spin />
          </div>
        ) : reply && !reply.ok ? (
          <div style={{ padding: 16 }}>
            <Alert type="error" showIcon message="This folder can't be opened" description={reply.error} />
          </div>
        ) : listing && listing.folders.length === 0 ? (
          <Empty style={{ marginTop: 90 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description="No sub-folders here. You can select this folder or create a new one." />
        ) : (
          listing?.folders.map((f) => (
            <button
              key={f.path}
              type="button"
              className="mv-folder-row"
              onClick={() => go(f.path)}
              title={f.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '8px 12px',
                border: 0,
                borderBottom: '1px solid #F2F1F7',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                font: 'inherit',
              }}
            >
              {listing.path === null ? <HddOutlined style={{ color: '#3C2E7E' }} /> : <FolderFilled style={{ color: '#F5B92E' }} />}
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
              <RightOutlined className="mv-muted" style={{ fontSize: 11 }} />
            </button>
          ))
        )}
        {q.isFetching && listing && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,.6)', display: 'grid', placeItems: 'center' }}>
            <Spin />
          </div>
        )}
      </div>
      {listing?.truncated && <div className="mv-muted" style={{ fontSize: 12.5, marginTop: 6 }}>Showing the first 1,000 folders. Type a path to go deeper.</div>}

      <div style={{ marginTop: 12, minHeight: 32 }}>
        {current && reply?.ok && (newName === null ? (
          <Button icon={<FolderAddOutlined />} onClick={() => setNewName('')}>
            New folder here
          </Button>
        ) : (
          <Space.Compact style={{ width: '100%' }}>
            <Input autoFocus placeholder="New folder name" value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} onPressEnter={() => void createFolder()} />
            <Button type="primary" loading={creating} disabled={!newName.trim()} onClick={() => void createFolder()}>
              Create
            </Button>
            <Button onClick={() => setNewName(null)}>Cancel</Button>
          </Space.Compact>
        ))}
      </div>
    </Modal>
  );
}
