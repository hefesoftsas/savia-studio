import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import https from "node:https";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  link,
  mkdtemp,
  open,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { assertAccountId, assertSafeR2Key } from "./naming.mjs";
import { RecoveryConsistencyError } from "./recovery-consistency.mjs";

const execFileAsync = promisify(execFile);
const TOKEN_VERIFY_TIMEOUT_MS = 30_000;
const TOKEN_ID = /^[a-f0-9]{32}$/i;
const STREAM_TIMEOUT_MS = 300_000;
const MAX_STREAM_TIMEOUT_MS = 600_000;

function assertBucket(bucket) {
  if (
    typeof bucket !== "string" ||
    bucket.trim() === "" ||
    bucket !== bucket.trim() ||
    bucket.includes("/")
  ) {
    throw new Error("bucket must be a non-empty R2 bucket name");
  }
  return bucket;
}

function assertToken(token) {
  if (
    typeof token !== "string" ||
    token.trim() === "" ||
    /[\r\n]/.test(token)
  ) {
    throw new Error("A valid Cloudflare API token is required");
  }
  return token;
}

function quoteEtag(etag) {
  if (typeof etag !== "string" || etag.length === 0 || /[\r\n]/.test(etag)) {
    throw new Error("A valid R2 inventory ETag is required");
  }
  const unquoted =
    etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
  if (unquoted.length === 0 || unquoted.includes('"')) {
    throw new Error("A valid R2 inventory ETag is required");
  }
  return `"${unquoted}"`;
}

async function verifyResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      "Cloudflare token verification returned an invalid response",
    );
  }
  return payload;
}

