#!/bin/sh
set -eu
mkdir -p /etc/qiyun /var/lib/qiyun-agent /var/lib/qiyun-helper /run/qiyun-helper
cp /fixture/agent.json /etc/qiyun/agent.json
cp /fixture/helper.json /etc/qiyun/helper.json
cp /fixture/ca.pem /var/lib/qiyun-agent/ca.pem
cp /fixture/token /var/lib/qiyun-agent/token
chown -R 65534:65534 /var/lib/qiyun-agent
chmod 700 /var/lib/qiyun-agent
chmod 600 /var/lib/qiyun-agent/token
chmod 644 /etc/qiyun/agent.json
chmod 600 /etc/qiyun/helper.json
su-exec 65534:65534 qiyun-agent enroll --config /etc/qiyun/agent.json --token-file /var/lib/qiyun-agent/token
rm /var/lib/qiyun-agent/token
cp /var/lib/qiyun-agent/signing-public.pem /etc/qiyun/signing-public.pem
chmod 644 /etc/qiyun/signing-public.pem
qiyun-agent helper --config /etc/qiyun/helper.json &
helper_pid=$!
trap 'kill "$helper_pid" 2>/dev/null || true' EXIT TERM INT
attempt=0
while [ ! -S /run/qiyun-helper/helper.sock ]; do
  attempt=$((attempt+1))
  [ "$attempt" -lt 30 ] || exit 1
  sleep 1
done
su-exec 65534:65534 qiyun-agent run --config /etc/qiyun/agent.json
