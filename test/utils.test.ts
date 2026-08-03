import assert from "node:assert";
import { floatToUint8 } from "../src/utils.js";

assert.strictEqual(floatToUint8(0), 0, "floatToUint8 test 1 Failed");
assert.strictEqual(floatToUint8(1), 255, "floatToUint8 test 2 Failed");

console.log("✅ All test cases passed!");
