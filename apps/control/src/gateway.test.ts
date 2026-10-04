import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:https";
import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { ControlStore } from "./store.js";
import {
  parseAndVerifyCsr,
  startGateway,
  validateSnapshot,
} from "./gateway.js";

test("gateway enrolls once, authenticates mTLS and binds host identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qiyun-gateway-"));
  const store = new ControlStore(":memory:");
  const gateway = await startGateway(store, { dataDir: dir, port: 0 });
  const address = gateway.server.address();
  assert.ok(address && typeof address === "object");
  const keypair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(keypair.publicKey);
  csr.setSubject([{ name: "commonName", value: "test-host" }]);
  csr.sign(
    forge.pki.privateKeyFromPem(keypair.privateKey),
    forge.md.sha256.create(),
  );
  assert.doesNotThrow(() =>
    parseAndVerifyCsr(forge.pki.certificationRequestToPem(csr)),
  );
  const originalSignature = csr.signature;
  csr.signature =
    String.fromCharCode(csr.signature.charCodeAt(0) ^ 1) +
    csr.signature.slice(1);
  assert.throws(
    () => parseAndVerifyCsr(forge.pki.certificationRequestToPem(csr)),
    /Invalid CSR signature/,
  );
  csr.signature = originalSignature;
  const call = (path: string, body?: unknown, cert?: string) =>
    new Promise<{ status: number; value: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method: body === undefined ? "GET" : "POST",
            ca: gateway.caCertificate,
            ...(cert ? { cert, key: keypair.privateKey } : {}),
            headers:
              body === undefined ? {} : { "Content-Type": "application/json" },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode || 0,
                value: JSON.parse(text) as Record<string, unknown>,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      },
    );
  try {
    assert.equal((await call("/api/agent/jobs")).status, 401);
    const pairing = store.createPairing();
    const body = {
      token: pairing.token,
      hostId: "test-host",
      csr: forge.pki.certificationRequestToPem(csr),
    };
    const enrollment = await call("/api/agent/register", body);
    assert.equal(enrollment.status, 201);
    assert.equal(typeof enrollment.value.certificate, "string");
    assert.equal((await call("/api/agent/register", body)).status, 403);
    const cert = enrollment.value.certificate as string;
    assert.deepEqual((await call("/api/agent/jobs", undefined, cert)).value, {
      jobs: [],
    });
    const snapshot = {
      host: {
        id: "other-host",
        name: "test",
        address: "",
        os: "Linux",
        arch: "amd64",
        status: "online",
        cpu: 1,
        memory: 20,
        disk: 10,
        uptime: 10,
        lastSeen: new Date().toISOString(),
        labels: [],
        history: [],
      },
      services: [],
      logs: {},
    };
    assert.equal(
      (await call("/api/agent/snapshot", snapshot, cert)).status,
      400,
    );
    snapshot.host.id = "test-host";
    assert.equal(
      (await call("/api/agent/snapshot", snapshot, cert)).status,
      200,
    );
    assert.equal(store.inventory("live").hosts.length, 1);
    store.setSetting("agent-fingerprint:test-host", "revoked");
    assert.equal((await call("/api/agent/jobs", undefined, cert)).status, 401);
  } finally {
    await gateway.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot validates bounded metrics and unexpected fields", () => {
  assert.throws(() =>
    validateSnapshot(
      { host: {}, services: [], logs: {}, exec: "anything" },
      "h",
    ),
  );
  assert.throws(() =>
    validateSnapshot({ host: { id: "h" }, services: [], logs: {} }, "h"),
  );
});
