import { useCallback, useRef, useState } from 'react';

interface ConfirmOptions {
  title: string;
  message: string;
}

export interface ConfirmDialogState extends ConfirmOptions {
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
    setDialog((previousDialog) => ({ ...previousDialog, visible: false }));
    resolveRef.current?.(result);
    resolveRef.current = null;
  }, []);

  return { dialog, confirm, handleClose };
}