#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Запускать от root"; exit 1; fi

SALON_USER="${SALON_USER:-salon}"
SSH_PUBKEY="${SSH_PUBKEY:-}"

if [[ -z "$SSH_PUBKEY" ]]; then
  echo "Задайте свой публичный ключ:"
  echo "  SSH_PUBKEY='ssh-ed25519 AAAA... you@host' $0"
  exit 1
fi

timedatectl set-timezone Asia/Almaty
echo "[0] часовой пояс: $(timedatectl show -p Timezone --value)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  ufw fail2ban unattended-upgrades curl git make jq ca-certificates gnupg openssl

if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
fi
echo "[2] подкачка: $(free -h | awk '/Swap/{print $2}')"

if ! id "$SALON_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$SALON_USER"
fi
usermod -aG sudo "$SALON_USER"
install -d -m 700 -o "$SALON_USER" -g "$SALON_USER" "/home/$SALON_USER/.ssh"
echo "$SSH_PUBKEY" > "/home/$SALON_USER/.ssh/authorized_keys"
chmod 600 "/home/$SALON_USER/.ssh/authorized_keys"
chown "$SALON_USER:$SALON_USER" "/home/$SALON_USER/.ssh/authorized_keys"

echo ""
echo "⚠️  ПРОВЕРЬТЕ ВХОД В ДРУГОМ ОКНЕ, НЕ ЗАКРЫВАЯ ЭТО:"
echo "     ssh $SALON_USER@$(hostname -I | awk '{print $1}')"
read -p "Вход по ключу работает? Введите 'да': " ok
[[ "$ok" == "да" ]] || { echo "Прервано. Пароль не отключён."; exit 1; }

cat > /etc/ssh/sshd_config.d/01-hardening.conf <<EOF
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
MaxAuthTries 3
AllowUsers $SALON_USER
EOF
sshd -t && systemctl reload ssh
echo "[4] вход по паролю: $(sshd -T | grep -i '^passwordauthentication')"

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw --force enable

echo "[5] ufw включён. Помните: docker обходит ufw для опубликованных портов."

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51-no-reboot
systemctl enable --now unattended-upgrades >/dev/null

mkdir -p /etc/systemd/journald.conf.d
echo -e "[Journal]\nSystemMaxUse=500M" > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald

mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
EOF

if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker "$SALON_USER"

install -d -o "$SALON_USER" -g "$SALON_USER" /opt/salon /opt/salon-backups

echo ""
echo "════════════════════════════════════════════"
echo "Сервер готов."
echo ""
echo "Дальше:"
echo "  1. Перезайдите как $SALON_USER (нужно для группы docker)"
echo "  2. Скопируйте проект в /opt/salon"
echo "  3. cd /opt/salon && make setup"
echo ""
echo "Добавьте бэкап в cron ($SALON_USER):"
echo "  15 3 * * * cd /opt/salon && ./ops/backup.sh >> /var/log/salon-backup.log 2>&1"
echo "════════════════════════════════════════════"
