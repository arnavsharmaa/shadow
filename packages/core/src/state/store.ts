import type { JsonObject, JsonValue, PatchOperation } from "@shadow/schemas";
import { deepClone, deepEqual } from "../json.js";
import { getAtPointer, removeAtPointer, setAtPointer } from "./pointer.js";

export interface StateStore {
  readonly version: number;
  getState(): JsonObject;
  getContext(): JsonObject;
  /** Returns the patch applied, or null when nothing changed. */
  setState(path: string, value: JsonValue): PatchOperation[] | null;
  removeState(path: string): PatchOperation[] | null;
  replaceState(next: JsonObject): PatchOperation[] | null;
  setContext(key: string, value: JsonValue): boolean;
  removeContext(key: string): boolean;
  load(state: JsonObject, context: JsonObject, version: number): void;
}

/** In-memory, versioned state used by the recording and replay runtimes. */
export class InMemoryStateStore implements StateStore {
  private state: JsonObject;
  private context: JsonObject;
  version = 0;

  constructor(initialState: JsonObject = {}, initialContext: JsonObject = {}, version = 0) {
    this.state = deepClone(initialState);
    this.context = deepClone(initialContext);
    this.version = version;
  }

  load(state: JsonObject, context: JsonObject, version: number): void {
    this.state = deepClone(state);
    this.context = deepClone(context);
    this.version = version;
  }

  getState(): JsonObject {
    return deepClone(this.state);
  }

  getContext(): JsonObject {
    return deepClone(this.context);
  }

  setState(path: string, value: JsonValue): PatchOperation[] | null {
    const existing = getAtPointer(this.state, path);
    if (deepEqual(existing, value)) return null;
    const next = setAtPointer(this.state, path, deepClone(value));
    this.state = next as JsonObject;
    this.version++;
    return [{ op: existing === undefined ? "add" : "replace", path, value: deepClone(value) }];
  }

  removeState(path: string): PatchOperation[] | null {
    if (getAtPointer(this.state, path) === undefined) return null;
    this.state = removeAtPointer(this.state, path) as JsonObject;
    this.version++;
    return [{ op: "remove", path }];
  }

  replaceState(next: JsonObject): PatchOperation[] | null {
    if (deepEqual(this.state, next)) return null;
    this.state = deepClone(next);
    this.version++;
    return [{ op: "replace", path: "", value: deepClone(next) }];
  }

  setContext(key: string, value: JsonValue): boolean {
    if (key in this.context && deepEqual(this.context[key], value)) return false;
    this.context = { ...this.context, [key]: deepClone(value) };
    this.version++;
    return true;
  }

  removeContext(key: string): boolean {
    if (!(key in this.context)) return false;
    const { [key]: _removed, ...rest } = this.context;
    this.context = rest;
    this.version++;
    return true;
  }
}
