import { useAppContext } from '../../context/AppContext';

export default function Spinner() {
  const { state } = useAppContext();

  if (!state.loading) return null;

  return (
    <div className="spinner-overlay position-fixed top-0 start-0 w-100 h-100 d-flex align-items-center justify-content-center"
      style={{ zIndex: 1050 }}>
      <div className="spinner-border text-primary" role="status">
        <span className="visually-hidden">Loading...</span>
      </div>
    </div>
  );
}
