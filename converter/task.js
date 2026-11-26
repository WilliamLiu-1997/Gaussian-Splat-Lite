import { failLodTask, lodTask } from "../bin/rad/parallel.js";
import { taskHandler } from "../bin/tasks.js";

let port;
let shared;
let handler;
let queue = Promise.resolve();
async function dispatch(message) {
  if (message.init) {
    const data = message.init;
    if (data.control) {
      shared = data;
      const task = lodTask(data);
      handler = (job) =>
        job.round === undefined ? task.use(job) : task.run(job.round);
    } else {
      handler = await taskHandler(data, (result, transfer) =>
        port.postMessage({ result }, transfer),
      );
    }
  } else await handler(message);
}
function enqueue(data) {
  queue = queue
    .then(() => dispatch(data))
    .catch((error) => {
      if (shared) failLodTask(shared, error);
      else port.postMessage({ error: error.message ?? String(error) });
      self.close();
    });
}
self.onmessage = ({ data }) => {
  port = data.port;
  enqueue({ init: data.init });
  port.onmessage = ({ data }) => enqueue(data);
};
