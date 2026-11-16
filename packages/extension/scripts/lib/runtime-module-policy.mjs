const BIGINT_BUFFER_MODULE_PATTERN =
  /\/node_modules\/(?:\.pnpm\/bigint-buffer@[^/]+\/node_modules\/)?bigint-buffer\//

export function findProhibitedRuntimeModules(moduleIds) {
  return Object.freeze(
    [...new Set(moduleIds)]
      .filter(moduleId => BIGINT_BUFFER_MODULE_PATTERN.test(moduleId.replaceAll('\\', '/')))
      .sort()
  )
}
