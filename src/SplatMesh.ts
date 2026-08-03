import * as THREE from "three";

import init_wasm, {
  get_raycast_buffer,
  get_raycast_buffer2,
  raycast_ext_buffers,
  raycast_packed_buffer,
} from "spark-rs";
import { ExtSplats } from "./ExtSplats";
import { PackedSplats } from "./PackedSplats";
import { type RgbaArray, TRgbaArray } from "./RgbaArray";
import { SplatEdit, SplatEditSdf, SplatEdits } from "./SplatEdit";
import {
  type CovSplatModifier,
  CovSplatTransformer,
  type FrameUpdateContext,
  type GsplatModifier,
  SplatGenerator,
  SplatTransformer,
} from "./SplatGenerator";
import type { SplatSkinning } from "./SplatSkinning";
import {
  DEFAULT_SPLAT_ENCODING,
  LN_SCALE_MAX,
  LN_SCALE_MIN,
  type SplatEncoding,
  type SplatFileType,
} from "./defines";
import {
  CovSplat,
  Dyno,
  DynoFloat,
  DynoInt,
  type DynoVal,
  DynoVec4,
  Gsplat,
  combineCovSplat,
  combineGsplat,
  defineGsplat,
  dyno,
  dynoBlock,
  dynoConst,
  gsplatToCovSplat,
  min,
  mul,
  splitCovSplat,
  splitGsplat,
  unindentLines,
} from "./dyno";

export type SplatMeshOptions = {
  // URL to fetch a .ply or .spz Gaussian splat file from. (default: undefined)
  url?: string;
  // Raw bytes of a Gaussian splat file to decode directly instead of fetching
  // from URL. (default: undefined)
  fileBytes?: Uint8Array | ArrayBuffer;
  // Override file type detection. (default: undefined auto-detects from the
  // file contents)
  fileType?: SplatFileType;
  // File name to use for type detection. (default: undefined)
  fileName?: string;
  // Stream to read the Gaussian splat file from. (default: undefined)
  stream?: ReadableStream;
  // Length of the stream in bytes. (default: undefined)
  streamLength?: number;
  // Use an existing PackedSplats object as the source instead of loading from
  // a file. Can be used to share a collection of Gsplats among multiple SplatMeshes
  // (default: undefined creates a new empty PackedSplats or decoded from a
  // data source above)
  packedSplats?: PackedSplats;
  // Use an existing SplatSource object as the source instead of loading from file.
  splats?: SplatSource;
  // Reserve space for at least this many splats when constructing the mesh
  // initially. (default: determined by file)
  maxSplats?: number;
  // Callback function to programmatically create splats at initialization
  // in provided PackedSplats. (default: undefined)
  constructSplats?: (splats: PackedSplats) => Promise<void> | void;
  // Callback function called while downloading and initializing (default: undefined)
  onProgress?: (event: ProgressEvent) => void;
  // Callback function that is called when mesh initialization is complete.
  // (default: undefined)
  onLoad?: (mesh: SplatMesh) => Promise<void> | void;
  // Controls whether SplatEdits have any effect on this mesh. (default: true)
  editable?: boolean;
  // Controls whether SplatMesh participates in Three.js raycasting (default: true)
  raycastable?: boolean;
  // Minimum opacity for raycasting splats. (default: 0.2)
  minRaycastOpacity?: number;
  // Callback function that is called every frame to update the mesh.
  // Call mesh.updateVersion() if splats need to be regenerated due to some change.
  // Calling updateVersion() is not necessary for object transformations, recoloring,
  // or opacity adjustments as these are auto-detected. (default: undefined)
  onFrame?: ({
    mesh,
    time,
    deltaTime,
  }: { mesh: SplatMesh; time: number; deltaTime: number }) => void;
  // Gsplat modifier to apply in object-space before any transformations.
  // A GsplatModifier is a dyno shader-graph block that transforms an input
  // gsplat: DynoVal<Gsplat> to an output gsplat: DynoVal<Gsplat> with gsplat.center
  // coordinate in object-space. (default: undefined)
  objectModifier?: GsplatModifier;
  objectModifiers?: GsplatModifier[];
  // Gsplat modifier to apply in world-space after transformations.
  // (default: undefined)
  worldModifier?: GsplatModifier;
  worldModifiers?: GsplatModifier[];
  covObjectModifiers?: CovSplatModifier[];
  covWorldModifiers?: CovSplatModifier[];
  // Override the default splat encoding ranges for the PackedSplats.
  // (default: undefined)
  splatEncoding?: SplatEncoding;
  // Set to true to load/use "extended splat" encoding with float32 x/y/z
  extSplats?: boolean | ExtSplats;
  // Set to true to output covariance splats for anisotropic scaling
  covSplats?: boolean;
};

