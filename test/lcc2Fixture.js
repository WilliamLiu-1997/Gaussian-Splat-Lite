// Independently generated records; no XGRIDS export data is embedded here.
export function createSharedPlyScene() {
  const c0 = 0.28209479177387814;
  const properties = [
    "x",
    "y",
    "z",
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "opacity",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`),
  ];
  const count = 8;
  const header = new TextEncoder().encode(
    [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${count}`,
      ...properties.map((name) => `property float ${name}`),
      "end_header",
      "",
    ].join("\n"),
  );
  const ply = new Uint8Array(header.length + count * properties.length * 4);
  ply.set(header);
  const view = new DataView(ply.buffer, header.length);
  for (let index = 0; index < count; index++) {
    const values = [
      index - 3,
      0,
      -4,
      Math.log(0.04),
      Math.log(0.12),
      Math.log(0.08),
      1,
      0,
      0,
      0,
      index === 0 ? -1000 : 0,
      (index / 8 - 0.5) / c0,
      (0.25 - 0.5) / c0,
      (0.75 - 0.5) / c0,
      ...Array.from(
        { length: 45 },
        (_, coefficient) => (coefficient + 1) * (index + 1) * 0.001,
      ),
    ];
    values.forEach((value, field) =>
      view.setFloat32((index * properties.length + field) * 4, value, true),
    );
  }
  const bounds = { min: [-1.2, -0.2, -4.2], max: [2.2, 0.2, -3.8] };
  const child = (id, start) => ({
    id,
    boundingBox: bounds,
    childNum: 0,
    data: { "3dgs": { name: 0, start, count: 2 } },
  });
  return {
    ply,
    metadata: {
      version: "0.0.3",
      splatType: ".ply",
      fileType: "quality",
      totalLevels: 1,
      totalSplats: 4,
      lodSplats: [4],
      root: {
        id: "root",
        boundingBox: bounds,
        childNum: 2,
        splatFiles: ["payload/shared.ply"],
        child: { left: child("left", 2), right: child("right", 4) },
      },
    },
  };
}
