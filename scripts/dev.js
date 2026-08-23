import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const viteEntry = fileURLToPath(
  new URL("../node_modules/vite/bin/vite.js", import.meta.url),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const viteArguments = [viteEntry, "--host", ...process.argv.slice(2)];
const childOptions = {
  cwd: projectRoot,
  stdio: "inherit",
  detached: process.platform !== "win32",
};

const children = [
  spawn(npmCommand, ["run", "build:watch"], childOptions),
  spawn(process.execPath, viteArguments, childOptions),
];

let stopping = false;
let finalExitCode = 0;

function allChildrenExited() {
  return children.every(
    (child) => child.exitCode !== null || child.signalCode !== null,
  );
}

function finishIfStopped() {
  if (stopping && allChildrenExited()) {
    process.exit(finalExitCode);
  }
}

function signalChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      // Each child owns a process group so npm's watcher descendants are
      // stopped together with the direct child.
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  finalExitCode = exitCode;

  for (const child of children) {
    signalChild(child, "SIGTERM");
  }

  const forceStopTimer = setTimeout(() => {
    for (const child of children) {
      signalChild(child, "SIGKILL");
    }
  }, 3000);
  forceStopTimer.unref();
  finishIfStopped();
}

for (const child of children) {
  child.on("error", (error) => {
    console.error("Failed to start the development server:", error.message);
    stop(1);
  });

  child.on("exit", (code, signal) => {
    if (!stopping) {
      const exitCode = code ?? (signal ? 1 : 0);
      stop(exitCode);
    }
    finishIfStopped();
  });
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
