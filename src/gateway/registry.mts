import type { ServiceConnection } from "../agents/contracts.mjs";
import type {
  ExecutorConfiguration,
  ResolveExecutorConfiguration,
} from "./config.mjs";
import { assertHttpEndpoint, configurationReference } from "./config.mjs";
import { canonicalJson } from "./json.mjs";

export interface GatewaySetupChoice {
  id: string;
  label: string;
  service: string;
  transport: ServiceConnection["transport"];
  authenticationMethods: ServiceConnection["authentication"]["method"][];
  guide?: {
    credentialLabel: string;
    credentialUrl: string;
    documentationUrl: string;
    accountOwnership: { personal: string; dedicated: string };
    steps: string[];
  };
}
export type GatewayOwnerIdentityProvider =
  "linear-api-key" | "github-pat" | "gmail-oauth-token";
export interface TrustedGatewayRegistration {
  choice: GatewaySetupChoice;
  configuration: ExecutorConfiguration;
  ownerIdentity?: GatewayOwnerIdentityProvider;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function copyConfiguration(
  value: ExecutorConfiguration,
): ExecutorConfiguration {
  if (value.type === "mcp")
    return freeze({ ...value, oauth: value.oauth && { ...value.oauth } });
  return freeze({
    ...value,
    oauth: value.oauth && { ...value.oauth },
    environment: { ...value.environment },
    operations: value.operations.map((operation) => ({
      ...operation,
      inputSchema: structuredClone(operation.inputSchema),
    })),
  });
}

/** Trusted host-code registrations only. There is deliberately no JSON/API method
 * for installing arbitrary commands, config paths, OAuth issuers or endpoints. */
export class TrustedGatewayRegistry {
  private readonly entries = new Map<string, TrustedGatewayRegistration>();
  constructor(registrations: readonly TrustedGatewayRegistration[]) {
    if (registrations.length > 32)
      throw new Error("Too many gateway adapters.");
    const references = new Set<string>();
    for (const registration of registrations) {
      const choice = structuredClone(registration.choice);
      const configuration = copyConfiguration(registration.configuration);
      const reference =
        choice.transport.type === "mcp"
          ? choice.transport.serverConfigRef
          : choice.transport.executorConfigRef;
      if (
        !/^[a-z][a-z0-9._-]{0,79}$/.test(choice.id) ||
        !reference ||
        this.entries.has(choice.id) ||
        references.has(reference) ||
        choice.transport.type !== configuration.type ||
        !Number.isSafeInteger(configuration.timeoutMs) ||
        configuration.timeoutMs < 1 ||
        configuration.timeoutMs > 120_000 ||
        choice.authenticationMethods.length === 0 ||
        new Set(choice.authenticationMethods).size !==
          choice.authenticationMethods.length
      )
        throw new Error("Invalid trusted gateway registration.");
      if (configuration.type === "mcp")
        assertHttpEndpoint(configuration.url, configuration.allowLoopbackHttp);
      references.add(reference);
      if (
        registration.ownerIdentity !== undefined &&
        !["linear-api-key", "github-pat", "gmail-oauth-token"].includes(
          registration.ownerIdentity,
        )
      )
        throw new Error("Unsupported owner identity verification.");
      this.entries.set(
        choice.id,
        freeze({
          choice,
          configuration,
          ownerIdentity: registration.ownerIdentity,
        }),
      );
    }
  }
  setupChoices(): GatewaySetupChoice[] {
    return [...this.entries.values()].map((entry) =>
      structuredClone(entry.choice),
    );
  }
  readonly resolve: ResolveExecutorConfiguration = async (reference) => {
    for (const entry of this.entries.values()) {
      const transport = entry.choice.transport;
      if (
        (transport.type === "mcp"
          ? transport.serverConfigRef
          : transport.executorConfigRef) === reference
      )
        return entry.configuration;
    }
    throw new Error("Trusted gateway configuration is unavailable.");
  };
  assertConnection(
    connection: Pick<
      ServiceConnection,
      "service" | "transport" | "authentication"
    >,
  ): void {
    const reference = configurationReference(connection as ServiceConnection);
    const match = [...this.entries.values()].find((entry) => {
      const transport = entry.choice.transport;
      return (
        (transport.type === "mcp"
          ? transport.serverConfigRef
          : transport.executorConfigRef) === reference
      );
    });
    if (
      !match ||
      match.choice.service !== connection.service ||
      canonicalJson(match.choice.transport) !==
        canonicalJson(connection.transport) ||
      !match.choice.authenticationMethods.includes(
        connection.authentication.method,
      )
    )
      throw new Error(
        "Connection does not match a supported owner setup choice.",
      );
  }
  ownerIdentity(
    connection: ServiceConnection,
  ): GatewayOwnerIdentityProvider | null {
    this.assertConnection(connection);
    const reference = configurationReference(connection);
    for (const entry of this.entries.values()) {
      const transport = entry.choice.transport;
      if (
        (transport.type === "mcp"
          ? transport.serverConfigRef
          : transport.executorConfigRef) === reference
      )
        return entry.ownerIdentity ?? null;
    }
    return null;
  }
}

/** Official endpoints verified against https://linear.app/docs/mcp. Credentials
 * must be explicitly entered by the owner into Crew. No personal connector reuse.
 * Token setup is supported now; interactive OAuth requires a separate verified
 * registration/callback implementation and is intentionally not advertised. */
export function createSupportedGatewayRegistry(): TrustedGatewayRegistry {
  const linearGuide: NonNullable<GatewaySetupChoice["guide"]> = {
    credentialLabel: "Linear API key",
    credentialUrl: "https://linear.app/settings/account/security",
    documentationUrl: "https://linear.app/docs/mcp",
    accountOwnership: {
      personal: "Use an API key belonging to your own Linear account.",
      dedicated:
        "Sign in to the separate Linear account your organization intends Crew to use before creating its key.",
    },
    steps: [
      "In Linear, open Settings, then Account, then Security & Access and create an API key for Crew.",
      "Limit the key to the teams and permissions needed. For read-only work, enable only Read.",
      "Paste the key here, then verify the account and available capabilities before saving.",
    ],
  };
  const githubGuide: NonNullable<GatewaySetupChoice["guide"]> = {
    credentialLabel: "GitHub personal access token",
    credentialUrl: "https://github.com/settings/personal-access-tokens/new",
    documentationUrl:
      "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens",
    accountOwnership: {
      personal: "Use a token belonging to your own GitHub account.",
      dedicated:
        "Use a token created by the separate account your organization has approved for Crew. A personal access token still belongs to that account.",
    },
    steps: [
      "Create a fine-grained personal access token for Crew with an expiry.",
      "Choose the intended resource owner, repositories and minimum required permissions. Your organization may need to approve the token.",
      "Paste the token here, then verify the account and available capabilities. Discovery does not prove access to every repository or operation.",
    ],
  };
  return new TrustedGatewayRegistry([
    ...([false, true] as const).map((write): TrustedGatewayRegistration => ({
      choice: {
        id: write ? "gmail" : "gmail-readonly",
        label: write ? "Gmail (mail and drafts)" : "Gmail (read only)",
        service: "gmail",
        transport: {
          type: "mcp",
          serverConfigRef: write ? "crew.gmail.v1" : "crew.gmail.readonly.v1",
        },
        authenticationMethods: ["token", "oauth"],
        guide: {
          credentialLabel: "Google OAuth access token or credential JSON",
          credentialUrl: "https://developers.google.com/oauthplayground/",
          documentationUrl:
            "https://developers.google.com/workspace/gmail/api/auth/scopes",
          accountOwnership: {
            personal: "Explicitly authorize your own Google mailbox.",
            dedicated:
              "Choose the separate Google mailbox your organization approved for this agent.",
          },
          steps: [
            "Open Google's OAuth Playground. Use Google OAuth endpoints, choose https://www.googleapis.com/auth/gmail.readonly and authorize the intended account. For drafts/sending also authorize gmail.compose and gmail.send scopes.",
            "Exchange the authorization code for tokens. Copy only the access token into Crew. Never copy browser, Codex or another application's credentials.",
            "Verify the mailbox, choose group operations and memberships, then save. Google or your Workspace administrator may restrict consent; configure your own Google Cloud OAuth client if required.",
            "A plain token expires. For refresh, supply JSON containing access_token, expires_at (Unix milliseconds), refresh_token, client_id and optional client_secret for your own Google Cloud OAuth client. All fields stay vaulted. No personal connector sessions are reused.",
            "Choose read-only operations or separately grant draft/send operations through groups. Attachments, mailbox administration and replies/thread composition are not supported.",
          ],
        },
      },
      ownerIdentity: "gmail-oauth-token",
      configuration: {
        type: "mcp",
        adapter: "gmail-rest",
        gmailWrite: write,
        url: "https://gmail.googleapis.com",
        timeoutMs: 30_000,
      },
    })),
    {
      choice: {
        id: "linear-readonly",
        label: "Linear (read only)",
        service: "linear",
        transport: { type: "mcp", serverConfigRef: "crew.linear.readonly.v1" },
        authenticationMethods: ["token"],
        guide: linearGuide,
      },
      ownerIdentity: "linear-api-key",
      configuration: {
        type: "mcp",
        url: "https://mcp.linear.app/mcp/readonly",
        timeoutMs: 30_000,
      },
    },
    {
      choice: {
        id: "linear",
        label: "Linear",
        service: "linear",
        transport: { type: "mcp", serverConfigRef: "crew.linear.v1" },
        authenticationMethods: ["token"],
        guide: linearGuide,
      },
      ownerIdentity: "linear-api-key",
      configuration: {
        type: "mcp",
        url: "https://mcp.linear.app/mcp",
        timeoutMs: 30_000,
      },
    },
    ...(["readonly", "standard"] as const).map(
      (mode): TrustedGatewayRegistration => ({
        choice: {
          id: mode === "readonly" ? "github-readonly" : "github",
          label: mode === "readonly" ? "GitHub (read only)" : "GitHub",
          service: "github",
          transport: {
            type: "mcp",
            serverConfigRef:
              mode === "readonly"
                ? "crew.github.readonly.v1"
                : "crew.github.v1",
          },
          authenticationMethods: ["token"],
          guide: githubGuide,
        },
        ownerIdentity: "github-pat",
        configuration: {
          type: "mcp",
          url:
            mode === "readonly"
              ? "https://api.githubcopilot.com/mcp/readonly"
              : "https://api.githubcopilot.com/mcp/",
          timeoutMs: 30_000,
        },
      }),
    ),
  ]);
}
