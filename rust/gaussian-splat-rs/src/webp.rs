use image_webp::{ColorType, WebPEncoder};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = encodeWebp)]
pub fn encode_webp(data: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
    if width == 0
        || height == 0
        || width > 16383
        || height > 16383
        || data.len() as u64 != u64::from(width) * u64::from(height) * 4
    {
        return Err(js_sys::Error::new("Invalid WebP image dimensions").into());
    }
    let mut output = Vec::new();
    WebPEncoder::new(&mut output)
        .encode(data, width, height, ColorType::Rgba8)
        .map_err(|error| js_sys::Error::new(&error.to_string()))?;
    Ok(output)
}
