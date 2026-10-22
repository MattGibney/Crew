import type {
  CallerContext,
  ConfigurationSnapshot,
  RuntimeAccessProvider,
  RuntimeIsolationResult,
} from "../agents/contracts.mjs";

/**
 * The #89 native-runtime feasibility decision, not a claim about every Codex
 * version or a substitute for observing a future isolation implementation.
 * See docs/ACCESS-ISOLATION.md for installed-runtime evidence and acceptance.
 */
const limitations: readonly string[] = Object.freeze([
  "No verified runtime boundary excludes personal filesystem credentials, OS keychain access, process access, Git/SSH helpers and agent sockets while preserving native approvals.",
  "A separate Codex home, private workspace, filtered environment or permission profile does not by itself prove that personal MCP, apps, plugins, CLI configuration and shell startup cannot supply service authority.",
  "Native ChatGPT sign-in is supported, but subscription sign-in inside the required isolation boundary has not been verified. Personal auth files and tokens must not be copied or extracted; API-key fallback is not permitted.",
  "The inspected Codex 0.163.0-alpha.11 schema marks chatgptAuthTokens for OpenAI internal use only. It is not a supported credential-transfer route for this implementation.",
  "No session-bound gateway connection and environment policy have been observed together with enforced denial of direct service access across ordinary, approved and resumed execution.",
]);

/**
 * Fail closed until a supported, observed isolation route is implemented.
 *
 * Construction and prepare never discover/read personal configuration, resolve
 * credential references, launch a process, create a workspace or change native
 * approvals. Configuration snapshots and opaque references are not evidence.
 * There is deliberately no boolean, callback or option that can mint `ready`.
 */
export class CodexRuntimeAccessProvider implements RuntimeAccessProvider {
  async prepare(
    _caller: CallerContext,
    _configuration: ConfigurationSnapshot,
  ): Promise<RuntimeIsolationResult> {
    return {
      state: "blocked",
      reason:
        "Agent Start is blocked: Crew has not verified subscription-backed Codex execution without personal service credential inheritance. See docs/ACCESS-ISOLATION.md.",
      limitations: [...limitations],
    };
  }

  /** No resources are allocated by this provider, including failed prepares. */
  async release(_caller: CallerContext): Promise<void> {}
}
