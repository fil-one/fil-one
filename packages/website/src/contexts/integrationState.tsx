import { createContext, useContext, useState } from 'react';

export type IntegrationStatus = 'available' | 'pending' | 'connected';

export type IntegrationState = {
  status: IntegrationStatus;
  buckets: string[];
};

type IntegrationStateMap = Record<string, IntegrationState>;

type IntegrationStateContextValue = {
  states: IntegrationStateMap;
  connect: (name: string, buckets: string[]) => void;
  disconnect: (name: string) => void;
  setBuckets: (name: string, buckets: string[]) => void;
};

const IntegrationStateContext = createContext<IntegrationStateContextValue>({
  states: {},
  connect: () => {},
  disconnect: () => {},
  setBuckets: () => {},
});

const INITIAL_STATES: IntegrationStateMap = {
  'Claude Desktop': { status: 'connected', buckets: ['agent-memory', 'contracts-prod'] },
};

export function IntegrationStateProvider({ children }: { children: React.ReactNode }) {
  const [states, setStates] = useState<IntegrationStateMap>(INITIAL_STATES);

  function connect(name: string, buckets: string[]) {
    setStates((prev) => ({ ...prev, [name]: { status: 'pending', buckets } }));
  }

  function disconnect(name: string) {
    setStates((prev) => ({ ...prev, [name]: { status: 'available', buckets: [] } }));
  }

  function setBuckets(name: string, buckets: string[]) {
    setStates((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { status: 'available', buckets: [] }), buckets },
    }));
  }

  return (
    <IntegrationStateContext.Provider value={{ states, connect, disconnect, setBuckets }}>
      {children}
    </IntegrationStateContext.Provider>
  );
}

export function useIntegrationState() {
  return useContext(IntegrationStateContext);
}
