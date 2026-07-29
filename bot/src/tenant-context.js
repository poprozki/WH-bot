import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export function runInTenant(tenantId, actor, fn) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`runInTenant: некорректный tenantId (${tenantId})`);
  }
  return als.run({ tenantId: id, actor: actor || 'system' }, fn);
}

export function runAsAdmin(reason, fn) {
  return als.run({ tenantId: null, admin: true, actor: `admin:${reason}` }, fn);
}

export function currentTenantId() {
  return als.getStore()?.tenantId ?? null;
}

export function currentActor() {
  return als.getStore()?.actor ?? 'system';
}

export function isAdminContext() {
  return als.getStore()?.admin === true;
}

export function hasContext() {
  return als.getStore() !== undefined;
}
