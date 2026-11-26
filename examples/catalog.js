// Each id names a directory under ./examples with its own index.html.
export const examples = [
  {
    id: "basic-viewer",
    title: "Basic Viewer",
    thumbnail: new URL(
      "./examples/basic-viewer/thumbnail.webp",
      import.meta.url,
    ).href,
  },
  {
    id: "blind-data",
    title: "Blind Data",
    thumbnail: new URL("./examples/blind-data/thumbnail.webp", import.meta.url)
      .href,
  },
];
