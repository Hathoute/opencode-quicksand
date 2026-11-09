#!/usr/bin/env bash
set -euo pipefail

if ! command -v sshd >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server
fi

mkdir -p /run/sshd /etc/ssh/sshd_config.d /root/.ssh
printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/99-demo.conf
echo 'root:root' | chpasswd
chmod 700 /root/.ssh
systemctl enable ssh
