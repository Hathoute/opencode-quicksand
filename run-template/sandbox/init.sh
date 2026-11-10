#!/usr/bin/env bash
set -euo pipefail

case "${SANDBOX_LIFECYCLE:-}" in
  create|update) ;;
  *)
    printf 'Unsupported sandbox lifecycle: %s\n' "${SANDBOX_LIFECYCLE:-unset}" >&2
    exit 1
    ;;
esac

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  openssh-server \
  openjdk-21-jdk \
  maven \
  nodejs \
  npm \
  nftables \
  podman \
  uidmap \
  slirp4netns \
  fuse-overlayfs \
  ripgrep

id podmanuser >/dev/null 2>&1 || useradd --create-home --shell /bin/bash podmanuser
grep -q '^podmanuser:' /etc/subuid || usermod --add-subuids 100000-165535 podmanuser
grep -q '^podmanuser:' /etc/subgid || usermod --add-subgids 100000-165535 podmanuser
podman_uid="$(id -u podmanuser)"
loginctl enable-linger podmanuser
cat > /etc/tmpfiles.d/podman-rootless.conf <<EOF
d /run/user/$podman_uid 0700 podmanuser podmanuser -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/podman-rootless.conf
cat > /etc/profile.d/podman-rootless.sh <<'EOF'
if [ "$(id -u)" -ne 0 ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
fi
EOF

mkdir -p /run/sshd /etc/ssh/sshd_config.d /root/.ssh
printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/99-demo.conf
echo 'root:root' | chpasswd
chmod 700 /root/.ssh
systemctl enable ssh
