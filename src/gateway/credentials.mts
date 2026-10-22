import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  JsonObject,
  ServiceConnection,
  TrustedCredentialHandle,
} from "../agents/contracts.mjs";
import { withStateLock } from "../orchestration/state-lock.mjs";
import { assertHttpEndpoint } from "./config.mjs";
import type {
  ExecutorConfiguration,
  GatewayConnections,
  GatewayCredentialVault,
} from "./config.mjs";
import { canonicalJson, jsonObject, Sanitizer, sha256 } from "./json.mjs";
import { atomicJson } from "./store.mjs";

/** Owns protocol coordination only. All credential persistence and CAS belongs to #89. */
export class GatewayCredentials {
  constructor(
    private readonly vault: GatewayCredentialVault,
    private readonly connections: GatewayConnections,
    private readonly privateDirectory: string,
  ) {}

  async use<T>(
    connection: ServiceConnection,
    config: ExecutorConfiguration,
    action: (
      handle: TrustedCredentialHandle | null,
      token: string | null,
      sanitizer: Sanitizer,
    ) => Promise<T>,
  ): Promise<T> {
    const sanitizer = new Sanitizer();
    if (connection.authentication.method === "none")
      return action(null, null, sanitizer);
    if (connection.authentication.method === "oauth")
      await this.refresh(connection, config);
    const current = await this.connections.get(connection.id);
    if (
      !current ||
      current.revision !== connection.revision ||
      current.projectId !== connection.projectId ||
      current.authentication.method !== connection.authentication.method ||
      canonicalJson(current.transport) !==
        canonicalJson(connection.transport) ||
      canonicalJson(current.identity) !== canonicalJson(connection.identity)
    )
      throw new Error("Connection changed during credential preparation.");
    return this.vault.withCredential(
      current.authentication.credentialRef,
      (handle) =>
        handle.use(async (material) => {
          const text = Buffer.from(material).toString("utf8");
          sanitizer.add(text);
          let token = text;
          if (current.authentication.method === "oauth") {
            const data = jsonObject(JSON.parse(text));
            for (const value of Object.values(data))
              if (typeof value === "string") sanitizer.add(value);
            if (typeof data.access_token !== "string" || !data.access_token)
              throw new Error("OAuth sign-in required.");
            token = data.access_token;
          }
          return action(handle, token, sanitizer);
        }),
    );
  }

  private async refresh(
    connection: ServiceConnection,
    config: ExecutorConfiguration,
  ): Promise<void> {
    const key = sha256(connection.id);
    return withStateLock(
      this.privateDirectory,
      `refresh-${key}.lock`,
      async () => {
        const current = await this.connections.get(connection.id);
        if (
          !current ||
          current.authentication.method !== "oauth" ||
          current.revision !== connection.revision ||
          canonicalJson(current) !== canonicalJson(connection)
        )
          throw new Error("OAuth connection changed.");
        const metadata = await this.vault.metadataForReference(
          current.authentication.credentialRef,
        );
        if (metadata.deleted)
          throw new Error("OAuth credential is unavailable.");
        const markerFile = join(this.privateDirectory, `refresh-${key}.json`);
        let marker: JsonObject | null = null;
        try {
          marker = jsonObject(JSON.parse(await readFile(markerFile, "utf8")));
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ))
            throw error;
        }
        // Refresh tokens may rotate even if the response was lost. Never blindly refresh again.
        if (
          marker?.revision === metadata.revision &&
          marker.state === "pending"
        )
          throw new Error(
            "OAuth refresh outcome is unknown; owner reauthentication is required.",
          );
        return this.vault.withCredential(
          current.authentication.credentialRef,
          (handle) =>
            handle.use(async (material) => {
              const saved = jsonObject(
                JSON.parse(Buffer.from(material).toString("utf8")),
              );
              if (
                typeof saved.access_token !== "string" ||
                typeof saved.expires_at !== "number"
              )
                throw new Error(
                  "OAuth credential requires an access token and expiry.",
                );
              if (saved.expires_at > Date.now() + 30_000) return;
              const oauth = config.oauth;
              if (!oauth || typeof saved.refresh_token !== "string")
                throw new Error("OAuth owner sign-in is required.");
              const url = assertHttpEndpoint(oauth.tokenEndpoint);
              assertHttpEndpoint(oauth.resource);
              const form = new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: saved.refresh_token,
                client_id: oauth.clientId,
                resource: oauth.resource,
              });
              if (oauth.clientAuthentication === "client_secret_post") {
                if (typeof saved.client_secret !== "string")
                  throw new Error(
                    "OAuth client authentication is unavailable.",
                  );
                form.set("client_secret", saved.client_secret);
              }
              await atomicJson(markerFile, {
                revision: metadata.revision,
                state: "pending",
              });
              const response = await fetch(url, {
                method: "POST",
                body: form,
                redirect: "error",
                signal: AbortSignal.timeout(Math.min(config.timeoutMs, 30_000)),
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Accept: "application/json",
                },
              });
              if (!response.ok)
                throw new Error(
                  "OAuth refresh failed; owner sign-in is required.",
                );
              const data = jsonObject(
                JSON.parse(await boundedResponse(response, 32 * 1024)),
              );
              if (
                typeof data.access_token !== "string" ||
                !data.access_token ||
                typeof data.expires_in !== "number" ||
                data.expires_in <= 0 ||
                (data.token_type !== undefined &&
                  String(data.token_type).toLowerCase() !== "bearer")
              )
                throw new Error(
                  "OAuth refresh returned unsupported token metadata.",
                );
              const replacement = Buffer.from(
                canonicalJson({
                  ...saved,
                  access_token: data.access_token,
                  refresh_token:
                    typeof data.refresh_token === "string"
                      ? data.refresh_token
                      : saved.refresh_token,
                  expires_at: Date.now() + data.expires_in * 1000,
                }),
              );
              try {
                const revision = await this.vault.withReplacement(
                  current.id,
                  replacement,
                  (handle) =>
                    this.vault.replace(current.id, metadata.revision, handle),
                );
                await atomicJson(markerFile, { revision, state: "saved" });
                return;
              } finally {
                replacement.fill(0);
              }
            }),
        );
      },
    );
  }
}

export async function boundedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) throw new Error("Empty upstream response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit)
        throw new Error("Upstream response exceeded the limit.");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}
