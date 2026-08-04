import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { Readback } from "./Readback";
import { SplatEdit } from "./SplatEdit";
import {
  type CovSplatGenerator,
  type GsplatGenerator,
  SplatGenerator,
} from "./SplatGenerator";
import { SplatMesh } from "./SplatMesh";
import {
  LN_SCALE_MAX,
  LN_SCALE_MIN,
  SPLAT_TEX_HEIGHT,
  SPLAT_TEX_WIDTH,
} from "./defines";
import {
  type CovSplat,
  Dyno,
  DynoBool,
  DynoProgram,
  DynoProgramTemplate,
  DynoUsampler2DArray,
  type DynoVal,
  DynoVec3,
  combineCovSplat,
  combineGsplat,
  dynoBlock,
  dynoConst,
  gsplatToCovSplat,
  min,
  mul,
  outputCovSplat,
  outputCovSplatDepth,
  outputExtCovSplat,
  outputExtendedSplat,
  outputPackedSplat,
  outputSplatDepth,
  outputSplatShape,
  splitCovSplat,
  splitGsplat,
  sub,
  unindentLines,
} from "./dyno";
import { getShaders } from "./shaders";
import { getTextureSize, threeMrtArray } from "./utils";

// A GeneratorMapping describes a Gsplat range that was generated, including
// which generator and its version number.
export type GeneratorMapping = {
  node: SplatGenerator;
  generator?: GsplatGenerator;
  covGenerator?: CovSplatGenerator;
  splatShape?: DynoVal<"float">;
  version: number;
  sortVersion: number;
  mappingVersion?: number;
  base: number;
  count: number;
};

export class SplatAccumulator {
  time = 0;
  deltaTime = 0;
  viewToWorld = new THREE.Matrix4();
  viewOrigin = new THREE.Vector3();
  viewDirection = new THREE.Vector3();
  static viewCenterUniform = new DynoVec3({ value: new THREE.Vector3() });
  static viewDirUniform = new DynoVec3({ value: new THREE.Vector3() });
  static sortRadialUniform = new DynoBool({ value: true });
  maxSplats = 0;
  numSplats = 0;
  target: THREE.WebGLArrayRenderTarget | null = null;
  mapping: GeneratorMapping[] = [];
  version = -1;
  mappingVersion = -1;
  extSplats: boolean;
  covSplats: boolean;
  readback: Readback | null = null;
  readbackSplats: DynoUsampler2DArray<"extSplats", THREE.DataArrayTexture>[] =
    [];

  constructor({
    extSplats,
    covSplats,
  }: { extSplats?: boolean; covSplats?: boolean } = {}) {
    if (!threeMrtArray) {
      throw new Error("Spark requires THREE.js r179 or above");
    }
    this.extSplats = extSplats ?? true;
    this.covSplats = covSplats ?? false;
  }

  dispose() {
    if (this.target) {
      this.target.dispose();
      this.target = null;
    }
  }

  // Returns the accumulator's splat, depth, and shape data array textures.
  // The final R8 texture stores the special per-splat shape amount above 1.
  getTextures(): THREE.DataArrayTexture[] {
    if (this.target) {
      return this.target.textures;
    }
    return SplatAccumulator.emptyTextures;
  }

  getSplatShapeTexture(): THREE.DataArrayTexture {
    return (
      this.target?.textures[this.extSplats ? 3 : 2] ??
      SplatAccumulator.emptySplatShape
    );
  }

  static emptyTexture = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint32Array(maxSplats * 4);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptySplatShape = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint8Array(maxSplats);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.internalFormat = "R8";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyTextures = (() => {
    return [SplatAccumulator.emptyTexture, SplatAccumulator.emptyTexture];
  })();

