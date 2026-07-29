(async function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS && !standalone) {
    showHint(
      'Чтобы получать уведомления о новых записях, добавьте эту страницу на экран «Домой»: ' +
      'кнопка «Поделиться» → «На экран Домой».'
    );
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/panel/static/sw.js', { scope: '/panel/' });

    const existing = await reg.pushManager.getSubscription();
    if (existing) return;

    document.addEventListener('click', askOnce, { once: true });

    async function askOnce() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;

      const key = await (await fetch('/panel/push/key')).text();
      if (!key) return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });

      await fetch('/panel/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub),
      });
    }
  } catch (e) {
    console.warn('push registration failed', e);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  function showHint(text) {
    if (sessionStorage.getItem('pwaHint')) return;
    sessionStorage.setItem('pwaHint', '1');
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:96px;background:#211d26;color:#fff;' +
      'padding:14px 16px;border-radius:14px;font-size:14px;line-height:1.4;z-index:50';
    el.textContent = text;
    el.addEventListener('click', () => el.remove());
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 15000);
  }
})();
