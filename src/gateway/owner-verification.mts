import { gmailOAuthBundle, gmailRequest } from "./gmail.mjs";
import type {
  ServiceCapability,
  ServiceConnection,
} from "../agents/contracts.mjs";
import type { GatewayConnections, GatewayCredentialVault } from "./config.mjs";
import { boundedResponse } from "./credentials.mjs";
import { capabilityId } from "./executor.mjs";
import { canonicalJson, jsonObject, Sanitizer } from "./json.mjs";
import type {
  GatewayOwnerIdentityProvider,
  TrustedGatewayRegistry,
} from "./registry.mjs";

export interface GatewayVerificationCredential {
  credentialRef: string;
  revision: number;
}
export type GatewayIdentityObservation =
  | { state: "verified"; value: ServiceConnection["identity"] }
  | { state: "unavailable"; reason: string };
export type GatewayCapabilitiesObservation =
  | { state: "verified"; values: ServiceCapability[] }
  | { state: "unavailable"; reason: string };
export interface GatewayOwnerVerification {
  state: "verified" | "unavailable" | "cancelled";
  identity: GatewayIdentityObservation;
  capabilities: GatewayCapabilitiesObservation;
  checkedAt: string;
  credential: GatewayVerificationCredential;
  reason: string | null;
}

/** Owner setup only. The host may supply an isolated, vaulted draft connection.
 * This class cannot save connections, assign agents or grant operation access.
 * A verified account is not evidence of its intended personal/dedicated use or
 * of authorization for any particular repository, team or future operation. */
export class GatewayOwnerConnectionVerifier {
  constructor(
    private readonly options: {
      vault: GatewayCredentialVault;
      connections: GatewayConnections;
      registry: TrustedGatewayRegistry;
      prepareCredential?(
        connection: ServiceConnection,
        expectedRevision: number,
      ): Promise<number>;
      discoverCapabilities(
        connection: ServiceConnection,
        options: { signal: AbortSignal },
      ): Promise<ServiceCapability[]>;
    },
  ) {}

