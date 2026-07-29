import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('Добавьте в .env:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:вашапочта@example.com');
console.log('\nПосле смены ключей все существующие подписки перестанут работать —');
console.log('владелице придётся заново разрешить уведомления.');
