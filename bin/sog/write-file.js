// Keep the producer's encoded buffer alive until the writer consumes it.
export async function writeFile(open, produce) {
  const writer = await open;
  let size;
  try {
    await produce((bytes) => {
      size = bytes.byteLength;
      return writer.write(bytes, 0);
    });
  } catch (error) {
    await writer.abort();
    throw error;
  }
  await writer.close();
  return size;
}