export type SplatMeshContext = {
  transform: SplatTransformer;
  viewToWorld: SplatTransformer;
  worldToView: SplatTransformer;
  viewToObject: SplatTransformer;
  covTransform: CovSplatTransformer;
  covViewToWorld: CovSplatTransformer;
  covWorldToView: CovSplatTransformer;
  covViewToObject: CovSplatTransformer;
  recolor: DynoVec4<THREE.Vector4>;
  time: DynoFloat;
  deltaTime: DynoFloat;
  numSplats: DynoInt<string>;
  splats: SplatSource;
};

export interface SplatSource {
  prepareFetchSplat(): void;
  dispose(): void;

  getNumSplats(): number;
  hasRgbDir(): boolean;
  getNumSh(): number;
  setMaxSh(maxSh: number): void;

  fetchSplat({
    index,
    viewOrigin,
  }: { index: DynoVal<"int">; viewOrigin?: DynoVal<"vec3"> }): DynoVal<
    typeof Gsplat
  >;

  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ): void;
}

export class EmptySplatSource implements SplatSource {
  fetchDyno = new Dyno({
    inTypes: {},
    outTypes: { gsplat: Gsplat },
    globals: () => [defineGsplat],
    statements: ({ outputs }) =>
      unindentLines(`
      ${outputs.gsplat}.flags = 0u;
      return;
    `),
  }).outputs.gsplat;

  prepareFetchSplat() {}
  dispose() {}

  getNumSplats() {
    return 0;
  }
  hasRgbDir() {
    return false;
  }
  getNumSh() {
    return 0;
  }
  setMaxSh(maxSh: number) {}

  fetchSplat({ index }: { index: DynoVal<"int"> }): DynoVal<typeof Gsplat> {
    return this.fetchDyno;
  }

  forEachSplat() {}
}

export class SplatMesh extends SplatGenerator {
  // A Promise<SplatMesh> you can await to ensure fetching, parsing,
  // and initialization has completed
  initialized: Promise<SplatMesh>;
  // A boolean indicating whether initialization is complete
  isInitialized = false;

  // If you modify packedSplats you should set
  // splatMesh.packedSplats.needsUpdate = true to signal to Three.js that it
  // should re-upload the data to the underlying texture. Use this sparingly with
  // objects with smaller Gsplat counts as it requires a CPU-GPU data transfer for
  // each frame. Thousands to tens of thousands of Gsplats is fine. (See hands.ts
  // for an example of rendering "Gsplat hands" in WebXR using this technique.)
  packedSplats?: PackedSplats;
  extSplats?: ExtSplats;
  covSplats: boolean;
  splats?: SplatSource;
  lastSplats?: SplatSource;

  // A THREE.Color that can be used to tint all splats in the mesh.
  // (default: new THREE.Color(1, 1, 1))
  recolor: THREE.Color = new THREE.Color(1, 1, 1);
  // Global opacity multiplier for all splats in the mesh. (default: 1)
  opacity = 1;

  // A SplatMeshContext consisting of useful scene and object dyno uniforms that can
  // be used to in the Gsplat processing pipeline, for example via objectModifier and
  // worldModifier. (created on construction)
  context: SplatMeshContext;
  onFrame?: ({
    mesh,
    time,
    deltaTime,
  }: { mesh: SplatMesh; time: number; deltaTime: number }) => void;
  generatorDirty = true;
  private generatorSortDirty = true;

