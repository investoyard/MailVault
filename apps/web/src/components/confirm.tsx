import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined, QuestionCircleOutlined, WarningOutlined } from '@ant-design/icons';

export type ConfirmTone = 'danger' | 'warning' | 'primary' | 'success';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  /** The item being acted on (a name, email, count), shown highlighted. */
  subject?: ReactNode;
  tone?: ConfirmTone;
  icon?: ReactNode;
  okText?: string;
  cancelText?: string;
  /** Runs while the dialog shows a busy button; the dialog closes when it settles. */
  onConfirm?: () => unknown;
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

const TONE_ICON: Record<ConfirmTone, ReactNode> = {
  danger: <ExclamationCircleOutlined />,
  warning: <WarningOutlined />,
  primary: <QuestionCircleOutlined />,
  success: <CheckCircleOutlined />,
};

interface State extends ConfirmOptions {
  open: boolean;
  busy: boolean;
}

/**
 * One app-wide confirmation dialog. Usage:
 *   const confirm = useConfirm();
 *   confirm({ tone: 'danger', title: 'Remove this integration?', subject: name, okText: 'Remove', onConfirm: () => del.mutateAsync(id) });
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ open: false, busy: false, title: '' });
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setState({ ...o, open: true, busy: false });
      }),
    [],
  );

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState((s) => ({ ...s, open: false, busy: false }));
  };

  const accept = async () => {
    if (!state.onConfirm) return finish(true);
    setState((s) => ({ ...s, busy: true }));
    try {
      await state.onConfirm();
      finish(true);
    } catch {
      // The action reports its own error (toast); just close.
      finish(false);
    }
  };

  const tone = state.tone ?? 'primary';
  const danger = tone === 'danger';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={state.open}
        onCancel={() => !state.busy && finish(false)}
        footer={null}
        closable={false}
        maskClosable={!state.busy}
        keyboard={!state.busy}
        centered
        width={420}
        className={`mv-confirm mv-confirm-${tone}`}
        destroyOnHidden
      >
        <div className="mv-confirm-body" role="alertdialog" aria-modal="true">
          <span className="mv-confirm-icon">{state.icon ?? TONE_ICON[tone]}</span>
          <h3 className="mv-confirm-title">{state.title}</h3>
          {state.subject && <div className="mv-confirm-subject">{state.subject}</div>}
          {state.description && <div className="mv-confirm-desc">{state.description}</div>}
          <div className="mv-confirm-actions">
            <Button size="large" onClick={() => finish(false)} disabled={state.busy} autoFocus={danger}>
              {state.cancelText ?? 'Cancel'}
            </Button>
            <Button size="large" type="primary" danger={danger} loading={state.busy} onClick={() => void accept()} autoFocus={!danger} className="mv-confirm-ok">
              {state.okText ?? 'Confirm'}
            </Button>
          </div>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return fn;
}
