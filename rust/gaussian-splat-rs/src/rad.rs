//! JavaScript bridge for the validated native RAD chunk decoder.

use gaussian_splat_lib::rad::{self, RadMeta};
use js_sys::{Float32Array, Object, Reflect, Uint16Array, Uint32Array, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::splats::SplatsData;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{error:#}")).into()
}

#[wasm_bindgen]
pub fn decode_rad_header(bytes: Uint8Array) -> Result<JsValue, JsValue> {
    let bytes = bytes
        .subarray(0, (rad::MAX_HEADER_BYTES + 15) as u32)
        .to_vec();
    let Some((meta, chunks_start)) = rad::decode_rad_header(&bytes).map_err(js_error)? else {
        return Ok(JsValue::UNDEFINED);
    };
    let object = Object::new();
    let meta_json = serde_json::to_string(&meta).map_err(js_error)?;
    Reflect::set(&object, &"meta".into(), &js_sys::JSON::parse(&meta_json)?)?;
    Reflect::set(
        &object,
        &"chunksStart".into(),
        &JsValue::from_f64(chunks_start as f64),
    )?;
    Ok(object.into())
}

/// Owns only dataset metadata and the requested SH codebooks. Call the generated
/// `free()` method when a load finishes or its stream scheduler is disposed.
#[wasm_bindgen]
pub struct RadDecoder {
    decoder: rad::RadDecoder,
}

#[wasm_bindgen]
impl RadDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(meta_json: &str, max_sh: u32) -> Result<RadDecoder, JsValue> {
        let meta = RadMeta::from_json(meta_json).map_err(js_error)?;
        let decoder = rad::RadDecoder::new(meta, max_sh as usize).map_err(js_error)?;
        Ok(Self { decoder })
    }

    pub fn decode_chunk(&mut self, bytes: Uint8Array) -> Result<JsValue, JsValue> {
        if bytes.length() as usize > rad::MAX_CHUNK_BYTES {
            return Err(js_error("RADC encoded chunk exceeds memory limit"));
        }
        let (splats, chunk) = self
            .decoder
            .decode_chunk(&bytes.to_vec(), SplatsData::new())
            .map_err(js_error)?;
        let object = splats.into_splat_object();
        Reflect::set(&object, &"base".into(), &JsValue::from(chunk.base))?;
        Reflect::set(&object, &"fileType".into(), &JsValue::from_str("rad"))?;
        if let Some(child_start) = chunk.child_start {
            Reflect::set(
                &object,
                &"childStart".into(),
                &Uint32Array::from(child_start.as_slice()),
            )?;
        }
        if let Some(child_count) = chunk.child_count {
            Reflect::set(
                &object,
                &"childCount".into(),
                &Uint16Array::from(child_count.as_slice()),
            )?;
        }
        if let Some(lod_radii) = chunk.lod_radii {
            Reflect::set(
                &object,
                &"lodRadii".into(),
                &Float32Array::from(lod_radii.as_slice()),
            )?;
        }
        Ok(object.into())
    }
}
