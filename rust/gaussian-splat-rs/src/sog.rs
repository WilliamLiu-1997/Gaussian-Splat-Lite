//! JavaScript bridge for SOG property decoding through the shared SplatReceiver.
use anyhow::Context;
use gaussian_splat_lib::sog::{self, SogDecoder};
use js_sys::{Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::splats::SplatsData;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("SOG: {error}"))
}

#[wasm_bindgen]
pub fn decode_sog_meta(
    bytes: Uint8Array,
    method: u32,
    size: usize,
    crc: f64,
    max_bytes: Option<u32>,
    max_wasm_bytes: Option<f64>,
) -> Result<String, JsValue> {
    #[cfg(target_arch = "wasm32")]
    crate::allocation::set_memory_limit(max_wasm_bytes)?;
    #[cfg(not(target_arch = "wasm32"))]
    let _ = max_wasm_bytes;
    if max_bytes.is_some_and(|limit| bytes.length() > limit || size > limit as usize) {
        return Err(js_error("Metadata exceeds decoder byte limit"));
    }
    sog::decode_sog_meta(bytes.to_vec(), method, size, crc).map_err(js_error)
}

#[wasm_bindgen]
pub struct SogDecodeSession {
    decoder: SogDecoder<SplatsData>,
    asset_limit: usize,
}

#[wasm_bindgen]
impl SogDecodeSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        metadata: &str,
        max_points: Option<u32>,
        memory_budget: Option<f64>,
        max_wasm_bytes: Option<f64>,
        max_sh: Option<u32>,
    ) -> Result<Self, JsValue> {
        #[cfg(target_arch = "wasm32")]
        crate::allocation::set_memory_limit(max_wasm_bytes)?;
        #[cfg(not(target_arch = "wasm32"))]
        let _ = max_wasm_bytes;
        if let Some(max_points) = max_points {
            let value: serde_json::Value =
                serde_json::from_str(metadata.trim_start_matches('\u{feff}')).map_err(js_error)?;
            let count = if value["version"] == 2 {
                &value["count"]
            } else {
                &value["means"]["shape"][0]
            };
            if count.as_u64().is_none_or(|count| count > max_points as u64) {
                return Err(js_error("Decoder maxPoints exceeded by SOG metadata"));
            }
        }
        let splats = SplatsData::with_limits(3, max_points, memory_budget).map_err(js_error)?;
        Ok(Self {
            decoder: SogDecoder::new(splats, metadata, max_sh.unwrap_or(3) as usize).map_err(js_error)?,
            asset_limit: memory_budget.map_or(usize::MAX, |bytes| bytes as usize),
