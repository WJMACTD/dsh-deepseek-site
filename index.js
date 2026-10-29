/**
 * Host half: this plugin has no Host behaviour.
 *
 * The whole feature lives in the Client half (`./client`), which registers a
 * `sidebar.panellist` row and the `main` panel that row selects. The Host half
 * exists because a bundle patch entry has to resolve to a package main; it
 * deliberately does nothing.
 */
export function apply() {}
