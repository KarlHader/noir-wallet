// The typeof guard keeps the module importable where no build define exists (Node tests), which
// then see the UI as off; builds replace the literal, so the guard folds away there.
export const MULTISIG_UI_CONFIG = Object.freeze({
  enabled: typeof __FROST_MULTISIG_UI__ === 'boolean' && __FROST_MULTISIG_UI__
})
