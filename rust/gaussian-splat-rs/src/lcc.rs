//! JavaScript bridge for LCC record decoding through the shared SplatReceiver.
use gaussian_splat_lib::{
    decoder::{SplatInit, SplatReceiver},
    lcc::{LccDecoder, LccRanges, LccSh, LCC_BATCH, LCC_SH_BYTES},
};
use js_sys::{Float32Array, Object, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::splats::SplatsData;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

/// Decodes data.bin records with optional shcoef.bin records, or interleaved
/// environment.bin records. `ranges` holds scale min/max then SH min/max XYZ.
/// Input is copied in small batches so large nodes do not grow WASM memory.
#[wasm_bindgen]
pub fn decode_lcc_splats(
    base: Uint8Array,
    sh: Option<Uint8Array>,
    interleaved: bool,
    ranges: Float32Array,
) -> Result<Object, JsValue> {
    if ranges.length() != 12 {
        return Err(js_error("LCC: expected twelve range values"));
    }
    let values = ranges.to_vec();
    let vector = |offset: usize| [values[offset], values[offset + 1], values[offset + 2]];
    let mut decoder = LccDecoder::new(LccRanges {
        scale_min: vector(0),
        scale_max: vector(3),
        sh_min: vector(6),
        sh_max: vector(9),
    });
    let layout = match (&sh, interleaved) {
        (Some(_), _) => LccSh::Separate(&[]),
        (None, true) => LccSh::Interleaved,
        (None, false) => LccSh::None,
    };
    let stride = layout.record_bytes() as u32;
    if !base.length().is_multiple_of(stride) {
        return Err(js_error(
            "LCC: record data is not a whole number of records",
        ));
    }
    let count = base.length() / stride;
    if sh
        .as_ref()
        .is_some_and(|sh| sh.length() as u64 != count as u64 * LCC_SH_BYTES as u64)
    {
        return Err(js_error(
            "LCC: SH data length does not match the record count",
        ));
    }
    let mut splats = SplatsData::new();
    splats
        .init_splats(&SplatInit {
            num_splats: count as usize,
            max_sh_degree: layout.degree(),
        })
        .map_err(js_error)?;
    let mut records = Vec::new();
    let mut coefficients = Vec::new();
    for start in (0..count).step_by(LCC_BATCH) {
        let end = count.min(start + LCC_BATCH as u32);
        records.resize(((end - start) * stride) as usize, 0);
        base.subarray(start * stride, end * stride)
            .copy_to(&mut records);
        let batch_layout = if let Some(sh) = &sh {
            let bytes = LCC_SH_BYTES as u32;
            coefficients.resize(((end - start) * bytes) as usize, 0);
            sh.subarray(start * bytes, end * bytes)
                .copy_to(&mut coefficients);
            LccSh::Separate(&coefficients)
        } else {
            layout
        };
        decoder
            .decode(&mut splats, start as usize, &records, batch_layout)
            .map_err(js_error)?;
    }
    splats.finish().map_err(js_error)?;
    let output = splats.into_splat_object();
    Reflect::set(&output, &"fileType".into(), &"lcc".into())?;
    Ok(output)
}