  async verify(
    connection: ServiceConnection,
    expectedCredential: GatewayVerificationCredential,
    options: { signal?: AbortSignal } = {},
  ): Promise<GatewayOwnerVerification> {
    connection = structuredClone(connection);
    expectedCredential = structuredClone(expectedCredential);
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(30_000),
    ]);
    const unavailable = (reason: string): GatewayOwnerVerification => ({
      state: options.signal?.aborted ? "cancelled" : "unavailable",
      identity: { state: "unavailable", reason },
      capabilities: { state: "unavailable", reason },
      checkedAt: new Date().toISOString(),
      credential: expectedCredential,
      reason,
    });
    try {
      signal.throwIfAborted();
      if (
        (connection.authentication.method !== "token" &&
          connection.authentication.method !== "oauth") ||
        connection.authentication.credentialRef !==
          expectedCredential.credentialRef ||
        !Number.isSafeInteger(expectedCredential.revision) ||
        expectedCredential.revision < 1
      )
        throw new Error("Unsupported verification credential.");
      const provider = this.options.registry.ownerIdentity(connection);
      if (!provider)
        return unavailable(
          "Identity verification is unavailable for this connection.",
        );
      if (
        connection.authentication.method === "oauth" &&
        this.options.prepareCredential
      )
        expectedCredential = {
          ...expectedCredential,
          revision: await this.options.prepareCredential(
            connection,
            expectedCredential.revision,
          ),
        };
      await this.assertCurrent(connection, expectedCredential);
      return await this.options.vault.withCredential(
        expectedCredential.credentialRef,
        async (handle) => {
          const sanitizer = new Sanitizer();
          let identity: GatewayIdentityObservation;
          try {
            identity = await handle.use(async (material) => {
              signal.throwIfAborted();
              let token = new TextDecoder("utf-8", { fatal: true }).decode(
                material,
              );
              if (connection.authentication.method === "oauth") {
                if (provider !== "gmail-oauth-token")
                  throw new Error("Unsupported owner OAuth bundle.");
                const bundle = gmailOAuthBundle(token);
                for (const value of Object.values(bundle))
                  if (typeof value === "string") sanitizer.add(value);
                token = bundle.access_token as string;
              }
              if (
                !token ||
                token.length > 16_384 ||
                /[\s\u0000-\u001f\u007f]/u.test(token)
              )
                throw new Error("Unsupported token material.");
              sanitizer.add(token);
              return {
                state: "verified",
                value: await this.identity(provider, token, sanitizer, signal),
              };
            });
          } catch {
            identity = {
              state: "unavailable",
              reason:
                "The provider account could not be verified with this credential.",
            };
          }
          signal.throwIfAborted();
          let capabilities: GatewayCapabilitiesObservation;
          try {
            const values = await this.options.discoverCapabilities(connection, {
              signal,
            });
            if (values.length > 500)
              throw new Error("Capability limit exceeded.");
            let bytes = 0;
            const ids = new Set<string>();
            const safe = values.map((value) => {
              const clean = jsonObject(sanitizer.value(value));
              bytes += Buffer.byteLength(canonicalJson(clean));
              if (
                clean.connectionId !== connection.id ||
                typeof clean.upstreamName !== "string" ||
                !clean.upstreamName ||
                clean.upstreamName.length > 256 ||
                typeof clean.description !== "string" ||
                !clean.inputSchema ||
                typeof clean.inputSchema !== "object" ||
                Array.isArray(clean.inputSchema) ||
                clean.inputSchema.type !== "object" ||
                !["read_only", "unsupported"].includes(
                  String(clean.verification),
                ) ||
                clean.id !== capabilityId(connection.id, clean.upstreamName) ||
                ids.has(String(clean.id)) ||
                bytes > 2 * 1024 * 1024
              )
                throw new Error("Invalid capability discovery.");
              ids.add(String(clean.id));
              clean.description = clean.description
                .slice(0, 4096)
                .replace(/[\uD800-\uDBFF]$/u, "");
              return clean as unknown as ServiceCapability;
            });
            capabilities = { state: "verified", values: safe };
          } catch {
            capabilities = {
              state: "unavailable",
              reason:
                "The provider capability catalogue could not be verified.",
            };
          }
          await this.assertCurrent(connection, expectedCredential);
          // Reborrow under the vault's mutation lock before publishing evidence.
          // The host must still compare these exact revisions when saving later.
          return handle.use(async () => {
            signal.throwIfAborted();
            const verified =
              identity.state === "verified" &&
              capabilities.state === "verified";
            return {
              state: verified ? "verified" : "unavailable",
              identity,
              capabilities,
              checkedAt: new Date().toISOString(),
              credential: expectedCredential,
              reason: verified
                ? null
                : "Account and capability verification must both succeed before saving.",
            } as GatewayOwnerVerification;
          });
        },
      );
    } catch {
      return unavailable(
        options.signal?.aborted
          ? "Connection verification was cancelled."
          : signal.aborted
            ? "Connection verification timed out."
            : "The connection or credential changed, or verification is unavailable.",
      );
    }
  }

  private async assertCurrent(
    expected: ServiceConnection,
    credential: GatewayVerificationCredential,
  ): Promise<void> {
    const current = await this.options.connections.get(expected.id);
    if (!current || canonicalJson(current) !== canonicalJson(expected))
      throw new Error("Connection changed during verification.");
    const metadata = await this.options.vault.metadataForReference(
      credential.credentialRef,
    );
    if (
      metadata.deleted ||
      metadata.credentialRef !== credential.credentialRef ||
      metadata.revision !== credential.revision
    )
      throw new Error("Credential changed during verification.");
  }

  private async identity(
    provider: GatewayOwnerIdentityProvider,
    token: string,
    sanitizer: Sanitizer,
    signal: AbortSignal,
  ): Promise<ServiceConnection["identity"]> {
    if (provider === "gmail-oauth-token") {
      const profile = await gmailRequest(token, "gmail_profile", {}, signal);
      if (
        typeof profile.emailAddress !== "string" ||
        !profile.emailAddress.includes("@") ||
        profile.emailAddress.length > 256 ||
        sanitizer.text(profile.emailAddress) !== profile.emailAddress
      )
        throw new Error("Gmail mailbox identity unavailable.");
      return {
        displayName: profile.emailAddress,
        emailAddress: profile.emailAddress,
        externalAccountId: profile.emailAddress,
      };
    }
    const github = provider === "github-pat";
    const response = await fetch(
      github ? "https://api.github.com/user" : "https://api.linear.app/graphql",
      {
        method: github ? "GET" : "POST",
        headers: github
          ? {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2026-03-10",
              "User-Agent": "crew-service-gateway",
            }
          : {
              Authorization: token,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
        ...(github
          ? {}
          : {
              body: JSON.stringify({
                query:
                  "query CrewConnectionIdentity { viewer { id name email } }",
              }),
            }),
        redirect: "error",
        signal,
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Identity request failed.");
    }
    const data = jsonObject(
      JSON.parse(await boundedResponse(response, 64 * 1024)),
    );
    const text = (value: unknown, limit: number): string => {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        value.length > limit ||
        /[\u0000-\u001f\u007f]/u.test(value) ||
        sanitizer.text(value) !== value
      )
        throw new Error("Invalid provider identity.");
      return value;
    };
    const email = (value: unknown): string | null =>
      value === null || value === undefined ? null : text(value, 256);
    if (github) {
      if (
        typeof data.id !== "number" ||
        !Number.isSafeInteger(data.id) ||
        data.id < 1
      )
        throw new Error("Invalid provider identity.");
      const login = text(data.login, 256);
      return {
        displayName: text(
          data.name ? `${text(data.name, 256)} (@${login})` : `@${login}`,
          256,
        ),
        externalAccountId: String(data.id),
        emailAddress: email(data.email),
      };
    }
    if (
      data.errors !== undefined &&
      (!Array.isArray(data.errors) || data.errors.length > 0)
    )
      throw new Error("Linear account query failed.");
    const viewer = jsonObject(jsonObject(data.data).viewer);
    return {
      displayName: text(viewer.name, 256),
      externalAccountId: text(viewer.id, 256),
      emailAddress: email(viewer.email),
    };
  }
}
