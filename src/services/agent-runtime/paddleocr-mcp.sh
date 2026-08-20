#!/bin/sh
set -eu

# PaddleOCR MCP 需要联网访问 AI Studio，但只应读取当前 Session 工作区。
# 与 Bash/Core 不同，这里保留容器网络；文件系统、PID、用户与环境仍隔离。
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
    --unshare-user --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup \
    --die-with-parent --new-session \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /opt/paddleocr-mcp /opt/paddleocr-mcp \
    --ro-bind /etc /etc \
    --proc /proc --dev /dev --tmpfs /tmp \
    --ro-bind "$workspace_root" /workspace \
    --bind "$workspace_root/output" /workspace/output \
    --bind "$workspace_root/tmp" /workspace/tmp \
    --chdir /workspace \
    --clearenv \
    --setenv HOME /workspace/tmp \
    --setenv PATH /opt/paddleocr-mcp/bin:/usr/bin:/bin \
    --setenv LANG C.UTF-8 \
    --setenv PADDLEOCR_MCP_MODEL "${PADDLEOCR_MCP_MODEL:-PaddleOCR-VL-1.6}" \
    --setenv PADDLEOCR_MCP_PPOCR_SOURCE "${PADDLEOCR_MCP_PPOCR_SOURCE:-aistudio}" \
    --setenv PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN "${PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN-}" \
    --setenv PADDLEOCR_MCP_AISTUDIO_BASE_URL "${PADDLEOCR_MCP_AISTUDIO_BASE_URL:-https://paddleocr.aistudio-app.com}" \
    --setenv PADDLEOCR_MCP_AISTUDIO_REQUEST_TIMEOUT "${PADDLEOCR_MCP_AISTUDIO_REQUEST_TIMEOUT:-120}" \
    --setenv PADDLEOCR_MCP_AISTUDIO_POLL_TIMEOUT "${PADDLEOCR_MCP_AISTUDIO_POLL_TIMEOUT:-600}" \
    /opt/paddleocr-mcp/bin/paddleocr_mcp
