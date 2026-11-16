import { useMemo } from 'react'
import { getPasswordStrength } from '@/core/wallet/password-policy'

interface PasswordStrengthProps {
  password: string
}

export function PasswordStrength({ password }: PasswordStrengthProps) {
  const { strength, score } = useMemo(() => getPasswordStrength(password), [password])

  const strengthColors = {
    'Too Weak': 'bg-danger',
    Weak: 'bg-warning',
    Medium: 'bg-warning',
    Strong: 'bg-success'
  }

  const maxBars = 4
  const filledBars = Math.min(score, maxBars)

  if (!password) return null

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {Array.from({ length: maxBars }).map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${
              i < filledBars ? strengthColors[strength] : 'bg-white/20'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-default-500">{strength}</p>
    </div>
  )
}
