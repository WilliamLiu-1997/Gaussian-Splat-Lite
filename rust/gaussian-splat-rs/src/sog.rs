//! JavaScript bridge for SOG property decoding through the shared SplatReceiver.
#[cfg(target_arch = "wasm32")]
use anyhow::Context;
use gaussian_splat_lib::sog::{self, SogDecoder};
#[cfg(target_arch = "wasm32")]
use js_sys::Array;
use js_sys::{Object, Reflect, Uint8Array};
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
) -> Result<String, JsValue> {
    sog::decode_sog_meta(bytes.to_vec(), method, size, crc).map_err(js_error)
}

#[cfg(target_arch = "wasm32")]
fn unpack_asset(
    chunks: Array<Uint8Array>,
    method: u32,
    size: usize,
    crc: f64,
) -> Result<Vec<u8>, JsValue> {
    let length = chunks
        .iter()
        .try_fold(0usize, |length, chunk| {
            length
                .checked_add(chunk.length() as usize)
                .context("asset input length overflow")
        })
        .map_err(js_error)?;
    let mut bytes = vec![0; length];
    let mut offset = 0;
    for chunk in chunks.iter() {
        let end = offset + chunk.length() as usize;
        chunk.copy_to(&mut bytes[offset..end]);
        offset = end;
    }
    chunks.set_length(0);
    sog::unpack(bytes, method, size, crc).map_err(js_error)
}

#[wasm_bindgen]
pub struct SogDecodeSession {
    decoder: SogDecoder<SplatsData>,
}

#[wasm_bindgen]
impl SogDecodeSession {
    #[wasm_bindgen(constructor)]
    pub fn new(metadata: &str, max_sh: Option<u32>, blind: Option<bool>) -> Result<Self, JsValue> {
        Ok(Self {
            decoder: SogDecoder::new(
                SplatsData::new(4),
                metadata,
                max_sh.unwrap_or(4) as usize,
                blind.unwrap_or(true),
            )
            .map_err(js_error)?,
        })
    }

    pub fn plan(&self) -> String {
        serde_json::to_string(&self.decoder.plan()).expect("asset names are serializable")
    }

    pub fn warnings(&self) -> String {
        serde_json::to_string(self.decoder.warnings()).expect("warnings are serializable")
    }

    #[cfg(target_arch = "wasm32")]
    pub fn decode_asset(
        &mut self,
        chunks: Array<Uint8Array>,
        method: u32,
        size: usize,
        crc: f64,
    ) -> Result<(), JsValue> {
        let bytes = unpack_asset(chunks, method, size, crc)?;
        let (pixels, width, height, channels) = crate::webp::decode(&bytes).map_err(js_error)?;
        self.decoder
            .decode_image(pixels, width, height, channels)
            .map_err(js_error)
    }

    pub fn decode_batch(&mut self) -> Result<bool, JsValue> {
        self.decoder.decode_batch().map_err(js_error)
    }

    pub fn finish(mut self) -> Result<Object, JsValue> {
        self.decoder.finish().map_err(js_error)?;
        let blind = serde_json::to_string(self.decoder.blind_metadata()).unwrap();
        let output = self.decoder.into_splats().into_splat_object();
        Reflect::set(&output, &"blind".into(), &js_sys::JSON::parse(&blind)?)?;
        Reflect::set(&output, &"fileType".into(), &"sog".into())?;
        Ok(output)
    }
}