  objectModifiers?: GsplatModifier[];
  worldModifiers?: GsplatModifier[];
  covObjectModifiers?: CovSplatModifier[];
  covWorldModifiers?: CovSplatModifier[];
  // Set to true to have the viewToObject property in context be updated each frame.
  // If the mesh has extra.sh1 (first order spherical harmonics directional lighting)
  // this property will always be updated. (default: false)
  enableViewToObject = false;
  // Set to true to have context.viewToWorld updated each frame. (default: false)
  enableViewToWorld = false;
  // Set to true to have context.worldToView updated each frame. (default: false)
  enableWorldToView = false;

  // Optional SplatSkinning instance for animating splats with dual-quaternion
  // skeletal animation. (default: null)
  skinning: SplatSkinning | null = null;

  // Optional list of SplatEdits to apply to the mesh. If null, any SplatEdit
  // children in the scene graph will be added automatically. (default: null)
  edits: SplatEdit[] | null = null;
  editable: boolean;
  raycastable: boolean;
  minRaycastOpacity: number;
  // Compiled SplatEdits for applying SDF edits to splat RGBA + centers
  rgbaDisplaceEdits: SplatEdits | null = null;
  // Optional RgbaArray to overwrite splat RGBA values with custom values.
  // Useful for "baking" RGB and opacity edits into the SplatMesh. (default: null)
  splatRgba: RgbaArray | null = null;

  // Maximum Spherical Harmonics level to use. Call updateGenerator()
  // after changing. (default: 3)
  maxSh = 3;

  constructor(options: SplatMeshOptions = {}) {
    super({
      update: (context) => this.update(context),
    });

    if (options.splats) {
      this.splats = options.splats;
      this.numSplats = options.splats.getNumSplats();
    } else if (options.extSplats) {
      this.extSplats =
        options.extSplats instanceof ExtSplats
          ? options.extSplats
          : new ExtSplats();
      options.extSplats = this.extSplats;
      this.numSplats = this.extSplats.numSplats;
      this.splats = this.extSplats;
    } else if (options.packedSplats) {
      this.packedSplats = options.packedSplats;
      this.packedSplats.splatEncoding = options.splatEncoding ?? {
        ...DEFAULT_SPLAT_ENCODING,
      };
      this.splats = this.packedSplats;
    } else {
      this.packedSplats = new PackedSplats();
    }

    this.editable = options.editable ?? true;
    this.raycastable = options.raycastable ?? true;
    this.minRaycastOpacity = options.minRaycastOpacity ?? 0.2;
    this.onFrame = options.onFrame;

    this.context = {
      transform: new SplatTransformer(),
      viewToWorld: new SplatTransformer(),
      worldToView: new SplatTransformer(),
      viewToObject: new SplatTransformer(),
      covTransform: new CovSplatTransformer(),
      covViewToWorld: new CovSplatTransformer(),
      covWorldToView: new CovSplatTransformer(),
      covViewToObject: new CovSplatTransformer(),
      recolor: new DynoVec4({
        value: new THREE.Vector4().setScalar(Number.NEGATIVE_INFINITY),
      }),
      time: new DynoFloat({ value: 0 }),
      deltaTime: new DynoFloat({ value: 0 }),
      numSplats: new DynoInt({ value: 0 }),
      splats: new EmptySplatSource(),
    };

    this.covSplats = options.covSplats ?? false;
    if (this.covSplats && !this.extSplats) {
      throw new Error("CovSplats requires ExtSplats");
    }

    this.objectModifiers = options.objectModifier
      ? [options.objectModifier]
      : undefined;
    this.worldModifiers = options.worldModifier
      ? [options.worldModifier]
      : undefined;

    if (options.objectModifiers) {
      this.objectModifiers = options.objectModifiers;
    }
    if (options.worldModifiers) {
      this.worldModifiers = options.worldModifiers;
    }

    this.updateGenerator();

    if (
      options.url ||
      options.fileBytes ||
      options.stream ||
      options.constructSplats ||
      (options.packedSplats && !options.packedSplats.isInitialized) ||
      (this.extSplats && !this.extSplats.isInitialized)
    ) {
      // We need to initialize asynchronously given the options
      this.initialized = this.asyncInitialize(options).then(async () => {
        this.updateGenerator();

        this.isInitialized = true;
        if (options.onLoad) {
          const maybePromise = options.onLoad(this);
          if (maybePromise instanceof Promise) {
            await maybePromise;
          }
        }
        return this;
      });
    } else {
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
      if (options.onLoad) {
        const maybePromise = options.onLoad(this);
        // If onLoad returns a promise, wait for it to complete
        if (maybePromise instanceof Promise) {
          this.initialized = maybePromise.then(() => this);
        }
      }
    }
  }

