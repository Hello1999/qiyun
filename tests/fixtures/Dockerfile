FROM postgres:16-alpine
COPY qiyun-agent-linux-amd64 /usr/local/bin/qiyun-agent
COPY agent-entrypoint.sh /usr/local/bin/qiyun-fixture-start
RUN chmod 755 /usr/local/bin/qiyun-agent /usr/local/bin/qiyun-fixture-start
ENTRYPOINT ["/usr/local/bin/qiyun-fixture-start"]
