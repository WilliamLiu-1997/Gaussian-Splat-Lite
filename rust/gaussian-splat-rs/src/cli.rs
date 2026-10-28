//! Bounded PLY/SPZ decode batches for the Node.js RAD builder. Model storage and LOD
//! construction belong to JavaScript, outside this module's linear memory.
use std::{cell::RefCell, rc::Rc};

use gaussian_splat_lib::decoder::{
    ChunkReceiver, MultiDecoder, SplatInit, SplatProps, SplatReceiver,
};
use js_sys::{Float32Array, Function};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&format!("{error:#}")).into()
}

#[derive(Clone)]
struct Receiver {
    callback: Function,
    error: Rc<RefCell<Option<JsValue>>>,
}

impl Receiver {
    fn new(callback: Function) -> Self {
        Self {
            callback,
            error: Rc::new(RefCell::new(None)),
        }
    }
    fn emit(&self, name: &str, base: usize, values: &[f32]) {
        if self.error.borrow().is_some() {
            return;
        }
        // A view of this module's memory rather than a copy: the copies'
        // freed buffers stayed in the process and took room from the
        // builder's cache.
        // SAFETY: the callback uses the values before it returns and calls
        // nothing here, so the memory cannot grow while the view is in use.
        let values = unsafe { Float32Array::view(values) };
        if let Err(error) = self.callback.call3(
            &JsValue::UNDEFINED,
            &name.into(),
            &JsValue::from_f64(base as f64),
            &values,
        ) {
            *self.error.borrow_mut() = Some(error);
        }
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

    fn reserve_decoder_memory(&mut self, bytes: usize) -> anyhow::Result<()> {
        self.emit("memory", bytes, &[]);
        anyhow::ensure!(
            self.error.borrow().is_none(),
            "Decoder memory reservation failed"
        );
        Ok(())
    }
    fn init_splats(&mut self, init: &SplatInit) -> anyhow::Result<()> {
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
    fn set_sh(&mut self, base: usize, count: usize, a: &[f32], b: &[f32], c: &[f32], _: &[f32]) {
        self.set_sh1(base, count, a);
        self.set_sh2(base, count, b);
        self.set_sh3(base, count, c);
    }
    fn set_sh1(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("sh1", base, values);
    }
    fn set_sh2(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("sh2", base, values);
    }
    fn set_sh3(&mut self, base: usize, _: usize, values: &[f32]) {
        self.emit("sh3", base, values);
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
    pub fn new(path: &str, size: f64, callback: Function) -> Result<Self, JsValue> {
        let receiver = Receiver::new(callback);
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
