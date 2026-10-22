import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  realpath,
  open,
  rename,
  readdir,
  unlink,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import type { Skill, ProjectSkillSource } from "../agents/contracts.mjs";
import type { SkillDocument } from "./types.mjs";
export type { SkillDocument } from "./types.mjs";
import {
  ProjectSkillError,
  expectedRevision,
  identifier,
  skillLimits,
  validateDocument,
  resourcePath,
  fields,
  type SkillDocumentInput,
  type SkillResource,
} from "./validation.mjs";

export interface ProjectSkillStoreOptions {
  /** Dedicated Crew-owned directory, outside repositories and personal native storage. */
  directory: string;
  projectId: string;
  /** Include this project's repository and any configured personal Codex roots. */
  forbiddenRoots: string[];
}
interface FileRecord {
  path: string;
  sha256: string;
  bytes: number;
  executable: boolean;
}
interface RevisionRecord {
  schema: 1;
  skill: Skill;
  files: FileRecord[];
}
interface Index {
  schema: 1;
  projectId: string;
  skills: Skill[];
  revisions: Skill[];
}
export interface SelectedSkillRoots {
  extraRoots: string[];
  skills: { id: string; revision: number; nativePath: string }[];
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const inside = (root: string, target: string) =>
  target === root || target.startsWith(root + sep);
const unsafe = () =>
  new ProjectSkillError(
    "unsafe_store",
    "The project skill store changed or is unsafe. Restore its Crew-owned files before retrying.",
  );

async function canonicalFuture(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(
      await canonicalFuture(parent),
      path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
    );
  }
}