/** Resolve Cloudflare's documented R2 S3 credentials from an existing API token. */
export async function resolveR2S3Credentials({
  accountId,
  token,
  fetchImpl = fetch,
} = {}) {
  const validatedAccountId = assertAccountId(accountId);
  const validatedToken = assertToken(token);
  if (typeof fetchImpl !== "function")
    throw new Error("fetchImpl must be a function");

  const headers = { authorization: `Bearer ${validatedToken}` };
  const verify = async (url) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(TOKEN_VERIFY_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Cloudflare token verification failed");
    }
    return response;
  };

  const accountUrl = `https://api.cloudflare.com/client/v4/accounts/${validatedAccountId}/tokens/verify`;
  let response = await verify(accountUrl);
  if (response.status === 401 || response.status === 403) {
    response = await verify(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Cloudflare token verification failed (HTTP ${response.status})`,
    );
  }
  const payload = await verifyResponse(response);
  const result = payload?.success === true ? payload.result : undefined;
  if (
    result?.status !== "active" ||
    typeof result.id !== "string" ||
    !TOKEN_ID.test(result.id)
  ) {
    throw new Error(
      "Cloudflare token verification did not return an active token identity",
    );
  }
  return {
    accessKeyId: result.id,
    secretAccessKey: createHash("sha256")
      .update(validatedToken, "utf8")
      .digest("hex"),
  };
}

function isPreconditionFailure(error) {
  return (
    error?.statusCode === 412 ||
    error?.code === "PreconditionFailed" ||
    /(?:^|\D)412(?:\D|$)|PreconditionFailed/i.test(
      `${error?.stderr ?? ""} ${error?.message ?? ""}`,
    )
  );
}

function sourceChildEnv(parentEnv, credentials) {
  const env = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_PAGER: "",
  };
  if (typeof parentEnv.PATH === "string" && parentEnv.PATH !== "")
    env.PATH = parentEnv.PATH;
  if (typeof parentEnv.SYSTEMROOT === "string")
    env.SYSTEMROOT = parentEnv.SYSTEMROOT;
  return env;
}

/** Create an isolated, lazy S3 downloader; token verification is shared per capture. */
export function createR2S3Downloader({
  accountId,
  token,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  parentEnv = process.env,
  tempRoot = tmpdir(),
} = {}) {
  const validatedAccountId = assertAccountId(accountId);
  const validatedToken = assertToken(token);
  if (typeof execFileImpl !== "function")
    throw new Error("execFileImpl must be a function");
  let credentialsPromise;
  const credentials = () => {
    credentialsPromise ??= resolveR2S3Credentials({
      accountId: validatedAccountId,
      token: validatedToken,
      fetchImpl,
    });
    return credentialsPromise;
  };

  return async function downloadR2S3Object({
    bucket,
    key,
    destFile,
    expectedSize,
    expectedEtag,
  } = {}) {
    const safeBucket = assertBucket(bucket);
    const safeKey = assertSafeR2Key(key);
    const match = quoteEtag(expectedEtag);
    if (typeof destFile !== "string" || destFile.trim() === "") {
      throw new Error("destFile must be a non-empty path");
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new Error("expectedSize must be a non-negative safe integer");
    }

    const tempDir = await mkdtemp(join(tempRoot, "savia-r2-object-"));
    await chmod(tempDir, 0o700);
    const tempFile = join(tempDir, "object");
    const keyFile = join(tempDir, "key");
    let finalCreated = false;
    let finalHandle;
    try {
      const sourceCredentials = await credentials();
      await writeFile(keyFile, safeKey, { flag: "wx", mode: 0o600 });
      const args = [
        "s3api",
        "get-object",
        "--bucket",
        safeBucket,
        "--key",
        `file://${keyFile}`,
        "--if-match",
        match,
        tempFile,
        "--endpoint-url",
        `https://${validatedAccountId}.r2.cloudflarestorage.com`,
        "--cli-connect-timeout",
        "30",
        "--cli-read-timeout",
        "300",
        "--output",
        "json",
      ];
      let result;
      try {
        result = await execFileImpl("aws", args, {
          env: sourceChildEnv(parentEnv, sourceCredentials),
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        if (isPreconditionFailure(error)) {
          throw new RecoveryConsistencyError(
            "R2 object changed during backup; retry against a stable recovery boundary",
          );
        }
        throw new Error("R2 source object download failed");
      }

      let response;
      try {
        response = JSON.parse(result?.stdout ?? "");
      } catch {
        throw new Error("R2 source object download returned invalid metadata");
      }
      const returnedEtag =
        typeof response.ETag === "string" ? response.ETag : "";
      if (returnedEtag !== match) {
        throw new RecoveryConsistencyError(
          "R2 object ETag changed during backup",
        );
      }
      if (response.ContentLength !== expectedSize) {
        throw new RecoveryConsistencyError(
          "R2 object size changed during backup",
        );
      }
      const tempInfo = await stat(tempFile);
      if (!tempInfo.isFile() || tempInfo.size !== expectedSize) {
        throw new RecoveryConsistencyError(
          "R2 object bytes changed during backup",
        );
      }
      await chmod(tempFile, 0o600);

      finalHandle = await open(destFile, "wx", 0o600);
      finalCreated = true;
      for await (const chunk of createReadStream(tempFile)) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await finalHandle.write(chunk, offset);
          if (bytesWritten === 0) throw new Error("R2 object copy stalled");
          offset += bytesWritten;
        }
      }
      await finalHandle.close();
      finalHandle = undefined;
      const finalInfo = await stat(destFile);
      if (!finalInfo.isFile() || finalInfo.size !== expectedSize) {
        throw new RecoveryConsistencyError(
          "R2 object bytes changed during backup",
        );
      }
      await chmod(destFile, 0o600);
      return { bytesWritten: finalInfo.size, etag: returnedEtag };
    } catch (error) {
      if (finalHandle) await finalHandle.close().catch(() => {});
      if (finalCreated) await rm(destFile, { force: true }).catch(() => {});
      if (error instanceof RecoveryConsistencyError) throw error;
      if (
        /^R2 source object|^Cloudflare token verification|^A valid|^bucket |^expectedSize|^destFile/.test(
          error?.message ?? "",
        )
      ) {
        throw error;
      }
      throw new Error("R2 source object download failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function validateStreamTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_STREAM_TIMEOUT_MS
  )
    throw new Error(
      `timeoutMs must be an integer from 1 through ${MAX_STREAM_TIMEOUT_MS}`,
    );
}

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function streamSignedObject({
  signedRequest,
  requestImpl,
  agent,
  timeoutMs,
  expectedSize,
  expectedEtag,
  outputFile,
}) {
  const url = new URL(signedRequest.url);
  if (url.protocol !== "https:")
    throw new Error("R2 S3 request must use HTTPS");
  const headers = Object.fromEntries(signedRequest.headers.entries());
  const response = await new Promise((resolve, reject) => {
    let request;
    try {
      request = requestImpl(
        url,
        { method: signedRequest.method, headers, agent },
        resolve,
      );
      request.once("error", reject);
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error("R2 S3 object download timed out"));
      });
      request.end();
    } catch (error) {
      reject(error);
    }
  });

  if (response.statusCode === 412) {
    response.destroy();
    throw new RecoveryConsistencyError(
      "R2 object changed during backup; retry against a stable recovery boundary",
    );
  }
  if (response.statusCode !== 200) {
    const status = response.statusCode ?? "unknown";
    response.destroy();
    throw new Error(`R2 S3 object download failed (HTTP ${status})`);
  }
  if (response.headers.etag !== expectedEtag) {
    response.destroy();
    throw new RecoveryConsistencyError("R2 object ETag changed during backup");
  }
  const contentLength = response.headers["content-length"];
  if (
    typeof contentLength !== "string" ||
    !/^\d+$/.test(contentLength) ||
    Number(contentLength) !== expectedSize
  ) {
    response.destroy();
    throw new RecoveryConsistencyError("R2 object size changed during backup");
  }

  let received = 0;
  const counter = new Transform({
    transform(chunk, encoding, callback) {
      received += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding);
      if (received > expectedSize) {
        callback(
          new RecoveryConsistencyError("R2 object bytes changed during backup"),
        );
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (received !== expectedSize) {
        callback(
          new RecoveryConsistencyError("R2 object bytes changed during backup"),
        );
        return;
      }
      callback();
    },
  });
  await pipeline(
    response,
    counter,
    createWriteStream(outputFile, { flags: "wx", mode: 0o600 }),
  );
  return { bytesWritten: received };
}

