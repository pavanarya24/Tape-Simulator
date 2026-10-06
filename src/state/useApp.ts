import { useSyncExternalStore } from "react";
import { controller, type AppState } from "./app";

/** Subscribe a component to the controller's immutable snapshot. */
export function useApp(): AppState {
  return useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
  );
}

export { controller };
export type { AppState } from "./app";
