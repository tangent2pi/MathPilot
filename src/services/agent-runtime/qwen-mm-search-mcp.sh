#!/bin/sh
set -eu

# Search 保留外网，但不挂载 Session 工作区。它只获得搜索供应商凭据；模型密钥、
# OCR 密钥和服务环境均被清空。工作区发现与检索继续由 Bubblewrap 内的 Bash 完成。
exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs \
  /usr/bin/bwrap \
    --unshare-user --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup \
    --die-with-parent --new-session \
    --ro-bind /usr /usr \
    --ro-bind /bin /bin \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /opt/qwen-mm /opt/qwen-mm \
    --ro-bind /etc /etc \
    --proc /proc --dev /dev --tmpfs /tmp \
    --chdir /tmp \
    --clearenv \
    --setenv HOME /tmp \
    --setenv PATH /opt/qwen-mm/bin:/usr/bin:/bin \
    --setenv LANG C.UTF-8 \
    --setenv SERPER_API_KEY "${SERPER_API_KEY-}" \
    --setenv TAVILY_API_KEY "${TAVILY_API_KEY-}" \
    --setenv EXA_API_KEY "${EXA_API_KEY-}" \
    --setenv QWEN_MM_SEARCH_BACKEND "${QWEN_MM_SEARCH_BACKEND-auto}" \
    /opt/qwen-mm/bin/qwen-mm-plugins-search
