#include <stdint.h>
#include <string.h>
#include <webp/decode.h>

int webp_info(const uint8_t *bytes, size_t size, uint32_t *result) {
    WebPBitstreamFeatures features;
    if (size < 12 || memcmp(bytes, "RIFF", 4) || memcmp(bytes + 8, "WEBP", 4) ||
        WebPGetFeatures(bytes, size, &features) != VP8_STATUS_OK ||
        features.has_animation || features.format != 2) return 0;

    result[0] = features.width;
    result[1] = features.height;
    result[2] = features.has_alpha ? 4 : 3;
    return 1;
}

int webp_decode_into(const uint8_t *bytes, size_t size, uint8_t *pixels,
                     size_t length, int width, int channels) {
    WebPDecoderConfig config;
    if (!WebPInitDecoderConfig(&config)) return 0;
    config.output.colorspace = channels == 4 ? MODE_RGBA : MODE_RGB;
    config.output.is_external_memory = 1;
    config.output.u.RGBA.rgba = pixels;
    config.output.u.RGBA.stride = width * channels;
    config.output.u.RGBA.size = length;
    VP8StatusCode status = WebPDecode(bytes, size, &config);
    WebPFreeDecBuffer(&config.output);
    return status == VP8_STATUS_OK ? 1 : status == VP8_STATUS_OUT_OF_MEMORY ? -1 : 0;
}
