//! Browser bridge for indexed LCC records.
use crate::splats::SplatsData;
use js_sys::{Float32Array, Uint8Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn decode_lcc_records(
    data: Uint8Array,
    sh: Option<Uint8Array>,
    interleaved_sh: bool,
    ranges: Float32Array,
) -> Result<JsValue, JsValue> {
    let sh = sh.map(|bytes| bytes.to_vec());
    gaussian_splat_lib::lcc::decode_lcc(
        &data.to_vec(),
        sh.as_deref(),
        interleaved_sh,
        &ranges.to_vec(),
        SplatsData::new(),
    )
    .map(|splats| splats.into_splat_object().into())
    .map_err(|error| js_sys::Error::new(&format!("{error:#}")).into())
}
