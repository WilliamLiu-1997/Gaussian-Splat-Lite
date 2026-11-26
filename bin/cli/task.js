import {
  parentPort,
  receiveMessageOnPort,
  workerData,
} from "node:worker_threads";
import { failLodTask, lodTask } from "../rad/parallel.js";
import { taskHandler } from "../tasks.js";

if (workerData.control) {
  const { control } = workerData;
  const task = lodTask(workerData);
  try {
    for (let seen = 0; ; ) {
      Atomics.wait(control, task.generation, seen);
      seen = Atomics.load(control, task.generation);
      if (seen < 0) break;
      while (task.needsState()) {
        const update = receiveMessageOnPort(parentPort);
        if (update) task.use(update.message);
      }
      task.run(seen);
    }
  } catch (error) {
    failLodTask(workerData, error);
  }
} else {
  parentPort.on(
    "message",
    await taskHandler(workerData, (result, transfer) =>
      parentPort.postMessage(result, transfer),
    ),
  );
}
