/** Optional project preferences and canonical issue identities (GH-78).
 * These are mapping data, never proof of connected access or authority to act. */
export type TrackerProvider = "linear" | "github";
export interface TrackingPreferences {
  providers: TrackerProvider[];
  preferred: TrackerProvider | "none";
  githubRepository: string | null;
}
export type WorkLink =
  | { provider: "github"; repository: string; number: number; url: string }
  | { provider: "linear"; identifier: string; url: string };
export const repositoryName =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
export const trackingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["providers", "preferred", "githubRepository"],
  properties: {
    providers: {
      type: "array",
      uniqueItems: true,
      items: { enum: ["linear", "github"] },
    },
    preferred: { enum: ["none", "linear", "github"] },
    githubRepository: {
      type: ["string", "null"],
      pattern: repositoryName.source,
    },
  },
};
interface LinkSchema {
  type: string | string[];
  anyOf?: LinkSchema[];
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, LinkSchema>;
  const?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}
export const workLinkSchema: LinkSchema = {
  type: ["object", "null"],
  anyOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      required: ["provider", "repository", "number", "url"],
      properties: {
        provider: { type: "string", const: "github" },
        repository: { type: "string", pattern: repositoryName.source },
        number: {
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        url: { type: "string", maxLength: 500 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["provider", "identifier", "url"],
      properties: {
        provider: { type: "string", const: "linear" },
        identifier: {
          type: "string",
          pattern: "^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]*$",
        },
        url: { type: "string", maxLength: 500 },
      },
    },
  ],
};
export function trackingPreferences(project: {
  tracking?: TrackingPreferences;
  linear?: { teamId?: string | null; teamKey?: string | null };
}): TrackingPreferences {
  return (
    project.tracking || {
      providers:
        project.linear?.teamId || project.linear?.teamKey ? ["linear"] : [],
      preferred:
        project.linear?.teamId || project.linear?.teamKey ? "linear" : "none",
      githubRepository: null,
    }
  );
}
export function validateTracking(
  project: Parameters<typeof trackingPreferences>[0],
) {
  const tracking = trackingPreferences(project);
  if (
    tracking.preferred !== "none" &&
    !tracking.providers.includes(tracking.preferred)
  )
    throw Error(
      "Preferred tracker must be enabled, or choose no external tracker.",
    );
  return tracking;
}
/** Infer only unambiguous canonical URLs. Legacy labels stay labels, not verified identities. */
export function workLinkFromTicket(ticket: string): WorkLink | null {
  const github =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(
      ticket,
    );
  if (github)
    return validateWorkLink({
      provider: "github",
      repository: github[1],
      number: Number(github[2]),
      url: ticket.replace(/\/$/, ""),
    });
  const linear =
    /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]{0,19}-[1-9][0-9]*)(?:\/[^?#]*)?$/.exec(
      ticket,
    );
  if (linear)
    return validateWorkLink({
      provider: "linear",
      identifier: linear[1],
      url: ticket,
    });
  return null;
}
export function validateWorkLink(
  value: WorkLink | null | undefined,
): WorkLink | null {
  if (value == null) return null;
  if (value.provider === "github") {
    if (
      !repositoryName.test(value.repository) ||
      !Number.isSafeInteger(value.number) ||
      value.number < 1 ||
      value.url !==
        `https://github.com/${value.repository}/issues/${value.number}` ||
      Object.keys(value).some(
        (key) => !["provider", "repository", "number", "url"].includes(key),
      )
    )
      throw Error(
        "GitHub issue linkage must contain its exact repository, issue number and canonical URL.",
      );
  } else if (value.provider === "linear") {
    if (
      !/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]*$/.test(value.identifier) ||
      !new RegExp(
        `^https://linear\\.app/[A-Za-z0-9_-]+/issue/${value.identifier}(?:/[^/?#\\s]+)?$`,
      ).test(value.url) ||
      Object.keys(value).some(
        (key) => !["provider", "identifier", "url"].includes(key),
      )
    )
      throw Error(
        "Linear issue linkage must contain its exact identifier and canonical issue URL.",
      );
  } else throw Error("Unknown issue provider.");
  return value;
}
export function workLinkLabel(link: WorkLink | null | undefined) {
  return link?.provider === "github"
    ? `${link.repository}#${link.number}`
    : link?.identifier || null;
}

/** Missing linkage is legacy data; explicit null is an intentionally local assignment.
 * Resolve only for comparison/inheritance. Never migrate retained record bytes here. */
export function retainedWorkLink(record: {
  ticket: string;
  workLink?: WorkLink | null;
}): WorkLink | null {
  return record.workLink === undefined
    ? workLinkFromTicket(record.ticket)
    : record.workLink;
}
/** Link identity does not depend on JSON object insertion order. Undefined still
 * differs from null for follow-up request provenance (retain versus unlink). */
export function sameWorkLink(
  left: WorkLink | null | undefined,
  right: WorkLink | null | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null || left.provider !== right.provider)
    return false;
  return left.provider === "github" && right.provider === "github"
    ? left.repository === right.repository &&
        left.number === right.number &&
        left.url === right.url
    : left.provider === "linear" &&
        right.provider === "linear" &&
        left.identifier === right.identifier &&
        left.url === right.url;
}

/** Presentation only: a legacy canonical URL is evidence, an arbitrary label is
 * not. Explicit null prevents a historical URL from relinking local work. */
export function workReference(
  record: { ticket?: string; workLink?: WorkLink | null },
  fallback: string,
) {
  let link: WorkLink | null = null;
  try {
    link =
      record.workLink === undefined
        ? workLinkFromTicket(record.ticket || "")
        : validateWorkLink(record.workLink);
  } catch {
    /* An unsupported legacy label is still a label, never inferred identity. */
  }
  if (link?.provider === "github")
    return {
      label: `#${link.number}`,
      context: `GitHub issue ${workLinkLabel(link)}`,
      repository: link.repository,
      link,
    };
  if (link?.provider === "linear")
    return {
      label: link.identifier,
      context: `Linear issue ${link.identifier}`,
      repository: null,
      link,
    };
  const label =
    record.workLink === null && /^https?:\/\//i.test(record.ticket || "")
      ? fallback
      : record.ticket || fallback;
  return {
    label,
    context: label,
    repository: null,
    link: null,
  };
}
