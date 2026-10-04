import { createServer, type Server } from "node:https";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type TLSSocket } from "node:tls";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  constants,
  generateKeyPairSync,
  randomBytes,
  verify,
  X509Certificate,
} from "node:crypto";
import forge from "node-forge";
import type { AgentJobResult, AgentSnapshot } from "@qiyun/contracts";
import type { ControlStore } from "./store.js";

export interface GatewayOptions {
  dataDir?: string;
  host?: string;
  port?: number;
  hostnames?: string[];
}
interface TLSMaterial {
  ca: string;
  key: string;
  cert: string;
  caKey: string;
}
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function rsaKeys() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    key: pair.privateKey,
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
  };
}
function certificate(
  publicKey: forge.pki.rsa.PublicKey,
  name: string,
  days: number,
) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = `01${randomBytes(16).toString("hex")}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 86400000);
  cert.setSubject([{ name: "commonName", value: name }]);
  return cert;
}

export function ensureTLS(
  dataDir: string,
  hostnames: string[] = [],
): TLSMaterial {
  const dir = join(dataDir, "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = {
    ca: join(dir, "ca.pem"),
    caKey: join(dir, "ca-key.pem"),
    cert: join(dir, "server.pem"),
    key: join(dir, "server-key.pem"),
  };
  const existing = Object.values(paths).filter(existsSync);
  if (existing.length && existing.length !== 4)
    throw new Error(
      "TLS material is incomplete; restore the existing certificate set instead of silently replacing trust.",
    );
  if (existing.length === 4)
    return {
      ca: readFileSync(paths.ca, "utf8"),
      caKey: readFileSync(paths.caKey, "utf8"),
      cert: readFileSync(paths.cert, "utf8"),
      key: readFileSync(paths.key, "utf8"),
    };
  const caKeys = rsaKeys();
  const ca = certificate(caKeys.publicKey, "Qiyun private agent CA", 3650);
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
      critical: true,
      pathLenConstraint: 0,
    },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
  ]);
  ca.sign(forge.pki.privateKeyFromPem(caKeys.key), forge.md.sha256.create());
  const serverKeys = rsaKeys();
  const server = certificate(serverKeys.publicKey, "Qiyun agent gateway", 365);
  server.setIssuer(ca.subject.attributes);
  const names = [
    ...new Set(["localhost", "host.docker.internal", ...hostnames]),
  ];
  server.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 7, ip: "127.0.0.1" },
        { type: 7, ip: "::1" },
        ...names.map((name) =>
          /^\d+\.\d+\.\d+\.\d+$/.test(name)
            ? { type: 7, ip: name }
            : { type: 2, value: name },
        ),
      ],
    },
  ]);
  server.sign(
    forge.pki.privateKeyFromPem(caKeys.key),
    forge.md.sha256.create(),
  );
  const values = {
    ca: forge.pki.certificateToPem(ca),
    caKey: caKeys.key,
    cert: forge.pki.certificateToPem(server),
    key: serverKeys.key,
  };
  for (const field of Object.keys(paths) as (keyof typeof paths)[])
    writeFileSync(paths[field], values[field], {
      mode: field === "ca" || field === "cert" ? 0o644 : 0o600,
      flag: "wx",
    });
  return values;
}

class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
type VerifiedCsr = forge.pki.CertificateSigningRequest & {
  publicKey: forge.pki.rsa.PublicKey;
};
function isRsaPublicKey(
  key: forge.pki.PublicKey | null,
): key is forge.pki.rsa.PublicKey {
  return key !== null && !Buffer.isBuffer(key) && "n" in key && "e" in key;
}
export function parseAndVerifyCsr(pem: string): VerifiedCsr {
  const csr = forge.pki.certificationRequestFromPem(
    pem,
  ) as forge.pki.CertificateSigningRequest & {
    certificationRequestInfo: forge.asn1.Asn1;
  };
  // Do not use forge's RSA signature verifier: GHSA-86w9-cpqp-85rv.
  // Go's enrollment client produces SHA256-with-RSA, exponent 65537.
  const publicKey = csr.publicKey;
  if (
    !isRsaPublicKey(publicKey) ||
    csr.signatureOid !== "1.2.840.113549.1.1.11" ||
    publicKey.n.bitLength() < 2048 ||
    publicKey.e.toString(10) !== "65537" ||
    !csr.certificationRequestInfo
  )
    throw new Error("Unsupported CSR key or signature algorithm");
  const bytes = Buffer.from(
    forge.asn1.toDer(csr.certificationRequestInfo).getBytes(),
    "binary",
  );
  if (
    !verify(
      "sha256",
      bytes,
      {
        key: forge.pki.publicKeyToPem(publicKey),
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(csr.signature, "binary"),
    )
  )
    throw new Error("Invalid CSR signature");
  return Object.assign(csr, { publicKey });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new GatewayError(400, "Invalid object fields");
}
function str(value: unknown, max = 1000): value is string {
  return typeof value === "string" && value.length <= max;
}
function metric(value: unknown, max = 100): boolean {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= max)
  );
}
function timestamp(value: unknown): boolean {
  return str(value, 40) && Number.isFinite(Date.parse(value));
}

export function validateSnapshot(
  value: unknown,
  hostId: string,
): asserts value is AgentSnapshot {
  if (!record(value)) throw new GatewayError(400, "Invalid snapshot");
  keys(value, ["host", "services", "logs"]);
  const h = value.host;
  if (!record(h)) throw new GatewayError(400, "Invalid host");
  keys(h, [
    "id",
    "name",
    "address",
    "os",
    "arch",
    "status",
    "cpu",
    "memory",
    "disk",
    "uptime",
    "lastSeen",
    "labels",
    "history",
  ]);
  if (
    h.id !== hostId ||
    !["name", "address", "os", "arch"].every((key) => str(h[key], 200)) ||
    !["online", "offline"].includes(String(h.status)) ||
    !metric(h.cpu) ||
    !metric(h.memory) ||
    !metric(h.disk) ||
    !metric(h.uptime, 1e12) ||
    !timestamp(h.lastSeen) ||
    !Array.isArray(h.labels) ||
    h.labels.length > 20 ||
    !h.labels.every((label) => str(label, 80)) ||
    !Array.isArray(h.history) ||
    h.history.length > 120 ||
    !h.history.every((point) => typeof point === "number" && metric(point))
  )
    throw new GatewayError(400, "Invalid host metrics");
  if (
    !Array.isArray(value.services) ||
    value.services.length > 100 ||
    !record(value.logs)
  )
    throw new GatewayError(400, "Invalid services");
  const ids = new Set<string>();
  for (const s of value.services) {
    if (!record(s)) throw new GatewayError(400, "Invalid service");
    keys(
      s,
      [
        "id",
        "hostId",
        "name",
        "kind",
        "category",
        "status",
        "state",
        "cpu",
        "memory",
        "description",
        "updatedAt",
        "revision",
        "restartAllowed",
      ],
      ["image", "url", "port", "responseMs"],
    );
    if (
      !str(s.id, 160) ||
      !s.id.startsWith(`${hostId}:`) ||
      ids.has(s.id) ||
      s.hostId !== hostId ||
      !str(s.name, 200) ||
      !["docker", "systemd"].includes(String(s.kind)) ||
      !["website", "database", "application", "infrastructure"].includes(
        String(s.category),
      ) ||
      !["healthy", "warning", "critical", "unknown"].includes(
        String(s.status),
      ) ||
      !str(s.state, 200) ||
      !str(s.description, 1000) ||
      !str(s.revision, 200) ||
      !timestamp(s.updatedAt) ||
      typeof s.restartAllowed !== "boolean" ||
      !metric(s.cpu, 100000) ||
      !metric(s.memory, 1e15) ||
      ["image", "url", "port"].some(
        (key) => s[key] !== undefined && !str(s[key], 1000),
      ) ||
      (s.responseMs !== undefined && !metric(s.responseMs, 3600000))
    )
      throw new GatewayError(400, "Invalid service fields");
    ids.add(s.id);
  }
  for (const [id, lines] of Object.entries(value.logs)) {
    if (!ids.has(id) || !Array.isArray(lines) || lines.length > 100)
      throw new GatewayError(400, "Invalid log scope");
    for (const line of lines) {
      if (!record(line)) throw new GatewayError(400, "Invalid log");
      keys(line, ["timestamp", "level", "message"]);
      if (
        !timestamp(line.timestamp) ||
        !["info", "warn", "error"].includes(String(line.level)) ||
        !str(line.message, 4000)
      )
        throw new GatewayError(400, "Invalid log fields");
    }
  }
}
function validateResult(value: unknown): asserts value is AgentJobResult {
  if (!record(value)) throw new GatewayError(400, "Invalid job result");
  keys(value, ["jobId", "status", "detail"], ["revision"]);
  if (
    !str(value.jobId, 100) ||
    !["succeeded", "failed", "unknown"].includes(String(value.status)) ||
    !str(value.detail, 4000) ||
    (value.revision !== undefined && !str(value.revision, 200))
  )
    throw new GatewayError(400, "Invalid result fields");
}
async function jsonBody(
  request: IncomingMessage,
  limit = 1_000_000,
): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new GatewayError(415, "JSON required");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > limit) throw new GatewayError(413, "Request too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError(400, "Invalid JSON");
  }
}
function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export async function startGateway(
  store: ControlStore,
  options: GatewayOptions = {},
): Promise<{
  server: Server;
  caCertificate: string;
  close: () => Promise<void>;
}> {
  const material = ensureTLS(
    options.dataDir || process.env.QIYUN_DATA_DIR || ".local",
    options.hostnames ||
      (process.env.QIYUN_AGENT_HOSTNAMES || "").split(",").filter(Boolean),
  );
  const ca = forge.pki.certificateFromPem(material.ca);
  const caKey = forge.pki.privateKeyFromPem(material.caKey);
  const attempts = new Map<string, { count: number; reset: number }>();
  const server = createServer(
    {
      key: material.key,
      cert: material.cert,
      ca: material.ca,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    },
    (request, response) => {
      void (async () => {
        if (
          request.url === "/api/agent/register" &&
          request.method === "POST"
        ) {
          const address = request.socket.remoteAddress || "unknown";
          const previous = attempts.get(address);
          const counter =
            previous && previous.reset > Date.now()
              ? previous
              : { count: 0, reset: Date.now() + 60000 };
          counter.count++;
          attempts.set(address, counter);
          if (counter.count > 5)
            throw new GatewayError(429, "Too many enrollment requests");
          if (attempts.size > 1000)
            for (const [key, item] of attempts)
              if (item.reset < Date.now()) attempts.delete(key);
          const body = await jsonBody(request, 20000);
          if (!record(body)) throw new GatewayError(400, "Invalid enrollment");
          keys(body, ["token", "csr", "hostId"]);
          if (
            !str(body.token, 300) ||
            !str(body.csr, 16000) ||
            !str(body.hostId, 80) ||
            !idPattern.test(body.hostId)
          )
            throw new GatewayError(400, "Invalid enrollment fields");
          let csr: VerifiedCsr;
          try {
            csr = parseAndVerifyCsr(body.csr);
          } catch {
            throw new GatewayError(
              400,
              "A valid RSA 2048+ SHA256 CSR is required",
            );
          }
          const client = certificate(csr.publicKey, body.hostId, 90);
          client.setIssuer(ca.subject.attributes);
          client.setExtensions([
            { name: "basicConstraints", cA: false, critical: true },
            { name: "keyUsage", digitalSignature: true, critical: true },
            { name: "extKeyUsage", clientAuth: true },
          ]);
          client.sign(caKey, forge.md.sha256.create());
          const pem = forge.pki.certificateToPem(client);
          store.consumePairing(body.token, body.hostId);
          store.setSetting(
            `agent-fingerprint:${body.hostId}`,
            new X509Certificate(pem).fingerprint256,
          );
          send(response, 201, {
            certificate: pem,
            caCertificate: material.ca,
            signingPublicKey: store.signingPublicKey,
            hostId: body.hostId,
          });
          return;
        }
        const socket = request.socket as TLSSocket;
        const peer = socket.getPeerCertificate();
        const hostId = peer.subject?.CN;
        if (
          !socket.authorized ||
          typeof hostId !== "string" ||
          !idPattern.test(hostId) ||
          store.getSetting(`agent-fingerprint:${hostId}`) !==
            peer.fingerprint256
        )
          throw new GatewayError(
            401,
            "An enrolled client certificate is required",
          );
        if (
          request.url === "/api/agent/snapshot" &&
          request.method === "POST"
        ) {
          const body = await jsonBody(request);
          validateSnapshot(body, hostId);
          store.snapshot(hostId, body);
          send(response, 200, { accepted: true });
        } else if (
          request.url === "/api/agent/jobs" &&
          request.method === "GET"
        )
          send(response, 200, { jobs: store.jobs(hostId) });
        else if (
          request.url === "/api/agent/results" &&
          request.method === "POST"
        ) {
          const body = await jsonBody(request, 10000);
          validateResult(body);
          store.result(hostId, body);
          send(response, 200, { accepted: true });
        } else throw new GatewayError(404, "Unknown agent endpoint");
      })().catch((error: unknown) => {
        const status =
          error instanceof GatewayError
            ? error.status
            : typeof error === "object" &&
                error &&
                "statusCode" in error &&
                typeof error.statusCode === "number"
              ? error.statusCode
              : 500;
        send(response, status, {
          error:
            error instanceof GatewayError
              ? error.message
              : status < 500
                ? "Agent request rejected"
                : "Agent gateway failed to process the request",
        });
      });
    },
  );
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      options.port ?? Number(process.env.QIYUN_AGENT_PORT || 4311),
      options.host || process.env.QIYUN_AGENT_HOST || "127.0.0.1",
      () => {
        server.removeListener("error", reject);
        resolve();
      },
    );
  });
  return {
    server,
    caCertificate: material.ca,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
