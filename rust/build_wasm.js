import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCWasm } from "../c/build_wasm.js";

const wasmPackVersion = "0.15.1";
const wasmPackRoot = join(
  homedir(),
  ".cache",
  "gaussian-splat-lite",
  "rust",
  `wasm-pack-${wasmPackVersion}`,
);
const wasmPack = join(
  wasmPackRoot,
  "bin",
  process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack",
);
const lodOnly = process.argv.includes("--lod");
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

function version(command) {
  const result = spawnSync(command, ["--version"], {
    env: childEnv,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
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
    if (!version(command)) {
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
  if (version(wasmPack) !== `wasm-pack ${wasmPackVersion}`) {
    run("cargo", [
      "install",
      "wasm-pack",
      "--version",
      wasmPackVersion,
      "--locked",
      "--root",
      wasmPackRoot,
    ]);
  }

  // Build on the system volume: AppleDouble files on external volumes can
  // otherwise be mistaken for WASM modules by wasm-bindgen or wasm-opt.
  buildDir = mkdtempSync(join(tmpdir(), "gaussian-splat-lite-wasm-"));
  const buildEnv = {
    ...childEnv,
    CARGO_TARGET_DIR: join(buildDir, "cargo-target"),
    RUSTFLAGS: undefined,
  };
  const decoderOutput = join(buildDir, "decoder");
  run(
    wasmPack,
    [
      "build",
      "--target",
      "web",
      "--release",
      "--no-typescript",
      "--out-name",
      "decoder",
      "--out-dir",
      decoderOutput,
      "--",
      "--features",
      "cli",
      "--locked",
    ],
    { env: buildEnv },
  );
  const decoderDestination = new URL("../bin/decoder/", import.meta.url);
  mkdirSync(decoderDestination, { recursive: true });
  for (const file of ["decoder.js", "decoder_bg.wasm"]) {
    cpSync(join(decoderOutput, file), new URL(file, decoderDestination));
  }
  // The SH codebook kernel of `gsl-build-rad --cluster-sh` is a module of
  // its own: it needs relaxed SIMD, which the decoder must not.
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--target",
      "wasm32-unknown-unknown",
      "--package",
      "gaussian-splat-cluster",
    ],
    { env: buildEnv },
  );
  cpSync(
    join(
      buildEnv.CARGO_TARGET_DIR,
      "wasm32-unknown-unknown",
      "release",
      "gaussian_splat_cluster.wasm",
    ),
    new URL("cluster.wasm", decoderDestination),
  );

  const webpDirectory = buildCWasm(
    buildDir,
    lodOnly ? ["encoder"] : ["encoder", "decoder"],
    fileURLToPath(decoderDestination),
  );

  if (!lodOnly) {
    buildEnv.GSL_WEBP_LIB_DIR = webpDirectory;
    const output = join(buildDir, "pkg");
    run(
      wasmPack,
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
      { env: buildEnv },
    );
    const destination = join(packageDir, "pkg");
    rmSync(destination, { recursive: true, force: true });
    cpSync(output, destination, {
      recursive: true,
      filter: (source) => !basename(source).startsWith("._"),
    });
  }
} catch (error) {
  console.error("Failed to build WASM:", error.message);
  process.exitCode = 1;
}
