import Big from 'big.js'

Big.DP = 40
Big.PE = 24

export default Big

type BigValue = Big | string | number | undefined | null

export function safeBig(val: BigValue, defaultVal = '0') {
  try {
    const v = val || defaultVal
    return new Big(v)
  } catch (error) {
    console.error('safeBig error', val, error)
    return new Big('0')
  }
}
