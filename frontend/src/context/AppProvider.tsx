import { useReducer } from 'react';
import type { ReactNode } from 'react';
import { AppContext, appReducer, initialState } from './AppContext';

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}