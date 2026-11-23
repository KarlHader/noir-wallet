import { useState } from 'react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Icon } from '@iconify/react'
import { cn } from '@/lib/utils'

interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  error?: string
  className?: string
  onEnter?: () => void
  disabled?: boolean
}

export function PasswordInput({
  value,
  onChange,
  placeholder = 'Enter Password',
  label,
  error,
  className,
  onEnter,
  disabled
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onEnter) {
      onEnter()
    }
  }

  return (
    <div className={cn('w-full', className)}>
      {label && <label className="block text-muted-foreground text-sm mb-2">{label}</label>}
      <Input
        type={showPassword ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'h-[46px] rounded-xl pr-12',
          error && 'border-destructive',
          disabled && 'opacity-50'
        )}
        endContent={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setShowPassword(!showPassword)}
            className="h-8 w-8 text-muted hover:text-foreground"
            disabled={disabled}
          >
            <Icon icon={showPassword ? 'lucide:eye-off' : 'lucide:eye'} width={18} height={18} />
          </Button>
        }
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
