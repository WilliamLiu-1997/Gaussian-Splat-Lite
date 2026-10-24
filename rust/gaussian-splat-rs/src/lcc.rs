//! Narrow worker bridge; scene metadata and byte-range I/O stay in JavaScript.

use gaussian_splat_lib::{
    decoder::SplatReceiver,
    lcc::{decode_lcc, LccDecodeContext},
};
use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::prelude::*;

use crate::splats::SplatsData;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{error:#}")).into()
}

fn context_and_limits(json: &str) -> anyhow::Result<(LccDecodeContext, Option<f64>, Option<f64>)> {
    anyhow::ensure!(json.len() <= 16384, "LCC decode context exceeds byte limit");
    let mut value: serde_json::Value = serde_json::from_str(json)?;
    let fields = value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Invalid LCC decode context"))?;
    let mut limit = |name: &str| -> anyhow::Result<Option<f64>> {
        match fields.remove(name) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(value) => value
                .as_f64()
                .map(Some)
                .ok_or_else(|| anyhow::anyhow!("Invalid {name}")),
        }
    };
    let decoder = limit("maxDecoderBytes")?;
    let wasm = limit("maxWasmBytes")?;
    let context = LccDecodeContext::from_json(&serde_json::to_string(&value)?)?;
    Ok((context, decoder, wasm))
}

#[cfg(test)]
mod tests {
    use super::context_and_limits;

    #[test]
    fn accepts_budget_fields_without_weakening_the_format_context() {
        let mut value = serde_json::json!({
            "version": "5.0", "encoding": "COMPRESS", "fileType": "Portable", "count": 1,
            "scaleMin": [0, 0, 0], "scaleMax": [1, 1, 1],
            "maxDecoderBytes": 67108864, "maxWasmBytes": 33554432
        });
        let (context, decoder, wasm) = context_and_limits(&value.to_string()).unwrap();
        assert_eq!(context.count, 1);
        assert_eq!(decoder, Some(67108864.0));
        assert_eq!(wasm, Some(33554432.0));
        value["unrecognized"] = serde_json::json!(true);
        assert!(context_and_limits(&value.to_string()).is_err());
        value.as_object_mut().unwrap().remove("unrecognized");
        value["maxDecoderBytes"] = serde_json::json!("unbounded");
        assert!(context_and_limits(&value.to_string()).is_err());
    }
}

/// Returns the same canonical packed fields as the ordinary decoders, without
/// Morton reordering. Quality requires SH bytes; interleaved environments do not.
#[wasm_bindgen(js_name = decodeLcc)]
pub fn decode_lcc_records(
    base: Uint8Array,
    sh: Uint8Array,
    context_json: &str,
) -> Result<JsValue, JsValue> {
    let (context, budget, _wasm_budget) = context_and_limits(context_json).map_err(js_error)?;
    context
        .validate_lengths(base.length() as usize, sh.length() as usize)
        .map_err(js_error)?;
    #[cfg(target_arch = "wasm32")]
    crate::allocation::set_memory_limit(_wasm_budget)?;
    let mut receiver = SplatsData::with_limits(
        Some(context.max_points.try_into().map_err(js_error)?),
        budget,
    )
    .map_err(js_error)?;
    receiver
        .reserve_decoder_memory(
            (base.length() as usize)
                .saturating_add(sh.length() as usize)
                .saturating_add(1024 * 1024),
        )
        .map_err(js_error)?;
    let splats = decode_lcc(&base.to_vec(), &sh.to_vec(), &context, receiver).map_err(js_error)?;
    let object = splats.into_splat_object();
    Reflect::set(&object, &"fileType".into(), &JsValue::from_str("lcc"))?;
    Ok(object.into())
}
