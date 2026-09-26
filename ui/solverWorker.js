// The Web Worker the solver runs in (M14). Everything it does is in
// stepperCore.js, which node tests drive directly; this only connects it to
// postMessage. The typed arrays in a reply are transferred, not copied - they
// were made for this reply and nothing here keeps them.

import { StepperCore } from "./stepperCore.js";

const core = new StepperCore({ posted: true });

self.onmessage = (event) => {
  let reply;
  try {
    reply = core.handle(event.data);
  } catch (error) {
    reply = { type: "fault", epoch: event.data?.epoch ?? null, message: `${error.name}: ${error.message}` };
  }
  const transfer = [];
  if (reply.state) {
    const { state } = reply;
    for (const array of [state.u, state.v, state.p, state.previousU, state.previousV, state.tracer.c]) {
      transfer.push(array.buffer);
    }
  }
  self.postMessage(reply, transfer);
};
