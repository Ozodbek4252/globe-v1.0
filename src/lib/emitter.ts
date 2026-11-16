export type Unsubscribe = () => void;

// Properties rather than methods, so `emitter.on` can be handed out without binding `this`.
export interface Emitter<T> {
  /** Subscribe; returns a function that unsubscribes. */
  on: (listener: (value: T) => void) => Unsubscribe;
  emit: (value: T) => void;
  clear: () => void;
}

/** A tiny typed event source, so callers can subscribe without the emitter knowing about them. */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) listener(value);
    },
    clear() {
      listeners.clear();
    },
  };
}
