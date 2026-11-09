#!/usr/bin/env bash
set -euo pipefail

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  openssh-server \
  openjdk-21-jdk \
  maven \
  nodejs \
  npm \
  nftables \
  ripgrep

mkdir -p /run/sshd /etc/ssh/sshd_config.d /root/.ssh
printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/99-demo.conf
echo 'root:root' | chpasswd
chmod 700 /root/.ssh
systemctl enable ssh
