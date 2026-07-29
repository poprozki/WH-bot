const ASSET_V = '7';
export const asset = (name) => `/panel/static/${name}?v=${ASSET_V}`;

export function h(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV = [
  { key: 'day',    href: '/panel/',         icon: '📅', label: 'Сегодня',   dev: false },
  { key: 'chats',  href: '/panel/chats',    icon: '💬', label: 'Чаты',      dev: false },
  { key: 'stats',  href: '/panel/stats',    icon: '📈', label: 'Статистика',   dev: false },
  { key: 'set',    href: '/panel/settings', icon: '⚙️', label: 'Настройки', dev: false },
  { key: 'con',    href: '/panel/console',  icon: '🧪', label: 'Консоль',   dev: true  },
  { key: 'salons', href: '/panel/salons',   icon: '🏢', label: 'Салоны',    dev: true  },
  { key: 'ops',    href: '/panel/ops',      icon: '🩺', label: 'Служебное', dev: true  },
];

const MOBILE = ['day', 'chats', 'stats', 'set', 'con'];

function sidebar(active, dev, salonName) {
  const items = NAV.filter((n) => !n.dev || dev);
  const own = items.filter((n) => !n.dev);
  const devItems = items.filter((n) => n.dev);

  const row = (n) => `
    <a href="${n.href}" class="${active === n.key ? 'on' : ''}"${active === n.key ? ' aria-current="page"' : ''}>
      <span class="i" aria-hidden="true">${n.icon}</span>${h(n.label)}</a>`;

  return `
  <aside class="side">
    <div class="brand"><span class="dot" aria-hidden="true">◈</span>${h(salonName || 'Студия')}</div>
    ${own.map(row).join('')}
    ${devItems.length ? `<div class="grp">Разработчику</div>${devItems.map(row).join('')}` : ''}
  </aside>`;
}

function tabbar(active, dev) {
  const items = NAV.filter((n) => MOBILE.includes(n.key) && (!n.dev || dev)).slice(0, 5);
  return `
  <nav class="tabbar">
    ${items.map((n) => `
      <a href="${n.href}" class="${active === n.key ? 'on' : ''}"${active === n.key ? ' aria-current="page"' : ''}>
        <span class="i" aria-hidden="true">${n.icon}</span>${h(n.label)}</a>`).join('')}
  </nav>`;
}

export function page({ title, body, active = '', dev = false, sub = '',
                       back = '', salon = '', impersonating = null }) {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="theme-color" content="#9333ea" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141118" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Записи">
<link rel="manifest" href="/panel/manifest.webmanifest">
<link rel="apple-touch-icon" href="/panel/static/icon-192.png">
<link rel="stylesheet" href="${asset('app.css')}">
<title>${h(title)}</title>
</head><body>
<div class="app">
  ${sidebar(active, dev, salon)}
  <div class="main">
    <div class="topbar"><div class="wrap">
      ${back ? `<a class="back" href="${back}">‹ Назад</a>` : ''}
      <h1>${h(title)}</h1>
      ${sub ? `<span class="sub">${sub}</span>` : ''}
    </div></div>
    ${impersonating ? `<div class="impersonate">
      Вы смотрите салон «${h(impersonating)}» от лица владелицы.
      <a href="/panel/salons">выйти</a>
    </div>` : ''}
    <div class="wrap">${body}</div>
  </div>
</div>
${tabbar(active, dev)}
<script src="${asset('htmx.min.js')}" defer></script>
<script src="${asset('app.js')}" defer></script>
</body></html>`;
}

export function empty(icon, title, hint = '') {
  return `<div class="empty">
    <div class="big" aria-hidden="true">${icon}</div>
    <p>${h(title)}</p>
    ${hint ? `<small>${h(hint)}</small>` : ''}
  </div>`;
}

export const money = (v) => `${Number(v || 0).toLocaleString('ru-RU')} ₸`;

export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
export const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
