import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PermissionGroup } from "../agents/contracts.mjs";

/** References are project-owned metadata. They never grant filesystem or service access. */
export interface ProjectReference {
  id: string;
  projectId: string;
  revision: number;
  name: string;
  category: "documentation" | "marketing" | "deployment" | "other";
  description: string;
  url: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface ProjectResource {
  id: string;
  kind: "reference" | "workspace" | "service";
  name: string;
  description: string;
  location: string | null;
  reference?: ProjectReference;
  /** Execution still uses the canonical environment or gateway tools. */
  environmentPolicyId?: string;
  connectionId?: string;
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value &&
  value.length <= 512 &&
  !/[\u0000-\u001f\u007f]/.test(value);
function validate(
  value: unknown,
  projectId: string,
): asserts value is ProjectReference {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid project reference.");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
      "archivedAt,category,description,id,name,projectId,revision,updatedAt,url" ||
    !validId(row.id) ||
    row.projectId !== projectId ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    !validId(row.name) ||
    typeof row.description !== "string" ||
    row.description.length > 20000 ||
    !["documentation", "marketing", "deployment", "other"].includes(
      String(row.category),
    ) ||
    typeof row.url !== "string" ||
    row.url.length > 8192 ||
    typeof row.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.updatedAt)) ||
    (row.archivedAt !== null &&
      (typeof row.archivedAt !== "string" ||
        !Number.isFinite(Date.parse(row.archivedAt))))
  )
    throw Error("Invalid project reference.");
  const url = new URL(row.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error(
      "Use a nonsecret HTTP(S) reference without embedded credentials.",
    );
}
/** Owned by the application's foundation writer lease, not another independent authority. */
export class ProjectResourceCatalogue {
  private rows: ProjectReference[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private constructor(
    private directory: string,
    readonly projectId: string,
  ) {}
  static async open(directory: string, projectId: string) {
    const catalogue = new ProjectResourceCatalogue(directory, projectId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const bytes = await readFile(join(directory, "references.json"), "utf8");
      if (bytes.length > 4 * 1024 * 1024)
        throw Error("Project reference catalogue is too large.");
      const state = JSON.parse(bytes);
      if (
        state.schema !== 1 ||
        state.projectId !== projectId ||
        !Array.isArray(state.references) ||
        state.references.length > 5000
      )
        throw Error("Invalid project resource catalogue.");
      for (const reference of state.references) validate(reference, projectId);
      if (
        new Set(state.references.map((row: ProjectReference) => row.id))
          .size !== state.references.length
      )
        throw Error("Duplicate project reference identities.");
      catalogue.rows = state.references;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return catalogue;
  }
  list() {
    return structuredClone(this.rows.filter((row) => !row.archivedAt));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  save(input: {
    id?: string;
    expectedRevision: number | null;
    name: string;
    category: ProjectReference["category"];
    description: string;
    url: string;
    archived?: boolean;
  }) {
    const operation = this.queue.then(async () => {
      const previous = input.id
        ? this.rows.find((row) => row.id === input.id)
        : undefined;
      if (
        (input.id && !previous) ||
        (previous?.revision ?? null) !== input.expectedRevision
      )
        throw Error(
          "Project reference changed; refresh and review before saving.",
        );
      const now = new Date().toISOString();
      const row: ProjectReference = {
        id: previous?.id ?? randomUUID(),
        projectId: this.projectId,
        revision: (previous?.revision ?? 0) + 1,
        name: input.name,
        category: input.category,
        description: input.description,
        url: input.url,
        updatedAt: now,
        archivedAt: input.archived ? now : null,
      };
      validate(row, this.projectId);
      if (!previous && this.rows.length >= 5000)
        throw Error("Project reference limit reached.");
      const rows = previous
        ? this.rows.map((old) => (old.id === previous.id ? row : old))
        : [...this.rows, row];
      const temporary = join(this.directory, `references-${randomUUID()}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({
          schema: 1,
          projectId: this.projectId,
          references: rows,
        }),
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, join(this.directory, "references.json"));
      this.rows = rows;
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          /* projection only */
        }
      }
      return structuredClone(row);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close() {
    await this.queue;
    this.listeners.clear();
  }
}
/** Existing policies and connections stay authoritative; resource IDs are only projections. */
export function projectResources(input: {
  references: ProjectReference[];
  workspaces: {
    policy: { id: string };
    workspace: { path: string };
    writable: boolean;
  }[];
  connections: {
    id: string;
    name: string;
    service: string;
    identity: { displayName: string };
  }[];
  groups?: PermissionGroup[];
}): ProjectResource[] {
  const groups = input.groups;
  const refs = new Set(
    groups?.flatMap((group) => group.grants.resourceIds ?? []),
  );
  const policies = new Set(
    groups?.flatMap((group) => group.grants.environmentPolicyIds),
  );
  const connections = new Set(
    groups?.flatMap((group) =>
      group.grants.services
        .filter((row) => row.capabilities.length)
        .map((row) => row.connectionId),
    ),
  );
  return [
    ...input.references
      .filter((row) => !groups || refs.has(row.id))
      .map((row) => ({
        id: row.id,
        kind: "reference" as const,
        name: row.name,
        description: row.description,
        location: row.url,
        reference: row,
      })),
    ...input.workspaces
      .filter((row) => !groups || policies.has(row.policy.id))
      .map((row) => ({
        id: `workspace:${row.policy.id}`,
        kind: "workspace" as const,
        name: row.workspace.path,
        description: row.writable
          ? "Read and write approved working files"
          : "Read approved working files",
        location: row.workspace.path,
        environmentPolicyId: row.policy.id,
      })),
    ...input.connections
      .filter((row) => !groups || connections.has(row.id))
      .map((row) => ({
        id: `service:${row.id}`,
        kind: "service" as const,
        name: row.name,
        description: `${row.service} · ${row.identity.displayName}`,
        location: null,
        connectionId: row.id,
      })),
  ];
}
