import { createContext, useContext, useState } from 'react';

export type AddOnStatus = 'coming-soon' | 'disabled' | 'active';

type AddOnStateMap = Record<string, AddOnStatus>;

type AddOnStateContextValue = {
  states: AddOnStateMap;
  setStatus: (path: string, status: AddOnStatus) => void;
};

const AddOnStateContext = createContext<AddOnStateContextValue>({
  states: {},
  setStatus: () => {},
});

export function AddOnStateProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<AddOnStateMap>({
    '/rag-pipeline': 'coming-soon',
    '/ai-agent-toolkit': 'coming-soon',
  });

  function setStatus(path: string, status: AddOnStatus) {
    setStates((prev) => ({ ...prev, [path]: status }));
  }

  return (
    <AddOnStateContext.Provider value={{ states, setStatus }}>
      {children}
    </AddOnStateContext.Provider>
  );
}

export function useAddOnState() {
  return useContext(AddOnStateContext);
}
