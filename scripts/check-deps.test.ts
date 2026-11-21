import { describe, expect, test } from "bun:test";

import {
  checkDependency,
  compareSemver,
  parseSemver,
  type CommandRunner,
  type DependencySpec,
} from "./check-deps.ts";

describe("semver helpers", () => {
  test("parses semver from tool version strings", () => {
    expect(parseSemver("1.4.5")).toEqual([1, 4, 5]);
    expect(parseSemver("Docker version 27.3.1, build ce12230")).toEqual([27, 3, 1]);
    expect(parseSemver("Terraform v1.9.8\non darwin_arm64")).toEqual([1, 9, 8]);
    expect(parseSemver("no version here")).toBeUndefined();
  });

  test("compares semver tuples", () => {
    expect(compareSemver([1, 4, 5], [1, 4, 0])).toBeGreaterThan(0);
    expect(compareSemver([1, 4, 0], [1, 4, 0])).toBe(0);
    expect(compareSemver([1, 3, 9], [1, 4, 0])).toBeLessThan(0);
  });
});

describe("checkDependency", () => {
  const composeSpec: DependencySpec = {
    id: "docker-compose",
    name: "Docker Compose",
    required: true,
    commands: [
      ["docker", "compose", "version"],
      ["docker-compose", "--version"],
    ],
    installHint: "Install Docker Compose",
  };

  test("returns ok with parsed version when command succeeds", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      stdout: "Docker Compose version v2.29.7\n",
      stderr: "",
    });

    const result = await checkDependency(composeSpec, runner);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.29.7");
    expect(result.commandUsed).toBe("docker compose version");
  });

  test("falls back to secondary command when primary fails", async () => {
    const seen: string[][] = [];
    const runner: CommandRunner = async (args) => {
      seen.push(args);
      if (args[0] === "docker") {
        return { exitCode: 1, stdout: "", stderr: "unknown command: compose" };
      }
      return { exitCode: 0, stdout: "docker-compose version 1.29.2", stderr: "" };
    };

    const result = await checkDependency(composeSpec, runner);
    expect(seen).toEqual([
      ["docker", "compose", "version"],
      ["docker-compose", "--version"],
    ]);
    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.29.2");
    expect(result.commandUsed).toBe("docker-compose --version");
  });

  test("fails when version is below minVersion", async () => {
    const bunSpec: DependencySpec = {
      id: "bun",
      name: "Bun",
      required: true,
      commands: [["bun", "--version"]],
      minVersion: "1.4.0",
      installHint: "Upgrade bun",
    };
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      stdout: "1.3.2\n",
      stderr: "",
    });

    const result = await checkDependency(bunSpec, runner);
    expect(result.ok).toBe(false);
    expect(result.version).toBe("1.3.2");
    expect(result.error).toBe("Found 1.3.2, requires >= 1.4.0");
  });

  test("reports error when all commands fail", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "Executable not found in $PATH",
    });

    const result = await checkDependency(composeSpec, runner);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Executable not found in $PATH");
  });
});
