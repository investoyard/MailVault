import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Checkbox, Empty, Input, Modal, Skeleton, Tag } from 'antd';
import { FolderOutlined, SearchOutlined } from '@ant-design/icons';
import { api } from '../api';
import { fromNow } from '../format';

interface FolderInfo {
  id: string;
  displayName: string;
  path: string;
  totalItemCount?: number;
}
interface Resp {
  available: FolderInfo[] | null;
  monitored: { id: string; displayName: string; lastSyncAt: string | null }[];
  error: string | null;
}

/** Choose which mail folders are watched (needed when Outlook rules move mail into subfolders). */
export function FoldersModal({ mailbox, canEdit, onClose }: { mailbox: { id: string; email: string } | null; canEdit: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const q = useQuery({
    queryKey: ['mailbox-folders', mailbox?.id],
    queryFn: () => api.get<Resp>(`/api/mailboxes/${mailbox!.id}/folders`),
    enabled: !!mailbox,
  });

  useEffect(() => {
    if (q.data) setSelected(q.data.monitored.map((f) => f.id));
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => {
      const all = q.data?.available ?? [];
      const folders = selected.map((id) => {
        const f = all.find((x) => x.id === id) ?? q.data?.monitored.find((x) => x.id === id);
        return { id, displayName: (f && 'path' in f ? f.path : f?.displayName) ?? id };
      });
      return api.put(`/api/mailboxes/${mailbox!.id}/folders`, { folders });
    },
    onSuccess: () => {
      message.success('Monitored folders saved. New folders start with emails received from now on.');
      void qc.invalidateQueries({ queryKey: ['mailboxes'] });
      void qc.invalidateQueries({ queryKey: ['mailbox-folders', mailbox?.id] });
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const available = (q.data?.available ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Modal
      open={!!mailbox}
      onCancel={onClose}
      title={`Monitored folders · ${mailbox?.email ?? ''}`}
      okText="Save folders"
      onOk={() => save.mutate()}
      okButtonProps={{ disabled: !canEdit || !q.data?.available || selected.length === 0, loading: save.isPending }}
      width={560}
      destroyOnHidden
    >
      <p className="mv-muted" style={{ marginTop: 0 }}>
        MailVault checks these folders for new emails. Add subfolders if Outlook rules move emails out of the Inbox.
      </p>
      {q.isLoading ? (
        <Skeleton active />
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Currently monitored</div>
            {q.data?.monitored.map((f) => (
              <Tag key={f.id} icon={<FolderOutlined />} style={{ marginBottom: 4 }}>
                {f.displayName} <span className="mv-muted">· synced {fromNow(f.lastSyncAt)}</span>
              </Tag>
            ))}
          </div>
          {q.data?.error ? (
            <Alert type="warning" showIcon message="Folder list not available" description={q.data.error} />
          ) : (
            <>
              <Input prefix={<SearchOutlined className="mv-muted" />} placeholder="Filter folders" allowClear value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 10 }} />
              <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid #E6E9F0', borderRadius: 8, padding: '6px 12px' }}>
                {available.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No folders" />
                ) : (
                  <Checkbox.Group value={selected} onChange={(v) => setSelected(v as string[])} style={{ display: 'flex', flexDirection: 'column', gap: 6 }} disabled={!canEdit}>
                    {available.map((f) => (
                      <Checkbox key={f.id} value={f.id}>
                        <span style={{ paddingLeft: (f.path.split('/').length - 1) * 16 }}>{f.displayName}</span>
                        <span className="mv-muted" style={{ marginLeft: 8, fontSize: 12 }}>{f.totalItemCount ?? 0} items</span>
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
