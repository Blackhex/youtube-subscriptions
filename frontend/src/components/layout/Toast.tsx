import { useEffect } from 'react';
import { useAppContext } from '../../context/AppContext';

export default function Toast() {
  const { state, dispatch } = useAppContext();
  const { toast } = state;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dispatch({ type: 'HIDE_TOAST' }), 4000);
    return () => clearTimeout(timer);
  }, [toast, dispatch]);

  if (!toast) return null;

  const bgClass =
    toast.type === 'success' ? 'toast-success' :
    toast.type === 'error' ? 'toast-error' :
    'toast-info';

  return (
    <div className="toast-container position-fixed bottom-0 end-0 p-3" style={{ zIndex: 1100 }}>
      <div className={`toast show text-white ${bgClass}`}>
        <div className="toast-body d-flex justify-content-between align-items-center">
          <span>{toast.message}</span>
          <button
            type="button"
            className="btn-close btn-close-white ms-2"
            onClick={() => dispatch({ type: 'HIDE_TOAST' })}
          />
        </div>
      </div>
    </div>
  );
}
