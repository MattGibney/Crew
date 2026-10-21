export type Command =
  | "help"
  | "init"
  | "doctor"
  | "validate"
  | "start"
  | "status"
  | "stop"
  | "package";
export interface CliOptions {
  command: Command;
  "--config"?: string;
  "--template"?: string;
  "--output"?: string;
  "--background"?: boolean;
}
const commands: Record<Exclude<Command, "help">, readonly string[]> = {
  init: ["--config", "--template"],
  doctor: ["--config"],
  validate: ["--config"],
  start: ["--config", "--background"],
  status: ["--config"],
  stop: ["--config"],
  package: ["--output"],
};
function isCommand(value: string): value is Exclude<Command, "help"> {
  return Object.hasOwn(commands, value);
}
export function parse(args: string[]): CliOptions {
  const command = args.shift() || "help";
  if (["help", "--help", "-h"].includes(command)) return { command: "help" };
  if (!isCommand(command))
    throw new Error(`Unknown command "${command}". Run npm start -- --help.`);
  const options: CliOptions = { command },
    seen = new Set<string>();
  while (args.length) {
    const flag = args.shift()!;
    if (!commands[command].includes(flag) || seen.has(flag))
      throw new Error(
        `Unsupported or repeated option "${flag}" for ${command}.`,
      );
    seen.add(flag);
    if (flag === "--background") {
      options[flag] = true;
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value.`);
    if (flag === "--config" || flag === "--template" || flag === "--output")
      options[flag] = value;
  }
  return options;
}
