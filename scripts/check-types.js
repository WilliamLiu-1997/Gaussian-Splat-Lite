import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkPackage = process.argv.includes("--package");
const directory = await mkdtemp(path.join(os.tmpdir(), "gsl-types-"));
const specifier = checkPackage
  ? "gaussian-splat-lite"
  : path.join(root, "src/index.js").split(path.sep).join("/");
const fixture = `
import {
  GaussianSplatRenderer, SplatCapture, SplatFileType, SplatLoader, SplatMesh,
  Splats, TAANode, TAAPass, fromHalf, postDecode, toHalf,
  type GaussianSplatRendererOptions, type SplatMeshOptions,
} from ${JSON.stringify(specifier)};
import { Box3, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from "three";
import { type WebGPURenderer, type Node } from "three/webgpu";

declare const webgl: WebGLRenderer;
declare const webgpu: WebGPURenderer;
const scene = new Scene();
const camera = new PerspectiveCamera();
const options: GaussianSplatRendererOptions = { renderer: webgl, stochastic: true };
const renderer = new GaussianSplatRenderer(options);
new GaussianSplatRenderer({ renderer: webgpu, encodeLinear: false });
renderer.material.depthTest = true;
renderer.stochastic = false;
renderer.update({ scene, camera }) satisfies Promise<void>;
renderer.shrinkResources({ scene, camera }) satisfies Promise<void>;
const meshOptions: SplatMeshOptions = {
  fileBytes: new Uint8Array(), fileType: SplatFileType.PLY,
  onFrame({ mesh, time, deltaTime }) { mesh.opacity = time + deltaTime; },
};
const mesh = new SplatMesh(meshOptions);
mesh.initialized satisfies Promise<SplatMesh>;
mesh.getBoundingBox(false, new Box3()) satisfies Box3;
const splats = new Splats();
splats.getSplat(0, false).center satisfies Vector3;
new SplatLoader().parse(splats) satisfies SplatMesh;
new SplatLoader().loadAsync("model.ply") satisfies Promise<Splats>;
const capture = new SplatCapture({ splatRenderer: renderer, target: { width: 32, height: 32 } });
capture.renderReadTarget({ scene, camera }) satisfies Promise<Uint8Array>;
capture.renderCubeMap({ scene, worldCenter: new Vector3() });
new TAAPass(scene, camera).setSize(32, 32);
const taa: Node<"vec4"> = new TAANode(scene, camera);
postDecode.define(() => ({}));
fromHalf(toHalf(1)) satisfies number;

// @ts-expect-error Renderer options require an actual Three.js renderer.
new GaussianSplatRenderer({ renderer: 1 });
// @ts-expect-error Stochastic mode is a boolean.
renderer.stochastic = "sorted";
// @ts-expect-error The loader requires a URL string.
new SplatLoader().loadAsync(42);
// @ts-expect-error Capture dimensions are numeric.
new SplatCapture({ splatRenderer: renderer, target: { width: "32", height: 32 } });
// @ts-expect-error Bounding-box output must be a Box3.
mesh.getBoundingBox(false, new Vector3());
`;

const diagnosticsHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => directory,
  getNewLine: () => "\n",
};

try {
  const dependencies = path.join(directory, "node_modules");
  await mkdir(dependencies);
  for (const dependency of ["three", "@types"]) {
    await symlink(
      path.join(root, "node_modules", dependency),
      path.join(dependencies, dependency),
      "junction",
    );
  }
  if (checkPackage) {
    await symlink(
      root,
      path.join(dependencies, "gaussian-splat-lite"),
      "junction",
    );
  }

  const modes = [
    {
      name: "Bundler",
      extension: "ts",
      module: ts.ModuleKind.ESNext,
      resolution: ts.ModuleResolutionKind.Bundler,
    },
    {
      name: "NodeNext ESM",
      extension: "mts",
      module: ts.ModuleKind.NodeNext,
      resolution: ts.ModuleResolutionKind.NodeNext,
    },
    ...(checkPackage
      ? [
          {
            name: "NodeNext CommonJS",
            extension: "cts",
            module: ts.ModuleKind.NodeNext,
            resolution: ts.ModuleResolutionKind.NodeNext,
          },
        ]
      : []),
  ];
  for (const mode of modes) {
    const file = path.join(directory, `consumer.${mode.extension}`);
    await writeFile(file, fixture);
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2020,
      lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
      module: mode.module,
      moduleResolution: mode.resolution,
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      console.error(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost),
      );
      process.exitCode = 1;
    } else {
      console.log(
        `Checked ${checkPackage ? "package" : "source"} types with ${mode.name}.`,
      );
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
