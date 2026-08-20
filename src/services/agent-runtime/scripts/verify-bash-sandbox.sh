#!/bin/sh
set -eu

smoke_root=$(mktemp -d /tmp/agmath-sandbox-smoke.XXXXXX)
trap 'rm -rf "$smoke_root"' EXIT INT TERM
chmod 0711 "$smoke_root"

install -d -m 0500 -o 65534 -g 65534 "$smoke_root/workspace"
install -d -m 0500 -o 65534 -g 65534 "$smoke_root/workspace/input"
install -d -m 0700 -o 65534 -g 65534 "$smoke_root/workspace/output" "$smoke_root/workspace/tmp"
printf 'needle\n' > "$smoke_root/workspace/input/data.txt"
chown 65534:65534 "$smoke_root/workspace/input/data.txt"
chmod 0400 "$smoke_root/workspace/input/data.txt"

setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs \
  /usr/bin/bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr \
  --ro-bind /bin /bin \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /etc/alternatives /etc/alternatives \
  --proc /proc --dev /dev --tmpfs /tmp \
  --ro-bind "$smoke_root/workspace" /workspace \
  --bind "$smoke_root/workspace/output" /workspace/output \
  --bind "$smoke_root/workspace/tmp" /workspace/tmp \
  --chdir /workspace \
  --clearenv \
  --setenv HOME /workspace/tmp \
  --setenv PATH /usr/bin:/bin \
  --setenv LANG C.UTF-8 \
  /bin/sh -lc '
    set -eu
    test "$(id -u)" = 65534
    test "$(env | wc -l)" -eq 4
    env | awk -F= "\$1 != \"HOME\" && \$1 != \"LANG\" && \$1 != \"PATH\" && \$1 != \"PWD\" { exit 1 }"
    test ! -e /app
    test ! -e /var/lib/agmath
    rg -q needle /workspace/input/data.txt
    ! touch /workspace/input/denied 2>/dev/null
    printf ok > /workspace/output/result.txt
    test "$(sed -n "3,$ p" /proc/net/dev | cut -d: -f1 | tr -d " ")" = lo
    ! tr "\0" "\n" < /proc/1/environ | rg -q sentinel-never-visible
    printf "sandbox_ok\n"
  '
