export const renderOptionGroups = [
  {
    title: "Performance & diagnostics",
    description: "Frame scheduling and live metrics.",
    options: [
      {
        property: "rendererBackend",
        description:
          "Chooses the renderer; WebGPU falls back to WebGL2 when unavailable.",
        defaultValue: "webgpu",
        choices: [
          ["webgpu", "WebGPU"],
          ["webgl-fallback", "WebGPU · WebGL2"],
          ["webgl", "WebGL2"],
        ],
      },
      {
        property: "outputColorSpace",
        label: "Output color space",
        description:
          "Chooses whether the canvas presents linear RGB values directly or encodes them for an sRGB display.",
        defaultValue: true,
        falseLabel: "Linear",
        trueLabel: "sRGB",
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
        property: "rotateCubes",
        label: "Rotate cubes",
        description: "Pauses or resumes the cubes' orbit and spin.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "cubeOrbitRadius",
        label: "Cube orbit radius",
        description: "Scales the orbit radius relative to the model size.",
        min: 0,
        max: 3,
        step: 0.05,
        defaultValue: 1,
        format: (value) => `${value.toFixed(2)}×`,
      },
    ],
  },
  {
    title: "Rendering",
    description: "Stochastic transparency and depth output.",
    options: [
      {
        property: "stochasticMode",
        label: "Stochastic",
        description:
          "Auto uses stochastic rendering during camera motion until a fresh sort is ready; On keeps it active; Off uses sorted rendering.",
        defaultValue: "off",
        choices: [
          ["auto", "Auto"],
          ["on", "On"],
          ["off", "Off"],
        ],
      },
      {
        property: "renderDepth",
        label: "Force Splat depth",
        description:
          "Enables the depth-only companion draw when Stochastic is Off.",
        defaultValue: false,
        falseLabel: "Off",
        trueLabel: "On",
      },
      {
        property: "temporalResolve",
        label: "Temporal smoothing",
        description:
          "Reuses up to 16 samples while moving. After stopping, fades smoothing out over 16 frames and refines up to 64 samples. Not used in XR.",
        defaultValue: true,
        falseLabel: "Off",
        trueLabel: "On",
      },
    ],
  },
  {
    title: "Culling & sorting",
    description: "Trade image stability for rendering work.",
    options: [
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
        property: "maxPixelRadius",
        description: "Caps very large nearby splats to limit overdraw.",
        min: 16,
        max: 1024,
        step: 16,
        defaultValue: 256,
        format: (value) => `${Math.round(value)} px`,
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
