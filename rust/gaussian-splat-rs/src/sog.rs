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
        let splats = SplatsData::with_limits(max_points, memory_budget).map_err(js_error)?;
        Ok(Self {
            decoder: SogDecoder::new(splats, metadata).map_err(js_error)?,
            asset_limit: memory_budget.map_or(usize::MAX, |bytes| bytes as usize),
        })
    }

    pub fn plan(&self) -> String {
        serde_json::to_string(&self.decoder.plan()).expect("asset names are serializable")
    }

    pub fn decode_asset(
        &mut self,
        chunks: Array<Uint8Array>,
        method: u32,
        uncompressed_size: usize,
        crc: f64,
    ) -> Result<(), JsValue> {
        let length = chunks
            .iter()
            .try_fold(0usize, |length, chunk| {
                length
                    .checked_add(chunk.length() as usize)
                    .context("asset input length overflow")
            })
            .map_err(js_error)?;
        if length > self.asset_limit || uncompressed_size > self.asset_limit {
            return Err(js_error("Asset exceeds decoder memory admission"));
        }
        let mut bytes = vec![0; length];
        let mut offset = 0;
        for chunk in chunks.iter() {
            let end = offset + chunk.length() as usize;
            chunk.copy_to(&mut bytes[offset..end]);
            offset = end;
        }
        // Release compressed JS chunks before decoding their WASM copy.
        chunks.set_length(0);
        self.decoder
            .decode_asset(bytes, method, uncompressed_size, crc)
            .map_err(js_error)
    }

    pub fn decode_batch(&mut self) -> Result<bool, JsValue> {
        self.decoder.decode_batch().map_err(js_error)
    }

    pub fn finish(mut self) -> Result<Object, JsValue> {
        self.decoder.finish().map_err(js_error)?;
        let output = self.decoder.into_splats().into_splat_object();
        Reflect::set(&output, &"fileType".into(), &"sog".into())?;
        Ok(output)
    }
}
