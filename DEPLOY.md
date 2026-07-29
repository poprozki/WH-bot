# Развёртывание на сервере

Пошагово, от чистой Ubuntu до работающего бота. Порядок шагов важен —
где это критично, отмечено отдельно.

Контур: Contabo Cloud VPS, Ubuntu 24.04, доступ по SSH под root.

---

## 0. Часовой пояс — ПЕРВЫМ ДЕЛОМ

```bash
timedatectl set-timezone Asia/Almaty
timedatectl          # проверить: должно быть +05
```

Contabo отдаёт машины в UTC. Если сделать это позже, все уже созданные
cron-задачи и напоминания будут сдвинуты на пять часов, а расписание
покажет вчерашний день после семи вечера.

---

## 1. Подкачка и базовые пакеты

```bash
apt update && apt upgrade -y
apt install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades

# Contabo отдаёт машины БЕЗ подкачки. Она нужна не как память,
# а как амортизатор: без неё утечка в одном контейнере убивает весь сервер
fallocate -l 4G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.d/99-swap.conf
```

---

## 2. Пользователь и вход по ключу

```bash
adduser --gecos "" salon
usermod -aG sudo salon
mkdir -p /home/salon/.ssh
cat >> /home/salon/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAA... ваш-ключ
KEY
chown -R salon:salon /home/salon/.ssh
chmod 700 /home/salon/.ssh && chmod 600 /home/salon/.ssh/authorized_keys
```

**ПРОВЕРЬТЕ ВХОД ВО ВТОРОМ ОКНЕ ТЕРМИНАЛА, НЕ ЗАКРЫВАЯ ЭТО.**
Следующий шаг отключает вход по паролю. Ошиблись — потеряете доступ
к серверу и придётся идти в консоль провайдера.

```bash
# Имя файла ДОЛЖНО сортироваться раньше 50-cloud-init.conf:
# OpenSSH берёт ПЕРВОЕ найденное значение, а cloud-init уже включил пароли
cat > /etc/ssh/sshd_config.d/01-hardening.conf <<'CFG'
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
AllowUsers salon
CFG
systemctl restart ssh
sshd -T | grep -E 'passwordauthentication|permitrootlogin'   # оба должны быть no
```

---

## 3. Межсетевой экран

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable
```

**Важно понимать ограничение.** Docker пишет собственные правила в обход
UFW. Опубликованный порт контейнера будет доступен снаружи, даже если
`ufw status` показывает только 22. Единственная настоящая защита —
привязка портов к `127.0.0.1` в файле развёртывания, а она там есть.
Никогда не публикуйте порт без явного `127.0.0.1:`.

```bash
# fail2ban на 24.04+ читает journald, а не /var/log/auth.log — тот пуст,
# и без этой строки джейл молча не банит никого и никогда
cat > /etc/fail2ban/jail.local <<'CFG'
[DEFAULT]
backend = systemd
[sshd]
enabled = true
maxretry = 5
bantime = 1h
CFG
systemctl enable --now fail2ban
```

---

## 4. Ротация логов — ДО установки Docker

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'CFG'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
CFG
```

Порядок критичен: настройки логов применяются **только к контейнерам,
созданным после** их появления. Сделаете позже — 200 ГБ диска забьются
логами, а уже созданные контейнеры так и останутся без ротации.

---

## 5. Docker

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker salon
```

Ставим из репозитория, а не скриптом `get.docker.com` — сами
разработчики Docker не рекомендуют его для боевых серверов.

---

## 6. Проект и секреты

```bash
su - salon
git clone <репозиторий> ~/salon    # или scp с рабочей машины
cd ~/salon

# Секреты генерируются на месте и никогда не хранятся в репозитории
g() { openssl rand -hex "${1:-32}"; }
cat > .env <<ENV
PG_PASSWORD=$(g 24)
BOT_DB_PASSWORD=$(g 24)
WAHA_API_KEY=$(g 32)
WAHA_HMAC_KEY=$(g 32)
WAHA_DASHBOARD_USER=admin
WAHA_DASHBOARD_PASSWORD=$(g 12)
SESSION_SECRET=$(g 32)

