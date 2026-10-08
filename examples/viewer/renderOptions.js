export const renderOptionGroups = [
  {
    title: "Performance & diagnostics",
    description: "Frame scheduling and live metrics.",
    options: [
      {
        property: "rendererBackend",
        label: "Renderer",
        description:
          "Chooses the renderer; WebGPU falls back to WebGL2 when unavailable.",
        defaultValue: "webgpu",
        choices: [
          ["webgpu", "WebGPU"],
          ["webgl-fallback", "WebGPU (WebGL2 fallback)"],
          ["webgl", "WebGLRenderer"],
        ],
      },
      {
        property: "splatBudget",
        label: "Streaming splat budget",
        description:
          "Target splat count for RAD and SOG streaming. Adjusts detail without reloading.",
        min: 1_000_000,
        max: 5_000_000,
        step: 100_000,
        defaultValue: 3_000_000,
        format: (value) => `${(value / 1_000_000).toFixed(1)}M`,
      },
      {
        property: "renderOnDemand",
        description:
          "Skips unchanged frames. Disable it to render continuously for profiling.",
        defaultValue: true,
        falseLabel: "Continuous",
        trueLabel: "On demand",
      },
      {
        property: "halfFloatBlending",
        label: "Blend buffer",
        description:
          "Half float blends at high precision and rounds to the display once, removing the overlapping rings 8-bit blending leaves in faint gradients. Stochastic rendering always uses half float.",
        defaultValue: true,
        falseLabel: "8-bit",
        trueLabel: "Half float",
      },
    ],
  },
  {
    title: "Culling & sorting",
    description: "Trade image stability for rendering work.",
    options: [
      {
        property: "stochastic",
        label: "Stochastic",
        description:
          "Uses stochastic coverage, smoothed by the stochastic denoiser below. Off restores sorted alpha blending.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "denoiser",
        label: "Stochastic denoiser",
        description:
          "Neural leaves no trail behind moving objects and stays clean while the camera moves. Fast motion looks softer, and it takes more GPU time and memory.",
        defaultValue: "taa",
        choices: [
          ["taa", "TAA"],
          ["neural", "Neural"],
        ],
      },
      {
        property: "denoiserQuality",
        label: "Neural denoiser quality",
        description:
          "Balanced and Quality follow content that moves, which keeps its detail sharp; Quality is a little cleaner. Performance takes less than half the GPU time of Balanced.",
        defaultValue: "balanced",
        choices: [
          ["performance", "Performance"],
          ["balanced", "Balanced"],
          ["quality", "Quality"],
        ],
      },
      {
        property: "sortRadial",
        description:
          "Radial is stable while orbiting; Z-depth can match trained scenes more accurately.",
        defaultValue: false,
        falseLabel: "Z-depth",
        trueLabel: "Radial",
      },
      {
        property: "fastSort",
        label: "Fast sort",
        description:
          "Speeds up sorted rendering with a small loss of blending accuracy.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "stochasticSort",
        label: "Stochastic front sort",
        description:
          "Uses 16-bit front-to-back ordering to reduce overdraw. WebXR eyes share one head-based order. Off draws in source or compacted order.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "minSortIntervalMs",
        description:
          "Limits asynchronous WebGL sorting. Higher values save work but may lag while moving.",
        min: 0,
        max: 500,
        step: 10,
        defaultValue: 0,
        format: (value) => `${Math.round(value)} ms`,
      },
      {
        property: "clipXY",
        description:
          "Keeps splat centers this far beyond the viewport before culling them.",
        min: 1,
        max: 3,
        step: 0.05,
        defaultValue: 1.25,
        format: (value) => `${value.toFixed(2)}×`,
      },
    ],
  },
  {
    title: "Splat appearance",
    description: "Shape, filtering, and screen-space size.",
    options: [
      {
        property: "maxStdDev",
        description:
          "Draws more of each Gaussian tail. Higher is softer but costs more fill rate.",
        min: 1,
        max: 4,
        step: 0.05,
        defaultValue: Math.sqrt(8),
        format: (value) => value.toFixed(2),
      },
      {
        property: "minPixelRadius",
        description:
          "Hides splats whose two screen-space radii are below this pixel size.",
        min: 0,
        max: 4,
        step: 0.05,
        defaultValue: 1,
        format: (value) => `${value.toFixed(2)} px`,
      },
      {
        property: "minAlpha",
        description:
          "Discards faint splats and fragments. Raise it to reveal the cutoff boundary.",
        min: 0,
        max: 0.1,
        step: 0.5 / 255,
        defaultValue: 0.5 / 255,
        format: (value) => value.toFixed(4),
      },
      {
        property: "preBlurAmount",
        description: "Enlarges and brightens splats before opacity correction.",
        min: 0,
        max: 2,
        step: 0.01,
        defaultValue: 0.3,
        format: (value) => value.toFixed(2),
      },
      {
        property: "blurAmount",
        description:
          "Smooths small splats while correcting opacity to preserve their energy.",
        min: 0,
        max: 2,
        step: 0.01,
        defaultValue: 0,
        format: (value) => value.toFixed(2),
      },
      {
        property: "focalAdjustment",
        description:
          "Changes projected splat size. Higher values generally appear sharper.",
        min: 0.5,
        max: 4,
        step: 0.05,
        defaultValue: 2,
        format: (value) => `${value.toFixed(2)}×`,
      },
    ],
  },
  {
    title: "Material pipeline",
    description: "How splats blend with the Three.js scene.",
    options: [
      {
        property: "premultipliedAlpha",
        description:
          "Uses RGB already multiplied by alpha for edge-correct blending.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "depthTest",
        description:
          "Lets opaque Three.js geometry occlude splats using the depth buffer.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "depthWrite",
        description:
          "Writes splats to depth. This can create hard artifacts in transparent areas.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "transparent",
        description:
          "Places splats in Three.js’s transparent pass instead of its opaque pass.",
        defaultValue: true,
        falseLabel: "Opaque",
        trueLabel: "Transparent",
      },
    ],
  },
];
