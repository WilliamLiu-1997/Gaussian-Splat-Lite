use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use wasm_bindgen::prelude::*;

struct AllocationTracker;

static FAILED: AtomicBool = AtomicBool::new(false);
static BUDGET_FAILED: AtomicBool = AtomicBool::new(false);
static HEAP_LIMIT: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Audited against Rust 1.98.1's wasm System / dlmalloc 0.2.13: realloc
/// reuses memory or makes one malloc(new_size); memalign adds alignment and
/// small headers; sys_alloc rounds headers to one 64 KiB page. Two pages
/// cover headers and rounding. Capacity already includes the old realloc block.
/// This deliberately also charges allocations that could reuse a free block.
/// Re-audit before allocator/toolchain changes or enabling shared-memory threads.
fn admitted(size: usize, alignment: usize) -> bool {
    let limit = HEAP_LIMIT.load(Ordering::Relaxed);
    if limit == usize::MAX {
        return true;
    }
    let capacity = core::arch::wasm32::memory_size::<0>().saturating_mul(65536);
    let allowed = capacity
        .saturating_add(size)
        .saturating_add(alignment)
        .saturating_add(131072)
        <= limit;
    if !allowed {
        BUDGET_FAILED.store(true, Ordering::Relaxed);
        FAILED.store(true, Ordering::Relaxed);
    }
    allowed
}

#[wasm_bindgen(js_name = set_decoder_memory_limit)]
pub fn set_memory_limit(bytes: Option<f64>) -> Result<(), JsValue> {
    let limit = if let Some(bytes) = bytes {
        if !bytes.is_finite() || bytes.fract() != 0.0 || !(0.0..=4_294_901_760.0).contains(&bytes) {
            return Err(JsValue::from_str("Invalid WASM capacity limit"));
        }
        bytes as usize
    } else {
        usize::MAX
    };
    if limit != usize::MAX && core::arch::wasm32::memory_size::<0>() as u64 * 65536 > limit as u64 {
        return Err(JsValue::from_str(
            "Retained WASM capacity exceeds source admission; increase maxWasmBytes",
        ));
    }
    HEAP_LIMIT.store(limit, Ordering::Relaxed);
    Ok(())
}

#[global_allocator]
static ALLOCATOR: AllocationTracker = AllocationTracker;

fn track(ptr: *mut u8) -> *mut u8 {
    if ptr.is_null() {
        FAILED.store(true, Ordering::Relaxed);
    }
    ptr
}

// SAFETY: Every allocation and deallocation delegates to System with the
// caller's unchanged layout. Recording a failed allocation does not allocate.
unsafe impl GlobalAlloc for AllocationTracker {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if !admitted(layout.size(), layout.align()) {
            return std::ptr::null_mut();
        }
        track(System.alloc(layout))
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if !admitted(layout.size(), layout.align()) {
            return std::ptr::null_mut();
        }
        track(System.alloc_zeroed(layout))
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if !admitted(size, layout.align()) {
            return std::ptr::null_mut();
        }
        track(System.realloc(ptr, layout, size))
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
}

/// Remains readable after an allocation abort, which otherwise looks like any
/// other `unreachable` trap to JavaScript. The failed instance is then retired.
#[wasm_bindgen]
pub fn wasm_budget_exceeded() -> bool {
    BUDGET_FAILED.load(Ordering::Relaxed)
}

#[wasm_bindgen]
pub fn wasm_allocation_failed() -> bool {
    FAILED.load(Ordering::Relaxed)
}
