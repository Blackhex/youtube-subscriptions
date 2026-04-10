import type { ConfirmDialogState } from '../../hooks/useConfirm';

interface ConfirmDialogProps {
  dialog: ConfirmDialogState;
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
