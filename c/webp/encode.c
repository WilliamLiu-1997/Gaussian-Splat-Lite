#include <stdint.h>
#include <webp/encode.h>

int webp_encode(const uint8_t *rgba, int width, int height,
                uint8_t **output, size_t *size) {
    WebPConfig config;
    WebPPicture picture;
    WebPMemoryWriter writer;
    if (!WebPConfigInit(&config) || !WebPConfigLosslessPreset(&config, 1) ||
        !WebPPictureInit(&picture)) return 0;

    // SOG stores data in all four channels, including RGB under zero alpha.
    config.exact = 1;
    picture.use_argb = 1;
    picture.width = width;
    picture.height = height;
    WebPMemoryWriterInit(&writer);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;

    int ok = WebPPictureImportRGBA(&picture, rgba, width * 4) &&
             WebPEncode(&config, &picture);
    WebPPictureFree(&picture);
    if (!ok) {
        WebPMemoryWriterClear(&writer);
        return 0;
    }
    *output = writer.mem;
    *size = writer.size;
    return 1;
}
