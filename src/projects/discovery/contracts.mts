export interface ProjectInventory {
  root: string;
  entries: { path: string; kind: string }[];
  sources: { path: string; content: string }[];
  truncated: boolean;
  limits: {
    entries: number;
    visited: number;
    depth: number;
    files: number;
    fileBytes: number;
    totalBytes: number;
  };
}
export interface DiscoveryAnalysis {
  name: string;
  summary: string;
  managerContext: string;
  workerContext: string;
  components: string[];
  questions: string[];
  findings: { statement: string; status: string; sources: string[] }[];
}
export interface DiscoveryRunOptions {
  executable: string;
  prompt: string;
  cwd: string;
  schemaPath: string;
  outputPath: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