  async asyncInitialize(options: SplatMeshOptions) {
    const {
      url,
      fileBytes,
      fileType,
      fileName,
      stream,
      streamLength,
      maxSplats,
      constructSplats,
      onProgress,
      splatEncoding,
    } = options;
    if (this.packedSplats) {
      if (url || fileBytes || stream || constructSplats) {
        const packedSplatsOptions = {
          url,
          fileBytes,
          fileType,
          fileName,
          stream,
          streamLength,
          maxSplats,
          construct: constructSplats,
          onProgress,
          splatEncoding,
        };
        this.packedSplats.reinitialize(packedSplatsOptions);
      }
      await this.packedSplats.initialized;
      this.splats = this.packedSplats;
    } else if (this.extSplats) {
      if (url || fileBytes || stream || constructSplats) {
        const construct = constructSplats as
          | ((splats: ExtSplats) => Promise<void>)
          | undefined;
        this.extSplats.reinitialize({
          url,
          fileBytes,
          fileType,
          fileName,
          stream,
          streamLength,
          maxSplats,
          construct,
          onProgress,
        });
        await this.extSplats.initialized;
        this.splats = this.extSplats;
      }
    }

    if (this.splats) {
      this.numSplats = this.splats.getNumSplats();
      this.updateGenerator();
    }
  }

  static staticInitialized = SplatMesh.staticInitialize();
  static isStaticInitialized = false;

  static dynoTime = new DynoFloat({ value: 0 });

  static async staticInitialize() {
    await init_wasm();
    SplatMesh.isStaticInitialized = true;
  }

  // Creates a new Gsplat with the provided parameters (all values in "float" space,
  // i.e. 0-1 for opacity and color) and adds it to the end of the packedSplats,
  // increasing numSplats by 1. If necessary, reallocates the buffer with an exponential
  // doubling strategy to fit the new data, so it's fairly efficient to just
  // pushSplat(...) each Gsplat you want to create in a loop.
  pushSplat(
    center: THREE.Vector3,
    scales: THREE.Vector3,
    quaternion: THREE.Quaternion,
    opacity: number,
    color: THREE.Color,
  ) {
    if (this.packedSplats) {
      this.packedSplats.pushSplat(center, scales, quaternion, opacity, color);
    } else if (this.extSplats) {
      this.extSplats.pushSplat(center, scales, quaternion, opacity, color);
    }
  }

  // This method iterates over all Gsplats in this instance's packedSplats,
  // invoking the provided callback with index: number in 0..=(this.numSplats-1) and
  // center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion,
  // opacity: number (0..1), and color: THREE.Color (rgb values in 0..1).
  // Note that the objects passed in as center etc. are the same for every callback
  // invocation: these objects are reused for efficiency. Changing these values has
  // no effect as they are decoded/unpacked copies of the underlying data. To update
  // the packedSplats, call .packedSplats.setSplat(index, center, scales,
  // quaternion, opacity, color).
  forEachSplat(
    callback: (
      index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      opacity: number,
      color: THREE.Color,
    ) => void,
  ) {
    this.splats?.forEachSplat(callback);
  }

  // Call this when you are finished with the SplatMesh and want to free
  // any buffers it holds (via packedSplats).
  dispose() {
    if (
      this.splats &&
      this.splats !== this.packedSplats &&
      this.splats !== this.extSplats
    ) {
      this.splats.dispose();
      this.splats = undefined;
    }
    if (this.packedSplats) {
      this.packedSplats.dispose();
      this.packedSplats = undefined;
    }
    if (this.extSplats) {
      this.extSplats.dispose();
      this.extSplats = undefined;
    }
  }

