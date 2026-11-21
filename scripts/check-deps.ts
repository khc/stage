// Shared dependency checks for local stage development (CLI tools + Docker daemon).

export type CommandOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (args: string[]) => Promise<CommandOutput>;

export type DependencySpec = {
  id: string;
  name: string;
  required: boolean;
  /** Commands tried in order until one exits 0 (e.g. `docker compose` then `docker-compose`). */
  commands: string[][];
  minVersion?: string;
  installHint: string;
};

export type DependencyResult = {
  spec: DependencySpec;
  ok: boolean;
  version?: string;
  commandUsed?: string;
  error?: string;
};

const SEMVER_PATTERN = /\bv?(\d+)\.(\d+)\.(\d+)\b/;

export type Semver = readonly [number, number, number];

export const parseSemver = (text: string): Semver | undefined => {
  const match = SEMVER_PATTERN.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const formatSemver = ([major, minor, patch]: Semver): string => `${major}.${minor}.${patch}`;

export const compareSemver = (a: Semver, b: Semver): number => {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export const createSpawnRunner = (): CommandRunner => async (args) => {
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

export const dependencySpecs: DependencySpec[] = [
  {
    id: "bun",
    name: "Bun",
    required: true,
    commands: [["bun", "--version"]],
    minVersion: "1.4.0",
    installHint: "curl -fsSL https://bun.sh/install | bash",
  },
  {
    id: "docker",
    name: "Docker CLI",
    required: true,
    commands: [["docker", "--version"]],
    installHint: "Install Docker Desktop or OrbStack (https://docs.docker.com/get-docker/)",
  },
  {
    id: "docker-daemon",
    name: "Docker daemon",
    required: true,
    commands: [["docker", "info", "--format", "{{.ServerVersion}}"]],
    installHint: "Start Docker Desktop / OrbStack or the dockerd service",
  },
  {
    id: "docker-compose",
    name: "Docker Compose",
    required: true,
    commands: [
      ["docker", "compose", "version"],
      ["docker-compose", "--version"],
    ],
    installHint: "Install Docker Compose v2 plugin or docker-compose",
  },
  {
    id: "task",
    name: "go-task (task)",
    required: true,
    commands: [["task", "--version"]],
    installHint: "brew install go-task (https://taskfile.dev/installation/)",
  },
  {
    id: "terraform",
    name: "Terraform",
    required: true,
    commands: [["terraform", "version"]],
    installHint: "brew install terraform",
  },
  {
    id: "yq",
    name: "yq",
    required: true,
    commands: [["yq", "--version"]],
    installHint: "brew install yq",
  },
];

export const checkDependency = async (
  spec: DependencySpec,
  run: CommandRunner = createSpawnRunner(),
): Promise<DependencyResult> => {
  let lastError = "No command configured";

  for (const cmd of spec.commands) {
    const result = await run(cmd);
    const output = firstLine(result.stdout) || firstLine(result.stderr);
    const commandUsed = cmd.join(" ");

    if (result.exitCode !== 0) {
      lastError = output || `Exited with code ${result.exitCode}`;
      continue;
    }

    const parsed = parseSemver(output);
    const version = parsed ? formatSemver(parsed) : output || "ok";

    if (spec.minVersion) {
      const required = parseSemver(spec.minVersion);
      if (required && (!parsed || compareSemver(parsed, required) < 0)) {
        return {
          spec,
          ok: false,
          version,
          commandUsed,
          error: `Found ${version}, requires >= ${spec.minVersion}`,
        };
      }
    }

    return { spec, ok: true, version, commandUsed };
  }

  return { spec, ok: false, error: lastError };
};

export const summarizeFailures = (results: DependencyResult[]): string[] =>
  results
    .filter((r) => !r.ok)
    .map((r) => `${r.spec.name}: ${r.error ?? "not available"}\n  -> ${r.spec.installHint}`);
