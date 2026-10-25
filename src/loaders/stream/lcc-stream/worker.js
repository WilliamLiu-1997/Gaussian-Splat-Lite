import { decode_lcc_records } from "gaussian-splat-rs";
import { wasmCall } from "../../../runtime/wasmCall.js";
import { startWorker } from "../../../runtime/workerServer.js";
import { decodeSplats, resolveAsset } from "../../workerDecode.js";
import { createLccStreamHandlers } from "./workerHandlers.js";
function decodeRecords(base, sh, interleaved, ranges) {
  const data = wasmCall(() =>
    decode_lcc_records(base, sh, interleaved, ranges),
  );
  return {
    numSplats: data.numSplats,
    splatArrays: [data.splat0, data.splat1],
    extra: {
      shBlock0: data.shBlock0,
      shBlock1: data.shBlock1,
      shBlock2: data.shBlock2,
      shBlock3: data.shBlock3,
      shBlock4: data.shBlock4,
      shBlock5: data.shBlock5,
    },
  };
}
startWorker({
  ...createLccStreamHandlers(decodeSplats, decodeRecords),
  resolveAsset,
});