async function noRepository(path: string) {
  let current = path;
  while (true) {
    try {
      await lstat(join(current, ".git"));
      throw new ProjectSkillError(
        "unsafe_store",
        "Project skills must be stored outside source repositories.",
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function writeExclusive(path: string, value: string, mode = 0o600) {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Canonical authoring store. Immutable native revision trees are read-only discovery
 * inputs; the atomic index selects current revisions for both owner and agent APIs. */
export class ProjectSkillStore implements ProjectSkillSource {
  private readonly listeners = new Set<() => void>();
  private constructor(
    readonly directory: string,
    readonly projectId: string,
    private readonly rootIdentity: { dev: number; ino: number },
  ) {}

  static async open(
    options: ProjectSkillStoreOptions,
  ): Promise<ProjectSkillStore> {
    identifier(options.projectId);
    if (
      !isAbsolute(options.directory) ||
      !Array.isArray(options.forbiddenRoots)
    )
      throw unsafe();
    const wanted = await canonicalFuture(resolve(options.directory));
    const forbidden = await Promise.all(
      [
        join(homedir(), ".codex"),
        join(homedir(), ".agents", "skills"),
        ...options.forbiddenRoots,
      ].map((path) => {
        if (!isAbsolute(path)) throw unsafe();
        return canonicalFuture(resolve(path));
      }),
    );
    if (forbidden.some((root) => inside(root, wanted) || inside(wanted, root)))
      throw new ProjectSkillError(
        "unsafe_store",
        "Project skills must use a separate Crew-owned directory outside repositories and personal Codex storage.",
      );
    await noRepository(wanted);
    await mkdir(wanted, { recursive: true, mode: 0o700 });
    const stat = await lstat(wanted);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    )
      throw unsafe();
    const store = new ProjectSkillStore(wanted, options.projectId, {
      dev: stat.dev,
      ino: stat.ino,
    });
    await store.withWrite(async () => {
      try {
        await store.index();
      } catch (error) {
        if (!isMissing(error)) throw error;
        const entries = (await readdir(wanted)).filter(
          (name) => name !== ".write-lock",
        );
        if (entries.length)
          throw new ProjectSkillError(
            "unsafe_store",
            "The skill index is missing from a nonempty store; no replacement was created.",
          );
        await store.writeIndex({
          schema: 1,
          projectId: options.projectId,
          skills: [],
          revisions: [],
        });
      }
    });
    return store;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async list(): Promise<Skill[]> {
    return structuredClone((await this.index()).skills);
  }
  async read(skillId: string): Promise<SkillDocument> {
    identifier(skillId);
    const skill = (await this.index()).skills.find(
      (item) => item.id === skillId,
    );
    if (!skill)
      throw new ProjectSkillError(
        "missing",
        "This skill does not exist in the selected project.",
      );
    return this.readRevision(skill);
  }
  async create(input: SkillDocumentInput): Promise<SkillDocument> {
    const document = validateDocument(input);
    return this.withWrite(async () => {
      const index = await this.index();
      if (index.skills.length >= skillLimits.skills)
        throw new ProjectSkillError(
          "invalid",
          "This project has reached its skill limit.",
        );
      this.revisionCapacity(index);
      this.uniqueName(index, document.name);
      const saved = await this.writeRevision(randomUUID(), 1, document);
      await this.writeIndex({
        ...index,
        skills: [...index.skills, saved.skill],
        revisions: [...index.revisions, saved.skill],
      });
      this.changed();
      return saved;
    });
  }
  async update(
    input: SkillDocumentInput & { skillId: string; expectedRevision: number },
  ): Promise<SkillDocument> {
    const value = fields(
      input,
      ["skillId", "expectedRevision", "markdown", "resources"],
      ["skillId", "expectedRevision", "markdown"],
    );
    identifier(value.skillId);
    expectedRevision(value.expectedRevision);
    return this.withWrite(async () => {
      const index = await this.index();
      this.revisionCapacity(index);
      const current = index.skills.find((skill) => skill.id === value.skillId);
      if (!current)
        throw new ProjectSkillError(
          "missing",
          "This skill does not exist in the selected project.",
        );
      if (current.revision !== value.expectedRevision)
        throw new ProjectSkillError(
          "conflict",
          "This skill was changed elsewhere. Reload the saved version and keep your draft before saving again.",
        );
      const retained =
        value.resources === undefined
          ? (await this.readRevision(current)).resources
          : [];
      const document = validateDocument(
        {
          markdown: value.markdown,
          ...(value.resources !== undefined
            ? { resources: value.resources }
            : {}),
        },
        retained,
      );
      this.uniqueName(index, document.name, current.id);
      const saved = await this.writeRevision(
        current.id,
        current.revision + 1,
        document,
      );
      await this.writeIndex({
        ...index,
        skills: index.skills.map((skill) =>
          skill.id === current.id ? saved.skill : skill,
        ),
        revisions: [...index.revisions, saved.skill],
      });
      this.changed();
      return saved;
    });
  }

  async resolve(
    skillId: string,
    revision: number,
  ): Promise<{ nativePath: string }> {
    identifier(skillId);
    expectedRevision(revision);
    const skill = (await this.index()).revisions.find(
      (item) => item.id === skillId && item.revision === revision,
    );
    if (!skill)
      throw new ProjectSkillError(
        "missing",
        "The exact project skill revision is unavailable.",
      );
    await this.readRevision(skill);
    return { nativePath: join(skill.directoryRef, "SKILL.md") };
  }

  /** Trusted resolver only. Bind exact revisions into one project's native process;
   * never discover the whole store or modify personal/native configuration. */
  async resolveSelected(skills: Skill[]): Promise<SelectedSkillRoots> {
    if (
      !Array.isArray(skills) ||
      skills.length > skillLimits.skills ||
      new Set(skills.map((item) => item.id)).size !== skills.length
    )
      throw unsafe();
    const index = await this.index();
    for (const skill of skills) {
      this.validateSkill(skill);
      const committed = index.revisions.find(
        (item) => item.id === skill.id && item.revision === skill.revision,
      );
      if (!committed || !sameSkill(committed, skill)) throw unsafe();
      await this.readRevision(skill);
    }
    return {
      extraRoots: skills.map((skill) => dirname(skill.directoryRef)),
      skills: skills.map((skill) => ({
        id: skill.id,
        revision: skill.revision,
        nativePath: join(skill.directoryRef, "SKILL.md"),
      })),
    };
  }

  private revisionCapacity(index: Index) {
    if (index.revisions.length >= skillLimits.revisions)
      throw new ProjectSkillError(
        "invalid",
        "This project has reached its retained skill revision limit. Existing revisions are preserved.",
      );
  }

  private uniqueName(index: Index, name: string, except?: string) {
    if (index.skills.some((item) => item.id !== except && item.name === name))
      throw new ProjectSkillError(
        "conflict",
        "A skill with that name already exists in this project.",
      );
  }
  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observation cannot roll back a committed save. */
      }
    }
  }
  private async assertRoot() {
    const stat = await lstat(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.rootIdentity.dev ||
      stat.ino !== this.rootIdentity.ino ||
      (await realpath(this.directory)) !== this.directory
    )
      throw unsafe();
  }
  private async assertPath(path: string) {
    await this.assertRoot();
    if (!inside(this.directory, path)) throw unsafe();
    let current = this.directory;
    const parts = relative(this.directory, path).split(sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (i < parts.length - 1 && !stat.isDirectory())
      )
        throw unsafe();
    }
  }
  private async readFile(path: string, max: number): Promise<string> {
    await this.assertPath(path);
    let file: FileHandle | undefined;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw unsafe();
      const data = await file.readFile();
      if (
        data.length > max ||
        !Buffer.from(data.toString("utf8"), "utf8").equals(data)
      )
        throw unsafe();
      await this.assertRoot();
      return data.toString("utf8");
    } finally {
      await file?.close();
    }
  }
  private validateSkill(skill: Skill) {
    fields(skill, [
      "id",
      "projectId",
      "revision",
      "name",
      "description",
      "directoryRef",
      "updatedAt",
    ]);
    identifier(skill.id);
    expectedRevision(skill.revision);
    if (
      skill.projectId !== this.projectId ||
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      typeof skill.directoryRef !== "string" ||
      typeof skill.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(skill.updatedAt))
    )
      throw unsafe();
    const location = relative(this.directory, skill.directoryRef).split(sep);
    if (
      location.length !== 4 ||
      location[0] !== "revisions" ||
      location[1] !== skill.id ||
      !location[2].startsWith(`${skill.revision}-`) ||
      !/^\d+-[0-9a-f-]{36}$/.test(location[2]) ||
      location[3] !== skill.name ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)
    )
      throw unsafe();
  }
  private async index(): Promise<Index> {
    const value = JSON.parse(
      await this.readFile(join(this.directory, "index.json"), 32 * 1024 * 1024),
    ) as Index;
    fields(value, ["schema", "projectId", "skills", "revisions"]);
    if (
      value.schema !== 1 ||
      value.projectId !== this.projectId ||
      !Array.isArray(value.skills) ||
      value.skills.length > skillLimits.skills ||
      !Array.isArray(value.revisions) ||
      value.revisions.length > skillLimits.revisions
    )
      throw unsafe();
    for (const skill of [...value.skills, ...value.revisions])
      this.validateSkill(skill);
    if (
      new Set(value.skills.map((s) => s.id)).size !== value.skills.length ||
      new Set(value.skills.map((s) => s.name)).size !== value.skills.length
    )
      throw unsafe();
    if (
      new Set(value.revisions.map((s) => `${s.id}:${s.revision}`)).size !==
        value.revisions.length ||
      value.skills.some(
        (skill) => !value.revisions.some((entry) => sameSkill(entry, skill)),
      )
    )
      throw unsafe();
    return value;
  }
  private async readRevision(skill: Skill): Promise<SkillDocument> {
    this.validateSkill(skill);
    const container = dirname(skill.directoryRef);
    const record = JSON.parse(
      await this.readFile(join(container, "revision.json"), 128 * 1024),
    ) as RevisionRecord;
    fields(record, ["schema", "skill", "files"]);
    if (
      record.schema !== 1 ||
      !sameSkill(record.skill, skill) ||
      !Array.isArray(record.files) ||
      record.files.length > skillLimits.resourceCount + 1
    )
      throw unsafe();
    const resources: SkillResource[] = [];
    let markdown: string | undefined;
    for (const entry of record.files) {
      fields(entry, ["path", "sha256", "bytes", "executable"]);
      if (
        typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > skillLimits.resourceBytes ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof entry.executable !== "boolean"
      )
        throw unsafe();
      if (entry.path !== "SKILL.md") {
        // Validate before path joining, including for corrupt on-disk manifests.
        resourcePath(entry.path);
      }
      const content = await this.readFile(
        join(skill.directoryRef, entry.path),
        entry.path === "SKILL.md"
          ? skillLimits.markdownBytes
          : skillLimits.resourceBytes,
      );
      if (
        Buffer.byteLength(content) !== entry.bytes ||
        digest(content) !== entry.sha256
      )
        throw unsafe();
      if (entry.path === "SKILL.md") {
        if (markdown !== undefined || entry.executable) throw unsafe();
        markdown = content;
      } else
        resources.push({
          path: entry.path,
          content,
          executable: entry.executable,
        });
    }
    const checked = validateDocument({ markdown, resources });
    if (
      checked.name !== skill.name ||
      checked.description !== skill.description
    )
      throw unsafe();
    await this.assertTree(
      skill.directoryRef,
      record.files.map((file) => file.path),
    );
    return {
      skill: structuredClone(skill),
      markdown: checked.markdown,
      resources: checked.resources,
    };
  }
  private async assertTree(directory: string, expected: string[]) {
    const files = new Set(expected);
    const directories = new Set<string>();
    for (const file of expected) {
      let parent = dirname(file);
      while (parent !== ".") {
        directories.add(parent);
        parent = dirname(parent);
      }
    }
    let entries = 0;
    const visit = async (path: string) => {
      await this.assertPath(path);
      for (const name of await readdir(path)) {
        if (++entries > 600) throw unsafe();
        const child = join(path, name),
          local = relative(directory, child);
        const stat = await lstat(child);
        if (stat.isSymbolicLink()) throw unsafe();
        if (stat.isDirectory()) {
          if (!directories.has(local)) throw unsafe();
          await visit(child);
        } else if (!stat.isFile() || stat.nlink !== 1 || !files.delete(local))
          throw unsafe();
      }
    };
    await visit(directory);
    if (files.size) throw unsafe();
  }
  private async writeRevision(
    id: string,
    revision: number,
    document: ReturnType<typeof validateDocument>,
  ): Promise<SkillDocument> {
    await this.assertRoot();
    const parent = join(this.directory, "revisions", id);
    await this.ensureDirectories(parent);
    const container = join(parent, `${revision}-${randomUUID()}`);
    await mkdir(container, { mode: 0o700 });
    const directoryRef = join(container, document.name);
    await mkdir(directoryRef, { mode: 0o700 });
    const skill: Skill = {
      id,
      projectId: this.projectId,
      revision,
      name: document.name,
      description: document.description,
      directoryRef,
      updatedAt: new Date().toISOString(),
    };
    const source = [
      { path: "SKILL.md", content: document.markdown, executable: false },
      ...document.resources,
    ];
    const files: FileRecord[] = [];
    for (const item of source) {
      const file = join(directoryRef, item.path);
      await this.ensureDirectories(dirname(file));
      await writeExclusive(file, item.content, item.executable ? 0o700 : 0o600);
      files.push({
        path: item.path,
        sha256: digest(item.content),
        bytes: Buffer.byteLength(item.content),
        executable: item.executable === true,
      });
    }
    await writeExclusive(
      join(container, "revision.json"),
      JSON.stringify({ schema: 1, skill, files } satisfies RevisionRecord),
    );
    await syncDirectory(directoryRef);
    await syncDirectory(container);
    return {
      skill,
      markdown: document.markdown,
      resources: structuredClone(document.resources),
    };
  }
  private async ensureDirectories(path: string) {
    await this.assertRoot();
    if (!inside(this.directory, path)) throw unsafe();
    let current = this.directory;
    for (const part of relative(this.directory, path)
      .split(sep)
      .filter(Boolean)) {
      current = join(current, part);
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
    }
  }
  private async writeIndex(index: Index) {
    await this.assertRoot();
    const temporary = join(this.directory, `.index-${randomUUID()}.json`);
    try {
      await writeExclusive(temporary, JSON.stringify(index));
      await this.assertRoot();
      await rename(temporary, join(this.directory, "index.json"));
      await syncDirectory(this.directory);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
  private async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertRoot();
    const lock = join(this.directory, ".write-lock");
    let acquired = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!acquired)
      throw new ProjectSkillError(
        "busy",
        "Another skill save is in progress, or its lock needs owner recovery. Your draft has been retained; retry after the save completes.",
      );
    try {
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }
}

function sameSkill(left: Skill, right: Skill) {
  return (
    left &&
    right &&
    (
      [
        "id",
        "projectId",
        "revision",
        "name",
        "description",
        "directoryRef",
        "updatedAt",
      ] as const
    ).every((key) => left[key] === right[key])
  );
}
