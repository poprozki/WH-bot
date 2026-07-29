export function slugFromHost(host, baseDomain) {
  if (!host || !baseDomain) return null;

  const clean = String(host).split(':')[0].toLowerCase().trim()
    .replace(/\.$/, '');
  const base = String(baseDomain).toLowerCase().trim();

  if (clean === base) return null;
  if (!clean.endsWith(`.${base}`)) return null;

  const sub = clean.slice(0, -(base.length + 1));
  if (!sub || sub.includes('.')) return null;

  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(sub)) return null;

  if (['panel', 'admin', 'www', 'api', 'static', 'cdn'].includes(sub)) return null;

  return sub;
}
