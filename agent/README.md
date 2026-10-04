# Qiyun Linux Agent

Go standard-library implementation, with no shell execution endpoint or third-party Go modules. Build from this directory: `go build ./cmd/qiyun-agent`; tests: `go test ./...`. Production target is Linux; the other-platform stubs exist for development unit tests and do not offer privileged execution.

## Process and permission boundary

Run `qiyun-agent run --config /etc/qiyun/agent.json` as an ordinary dedicated user. It reads `/proc`, root-filesystem disk usage, and connects outbound to the HTTPS control gateway using its enrolled client certificate. CPU is a percentage between consecutive samples (first sample is `null`); memory and disk are percentages. Service CPU/memory are currently `null`, not fabricated zeroes. History is empty until the control plane accumulates it.

The optional root helper is a separate process: `qiyun-agent helper --config /etc/qiyun/helper.json`. It alone opens the Docker socket and runs fixed `/usr/bin/systemctl` and `/usr/bin/journalctl` argument lists. The Docker socket is effectively host-root authority; an HTTP read method does not make socket possession low privilege. Never grant the Agent Docker group membership or mount that socket into the control plane.

The helper requires root-owned configuration, signing public key, state directory and non-writable ancestor paths, and rejects symlinks on those paths. It verifies Unix `SO_PEERCRED` against the configured nonzero Agent UID, plus socket filesystem permissions. Assign `agentUid` and `agentGid` from the actual dedicated account; the example numbers are placeholders. The Agent must not be able to replace the helper binary, its config, signing key, state or socket directory. Install the executable root-owned and non-writable by that account.

Examples and systemd templates are in `../deploy/agent/`. There is no published installer URL yet. Templates require an administrator to create the account, install the binary/configuration, provide a trusted CA and enroll before starting the services. Ensure `/etc/qiyun` is root-owned mode 0755, helper config/key are root-owned mode 0600, and the Agent's own state directory is owned by its dedicated user mode 0700. The helper's socket directory is root-owned and group-readable/traversable by the Agent's group. The helper template intentionally retains root privilege for the two registered backends; its policy is a scope boundary, not a general sandbox against a compromised helper or control-plane signing authority.

## Enrollment and initial trust

Both `enrollmentUrl` and `controlUrl` are HTTPS **base URLs**, normally the same gateway on port 4311. For a Docker test host, use `https://host.docker.internal:4311` only when that name is present in the trusted gateway certificate. An administrator must deliver the initial CA to `caFile` through a trusted channel; no insecure TLS mode exists. The gateway's registration route accepts a short-lived pairing token; all other Agent routes require mTLS.

Run `qiyun-agent enroll --config /etc/qiyun/agent.json --token-file /secure/path/pairing-token`. Omit `--token-file` to read one line from stdin. Interactive input is not terminal-echo suppressed, so a protected token file or piped stdin is preferred on shared consoles. The token value is never accepted as a CLI argument, logged, or saved by the Agent; the administrator removes its source file after pairing. Enrollment generates a local RSA-2048 private key and CSR, validates the returned certificate against its key/host identity, then stores the certificate, CA and Ed25519 signing public key. An existing certificate is never silently replaced. Identity rotation/revocation workflow is not implemented here.

The helper uses a **separate root-protected** signing public key. After enrollment, the administrator verifies and installs the Agent's received public key at the helper key path. The helper never trusts a key file writable by the Agent. Changes require administrator action and helper restart. This prevents a compromised Agent from substituting its own signing authority.

## Read scope and restart authorization

With no helper configured, `collect`/`run` can read host metrics and explicitly registered systemd services under the ordinary user's existing read permissions. Docker collection is disabled, and restarts are rejected. `qiyun-agent collect --config ...` prints one snapshot for diagnostics without contacting the control plane.

Helper Docker reads include only explicitly configured `dockerContainers`, plus `qiyun.managed=true` containers if `discoverManaged` is enabled. Discovery never grants restart permission. Docker restart names must be independently listed in `dockerRestartAllowlist` **and** `dockerContainers`. Systemd reads require `systemdUnits`; restarting also requires `systemdRestartAllowlist`. Both restart lists default empty. At most 100 services are reported. Missing permissions/services appear unavailable for explicit targets; helper transport failure withholds the whole snapshot so a transient failure does not erase known services.

Service IDs are `hostId:docker:containerName` and `hostId:systemd:unit.service`. Revisions hash stable identity/start/state fields, never sampling time. Docker restart targets the inspected immutable container ID. The helper accepts only a base64 JSON payload signed over its original bytes with Ed25519; it validates signature, exact fields, host, action, expiry, local allowlist and expected revision. Restart completion is followed by observed healthy state and a changed revision. Health is Docker's declared health status/running state or systemd's active state; this is not an application HTTP availability test. External administrator changes can race backend checks; these APIs do not provide transactional compare-and-restart semantics.

## Receipts and recovery

The helper serializes writes, and holds an OS process lock on its state directory. Before a side effect it writes and fsyncs a `running` receipt, then fsyncs its parent directory. Final results are stored similarly. Repeated signed jobs return the existing result; the same ID with another payload is rejected. After a helper crash, incomplete receipts become `unknown`; they never cause blind restart repetition. Corrupt receipts fail closed. A backend timeout or lost response is `unknown`, because a restart might have occurred. Reconcile real state and create a new approved task when necessary; never delete receipts as a retry mechanism.

The network Agent durably stores received jobs and an outbox result. Lost result acknowledgements are retransmitted without re-running the completed action. If it disconnects while the helper executes, it asks the helper again with the same signed job and obtains the durable receipt. The gateway owns the interval between claiming a task and the Agent persisting it. This is at-least-once delivery with deduplication, not a claim of exactly-once side effects.

Logs are bounded to the last 100 lines per registered service and about 2,000 bytes per line, with common credential patterns, URL passwords and PEM blocks removed. Redaction is best effort, not proof that arbitrary application logs contain no secrets; administrators should register only appropriate services and review retention/external-model policies. Raw backend error bodies and command stderr are not forwarded. Backend read failures produce an explicitly labeled Qiyun collection warning; unsupported or oversized individual log lines may be omitted.

## Current limitations

No arbitrary commands, configuration deployment, Compose updates, scheduling, data rollback, certificate rotation, application probe or service resource accounting. Read collection is sequential and deadline bounded; large/slow registered sets can exceed the intended sampling interval. Durable receipt retention is currently manual and must preserve IDs for the full control-plane replay horizon. Integration tests must target isolated fixtures, never existing user containers.
