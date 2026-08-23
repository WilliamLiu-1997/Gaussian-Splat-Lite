# Custom SplatSource

[Back to the API overview](../README.md#core-concepts-and-public-api)

Advanced integrations can implement and supply a custom `SplatSource`. A source must provide both CPU center iteration and GPU texture access:

```ts
interface SplatSource {
  needsUpdate: boolean;

  dispose(): void;
  getNumSplats(): number;
  getNumSh(): number;
  getSplatTextures(): readonly [
    THREE.DataArrayTexture,
    THREE.DataArrayTexture,
  ];
  getShTextures(): SplatShTextures;
  forEachCenter(callback: (index, x, y, z) => void): void;
  forEachSplat(callback: (index, center, scales, quaternion, opacity, color) => void): void;
}

const mesh = new SplatMesh({ splats: customSource });
```

This is an extension point for the low-level encoding. Shader construction, arbitrary per-Splat modifiers, and dynamic shader nodes are deliberately outside this interface.
