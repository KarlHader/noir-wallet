import { useEffect, useMemo, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  createBitcoinPsbtUREncoder,
  createKeystoneEthereumSignRequestUREncoder,
  createPcztUREncoder,
  DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH,
  DEFAULT_PCZT_FRAGMENT_LENGTH
} from '@/lib/keystone'

// Keystone's camera needs time to capture a full frame off a monitor; a slower
// cadence than Zashi's phone default (0.2s) avoids the camera grabbing a torn
// frame mid-transition, which decodes to a non-UR string ("invalid QR").
const DEFAULT_FRAME_INTERVAL_MS = 400

export type QRLevel = 'L' | 'M' | 'Q' | 'H'

interface AnimatedQRProps {
  /** Raw PCZT bytes; encoded as animated `ur:zcash-pczt` fountain frames */
  pcztBytes: Uint8Array
  size?: number
  level?: QRLevel
  fragmentLength?: number
  intervalMs?: number
}

export function AnimatedQR({
  pcztBytes,
  size = 340,
  level = 'M',
  fragmentLength = DEFAULT_PCZT_FRAGMENT_LENGTH,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS
}: AnimatedQRProps) {
  const encoder = useMemo(
    () => createPcztUREncoder(pcztBytes, fragmentLength),
    [pcztBytes, fragmentLength]
  )
  const [frame, setFrame] = useState(() => encoder.nextPart())

  useEffect(() => {
    if (encoder.fragmentsLength <= 1) {
      setFrame(encoder.nextPart())
      return
    }
    const interval = setInterval(() => {
      setFrame(encoder.nextPart())
    }, intervalMs)
    return () => clearInterval(interval)
  }, [encoder, intervalMs])

  return (
    <div className="flex flex-col items-center">
      {/* Uppercase UR enables QR alphanumeric mode; marginSize=4 is the spec quiet
          zone. White background comes from the parent for camera contrast. */}
      <QRCodeSVG value={frame.toUpperCase()} size={size} level={level} marginSize={4} />
      {encoder.fragmentsLength > 1 && (
        <p className="mt-2 text-xs text-gray-500">
          Keep the QR in view — it cycles through {encoder.fragmentsLength} frames
        </p>
      )}
    </div>
  )
}

export function BitcoinPsbtAnimatedQR({
  psbtBytes,
  size = 340,
  level = 'M',
  fragmentLength = DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS
}: Omit<AnimatedQRProps, 'pcztBytes'> & { readonly psbtBytes: Uint8Array }) {
  const encoder = useMemo(
    () => createBitcoinPsbtUREncoder(psbtBytes, fragmentLength),
    [psbtBytes, fragmentLength]
  )
  const [frame, setFrame] = useState(() => encoder.nextPart())

  useEffect(() => {
    if (encoder.fragmentsLength <= 1) {
      setFrame(encoder.nextPart())
      return
    }
    const interval = setInterval(() => setFrame(encoder.nextPart()), intervalMs)
    return () => clearInterval(interval)
  }, [encoder, intervalMs])

  return (
    <div className="flex flex-col items-center">
      <QRCodeSVG value={frame.toUpperCase()} size={size} level={level} marginSize={4} />
      {encoder.fragmentsLength > 1 && (
        <p className="mt-2 text-xs text-gray-500">
          Keep the QR in view — it cycles through {encoder.fragmentsLength} frames
        </p>
      )}
    </div>
  )
}

export function EthereumSignRequestAnimatedQR({
  cborBytes,
  size = 340,
  level = 'M',
  fragmentLength = DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS
}: Omit<AnimatedQRProps, 'pcztBytes'> & { readonly cborBytes: Uint8Array }) {
  const encoder = useMemo(
    () => createKeystoneEthereumSignRequestUREncoder(cborBytes, fragmentLength),
    [cborBytes, fragmentLength]
  )
  const [frame, setFrame] = useState(() => encoder.nextPart())

  useEffect(() => {
    if (encoder.fragmentsLength <= 1) {
      setFrame(encoder.nextPart())
      return
    }
    const interval = setInterval(() => setFrame(encoder.nextPart()), intervalMs)
    return () => clearInterval(interval)
  }, [encoder, intervalMs])

  return (
    <div className="flex flex-col items-center">
      <QRCodeSVG value={frame.toUpperCase()} size={size} level={level} marginSize={4} />
      {encoder.fragmentsLength > 1 && (
        <p className="mt-2 text-xs text-gray-500">
          Keep the QR in view — it cycles through {encoder.fragmentsLength} frames
        </p>
      )}
    </div>
  )
}
