#!/bin/sh
set -eu

# Core 是本地文件 MCP，但上游工具接受绝对路径。每次任务将它放进独立
# Bubblewrap：只能看到当前工作区，输入只读，output/tmp 可写，无网络。
workspace_input=${1:-}
workspace_root=$(realpath -e "$workspace_input")
configured_root=$(realpath -e "${WORKSPACE_ROOT:-/var/lib/agmath/workspaces}")
case "$workspace_root/" in
  "$configured_root"/*/) ;;
  *) echo "workspace escapes configured root" >&2; exit 64 ;;
esac
test -d "$workspace_root/input" -a -d "$workspace_root/output" -a -d "$workspace_root/tmp"

exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs \
  /usr/bin/bwrap \
    --unshare-all --die-with-parent --new-session \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /opt/qwen-mm /opt/qwen-mm \
    --ro-bind /etc /etc \
    --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$workspace_root" /workspace \
    --bind "$workspace_root/output" /workspace/output \
    --bind "$workspace_root/tmp" /workspace/tmp \
    --chdir /workspace \
    --clearenv \
    --setenv HOME /workspace/tmp \
    --setenv PATH /opt/qwen-mm/bin:/usr/bin:/bin \
    --setenv LANG C.UTF-8 \
    /opt/qwen-mm/bin/qwen-mm-plugins-core
