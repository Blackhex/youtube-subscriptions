import { useCallback, useRef, useState } from 'react';

interface ConfirmOptions {
  title: string;
  message: string;
}

interface ConfirmDialogState extends ConfirmOptions {
  visible: boolean;
}

export function useConfirm() {
  const [dialog, setDialog] = useState<ConfirmDialogState>({ visible: false, title: '', message: '' });
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setDialog({ ...options, visible: true });
    });
  }, []);

  const handleClose = useCallback((result: boolean) => {
    setDialog((prev) => ({ ...prev, visible: false }));
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  return { dialog, confirm, handleClose };
}

interface ConfirmDialogProps {
  dialog: { visible: boolean; title: string; message: string };
  onClose: (result: boolean) => void;
}

export default function ConfirmDialog({ dialog, onClose }: ConfirmDialogProps) {
  if (!dialog.visible) return null;

  return (
    <div className="modal d-block" tabIndex={-1} style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="modal-dialog modal-dialog-centered modal-sm">
        <div className="modal-content">
          <div className="modal-header">
            <h5 className="modal-title">{dialog.title}</h5>
            <button type="button" className="btn-close" onClick={() => onClose(false)} />
          </div>
          <div className="modal-body">
            <p>{dialog.message}</p>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onClose(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onClose(true)}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
