/**
 * Code-split chunk for the extension demo. Loading starts as soon as a button is hovered or
 * focused, so a click rarely has to wait.
 */
export const loadDemo = () => import('./extension/ExtensionDemo')
