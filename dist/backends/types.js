/**
 * Generic validation error that any backend can throw.
 * Routing engine catches these and propagates them to the tool layer
 * with user-friendly messages.
 */
export class BackendValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "BackendValidationError";
    }
}
