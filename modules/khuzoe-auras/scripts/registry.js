export class AuraActionRegistry {
  #handlers = new Map();

  register(type, handler, { replace = false } = {}) {
    if (typeof type !== "string" || !type.trim()) throw new TypeError("Action type must be a non-empty string.");
    if (typeof handler !== "function") throw new TypeError(`Handler for "${type}" must be a function.`);
    if (this.#handlers.has(type) && !replace) throw new Error(`Action type "${type}" is already registered.`);
    this.#handlers.set(type, handler);
  }

  has(type) {
    return this.#handlers.has(type);
  }

  async execute(action, context) {
    const handler = this.#handlers.get(action?.type);
    if (!handler) throw new Error(`No handler is registered for action type "${action?.type}".`);
    return handler(action, context);
  }

  get types() {
    return [...this.#handlers.keys()];
  }
}
