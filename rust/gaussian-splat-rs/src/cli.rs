//! Bounded PLY/SPZ decode batches for the Node.js RAD/SOG builders. Model storage and LOD
//! construction belong to JavaScript, outside this module's linear memory.
use std::{cell::RefCell, rc::Rc};

use gaussian_splat_lib::{
    decoder::{ChunkReceiver, MultiDecoder, SplatInit, SplatProps, SplatReceiver},
    splat_encode::decode_splat_sh_rgb,
};
use half::f16;
use js_sys::{Float32Array, Float64Array, Function, Uint16Array};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{error:#}")).into()
}

#[derive(Clone)]
struct Receiver {
    callback: Function,
    error: Rc<RefCell<Option<JsValue>>>,
    raw_mass: bool,
    max_sh: usize,
    sh: Vec<u16>,
    columns: Vec<String>,
}

impl Receiver {
    fn new(callback: Function, raw_mass: bool, max_sh: usize) -> Self {
        Self {
            callback,
            error: Rc::new(RefCell::new(None)),
            raw_mass,
            max_sh,
            sh: Vec::new(),
            columns: Vec::new(),
        }
    }
    fn emit_values(&self, name: &str, base: usize, values: &JsValue) {
        if self.error.borrow().is_some() {
            return;
        }
        if let Err(error) = self.callback.call3(
            &JsValue::UNDEFINED,
            &name.into(),
            &JsValue::from_f64(base as f64),
            values,
        ) {
            *self.error.borrow_mut() = Some(error);
        }
    }
    fn emit(&self, name: &str, base: usize, values: &[f32]) {
        // SAFETY: the callback consumes the view synchronously and never
        // reenters this module, so its memory cannot grow during the call.
        let values = unsafe { Float32Array::view(values) };
        self.emit_values(name, base, &values);
    }
    fn emit_sh(
        &mut self,
        band: usize,
        base: usize,
        length: usize,
        values: impl Iterator<Item = f32>,
    ) {
        if band > self.max_sh || length == 0 || self.error.borrow().is_some() {
            return;
        }
        let saturate = self.raw_mass;
        self.sh.clear();
        self.sh.reserve_exact(length);
        self.sh.extend(values.map(|value| {
            // SOG saturates finite overflow; RAD filters those splats.
            let value = if saturate && value.is_finite() {
                value.clamp(-65504.0, 65504.0)
            } else {
                value
            };
            f16::from_f32(value).to_bits()
        }));
        // SAFETY: as in emit(); the buffer is reused only after the callback.
        let values = unsafe { Uint16Array::view(&self.sh) };
        self.emit_values(["sh1", "sh2", "sh3", "sh4"][band - 1], base, &values);
    }
    fn check<T>(&self, result: anyhow::Result<T>) -> Result<T, JsValue> {
        if let Some(error) = self.error.borrow_mut().take() {
            return Err(error);
        }
        result.map_err(js_error)
    }
}

impl SplatReceiver for Receiver {
    const SUPPORTS_COMPRESSED_PLY: bool = false;

    fn raw_mass(&self) -> bool {
        self.raw_mass
    }

    fn ply_columns(&self) -> &[String] {
        &self.columns
    }
    fn ply_header(&mut self, header: &str) -> anyhow::Result<()> {
        self.emit_values("ply", 0, &JsValue::from_str(header));
        anyhow::ensure!(self.error.borrow().is_none(), "Reading PLY metadata failed");
        Ok(())
    }
    fn set_ply_columns(&mut self, base: usize, values: &[f64]) {
        // SAFETY: the callback copies this view synchronously, as in emit().
        let values = unsafe { Float64Array::view(values) };
        self.emit_values("blind", base, &values);
    }

    fn reserve_decoder_memory(&mut self, bytes: usize) -> anyhow::Result<()> {
        // The reusable SH half buffer and its growth during a batch.
        let sh_bytes = if self.max_sh > 0 { 8 * 1024 * 1024 } else { 0 };
        self.emit("memory", bytes.saturating_add(sh_bytes), &[]);
        anyhow::ensure!(
            self.error.borrow().is_none(),
            "Decoder memory reservation failed"
        );
        Ok(())
    }
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
        self.max_sh = self.max_sh.min(init.max_sh_degree);
        self.emit("init", init.num_splats, &[init.max_sh_degree as f32]);
        anyhow::ensure!(
            self.error.borrow().is_none(),
            "Allocating decoded splats failed"
        );
        Ok(())
    }
    fn set_batch(&mut self, base: usize, count: usize, batch: &SplatProps) {
        self.set_center(base, count, batch.center);
        self.set_opacity(base, count, batch.opacity);
        self.set_rgb(base, count, batch.rgb);
        self.set_scale(base, count, batch.scale);
        self.set_quat(base, count, batch.quat);
        self.set_sh(base, count, batch.sh1, batch.sh2, batch.sh3, batch.sh4);
    }
    fn set_batch_ln_scale(&mut self, base: usize, count: usize, batch: &SplatProps, ln: &[f32]) {
        self.set_batch(
            base,
            count,
            &SplatProps {
                scale: &[],
                ..*batch
            },
        );
        self.set_ln_scale(base, count, ln);
    }
    fn set_center(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("center", base, values);
    }
    fn set_opacity(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("opacity", base, values);
    }
    fn set_rgb(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("rgb", base, values);
    }
    fn set_scale(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("scale", base, values);
    }
    fn set_ln_scale(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("lnScale", base, values);
    }
    fn set_quat(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("quat", base, values);
    }
    fn set_sh(&mut self, base: usize, count: usize, a: &[f32], b: &[f32], c: &[f32], d: &[f32]) {
        self.set_sh1(base, count, a);
        self.set_sh2(base, count, b);
        self.set_sh3(base, count, c);
        self.set_sh4(base, count, d);
    }
    fn set_sh1(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit_sh(1, base, values.len(), values.iter().copied());
    }
    fn set_sh2(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit_sh(2, base, values.len(), values.iter().copied());
    }
    fn set_sh3(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit_sh(3, base, values.len(), values.iter().copied());
    }
    fn set_sh4(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit_sh(4, base, values.len(), values.iter().copied());
    }
    fn set_sh_packed<F: Fn(usize, usize) -> u32>(
        &mut self,
        base: usize,
        count: usize,
        band: usize,
        word: F,
    ) {
        let coefficients = [3, 5, 7, 9][band - 1];
        let word = &word;
        let values = (0..count)
            .flat_map(|i| (0..coefficients).flat_map(move |k| decode_splat_sh_rgb(word(i, k))));
        self.emit_sh(band, base, count * coefficients * 3, values);
    }
}

#[wasm_bindgen]
pub struct RawDecoder {
    decoder: MultiDecoder<Receiver>,
    receiver: Receiver,
}

#[wasm_bindgen]
impl RawDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new(
        path: &str,
        size: f64,
        callback: Function,
        raw_mass: Option<bool>,
        max_sh: usize,
        columns: Option<Vec<String>>,
    ) -> Result<Self, JsValue> {
        let mut receiver = Receiver::new(callback, raw_mass.unwrap_or(false), max_sh);
        receiver.columns = columns.unwrap_or_default();
        let mut decoder = MultiDecoder::new(receiver.clone(), None, Some(path));
        receiver.check(decoder.set_expected_input_size(size as u64))?;
        Ok(Self { decoder, receiver })
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        self.receiver.check(self.decoder.push(bytes))
    }
    pub fn finish(&mut self) -> Result<(), JsValue> {
        self.receiver.check(self.decoder.finish())
    }
}