  // Given an array of splatCounts (.numSplats for each
  // SplatGenerator/SplatMesh in the scene), compute a
  // "mapping layout" in the composite array of generated outputs.
  generateMapping(splatCounts: number[]): {
    maxSplats: number;
    mapping: { base: number; count: number }[];
  } {
    let maxSplats = 0;
    const mapping = splatCounts.map((numSplats) => {
      const base = maxSplats;
      // Generation happens in horizontal row chunks, so round up to full width
      const rounded = Math.ceil(numSplats / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
      maxSplats += rounded;
      return { base, count: numSplats };
    });
    return { maxSplats, mapping };
  }

  // Ensures our NewSplatAccumulator.target render target has enough space
  // to generate maxSplats total Gsplats, and reallocate if not large enough.
  ensureGenerate({ maxSplats }: { maxSplats: number }) {
    if (this.target && (maxSplats ?? 1) <= this.maxSplats) {
      return false;
    }
    this.dispose();

    // The packed Gsplats are stored in a 2D array texture of max size
    // 2048 x 2048 x 2048, one RGBA32UI pixel = 4 uint32 = one Gsplat
    const textureSize = getTextureSize(maxSplats ?? 1);
    const { width, height, depth } = textureSize;
    this.maxSplats = textureSize.maxSplats;
    this.target = new THREE.WebGLArrayRenderTarget(width, height, depth, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      format: THREE.RGBAIntegerFormat,
      type: THREE.UnsignedIntType,
    });
    this.target.scissorTest = true;

    if (this.extSplats) {
      const target2 = this.target.texture.clone();
      const target3 = this.target.texture.clone();
      target3.format = THREE.RGBAFormat;
      target3.type = THREE.UnsignedByteType;
      target3.internalFormat = "RGBA8";
      const targetShape = target3.clone();
      targetShape.format = THREE.RedFormat;
      targetShape.internalFormat = "R8";
      this.target.textures = [
        this.target.texture,
        target2,
        target3,
        targetShape,
      ];
    } else {
      const target3 = this.target.texture.clone();
      target3.format = THREE.RGBAFormat;
      target3.type = THREE.UnsignedByteType;
      target3.internalFormat = "RGBA8";
      const targetShape = target3.clone();
      targetShape.format = THREE.RedFormat;
      targetShape.internalFormat = "R8";
      this.target.textures = [this.target.texture, target3, targetShape];
    }

    return true;
  }

  private saveRenderState(renderer: THREE.WebGLRenderer) {
    return {
      target: renderer.getRenderTarget(),
      activeCubeFace: renderer.getActiveCubeFace(),
      activeMipmapLevel: renderer.getActiveMipmapLevel(),
      xrEnabled: renderer.xr.enabled,
      autoClear: renderer.autoClear,
    };
  }

  private resetRenderState(
    renderer: THREE.WebGLRenderer,
    state: {
      target: THREE.WebGLRenderTarget | null;
      activeCubeFace: number;
      activeMipmapLevel: number;
      xrEnabled: boolean;
      autoClear: boolean;
    },
  ) {
    renderer.setRenderTarget(
      state.target,
      state.activeCubeFace,
      state.activeMipmapLevel,
    );
    renderer.xr.enabled = state.xrEnabled;
    renderer.autoClear = state.autoClear;
  }

