import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const wasmPackVersion = "0.15.0";
const packageDir = fileURLToPath(
  new URL("./gaussian-splat-rs/", import.meta.url),
);
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const childEnv = {
  ...process.env,
  [pathKey]: [join(cargoHome, "bin"), process.env[pathKey]]
    .filter(Boolean)
    .join(delimiter),
};

function available(command) {
  return (
    spawnSync(command, ["--version"], {
      env: childEnv,
      stdio: "ignore",
    }).status === 0
  );
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageDir,
    env: childEnv,
    stdio: "inherit",
    ...options,
  });
}

let buildDir;
function cleanup() {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
}
process.once("exit", cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

try {
  for (const command of ["rustc", "cargo"]) {
    if (!available(command)) {
      throw new Error(`${command} is required. Install Rust through rustup.`);
    }
  }
  const sysroot = run("rustc", ["--print", "sysroot"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!existsSync(join(sysroot, "lib", "rustlib", "wasm32-unknown-unknown"))) {
    run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
  }
  if (!available("wasm-pack")) {
    run("cargo", [
      "install",
      "wasm-pack",
      "--version",
      wasmPackVersion,
      "--locked",
    ]);
  }

  // Build on the system volume: AppleDouble files on external volumes can
  // otherwise be mistaken for WASM modules by wasm-bindgen or wasm-opt.
  buildDir = mkdtempSync(join(tmpdir(), "gaussian-splat-lite-wasm-"));
  const output = join(buildDir, "pkg");
  run(
    "wasm-pack",
    [
      "build",
      "--target",
      "web",
      "--release",
      "--out-dir",
      output,
      "--",
      "--locked",
    ],
    {
      env: {
        ...childEnv,
        CARGO_TARGET_DIR: join(buildDir, "cargo-target"),
        RUSTFLAGS: "-C target-feature=+simd128,+bulk-memory",
      },
    },
  );
  const destination = join(packageDir, "pkg");
  rmSync(destination, { recursive: true, force: true });
  cpSync(output, destination, {
    recursive: true,
    filter: (source) => !basename(source).startsWith("._"),
  });
} catch (error) {
  console.error("Failed to build Rust WASM:", error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
