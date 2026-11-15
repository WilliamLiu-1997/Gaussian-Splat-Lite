import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const emsdkVersion = "4.0.23";
const cmakeVersion = "3.31.6";
const ninjaVersion = "1.11.1.4";
const directory = fileURLToPath(new URL("./", import.meta.url));

export function buildCWasm(buildDir, modes, outputDir) {
  const cache = join(homedir(), ".cache", "gaussian-splat-lite", "c");
  const sdk = join(cache, `emsdk-${emsdkVersion}`);
  const python = process.platform === "win32" ? "python" : "python3";
  const tools = join(cache, `cmake-${cmakeVersion}-ninja-${ninjaVersion}`);
  const toolsBin = join(
    tools,
    process.platform === "win32" ? "Scripts" : "bin",
  );
  const executable = (name) =>
    join(toolsBin, process.platform === "win32" ? `${name}.exe` : name);
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { stdio: "inherit", ...options });

  for (const command of [python, "git"]) run(command, ["--version"]);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(join(sdk, "emsdk.py"))) {
    run("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      emsdkVersion,
      "https://github.com/emscripten-core/emsdk.git",
      sdk,
    ]);
  }
  const emsdk = join(sdk, "emsdk.py");
  run(python, [emsdk, "install", emsdkVersion]);
  run(python, [emsdk, "activate", emsdkVersion]);

  if (!existsSync(executable("cmake")) || !existsSync(executable("ninja"))) {
    run(python, ["-m", "venv", tools]);
    run(executable("python"), [
      "-m",
      "pip",
      "install",
      `cmake==${cmakeVersion}`,
      `ninja==${ninjaVersion}`,
    ]);
  }
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const env = {
    ...process.env,
    EM_CONFIG: join(sdk, ".emscripten"),
    [pathKey]: [toolsBin, process.env[pathKey]].filter(Boolean).join(delimiter),
  };
  const build = join(buildDir, "c");
  for (const mode of modes) {
    const modeBuild = join(build, mode);
    run(
      python,
      [
        join(sdk, "upstream", "emscripten", "emcmake.py"),
        executable("cmake"),
        "-S",
        directory,
        "-B",
        modeBuild,
        "-G",
        "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        `-DGSL_WEBP_DECODER=${mode === "decoder" ? "ON" : "OFF"}`,
        `-DFETCHCONTENT_BASE_DIR=${join(cache, `sources-${emsdkVersion}`)}`,
      ],
      { env },
    );
    run(
      executable("cmake"),
      [
        "--build",
        modeBuild,
        "--target",
        "wasm",
        "--parallel",
        String(availableParallelism()),
      ],
      { env },
    );
  }

  if (modes.includes("encoder")) {
    mkdirSync(outputDir, { recursive: true });
    cpSync(join(build, "encoder", "modules"), outputDir, { recursive: true });
  }
  if (modes.includes("decoder")) return join(build, "decoder", "lib");
}
