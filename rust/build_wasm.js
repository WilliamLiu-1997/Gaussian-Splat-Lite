const { execFileSync } = await import("node:child_process");
const { homedir, platform } = await import("node:os");
const { delimiter, join } = await import("node:path");

const isWindows = platform() === "win32";
const pathKey =
  Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
  "PATH";
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
const cargoBin = join(cargoHome, "bin");
const childEnv = {
  ...process.env,
  [pathKey]: [cargoBin, process.env[pathKey]].filter(Boolean).join(delimiter),
};

try {
  if (isWindows) {
    execFileSync(
      "powershell.exe",
      ["-ExecutionPolicy", "Bypass", "-File", "./rust/build_rust_wasm.ps1"],
      { stdio: "inherit", env: childEnv },
    );
  } else {
    execFileSync("bash", ["rust/build_rust_wasm.sh"], {
      stdio: "inherit",
      env: childEnv,
    });
  }
} catch (err) {
  console.error("Failed to build RUST WASM:", err.message);
  process.exit(1);
}