  // Returns axis-aligned bounding box of the SplatMesh. If centers_only is true,
  // only the centers of the splats are used to compute the bounding box.
  // IMPORTANT: This should only be called after the SplatMesh is initialized.
  getBoundingBox(centers_only = true) {
    if (!this.initialized) {
      throw new Error(
        "Cannot get bounding box before SplatMesh is initialized",
      );
    }
    const minVec = new THREE.Vector3(
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    );
    const maxVec = new THREE.Vector3(
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    );
    const corners = new THREE.Vector3();
    const signs = [-1, 1];

    function callback(
      _index: number,
      center: THREE.Vector3,
      scales: THREE.Vector3,
      quaternion: THREE.Quaternion,
      _opacity: number,
      _color: THREE.Color,
    ) {
      if (centers_only) {
        minVec.min(center);
        maxVec.max(center);
      } else {
        // Get the 8 corners of the AABB in local space
        for (const x of signs) {
          for (const y of signs) {
            for (const z of signs) {
              corners.set(x * scales.x, y * scales.y, z * scales.z);
              // Transform corner by rotation and position
              corners.applyQuaternion(quaternion);
              corners.add(center);
              minVec.min(corners);
              maxVec.max(corners);
            }
          }
        }
      }
    }

    this.splats?.forEachSplat(callback);
    const box = new THREE.Box3(minVec, maxVec);
    return box;
  }

  set objectModifier(modifier: GsplatModifier | undefined) {
    if (modifier) {
      this.objectModifiers = [modifier];
    } else {
      this.objectModifiers = undefined;
    }
  }

  set worldModifier(modifier: GsplatModifier | undefined) {
    if (modifier) {
      this.worldModifiers = [modifier];
    } else {
      this.worldModifiers = undefined;
    }
  }

