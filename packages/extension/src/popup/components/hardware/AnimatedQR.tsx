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

const encoders = {
  bitcoin: {
    create: createBitcoinPsbtUREncoder,
    fragmentLength: DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH
  },
  evm: {
    create: createKeystoneEthereumSignRequestUREncoder,
    fragmentLength: DEFAULT_BITCOIN_PSBT_FRAGMENT_LENGTH
  },
  zcash: { create: createPcztUREncoder, fragmentLength: DEFAULT_PCZT_FRAGMENT_LENGTH }
}

interface AnimatedQRProps {
  family: keyof typeof encoders
  bytes: Uint8Array
  size?: number
  level?: QRLevel
  fragmentLength?: number
  intervalMs?: number
}

export function AnimatedQR({
  family,
  bytes,
  size = 340,
  level = 'M',
  fragmentLength = encoders[family].fragmentLength,
  intervalMs = DEFAULT_FRAME_INTERVAL_MS
}: AnimatedQRProps) {
  const { encoder, firstFrame } = useMemo(() => {
    const encoder = encoders[family].create(bytes, fragmentLength)
    return { encoder, firstFrame: encoder.nextPart() }
  }, [bytes, family, fragmentLength])
  const [animation, setAnimation] = useState<{ encoder: typeof encoder; frame: string }>()
  const frame = animation?.encoder === encoder ? animation.frame : firstFrame

  useEffect(() => {
    if (encoder.fragmentsLength <= 1) return
    const interval = setInterval(() => {
      setAnimation({ encoder, frame: encoder.nextPart() })
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