LLM_PROVIDER=deepseek
LLM_API_KEY=sk-ВАШ_КЛЮЧ

# Служебные оповещения — разработчику, не владелице салона
DEV_TELEGRAM_TOKEN=
DEV_TELEGRAM_CHAT_ID=

# Панель наружу
BASE_DOMAIN=
PANEL_ORIGIN=https://panel.вашдомен.kz
CF_ACCESS_TEAM_DOMAIN=
CF_ACCESS_AUD=
CF_TUNNEL_TOKEN=

# Web Push владелице: npm run vapid
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:вы@почта
ENV
chmod 600 .env
```

`PANEL_DEV_AUTH` в этом файле быть НЕ ДОЛЖНО. Процесс с ним при
`NODE_ENV=production` откажется стартовать — это панель с телефонами
клиенток без пароля.

---

## 7. Запуск

```bash
docker compose up -d postgres
docker compose exec postgres pg_isready -U salon -d salon   # дождаться готовности
docker compose up -d bot waha

# Схема. При первом развёртывании начальные файлы применит сам Postgres,
# поэтому миграции достаточно отметить как применённые
docker compose exec -e MIGRATE_DATABASE_URL="postgres://salon:$(grep ^PG_PASSWORD .env | cut -d= -f2)@postgres:5432/salon" \
  bot node scripts/migrate.js --baseline

bash bot/scripts/smoke.sh http://127.0.0.1:3001
```

---

## 8. Привязка телефона

Порты наружу не смотрят, поэтому через туннель со своей машины:

```bash
ssh -L 3001:127.0.0.1:3001 salon@СЕРВЕР
```

Дальше в браузере `http://127.0.0.1:3001/panel/qr` — код обновляется сам.
**Телефон держите наготове:** WhatsApp даёт ограниченное число кодов
подряд, и если их не отсканировать, сессия падает с ошибкой.

Номер — отдельный, не личный номер владелицы. Протокол неофициальный,
при блокировке вместе с номером уедет вся личная переписка.

---

## 9. Панель наружу

Порядок обязателен и не подлежит перестановке:

1. Создать приложение и политику в Cloudflare Access
2. **Только потом** добавить маршрут в туннеле

Наоборот нельзя: между публикацией и настройкой доступа панель будет
открыта всему интернету, а имя хоста попадает в публичные журналы
сертификатов за секунды — сканеры их читают непрерывно.

```bash
docker compose --profile web up -d
```

---

## 10. Обновление

```bash
cd ~/salon && git pull
docker compose build bot

# Бота останавливаем на время миграций: иначе они упрутся в блокировки,
# которые он держит, и упадут по таймауту через пять секунд
docker compose stop bot
docker compose exec -e MIGRATE_DATABASE_URL="postgres://salon:$(grep ^PG_PASSWORD .env | cut -d= -f2)@postgres:5432/salon" \
  bot node scripts/migrate.js
docker compose up -d bot

bash bot/scripts/smoke.sh http://127.0.0.1:3001
```

---

## Что проверить перед тем, как отдать салону

- [ ] `sshd -T | grep passwordauth` → `no`
- [ ] `docker info --format '{{.LoggingDriver}}'` → `local`
- [ ] `free -h` → подкачка 4 ГБ
- [ ] `timedatectl` → `+05`
- [ ] смок-тест зелёный
- [ ] сессия WhatsApp в состоянии `WORKING`
- [ ] в консоли панели бот отвечает настоящими ценами из прайса
- [ ] оповещение в Telegram приходит (остановите бота — должно прийти)
- [ ] бэкап отработал и восстановление проверено на копии
- [ ] ключ DeepSeek выпущен заново, если засветился где-либо
- [ ] владелица добавила панель на домашний экран телефона