/** Create a lazy, persistent, raw-streaming S3 downloader for Preview capture. */
export function createR2S3StreamDownloader({
  accountId,
  token,
  fetchImpl = fetch,
  requestImpl = https.request,
  agent,
  timeoutMs = STREAM_TIMEOUT_MS,
} = {}) {
  const validatedAccountId = assertAccountId(accountId);
  const validatedToken = assertToken(token);
  if (typeof fetchImpl !== "function")
    throw new Error("fetchImpl must be a function");
  if (typeof requestImpl !== "function")
    throw new Error("requestImpl must be a function");
  validateStreamTimeout(timeoutMs);

  const sharedAgent =
    agent ??
    new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 8 });
  if (!sharedAgent || typeof sharedAgent !== "object")
    throw new Error("agent must be an HTTPS Agent");

  let clientPromise;
  const client = () => {
    clientPromise ??= resolveR2S3Credentials({
      accountId: validatedAccountId,
      token: validatedToken,
      fetchImpl,
    }).then(async ({ accessKeyId, secretAccessKey }) => {
      const { AwsClient } = await import("aws4fetch");
      return new AwsClient({
        accessKeyId,
        secretAccessKey,
        service: "s3",
        region: "auto",
        retries: 0,
      });
    });
    return clientPromise;
  };

  return async function downloadR2S3ObjectStream({
    bucket,
    key,
    destFile,
    expectedSize,
    expectedEtag,
  } = {}) {
    const safeBucket = assertBucket(bucket);
    const safeKey = assertSafeR2Key(key);
    const match = quoteEtag(expectedEtag);
    if (typeof destFile !== "string" || destFile.trim() === "")
      throw new Error("destFile must be a non-empty path");
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
      throw new Error("expectedSize must be a non-negative safe integer");
    const aws = await client();

    let tempDir;
    let finalCreated = false;
    try {
      tempDir = await mkdtemp(join(dirname(destFile), ".savia-r2-stream-"));
      await chmod(tempDir, 0o700);
      const tempFile = join(tempDir, "object");
      const objectPath = [safeBucket, ...safeKey.split("/")]
        .map(encodePathSegment)
        .join("/");
      const requestUrl = `https://${validatedAccountId}.r2.cloudflarestorage.com/${objectPath}`;
      const signedRequest = await aws.sign(requestUrl, {
        method: "GET",
        headers: {
          "Accept-Encoding": "identity",
          "If-Match": match,
        },
        aws: { allHeaders: true },
      });
      await streamSignedObject({
        signedRequest,
        requestImpl,
        agent: sharedAgent,
        timeoutMs,
        expectedSize,
        expectedEtag: match,
        outputFile: tempFile,
      });
      await link(tempFile, destFile);
      finalCreated = true;
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
      return { bytesWritten: expectedSize, etag: match };
    } catch (error) {
      if (finalCreated) await rm(destFile, { force: true }).catch(() => {});
      if (tempDir)
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof RecoveryConsistencyError) throw error;
      if (error?.message === "R2 S3 object download timed out")
        throw new Error("R2 S3 object download timed out");
      if (
        /^R2 S3 object download failed \(HTTP \d+\)$/.test(error?.message ?? "")
      )
        throw error;
      throw new Error("R2 S3 object download failed");
    }
  };
}
