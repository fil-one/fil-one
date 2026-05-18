export const STORAGE_STATE = {
  paid: '.auth/paid.json',
  unpaid: '.auth/unpaid.json',
  trial: '.auth/trial.json',
} as const;

export type Role = keyof typeof STORAGE_STATE;
