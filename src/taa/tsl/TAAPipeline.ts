import * as THREE from "three";
import { type Node, NodeMaterial, type WebGPURenderer } from "three/webgpu";
import { setRendererRenderTarget } from "../../rendering/rendererUtils";
import { N, load2D } from "../../rendering/tsl/shaderUtils";
import { uintTexture } from "../../rendering/tsl/tslCompat";
import { TAA_DEPTH_PROBES, createTAAHistory } from "../TAAHistory";

/** SuperSplat accumulation, matching webgl/TAAPipeline.ts on native GPU and GL fallback. */
export function createNodeTAAPipeline(
  renderer: WebGPURenderer,
  camera: THREE.Camera,
  sizeValue: THREE.Vector2,
  sourceTarget: THREE.RenderTarget,
) {
  const history = createTAAHistory(renderer, camera, sizeValue);
  const source = N.texture(sourceTarget.texture);
  const depth = N.texture(sourceTarget.depthTexture as THREE.DepthTexture);
  const previousColor = uintTexture(history.input.texture).onObjectUpdate(
    () => history.input.texture,
  );
  const previousInfo = uintTexture(history.input.textures[1]).onObjectUpdate(
    () => history.input.textures[1],
  );
  let composed = history.output;
  const composedColor = uintTexture(composed.texture).onObjectUpdate(
    () => composed.texture,
  );
  const composedInfo = uintTexture(composed.textures[1]).onObjectUpdate(
    () => composed.textures[1],
  );
  const size = N.uniform(sizeValue);
  const projection = N.uniform(camera.projectionMatrix);
  const params = N.uniform(history.params);
  const depthParams = N.uniform(history.depthParams);
  const previousClip = N.uniform(history.viewToPreviousClip);
  const previousView = N.uniform(history.viewToPreviousView);
  const pixel = N.ivec2(N.screenCoordinate.xy);
  const logarithmic = depthParams.x.greaterThan(0);
  const reverseSelection = history.reversed ? logarithmic.not() : N.bool(false);
  const bounded = (p: Node<"ivec2">) =>
    p.clamp(N.ivec2(0), N.ivec2(size).sub(1));
  const decodeColor = N.Fn(([v]: [Node<"uvec4">]) =>
    N.vec4(N.unpackUnorm2x16(v.x), N.unpackUnorm2x16(v.y)),
  );
  const decodeInfo = N.Fn(([v]: [Node<"uint">]) =>
    N.vec2(
      N.uintBitsToFloat(v.shiftRight(9).shiftLeft(8)),
      N.float(v.bitAnd(511)),
    ),
  );
  const viewDepth = N.Fn(([encoded]: [Node<"float">]) => {
    const z = history.zeroToOne ? encoded : encoded.mul(2).sub(1);
    const pz = projection.element(2);
    const pw = projection.element(3);
    const result = pw.z
      .sub(z.mul(pw.w))
      .div(z.mul(pz.w).sub(pz.z))
      .negate()
      .toVar();
    N.If(logarithmic, () => {
      result.assign(
        depthParams.x.mul(encoded.mul(depthParams.z).exp2()).sub(depthParams.y),
      );
    });
    return result;
  });
  const deviceDepth = N.Fn(([d]: [Node<"float">]) => {
    const result = N.select(reverseSelection, 0, 1).toVar();
    N.If(d.greaterThan(0), () => {
      const pz = projection.element(2);
      const pw = projection.element(3);
      const clip = pw.z.sub(pz.z.mul(d)).div(pw.w.sub(pz.w.mul(d)));
      result.assign(history.zeroToOne ? clip : clip.mul(0.5).add(0.5));
      N.If(logarithmic, () => {
        result.assign(
          d.add(depthParams.y).div(depthParams.x).log2().div(depthParams.z),
        );
      });
    });
    return result;
  });
  const isHit = N.Fn(([alpha, z]: [Node<"float">, Node<"float">]) =>
    alpha
      .greaterThan(0)
      .and(N.select(reverseSelection, z.greaterThan(0), z.lessThan(1))),
  );
  const hitAt = N.Fn(([p]: [Node<"ivec2">]) =>
    isHit(load2D(source, p).a, load2D(depth, p).r),
  );
  const spatialDepth = N.Fn(([p]: [Node<"ivec2">]) => {
    const z = load2D(depth, p).r.toVar();
    N.If(hitAt(p).not(), () => {
      const quad = p.div(2).mul(2);
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const n = load2D(depth, bounded(quad.add(N.ivec2(x, y)))).r;
          z.assign(N.select(reverseSelection, z.max(n), z.min(n)));
        }
    });
    return z;
  });
  const quadSample = N.Fn(([p]: [Node<"ivec2">]) => {
    const u = N.vec2(p).sub(0.5).mul(0.5);
    const f = u.fract();
    const uv = u.floor().mul(2).add(1).div(size);
    const step = N.vec2(2).div(size);
    return N.mix(
      N.mix(
        source.sample(uv).level(N.float(0)),
        source.sample(uv.add(N.vec2(step.x, 0))).level(N.float(0)),
        f.x,
      ),
      N.mix(
        source.sample(uv.add(N.vec2(0, step.y))).level(N.float(0)),
        source.sample(uv.add(step)).level(N.float(0)),
        f.x,
      ),
      f.y,
    );
  });
  const cubicWeights = N.Fn(([f]: [Node<"float">]) => {
    const f2 = f.mul(f);
    const f3 = f2.mul(f);
    return N.vec4(
      f3.mul(-0.5).add(f2).sub(f.mul(0.5)),
      f3.mul(1.5).sub(f2.mul(2.5)).add(1),
      f3.mul(-1.5).add(f2.mul(2)).add(f.mul(0.5)),
      f3.sub(f2).mul(0.5),
    );
  });
  const historyAt = N.Fn(([uv]: [Node<"vec2">]) => {
    const p = uv.mul(size).sub(0.5);
    const base = N.ivec2(p.floor());
    const f = p.fract();
    const wx = cubicWeights(f.x);
    const wy = cubicWeights(f.y);
    const sum = N.vec4(0).toVar();
    // Catmull-Rom without its four corner taps (each weight <= (2/27)^2 ~ 0.0055).
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        if ((x === 0 || x === 3) && (y === 0 || y === 3)) continue;
        sum.addAssign(
          decodeColor(
            load2D(previousColor, bounded(base.add(N.ivec2(x - 1, y - 1)))),
          )
            .mul(wx.element(x))
            .mul(wy.element(y)),
        );
      }
    // The corners sum to (wx.x + wx.w) * (wy.x + wy.w); renormalise without them.
    return sum.div(N.float(1).sub(wx.x.add(wx.w).mul(wy.x.add(wy.w))));
  });
  const resolve = N.Fn(() => {
    const center = load2D(source, pixel).toVar();
    const centerDepth = load2D(depth, pixel).r.toVar();
    const hit = isHit(center.a, centerDepth).toVar();
    const moving = params.z.greaterThan(0.5);
    const d = viewDepth(centerDepth);
    const own = N.vec2(0).toVar();
    N.If(params.y.greaterThan(0.5), () => {
      own.assign(decodeInfo(load2D(previousInfo, pixel).r));
    });
    const sample = N.select(hit, N.vec4(center.rgb, 1), N.vec4(0)).toVar();
    N.If(moving, () => {
      sample.assign(quadSample(pixel));
    });
    const uv = N.vec2(pixel).add(0.5).div(size);
    const previousUV = uv.toVar();
    const depthMin = N.float(1).toVar();
    const depthMax = N.float(-1).toVar();
    const nearDepth = N.float(0).toVar();
    const farDepth = N.float(0).toVar();
    const m1 = N.vec4(0).toVar();
    const m2 = N.vec4(0).toVar();
    N.If(moving.and(sample.a.greaterThan(0)), () => {
      // Read the 4x4 block quadSample covers once (zero coverage means no hits):
      // misses borrow its nearest depth so every covered pixel reprojects,
      // occluders use its depth range, and the clamp its inner 3x3 moments.
      const block = N.ivec2(N.vec2(pixel).sub(0.5).mul(0.5).floor()).mul(2);
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          const o = block.add(N.ivec2(x, y));
          const q = bounded(o);
          const s = load2D(source, q).toVar();
          const z = load2D(depth, q).r.toVar();
          N.If(isHit(s.a, z), () => {
            depthMin.assign(depthMin.min(z));
            depthMax.assign(depthMax.max(z));
            const offset = N.vec2(o.sub(pixel)).abs();
            N.If(N.all(offset.lessThanEqual(N.vec2(1))), () => {
              const n = N.vec4(s.rgb, 1);
              m1.addAssign(n);
              m2.addAssign(n.mul(n));
            });
          });
        }
      N.If(depthMax.greaterThanEqual(0), () => {
        const a = viewDepth(depthMin);
        const b = viewDepth(depthMax);
        nearDepth.assign(a.min(b));
        farDepth.assign(a.max(b));
      });
    });
    // Misses without their own depth borrow the nearest hit in that block, so
    // sparse edges keep reprojecting instead of resetting every other frame.
    const carryDepth = N.select(
      hit,
      d,
      N.select(own.x.greaterThan(0), own.x, nearDepth),
    ).toVar();
    // A sparse edge entering empty screen has no depth here or in the block:
    // guess from the closest surface around it in the previous history instead.
    const guessed = moving
      .and(params.y.greaterThan(0.5))
      .and(carryDepth.lessThanEqual(0))
      .toVar();
    N.If(guessed, () => {
      // Probes run inner first; each is skipped once an earlier one found depth.
      for (const [x, y] of TAA_DEPTH_PROBES)
        N.If(carryDepth.lessThanEqual(0), () => {
          const n = decodeInfo(
            load2D(previousInfo, bounded(pixel.add(N.ivec2(x, y)))).r,
          ).toVar();
          N.If(n.y.greaterThan(0).and(n.x.greaterThan(0)), () => {
            carryDepth.assign(n.x);
          });
        });
    });
    const previousDepth = carryDepth.toVar();
    const valid = params.y.greaterThan(0.5).toVar();
    N.If(moving, () => {
      valid.assign(valid.and(hit.or(carryDepth.greaterThan(0))));
      const ndc = uv.mul(N.vec2(2, -2)).add(N.vec2(-1, 1));
      const z = carryDepth.negate();
      const pz = projection.element(2);
      const pw = projection.element(3);
      const clipW = pz.w.mul(z).add(pw.w);
      const xy = ndc
        .mul(clipW)
        .sub(pz.xy.mul(z))
        .sub(pw.xy)
        .div(N.vec2(projection.element(0).x, projection.element(1).y));
      const point = N.vec4(xy, z, 1);
      previousDepth.assign(previousView.mul(point).z.negate());
      const previous = previousClip.mul(point);
      previousUV.assign(
        previous.xy.div(previous.w.max(1e-9)).mul(N.vec2(0.5, -0.5)).add(0.5),
      );
      valid.assign(
        valid
          .and(previous.w.greaterThan(0))
          .and(N.all(previousUV.greaterThanEqual(N.vec2(0))))
          .and(N.all(previousUV.lessThanEqual(N.vec2(1)))),
      );
    });
    const hist = N.vec4(0).toVar();
    const info = N.vec2(0).toVar();
    N.If(valid, () => {
      N.If(moving, () => {
        hist.assign(historyAt(previousUV));
        // Take the most-sampled texel under the footprint: a nearest lookup lets
        // one reset neighbour restart a sparse edge pixel's sample count.
        const base = N.ivec2(previousUV.mul(size).sub(0.5).floor());
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++) {
            const n = decodeInfo(
              load2D(previousInfo, bounded(base.add(N.ivec2(x, y)))).r,
            ).toVar();
            N.If(n.y.greaterThan(info.y), () => {
              info.assign(n);
            });
          }
        // Accept a guessed depth only where the history holds a surface at it;
        // this also keeps trailing edges from dragging history behind them.
        N.If(
          guessed.and(
            info.x
              .sub(previousDepth)
              .abs()
              .greaterThan(previousDepth.mul(0.25)),
          ),
          () => {
            info.assign(N.vec2(0));
          },
        );
      }).Else(() => {
        hist.assign(decodeColor(load2D(previousColor, pixel)));
        info.assign(own);
      });
    });
    const color = sample.toVar();
    const mean = N.select(hit, d, 0).toVar();
    const count = N.select(hit, 1, 0).toVar();
    N.If(valid.not().or(info.y.lessThanEqual(0.5)), () => {
      N.If(hit.and(moving.not()).and(params.y.greaterThan(0.5)), () => {
        count.assign(params.w.clamp(1, params.x));
        color.assign(sample.div(count));
      });
      // Seed covered misses as well: otherwise the quadSample rim beyond the last
      // hit never joins the history and keeps flickering outside it.
      N.If(
        moving.and(valid).and(hit.not()).and(sample.a.greaterThan(0)),
        () => {
          count.assign(N.float(1));
          mean.assign(carryDepth);
        },
      );
    }).Else(() => {
      const cap = params.x.toVar();
      N.If(moving, () => {
        const mu = m1.div(9);
        const sd = m2.div(9).sub(mu.mul(mu)).max(0).sqrt();
        // An empty 3x3 is expected where coverage is sparse and would clamp the
        // history to zero. Let the upper bound admit the binomial noise that the
        // history's own coverage predicts for 9 samples, so sparse edges persist
        // while dense history keeps the tight bounds.
        const a = hist.a.clamp(1e-4, 1);
        const noise = hist
          .max(0)
          .mul(N.float(1).sub(a).div(a.mul(9)).sqrt().mul(1.5));
        hist.assign(
          hist.clamp(mu.sub(sd.mul(1.25)), mu.add(sd.mul(1.25).max(noise))),
        );
        const speed = previousUV.sub(uv).mul(size).length();
        cap.assign(params.x.div(speed.div(4).add(1)).max(2));
      });
      count.assign(info.y.add(1).min(cap));
      const w = N.float(1).div(count);
      color.assign(N.mix(hist, sample, w));
      N.If(sample.a.equal(0), () => {
        color.a.assign(color.a.min(hist.a.sub(1 / 65535).max(0)));
      });
      // Average valid hits; misses retain the depth carried into the current view.
      const shifted = info.x.add(carryDepth).sub(previousDepth).max(0);
      mean.assign(N.select(hit, N.mix(shifted, d, w), shifted));
      N.If(moving, () => {
        // Old occluders must leave with the current surface, not fade through it.
        N.If(depthMax.greaterThanEqual(0), () => {
          mean.assign(mean.clamp(nearDepth, farDepth));
        });
        // Keep reprojection depth across misses so the sample count survives.
        // Color bounds still reject history outside the sampled coverage.
      });
    });
    color.a.assign(color.a.clamp(0, 1));
    color.rgb.assign(color.rgb.clamp(N.vec3(0), N.vec3(color.a)));
    const packedInfo = N.floatBitsToUint(mean.max(0))
      .add(N.uint(0x80))
      .shiftRight(8)
      .shiftLeft(9)
      .bitOr(N.uint(count).min(511));
    return N.uvec3(
      N.packUnorm2x16(color.rg),
      N.packUnorm2x16(color.ba),
      packedInfo,
    );
  });
  const material = new NodeMaterial();
  material.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
  const packed = resolve();
  material.fragmentNode = N.outputStruct(packed.xy, packed.z);
  material.blending = THREE.NoBlending;
  material.depthTest = material.depthWrite = false;
  material.toneMapped = false;
  const createCompositeMaterial = (temporal: boolean, depthOnly = false) => {
    const compositeMaterial = new NodeMaterial();
    compositeMaterial.vertexNode = N.vec4(N.positionGeometry.xy, 0, 1);
    const info = temporal
      ? decodeInfo(load2D(composedInfo, pixel).r)
      : N.vec2(0);
    const sampledDepth = info.x;
    compositeMaterial.fragmentNode = N.Fn(() => {
      const color = (
        temporal ? decodeColor(load2D(composedColor, pixel)) : quadSample(pixel)
      ).toVar();
      color.a.lessThanEqual(0.001).discard();
      if (depthOnly) color.a.lessThan(0.1).discard();
      return color;
    })();
    compositeMaterial.depthNode = N.Fn(() => {
      const z = temporal ? deviceDepth(sampledDepth) : spatialDepth(pixel);
      const clamped = N.select(reverseSelection, z.max(1e-7), z.min(1 - 1e-7));
      return temporal
        ? N.select(sampledDepth.greaterThan(0), clamped, z)
        : clamped;
    })();
    compositeMaterial.blending = THREE.CustomBlending;
    compositeMaterial.blendSrc = compositeMaterial.blendSrcAlpha =
      THREE.OneFactor;
    compositeMaterial.blendDst = compositeMaterial.blendDstAlpha =
      THREE.OneMinusSrcAlphaFactor;
    compositeMaterial.depthTest = true;
    compositeMaterial.depthWrite = !temporal || depthOnly;
    compositeMaterial.colorWrite = !depthOnly;
    compositeMaterial.toneMapped = false;
    return compositeMaterial;
  };
  const compositeMaterial = createCompositeMaterial(true);
  const depthMaterial = createCompositeMaterial(true, true);
  const compositeMaterials = [compositeMaterial, depthMaterial];
  const spatialMaterial = createCompositeMaterial(false);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Keep faint color depth-tested without letting it occlude later geometry.
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(0, 3, 1);
  const composite: THREE.Mesh = new THREE.Mesh(geometry, compositeMaterials);
  composite.frustumCulled = false;
  const fullscreenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    composite,
    get needsRender() {
      return history.needsRender;
    },
    reset: () => history.reset(),
    resolve(version: number, temporalEnabled = true) {
      composite.material = temporalEnabled
        ? compositeMaterials
        : spatialMaterial;
      if (!temporalEnabled) {
        history.updateDepthParams();
        return;
      }
      history.begin(version);
      setRendererRenderTarget(renderer, history.output);
      renderer.render(mesh, fullscreenCamera);
      composed = history.output;
      history.commit();
    },
    dispose() {
      history.dispose();
      material.dispose();
      compositeMaterial.dispose();
      depthMaterial.dispose();
      spatialMaterial.dispose();
      geometry.dispose();
    },
  };
}
