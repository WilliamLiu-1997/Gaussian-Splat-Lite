use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, Ordering};

use wasm_bindgen::prelude::*;

struct AllocationTracker;

static FAILED: AtomicBool = AtomicBool::new(false);

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
        track(System.alloc(layout))
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        track(System.alloc_zeroed(layout))
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        track(System.realloc(ptr, layout, size))
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }
}

/// Remains readable after an allocation abort, which otherwise looks like any
/// other `unreachable` trap to JavaScript. The failed instance is then retired.
#[wasm_bindgen]
pub fn wasm_allocation_failed() -> bool {
    FAILED.load(Ordering::Relaxed)
}