  private constructGenerator(context: SplatMeshContext) {
    if (this.covSplats) {
      return this.constructCovGenerator(context);
    }

    const { transform, viewToObject, recolor } = context;
    const generator = dynoBlock(
      { index: "int" },
      { gsplat: Gsplat, splatShape: "float" },
      ({ index }) => {
        if (!index) {
          throw new Error("index is undefined");
        }

        // Read a Gsplat from the SplatSource
        context.splats.setMaxSh(this.maxSh);
        context.splats.prepareFetchSplat();
        let gsplat = context.splats.fetchSplat({
          index,
          viewOrigin: viewToObject.translate,
        });

        if (this.splatRgba) {
          // Overwrite RGBA with baked RGBA values
          gsplat = maybeInjectSplatRgba(gsplat, this.splatRgba.dyno, index);
        }

        if (this.skinning) {
          // Transform according to bones + skinning weights
          gsplat = this.skinning.modify(gsplat);
        }

        if (this.objectModifiers) {
          // Inject object-space Gsplat modifier dyno
          for (const modifier of this.objectModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }

        // Transform from object to world-space
        gsplat = transform.applyGsplat(gsplat);

        // Preserve shape codes encoded in alpha before applying mesh opacity,
        // SDF edits, or world-space modifiers. Downstream opacity processing
        // operates on the decoded 0..1 alpha value.
        const splatShape = splitGsplat(gsplat).outputs.opacity;
        gsplat = combineGsplat({
          gsplat,
          opacity: min(splatShape, dynoConst("float", 1)),
        });

        // Apply any global recoloring and opacity
        const recolorRgba = mul(recolor, splitGsplat(gsplat).outputs.rgba);
        gsplat = combineGsplat({ gsplat, rgba: recolorRgba });

        if (this.rgbaDisplaceEdits) {
          // Apply RGBA edit layer SDFs
          gsplat = this.rgbaDisplaceEdits.modify(gsplat);
        }

        if (this.worldModifiers) {
          // Inject world-space Gsplat modifier dyno
          for (const modifier of this.worldModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }

        // We're done! Output resulting Gsplat
        return { gsplat, splatShape };
      },
    );
    this.generator = generator;
    this.covGenerator = undefined;
    this.splatShape = generator.outputs.splatShape;
  }

  constructCovGenerator(context: SplatMeshContext) {
    // console.log("CovSplatMesh.constructCovGenerator");
    const { covTransform, covViewToObject, recolor } = context;
    const generator = dynoBlock(
      { index: "int" },
      { covsplat: CovSplat, splatShape: "float" },
      ({ index }) => {
        if (!index) {
          throw new Error("index is undefined");
        }

        // Read a Gsplat from the SplatSource
        context.splats.prepareFetchSplat();
        let gsplat = context.splats.fetchSplat({
          index,
          viewOrigin: covViewToObject.offset,
        });

        if (this.splatRgba) {
          // Overwrite RGBA with baked RGBA values
          gsplat = maybeInjectSplatRgba(gsplat, this.splatRgba.dyno, index);
        }

        if (this.objectModifiers) {
          // Inject object-space Gsplat modifier dyno
          for (const modifier of this.objectModifiers) {
            gsplat = modifier.apply({ gsplat }).gsplat;
          }
        }

        let covsplat = gsplatToCovSplat(gsplat);

        if (this.skinning) {
          // Transform according to bones + skinning weights
          covsplat = this.skinning.modifyCov(covsplat);
        }

        if (this.covObjectModifiers) {
          // Inject object-space CovSplat modifier dyno
          for (const modifier of this.covObjectModifiers) {
            covsplat = modifier.apply({ covsplat }).covsplat;
          }
        }

        // Transform from object to world-space
        covsplat = covTransform.applyCovSplat(covsplat);

        // Preserve shape codes encoded in alpha before applying mesh opacity,
        // SDF edits, or world-space modifiers. Downstream opacity processing
        // operates on the decoded 0..1 alpha value.
        const splatShape = splitCovSplat(covsplat).outputs.opacity;
        covsplat = combineCovSplat({
          covsplat,
          opacity: min(splatShape, dynoConst("float", 1)),
        });

        // Apply any global recoloring and opacity
        const recolorRgba = mul(recolor, splitCovSplat(covsplat).outputs.rgba);
        covsplat = combineCovSplat({ covsplat, rgba: recolorRgba });

        if (this.rgbaDisplaceEdits) {
          // Apply RGBA edit layer SDFs
          covsplat = this.rgbaDisplaceEdits.modifyCov(covsplat);
        }

        if (this.covWorldModifiers) {
          // Inject world-space CovSplat modifier dyno
          for (const modifier of this.covWorldModifiers) {
            covsplat = modifier.apply({ covsplat }).covsplat;
          }
        }

        // We're done! Output resulting Gsplat
        return { covsplat, splatShape };
      },
    );
    this.generator = undefined;
    this.covGenerator = generator;
    this.splatShape = generator.outputs.splatShape;
  }

  // Call this whenever something changes in the Gsplat processing pipeline,
  // for example changing maxSh or updating objectModifier or worldModifier.
  // Compiled generators are cached for efficiency and re-use when the same
  // pipeline structure emerges after successive changes.
  updateGenerator() {
    this.generatorDirty = true;
    this.generatorSortDirty = true;
  }

  // This is called automatically by SparkRenderer and you should not have to
  // call it. It updates parameters for the generated pipeline and calls
  // updateGenerator() if the pipeline needs to change.
  update({
    renderer,
    time,
    deltaTime,
    viewToWorld,
    camera,
    renderSize,
    globalEdits,
  }: FrameUpdateContext) {
    this.context.time.value = time;
    this.context.deltaTime.value = deltaTime;
    SplatMesh.dynoTime.value = time;

    const splats = this.splats ?? this.packedSplats ?? this.extSplats;
    if (splats) {
      this.context.splats = splats;
    }
    this.numSplats = this.context.splats.getNumSplats();

    let updated = false;
    let sortUpdated = false;

    this.context.numSplats.value = this.numSplats;

    if (this.context.splats !== this.lastSplats) {
      this.lastSplats = this.context.splats;
      this.generatorDirty = true;
      this.generatorSortDirty = true;
    }

    if (!this.covSplats) {
      if (this.context.transform.update(this)) {
        updated = true;
        sortUpdated = true;
      }

      if (
        this.context.viewToWorld.updateFromMatrix(viewToWorld) &&
        this.enableViewToWorld
      ) {
        updated = true;
        sortUpdated = true;
      }
      const worldToView = viewToWorld.clone().invert();
      if (
        this.context.worldToView.updateFromMatrix(worldToView) &&
        this.enableWorldToView
      ) {
        updated = true;
        sortUpdated = true;
      }

      const objectToWorld = new THREE.Matrix4().compose(
        this.context.transform.translate.value,
        this.context.transform.rotate.value,
        new THREE.Vector3().setScalar(this.context.transform.scale.value),
      );
      const worldToObject = objectToWorld.invert();
      const viewToObjectMatrix = worldToObject.multiply(viewToWorld);
      if (
        this.context.viewToObject.updateFromMatrix(viewToObjectMatrix) &&
        (this.enableViewToObject || this.context.splats.hasRgbDir())
      ) {
        // Only trigger update if we have view-dependent spherical harmonics
        updated = true;
        // Directional RGB alone is appearance-only, but a custom
        // viewToObject modifier may also change generated centers.
        sortUpdated ||= this.enableViewToObject;
      }
    } else {
      if (this.context.covTransform.update(this)) {
        updated = true;
        sortUpdated = true;
      }

      if (
        this.context.covViewToWorld.updateFromMatrix(viewToWorld) &&
        this.enableViewToWorld
      ) {
        updated = true;
        sortUpdated = true;
      }
      const worldToView = viewToWorld.clone().invert();
      if (
        this.context.covWorldToView.updateFromMatrix(worldToView) &&
        this.enableWorldToView
      ) {
        updated = true;
        sortUpdated = true;
      }

      const worldToObject = this.matrixWorld.clone().invert();
      const viewToObjectMatrix = worldToObject.multiply(viewToWorld);
      if (
        this.context.covViewToObject.updateFromMatrix(viewToObjectMatrix) &&
        (this.enableViewToObject || this.context.splats.hasRgbDir())
      ) {
        // Only trigger update if we have view-dependent spherical harmonics
        updated = true;
        sortUpdated ||= this.enableViewToObject;
      }
    }

    const newRecolor = new THREE.Vector4(
      this.recolor.r,
      this.recolor.g,
      this.recolor.b,
      this.opacity,
    );
    if (!newRecolor.equals(this.context.recolor.value)) {
      this.context.recolor.value.copy(newRecolor);
      updated = true;
    }

    const edits = this.editable ? (this.edits ?? []).concat(globalEdits) : [];
    if (this.editable && !this.edits) {
      // If we haven't set any explicit edits, add any child SplatEdits
      this.traverseVisible((node) => {
        if (node instanceof SplatEdit) {
          edits.push(node);
        }
      });
    }

    edits.sort((a, b) => a.ordering - b.ordering);
    const editsSdfs = edits.map((edit) => {
      if (edit.sdfs != null) {
        return { edit, sdfs: edit.sdfs };
      }
      const sdfs: SplatEditSdf[] = [];
      edit.traverseVisible((node) => {
        if (node instanceof SplatEditSdf) {
          sdfs.push(node);
        }
      });
      return { edit, sdfs };
    });

    if (editsSdfs.length > 0 && !this.rgbaDisplaceEdits) {
      const edits = editsSdfs.length;
      const sdfs = editsSdfs.reduce(
        (total, edit) => total + edit.sdfs.length,
        0,
      );
      this.rgbaDisplaceEdits = new SplatEdits({
        maxEdits: edits,
        maxSdfs: sdfs,
      });
      this.generatorDirty = true;
    }
    if (this.rgbaDisplaceEdits) {
      const editResult = this.rgbaDisplaceEdits.update(editsSdfs);
      updated ||= editResult.updated;
      sortUpdated ||= editResult.positionUpdated;
      if (editResult.dynoUpdated) {
        this.generatorDirty = true;
        this.generatorSortDirty ||= editResult.positionUpdated;
      }
    }

    if (this.generatorDirty) {
      this.constructGenerator(this.context);
      this.generatorDirty = false;
      updated = true;
      sortUpdated ||= this.generatorSortDirty;
      this.generatorSortDirty = false;
    }

    if (updated) {
      this.updateVersion({ sort: sortUpdated });
    }

    this.onFrame?.({ mesh: this, time, deltaTime });
  }

  // This method conforms to the standard THREE.Raycaster API, performing object-ray
  // intersections using this method to populate the provided intersects[] array
  // with each intersection point.
  raycast(
    raycaster: THREE.Raycaster,
    intersects: {
      distance: number;
      point: THREE.Vector3;
      object: THREE.Object3D;
    }[],
  ) {
    if (
      !SplatMesh.isStaticInitialized ||
      !this.raycastable ||
      (!this.packedSplats && !this.extSplats)
    ) {
      return;
    }
    const ext = this.extSplats != null;

    const { near, far, ray } = raycaster;
    const worldToMesh = this.matrixWorld.clone().invert();
    const worldToMeshRot = new THREE.Matrix3().setFromMatrix4(worldToMesh);
    const origin = ray.origin.clone().applyMatrix4(worldToMesh);
    const direction = ray.direction.clone().applyMatrix3(worldToMeshRot);

    const buffer = get_raycast_buffer();
    const bufferSize = buffer.length / 4;
    let intersections = 0;

    const numSplats = this.context.numSplats.value ?? 0;

    if (!ext) {
      const packed = this.packedSplats?.packedArray;
      if (!packed) {
        return;
      }
      const splatEncoding = this.packedSplats?.splatEncoding;
      for (let base = 0; base < numSplats; base += bufferSize) {
        const count = Math.min(bufferSize, numSplats - base);
        buffer.set(packed.subarray(base * 4, (base + count) * 4));

        const newIntersections = raycast_packed_buffer(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          this.minRaycastOpacity,
          near,
          far,
          count,
          splatEncoding?.lnScaleMin ?? LN_SCALE_MIN,
          splatEncoding?.lnScaleMax ?? LN_SCALE_MAX,
        );
        intersections = this.appendRaycastBuffer(
          intersections,
          newIntersections,
        );
      }
    } else {
      const buffer2 = get_raycast_buffer2();
      const ext1 = this.extSplats?.extArrays[0];
      const ext2 = this.extSplats?.extArrays[1];
      if (!ext1 || !ext2) {
        return;
      }
      for (let base = 0; base < numSplats; base += bufferSize) {
        const count = Math.min(bufferSize, numSplats - base);
        buffer.set(ext1.subarray(base * 4, (base + count) * 4));
        buffer2.set(ext2.subarray(base * 4, (base + count) * 4));

        const newIntersections = raycast_ext_buffers(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          this.minRaycastOpacity,
          near,
          far,
          count,
        );
        intersections = this.appendRaycastBuffer(
          intersections,
          newIntersections,
        );
      }
    }

    for (const distance of SplatMesh.raycastBuffer.subarray(0, intersections)) {
      const point = ray.direction
        .clone()
        .multiplyScalar(distance)
        .add(ray.origin);
      intersects.push({
        distance,
        point,
        object: this,
      });
    }
  }

  static raycastBuffer = new Float32Array(1024);

  private appendRaycastBuffer(count: number, additional: Float32Array) {
    const total = count + additional.length;
    let capacity = SplatMesh.raycastBuffer.length;

    if (total > capacity) {
      while (capacity < total) {
        capacity *= 2;
      }
      const newBuffer = new Float32Array(capacity);
      newBuffer.set(SplatMesh.raycastBuffer.subarray(0, count));
      SplatMesh.raycastBuffer = newBuffer;
    }

    SplatMesh.raycastBuffer.set(additional, count);
    return count + additional.length;
  }
}

export function maybeInjectSplatRgba(
  gsplat: DynoVal<typeof Gsplat>,
  rgba: DynoVal<typeof TRgbaArray>,
  index: DynoVal<"int">,
): DynoVal<typeof Gsplat> {
  return dyno({
    inTypes: {
      gsplat: Gsplat,
      rgba: TRgbaArray,
      index: "int",
    },
    outTypes: { gsplat: Gsplat },
    inputs: { gsplat, rgba, index },
    statements: ({ inputs, outputs }) =>
      unindentLines(`
        ${outputs.gsplat} = ${inputs.gsplat};
        if ((${inputs.index} >= 0) && (${inputs.index} < ${inputs.rgba}.count)) {
          ${outputs.gsplat}.rgba = texelFetch(${inputs.rgba}.texture, splatTexCoord(${inputs.index}), 0);
        }
      `),
  }).outputs.gsplat;
}