  // Get a program and THREE.RawShaderMaterial for a given GsplatGenerator,
  // generating it if necessary and caching the result.
  prepareProgramMaterial(
    generator?: GsplatGenerator,
    covGenerator?: CovSplatGenerator,
    splatShape?: DynoVal<"float">,
  ) {
    const theGenerator = generator ?? covGenerator;
    if (!theGenerator) {
      throw new Error("Either generator or covGenerator must be provided");
    }

    const configKey = `${this.extSplats ? "ext" : "packed"}:${this.covSplats ? "cov" : "gsplat"}`;
    let configurations = SplatAccumulator.generatorProgram.get(theGenerator);
    let programs = configurations?.get(configKey);
    let program = programs?.get(splatShape);
    if (!program) {
      const graph = dynoBlock(
        { index: "int" },
        {},
        ({ index }, _outputs, { roots }) => {
          if (generator) {
            generator.inputs.index = index;
          }
          if (covGenerator) {
            covGenerator.inputs.index = index;
          }

          let outputGsplat = generator?.outputs.gsplat;
          let generatedCovSplat = covGenerator?.outputs.covsplat;
          let outputShape = splatShape;

          // Generic generators have no separately preserved shape output. In
          // that case their original alpha is the shape code, while their
          // conventional opacity is limited to the normal 0..1 range.
          if (!outputShape) {
            if (this.covSplats && generatedCovSplat) {
              const opacity = splitCovSplat(generatedCovSplat).outputs.opacity;
              outputShape = opacity;
              generatedCovSplat = combineCovSplat({
                covsplat: generatedCovSplat,
                opacity: min(opacity, dynoConst("float", 1)),
              });
            } else if (outputGsplat) {
              const opacity = splitGsplat(outputGsplat).outputs.opacity;
              outputShape = opacity;
              outputGsplat = combineGsplat({
                gsplat: outputGsplat,
                opacity: min(opacity, dynoConst("float", 1)),
              });
            } else if (generatedCovSplat) {
              const opacity = splitCovSplat(generatedCovSplat).outputs.opacity;
              outputShape = opacity;
              generatedCovSplat = combineCovSplat({
                covsplat: generatedCovSplat,
                opacity: min(opacity, dynoConst("float", 1)),
              });
            }
          }

          if (this.extSplats) {
            // Extended centers are float32, but they still need the same
            // camera-relative storage contract as packed centers. Keeping ECEF
            // world coordinates here would lose local precision before render.
            if (outputGsplat) {
              outputGsplat = combineGsplat({
                gsplat: outputGsplat,
                center: sub(
                  splitGsplat(outputGsplat).outputs.center,
                  SplatAccumulator.viewCenterUniform,
                ),
              });
            }
            if (generatedCovSplat) {
              generatedCovSplat = combineCovSplat({
                covsplat: generatedCovSplat,
                center: sub(
                  splitCovSplat(generatedCovSplat).outputs.center,
                  SplatAccumulator.viewCenterUniform,
                ),
              });
            }

            if (!this.covSplats) {
              if (outputGsplat) {
                const output = outputExtendedSplat(outputGsplat);
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            } else {
              if (generatedCovSplat) {
                const output = outputExtCovSplat(generatedCovSplat);
                roots.push(output);
              } else if (outputGsplat) {
                const covsplat = gsplatToCovSplat(outputGsplat);
                const output = outputExtCovSplat(covsplat);
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            }
          } else {
            if (!this.covSplats) {
              if (outputGsplat) {
                const centerSubView = sub(
                  splitGsplat(outputGsplat).outputs.center,
                  SplatAccumulator.viewCenterUniform,
                );
                // Store half alpha; the render shader restores the packed value.
                const halfAlpha = mul(
                  splitGsplat(outputGsplat).outputs.opacity,
                  dynoConst("float", 0.5),
                );
                const gsplat = combineGsplat({
                  gsplat: outputGsplat,
                  center: centerSubView,
                  opacity: halfAlpha,
                });
                const output = outputPackedSplat(
                  gsplat,
                  dynoConst("vec4", [0, 1, LN_SCALE_MIN, LN_SCALE_MAX]),
                );
                roots.push(output);
              } else {
                throw new Error("Generator must be provided");
              }
            } else {
              let covsplat: DynoVal<typeof CovSplat>;
              if (generatedCovSplat) {
                covsplat = generatedCovSplat;
              } else if (outputGsplat) {
                covsplat = gsplatToCovSplat(outputGsplat);
              } else {
                throw new Error("Generator must be provided");
              }
              const centerSubView = sub(
                splitCovSplat(covsplat).outputs.center,
                SplatAccumulator.viewCenterUniform,
              );
              const halfAlpha = mul(
                splitCovSplat(covsplat).outputs.opacity,
                dynoConst("float", 0.5),
              );
              covsplat = combineCovSplat({
                covsplat,
                center: centerSubView,
                opacity: halfAlpha,
              });
              const output = outputCovSplat(
                covsplat,
                dynoConst("vec4", [0, 1, LN_SCALE_MIN, LN_SCALE_MAX]),
              );
              roots.push(output);
            }
          }
          if (!outputShape) {
            throw new Error("Splat shape must be provided");
          }
          roots.push(outputSplatShape(outputShape));
          if (generator) {
            const outputDepth = outputSplatDepth(
              outputGsplat ?? generator.outputs.gsplat,
              this.extSplats
                ? dynoConst("vec3", [0, 0, 0])
                : SplatAccumulator.viewCenterUniform,
              SplatAccumulator.viewDirUniform,
              SplatAccumulator.sortRadialUniform,
            );
            roots.push(outputDepth);
          }
          if (covGenerator) {
            const outputDepth = outputCovSplatDepth(
              generatedCovSplat ?? covGenerator.outputs.covsplat,
              this.extSplats
                ? dynoConst("vec3", [0, 0, 0])
                : SplatAccumulator.viewCenterUniform,
              SplatAccumulator.viewDirUniform,
              SplatAccumulator.sortRadialUniform,
            );
            roots.push(outputDepth);
          }
          return undefined;
        },
      );
      program = new DynoProgram({
        graph,
        inputs: { index: "_index" },
        outputs: {},
        template: this.extSplats
          ? SplatAccumulator.programExtTemplate
          : SplatAccumulator.programTemplate,
        // consoleLog: true,
      });

      if (!programs) {
        programs = new Map();
        if (!configurations) {
          configurations = new Map();
          SplatAccumulator.generatorProgram.set(theGenerator, configurations);
        }
        configurations.set(configKey, programs);
      }
      programs.set(splatShape, program);
    }
    Object.assign(program.uniforms, {
      targetLayer: { value: 0 },
      targetBase: { value: 0 },
      targetCount: { value: 0 },
    });

    const material = program.prepareMaterial();
    SplatAccumulator.fullScreenQuad.material = material;
    return { program, material };
  }

  static programExtTemplate = new DynoProgramTemplate(
    getShaders().computeUvec4x2Vec4Template,
  );
  static programTemplate = new DynoProgramTemplate(
    getShaders().computeUvec4Vec4Template,
  );
  static generatorProgram = new WeakMap<
    GsplatGenerator | CovSplatGenerator,
    Map<string, Map<DynoVal<"float"> | undefined, DynoProgram>>
  >();
  static fullScreenQuad = new FullScreenQuad(
    new THREE.RawShaderMaterial({ visible: false }),
  );

  generate({
    generator,
    covGenerator,
    splatShape,
    base,
    count,
    renderer,
  }: {
    generator?: GsplatGenerator;
    covGenerator?: CovSplatGenerator;
    splatShape?: DynoVal<"float">;
    base: number;
    count: number;
    renderer: THREE.WebGLRenderer;
  }) {
    if (!this.target) {
      throw new Error("Target must be initialized with ensureGenerate");
    }
    if (base + count > this.maxSplats) {
      throw new Error("Base + count exceeds maxSplats");
    }

    const { program, material } = this.prepareProgramMaterial(
      generator,
      covGenerator,
      splatShape,
    );
    program.update();

    const renderState = this.saveRenderState(renderer);

    // Generate the Gsplats in "layer" chunks, in horizontal row ranges,
    // that cover the total count of Gsplats.
    const nextBase =
      Math.ceil((base + count) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH;
    const layerSize = SPLAT_TEX_WIDTH * SPLAT_TEX_HEIGHT;
    material.uniforms.targetBase.value = base;
    material.uniforms.targetCount.value = count;

    // Keep generating layers until we've reached the next generation's base
    while (base < nextBase) {
      const layer = Math.floor(base / layerSize);
      material.uniforms.targetLayer.value = layer;

      const layerBase = layer * layerSize;
      const layerYStart = Math.floor((base - layerBase) / SPLAT_TEX_WIDTH);
      const layerYEnd = Math.min(
        SPLAT_TEX_HEIGHT,
        Math.ceil((nextBase - layerBase) / SPLAT_TEX_WIDTH),
      );

      // Render the desired portion of the layer
      this.target.scissor.set(
        0,
        layerYStart,
        SPLAT_TEX_WIDTH,
        layerYEnd - layerYStart,
      );
      renderer.setRenderTarget(this.target, layer);
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      SplatAccumulator.fullScreenQuad.render(renderer);

      base += SPLAT_TEX_WIDTH * (layerYEnd - layerYStart);
    }

    this.resetRenderState(renderer, renderState);
    return { nextBase };
  }

  prepareGenerate({
    renderer,
    scene,
    timer,
    camera,
    sortRadial,
    renderSize,
    previous,
  }: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    timer: THREE.Timer;
    camera: THREE.Camera;
    sortRadial: boolean;
    renderSize: THREE.Vector2;
    previous: SplatAccumulator;
  }) {
    this.viewToWorld.copy(camera.matrixWorld);
    camera.getWorldPosition(this.viewOrigin);
    camera.getWorldDirection(this.viewDirection);
    SplatAccumulator.viewCenterUniform.value.copy(this.viewOrigin);
    SplatAccumulator.viewDirUniform.value.copy(this.viewDirection);
    SplatAccumulator.sortRadialUniform.value = sortRadial;

    this.time = timer.getElapsed();
    this.deltaTime = timer.getDelta();

    const allGenerators: SplatGenerator[] = [];
    scene.traverse((node) => {
      if (node instanceof SplatGenerator) {
        if (!camera.layers || camera.layers.test(node.layers)) {
          allGenerators.push(node);
        }
      }
    });

    const globalEditsSet = new Set<SplatEdit>();
    scene.traverseVisible((node) => {
      if (node instanceof SplatEdit) {
        let ancestor = node.parent;
        while (ancestor != null && !(ancestor instanceof SplatMesh)) {
          ancestor = ancestor.parent;
        }
        if (ancestor == null) {
          // Not part of a SplatMesh so it's a global edit
          globalEditsSet.add(node);
        }
      }
    });
    const globalEdits = Array.from(globalEditsSet);

    for (const object of allGenerators) {
      try {
        object.frameUpdate?.({
          renderer,
          object,
          time: this.time,
          deltaTime: this.deltaTime,
          viewToWorld: this.viewToWorld,
          camera,
          renderSize,
          globalEdits,
        });
      } catch (error) {
        console.error("frameUpdate error", error);
        object.generator = undefined;
        object.covGenerator = undefined;
        object.generatorError = error;
      }
    }

    const visibleGenerators: SplatGenerator[] = [];
    scene.traverseVisible((node) => {
      if (node instanceof SplatGenerator) {
        if (!camera.layers || camera.layers.test(node.layers)) {
          visibleGenerators.push(node);
        }
      }
    });

    const splatCounts = visibleGenerators.map(
      (generator) => generator.numSplats,
    );
    const { maxSplats, mapping: baseCounts } =
      this.generateMapping(splatCounts);

    const previousMappings = previous.mapping.reduce((mappings, mapping) => {
      mappings.set(mapping.node, mapping);
      return mappings;
    }, new Map<SplatGenerator, GeneratorMapping>());

    this.mapping = [];
    this.numSplats = 0;

    baseCounts.forEach(({ base, count }, index) => {
      const node = visibleGenerators[index];
      const previousNode = previousMappings.get(node);
      if (previousNode && previousNode.count !== node.numSplats) {
        node.updateMappingVersion();
      }

      const { generator, covGenerator, splatShape } = node;
      if ((generator || covGenerator) && count > 0) {
        const { version, sortVersion, mappingVersion } = node;
        this.mapping.push({
          node,
          generator,
          covGenerator,
          splatShape,
          version,
          sortVersion,
          mappingVersion,
          base,
          count,
        });
        this.numSplats = Math.max(this.numSplats, base + count);
      }
    });
    const { splatsUpdated, mappingUpdated, sortUpdated } =
      previous.checkVersions(this.mapping);
    this.version = previous.version + (splatsUpdated ? 1 : 0);
    this.mappingVersion = previous.mappingVersion + (mappingUpdated ? 1 : 0);

    return {
      sameMapping: !mappingUpdated,
      version: this.version,
      mappingVersion: this.mappingVersion,
      sortUpdated,
      visibleGenerators,
      generate: () => {
        this.ensureGenerate({ maxSplats });

        for (const { generator, covGenerator, splatShape, base, count } of this
          .mapping) {
          if ((generator || covGenerator) && count > 0) {
            this.generate({
              generator,
              covGenerator,
              splatShape,
              base,
              count,
              renderer,
            });
          }
        }
      },
      readback: async () => {
        const textures = this.getTextures();
        if (this.readbackSplats.length === 0) {
          this.readbackSplats = [
            new DynoUsampler2DArray({ value: textures[0], key: "extSplats" }),
            new DynoUsampler2DArray({ value: textures[1], key: "extSplats" }),
          ];
        }
        this.readbackSplats[0].value = textures[0];
        this.readbackSplats[1].value = textures[1];

        if (!this.readback) {
          this.readback = new Readback({ renderer });
        }
        const readback = this.readback;
        const words = this.extSplats ? 8 : 4;
        const array = readback.ensureBuffer(
          this.numSplats * words,
          new Uint32Array(0),
        );

        const reader = dynoBlock(
          { index: "int" },
          { rgba8: "vec4" },
          ({ index }) => {
            const rgba8 = new Dyno({
              inTypes: {
                index: "int",
                extSplats1: "usampler2DArray",
                extSplats2: "usampler2DArray",
              },
              outTypes: { rgba8: "vec4" },
              inputs: {
                index,
                extSplats1: this.readbackSplats[0],
                extSplats2: this.readbackSplats[1],
              },
              statements: ({ inputs, outputs }) => {
                if (this.extSplats) {
                  return unindentLines(`
                    int indexDiv8 = ${inputs.index} >> 3;
                    ivec3 coord = splatTexCoord(indexDiv8);
                    uvec4 packedData;
                    if ((${inputs.index} & 4) == 0) {
                      packedData = texelFetch(${inputs.extSplats1}, coord, 0);
                    } else {
                      packedData = texelFetch(${inputs.extSplats2}, coord, 0);
                    }

                    int indexMod4 = ${inputs.index} & 3;
                    uint data = (indexMod4 == 0) ? packedData.x
                      : (indexMod4 == 1) ? packedData.y
                      : (indexMod4 == 2) ? packedData.z
                      : packedData.w;
                    ${outputs.rgba8} = uintToVec4(data);
                  `);
                }
                return unindentLines(`
                  int indexDiv4 = ${inputs.index} >> 2;
                  ivec3 coord = splatTexCoord(indexDiv4);
                  uvec4 packedData = texelFetch(${inputs.extSplats1}, coord, 0);

                  int indexMod4 = ${inputs.index} & 3;
                  uint data = (indexMod4 == 0) ? packedData.x
                    : (indexMod4 == 1) ? packedData.y
                    : (indexMod4 == 2) ? packedData.z
                    : packedData.w;
                  ${outputs.rgba8} = uintToVec4(data);
                `);
              },
            }).outputs.rgba8;
            return { rgba8 };
          },
        );

        return await readback.renderReadback({
          reader,
          count: this.numSplats * words,
          renderer,
          readback: array,
        });
      },
    };
  }

  // Check if this accumulator has exactly the same generator mapping as
  // the previous one. If so, we can reuse the Gsplat sort order.
  checkVersions(otherMapping: GeneratorMapping[]) {
    if (this.mapping.length !== otherMapping.length) {
      return {
        splatsUpdated: true,
        mappingUpdated: true,
        sortUpdated: true,
      };
    }
    const mappingUpdated = this.mapping.some((item, i) => {
      const other = otherMapping[i];
      return (
        item.node !== other.node ||
        item.base !== other.base ||
        item.count !== other.count ||
        item.mappingVersion !== other.mappingVersion
      );
    });
    if (mappingUpdated) {
      return {
        splatsUpdated: true,
        mappingUpdated: true,
        sortUpdated: true,
      };
    }
    const splatsUpdated = this.mapping.some((item, i) => {
      return item.version !== otherMapping[i].version;
    });
    const sortUpdated = this.mapping.some((item, i) => {
      return item.sortVersion !== otherMapping[i].sortVersion;
    });
    return { splatsUpdated, mappingUpdated, sortUpdated };
  }
}
