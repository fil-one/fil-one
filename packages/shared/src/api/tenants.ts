/**
 * Orchestrator-agnostic tenant status. These are the three lowercase-dashed
 * values shared by every orchestrator. Aurora's generated `ModelsTenantStatus`
 * additionally has a never-used `LOCKED` value we intentionally don't model.
 */

export type TenantStatus = 'active' | 'write-locked' | 'disabled';
