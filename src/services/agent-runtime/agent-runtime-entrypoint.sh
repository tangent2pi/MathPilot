#!/bin/sh
set -eu

socket_dir=/var/run/mathpilot-db
socket_path="$socket_dir/.s.PGSQL.5432"
mkdir -p "$socket_dir"
chown nobody:nogroup "$socket_dir"
chmod 0750 "$socket_dir"

# Docker restart 会保留容器可写层；socat 退出后 Unix socket 路径可能仍在，
# 下一次启动若直接监听会报 "exists" 并让沙箱拿到一个无法连接的假 socket。
rm -f "$socket_path"

# Bash 沙箱保持无网络，只挂载这个 PostgreSQL 协议 Unix socket。socat 只转发
# postgres:5432，不提供通用网络出口；数据库端角色再执行最终权限约束。
setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs \
  socat "UNIX-LISTEN:$socket_path,fork,reuseaddr,mode=0660" TCP:postgres:5432 &
proxy_pid=$!
trap 'kill "$proxy_pid" 2>/dev/null || true; rm -f "$socket_path"' EXIT INT TERM

exec corepack pnpm --filter @mathpilot/agent-runtime run start
